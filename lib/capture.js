// Browser-side capture prep: find the card, crop to it, and upload
// the CROP at high quality instead of a whole-frame photo compressed
// twice. This is the fix for the measured phone-path collapse (Meowth
// name similarity 0.67 raw -> 0.25 on the 2400px/JPEG-q90 lane): the
// old path spent most of the image on table/background, then the
// server re-encoded to 1800px/JPEG-q90 — two JPEG passes over text
// that was already small. Crop-first gives the card ~1800px across
// (vs ~1080px after the old double shrink) in a single q95 pass.
//
// The box detector is a faithful port of the server's lib/locate.js
// (chroma row/column profiles, same hysteresis, same sanity gates),
// run on a 220px-wide canvas so it costs nothing on a phone. When it
// finds no trustworthy box, the caller falls back to the old
// whole-frame shrink — a missed crop must never be worse than the
// behavior it replaces.
//
// Also here: the pre-submit blur/glare check (lib/shotquality.js),
// run on a 320px-wide canvas before any server round-trip, so a
// blurry shot fails in <1s with a kid-simple retry instead of after
// a 10-50s identify that was doomed from the start.

import { assessShot } from './shotquality.js';

const CARD_ASPECT = 63 / 88;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[i];
}

function smooth(arr, radius) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
    }
    out[i] = s / n;
  }
  return out;
}

// Same hysteresis run-finder as lib/locate.js.
function axisRun(profile, { minContrast = 0.12, thrFrac = 0.42 } = {}) {
  const n = profile.length;
  if (!n) return null;
  const sorted = [...profile].sort((a, b) => a - b);
  const lo = percentile(sorted, 0.10);
  const hi = percentile(sorted, 0.90);
  const contrast = hi - lo;
  if (contrast < minContrast) return null;
  const thr = lo + thrFrac * contrast;
  const extThr = lo + 0.12 * contrast;
  const bridge = Math.max(2, Math.round(0.03 * n));
  let best = null;
  let runStart = -1, gap = 0, lastAbove = -1;
  const consider = (start, end) => {
    if (start < 0) return;
    const len = end - start + 1;
    if (!best || len > best.len) best = { start, end, len };
  };
  for (let i = 0; i < n; i++) {
    if (profile[i] > thr) {
      if (runStart < 0) runStart = i;
      lastAbove = i; gap = 0;
    } else if (runStart >= 0) {
      gap++;
      if (gap > bridge) { consider(runStart, lastAbove); runStart = -1; gap = 0; }
    }
  }
  consider(runStart, lastAbove);
  if (!best) return null;
  let mean = 0;
  for (let i = best.start; i <= best.end; i++) mean += profile[i];
  mean /= best.len;
  if (mean < thr + 0.25 * contrast) return null;
  let start = best.start;
  while (start > 0 && profile[start - 1] > extThr) start--;
  let end = best.end;
  while (end < n - 1 && profile[end + 1] > extThr) end++;
  return { start: start / n, end: (end + 1) / n, contrast: Math.round(contrast * 100) / 100 };
}

// Pixel-level card-box analysis (chroma row/column profiles, same
// hysteresis, same sanity gates as the server's lib/locate.js).
// data is row-major RGBA at w x h; srcW/srcH are the original frame
// dims, used only for the aspect check. Returns { l, t, w, h, mode,
// confidence } in fractions of the frame, or null. Pure — no DOM —
// so the live preview can run it on every sample frame (see
// app/camera-preview.js) and fixtures can run it on synthetic pixels.
export function analyzeCardPixels(data, w, h, srcW, srcH) {
  try {
    const ch = 4;
    const colorful = (i) => {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return mx - mn > 50 && mx > 55 ? 1 : 0;
    };
    const rowFrac = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) s += colorful((y * w + x) * ch);
      rowFrac[y] = s / w;
    }
    const rows = axisRun(smooth(rowFrac, 2));
    if (!rows) return null;
    const y0 = Math.floor(rows.start * h), y1 = Math.max(y0 + 1, Math.ceil(rows.end * h));
    const colFrac = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = y0; y < y1; y++) s += colorful((y * w + x) * ch);
      colFrac[x] = s / (y1 - y0);
    }
    const cols = axisRun(smooth(colFrac, 2));
    const EXP = 0.03;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const t = clamp01(rows.start - EXP), b = clamp01(rows.end + EXP);
    const height = b - t;
    if (height < 0.55 || height > 1.001) return null;
    if (cols) {
      const l = clamp01(cols.start - EXP), r = clamp01(cols.end + EXP);
      const width = r - l;
      const aspect = (width * srcW) / (height * srcH);
      const area = width * height;
      if (width >= 0.38 && area >= 0.26 && aspect > CARD_ASPECT * 0.72 && aspect < CARD_ASPECT * 1.30) {
        const nearFrame = l <= 0.02 && t <= 0.02 && r >= 0.98 && b >= 0.98;
        if (nearFrame) return null; // frame-filling: no crop to gain
        return { l, t, w: width, h: height, mode: 'full', confidence: Math.min(rows.contrast, cols.contrast) };
      }
    }
    return { l: 0, t, w: 1, h: height, mode: 'rows', confidence: rows.contrast * 0.7 };
  } catch { return null; }
}

// Find the card box in an ImageBitmap. Returns { l, t, w, h, mode,
// confidence } in fractions of the bitmap, or null.
export function detectCardBox(bmp) {
  try {
    const GW = 220;
    const scale = GW / bmp.width;
    const gh = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = GW; canvas.height = gh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, GW, gh);
    const { data } = ctx.getImageData(0, 0, GW, gh);
    return analyzeCardPixels(data, GW, gh, bmp.width, bmp.height);
  } catch { return null; }
}

function bitmapToFile(canvas, name = 'photo.jpg', quality = 0.95) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) { resolve(null); return; }
      resolve(new File([blob], name, { type: 'image/jpeg' }));
    }, 'image/jpeg', quality);
  });
}

// Crop-first upload prep. Returns { file, cropped } — cropped=true
// means the file is a tight card crop the server must NOT re-encode
// (it carries the cropped flag through the form). Falls back to the
// legacy whole-frame shrink whenever detection fails, so the worst
// case is exactly the old behavior.
export async function prepareForUpload(file) {
  try {
    if (!file || !file.type || !file.type.startsWith('image/')) return { file, cropped: false };
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(file);
    }
    const bw = bmp.width, bh = bmp.height;
    try {
      const box = detectCardBox(bmp);
      if (box) {
        const sx = Math.max(0, Math.round(box.l * bw));
        const sy = Math.max(0, Math.round(box.t * bh));
        const sw = Math.min(bw - sx, Math.round(box.w * bw));
        const sh = Math.min(bh - sy, Math.round(box.h * bh));
        if (sw > 60 && sh > 60) {
          const MAX = 1800;
          const scale = Math.min(1, MAX / Math.max(sw, sh));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(sw * scale);
          canvas.height = Math.round(sh * scale);
          canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          const out = await bitmapToFile(canvas, 'card-crop.jpg', 0.95);
          if (out) return { file: out, cropped: true };
        }
      }
      // Legacy whole-frame shrink (unchanged contract: 2400px, q90).
      const MAX = 2400;
      if (Math.max(bw, bh) <= MAX) return { file, cropped: false };
      const scale = MAX / Math.max(bw, bh);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bw * scale);
      canvas.height = Math.round(bh * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      if (!blob) return { file, cropped: false };
      return { file: new File([blob], 'photo.jpg', { type: 'image/jpeg' }), cropped: false };
    } finally {
      try { bmp.close?.(); } catch { /* ignore */ }
    }
  } catch { return { file, cropped: false }; }
}

// Pre-submit quality verdict for an ImageBitmap: { sharpness,
// glareFrac, verdict } — see lib/shotquality.js for the bars. Runs on
// a 320px-wide canvas; callers block only on 'blurry'.
export async function assessBitmap(bmp) {
  try {
    const W = 320;
    const scale = W / bmp.width;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return assessShot({ data, width: canvas.width, height: canvas.height, channels: 4 });
  } catch { return { sharpness: Infinity, glareFrac: 0, verdict: 'ok' }; }
}

// Video-frame capture for the live preview: draw the current video
// frame (optionally cropped to a fraction box) to a JPEG File.
export async function videoFrameToFile(video, box = null, quality = 0.95) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sx = box ? Math.max(0, Math.round(box.l * vw)) : 0;
  const sy = box ? Math.max(0, Math.round(box.t * vh)) : 0;
  const sw = box ? Math.min(vw - sx, Math.round(box.w * vw)) : vw;
  const sh = box ? Math.min(vh - sy, Math.round(box.h * vh)) : vh;
  const MAX = 1800;
  const scale = Math.min(1, MAX / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return bitmapToFile(canvas, 'card-crop.jpg', quality);
}
