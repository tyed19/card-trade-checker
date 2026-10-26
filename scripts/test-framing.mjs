// Fixtures for the preview firing gate's framing assessment +
// guidance chip (lib/framing.js) and the pixel-level box detector it
// runs on (lib/capture.js analyzeCardPixels).
import { assessFraming, luminanceContrast, guidanceFor, coverOutlineRect, coverBoxDisplayRect } from '../lib/framing.js';
import { analyzeCardPixels } from '../lib/capture.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}
const goodLum = { edge: 120, outside: 200 };
const goodBox = { l: 0.15, t: 0.1, w: 0.7, h: 0.8 };

// --- assessFraming ---
check('no box -> not framed, corners reason', (() => { const r = assessFraming(null, goodLum); return !r.framed && r.reason === 'corners'; })());
check('box touching the frame edge -> corners', (() => { const r = assessFraming({ l: 0.0, t: 0.1, w: 0.7, h: 0.8 }, goodLum); return !r.framed && r.reason === 'corners'; })());
check('full-width (rows-mode) box -> corners', (() => { const r = assessFraming({ l: 0, t: 0.1, w: 1, h: 0.8 }, goodLum); return !r.framed && r.reason === 'corners'; })());
check('short box -> closer', (() => { const r = assessFraming({ l: 0.15, t: 0.15, w: 0.7, h: 0.6 }, goodLum); return !r.framed && r.reason === 'closer'; })());
check('small-area box -> closer', (() => { const r = assessFraming({ l: 0.2, t: 0.1, w: 0.5, h: 0.75 }, goodLum); return !r.framed && r.reason === 'closer'; })());
check('weak background contrast -> background', (() => { const r = assessFraming(goodBox, { edge: 120, outside: 132 }); return !r.framed && r.reason === 'background'; })());
check('good box + strong contrast -> framed', (() => { const r = assessFraming(goodBox, goodLum); return r.framed && r.reason === null; })());
check('good box + no luminance data -> framed (never block on a missing reading)', (() => { const r = assessFraming(goodBox, null); return r.framed; })());

// --- guidanceFor: single most-blocking chip, settle window respected ---
const settled = { elapsedMs: 2000, minMs: 1000 };
check('settle window: no chip even when framing is bad', guidanceFor({ framing: { framed: false, reason: 'corners' }, glareFrac: 0, lastGood: false, elapsedMs: 400 }) === null);
check('corners chip', guidanceFor({ framing: { framed: false, reason: 'corners' }, glareFrac: 0, lastGood: false, ...settled }) === 'Show all four corners');
check('closer chip', guidanceFor({ framing: { framed: false, reason: 'closer' }, glareFrac: 0, lastGood: false, ...settled }) === 'Move closer');
check('background chip', guidanceFor({ framing: { framed: false, reason: 'background' }, glareFrac: 0, lastGood: false, ...settled }) === 'Needs a darker background');
check('framing beats glare', guidanceFor({ framing: { framed: false, reason: 'closer' }, glareFrac: 0.9, lastGood: false, ...settled }) === 'Move closer');
check('glare chip when framing is fine', guidanceFor({ framing: { framed: true, reason: null }, glareFrac: 0.4, lastGood: false, ...settled }) === 'Tilt a little');
check('steady chip when framing + glare are fine but the phone moves', guidanceFor({ framing: { framed: true, reason: null }, glareFrac: 0, lastGood: false, ...settled }) === 'Hold steady');
check('no chip when the last sample was good (fire is imminent, dots say so)', guidanceFor({ framing: { framed: true, reason: null }, glareFrac: 0, lastGood: true, ...settled }) === null);

// --- luminanceContrast on synthetic pixels ---
function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y);
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return data;
}
const brightCard = makeImage(20, 20, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 15 ? [200, 200, 200] : [50, 50, 50]));
const lum = luminanceContrast(brightCard, 20, 20, { l: 0.25, t: 0.25, w: 0.5, h: 0.5 });
check('luminance rings read bright card vs dark surround', lum && Math.abs(lum.edge - 200) < 1 && Math.abs(lum.outside - 50) < 1);
const flat = makeImage(20, 20, () => [100, 100, 100]);
const lumFlat = luminanceContrast(flat, 20, 20, { l: 0.25, t: 0.25, w: 0.5, h: 0.5 });
check('uniform frame -> ~zero contrast', lumFlat && Math.abs(lumFlat.edge - lumFlat.outside) < 1);

// --- analyzeCardPixels on synthetic pixels ---
const cardImg = makeImage(100, 140, (x, y) => (x >= 20 && x < 80 && y >= 20 && y < 120 ? [220, 40, 40] : [100, 100, 100]));
const box = analyzeCardPixels(cardImg, 100, 140, 100, 140);
check('colorful rect on dull ground is found in full mode', box && box.mode === 'full' && box.l > 0.12 && box.l < 0.22 && box.t > 0.08 && box.t < 0.16);
check('flat frame yields no box', analyzeCardPixels(flat, 20, 20, 20, 20) === null);

// --- REGRESSION (Iron Leaves, iPhone, 2026-10-25): a holo card's own
// dark middle band splits its row profile into two strong runs, so
// longest-run-wins kept only one fragment and the height gate
// returned null -> a lying 'corners' chip and a never-firing gate.
// The union span must recover the full card, not null.
const splitCard = makeImage(100, 140, (x, y) => {
  if (x >= 20 && x < 80 && y >= 20 && y < 120) {
    if (y >= 60 && y < 80) return [60, 60, 60]; // dark middle band
    return [220, 40, 40];
  }
  return [100, 100, 100];
});
const splitBox = analyzeCardPixels(splitCard, 100, 140, 100, 140);
check('card split by a dark middle band is found as one full box (union span)', splitBox && splitBox.mode === 'full' && splitBox.t < 0.2 && splitBox.h > 0.65);

// --- Outline-relative framing (preview gate): the box is judged
// against the outline the user frames inside, in video fractions.
const outline = { l: 0.4, t: 0.24, w: 0.2, h: 0.5 }; // outline rect for a landscape stream in a portrait container
check('outline: box matching the outline -> framed', (() => { const r = assessFraming({ l: 0.4, t: 0.24, w: 0.2, h: 0.5, mode: 'full' }, goodLum, outline); return r.framed && r.reason === null; })());
check('outline: box half the outline area -> closer', (() => { const r = assessFraming({ l: 0.45, t: 0.3, w: 0.1, h: 0.25, mode: 'full' }, goodLum, outline); return !r.framed && r.reason === 'closer'; })());
check('outline: box barely overlapping the outline -> corners', (() => { const r = assessFraming({ l: 0.0, t: 0.0, w: 0.2, h: 0.5, mode: 'full' }, goodLum, outline); return !r.framed && r.reason === 'corners'; })());
check('outline: box much bigger than the outline -> align, NOT corners (fully visible, just misaligned)', (() => { const r = assessFraming({ l: 0.1, t: 0.05, w: 0.8, h: 0.9, mode: 'full' }, goodLum, outline); return !r.framed && r.reason === 'align'; })());
check('outline: weak background contrast still -> background', (() => { const r = assessFraming({ l: 0.4, t: 0.24, w: 0.2, h: 0.5, mode: 'full' }, { edge: 120, outside: 132 }, outline); return !r.framed && r.reason === 'background'; })());
check('outline: missing box -> unknown, NEVER corners', (() => { const r = assessFraming(null, goodLum, outline); return !r.framed && r.reason === 'unknown'; })());
check('outline: rows-mode strip matching vertically -> unknown, not corners', (() => { const r = assessFraming({ l: 0, t: 0.24, w: 1, h: 0.5, mode: 'rows' }, goodLum, outline); return !r.framed && r.reason === 'unknown'; })());
check('outline: rows-mode strip much shorter than the outline -> closer', (() => { const r = assessFraming({ l: 0, t: 0.3, w: 1, h: 0.2, mode: 'rows' }, goodLum, outline); return !r.framed && r.reason === 'closer'; })());
// --- REGRESSION (zone scan, iPhone, 2026-10-25): a card riding
// high in the guide is fully visible — all four corners shown —
// yet the old mapping called it 'corners' (low outline overlap
// with a big-ish box) and the guide-anchored number zone landed on
// the table below the card. 'corners' is now reserved for a box
// actually touching the frame edge; every fully-visible miss is
// the alignment hint.
check('outline: card high in the guide -> align, NEVER corners', (() => { const r = assessFraming({ l: 0.4, t: 0.05, w: 0.2, h: 0.5, mode: 'full' }, goodLum, outline); return !r.framed && r.reason === 'align'; })());
check('outline: box touching the frame edge -> corners (actually cut off)', (() => { const r = assessFraming({ l: 0.0, t: 0.24, w: 0.2, h: 0.5, mode: 'full' }, goodLum, outline); return !r.framed && r.reason === 'corners'; })());
check('outline: rows strip overflowing the outline vertically -> align', (() => { const r = assessFraming({ l: 0, t: 0.1, w: 1, h: 0.5, mode: 'rows' }, goodLum, outline); return !r.framed && r.reason === 'align'; })());
check('outline: rows strip touching the frame edge vertically -> corners', (() => { const r = assessFraming({ l: 0, t: 0.0, w: 1, h: 0.5, mode: 'rows' }, goodLum, outline); return !r.framed && r.reason === 'corners'; })());
check('align chip', guidanceFor({ framing: { framed: false, reason: 'align' }, glareFrac: 0, lastGood: false, ...settled }) === 'Center the card in the outline');
check('unknown reason produces NO chip (steady phone, fallback hold governs)', guidanceFor({ framing: { framed: false, reason: 'unknown' }, glareFrac: 0, lastGood: true, ...settled }) === null);
check('unknown reason + moving phone -> Hold steady, never corners', guidanceFor({ framing: { framed: false, reason: 'unknown' }, glareFrac: 0, lastGood: false, ...settled }) === 'Hold steady');

// --- coverOutlineRect: landscape stream (1920x1080) in a portrait
// container (390x844) with a centered 78%-width outline.
const cover = coverOutlineRect({
  videoRect: { left: 0, top: 0, width: 390, height: 844 },
  outlineRect: { left: 43, top: 200, width: 304, height: 425 },
  videoW: 1920, videoH: 1080,
});
check('cover transform: outline maps to the central video slice (l~0.40, w~0.20, h~0.50)', Math.abs(cover.l - 0.40) < 0.02 && Math.abs(cover.w - 0.20) < 0.02 && Math.abs(cover.h - 0.50) < 0.02 && Math.abs(cover.t - 0.24) < 0.02);

// --- coverBoxDisplayRect: inverse cover transform, box fractions
// -> display pixels relative to the video element's top-left. The
// same landscape-stream-in-portrait-container geometry as above:
// a box equal to the outline fractions lands on the outline's
// display rect, and a box riding high lands high.
const boxRect = coverBoxDisplayRect({
  videoRect: { left: 0, top: 0, width: 390, height: 844 },
  videoW: 1920, videoH: 1080,
  box: { l: 0.4, t: 0.24, w: 0.2, h: 0.5 },
});
check('box display rect: outline fractions land on the outline pixels', Math.abs(boxRect.left - 43) < 5 && Math.abs(boxRect.top - 200) < 5 && Math.abs(boxRect.width - 304) < 5 && Math.abs(boxRect.height - 425) < 5);
const highBoxRect = coverBoxDisplayRect({
  videoRect: { left: 0, top: 0, width: 390, height: 844 },
  videoW: 1920, videoH: 1080,
  box: { l: 0.4, t: 0.05, w: 0.2, h: 0.5 },
});
check('box display rect: high card lands high, not on the guide bottom', Math.abs(highBoxRect.top - 42) < 5 && Math.abs(highBoxRect.top + highBoxRect.height - 464) < 5);

// --- REGRESSION (bottom overshoot, iPhone, 2026-10-25, third
// screenshot): Iron Leaves ex on dark wood — the row-profile
// detector ran the box to the frame bottom (a bright wood
// highlight blip near the bottom merged into the span), so the
// number zone detached to the screen bottom and a 'corners' chip
// fired on a fully visible card. Synthetic landscape stream
// (160x90 sample, 1920x1080 stream): card rows 0.115-0.615,
// central 23% of width, sparse name strip, solid art + text,
// dark wood table, optional blip at rows 0.85-0.885.
function landscapeStreamFrame(blip) {
  const W = 160, H = 90, data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = 60; data[i * 4 + 1] = 42; data[i * 4 + 2] = 28; data[i * 4 + 3] = 255; }
  const paint = (y0, y1, x0, x1, rgb, frac) => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (rnd() < frac) { const i = (y * W + x) * 4; data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; }
    }
  };
  const cardX0 = Math.floor(0.385 * W), cardX1 = Math.floor(0.615 * W);
  const y = (f) => Math.floor(f * H);
  paint(y(0.115), y(0.20), cardX0, cardX1, [120, 200, 90], 0.05); // sparse name strip
  paint(y(0.20), y(0.47), cardX0, cardX1, [220, 60, 60], 0.55); // art
  paint(y(0.47), y(0.615), cardX0, cardX1, [90, 150, 90], 0.30); // text
  if (blip) paint(y(0.85), y(0.885), Math.floor(0.2 * W), Math.floor(0.8 * W), [190, 150, 100], 0.35);
  return data;
}
const TRUE_BOTTOM = 0.615;
const blipBox = analyzeCardPixels(landscapeStreamFrame(true), 160, 90, 1920, 1080);
const noBlipBox = analyzeCardPixels(landscapeStreamFrame(false), 160, 90, 1920, 1080);
check('landscape stream + wood blip: box found, ends at the real bottom, NOT the frame bottom', blipBox && blipBox.t + blipBox.h > 0.55 && blipBox.t + blipBox.h < 0.75);
check('landscape stream, no blip: same box (the blip must not move it)', noBlipBox && blipBox && Math.abs((noBlipBox.t + noBlipBox.h) - (blipBox.t + blipBox.h)) < 0.02);
check('number zone of such a box sits on the real bottom corner, not the table', blipBox && (() => {
  const zb = blipBox.t + blipBox.h, zt = zb - 0.1 * blipBox.h;
  return zt < TRUE_BOTTOM && zb < 0.75;
})());
// The overstretch rule: a rows-mode strip that touches the frame
// edge but is far taller than the outline is an overshot span,
// not a cut-off card — 'unknown' (no chip), NEVER 'corners'.
check('outline: overstretched rows strip touching the frame edge -> unknown, NEVER corners', (() => { const r = assessFraming({ l: 0, t: 0.148, w: 1, h: 0.85, mode: 'rows' }, goodLum, outline); return !r.framed && r.reason === 'unknown'; })());
// The aspect floor: perspective tilt only ever makes a card look
// SHORTER (aspect larger), so a box far too tall for its width is
// an overstated span, not a tilted card — rejected outright.
// 0.43 x 0.90 rect on a square stream: expanded aspect ~0.56,
// inside the old window (0.515-0.931) but below the 0.58 floor.
const tallThin = makeImage(100, 100, (x, y) => (x >= 28 && x < 71 && y >= 5 && y < 95 ? [220, 40, 40] : [100, 100, 100]));
check('tall-thin box (aspect below the 0.58 floor) -> null, not a box on the table', analyzeCardPixels(tallThin, 100, 100, 100, 100) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
