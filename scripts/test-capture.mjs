#!/usr/bin/env node
// Fixtures for the capture overhaul:
//   - lib/shotquality.js: blur gate bars (sharp photo passes, heavy
//     blur blocks, glare advisory never blocks on its own)
//   - lib/warp.js: perspective tilt round-trip (corner recovery +
//     unwarped image similarity) and degenerate-quad rejection
//   - lib/degrade.js: every variant decodes and moves its metric the
//     right way (blur down, glare bright fraction up, jpeg smaller)
//
//   node scripts/test-capture.mjs
import sharp from 'sharp';
import { measureShot, assessShot, pickSharpest } from '../lib/shotquality.js';
import { warpPerspective, tiltPerspective, detectCardCorners } from '../lib/warp.js';
import { blurImage, jpegImage, glareImage, darkenImage, degradeAll, swapBackground } from '../lib/degrade.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  if (got === want) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}: got ${got}, want ${want}`); }
};
const checkTrue = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label} ${detail}`); }
};

async function rawPixels(buf) {
  const { data, info } = await sharp(buf).resize({ width: 320 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

// A synthetic high-contrast card-like image: cream face, dark border,
// color art block, bold name + number text.
async function synthCard(W = 630, H = 880) {
  const svg = `<svg width="${W}" height="${H}">`
    + `<rect width="100%" height="100%" fill="#fdf2dc"/>`
    + `<rect x="12" y="12" width="${W - 24}" height="${H - 24}" fill="none" stroke="#14213d" stroke-width="10"/>`
    + `<rect x="40" y="120" width="${W - 80}" height="420" fill="#2a75bb"/>`
    + `<rect x="60" y="140" width="${W - 120}" height="120" fill="#ffcb05"/>`
    + `<text x="40" y="80" font-family="sans-serif" font-size="64" font-weight="bold" fill="#14213d">MEOWTH</text>`
    + `<text x="40" y="${H - 60}" font-family="sans-serif" font-size="44" font-weight="bold" fill="#14213d">106/094</text>`
    + `<text x="${W - 220}" y="${H - 60}" font-family="sans-serif" font-size="36" fill="#475569">Illus. Test</text>`
    + `</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

// ---- 1. shot quality ----
{
  const card = await synthCard();
  const sharpM = measureShot(await rawPixels(card));
  checkTrue('sharp card passes blur bar', sharpM.sharpness >= 400, `sharp=${sharpM.sharpness}`);
  check('sharp card verdict ok', assessShot(await rawPixels(card)).verdict, 'ok');
  const blurred = await blurImage(card, 6);
  const blurM = measureShot(await rawPixels(blurred));
  checkTrue('heavy blur below bar', blurM.sharpness < 400, `sharp=${blurM.sharpness}`);
  check('heavy blur verdict blurry', assessShot(await rawPixels(blurred)).verdict, 'blurry');
  const frames = [await rawPixels(blurred), await rawPixels(card)];
  check('pickSharpest prefers the sharp frame', pickSharpest(frames), 1);
  const glared = await glareImage(card);
  const glareM = measureShot(await rawPixels(glared));
  checkTrue('glare raises bright fraction', glareM.glareFrac > sharpM.glareFrac,
    `orig=${sharpM.glareFrac} glared=${glareM.glareFrac}`);
}

// ---- 2. warp round-trip ----
{
  const card = await synthCard();
  const quad = [
    { x: 0.10, y: 0.06 }, { x: 0.92, y: 0.10 },
    { x: 0.88, y: 0.94 }, { x: 0.06, y: 0.90 },
  ];
  const tilted = await tiltPerspective(card, quad, 630, 880);
  checkTrue('tilt renders', !!tilted);
  // The axis-aligned bounding box is what locate would hand the warp.
  const box = {
    l: Math.min(...quad.map((c) => c.x)),
    t: Math.min(...quad.map((c) => c.y)),
    w: Math.max(...quad.map((c) => c.x)) - Math.min(...quad.map((c) => c.x)),
    h: Math.max(...quad.map((c) => c.y)) - Math.min(...quad.map((c) => c.y)),
  };
  const found = await detectCardCorners(tilted, box);
  checkTrue('corners detected', !!found);
  if (found) {
    const err = Math.max(...found.map((c, i) => Math.hypot(c.x - quad[i].x, c.y - quad[i].y)));
    checkTrue('corner recovery within 0.05', err < 0.05, `err=${err.toFixed(4)}`);
    const flat = await warpPerspective(tilted, found, 630, 880);
    checkTrue('unwarp renders', !!flat);
    if (flat) {
      const a = await sharp(card).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const b = await sharp(flat).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let sum = 0;
      const n = Math.min(a.data.length, b.data.length);
      for (let i = 0; i < n; i++) sum += Math.abs(a.data[i] - b.data[i]);
      const mad = sum / n;
      checkTrue('unwarped close to original', mad < 30, `mad=${mad.toFixed(1)}`);
    }
  }
  const degenerate = await warpPerspective(card, [
    { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 },
  ], 630, 880);
  check('degenerate quad rejected', degenerate, null);
}

// ---- 3. degrade set ----
{
  const card = await synthCard();
  const variants = await degradeAll(card);
  check('degradeAll yields 9 variants', variants.length, 9);
  for (const v of variants) {
    const meta = await sharp(v.buf).metadata().catch(() => null);
    checkTrue(`variant ${v.name} decodes`, !!meta && meta.width > 0);
  }
  const q95 = await sharp(card).jpeg({ quality: 95 }).toBuffer();
  const q50 = await jpegImage(card, 50);
  checkTrue('jpeg50 smaller than jpeg95', q50.length < q95.length, `${q50.length} vs ${q95.length}`);
  const dark = await darkenImage(card);
  const darkM = measureShot(await rawPixels(dark));
  const origM = measureShot(await rawPixels(card));
  checkTrue('dark variant dimmer or softer', darkM.sharpness <= origM.sharpness,
    `dark=${darkM.sharpness} orig=${origM.sharpness}`);
  // bgswap must actually change the image even when locate finds no
  // box (tight full-frame card: the center-crop fallback covers it).
  const swapped = await swapBackground(card);
  checkTrue('bgswap differs from original', !swapped.equals(card));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
