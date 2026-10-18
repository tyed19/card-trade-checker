// Native bridge for the FairSwap Capacitor shell (docs/CAPACITOR.md).
//
// The web app always runs the same code in a plain browser and inside
// the native shell (which loads this deployment by remote URL). Every
// function here is guarded: in a browser all of them are inert
// (isNative() false, takeNativePhoto() null) and every call site falls
// back to the exact pre-Capacitor behavior (the hidden <input
// type="file"> flow). Plugin packages are imported dynamically so a
// browser session never has to load or execute them.

export function isNative() {
  try {
    return typeof window !== 'undefined'
      && !!window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform() === true;
  } catch { return false; }
}

function base64ToFile(base64, filename) {
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new File([buf], filename, { type: 'image/jpeg' });
}

// Take a photo with the native camera plugin and hand back a File the
// EXISTING upload pipeline can consume (callers still run it through
// shrinkForUpload, so the 2400px / JPEG-q90 contract is unchanged).
//
// Returns:
//   File        — success
//   'cancelled' — the kid backed out of the camera; caller should do
//                 nothing (NOT open the fallback picker on top of them)
//   null        — not native, plugin missing, permission denied, or
//                 any other failure; caller falls back to the file
//                 input exactly as before.
//
// Plugin settings: quality 90 matches the pipeline's JPEG q90;
// width 2400 matches its max upload dimension (the plugin downscales
// before handing us the data, so the in-page shrink is a no-op safety
// net rather than the only line of defense). correctOrientation keeps
// the EXIF trap from shrinkForUpload's comments from reappearing
// through the native path.
export async function takeNativePhoto() {
  if (!isNative()) return null;
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
    const photo = await Camera.getPhoto({
      quality: 90,
      width: 2400,
      resultType: CameraResultType.Base64,
      source: CameraSource.Camera,
      correctOrientation: true,
      promptLabelHeader: 'Take a picture of the card',
      promptLabelPhoto: 'From Photos',
      promptLabelPicture: 'Take a Picture',
    });
    if (!photo || !photo.base64String) return null;
    return base64ToFile(photo.base64String, 'card.jpg');
  } catch (err) {
    const msg = String((err && err.message) || err || '');
    if (/cancel/i.test(msg)) return 'cancelled';
    return null;
  }
}

// A light happy buzz when a FAIR verdict lands. Native only; any
// failure is swallowed — haptics are a bonus, never a blocker.
export async function verdictHaptic() {
  if (!isNative()) return;
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch { /* no buzz, no problem */ }
}

// Native share sheet for grown-ups sharing gift/binder links, where a
// call site offers it. Returns true if the sheet was shown; callers
// keep their copy-link fallback for false (browser, cancel, error).
export async function nativeShare({ title, text, url }) {
  if (!isNative()) return false;
  try {
    const { Share } = await import('@capacitor/share');
    await Share.share({ title, text, url, dialogTitle: 'Share' });
    return true;
  } catch { return false; }
}
