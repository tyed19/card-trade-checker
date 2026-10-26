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

// Card-aspect sanity: a real card is 63:88. Perspective tilt can only
// make a card look SHORTER (aspect larger), never taller — so a box
// far too tall for its width has an overstated vertical span (table
// rows merged in), not a tilted card. Rejecting below this floor
// keeps such a box from ever placing zones on the table.
const ASPECT_FLOOR = 0.58;
// Within-column colorful density floors for span extension/shrink.
// Per-row density is too noisy on landscape streams (a pale name
// strip at ~0.05 density over ~37 columns is ~2 pixels per row),
// so extension judges 3-row BLOCKS at a low floor: card interior
// blocks average ~0.05+ even glare-washed, while table blocks
// inside the columns read ~0. Shrink keeps a per-row floor: the
// span edges are solid card regions in practice, and per-row
// trimming is what removes a few smeared table rows past the real
// bottom edge.
const BLOCK_ROWS = 3;
const BLOCK_DENSITY_FLOOR = 0.015;
const COL_DENSITY_FLOOR = 0.04;
// Largest single gap the fragment-merge below may bridge, as a
// fraction of frame height. A card's own dark band is ~0.10-0.15;
// a wood highlight blip 0.23+ below the card is not the card.
const UNION_MAX_GAP = 0.20;

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
  const runs = [];
  let runStart = -1, gap = 0, lastAbove = -1;
  const consider = (start, end) => {
    if (start < 0) return;
    const len = end - start + 1;
    runs.push({ start, end, len });
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
  return { start: start / n, end: (end + 1) / n, contrast: Math.round(contrast * 100) / 100, runs, extThr };
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
    const rowProf = smooth(rowFrac, 2);
    let rows = axisRun(rowProf);
    if (!rows) return null;
    const EXP = 0.03;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const spanHeight = (r) => clamp01(r.end + EXP) - clamp01(r.start - EXP);
    // Height gate, aspect-aware (see the final gate below for why).
    const heightGate = srcW > srcH ? 0.48 : 0.55;
    // Column profile over a row span, as fractions of the width.
    const columnsFor = (r) => {
      const cy0 = Math.floor(r.start * h), cy1 = Math.max(cy0 + 1, Math.ceil(r.end * h));
      const colFrac = new Float64Array(w);
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = cy0; y < cy1; y++) s += colorful((y * w + x) * ch);
        colFrac[x] = s / (cy1 - cy0);
      }
      return axisRun(smooth(colFrac, 2));
    };
    // Colorful density of one row restricted to a column span
    // (fractions of the width). Unlike the full-row fraction, this
    // stays discriminative on landscape streams, where the card
    // spans only ~23% of the width: a pale name strip still reads
    // ~0.05 inside its own columns while table rows read ~0.
    const colDensity = (y, c0, c1) => {
      const x0 = Math.max(0, Math.floor(c0 * w)), x1 = Math.min(w, Math.ceil(c1 * w));
      if (x1 - x0 < 1) return 0;
      let s = 0;
      for (let x = x0; x < x1; x++) s += colorful((y * w + x) * ch);
      return s / (x1 - x0);
    };
    // Column-restricted span extension, used when the row span
    // looks incomplete (below 0.62 tall): a pale name strip falls
    // below the full-row threshold on landscape streams, so the
    // run starts at the art and the span fails the height gate
    // outright (null -> zones hidden, even though the card is
    // right there). Extending through rows that carry signal
    // inside the card's own columns recovers the true span;
    // table rows inside those columns read ~0, so the extension
    // stops at the card's real edges instead of running away.
    // Runs only for incomplete spans, so complete portrait spans
    // are untouched.
    if (spanHeight(rows) < 0.62) {
      const cols0 = columnsFor(rows);
      if (cols0) {
        const n = rowProf.length;
        // Mean within-column density over a block of rows: robust
        // where per-row density is ~2 pixels of signal.
        const blockDensity = (y0, y1) => {
          let s = 0, m = 0;
          for (let y = Math.max(0, y0); y < Math.min(n, y1); y++) { s += colDensity(y, cols0.start, cols0.end); m++; }
          return m ? s / m : 0;
        };
        let s = Math.max(0, Math.round(rows.start * n));
        while (s > 0 && blockDensity(s - BLOCK_ROWS, s) >= BLOCK_DENSITY_FLOOR) s = Math.max(0, s - BLOCK_ROWS);
        let e = Math.min(n - 1, Math.round(rows.end * n) - 1);
        while (e < n - 1 && blockDensity(e + 1, e + 1 + BLOCK_ROWS) >= BLOCK_DENSITY_FLOOR) e = Math.min(n - 1, e + BLOCK_ROWS);
        const extended = { ...rows, start: s / n, end: (e + 1) / n };
        if (spanHeight(extended) >= spanHeight(rows)) rows = extended;
      }
    }
    // Fragmented card: a holo card's own dark middle band (text box,
    // glare washout) can split its row profile into two strong runs,
    // so longest-run-wins keeps only one fragment and the height
    // gate below rejects the whole card (Iron Leaves on wood: best
    // fragment 0.505 tall -> null -> a lying 'corners' chip). When
    // the best fragment is too short, retry with the union span
    // from the first solid run to the last solid run — the card's
    // full vertical extent. Same gates still apply to the union
    // span, so this merges fragments, it never loosens a threshold.
    // GAP CAP (Iron Leaves, iPhone, 2026-10-25, third screenshot):
    // the union used to merge across ANY gap, so a bright wood
    // highlight blip near the frame bottom extended the box to the
    // frame bottom — number zone detached to the screen bottom and
    // a 'corners' chip on a fully visible card. A card's own dark
    // band is ~0.10-0.15 tall; a gap over 0.20 is not the card, it
    // is table, and the union is refused (the span then fails the
    // height gate -> null -> 'unknown', never a lying box).
    if (spanHeight(rows) < 0.55 && rows.runs) {
      const solid = rows.runs.filter((r) => r.len >= 3);
      if (solid.length >= 2) {
        let maxGap = 0;
        for (let i = 1; i < solid.length; i++) {
          maxGap = Math.max(maxGap, (solid[i].start - solid[i - 1].end - 1) / rowProf.length);
        }
        if (maxGap <= UNION_MAX_GAP) {
          const n = rowProf.length;
          let us = solid[0].start;
          while (us > 0 && rowProf[us - 1] > rows.extThr) us--;
          let ue = solid[solid.length - 1].end;
          while (ue < n - 1 && rowProf[ue + 1] > rows.extThr) ue++;
          const union = { start: us / n, end: (ue + 1) / n, contrast: rows.contrast, runs: rows.runs, extThr: rows.extThr };
          if (spanHeight(union) >= heightGate) rows = union;
        }
      }
    }
    let y0 = Math.floor(rows.start * h), y1 = Math.max(y0 + 1, Math.ceil(rows.end * h));
    let cols = columnsFor(rows);
    // Shrink the outer edges to rows that actually carry signal
    // inside the card's columns: the threshold extension above can
    // leave a few smeared table rows on the span (smoothing +
    // EXP), which would push the number zone just past the card's
    // real bottom edge. Interior rows (dark bands) are never
    // touched — only the outer edges trim inward to the first and
    // last signal rows.
    if (cols) {
      let sy0 = y0, sy1 = y1;
      while (sy0 < sy1 - 1 && colDensity(sy0, cols.start, cols.end) < COL_DENSITY_FLOOR) sy0++;
      while (sy1 > sy0 + 1 && colDensity(sy1 - 1, cols.start, cols.end) < COL_DENSITY_FLOOR) sy1--;
      if (sy1 - sy0 >= 1 && (sy0 !== y0 || sy1 !== y1)) {
        rows = { ...rows, start: sy0 / h, end: sy1 / h };
        y0 = sy0; y1 = sy1;
        cols = columnsFor(rows);
      }
    }
    const t = clamp01(rows.start - EXP), b = clamp01(rows.end + EXP);
    const height = b - t;
    // Height gate (aspect-aware, defined above): on a landscape
    // stream the guide itself is only ~0.50 tall in stream
    // fractions (cover-fit: stream height maps 1:1 to container
    // height), so a guide-framed card reads ~0.50 + 2xEXP = 0.56
    // — the old flat 0.55 gate failed on a single sparse top row.
    // Portrait streams keep 0.55 (guide-framed cards read ~0.61
    // there). Fragments well below a whole card (art-only ~0.35)
    // still fail on either stream.
    if (height < heightGate || height > 1.001) return null;
    if (cols) {
      const l = clamp01(cols.start - EXP), r = clamp01(cols.end + EXP);
      const width = r - l;
      const aspect = (width * srcW) / (height * srcH);
      const area = width * height;
      if (width >= 0.38 && area >= 0.26 && aspect > CARD_ASPECT * 0.72 && aspect < CARD_ASPECT * 1.30) {
        // Aspect floor: perspective tilt only ever makes a card
        // look SHORTER (aspect larger), so a box far too tall for
        // its width is an overstated span, not a tilted card —
        // reject it outright rather than place zones on the table.
        if (aspect < ASPECT_FLOOR) return null;
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
