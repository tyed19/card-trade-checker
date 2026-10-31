// The ONE firing decision for every capture path in FairSwap — the
// native live-OCR screen and the WebView preview both feed it the
// same normalized sample shape, and it returns the same verdict.
// It replaces the layered accumulation it supersedes (lib/steady.js's
// diff-based streak, lib/framing.js's outline-coverage gate), which
// is deleted with it. One implementation, one owner, testable block
// reasons — so the next field report of "never fires" arrives with a
// reason instead of a shrug.
//
// Why there is NO frame-difference term: measured 2026-10-31 on real
// photos, a mere 1px shift between consecutive 160px frames scores a
// mean absolute diff of 8.2–8.4, above the old FIRE bar of 7. A phone
// held in a human hand can never hold 2 consecutive sub-7 frames,
// let alone the old fallback hold's 13 — the old rule demanded
// tripod stillness and silently never fired on Android. Motion blur
// already shows up as lost sharpness, so a sharp-frame streak IS the
// stillness proxy; no diff term is needed.
//
// Sampling scale is fixed at 320px wide everywhere: SHARP_MIN = 400
// was calibrated at ~320px (lib/shotquality.js), and native frames
// already report measureShot-exact 320px values. The old preview
// sampled at 160px while judging against a 320px bar.
//
// Firing, in priority order:
//   PRIMARY: stable name + stable number actually read, on a sharp
//     frame, after the autofocus settle. This is the new path: fire
//     because the text was read, not because framing looked good.
//     (WebView frames carry no live reads, so they can never fire
//     primary — they fall through to the backstops.)
//   BACKSTOP-BOXED: a short run of consecutive sharp frames with a
//     card box present. The card is framed and still; the text may
//     genuinely be unreadable live, and the shot still reaches the
//     server exactly as today.
//   BACKSTOP-HOLD: a long run of consecutive sharp frames even with
//     no box — a detector blind spot (holo fragmentation, glare)
//     must never permanently veto a steady hold.
// Manual SNAP always bypasses every rule (the caller never asks).
//
// `blocked` is diagnostic truth, not user copy: it names the gate
// that blocked THIS sample so the grown-ups diagnostic line can say
// why nothing fired. guidanceLineFor() maps it to the one short
// user-facing line — and deliberately maps 'no-box' to null, because
// a detector that cannot see the card must never guess an
// instruction at the kid (the old lying-'corners'-chip failure).

export const SHARP_MIN = 400;
export const FIRE_MIN_MS = 1000;
export const FIRE_STREAK_BOXED = 3;
export const FIRE_STREAK_HOLD = 13;

export function initialFireState(startedMs = 0) {
  return { startedMs, sharpStreak: 0, fired: false };
}

// Sample: { sharpness (number|null), hasBox (bool),
//   stableName (string|null), stableNumber (string|null),
//   expectsText (bool: true on native frames, false on WebView
//   frames, which carry no live reads) }.
// Returns { state, fire, blocked } where fire is 'primary' |
// 'backstop-boxed' | 'backstop-hold' | null and blocked is
// 'settling' | 'not-sharp' | 'waiting-text' | 'no-box' |
// 'need-streak' | null.
export function decideFire(state, sample, nowMs) {
  const prev = state || initialFireState(0);
  if (prev.fired) return { state: prev, fire: null, blocked: null };
  const sharp = typeof sample.sharpness === 'number' && sample.sharpness >= SHARP_MIN;
  const hasBox = !!sample.hasBox;
  const stableName = typeof sample.stableName === 'string' && sample.stableName.trim() ? sample.stableName : null;
  const stableNumber = typeof sample.stableNumber === 'string' && sample.stableNumber.trim() ? sample.stableNumber : null;
  const sharpStreak = sharp ? prev.sharpStreak + 1 : 0;
  const elapsedMs = nowMs - (prev.startedMs || 0);
  const next = { startedMs: prev.startedMs, sharpStreak, fired: false };
  if (elapsedMs < FIRE_MIN_MS) return { state: next, fire: null, blocked: 'settling' };
  if (stableName && stableNumber && sharp) {
    next.fired = true;
    return { state: next, fire: 'primary', blocked: null };
  }
  if (!sharp) return { state: next, fire: null, blocked: 'not-sharp' };
  if (sharpStreak >= FIRE_STREAK_HOLD) {
    next.fired = true;
    return { state: next, fire: 'backstop-hold', blocked: null };
  }
  if (sharpStreak >= FIRE_STREAK_BOXED && hasBox) {
    next.fired = true;
    return { state: next, fire: 'backstop-boxed', blocked: null };
  }
  if (sample.expectsText && hasBox) return { state: next, fire: null, blocked: 'waiting-text' };
  if (!hasBox) return { state: next, fire: null, blocked: 'no-box' };
  return { state: next, fire: null, blocked: 'need-streak' };
}

// The one short guidance line for a blocked WebView sample, or null
// when nothing actionable can honestly be said. boxSmall is the
// caller's "card genuinely tiny in frame" signal (box height well
// under the frame height); it outranks the streak reasons because a
// too-small card needs moving closer, not holding stiller.
export function guidanceLineFor({ blocked, boxSmall = false } = {}) {
  if (boxSmall) return 'Move closer';
  if (blocked === 'not-sharp') return 'Hold steady';
  return null;
}
