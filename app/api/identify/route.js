import { NextResponse } from 'next/server';
import { getStageStats } from '../../../lib/ocr';
import { findCandidates } from '../../../lib/identify';
import { identifyPhoto, NUMBER_CORNER_HINT } from '../../../lib/hybrid';
import { summarizeProgress, deadlineRetake } from '../../../lib/progress';

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
    // Two-photo merge: the client sends the first (failed) photo's OCR
    // summary back with a tilted second capture (see lib/hybrid.js).
    // Unparseable input is ignored, never fatal.
    let priorOcr = null;
    try {
      const rawPrior = form.get('priorOcr');
      if (typeof rawPrior === 'string' && rawPrior) priorOcr = JSON.parse(rawPrior);
    } catch { priorOcr = null; }
    // Capture overhaul: the client sends cropped=1 when the upload is
    // already a tight high-quality card crop — the pipeline must NOT
    // re-encode it (that second JPEG pass crushed text reads).
    const clientCropped = form.get('cropped') === '1';
    // RESET (2026-10-25): the client marks continuation shots. corner
    // = this shot is a close-up of the bottom number corner (the
    // missing piece): the server runs corner-first number extraction
    // and merges with the banked evidence. fast = picture+name are
    // already banked and only the number is missing: the server
    // skips the full re-read and goes straight to targeted
    // number-corner extraction, falling back to the normal path
    // when the number does not resolve. Neither flag can create a
    // choice on its own — the confidence gate still decides.
    const cornerCloseup = form.get('corner') === '1';
    const fastNumber = form.get('fast') === '1';
    // Hard deadline comfortably inside the platform cap (maxDuration 60):
    // if the pipeline is having a slow day, answer with structured JSON
    // the client can act on instead of dying as a platform 504 page
    // (which is what "Something went wrong" on the phone actually was).
    const DEADLINE_MS = parseInt(process.env.IDENTIFY_DEADLINE_MS || '50000', 10) || 50000;
    let timer = null;
    // Latest pipeline snapshot (lib/hybrid.js reports each stage
    // boundary): when the race below fires mid-flight, this is what
    // the pipeline had already established — the deadline answer is
    // built from it instead of discarding the whole slow lane.
    let latestPartial = null;
    const work = (async () => {
      // Phase 2 hybrid: picture-matching proposes, OCR confirms/rescues
      // (lib/hybrid.js). Falls back to the pure OCR path on its own
      // whenever the picture path is unavailable or has no match.
      return identifyPhoto(buffer, {
        deadlineAt: t0 + DEADLINE_MS - 4000, priorOcr, clientCropped,
        cornerCloseup, fastNumber,
        onPartial: (snap) => { latestPartial = snap; },
      });
    })();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(1000, DEADLINE_MS - (Date.now() - t0)));
    });
    const done = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (!done) {
      // Deadline, not failure: a slow lane degrades to the SAME
      // guided retake a normal safe-fail returns (banked progress +
      // missing-piece hint + second-photo offer), never to a generic
      // error. The kid flow sees the outline fill on the next shot
      // and hears "take the picture again"; failureKind is
      // grown-ups diagnostics only.
      return NextResponse.json({
        ...deadlineRetake(latestPartial, NUMBER_CORNER_HINT),
        detail: `Identification exceeded ${DEADLINE_MS}ms budget`,
        timing: { totalMs: Date.now() - t0 },
        ocrStages: getStageStats(),
      });
    }
    const { reading, candidates, pict, zone, retakeHint, secondPhoto } = done;
    const { nameGuess, nameGuesses, numberGuess, numberGuesses, attackGuesses, hpGuess, debug } = reading || {};
    // Confidence gate verdict: at least one candidate carries structural
    // evidence (see applyGate in lib/identify.js). When none does, the
    // client shows the retake state and never a card picture.
    const confident = candidates.some((c) => c.displayable);
    // We READ a solid number (>=2 slice votes) but the book still came
    // back empty after retries: the photo was fine, the lookup failed.
    // The client words that differently from "couldn't read it".
    const topNum = (numberGuesses && numberGuesses[0]) || numberGuess;
    const stumped = !candidates.length && !!topNum && (topNum.votes || 0) >= 2;
    // Banked progress: on a non-confident result, summarize which
    // signals this photo already banked (picture / name / number) and
    // which single piece the next guided shot should aim at. This is
    // evidence reporting only — it never creates a choice; only the
    // confidence gate above can do that. The client re-opens the
    // preview with the banked pieces as outline fill and the
    // missing piece's segment pulsing, instead of looping on generic
    // retakes. Confident responses carry no progress (nothing to
    // complete).
    const progress = confident ? null : summarizeProgress({ candidates, pict });
    return NextResponse.json({
      ok: true,
      confident,
      stumped,
      progress,
      ocr: {
        name: nameGuess || '',
        nameGuesses: nameGuesses || [],
        number: numberGuess ? `${numberGuess.padded}${numberGuess.total ? '/' + numberGuess.total : ''}` : '',
        numberGuesses: numberGuesses || [],
        attackGuesses: attackGuesses || [],
        hpGuess: hpGuess !== undefined && hpGuess !== null ? hpGuess : null,
      },
      candidates,
      zone,
      retakeHint: retakeHint || null,
      secondPhoto: secondPhoto === true,
      timing: {
        ocrMs: done.ocrMs || 0,
        totalMs: Date.now() - t0,
        ocrStages: (reading && reading.ocrTiming) || null,
        pictmatch: pict ? { ...pict.timings, topSim: pict.topSim, margin: pict.margin, indexCount: pict.indexCount } : null,
      },
      ...(process.env.DEBUG_OCR ? { debug } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'identify-failed', failureKind: 'server', debugError: String(err && err.message || err), timing: { totalMs: Date.now() - t0 } },
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
