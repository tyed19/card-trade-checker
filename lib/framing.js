// Pure framing assessment + guidance chip for the guided preview's
// firing gate (app/camera-preview.js). No DOM — tested by
// scripts/test-framing.mjs.
//
// A frame is "framed" when the detected card box is whole, big
// enough, and on a contrasting background. When it is not,
// assessFraming names the single most-blocking reason, and
// guidanceFor turns it into the one short chip the preview shows —
// Chase check-deposit style. Blocked firing always explains itself,
// but only one reason shows at a time, and nothing shows during the
// first FIRE_MIN_MS settle window (dots only, no chip flash while
// autofocus is still settling).
//
// Priority (most blocking first): cut-off card beats too-small
// beats weak background beats glare beats motion — no amount of
// holding steady fixes a half-framed card, and glare is more
// actionable than motion.

export const EDGE_MARGIN = 0.02; // box touching the frame edge = cut off
export const MIN_BOX_HEIGHT = 0.70; // card height as fraction of frame height
export const MIN_BOX_AREA = 0.40; // card area as fraction of frame area
export const MIN_BG_CONTRAST = 25; // |edge - outside| mean luminance (0-255)
export const GLARE_FRAC = 0.25; // same bar as the old shine chip

const CHIPS = {
  corners: 'Show all four corners',
  closer: 'Move closer',
  background: 'Needs a darker background',
  glare: 'Tilt a little',
  steady: 'Hold steady',
};

// Box is { l, t, w, h } in fractions of the frame (see
// lib/capture.js analyzeCardPixels). lum is { edge, outside } mean
// luminance from luminanceContrast, or null when unavailable.
export function assessFraming(box, lum) {
  if (!box) return { framed: false, reason: 'corners' };
  const r = box.l + box.w;
  const b = box.t + box.h;
  if (box.l <= EDGE_MARGIN || box.t <= EDGE_MARGIN || r >= 1 - EDGE_MARGIN || b >= 1 - EDGE_MARGIN) {
    return { framed: false, reason: 'corners' };
  }
  if (box.h < MIN_BOX_HEIGHT || box.w * box.h < MIN_BOX_AREA) {
    return { framed: false, reason: 'closer' };
  }
  if (lum && Math.abs(lum.edge - lum.outside) < MIN_BG_CONTRAST) {
    return { framed: false, reason: 'background' };
  }
  return { framed: true, reason: null };
}

// Mean luminance of the ring just inside the box edges vs the ring
// just outside them. data is row-major RGBA (channels 4) at w x h.
export function luminanceContrast(data, w, h, box) {
  const lumAt = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const x0 = Math.round(box.l * w);
  const y0 = Math.round(box.t * h);
  const x1 = Math.round((box.l + box.w) * w);
  const y1 = Math.round((box.t + box.h) * h);
  const band = Math.max(1, Math.round(0.05 * Math.min(x1 - x0, y1 - y0)));
  let edgeSum = 0;
  let edgeN = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < x0 + band || x >= x1 - band || y < y0 + band || y >= y1 - band) {
        edgeSum += lumAt(x, y);
        edgeN++;
      }
    }
  }
  let outSum = 0;
  let outN = 0;
  for (let y = Math.max(0, y0 - band); y < Math.min(h, y1 + band); y++) {
    for (let x = Math.max(0, x0 - band); x < Math.min(w, x1 + band); x++) {
      if (x < x0 || x >= x1 || y < y0 || y >= y1) {
        outSum += lumAt(x, y);
        outN++;
      }
    }
  }
  if (!edgeN || !outN) return null;
  return { edge: edgeSum / edgeN, outside: outSum / outN };
}

// The single guidance chip for this sample, or null when nothing
// needs saying (settling window, or fire is imminent). framing is
// the assessFraming result; lastGood is whether this sample was a
// firing-grade frame (a good sample waiting on its streak partner
// shows no chip — the dots already say "almost").
export function guidanceFor({ framing, glareFrac, lastGood, elapsedMs, minMs = 1000 }) {
  if (elapsedMs < minMs) return null;
  if (framing && !framing.framed) return CHIPS[framing.reason];
  if (glareFrac >= GLARE_FRAC) return CHIPS.glare;
  if (!lastGood) return CHIPS.steady;
  return null;
}
