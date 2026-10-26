// Fixtures for the preview firing gate's framing assessment +
// guidance chip (lib/framing.js) and the pixel-level box detector it
// runs on (lib/capture.js analyzeCardPixels).
import { assessFraming, luminanceContrast, guidanceFor } from '../lib/framing.js';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
