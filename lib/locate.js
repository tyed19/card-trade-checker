// Card localization: find the card's bounding box inside a photo so the
// OCR bands in ocr.js can run relative to the CARD instead of the frame.
//
// Why: the band fractions were tuned on photos where the card fills the
// frame. Real kid photos leave wide table margins (e.g. a Victini shot
// where the card spans x 0.17-0.86 / y 0.15-0.92) — the name boxes then
// OCR the tabletop and the number boxes land on the weakness bar and
// the copyright line, and a perfectly legible card reads as garbage.
//
// Method (deliberately conservative — a wrong crop is worse than none):
//  - Downscale to a small grid and mark "colorful" pixels (chroma > 50).
//    Card faces are saturated; tables/floors/fabrics mostly are not.
//  - Row profile first (fraction of colorful pixels per row), find the
//    dominant above-threshold run; then the column profile computed
//    only inside that row band (keeps bright clutter outside the card's
//    rows from polluting the left/right edges).
//  - The box must pass sanity checks (size, card-like aspect) or the
//    caller falls back to full-frame bands. If only the rows are
//    trustworthy, a full-width row strip is returned instead.
//  - Everything is axis-aligned; near-top-down photos don't need
//    perspective rectification for band OCR.

import sharp from 'sharp';

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

// Find the dominant run of "card-like" values in a 1-D profile.
// Hysteresis: a strong core run (high threshold) is extended outward
// while the profile stays above a much lower bar — a card's pale top
// strip and dark bottom strip are genuinely card but score weakly.
// Returns { start, end } as fractions of the axis length, or null when
// the profile has no convincing card/background contrast.
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
  // Longest run above threshold, bridging short dips (a card's pale
  // mid-section can dip below threshold for a few rows).
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
  // The run must be convincingly "on" — not a threshold-skimming smear.
  if (mean < thr + 0.25 * contrast) return null;
  // Hysteresis extension into the card's weak-scoring edges.
  let start = best.start;
  while (start > 0 && profile[start - 1] > extThr) start--;
  let end = best.end;
  while (end < n - 1 && profile[end + 1] > extThr) end++;
  return {
    start: start / n,
    end: (end + 1) / n,
    contrast: Math.round(contrast * 100) / 100,
    mean: Math.round(mean * 100) / 100,
  };
}

const CARD_ASPECT = 63 / 88; // a real card, w/h ≈ 0.716

export async function locateCard(imgBuffer, meta) {
  try {
    const GW = 220;
    const { data, info } = await sharp(imgBuffer)
      .resize({ width: GW })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height, ch = info.channels;
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
    if (!rows) return { box: null, mode: 'none', confidence: 0, rows: null, cols: null };
    // Columns only inside the row band: background clutter above/below
    // the card (desk corners, shadows) must not widen the box.
    const y0 = Math.floor(rows.start * h), y1 = Math.max(y0 + 1, Math.ceil(rows.end * h));
    const colFrac = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = y0; y < y1; y++) s += colorful((y * w + x) * ch);
      colFrac[x] = s / (y1 - y0);
    }
    const cols = axisRun(smooth(colFrac, 2));

    const EXP = 0.03; // outward pad: bands include the border, and a
    // slightly-too-big crop is far safer than one that clips the
    // name line (top) or the collector number (bottom).
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const t = clamp01(rows.start - EXP), b = clamp01(rows.end + EXP);
    const height = b - t;
    // A real card in a usable photo fills at least ~55% of the frame
    // height; a shorter "detection" is a partial read of the card's
    // busy section and must not be trusted as a crop.
    if (height < 0.55 || height > 1.001) {
      return { box: null, mode: 'none', confidence: 0, rows, cols };
    }
    if (cols) {
      const l = clamp01(cols.start - EXP), r = clamp01(cols.end + EXP);
      const width = r - l;
      const aspect = (width * meta.width) / (height * meta.height);
      const area = width * height;
      if (width >= 0.38 && area >= 0.26 && aspect > CARD_ASPECT * 0.72 && aspect < CARD_ASPECT * 1.30) {
        const nearFrame = l <= 0.02 && t <= 0.02 && r >= 0.98 && b >= 0.98;
        return {
          box: { l, t, w: width, h: height },
          mode: nearFrame ? 'frame' : 'full',
          confidence: Math.min(rows.contrast, cols.contrast),
          rows, cols,
        };
      }
    }
    // Rows-only strip: vertical placement is the number band's biggest
    // error source, so a trustworthy row range still helps on its own.
    return {
      box: { l: 0, t, w: 1, h: height },
      mode: 'rows',
      confidence: rows.contrast * 0.7,
      rows, cols,
    };
  } catch {
    return { box: null, mode: 'none', confidence: 0, rows: null, cols: null };
  }
}
