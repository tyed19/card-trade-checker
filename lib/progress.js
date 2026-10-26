// Progressive capture: which signals a FAILED identify already banked,
// and which single piece the next guided shot should aim at. Pure
// function, no I/O — unit-tested in scripts/test-progress.mjs.
//
// The three signals are the same channels the two-signal rule counts
// (lib/guards.js): picture (pool art at/above PICTURE_SIGNAL_MIN),
// name (a candidate nameSim at/above NAME_SIGNAL_MIN), and printed
// number (a candidate full or bare number match). This module never
// decides anything: it only summarizes what the pipeline found, so
// the client can show a wordless progress ring instead of looping on
// generic retakes. Only the existing confidence gate can ever produce
// choices — a banked signal here is evidence, never a verdict.
//
// Missing-piece priority (the next stage the preview highlights):
//   - 'tilt'    nothing matched at all (art never matched, no name):
//              the angle/glare/framing is wrong; change the angle.
//   - 'number'  something matched (picture or name) but no number:
//              the collector-number corner is the decisive piece —
//              it both adds the second signal and splits same-name
//              editions (Iron Leaves ex: name 0.92, three editions
//              tied, number unreadable). The preview emphasizes the
//              two bottom-edge dots for this stage.
//   - 'straight' number and picture read but name missing: reframe
//              straight and close so the title text reads. (A lone
//              corner read with neither picture nor name agreeing
//              still stages as 'tilt' — the angle is suspect there.)
//   - 'tilt'    (fallback) name and number both banked yet still not
//              confident — e.g. a tripwire or tie the number didn't
//              break: a cleaner angle is the only honest next move.
// A false number match on a wrong card (the JP Charizard '98' case)
// still shows as banked — the ring reports what the server saw, not
// what is true — but the stage stays 'tilt' there, because neither
// picture nor name agreed with that number, so the angle is suspect.

import { NAME_SIGNAL_MIN, PICTURE_SIGNAL_MIN } from './guards.js';

export const PROGRESS_STAGES = ['number', 'tilt', 'straight'];

// Partial progress for the DEADLINE path (see deadlineRetake below):
// the route's 50s race can fire while the pipeline is mid-flight, when
// no candidate list exists yet. Derive the same three signals from
// whatever stage snapshots the pipeline already reported:
//   - picture: the picture pool's top art similarity (same bar as the
//     two-signal rule — a pool match is picture evidence on its own).
//   - name: NEVER banked here — a raw title guess with no catalog
//     candidate agreeing with it is not a signal the two-signal rule
//     counts, and the ring must not claim otherwise.
//   - number: a number guess (number-band read or full read) that
//     agrees with a pool print's collector number (numeric compare,
//     so '025' and '25' agree). Print-level agreement, same as a
//     candidate numberMatch, just computed without candidates.
// With candidates present this delegates to summarizeProgress — one
// definition of the signals, never two.
export function summarizePartialProgress(snap) {
  if (!snap) return { picture: false, name: false, number: false, missing: 'tilt', banked: 0 };
  if (snap.candidates && snap.candidates.length) {
    return summarizeProgress({ candidates: snap.candidates, pict: snap.pict || null });
  }
  const picture = !!((snap.pict && (snap.pict.topSim || 0) >= PICTURE_SIGNAL_MIN));
  const name = false;
  let number = false;
  const pool = Array.isArray(snap.poolLight) ? snap.poolLight : [];
  const norm = (v) => {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? String(n) : null;
  };
  const guessLists = [];
  if (snap.numReading && Array.isArray(snap.numReading.numberGuesses)) guessLists.push(snap.numReading.numberGuesses);
  if (snap.reading && Array.isArray(snap.reading.numberGuesses)) guessLists.push(snap.reading.numberGuesses);
  for (const list of guessLists) {
    for (const g of list) {
      const gn = norm(g.padded ?? g.num);
      if (!gn) continue;
      if (pool.some((p) => norm(p.number) === gn)) { number = true; break; }
    }
    if (number) break;
  }
  let missing;
  if (!picture && !name) missing = 'tilt';
  else if (!number) missing = 'number';
  else if (!name) missing = 'straight';
  else missing = 'tilt';
  return { picture, name, number, missing, banked: (picture ? 1 : 0) + (name ? 1 : 0) + (number ? 1 : 0) };
}

// The client's OCR summary shape (what the two-photo merge sends back
// as priorOcr), built from a partial snapshot. Null when the snapshot
// has no reading at all — the next shot then starts clean instead of
// merging junk. Lets a deadline-guided second shot union with the
// first shot's text evidence instead of starting from zero.
export function partialOcr(snap) {
  const reading = (snap && snap.reading) || (snap && snap.numReading) || null;
  if (!reading) return null;
  const numberGuess = reading.numberGuess || (reading.numberGuesses && reading.numberGuesses[0]) || null;
  return {
    name: reading.nameGuess || '',
    nameGuesses: reading.nameGuesses || [],
    number: numberGuess ? `${numberGuess.padded}${numberGuess.total ? '/' + numberGuess.total : ''}` : '',
    numberGuesses: reading.numberGuesses || [],
    attackGuesses: reading.attackGuesses || [],
    hpGuess: reading.hpGuess !== undefined && reading.hpGuess !== null ? reading.hpGuess : null,
  };
}

// Deadline response body: shaped EXACTLY like a normal non-confident
// identify response (ok + progress + second-photo offer) so the
// client takes its guided-retake branch instead of the generic error
// branch. A slow lane degrades to guidance, never to "something went
// wrong": the ring shows what was banked, the hint names the missing
// piece, and secondPhoto offers the next guided shot. No candidates
// are ever included here — a half-gated candidate must never leak
// into a choice; only the existing confidence gate creates choices,
// and it did not run. failureKind is grown-ups diagnostics only
// (in-memory client state, never stored or transmitted).
export function deadlineRetake(snapshot, numberCornerHint) {
  const progress = summarizePartialProgress(snapshot);
  const body = {
    ok: true,
    confident: false,
    slow: true,
    failureKind: 'deadline',
    progress,
    retakeHint: progress.missing === 'number' ? numberCornerHint : null,
    secondPhoto: true,
  };
  const ocr = partialOcr(snapshot);
  if (ocr) body.ocr = ocr;
  return body;
}

export function summarizeProgress({ candidates = [], pict = null } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const picture = !!(
    (pict && (pict.topSim || 0) >= PICTURE_SIGNAL_MIN)
    || list.some((c) => c.pictConfident === true || (c.pictSim || 0) >= PICTURE_SIGNAL_MIN)
  );
  const name = list.some((c) => (c.nameSim || 0) >= NAME_SIGNAL_MIN);
  const number = list.some((c) => c.numberMatch === true || c.bareNumMatch === true);
  let missing;
  if (!picture && !name) missing = 'tilt';
  else if (!number) missing = 'number';
  else if (!name) missing = 'straight';
  else missing = 'tilt';
  return {
    picture,
    name,
    number,
    missing,
    banked: (picture ? 1 : 0) + (name ? 1 : 0) + (number ? 1 : 0),
  };
}
