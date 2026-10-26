// Live zonal scan: which parts of the card the camera still needs,
// drawn as outlines ON the card itself (not dots beside it). Pure
// functions, no DOM — tested by scripts/test-zones.mjs.
//
// The honest mechanism (Tye was told this plainly, and the code
// keeps it true): the phone cannot read card text live on-device —
// reading happens server-side from a captured frame. So a zone's
// LIVE state only ever means "this zone looks clear enough to read
// right now" (client-side per-zone quality: sharpness, glare, in
// frame). GOLD — locked — means only one thing: the server
// confirmed that signal from a capture, via the existing
// lib/progress.js contract (picture / name / number). A zone must
// never show gold for data the server hasn't confirmed.
//
// Zones are fractions of the DETECTED card box, mapped to display
// pixels (see zoneDisplayRects) — never fractions of the fixed
// guide. Guide-anchored zones lied whenever the card sat off-guide:
// a card riding high in the outline put the number zone on the
// table below the card (Iron Leaves, iPhone, 2026-10-25). Quality
// is measured on the same detected box in sample-frame
// coordinates. When no box exists, zones do not render at all —
// a zone drawn in the wrong place is worse than no zone, and the
// guidance chip + dots still say what to do.
//
// Signal → zone mapping (the progress contract's own channels):
//   picture → art     (pool art matched)
//   name    → name    (title text matched)
//   number  → number  (collector-number corner matched)
// A missing stage emphasizes its zone (number → number zone pulses,
// straight → name zone pulses, tilt → no single zone — the angle
// itself is the problem), but only while that zone is unlocked: a
// locked zone never pulses, it stays gold.
//
// Percent is a LIVE readiness meter: each zone contributes 0
// while sparkling, half while steady-bright (looks readable
// live), and full once locked — round(sum / 3 * 100). Gold still
// means server-confirmed only, and a lock still jumps its zone
// straight to full; but the number now climbs as framing
// improves instead of sitting at 0% until the first capture
// returns. Unconfirmed zones keep sparkling on the next live pass.

export const ZONES = [
  { key: 'name', label: 'name', top: 0.0, height: 0.14 },
  { key: 'art', label: 'art', top: 0.14, height: 0.42 },
  { key: 'number', label: 'number', top: 0.9, height: 0.1 },
];

// Coarse live-quality bars for a small zone inside a 160px sample.
// Whole-frame calibration (lib/shotquality.js) puts real photos at
// 1125+ Laplacian variance and heavy blur below 100; a zone is a
// much smaller pixel set, so its bar sits lower — this is a guide,
// never a verdict, and the firing gate keeps its own bar.
export const ZONE_SHARP_MIN = 200;
export const ZONE_GLARE_BAR = 0.25;

const SIGNAL_TO_ZONE = { picture: 'art', name: 'name', number: 'number' };
const ZONE_TO_SIGNAL = { art: 'picture', name: 'name', number: 'number' };

// Display rectangles for the zone outlines, in pixels relative to
// the preview container (which coincides with the <video> element
// — camVideo is absolute inset 0). box is the detected card box
// mapped to display pixels (lib/framing.js coverBoxDisplayRect)
// with its mode ('full' | 'rows'); guide is the outline div's
// display rect in the same space, or null. Returns null when
// there is no box to anchor to — the caller then renders no zones
// at all rather than zones in the wrong place. Rows-mode boxes
// carry no horizontal information (full-width by construction),
// so they anchor vertically to the box and horizontally to the
// guide: the vertical placement is the fix that matters (the
// number zone on the table was a vertical miss), and the guide
// width is the best horizontal estimate available. Rows without
// a guide rect also return null — a full-frame-wide guess would
// be a zone drawn across the table, the exact lie this exists to
// prevent. The 3% / 94% horizontal inset matches the old
// guide-anchored look, so a perfectly framed card looks unchanged.
export function zoneDisplayRects({ box, guide }) {
  if (!box) return null;
  let anchor;
  if (box.mode === 'rows') {
    if (!guide) return null;
    anchor = { left: guide.left, top: box.top, width: guide.width, height: box.height };
  } else {
    anchor = box;
  }
  const out = {};
  for (const zone of ZONES) {
    out[zone.key] = {
      left: anchor.left + 0.03 * anchor.width,
      top: anchor.top + zone.top * anchor.height,
      width: 0.94 * anchor.width,
      height: zone.height * anchor.height,
    };
  }
  return out;
}

// Per-zone Laplacian variance + bright-desaturated fraction, over
// the zone's rectangle inside the detected card box. data is
// row-major RGBA at w x h; box is { l, t, w, h } in frame fractions
// (see lib/capture.js analyzeCardPixels). Returns null when there
// is no box to measure inside — the caller then shows every zone
// as needing work.
export function assessZoneQuality(data, w, h, box) {
  if (!box) return null;
  const bx0 = Math.round(box.l * w);
  const by0 = Math.round(box.t * h);
  const bx1 = Math.round((box.l + box.w) * w);
  const by1 = Math.round((box.t + box.h) * h);
  if (bx1 - bx0 < 4 || by1 - by0 < 4) return null;
  const out = {};
  for (const zone of ZONES) {
    const zx0 = bx0;
    const zx1 = bx1;
    const zy0 = Math.round(by0 + zone.top * (by1 - by0));
    const zy1 = Math.round(by0 + (zone.top + zone.height) * (by1 - by0));
    const zw = zx1 - zx0;
    const zh = zy1 - zy0;
    if (zw < 2 || zh < 2) { out[zone.key] = { ready: false, sharpness: 0, glareFrac: 1 }; continue; }
    const gray = new Float64Array(zw * zh);
    let brightDesat = 0;
    for (let y = 0; y < zh; y++) {
      for (let x = 0; x < zw; x++) {
        const i = ((zy0 + y) * w + (zx0 + x)) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        gray[y * zw + x] = 0.299 * r + 0.587 * g + 0.114 * b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx > 200 && mx - mn < 30) brightDesat++;
      }
    }
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < zh - 1; y++) {
      for (let x = 1; x < zw - 1; x++) {
        const i = y * zw + x;
        const lap = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - zw] + gray[i + zw];
        sum += lap; sumSq += lap * lap; n++;
      }
    }
    const mean = n ? sum / n : 0;
    const sharpness = n ? Math.max(0, Math.round(sumSq / n - mean * mean)) : 0;
    const glareFrac = Math.round((brightDesat / (zw * zh)) * 1000) / 1000;
    out[zone.key] = { ready: sharpness >= ZONE_SHARP_MIN && glareFrac < ZONE_GLARE_BAR, sharpness, glareFrac };
  }
  return out;
}

// Combine server locks (progress or null) with live quality into
// the display state. progress is the lib/progress.js summary
// ({ picture, name, number, missing, banked }) or null on the
// first pass. quality is the assessZoneQuality result or null.
// Returns { zones: { name, art, number: { state, pulse } }, percent }.
// state is 'locked' (server-confirmed, gold), 'ready' (looks
// readable live, steady bright outline), or 'needs' (sparkling).
// pulse marks the missing stage's zone while it is still unlocked.
//
// Percent is a LIVE readiness meter, not a lock counter: each zone
// contributes 0 while sparkling, half while steady-bright, and
// full once locked — percent = round(sum / 3 * 100). A lock still
// jumps its zone straight to full, and gold still means
// server-confirmed only; but the number now climbs as framing
// improves (Face ID expectation), instead of sitting at 0% until
// the first capture returns.
export function deriveZoneDisplay({ progress = null, quality = null } = {}) {
  const locked = { name: false, art: false, number: false };
  if (progress) {
    for (const [signal, zone] of Object.entries(SIGNAL_TO_ZONE)) {
      if (progress[signal] === true) locked[zone] = true;
    }
  }
  const missing = progress ? progress.missing : null;
  const emphasized = missing === 'number' ? 'number' : missing === 'straight' ? 'name' : null;
  const zones = {};
  let weight = 0;
  for (const zone of ZONES) {
    const isLocked = locked[zone.key];
    const ready = !isLocked && quality && quality[zone.key] ? quality[zone.key].ready === true : false;
    if (isLocked) weight += 1;
    else if (ready) weight += 0.5;
    zones[zone.key] = {
      state: isLocked ? 'locked' : ready ? 'ready' : 'needs',
      pulse: !isLocked && emphasized === zone.key,
    };
  }
  return { zones, percent: Math.round((weight / ZONES.length) * 100) };
}
