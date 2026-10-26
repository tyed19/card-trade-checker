// Fixtures for the auto-capture steadiness + firing rule
// (lib/steady.js). Dots and firing are separate: points fill the dots
// and never fire; firing needs a consecutive-fire-sample streak, a
// settle window, and a framed card.
import { steadyStep, steadyDotFill, STEADY_GOAL, isFireSample, goodStreakStep, shouldFire, shouldFireFallback, FIRE_FALLBACK_STREAK, FIRE_MIN_MS } from '../lib/steady.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}
const good = { diff: 5, sharpness: 900 };
const okay = { diff: 15, sharpness: 900 };
const bad = { diff: 40, sharpness: 900 };
const blurry = { diff: 2, sharpness: 100 };

// Feed a sample sequence through the streak + fire decision and
// report whether firing ever happened.
function everFires(seq, { elapsedMs = 5000, framed = true } = {}) {
  let streak = 0;
  for (const s of seq) {
    streak = goodStreakStep(streak, isFireSample(s));
    if (shouldFire({ goodStreak: streak, elapsedMs, framed })) return true;
  }
  return false;
}

// --- Dots (points) still behave as before ---
let p = 0;
p = steadyStep(p, good); p = steadyStep(p, good); p = steadyStep(p, good);
check('three good samples fill the dots', p >= STEADY_GOAL);

p = 0;
for (let i = 0; i < 6; i++) p = steadyStep(p, okay);
check('six okay samples fill the dots', p >= STEADY_GOAL);

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
check('one bad sample dents but does not wipe dot progress', p === 1.5);

check('dot fills are fractional and bounded', steadyDotFill(1.5, 0) === 1 && steadyDotFill(1.5, 1) === 0.5 && steadyDotFill(1.5, 2) === 0 && steadyDotFill(0, 0) === 0);

// --- Firing rule (the 2026-10-25 retune) ---
check('alternating good/bad NEVER fires (streak resets)', !everFires([good, bad, good, bad, good, bad, good, bad, good, bad, good, bad]));

check('a single good sample NEVER fires', !everFires([good]));

check('okay samples NEVER fire (sharp-but-drifting is not fire-grade)', !everFires([okay, okay, okay, okay, okay, okay]));

check('blurry samples NEVER fire', !everFires([blurry, blurry, blurry]));

check('2 consecutive good samples after the settle window MUST fire', everFires([good, good], { elapsedMs: FIRE_MIN_MS + 200 }));

check('2 consecutive good samples inside the settle window must NOT fire', !everFires([good, good], { elapsedMs: 400 }));

check('a steady-but-unframed case must NOT fire', !everFires([good, good, good], { framed: false }));

check('a good sample after a bad one restarts the streak (needs a fresh pair)', !everFires([good, bad, good]) && everFires([good, bad, good, good]));

// --- Fallback hold (Iron Leaves regression): a long unbroken run of
// firing-grade frames fires even when the box gate never clears.
function everFiresFallback(seq, { elapsedMs = 5000 } = {}) {
  let streak = 0;
  for (const s of seq) {
    streak = goodStreakStep(streak, isFireSample(s));
    if (shouldFireFallback({ goodStreak: streak, elapsedMs })) return true;
  }
  return false;
}
const hold = Array.from({ length: FIRE_FALLBACK_STREAK }, () => good);
check('fallback: a full ~2.6s steady hold fires without a framed box', everFiresFallback(hold));
check('fallback: one sample short of the hold does NOT fire', !everFiresFallback(hold.slice(0, -1)));
check('fallback: a broken streak never reaches the hold', !everFiresFallback([...hold.slice(0, 6), bad, ...hold.slice(0, 6)]));
check('fallback: inside the settle window it must NOT fire', !everFiresFallback(hold, { elapsedMs: 400 }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
