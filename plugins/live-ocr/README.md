# @fairswap/live-ocr — JS wrapper

Local Capacitor plugin for FairSwap's on-device live-frame OCR camera
screen (Apple Vision on iOS, Google ML Kit on Android). The native
implementations live under `ios/` and `android/`; this package is only
the JS side of the bridge, written to match the official plugins' web
fallbacks (`registerPlugin('LiveOcr', { web: ... })` with a `WebPlugin`
subclass).

## No build toolchain — dist is checked in by hand

This plugin has **no build step**. Do not run a bundler over it: the
files under `dist/` are hand-written and checked in directly, matching
the `main` / `module` / `types` fields in `package.json`:

- `src/index.ts` — source of truth for the contract (types + web fallback)
- `dist/esm/index.js` — ES module entry (hand-kept in sync with `src/`)
- `dist/esm/index.d.ts` — types entry (hand-kept in sync with `src/`)
- `dist/plugin.cjs.js` — CommonJS entry (hand-kept in sync with `src/`)

When the contract changes, edit `src/index.ts` first, then mirror the
change into all three `dist/` files in the same commit. If they drift,
the browser fallback and the native bridge disagree silently — check
them together in review.

## Bridge contract (native side implements exactly this)

- `isAvailable()` → `{ supported: boolean, reason?: 'unsupported-os' | 'no-camera' | 'model-missing' }`
- `startCamera({ stage, locked })` → opens the native camera screen.
  `stage` is the missing piece from `lib/progress.js`
  (`'number' | 'tilt' | 'straight'`), or `null` for a fresh shot with
  nothing banked yet; `locked` is the already-banked pieces
  (`{ picture?, name?, number? }` booleans) so a second shot starts
  with the correct outline fill and pulsing segment.
- `ocrFrame` events (via `addListener`):
  `{ frameId, cardBox: {x,y,w,h} | null, observations: [{ text, confidence: number | null, boundingBox, region: 'title' | 'number' | 'attack' | 'other', script }], stable: { name, number }, sharpness: number | null }`
  `frameId` is monotonic; JS ignores stale frames (`frameId <= last seen`).
  `sharpness` uses the same bar as the web gate (`SHARP_MIN` in
  `lib/steady.js`). `stable` carries the native side's stable reads
  (same string in the same region on consecutive sampled frames);
  single-frame sightings stay candidates and never appear in `stable`.
- `snapRequest` event → JS calls `capture()` (manual SNAP bypasses
  every firing rule, as today).
- `closed` event → JS tears down defensively (`stopCamera()`), returns
  to the trade screen, and opens nothing on top.
- `capture()` → `{ base64, deviceOcr: { name, number, script } }`.
  The JPEG honors the existing upload contract (max 2400px, q90).
- `stopCamera()` → tears down the session and all analysis.

## Web fallback behavior

In a plain browser — or in a shell where the native implementation is
absent — every call resolves inert and never throws:
`isAvailable()` → `{ supported: false, reason: 'no-camera' }`,
`startCamera()` / `stopCamera()` resolve to nothing, `capture()`
resolves to `null`, and no listener ever fires. The web app therefore
always takes the WebView preview path there, and never breaks.

## How the web app uses it

`lib/live-ocr.js` wraps this plugin (dynamic import, so a browser
session never has to load native code eagerly), owns the firing
decision over `ocrFrame` events, converts `capture()`'s base64 to a
`File` exactly like `lib/native.js`'s `base64ToFile`, and feeds the
existing upload pipeline unchanged. The native screen is chosen only
when `isNative()` is true AND the grown-ups-only live-OCR toggle is ON
AND `isAvailable().supported` is true; every other case keeps the
current WebView preview path, and on ITS failure the existing handoff
banner (never a silent system-camera drop).
