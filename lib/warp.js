// Perspective warp for tilted cards: detect the card's four corners
// and warp the quadrilateral flat before OCR. This is a RESCUE path,
// not the primary frame — it runs only when the axis-aligned crop
// yields no number votes at all, and every gate below must pass or
// the caller keeps the axis crop. A wrong warp is worse than none.
//
// Why not OpenCV: the server has sharp only, and adding a native
// vision dependency to a serverless bundle is a deployment risk of
// its own. The detector below is deliberately narrow: it refines the
// already-trusted locate box (lib/locate.js) rather than searching
// the frame from scratch — each edge is a robust line fit over
// Sobel responses in a window around the box edge, and the four
// lines intersect to corners. A card whose edges are not clean
// straight lines (heavy sleeve glare, busy background) fails the
// sanity gates and never warps.
//
// warpPerspective maps an output rectangle back through the inverse
// homography of (corners -> rectangle) with bilinear sampling, so the
// same function tilts a flat image (corners = tilted quad) and
// unwarps a tilted photo (corners = detected quad).

import sharp from 'sharp';

// Solve an 8x8 linear system (homography) by Gaussian elimination
// with partial pivoting. Returns null when singular.
function solve8(A, b) {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-9) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

// Homography taking rect points (0,0),(W,0),(W,H),(0,H) to quad points.
// Returns { h } (3x3 row-major) mapping rect -> quad, or null.
function homographyRectToQuad(quad, W, H) {
  const rect = [[0, 0], [W, 0], [W, H], [0, H]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = rect[i];
    const [u, v] = quad[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const s = solve8(A, b);
  if (!s) return null;
  return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1];
}

function invert3(h) {
  const [a, b, c, d, e, f, g, hh, i] = h;
  const A = e * i - f * hh, B = -(d * i - f * g), C = d * hh - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    A / det, -(b * i - c * hh) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * hh - b * g) / det, (a * e - b * d) / det,
  ];
}

// Warp: sample the source image at the quadrilateral `corners`
// (fractions of the source, order TL, TR, BR, BL) into a flat
// outW x outH image. Returns a JPEG buffer (q95), or null on failure.
export async function warpPerspective(imgBuffer, corners, outW, outH) {
  try {
    const { data, info } = await sharp(imgBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const sw = info.width, sh = info.height, ch = info.channels;
    const quad = corners.map((c) => [c.x * sw, c.y * sh]);
    const h = homographyRectToQuad(quad, outW, outH);
    if (!h) return null;
    const out = Buffer.alloc(outW * outH * 3);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        // Rect point -> quad point via h (rect->quad), then sample.
        const w = h[6] * x + h[7] * y + h[8];
        const sx = (h[0] * x + h[1] * y + h[2]) / w;
        const sy = (h[3] * x + h[4] * y + h[5]) / w;
        const oi = (y * outW + x) * 3;
        if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
          out[oi] = out[oi + 1] = out[oi + 2] = 0;
          continue;
        }
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        for (let c = 0; c < 3; c++) {
          const p00 = data[(y0 * sw + x0) * ch + c];
          const p10 = data[(y0 * sw + x1) * ch + c];
          const p01 = data[(y1 * sw + x0) * ch + c];
          const p11 = data[(y1 * sw + x1) * ch + c];
          out[oi + c] = Math.round(
            p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy
          );
        }
      }
    }
    return sharp(out, { raw: { width: outW, height: outH, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  } catch { return null; }
}

// Inverse of warpPerspective: render the flat source image as if seen
// tilted, with the source rectangle landing on `corners` (fractions
// of the OUTPUT, order TL, TR, BR, BL). Used by the degradation
// harness and the warp fixture to synthesize tilted inputs —
// production only ever unwarps, never tilts.
export async function tiltPerspective(imgBuffer, corners, outW, outH) {
  try {
    const { data, info } = await sharp(imgBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const sw = info.width, sh = info.height, ch = info.channels;
    const quad = corners.map((c) => [c.x * outW, c.y * outH]);
    const h = homographyRectToQuad(quad, sw, sh);
    if (!h) return null;
    const inv = invert3(h);
    if (!inv) return null;
    const out = Buffer.alloc(outW * outH * 3);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        // Output pixel -> flat source point via the inverse map.
        const w = inv[6] * x + inv[7] * y + inv[8];
        const sx = (inv[0] * x + inv[1] * y + inv[2]) / w;
        const sy = (inv[3] * x + inv[4] * y + inv[5]) / w;
        const oi = (y * outW + x) * 3;
        if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
          out[oi] = 200; out[oi + 1] = 200; out[oi + 2] = 200;
          continue;
        }
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        for (let c = 0; c < 3; c++) {
          const p00 = data[(y0 * sw + x0) * ch + c];
          const p10 = data[(y0 * sw + x1) * ch + c];
          const p01 = data[(y1 * sw + x0) * ch + c];
          const p11 = data[(y1 * sw + x1) * ch + c];
          out[oi + c] = Math.round(
            p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy
          );
        }
      }
    }
    return sharp(out, { raw: { width: outW, height: outH, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  } catch { return null; }
}

// Robust line fit for one edge: points (t, v) where t runs along the
// edge and v is the edge position. Least squares + one outlier pass.
function fitLine(pts) {
  if (pts.length < 8) return null;
  const fit = (list) => {
    const n = list.length;
    let st = 0, sv = 0, stt = 0, stv = 0;
    for (const [t, v] of list) { st += t; sv += v; stt += t * t; stv += t * v; }
    const den = n * stt - st * st;
    if (Math.abs(den) < 1e-9) return null;
    const a = (n * stv - st * sv) / den;
    const b = (sv - a * st) / n;
    return { a, b };
  };
  let line = fit(pts);
  if (!line) return null;
  const res = pts.map(([t, v]) => Math.abs(v - (line.a * t + line.b)));
  const sorted = [...res].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const keep = pts.filter((_, i) => res[i] <= Math.max(4, 2.5 * med));
  if (keep.length >= Math.max(8, pts.length * 0.55)) {
    const refit = fit(keep);
    if (refit) line = refit;
  }
  if (Math.abs(line.a) > 1.2) return null; // edge implausibly steep
  return line;
}

// Detect the card's four corners (fractions of the source image, order
// TL, TR, BR, BL) by refining the locate box's edges. Returns null
// unless every sanity gate passes.
export async function detectCardCorners(imgBuffer, box) {
  try {
    const GW = 440;
    const { data, info } = await sharp(imgBuffer).resize({ width: GW }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height, ch = info.channels;
    const gray = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = 0.299 * data[i * ch] + 0.587 * data[i * ch + 1] + 0.114 * data[i * ch + 2];
    const sobel = (x, y) => {
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return 0;
      const gx = -gray[(y - 1) * w + x - 1] - 2 * gray[y * w + x - 1] - gray[(y + 1) * w + x - 1]
        + gray[(y - 1) * w + x + 1] + 2 * gray[y * w + x + 1] + gray[(y + 1) * w + x + 1];
      const gy = -gray[(y - 1) * w + x - 1] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + x + 1]
        + gray[(y + 1) * w + x - 1] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + x + 1];
      return Math.sqrt(gx * gx + gy * gy);
    };
    const bx0 = box.l * w, bx1 = (box.l + box.w) * w;
    const by0 = box.t * h, by1 = (box.t + box.h) * h;
    const bw = bx1 - bx0, bh = by1 - by0;
    const win = 0.20; // search window around each box edge, as a fraction of the box size
    // Top/bottom edges: for each column, strongest Sobel row near the prior edge.
    const edgeH = (priorY, isTop) => {
      const pts = [];
      const yLo = Math.max(1, Math.floor(priorY - win * bh));
      const yHi = Math.min(h - 2, Math.ceil(priorY + win * bh));
      for (let x = Math.floor(bx0 + 0.15 * bw); x <= Math.ceil(bx1 - 0.15 * bw); x++) {
        let best = -1, bestY = -1;
        for (let y = yLo; y <= yHi; y++) {
          const s = sobel(x, y);
          if (s > best) { best = s; bestY = y; }
        }
        if (best > 0) pts.push([x, bestY]);
      }
      return fitLine(pts);
    };
    // Left/right edges: for each row, strongest Sobel column near the prior edge.
    const edgeV = (priorX) => {
      const pts = [];
      const xLo = Math.max(1, Math.floor(priorX - win * bw));
      const xHi = Math.min(w - 2, Math.ceil(priorX + win * bw));
      for (let y = Math.floor(by0 + 0.15 * bh); y <= Math.ceil(by1 - 0.15 * bh); y++) {
        let best = -1, bestX = -1;
        for (let x = xLo; x <= xHi; x++) {
          const s = sobel(x, y);
          if (s > best) { best = s; bestX = x; }
        }
        if (best > 0) pts.push([y, bestX]);
      }
      return fitLine(pts);
    };
    const top = edgeH(by0, true);
    const bottom = edgeH(by1, false);
    const left = edgeV(bx0);
    const right = edgeV(bx1);
    if (!top || !bottom || !left || !right) return null;
    // Intersect: top y = at*x + bt; left x = al*y + bl.
    const intersect = (hl, vl) => {
      const den = 1 - vl.a * hl.a;
      if (Math.abs(den) < 1e-6) return null;
      const x = (vl.a * hl.b + vl.b) / den;
      const y = hl.a * x + hl.b;
      return { x, y };
    };
    const TL = intersect(top, left);
    const TR = intersect(top, right);
    const BR = intersect(bottom, right);
    const BL = intersect(bottom, left);
    if (!TL || !TR || !BR || !BL) return null;
    const corners = [TL, TR, BR, BL];
    // Convexity: successive cross products must share a sign.
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const p = corners[i], q = corners[(i + 1) % 4], r = corners[(i + 2) % 4];
      const cr = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
      if (sign === 0) sign = Math.sign(cr);
      else if (Math.sign(cr) !== sign || cr === 0) return null;
    }
    // Aspect + area sanity (tilt foreshortens, so the band is wide).
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const topLen = dist(TL, TR), botLen = dist(BL, BR);
    const leftLen = dist(TL, BL), rightLen = dist(TR, BR);
    const aspect = ((topLen + botLen) / 2) / ((leftLen + rightLen) / 2);
    if (aspect < 0.5 || aspect > 1.4) return null;
    const quadArea = 0.5 * Math.abs(
      (TR.x - TL.x) * (BR.y - TL.y) - (BR.x - TL.x) * (TR.y - TL.y)
      + (BR.x - TL.x) * (BL.y - TL.y) - (BL.x - TL.x) * (BR.y - TL.y)
    );
    const boxArea = bw * bh;
    if (quadArea < 0.45 * boxArea || quadArea > 1.05 * boxArea) return null;
    // Corners must stay near the box corners (a wild line fit is a
    // background edge, not the card).
    const boxCorners = [{ x: bx0, y: by0 }, { x: bx1, y: by0 }, { x: bx1, y: by1 }, { x: bx0, y: by1 }];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(corners[i].x - boxCorners[i].x) > 0.30 * bw) return null;
      if (Math.abs(corners[i].y - boxCorners[i].y) > 0.30 * bh) return null;
    }
    return corners.map((c) => ({ x: c.x / w, y: c.y / h }));
  } catch { return null; }
}
