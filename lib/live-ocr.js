// Web integration for FairSwap's on-device OCR native camera module
// (see plugins/live-ocr/README.md for the bridge contract and the
// approved spec in ~/workspace/your_files/fairswap-on-device-ocr-spec.md).
//
// Three jobs, kept separate so each is unit-testable in
// scripts/test-live-ocr.mjs:
//   1. Plugin wrapper: dynamically import @fairswap/live-ocr exactly
//      like lib/native.js (a browser session never loads it eagerly),
//      and make every call inert — never throwing — where the plugin
//      is absent. The plugin's own web fallback already resolves
//      inert; these wrappers add a second safety net for a missing
//      module or a rejected call.
//   2. Firing decision over ocrFrame events (pure): this module does
//      NOT own the rule — it delegates to lib/capture-fire.js, the
//      SAME decideFire() the WebView preview feeds. Native frames
//      differ only in that they carry live reads (expectsText: true)
//      and a card box from the native analyzer. PRIMARY fire: stable
//      name + stable number on a sharp frame after the 1s settle.
//      BACKSTOP fire: a short run of sharp boxed frames, or a long
//      run of sharp frames with no box (detector blind spot).
//      Manual SNAP (the snapRequest event) bypasses every rule
//      entirely, as today. Session vocabulary keeps 'backstop' for
//      both hold flavors; the distinction lives in capture-fire and
//      is tested there directly.
//   3. deviceOcr -> priorOcr merge (pure): the server treats device
//      reads as prior-evidence HINTS in exactly the existing priorOcr
//      shape, so lib/hybrid.js's merge, gates, and corner-shot rule
//      apply to them unchanged. Device hints never suppress the
//      server's own reading and never create a choice by themselves.
//
// Outline states (single-outline language, per the reset): a segment
// is LIVE-filled when its region has a stable read (name / number;
// art has no live text and fills only on server confirmation). It
// turns GOLD only from the /api/identify response's progress
// (picture / name / number) — the web app never paints gold from a
// live read. liveOcrSessionStep reports liveFill for the firing
// decision and grown-ups diagnostics; gold comes from the server.

import { decideFire } from './capture-fire.js';

// ---- Grown-ups toggle (persisted in localStorage, lazily like
// lib/store.js — never touched at module scope, so server-side import
// is safe). The stored value is the explicit choice; when nothing is
// stored, the PAGE applies the shell default (native ON in the shell,
// off in a browser) — this getter alone stays a plain stored-value
// read so the no-window fixture ("defaults off") still holds.
export const LIVE_OCR_STORAGE_KEY = 'fairswap-live-ocr-enabled';

export function getLiveOcrEnabled() {
  try {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(LIVE_OCR_STORAGE_KEY) === '1';
  } catch { return false; }
}

export function setLiveOcrEnabled(on) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LIVE_OCR_STORAGE_KEY, on ? '1' : '0');
  } catch { /* persistence is a preference, never a blocker */ }
}

// ---- Plugin wrapper (dynamic import, inert everywhere else) ----

async function loadPlugin() {
  try {
    const mod = await import('@fairswap/live-ocr');
    return (mod && (mod.LiveOcr || mod.default)) || null;
  } catch { return null; }
}

// Capability check. Anything but supported:true takes the WebView
// preview path; the reason feeds the grown-ups diagnostic line
// (in-memory only, never stored or transmitted).
export async function isLiveOcrAvailable() {
  try {
    const plugin = await loadPlugin();
    if (!plugin || typeof plugin.isAvailable !== 'function') {
      return { supported: false, reason: 'no-camera' };
    }
    const res = await plugin.isAvailable();
    if (res && res.supported === true) return { supported: true };
    return { supported: false, reason: (res && res.reason) || 'no-camera' };
  } catch {
    return { supported: false, reason: 'no-camera' };
  }
}

export async function startLiveCamera(options) {
  try {
    const plugin = await loadPlugin();
    if (!plugin || typeof plugin.startCamera !== 'function') return false;
    await plugin.startCamera(options || { stage: null, locked: null });
    return true;
  } catch { return false; }
}

export async function stopLiveCamera() {
  try {
    const plugin = await loadPlugin();
    if (plugin && typeof plugin.stopCamera === 'function') await plugin.stopCamera();
  } catch { /* teardown failure is swallowed: the screen is gone either way */ }
}

// Listener helpers: each resolves to the Capacitor listener handle
// (with .remove()) or null when the plugin is absent. Callers remove
// handles when the session ends; a null handle is a no-op.
async function addLiveListener(event, cb) {
  try {
    const plugin = await loadPlugin();
    if (!plugin || typeof plugin.addListener !== 'function') return null;
    return await plugin.addListener(event, cb);
  } catch { return null; }
}

export function addLiveOcrFrameListener(cb) {
  return addLiveListener('ocrFrame', cb);
}

export function addLiveSnapRequestListener(cb) {
  return addLiveListener('snapRequest', cb);
}

export function addLiveClosedListener(cb) {
  return addLiveListener('closed', cb);
}

// capture() -> { base64, deviceOcr } on device, null on web / failure.
// The caller converts base64 to a File (livePhotoToFile, same bytes
// logic as lib/native.js base64ToFile) and feeds the EXISTING upload
// pipeline unchanged.
export async function captureLivePhoto() {
  try {
    const plugin = await loadPlugin();
    if (!plugin || typeof plugin.capture !== 'function') return null;
    const res = await plugin.capture();
    if (!res || !res.base64) return null;
    return res;
  } catch { return null; }
}

// Same conversion as lib/native.js base64ToFile (kept local: that
// helper is not exported, and this module must not widen native.js's
// surface). The File then goes through prepareForUpload exactly like
// any other capture, so the crop-first / blur-gate contract holds.
export function livePhotoToFile(base64, filename = 'card.jpg') {
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new File([buf], filename, { type: 'image/jpeg' });
}

// ---- Firing decision over ocrFrame events (pure) ----

export function initialLiveOcrSession(startedMs = 0) {
  return {
    lastFrameId: -1,
    startedMs,
    sharpStreak: 0,
    fired: false,
    liveFill: { name: false, number: false },
  };
}

// Step one native frame through the firing decision. Stale frames
// (frameId <= last seen) are ignored outright — a stalled pipeline
// must never fire on old frames. Returns { state, fire, blocked }
// where fire is 'primary' | 'backstop' | null and blocked is the
// capture-fire block reason (for the grown-ups diagnostic line).
// `nowMs` is the caller's clock (Date.now() in the page); tests pass
// it explicitly.
export function liveOcrSessionStep(state, frame, nowMs) {
  const prev = state || initialLiveOcrSession(0);
  if (!frame || typeof frame.frameId !== 'number' || frame.frameId <= prev.lastFrameId) {
    return { state: prev, fire: null, blocked: null };
  }
  const stable = frame.stable || {};
  const stableName = typeof stable.name === 'string' && stable.name.trim() ? stable.name : null;
  const stableNumber = typeof stable.number === 'string' && stable.number.trim() ? stable.number : null;
  const { state: fireState, fire: rawFire, blocked } = decideFire(
    { startedMs: prev.startedMs, sharpStreak: prev.sharpStreak, fired: prev.fired },
    { sharpness: frame.sharpness, hasBox: !!frame.cardBox, stableName, stableNumber, expectsText: true },
    nowMs,
  );
  const next = {
    lastFrameId: frame.frameId,
    startedMs: prev.startedMs,
    sharpStreak: fireState.sharpStreak,
    fired: fireState.fired,
    liveFill: { name: !!stableName, number: !!stableNumber },
  };
  if (prev.fired) return { state: next, fire: null, blocked: null };
  const fire = rawFire === 'primary' ? 'primary' : rawFire ? 'backstop' : null;
  return { state: next, fire, blocked: fire ? null : blocked };
}

// ---- deviceOcr -> priorOcr merge (pure, shared by the route) ----

// Parse a device number string ('025/162', '25', '025') into the
// number-guess shape lib/hybrid.js already consumes: num is the bare
// numeric string (leading-zero-insensitive downstream via strip0),
// padded is zero-padded, total is the set total when printed.
export function parseDeviceNumber(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d{1,3})\s*(?:\/\s*(\d{1,3}))?/);
  if (!m) return null;
  const num = String(parseInt(m[1], 10));
  return {
    num,
    padded: num.padStart(3, '0'),
    total: m[2] ? String(parseInt(m[2], 10)) : null,
    votes: 1,
  };
}

// Convert one capture's deviceOcr ({ name, number, script }) into the
// existing priorOcr shape. Null when it carries nothing usable — the
// server then runs the current pipeline unchanged. `script` is
// carried for diagnostics only; no gate reads it.
export function deviceOcrToPriorOcr(deviceOcr) {
  if (!deviceOcr || typeof deviceOcr !== 'object') return null;
  const name = typeof deviceOcr.name === 'string' ? deviceOcr.name.trim() : '';
  const number = parseDeviceNumber(deviceOcr.number);
  if (!name && !number) return null;
  return {
    name,
    nameGuesses: name ? [name] : [],
    number: number ? `${number.padded}${number.total ? '/' + number.total : ''}` : '',
    numberGuesses: number ? [number] : [],
    attackGuesses: [],
    hpGuess: null,
  };
}

// Union device hints into the priorOcr the client already sent (the
// first photo's OCR summary on a continuation shot). Prior evidence
// keeps its order; device guesses append deduped — a device read
// never overwrites banked evidence, it only adds to it. With no
// prior, the device hints stand alone; with no usable device reads,
// the prior passes through untouched.
export function mergeDeviceOcrIntoPriorOcr(priorOcr, deviceOcr) {
  const dev = deviceOcrToPriorOcr(deviceOcr);
  if (!dev) return priorOcr || null;
  if (!priorOcr) return dev;
  const seenNames = new Set([...(priorOcr.nameGuesses || []), priorOcr.name].filter(Boolean));
  const nameGuesses = [...(priorOcr.nameGuesses || [])];
  for (const n of dev.nameGuesses) {
    if (!seenNames.has(n)) { nameGuesses.push(n); seenNames.add(n); }
  }
  const key = (g) => `${g.padded}/${g.total || ''}/${g.bare ? 'b' : ''}`;
  const seenNums = new Set((priorOcr.numberGuesses || []).map(key));
  const numberGuesses = [...(priorOcr.numberGuesses || [])];
  for (const g of dev.numberGuesses) {
    if (!seenNums.has(key(g))) { numberGuesses.push(g); seenNums.add(key(g)); }
  }
  return {
    ...priorOcr,
    nameGuesses,
    numberGuesses,
  };
}
