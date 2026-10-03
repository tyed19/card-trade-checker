import { NextResponse } from 'next/server';
import { readCardPhoto } from '../../../lib/ocr';
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
  try {
    const form = await req.formData();
    const file = form.get('photo');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ ok: false, error: 'No photo received' }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const { nameGuess, nameGuesses, numberGuess, numberGuesses, attackGuesses, debug } = await readCardPhoto(buffer);
    const candidates = await findCandidates({ nameGuess, nameGuesses, numberGuess, numberGuesses, attackGuesses, photoBuffer: buffer });
    return NextResponse.json({
      ok: true,
      ocr: {
        name: nameGuess || '',
        nameGuesses: nameGuesses || [],
        number: numberGuess ? `${numberGuess.padded}${numberGuess.total ? '/' + numberGuess.total : ''}` : '',
        numberGuesses: numberGuesses || [],
        attackGuesses: attackGuesses || [],
      },
      candidates,
      ...(process.env.DEBUG_OCR ? { debug } : {}),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err && err.message || err) }, { status: 500 });
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
    return NextResponse.json({ ok: true, candidates });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err && err.message || err) }, { status: 500 });
  }
}
