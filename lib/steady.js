// Steadiness accumulator for the guided preview's auto-capture
// (app/camera-preview.js). Pure function, no DOM — tested by
// scripts/test-steady.mjs.
//
// Why points instead of a streak: the old rule needed 3 consecutive
// perfect samples (frame-diff < 7, sharpness >= 400), and one shaky
// sample reset the streak to zero — on a real hand-held phone the
// dots almost never all filled, so the bank-check-style auto-capture
// Tye loves never fired. Points accumulate and only decay:
//   - GOOD sample (diff < DIFF_GOOD, sharpness >= SHARP_MIN): +1
//   - OKAY sample (diff < DIFF_OKAY, sharpness >= SHARP_MIN): +0.5
//     (sharp but drifting — still a usable frame)
//   - anything else: -0.5, floored at 0 — a shaky sample dents
//     progress, it never wipes it.
// Fire at STEADY_GOAL (3 points): three good samples (~600ms), six
// okay ones, or any mix — e.g. good/bad alternating still fires in
// ~1.2s. This is safe because of the two backstops that do NOT move:
// the pre-submit blur gate (BLUR_MIN 400 in lib/shotquality.js)
// rejects a blurry auto-shot in under a second, and auto-capture
// always sends the sharpest recent frame, not the triggering one.

export const STEADY_GOAL = 3;
export const DIFF_GOOD = 12;
export const DIFF_OKAY = 20;
export const SHARP_MIN = 400;

export function steadyStep(progress, { diff, sharpness }) {
  if (sharpness >= SHARP_MIN && diff < DIFF_GOOD) {
    return Math.min(STEADY_GOAL, progress + 1);
  }
  if (sharpness >= SHARP_MIN && diff < DIFF_OKAY) {
    return Math.min(STEADY_GOAL, progress + 0.5);
  }
  return Math.max(0, progress - 0.5);
}

// Fractional fill of steady dot i (0, 1, 2) at the given progress —
// dots visibly fill as steadiness accumulates instead of flipping
// on/off only on perfect samples.
export function steadyDotFill(progress, i) {
  return Math.max(0, Math.min(1, progress - i));
}
