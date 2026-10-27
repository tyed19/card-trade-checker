#!/usr/bin/env node
// Fixtures for native camera preview routing (lib/capture-route.js):
// the guided preview must run wherever getUserMedia exists —
// including inside the native shell — so capture never hands off to
// the phone's camera app (or Google Lens) on the primary path. The
// native Camera plugin is strictly a fallback; the picker is terminal.
//
//   node scripts/test-preview-route.mjs
import { captureEntry, afterPreviewAutoFail, handoffNotice } from '../lib/capture-route.js';

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

// Automatic camera handoff must never be silent (2026-10-26 Android
// field report: system camera, tiny/far card, blur-gate rejection, no
// idea the preview had failed). The banner names the failure and
// carries framing guidance the dumb camera never shows.
const generic = handoffNotice({});
check('generic handoff names a failed start', generic.title, "The in-app camera couldn't start");
check('generic handoff guides framing', generic.guidance,
  "Your phone's camera will open instead. Get close — fill the frame with the card, all four corners showing — and hold still.");
check('generic handoff has no settings line', generic.settings, null);
const denied = handoffNotice({ denied: true });
check('denied handoff names the block', denied.title, 'Camera is blocked for FairSwap');
check('denied handoff gives the settings path', denied.settings,
  'Allow Camera in Settings → FairSwap → Camera to use the in-app camera.');
const noApi = handoffNotice({ noApi: true });
check('no-api handoff names unavailability', noApi.title, "The in-app camera isn't available here");
check('no-api handoff still guides framing', noApi.guidance, generic.guidance);

console.log(`\npreview-route: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
