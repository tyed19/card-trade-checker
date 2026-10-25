// Anti-false-positive guardrails (pure helpers, no I/O). Imported by
// lib/hybrid.js (the API-facing layer, where every zone's candidates
// are finalized) and lib/identify.js (rescue number matching).
// Unit-tested in scripts/test-guards.mjs.
//
// The package, in one paragraph:
//  (1) TWO-SIGNAL RULE: a sole displayable candidate (a single choice
//      is a de facto accept for a pre-reader — there is nothing to
//      compare it against) must carry at least two INDEPENDENT
//      signals. Picture, printed number, attack/ability text, HP, and
//      name are the channels; a number's "/total" half does NOT count
//      as a second signal (same strip, same OCR pass). The name
//      channel's bar is 0.6 — the codebase's existing corroboration
//      bar (the gate's bare-number clause) — lowered from 0.8 by
//      Tye's 2026-10-25 decision on the Meowth case: the true card
//      (me02-106, full 106/94 with total agreement) read a 0.67 name
//      ("eowt") and was retaken on a single signal; number + 0.67
//      name is two honest signals, not a guess. A single-signal match
//      may still appear in a multi-candidate choice list (different
//      Pokémon are genuinely comparable by picture) or as a retake —
//      never as the sole choice.
//  (2) RIVAL-MARGIN ESCALATION: same-name rivalry is handled by
//      escalating to number/attack disambiguation (the full-OCR path)
//      and, if that fails, a retake WITH a specific hint — never by
//      offering the rival group as tap choices. (The old neighbor
//      fallback did exactly that, and a live sim-lane run offered two
//      Japanese Walking Wake ex cards for a Charizard photo — the
//      pool top was the wrong Pokémon entirely, so the "same-art
//      group" was not the photographed card at all.)
//  (3) HIGH-PRICE TRIPWIRE: a displayable candidate whose price is an
//      extreme outlier versus its same-name rivals may only stay
//      displayable with FULL printed-number agreement (NNN/TTT). A
//      bare number does not satisfy the tripwire: with rivals in
//      play, the picture does not pin the set, so a bare number
//      cannot pin the print.
//  (4) SET-TOTAL CROSS-CHECK: a full number match requires total
//      agreement when both totals are known (see totalAgrees). The
//      TCGdex main search and the hybrid number-band matcher already
//      did this; the rescue's numberMatch was the gap this closes.
//      A bare read has no total, so it is unaffected. Secret rares
//      (number above the set total) are NOT rejected by this: the
//      check is total EQUALITY, not number <= total.

// Art-agreement bar for the picture leg: the coName floor. A pool sim
// below this is "in the top 60", not agreement.
export const PICTURE_SIGNAL_MIN = 0.78;

// Outlier line: at least 3x the median same-name rival price AND at
// least $50 above it. Small-dollar noise ($30 vs $5) does not trip;
// a $900 edition against ~$99 siblings trips at 9x / $800.
export const TRIPWIRE_RATIO = 3;
export const TRIPWIRE_MIN_GAP = 50;

// Name channel bar for the two-signal rule (Tye's 2026-10-25 Meowth
// decision — see the package comment above). Deliberately NOT the
// tie-guard's discriminating-evidence bar (lib/identify.js
// hasEvidence, still 0.8): within a same-name rival group, a 0.67
// name does not distinguish prints, so it stays non-discriminating
// there; as a second signal beside a full number match it is honest
// corroboration that the right Pokémon was photographed.
export const NAME_SIGNAL_MIN = 0.6;

// A candidate's independent signals. Returns the count (0-5).
export function signalCount(c) {
  let n = 0;
  if (c.pictConfident === true || (c.pictSim || 0) >= PICTURE_SIGNAL_MIN) n++;
  if (c.numberMatch === true || c.bareNumMatch === true) n++;
  if ((c.attackTokens || 0) >= 2) n++;
  if ((c.nameSim || 0) >= NAME_SIGNAL_MIN) n++;
  if (c.hpMatch === true) n++;
  return n;
}

// Two-signal enforcement: if exactly one candidate is displayable
// (a sole choice = a de facto accept) and it carries fewer than two
// signals, demote it. Choice lists (>= 2 displayable) and retakes
// (0 displayable) are untouched. Returns how many were demoted.
export function enforceTwoSignal(candidates) {
  const disp = candidates.filter((c) => c.displayable);
  if (disp.length !== 1) return 0;
  if (signalCount(disp[0]) >= 2) return 0;
  disp[0].displayable = false;
  return 1;
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// True when price is an extreme outlier versus rivalPrices (same-name
// rivals' prices, nulls already removed). Needs at least one rival.
export function isPriceOutlier(price, rivalPrices) {
  if (price === null || price === undefined) return false;
  const rivals = (rivalPrices || []).filter((p) => p !== null && p !== undefined);
  if (!rivals.length) return false;
  const med = median(rivals);
  if (med === null || med <= 0) return false;
  return price >= TRIPWIRE_RATIO * med && price - med >= TRIPWIRE_MIN_GAP;
}

// Set-total agreement for a full number match: true when either side
// is unknown (cannot disprove) or the totals are equal. String-safe:
// totals arrive as strings ("108") or numbers (108) across books.
export function totalAgrees(readTotal, candidateTotal) {
  if (!readTotal || !candidateTotal) return true;
  return Number(readTotal) === Number(candidateTotal);
}
