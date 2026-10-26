#!/usr/bin/env node
// Fixtures for native camera preview routing (lib/capture-route.js):
// the guided preview must run wherever getUserMedia exists —
// including inside the native shell — so capture never hands off to
// the phone's camera app (or Google Lens) on the primary path. The
// native Camera plugin is strictly a fallback; the picker is terminal.
//
//   node scripts/test-preview-route.mjs
import { captureEntry, afterPreviewAutoFail } from '../lib/capture-route.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  if (got === want) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}: got ${got}, want ${want}`); }
};

// Entry path.
check('browser + GUM -> preview', captureEntry({ isNative: false, hasGetUserMedia: true }), 'preview');
check('browser + no GUM -> picker', captureEntry({ isNative: false, hasGetUserMedia: false }), 'picker');
check('native + GUM -> preview (in-shell, no Lens detour)', captureEntry({ isNative: true, hasGetUserMedia: true }), 'preview');
check('native + no GUM -> native plugin', captureEntry({ isNative: true, hasGetUserMedia: false }), 'native');
// Falsy GUM values behave as absent.
check('native + undefined GUM -> native plugin', captureEntry({ isNative: true, hasGetUserMedia: undefined }), 'native');
check('browser + undefined GUM -> picker', captureEntry({ isNative: false, hasGetUserMedia: undefined }), 'picker');

// After the preview itself fails.
check('preview autofail native -> native plugin', afterPreviewAutoFail({ isNative: true }), 'native');
check('preview autofail browser -> picker', afterPreviewAutoFail({ isNative: false }), 'picker');

// The preview path never depends on the shell: a browser and a shell
// with a camera take the same primary path.
check('preview is shell-independent when GUM exists',
  captureEntry({ isNative: true, hasGetUserMedia: true }) === captureEntry({ isNative: false, hasGetUserMedia: true }) ? 'same' : 'diff', 'same');

console.log(`\npreview-route: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
