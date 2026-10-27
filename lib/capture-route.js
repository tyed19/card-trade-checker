// Capture routing for TAKE A PICTURE / second photo (see app/page.js).
//
// The guided live preview runs wherever getUserMedia exists —
// INCLUDING inside the native shell. Two platform facts make that
// safe, verified against the pinned Capacitor 8 sources:
//   - Android: BridgeWebChromeClient.onPermissionRequest maps a
//     WebView VIDEO_CAPTURE request to Manifest.permission.CAMERA,
//     launches the runtime permission prompt, and grants the stream
//     when allowed. The app manifest must DECLARE the permission
//     (android/app/src/main/AndroidManifest.xml) or the request
//     auto-denies — the camera plugin's own manifest does not declare
//     it, and the shell previously worked without it only because it
//     handed capture off to another app via intent.
//   - iOS: WKWebView serves getUserMedia from NSCameraUsageDescription
//     (already in Info.plist) over the HTTPS remote URL.
// The native Camera plugin is strictly a fallback: it fires an
// ACTION_IMAGE_CAPTURE intent, which on some Android phones resolves
// to Google Lens instead of the camera — the detour Tye hit. The
// photo picker is the terminal fallback; it can never strand a kid.
//
// Paths: 'preview' (guided live preview), 'native' (Camera plugin),
// 'picker' (hidden file input).

// Entry path for a fresh capture tap.
export function captureEntry({ isNative, hasGetUserMedia }) {
  if (hasGetUserMedia) return 'preview';
  if (isNative) return 'native';
  return 'picker';
}

// Where to go when the preview itself fails (no camera, denied
// permission, no API): the shell retries via the native plugin before
// giving up; a browser has no plugin to try. When the shell's plugin
// ALSO misses, the page names the failure with a small notice
// (Settings path back + picker button) instead of silently dropping
// to the picker — see onPreviewAutoFail in app/page.js.
export function afterPreviewAutoFail({ isNative }) {
  return isNative ? 'native' : 'picker';
}

// The automatic handoff to the phone's camera must NEVER be silent.
// Field evidence (2026-10-26, Android): TAKE A PICTURE dropped
// straight into the raw system camera app — no outline, no SNAP, no
// guidance — so shots came back tiny and far away and died at the
// blur gate, while the user had no idea the in-app camera had failed
// to start at all. The old Oct 19 sideload is the prime suspect (its
// manifest never declared CAMERA, so WebView getUserMedia auto-denies
// and every tap falls through to the intent), but WHATEVER the cause,
// the app must stop and name it before opening a dumb camera — and
// use that stop to deliver the framing guidance the system camera
// never shows (get close, fill the frame, all four corners, hold
// still). The page renders this as a banner with Open camera /
// Never-mind actions; the handoff only fires on the user's tap.
// Deliberate escapes ("Use photo picker instead", the camNotice's
// "Pick a photo") stay immediate — the user already chose to leave.
export function handoffNotice({ denied = false, noApi = false } = {}) {
  return {
    title: denied
      ? 'Camera is blocked for FairSwap'
      : noApi
        ? "The in-app camera isn't available here"
        : "The in-app camera couldn't start",
    guidance: "Your phone's camera will open instead. Get close — fill the frame with the card, all four corners showing — and hold still.",
    settings: denied
      ? 'Allow Camera in Settings → FairSwap → Camera to use the in-app camera.'
      : null,
  };
}
