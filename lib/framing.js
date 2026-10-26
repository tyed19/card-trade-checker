// Pure framing assessment + guidance chip for the guided preview's
// firing gate (app/camera-preview.js). No DOM — tested by
// scripts/test-framing.mjs.
//
// Two reference frames, deliberately kept apart:
//  - LEGACY (no outline arg): the detected box judged against the
//    full video frame. Kept for existing callers/tests only.
//  - OUTLINE (preview gate): the detected box judged against the
//    on-screen outline the user actually frames inside. This is the
//    only honest reference: the video is shown with object-fit:
//    cover, so a card filling the outline is only ~0.5 tall and
//    ~0.2-0.6 wide in full-frame fractions — the old frame-relative
//    bars (height 0.70, area 0.40) could never pass on a
//    well-framed card, and a missing box was misreported as
//    'corners' even when all four corners were visibly shown (Iron
//    Leaves, iPhone, 2026-10-25). So in the outline path a missing
//    box is 'unknown', never 'corners': the detector cannot see
//    the card (holo fragmentation, glare), and the fallback hold —
//    not a wrong instruction — is what fires. A chip must never
//    tell the user to fix something visibly already fixed.
//
// When framing is not met, assessFraming names the single
// most-blocking reason, and guidanceFor turns it into the one
// short chip the preview shows — Chase check-deposit style.
// Blocked firing always explains itself, but only one reason shows
// at a time, and nothing shows during the first FIRE_MIN_MS settle
// window (dots only, no chip flash while autofocus is settling).
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

// Map the on-screen outline rect into video-frame fractions.
// videoRect is the <video> element's DOM rect, outlineRect the
// outline div's DOM rect (same coordinate space); videoW/videoH
// are the stream's dimensions. The video is shown with
// object-fit: cover, so the displayed content is the stream
// scaled to cover the element and center-cropped — this inverts
// that transform. Pure (DOM rects are plain objects) so fixtures
// can call it with synthetic rects.
export function coverOutlineRect({ videoRect, outlineRect, videoW, videoH }) {
  const scale = Math.max(videoRect.width / videoW, videoRect.height / videoH);
  const contentW = videoW * scale, contentH = videoH * scale;
  const offX = videoRect.left + (videoRect.width - contentW) / 2;
  const offY = videoRect.top + (videoRect.height - contentH) / 2;
  return {
    l: (outlineRect.left - offX) / contentW,
    t: (outlineRect.top - offY) / contentH,
    w: outlineRect.width / contentW,
    h: outlineRect.height / contentH,
  };
}

function intersectArea(a, b) {
  const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t);
  const r = Math.min(a.l + a.w, b.l + b.w), bt = Math.min(a.t + a.h, b.t + b.h);
  return Math.max(0, r - l) * Math.max(0, bt - t);
}

// Outline-relative assessment: box and outline are both { l, t, w,
// h } in video-frame fractions. The card is framed when it covers
// the outline it is being framed inside.
function assessFramingOutline(box, lum, o) {
  if (!box) return { framed: false, reason: 'unknown' };
  const oArea = o.w * o.h;
  if (box.mode === 'rows') {
    // Horizontal span unknown (rows-mode strips are full-width by
    // construction): judge vertically only, and stay silent rather
    // than guess about corners we cannot see.
    if (box.h < 0.7 * o.h) return { framed: false, reason: 'closer' };
    if (box.t < o.t - 0.08 || box.t + box.h > o.t + o.h + 0.08) return { framed: false, reason: 'corners' };
    return { framed: false, reason: 'unknown' };
  }
  const bArea = box.w * box.h;
  const inter = intersectArea(box, o);
  if (inter < 0.65 * oArea) {
    return { framed: false, reason: bArea < 0.5 * oArea ? 'closer' : 'corners' };
  }
  if (bArea > 1.8 * oArea) return { framed: false, reason: 'corners' };
  if (lum && Math.abs(lum.edge - lum.outside) < MIN_BG_CONTRAST) {
    return { framed: false, reason: 'background' };
  }
  return { framed: true, reason: null };
}

// Box is { l, t, w, h } in fractions of the frame (see
// lib/capture.js analyzeCardPixels). lum is { edge, outside } mean
// luminance from luminanceContrast, or null when unavailable.
// outline, when given, switches to the outline-relative path above.
export function assessFraming(box, lum, outline = null) {
  if (outline) return assessFramingOutline(box, lum, outline);
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
  // 'unknown' means the detector cannot see the card at all: naming
  // a fix would be a guess, and a guessed 'corners' chip is exactly
  // the lie this path exists to prevent. Fall through to glare /
  // motion, and let the fallback hold fire on a steady hold.
  if (framing && !framing.framed && framing.reason !== 'unknown') return CHIPS[framing.reason];
  if (glareFrac >= GLARE_FRAC) return CHIPS.glare;
  if (!lastGood) return CHIPS.steady;
  return null;
}
