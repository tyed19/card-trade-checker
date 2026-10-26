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
