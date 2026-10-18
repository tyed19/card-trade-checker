// Generate the @capacitor/assets source images in assets/ from the
// final FairSwap brand SVGs (kept OUTSIDE the repo — this script reads
// the canonical brand folder and writes plain PNGs the asset tool
// consumes; re-run it if the brand mark ever changes).
//
//   node scripts/make-native-assets.mjs [brandDir]
//   npx capacitor-assets generate
//
// Brand rules applied (fairswap-brand/final/usage-spec.md):
//  - iOS icon: full mark on a full-bleed Cream field (no alpha).
//  - Android adaptive: REVERSED mark (cream cards) as foreground over
//    a Deep Teal background layer; art held inside the maskable safe
//    zone (~76%), same geometry as maskable-512.
//  - Splash: reversed mark centred on Deep Teal, both modes (the
//    app's ground IS teal/navy — no separate light splash).
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const brandDir = process.argv[2] || join(process.env.HOME, 'workspace/your_files/fairswap-brand/final');
const outDir = join(process.cwd(), 'assets');
mkdirSync(outDir, { recursive: true });

const TEAL = '#00596B';
const CREAM = '#FDF2DC';
const mark = readFileSync(join(brandDir, 'fairswap-mark.svg'));
const markReversed = readFileSync(join(brandDir, 'fairswap-mark-reversed.svg'));

const solid = (size, hex) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${hex}"/></svg>`));

// Render an SVG mark at `px`, centred on a `canvas`x`canvas` ground.
async function centred(svgBuf, canvas, px, groundHex) {
  const art = await sharp(svgBuf).resize(px, px).png().toBuffer();
  return solid(canvas, groundHex)
    .composite([{ input: art, gravity: 'center' }])
    .png();
}

const jobs = [
  // iOS / legacy Android icon: full-colour mark on cream, art ~88%.
  ['icon.png', () => centred(mark, 1024, 900, CREAM)],
  // Android adaptive foreground: reversed mark, transparent, ~76%.
  ['icon-foreground.png', async () => {
    const art = await sharp(markReversed).resize(780, 780).png().toBuffer();
    return sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: art, gravity: 'center' }])
      .png();
  }],
  // Android adaptive background: solid Deep Teal.
  ['icon-background.png', () => solid(1024, TEAL).png()],
  // Splash (2732 = largest iOS splash canvas): reversed mark ~34%.
  ['splash.png', () => centred(markReversed, 2732, 940, TEAL)],
  ['splash-dark.png', () => centred(markReversed, 2732, 940, TEAL)],
];

for (const [name, make] of jobs) {
  const img = await make();
  await img.toFile(join(outDir, name));
  const meta = await sharp(join(outDir, name)).metadata();
  console.log(`${name}: ${meta.width}x${meta.height} ${meta.format}`);
}
console.log('Asset sources written to assets/ — now run: npx capacitor-assets generate');
