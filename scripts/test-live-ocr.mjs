#!/usr/bin/env node
// Fixtures for FairSwap's on-device OCR web integration (lib/live-ocr.js
// + the /api/identify deviceOcr merge). No device, no photos, no
// network: everything here pins pure rules.
//
//   (1) Iron Leaves with correct deviceOcr { name: 'Iron Leaves',
//       number: '025/162' } satisfies the EXISTING fast-path gate
//       (selectFastCandidates: FULL number + set-total agreement +
//       banked nameSim >= 0.6) for the true #025 print only — the
//       rival edition print never qualifies.
//   (2) A corner-flagged shot with a glare-misread deviceOcr number
//       is refused by the existing corner-shot rule
//       (applyCornerShotRule): no offer, safe retake.
//   (3) deviceOcr disagreeing with the catalog is ignored: it yields
//       no fast candidate and never overwrites banked evidence.
//   (4) No deviceOcr: behavior identical to today (merge is a
//       pass-through; the pipeline's own reads decide).
// Plus the JS firing decision over ocrFrame events (primary vs
// backstop, stale-frame rejection, settle + sharp bars).
import {
  deviceOcrToPriorOcr, mergeDeviceOcrIntoPriorOcr, parseDeviceNumber,
  initialLiveOcrSession, liveOcrSessionStep, getLiveOcrEnabled,
} from '../lib/live-ocr.js';
import { selectFastCandidates, applyCornerShotRule, matchKind } from '../lib/hybrid.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}: got ${g}, want ${w}`); }
};
const g = (num, total, extra = {}) => ({ num: String(num), padded: String(num).padStart(3, '0'), total: total == null ? null : String(total), votes: 1, ...extra });
const c = (id, name, number, setTotal, nameSim, extra = {}) => ({ id, name, number: String(number), setTotal, nameSim, score: 0, displayable: false, ...extra });

// ---- deviceOcr parsing / priorOcr shape ----
check('parse 025/162', parseDeviceNumber('025/162'), g(25, 162));
check('parse bare 25', parseDeviceNumber('25'), g(25, null));
check('parse garbage is null', parseDeviceNumber('nope'), null);
check('parse null is null', parseDeviceNumber(null), null);
check('deviceOcr to priorOcr shape',
  deviceOcrToPriorOcr({ name: 'Iron Leaves', number: '025/162', script: 'latin' }),
  { name: 'Iron Leaves', nameGuesses: ['Iron Leaves'], number: '025/162', numberGuesses: [g(25, 162)], attackGuesses: [], hpGuess: null });
check('empty deviceOcr is null', deviceOcrToPriorOcr({ name: '', number: '', script: null }), null);
check('null deviceOcr is null', deviceOcrToPriorOcr(null), null);
check('name-only deviceOcr keeps number empty',
  deviceOcrToPriorOcr({ name: 'Victini', number: null, script: 'latin' }),
  { name: 'Victini', nameGuesses: ['Victini'], number: '', numberGuesses: [], attackGuesses: [], hpGuess: null });

// ---- (4) no deviceOcr: pass-through ----
{
  const prior = { name: 'Meowth', nameGuesses: ['Meowth'], number: '106/094', numberGuesses: [g(106, 94)], attackGuesses: [], hpGuess: null };
  check('no deviceOcr leaves prior untouched', mergeDeviceOcrIntoPriorOcr(prior, null), prior);
  check('no prior + no device is null', mergeDeviceOcrIntoPriorOcr(null, null), null);
  check('no prior + device stands alone',
    mergeDeviceOcrIntoPriorOcr(null, { name: 'Iron Leaves', number: '025/162', script: 'latin' }),
    { name: 'Iron Leaves', nameGuesses: ['Iron Leaves'], number: '025/162', numberGuesses: [g(25, 162)], attackGuesses: [], hpGuess: null });
}

// ---- (3) disagreeing deviceOcr: ignored, prior preserved ----
{
  const prior = { name: 'Meowth', nameGuesses: ['Meowth'], number: '106/094', numberGuesses: [g(106, 94)], attackGuesses: [], hpGuess: null };
  const merged = mergeDeviceOcrIntoPriorOcr(prior, { name: 'Zapdos', number: '999/999', script: 'latin' });
  check('disagreeing device name appends, never overwrites banked name',
    merged.nameGuesses, ['Meowth', 'Zapdos']);
  check('disagreeing device number appends, never overwrites banked number',
    merged.numberGuesses.map((x) => `${x.padded}/${x.total}`), ['106/94', '999/999']);
  // And the fast gate still refuses it: no catalog candidate agrees
  // with 999/999, so the hint creates nothing on its own.
  check('disagreeing device number yields no fast candidate',
    selectFastCandidates(
      [c('sv05-25', 'Iron Leaves ex', '25', '162', 0.92)],
      merged.numberGuesses.filter((x) => x.padded === '999'),
    ).length, 0);
}

// ---- (1) Iron Leaves fast-path contract ----
// The merged device guesses behave exactly like the corner close-up
// guesses the fast path already trusts: FULL number + set-total
// agreement + banked nameSim >= 0.6.
{
  const merged = mergeDeviceOcrIntoPriorOcr(null, { name: 'Iron Leaves', number: '025/162', script: 'latin' });
  const out = selectFastCandidates(
    [c('sv05-25', 'Iron Leaves ex', '25', '162', 0.92), c('sv05-203', 'Iron Leaves ex', '203', '162', 0.92)],
    merged.numberGuesses,
  );
  check('device fast path resolves #025 only', out.map((x) => x.id), ['sv05-25']);
  check('device fast path sets numberMatch', out[0] && out[0].numberMatch, true);
  check('device fast path sets displayable', out[0] && out[0].displayable, true);
  // Same gate, number-band form: the device guess fully matches the
  // true print's catalog row (numeric compare, so 025 == 25).
  check('device guess fully matches true print row',
    matchKind(merged.numberGuesses[0], { entry: { localId: '25', setTotal: '162' }, lang: 'en' }), 'full');
  check('device guess does not match rival print row',
    matchKind(merged.numberGuesses[0], { entry: { localId: '203', setTotal: '162' }, lang: 'en' }), null);
  // Total disagreement still blocks, even with a hot device name.
  check('device fast path blocked on total disagreement',
    selectFastCandidates([c('x-25', 'Iron Leaves ex', '25', '198', 0.92)], merged.numberGuesses).length, 0);
  // Weak banked name still blocks: a device number alone is not two
  // signals.
  check('device fast path blocked on weak banked name',
    selectFastCandidates([c('sv05-25', 'Iron Leaves ex', '25', '162', 0.4)], merged.numberGuesses).length, 0);
}

// ---- (2) corner-flagged glare misread: corner-shot rule refuses ----
{
  // Route order: deviceOcr merges into priorOcr FIRST, then the
  // corner rule reads names from that merged prior — so a
  // device-driven candidate is judged by the rule, not exempted.
  const merged = mergeDeviceOcrIntoPriorOcr(null, { name: 'id yy moan', number: '001/100', script: 'latin' });
  const copy = [
    { id: 'banette-1', name: 'Banette', number: '1', displayable: true, numberMatch: true, nameSim: 0.22 },
    { id: 'dusknoir-1', name: 'Dusknoir', number: '1', displayable: true, numberMatch: true, nameSim: 0.19 },
  ];
  applyCornerShotRule(copy, [...(merged.nameGuesses || []), merged.name].filter(Boolean));
  check('corner rule demotes glare-misread device-number offers',
    copy.filter((x) => x.displayable).map((x) => x.id), []);
  // And the honest counterpart: a device name that DOES agree keeps
  // a true number+name candidate (same rule, same bar as server OCR).
  const kept = [{ id: 'sv05-25', name: 'Iron Leaves ex', number: '25', displayable: true, numberMatch: true, nameSim: 0 }];
  applyCornerShotRule(kept, ['Iron eaves Ei a']);
  check('corner rule keeps device name+number agreement', kept.filter((x) => x.displayable).map((x) => x.id), ['sv05-25']);
}

// ---- Firing decision over ocrFrame events ----
const frame = (id, over = {}) => ({
  frameId: id,
  cardBox: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  observations: [],
  stable: { name: null, number: null },
  sharpness: 500,
  ...over,
});
{
  // Primary: stable name + stable number + sharp, after the 1s settle.
  let s = initialLiveOcrSession(1000);
  let r = liveOcrSessionStep(s, frame(0, { stable: { name: 'Iron Leaves', number: '025/162' } }), 2000);
  check('primary fires on text-complete sharp frame', r.fire, 'primary');
  check('primary live-fill reports name+number', r.state.liveFill, { name: true, number: true });
  // No second fire from the same session.
  r = liveOcrSessionStep(r.state, frame(1, { stable: { name: 'Iron Leaves', number: '025/162' } }), 2200);
  check('no second fire after firing', r.fire, null);
}
{
  // Settle bar: text-complete but before 1s does not fire.
  let s = initialLiveOcrSession(1000);
  const r = liveOcrSessionStep(s, frame(0, { stable: { name: 'Iron Leaves', number: '025/162' } }), 1500 - 600);
  check('no fire before autofocus settle', r.fire, null);
}
{
  // Sharp bar: text-complete but soft frame does not fire (and does
  // not count toward the backstop streak).
  let s = initialLiveOcrSession(1000);
  const r = liveOcrSessionStep(s, frame(0, { stable: { name: 'Iron Leaves', number: '025/162' }, sharpness: 399 }), 2000);
  check('no primary fire on soft frame', r.fire, null);
  check('soft frame resets sharp streak', r.state.sharpStreak, 0);
}
{
  // Partial reads never fire primary: number missing.
  let s = initialLiveOcrSession(1000);
  const r = liveOcrSessionStep(s, frame(0, { stable: { name: 'Iron Leaves', number: null } }), 2000);
  check('no primary fire on name-only read', r.fire, null);
  check('live-fill tracks name-only', r.state.liveFill, { name: true, number: false });
}
{
  // Stale frames are ignored outright (same or older frameId).
  let s = initialLiveOcrSession(1000);
  const first = liveOcrSessionStep(s, frame(5, { stable: { name: 'Iron Leaves', number: null } }), 2000);
  const stale = liveOcrSessionStep(first.state, frame(5, { stable: { name: 'Iron Leaves', number: '025/162' } }), 2200);
  check('stale frame ignored (no fire, state unchanged)', [stale.fire, stale.state.lastFrameId], [null, 5]);
  const older = liveOcrSessionStep(first.state, frame(3, { stable: { name: 'Iron Leaves', number: '025/162' } }), 2200);
  check('older frame ignored', [older.fire, older.state.lastFrameId], [null, 5]);
}
{
  // Backstop: 13 consecutive sharp boxed frames (~2.6s at 200ms)
  // fire even with no text read at all; a broken streak restarts.
  let s = initialLiveOcrSession(1000);
  let fired = null;
  for (let i = 0; i < 12; i++) {
    const r = liveOcrSessionStep(s, frame(i, { sharpness: 500 }), 2000 + i * 200);
    s = r.state;
    fired = r.fire;
  }
  check('no backstop fire at 12 sharp frames', fired, null);
  const r13 = liveOcrSessionStep(s, frame(12, { sharpness: 500 }), 2000 + 12 * 200);
  check('backstop fires at 13 sharp boxed frames', r13.fire, 'backstop');
  // A frame without a card box breaks the streak.
  let s2 = initialLiveOcrSession(1000);
  for (let i = 0; i < 5; i++) s2 = liveOcrSessionStep(s2, frame(i, { sharpness: 500 }), 2000 + i * 200).state;
  const broken = liveOcrSessionStep(s2, frame(5, { cardBox: null, sharpness: 500 }), 3000);
  check('missing card box resets backstop streak', broken.state.sharpStreak, 0);
}
{
  // Toggle: OFF by default outside a browser (no window here).
  check('live-OCR toggle defaults off', getLiveOcrEnabled(), false);
}

console.log(fail ? `\n${fail} FAILURES, ${pass} passed` : `\nall ${pass} checks passed`);
process.exit(fail ? 1 : 0);
