import { NextResponse } from 'next/server';
import { readCardPhoto, getStageStats } from '../../../lib/ocr';
import { findCandidates } from '../../../lib/identify';

export const runtime = 'nodejs';
export const maxDuration = 60;

function parseNumberParam(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,3})\s*(?:\/\s*(\d{1,3}))?/);
  if (!m) return null;
  return {
    num: String(parseInt(m[1], 10)),
    padded: String(parseInt(m[1], 10)).padStart(3, '0'),
    total: m[2] ? String(parseInt(m[2], 10)) : null,
  };
}

export async function POST(req) {
  const t0 = Date.now();
  try {
    const form = await req.formData();
    const file = form.get('photo');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ ok: false, error: 'No photo received' }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    // Hard deadline comfortably inside the platform cap (maxDuration 60):
    // if the pipeline is having a slow day, answer with structured JSON
    // the client can act on instead of dying as a platform 504 page
    // (which is what "Something went wrong" on the phone actually was).
    const DEADLINE_MS = parseInt(process.env.IDENTIFY_DEADLINE_MS || '50000', 10) || 50000;
    let timer = null;
    const work = (async () => {
      const reading = await readCardPhoto(buffer);
      const ocrMs = Date.now() - t0;
      const candidates = await findCandidates({ ...reading, photoBuffer: buffer });
      return { reading, candidates, ocrMs };
    })();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(1000, DEADLINE_MS - (Date.now() - t0)));
    });
    const done = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (!done) {
      return NextResponse.json({
        ok: false, error: 'slow', retry: true,
        detail: `Identification exceeded ${DEADLINE_MS}ms budget`,
        timing: { totalMs: Date.now() - t0 },
        ocrStages: getStageStats(),
      });
    }
    const { reading, candidates, ocrMs } = done;
    const { nameGuess, nameGuesses, numberGuess, numberGuesses, attackGuesses, debug } = reading;
    // Confidence gate verdict: at least one candidate carries structural
    // evidence (see applyGate in lib/identify.js). When none does, the
    // client shows the retake state and never a card picture.
    const confident = candidates.some((c) => c.displayable);
    // We READ a solid number (>=2 slice votes) but the book still came
    // back empty after retries: the photo was fine, the lookup failed.
    // The client words that differently from "couldn't read it".
    const topNum = (numberGuesses && numberGuesses[0]) || numberGuess;
    const stumped = !candidates.length && !!topNum && (topNum.votes || 0) >= 2;
    return NextResponse.json({
      ok: true,
      confident,
      stumped,
      ocr: {
        name: nameGuess || '',
        nameGuesses: nameGuesses || [],
        number: numberGuess ? `${numberGuess.padded}${numberGuess.total ? '/' + numberGuess.total : ''}` : '',
        numberGuesses: numberGuesses || [],
        attackGuesses: attackGuesses || [],
      },
      candidates,
      timing: { ocrMs, totalMs: Date.now() - t0, ocrStages: reading.ocrTiming || null },
      ...(process.env.DEBUG_OCR ? { debug } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'identify-failed', debugError: String(err && err.message || err), timing: { totalMs: Date.now() - t0 } },
      { status: 500 }
    );
  }
}

// Grown-ups manual fallback: /api/identify?name=Meowth&number=106/094
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const nameGuess = searchParams.get('name') || '';
    const numberGuess = parseNumberParam(searchParams.get('number'));
    if (!nameGuess && !numberGuess) {
      return NextResponse.json({ ok: false, error: 'Give a name or a number' }, { status: 400 });
    }
    const candidates = await findCandidates({ nameGuess, numberGuess });
    return NextResponse.json({ ok: true, confident: candidates.some((c) => c.displayable), candidates });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'identify-failed', debugError: String(err && err.message || err) },
      { status: 500 }
    );
  }
}
