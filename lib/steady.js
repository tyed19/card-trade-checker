// Steadiness + firing rule for the guided preview's auto-capture
// (app/camera-preview.js). Pure functions, no DOM — tested by
// scripts/test-steady.mjs.
//
// Two separate things, deliberately decoupled:
//   - DOTS (progress): points accumulate — good +1, okay +0.5, bad
//     −0.5 floored at 0 — and the three dots fill fractionally, so
//     the kid always sees progress toward a snap. Points NEVER fire
//     on their own.
//   - FIRING: the points rule shipped in ab26f53 fired too fast on
//     real phones (Tye, 2026-10-25: "goes real fast and I'm not even
//     sure it's getting a quality picture"). Alternating good/bad
//     samples fired in ~1.2s, and firing checked steadiness only —
//     never whether the card was actually well-framed. So firing now
//     needs all three:
//       1. FIRE_GOOD_STREAK consecutive FIRE samples (diff <
//          FIRE_DIFF, sharpness >= SHARP_MIN — a genuinely still,
//          sharp frame; one okay or bad sample resets the streak,
//          so alternating good/bad can never fire),
//       2. FIRE_MIN_MS since the preview started (phone autofocus
//          settles before any fire),
//       3. a framed card (lib/framing.js — box present, whole, big
//          enough, on a contrasting background).
// Backstops unchanged: the pre-submit blur gate (BLUR_MIN 400 in
// lib/shotquality.js) still rejects a blurry shot in under a second,
// and auto-capture sends the sharpest recent frame.

export const STEADY_GOAL = 3;
export const DIFF_GOOD = 12;
export const DIFF_OKAY = 20;
export const SHARP_MIN = 400;

// Firing bar: stricter than the dots' GOOD bar — a fire sample is a
// genuinely still frame, not just a sharp-but-drifting one.
export const FIRE_DIFF = 7;
export const FIRE_GOOD_STREAK = 2;
export const FIRE_MIN_MS = 1000;
// Fallback hold: a box-detector miss must never permanently veto
// auto-capture (Iron Leaves, iPhone, 2026-10-25: dots filled, chip
// lied about corners, nothing ever fired). A long UNBROKEN run of
// firing-grade frames — ~2.6s at the 200ms sample rate — fires even
// without a framed box. The pre-submit blur gate, crop-first
// upload, and server retake guidance still protect quality, and
// manual SNAP already bypasses the gate entirely.
export const FIRE_FALLBACK_STREAK = 13;

export function steadyStep(progress, { diff, sharpness }) {
  if (sharpness >= SHARP_MIN && diff < DIFF_GOOD) {
    return Math.min(STEADY_GOAL, progress + 1);
  }
  if (sharpness >= SHARP_MIN && diff < DIFF_OKAY) {
    return Math.min(STEADY_GOAL, progress + 0.5);
  }
  return Math.max(0, progress - 0.5);
}

// Is this sample a firing-grade frame (still AND sharp)?
export function isFireSample({ diff, sharpness }) {
  return sharpness >= SHARP_MIN && diff < FIRE_DIFF;
}

// Consecutive-fire-sample streak: any non-fire sample resets it.
export function goodStreakStep(streak, isFire) {
  return isFire ? streak + 1 : 0;
}

// The full firing decision. `framed` comes from lib/framing.js.
export function shouldFire({ goodStreak, elapsedMs, framed }) {
  return goodStreak >= FIRE_GOOD_STREAK && elapsedMs >= FIRE_MIN_MS && framed === true;
}

// The fallback decision: a long unbroken run of firing-grade frames
// fires even when the box gate never clears (detector blind spot).
// Same streak, longer threshold — a genuinely steady hold, not a
// lucky frame.
export function shouldFireFallback({ goodStreak, elapsedMs }) {
  return goodStreak >= FIRE_FALLBACK_STREAK && elapsedMs >= FIRE_MIN_MS;
}

// Fractional fill of steady dot i (0, 1, 2) at the given progress —
// dots visibly fill as steadiness accumulates instead of flipping
// on/off only on perfect samples.
export function steadyDotFill(progress, i) {
  return Math.max(0, Math.min(1, progress - i));
}
