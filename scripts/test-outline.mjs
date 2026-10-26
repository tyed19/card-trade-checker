#!/usr/bin/env node
// Fixtures for the RESET's single progress language (lib/outline.js):
// the card outline's border segments fill gold ONLY as the server
// confirms each piece (top = title, sides = art, bottom = number),
// and only the missing piece's segment pulses. Live framing quality
// never fills — so no state here can stall mid-way like the old
// percent did. A locked segment never pulses.
import { outlineSegments, outlineClasses } from '../lib/outline.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}: got ${g}, want ${w}`); }
};

// 1. Nothing banked, no stage: all plain, no classes.
check('fresh outline is all plain',
  outlineSegments({ locked: null, stage: null }),
  { top: 'plain', sides: 'plain', bottom: 'plain' });
check('fresh outline has no classes',
  outlineClasses(outlineSegments({ locked: null, stage: null })), '');

// 2. Number stage (Iron Leaves case): title + art banked, number
//    missing -> top + sides locked, bottom pulses.
check('number stage: name+art locked, number pulses',
  outlineSegments({ locked: { picture: true, name: true, number: false }, stage: 'number' }),
  { top: 'locked', sides: 'locked', bottom: 'pulse' });
check('number stage classes',
  outlineClasses(outlineSegments({ locked: { picture: true, name: true, number: false }, stage: 'number' })),
  'lockName lockArt pulseNumber');

// 3. Straight stage (number+picture read, name missing): only the
//    top segment pulses; the locked bottom stays locked, not pulsing.
check('straight stage: number locked, name pulses',
  outlineSegments({ locked: { picture: true, name: false, number: true }, stage: 'straight' }),
  { top: 'pulse', sides: 'locked', bottom: 'locked' });

// 4. Tilt stage: no single piece is missing (the angle is), so
//    nothing pulses — the guidance line carries it.
check('tilt stage: nothing pulses',
  outlineSegments({ locked: { picture: false, name: false, number: false }, stage: 'tilt' }),
  { top: 'plain', sides: 'plain', bottom: 'plain' });

// 5. Everything banked: all locked, no pulse even with a stage set
//    (a locked segment never pulses).
check('all locked: no pulse',
  outlineSegments({ locked: { picture: true, name: true, number: true }, stage: 'number' }),
  { top: 'locked', sides: 'locked', bottom: 'locked' });
check('all locked classes',
  outlineClasses(outlineSegments({ locked: { picture: true, name: true, number: true }, stage: 'number' })),
  'lockName lockArt lockNumber');

// 6. Number stage but number already locked (stale stage): no pulse.
check('number stage with number locked: no pulse',
  outlineSegments({ locked: { picture: false, name: false, number: true }, stage: 'number' }),
  { top: 'plain', sides: 'plain', bottom: 'locked' });

// 7. Partial progress object (missing keys read as not banked).
check('partial locked object',
  outlineSegments({ locked: { name: true }, stage: 'number' }),
  { top: 'locked', sides: 'plain', bottom: 'pulse' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
