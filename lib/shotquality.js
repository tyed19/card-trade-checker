// No-reference shot-quality metrics, shared by the browser capture flow
// (lib/capture.js, over canvas ImageData) and the node degradation
// harness / fixtures (over sharp raw buffers). This file imports
// nothing and touches no DOM: it works on plain pixel arrays.
//
//   pixels: { data, width, height, channels } — channels 3 or 4,
//           row-major RGB(A). Callers downscale to ~320px wide first
//           (cheap, and the thresholds below are calibrated at that
//           scale — see the calibration note).
//
// Calibration (2026-10-25, 8 real test photos + synthetic variants):
//   sharpness (Laplacian variance): real photos 1125-3828 (weakest:
//     Victini 1125); moderate Gaussian blur (sigma 3) 204-532; heavy
//     blur (sigma 6) 28-63. The gate bar 400 sits 2.8x below the
//     weakest real photo and above all heavy blur — it blocks only
//     egregiously blurry shots, never a merely imperfect one.
//   glare: single-frame glare proved WEAKLY separable with every
//     cheap metric tried (near-white blob fraction, washed-cell
//     fraction, bright-desaturated fraction all overlap real photos
//     under a synthetic screen-blend glare). So glare is ADVISORY
//     ONLY, at a very high bar (bright-desaturated fraction 0.25):
//     it fires on heavy shine and stays quiet otherwise. A glare
//     verdict never blocks an upload — a false glare alarm trains
//     kids to ignore the guidance, which is worse than no warning.
//     The reliable glare answers remain the server's strong-variant
//     OCR round and the tilt second-photo flow.

export const BLUR_MIN = 400;
export const GLARE_BAR = 0.25;

// Grayscale + Laplacian variance + bright-desaturated fraction, in
// one pass over the pixel array.
export function measureShot(pixels) {
  const { data, width: w, height: h, channels: ch } = pixels;
  const gray = new Float64Array(w * h);
  let brightDesat = 0;
  for (let i = 0; i < w * h; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 200 && mx - mn < 30) brightDesat++;
  }
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = n ? sum / n : 0;
  const sharpness = n ? Math.max(0, Math.round(sumSq / n - mean * mean)) : 0;
  return { sharpness, glareFrac: Math.round((brightDesat / (w * h)) * 1000) / 1000 };
}

// The pre-submit verdict. Only 'blurry' blocks (see calibration note);
// 'glare' is advisory — the caller shows a tilt hint, never a block.
export function assessShot(pixels) {
  const m = measureShot(pixels);
  if (m.sharpness < BLUR_MIN) return { ...m, verdict: 'blurry' };
  if (m.glareFrac >= GLARE_BAR) return { ...m, verdict: 'glare' };
  return { ...m, verdict: 'ok' };
}

// Pick the sharpest of several same-size frames (live-preview burst):
// returns the index of the sharpest frame, or -1 when none qualifies.
export function pickSharpest(frames) {
  let best = -1, bestSharp = -1;
  for (let i = 0; i < frames.length; i++) {
    const { sharpness } = measureShot(frames[i]);
    if (sharpness > bestSharp) { bestSharp = sharpness; best = i; }
  }
  return best;
}
