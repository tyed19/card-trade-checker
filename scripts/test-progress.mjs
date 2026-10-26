// Fixtures for progressive capture (lib/progress.js): which signals
// a failed identify banked, and which stage the next guided shot
// should aim at. Shapes mirror real production responses.
import { summarizeProgress } from '../lib/progress.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Iron Leaves ex (production, 2026-10-25): name nailed at 0.92 on all
// three prints, number never read, editions tied. The number corner
// is the missing piece.
{
  const cands = [
    { id: 'sv05-203', name: 'Iron Leaves ex', nameSim: 0.92, score: 80 },
    { id: 'sv05-025', name: 'Iron Leaves ex', nameSim: 0.92, score: 79 },
    { id: 'svp-128', name: 'Iron Leaves ex', nameSim: 0.92, score: 79 },
  ];
  const p = summarizeProgress({ candidates: cands, pict: { topSim: 0.7 } });
  check('Iron Leaves: name banked, number missing', p.name === true && p.number === false);
  check('Iron Leaves: next stage is number', p.missing === 'number');
  check('Iron Leaves: banked count 1', p.banked === 1);
}

// Sandaconda VMAX rainbow (production, 2026-10-25): only vintage
// noise with weak nameSim, no number, weak art. Nothing banked —
// the angle/glare is the problem, so tilt.
{
  const cands = [
    { id: 'ecard2-13', name: 'Exeggutor', nameSim: 0.17, score: 69 },
    { id: 'ecard2-15', name: 'Houndoom', nameSim: 0.17, score: 69 },
    { id: 'neo1-57', name: 'Cyndaquil', nameSim: 0.22, score: 69 },
  ];
  const p = summarizeProgress({ candidates: cands, pict: { topSim: 0.5 } });
  check('Sandaconda: nothing banked', p.picture === false && p.name === false && p.number === false);
  check('Sandaconda: next stage is tilt', p.missing === 'tilt');
  check('Sandaconda: banked count 0', p.banked === 0);
}

// Picture-only: strong art, no text at all. The number corner is the
// most decisive next piece (pins the print and adds the signal).
{
  const p = summarizeProgress({
    candidates: [{ id: 'x', name: 'Mew ex', nameSim: 0.3, pictSim: 0.91, score: 100 }],
    pict: { topSim: 0.91 },
  });
  check('picture-only: picture banked', p.picture === true);
  check('picture-only: next stage is number', p.missing === 'number');
}

// Name-only: the name read but neither art nor number agreed.
{
  const p = summarizeProgress({
    candidates: [{ id: 'x', name: 'Pikachu', nameSim: 0.95, score: 90 }],
    pict: { topSim: 0.4 },
  });
  check('name-only: name banked', p.name === true);
  check('name-only: next stage is number', p.missing === 'number');
}

// Number + picture read but name missing (clean corner, strong art,
// unread title): reframe straight and close so the text reads.
{
  const p = summarizeProgress({
    candidates: [{ id: 'x', name: 'Pikachu', nameSim: 0.2, pictSim: 0.91, numberMatch: true, score: 100 }],
    pict: { topSim: 0.91 },
  });
  check('number+picture-without-name: number banked', p.number === true);
  check('number+picture-without-name: next stage is straight', p.missing === 'straight');
}

// A lone corner read with neither picture nor name agreeing: the
// angle is suspect even though a number was seen, so tilt.
{
  const p = summarizeProgress({
    candidates: [{ id: 'x', name: 'Pikachu', nameSim: 0.2, numberMatch: true, score: 100 }],
    pict: { topSim: 0.4 },
  });
  check('lone-corner-read: number reported as seen', p.number === true);
  check('lone-corner-read: stage is tilt', p.missing === 'tilt');
}

// Name + number banked but still not confident (tripwire/tie the
// number didn't break): only a cleaner angle can help.
{
  const p = summarizeProgress({
    candidates: [{ id: 'x', name: 'Charizard ex', nameSim: 0.9, numberMatch: true, score: 180 }],
    pict: { topSim: 0.85 },
  });
  check('name+number banked: banked count 3', p.banked === 3);
  check('name+number banked: fallback stage is tilt', p.missing === 'tilt');
}

// JP Charizard false-number case: a number matched on wrong cards
// whose names never agreed. The ring reports the number as seen, but
// the stage stays tilt — the angle is suspect, not the corner.
{
  const cands = [
    { id: 'ex2-98', name: 'Raichu ex', nameSim: 0.22, numberMatch: true, score: 152 },
    { id: 'dp5-98', name: 'Glaceon', nameSim: 0.2, numberMatch: true, score: 151 },
  ];
  const p = summarizeProgress({ candidates: cands, pict: { topSim: 0.6 } });
  check('false-number: number reported as seen', p.number === true);
  check('false-number: name not banked', p.name === false);
  check('false-number: stage stays tilt', p.missing === 'tilt');
}

// Empty / degenerate input never throws and yields the tilt stage.
{
  const p = summarizeProgress({});
  check('empty input: all false, tilt', eq(p, { picture: false, name: false, number: false, missing: 'tilt', banked: 0 }));
  const p2 = summarizeProgress({ candidates: null, pict: null });
  check('null input: all false, tilt', p2.missing === 'tilt' && p2.banked === 0);
}

// pictConfident alone banks picture even when topSim is absent
// (the picture+number fast path returns a confident-flagged card).
{
  const p = summarizeProgress({
    candidates: [{ id: 'x', name: 'Mew ex', nameSim: 0.3, pictConfident: true }],
    pict: null,
  });
  check('pictConfident banks picture', p.picture === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
