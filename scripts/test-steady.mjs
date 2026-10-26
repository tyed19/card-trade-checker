// Fixtures for the auto-capture steadiness accumulator (lib/steady.js).
import { steadyStep, steadyDotFill, STEADY_GOAL } from '../lib/steady.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}
const good = { diff: 5, sharpness: 900 };
const okay = { diff: 15, sharpness: 900 };
const bad = { diff: 40, sharpness: 900 };
const blurry = { diff: 2, sharpness: 100 };

let p = 0;
p = steadyStep(p, good); p = steadyStep(p, good); p = steadyStep(p, good);
check('three good samples reach the goal', p >= STEADY_GOAL);

p = 0;
for (let i = 0; i < 6; i++) p = steadyStep(p, okay);
check('six okay samples reach the goal', p >= STEADY_GOAL);

p = 0;
let peak = 0;
for (let i = 0; i < 6; i++) { p = steadyStep(p, good); peak = Math.max(peak, p); p = steadyStep(p, bad); }
check('good/bad alternating still reaches the goal (decay, not reset)', peak >= STEADY_GOAL);

p = 0;
for (let i = 0; i < 10; i++) p = steadyStep(p, bad);
check('all-bad samples stay at zero', p === 0);

p = 0;
p = steadyStep(p, bad);
check('a bad sample never goes negative', p === 0);

p = 0;
for (let i = 0; i < 5; i++) p = steadyStep(p, blurry);
check('blurry samples never accumulate (blur gate backstop stays meaningful)', p === 0);

p = 0;
p = steadyStep(p, good); p = steadyStep(p, good); p = steadyStep(p, bad);
check('one bad sample dents but does not wipe progress', p === 1.5);

check('dot fills are fractional and bounded', steadyDotFill(1.5, 0) === 1 && steadyDotFill(1.5, 1) === 0.5 && steadyDotFill(1.5, 2) === 0 && steadyDotFill(0, 0) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
