// Fixtures for the deadline path (lib/progress.js): when the identify
// route's 50s race fires mid-flight, the response must degrade to a
// guided retake with whatever progress was banked — never to the
// generic error Tye saw most of the time on both phones (a ~45s wait
// then "Something went wrong"). Shapes mirror real production
// snapshots: the Iron Leaves lane reports picture + number-band
// stages long before its full read finishes.
import { summarizePartialProgress, partialOcr, deadlineRetake } from '../lib/progress.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// No snapshot at all (deadline during model load): nothing banked,
// angle is the honest next move, second shot still offered.
{
  const p = summarizePartialProgress(null);
  check('empty snapshot: nothing banked, tilt', p.banked === 0 && p.missing === 'tilt');
  const body = deadlineRetake(null, 'NUMBER_CORNER_HINT');
  check('empty deadline body: ok + slow + deadline kind', body.ok === true && body.slow === true && body.failureKind === 'deadline');
  check('empty deadline body: no choices, second shot offered', body.confident === false && body.secondPhoto === true && !('candidates' in body));
  check('empty deadline body: no ocr merged', !('ocr' in body));
  check('empty deadline body: no hint without a missing piece', body.retakeHint === null);
}

// Picture pool matched, number-band read found nothing yet: the
// picture signal is banked, the number corner is the missing piece.
{
  const snap = {
    pict: { topSim: 0.86 },
    poolLight: [{ name: 'Iron Leaves ex', number: '25', sim: 0.86 }],
    numReading: { numberGuesses: [] },
  };
  const p = summarizePartialProgress(snap);
  check('pool-only snapshot: picture banked, number missing', p.picture === true && p.number === false && p.missing === 'number');
}

// Number-band guess agreeing with a pool print banks the number,
// even with no candidates yet ('025' vs pool localId '25').
{
  const snap = {
    pict: { topSim: 0.5 },
    poolLight: [{ name: 'Iron Leaves ex', number: '25', sim: 0.5 }],
    numReading: { numberGuesses: [{ padded: '025', total: '162', bare: false }] },
  };
  const p = summarizePartialProgress(snap);
  check('number-band agreement banks number', p.number === true);
  // Picture below threshold + name missing: a lone corner read
  // stages as 'tilt' — the angle is suspect, per the documented rule.
  check('lone corner read without picture: tilt stage', p.missing === 'tilt');
  const framed = summarizePartialProgress({ ...snap, pict: { topSim: 0.86 } });
  check('number + picture banked, name missing: straight stage', framed.number === true && framed.missing === 'straight');
}

// A number guess that agrees with NO pool print banks nothing —
// the JP Charizard false-'98' shape must not fake a banked number
// when the pool never contained a 98.
{
  const snap = {
    pict: { topSim: 0.86 },
    poolLight: [{ name: 'Charizard V', number: '14', sim: 0.86 }],
    numReading: { numberGuesses: [{ padded: '098', total: null, bare: false }] },
  };
  const p = summarizePartialProgress(snap);
  check('unmatched number guess banks nothing', p.number === false && p.missing === 'number');
}

// Full-read number guesses count too (deadline during findCandidates).
{
  const snap = {
    pict: { topSim: 0.86 },
    poolLight: [{ name: 'Iron Leaves ex', number: '25', sim: 0.86 }],
    reading: { numberGuesses: [{ padded: '025', total: '162', bare: false }], nameGuesses: [], attackGuesses: [] },
  };
  const p = summarizePartialProgress(snap);
  check('full-read number guess banks number', p.number === true);
}

// Candidates present: one definition of the signals — delegate.
{
  const snap = {
    pict: { topSim: 0.7 },
    candidates: [
      { id: 'sv05-203', name: 'Iron Leaves ex', nameSim: 0.92, score: 80 },
      { id: 'sv05-025', name: 'Iron Leaves ex', nameSim: 0.92, score: 79 },
    ],
  };
  const p = summarizePartialProgress(snap);
  check('candidates delegate: name banked, number missing', p.name === true && p.number === false && p.missing === 'number');
}

// Raw title guess with no candidate agreement never banks name.
{
  const snap = {
    pict: { topSim: 0.86 },
    poolLight: [{ name: 'Iron Leaves ex', number: '25', sim: 0.86 }],
    reading: { nameGuesses: ['Iron Leaves ex'], numberGuesses: [], attackGuesses: [] },
  };
  const p = summarizePartialProgress(snap);
  check('raw name guess alone banks no name', p.name === false && p.missing === 'number');
}

// Deadline body carries the partial OCR so the guided second shot
// unions with the first shot's evidence instead of starting over.
{
  const snap = {
    pict: { topSim: 0.86 },
    poolLight: [{ name: 'Iron Leaves ex', number: '25', sim: 0.86 }],
    numReading: { numberGuesses: [{ padded: '025', total: '162', bare: false }] },
  };
  const body = deadlineRetake(snap, 'NUMBER_CORNER_HINT');
  check('deadline body: no number hint when number is banked', body.retakeHint === null);
  check('deadline body: ocr merged for next shot', body.ocr && body.ocr.number === '025/162' && body.ocr.numberGuesses.length === 1);
}

// Deadline body for the Iron Leaves mid-flight shape: picture banked,
// number missing, number-corner hint, second shot offered.
{
  const snap = {
    pict: { topSim: 0.86 },
    poolLight: [{ name: 'Iron Leaves ex', number: '25', sim: 0.86 }],
    numReading: { numberGuesses: [] },
  };
  const body = deadlineRetake(snap, 'NUMBER_CORNER_HINT');
  check('Iron Leaves deadline body: progress + hint + second shot',
    body.progress.picture === true && body.progress.missing === 'number'
    && body.retakeHint === 'NUMBER_CORNER_HINT' && body.secondPhoto === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
