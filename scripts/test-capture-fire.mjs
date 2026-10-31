// Fixtures for the single firing decision (lib/capture-fire.js) —
// the rule every capture path feeds. Run: node scripts/test-capture-fire.mjs
import {
  SHARP_MIN, FIRE_MIN_MS, FIRE_STREAK_BOXED, FIRE_STREAK_HOLD,
  initialFireState, decideFire, guidanceLineFor,
} from '../lib/capture-fire.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}
const sample = (over = {}) => ({
  sharpness: 500, hasBox: true, stableName: null, stableNumber: null, expectsText: false, ...over,
});
const step = (state, over, nowMs) => decideFire(state, sample(over), nowMs);

// Constants (the bars the diagnosis stands on).
check('sharp bar is the 320px-calibrated 400', SHARP_MIN, 400);
check('settle is 1s', FIRE_MIN_MS, 1000);
check('boxed backstop streak is 3', FIRE_STREAK_BOXED, 3);
check('hold backstop streak is 13', FIRE_STREAK_HOLD, 13);

// Settle: nothing fires before 1s, whatever the sample.
{
  const r = step(initialFireState(1000), {}, 1500);
  check('no fire during settle', [r.fire, r.blocked], [null, 'settling']);
}

// Primary: text-complete + sharp, after settle — native frames.
{
  const r = step(initialFireState(1000), { expectsText: true, stableName: 'Iron Leaves', stableNumber: '025/162' }, 2000);
  check('primary fires on text-complete sharp frame', r.fire, 'primary');
  check('primary clears blocked', r.blocked, null);
}

// Primary needs a sharp frame: text-complete but soft does not fire.
{
  const r = step(initialFireState(1000), { expectsText: true, stableName: 'Iron Leaves', stableNumber: '025/162', sharpness: 399 }, 2000);
  check('no primary fire on soft frame', [r.fire, r.blocked], [null, 'not-sharp']);
  check('soft frame resets sharp streak', r.state.sharpStreak, 0);
}

// No second fire from a fired state.
{
  const first = step(initialFireState(1000), { expectsText: true, stableName: 'Iron Leaves', stableNumber: '025/162' }, 2000);
  const second = step(first.state, { expectsText: true, stableName: 'Iron Leaves', stableNumber: '025/162' }, 2200);
  check('no second fire after firing', second.fire, null);
}

// Backstop-boxed: 3 consecutive sharp boxed frames fire, even with
// no text read (WebView frames carry no live reads at all).
{
  let s = initialFireState(1000);
  let r = null;
  for (let i = 0; i < 3; i++) r = step(s, {}, 2000 + i * 200), s = r.state;
  check('backstop-boxed fires at 3 sharp boxed frames', r.fire, 'backstop-boxed');
  // And it does NOT fire at 2.
  let s2 = initialFireState(1000);
  let r2 = null;
  for (let i = 0; i < 2; i++) r2 = step(s2, {}, 2000 + i * 200), s2 = r2.state;
  check('no backstop-boxed fire at 2 sharp boxed frames', [r2.fire, r2.blocked], [null, 'need-streak']);
}

// Backstop-hold: 13 consecutive sharp frames fire with NO box — a
// detector blind spot must never permanently veto a steady hold.
{
  let s = initialFireState(1000);
  let r = null;
  for (let i = 0; i < 13; i++) r = step(s, { hasBox: false }, 2000 + i * 200), s = r.state;
  check('backstop-hold fires at 13 sharp boxless frames', r.fire, 'backstop-hold');
  let s2 = initialFireState(1000);
  let r2 = null;
  for (let i = 0; i < 12; i++) r2 = step(s2, { hasBox: false }, 2000 + i * 200), s2 = r2.state;
  check('no backstop-hold fire at 12 sharp boxless frames', [r2.fire, r2.blocked], [null, 'no-box']);
}

// A missing box does NOT reset the sharp streak: the streak counts
// sharp frames, and the box is checked at fire time. (Old semantics
// reset the streak on a missing box, which is how a holo card's
// fragmented detection starved the hold forever.) Boxless frames
// build the streak without firing, so the streak itself is observable.
{
  let s = initialFireState(1000);
  for (let i = 0; i < 5; i++) s = step(s, { hasBox: false }, 2000 + i * 200).state;
  const broken = step(s, { hasBox: false }, 3000);
  check('missing box keeps sharp streak counting', broken.state.sharpStreak, 6);
  check('missing box reports no-box, not a streak reset', broken.blocked, 'no-box');
}

// A soft frame DOES reset the streak (motion blur drops sharpness).
{
  let s = initialFireState(1000);
  for (let i = 0; i < 5; i++) s = step(s, { hasBox: false }, 2000 + i * 200).state;
  const soft = step(s, { sharpness: 100 }, 3000);
  check('soft frame resets sharp streak', soft.state.sharpStreak, 0);
}

// Native waiting-text: sharp + boxed + text incomplete reports
// waiting-text (the native side's guidance covers it).
{
  const r = step(initialFireState(1000), { expectsText: true, stableName: 'Iron Leaves', stableNumber: null }, 2000);
  check('native incomplete read reports waiting-text', r.blocked, 'waiting-text');
}

// WebView frames never report waiting-text (they carry no live reads).
{
  const r = step(initialFireState(1000), { stableName: null, stableNumber: null }, 2000);
  check('webview incomplete read reports need-streak, not waiting-text', r.blocked, 'need-streak');
}

// Null sharpness (measurement failure) counts as not sharp.
{
  const r = step(initialFireState(1000), { sharpness: null }, 2000);
  check('null sharpness reports not-sharp', r.blocked, 'not-sharp');
}

// Guidance mapping: actionable only, never a guess.
check('guidance: not-sharp -> Hold steady', guidanceLineFor({ blocked: 'not-sharp' }), 'Hold steady');
check('guidance: tiny box -> Move closer', guidanceLineFor({ blocked: 'need-streak', boxSmall: true }), 'Move closer');
check('guidance: no-box -> silent (never guess)', guidanceLineFor({ blocked: 'no-box' }), null);
check('guidance: need-streak -> silent (almost there)', guidanceLineFor({ blocked: 'need-streak' }), null);
check('guidance: settling -> silent', guidanceLineFor({ blocked: 'settling' }), null);
check('guidance: waiting-text -> silent (native side covers it)', guidanceLineFor({ blocked: 'waiting-text' }), null);

console.log(fail ? `\n${fail} FAILURES, ${pass} passed` : `\nall ${pass} checks passed`);
process.exit(fail ? 1 : 0);
