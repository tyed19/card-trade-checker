// Synthetic phone-degradation harness (capture overhaul, Phase A).
//
// Purpose: validate the crop/warp + picture + OCR pipeline against
// phone-like damage WITHOUT any user data. Real user photos are never
// stored and never needed here — these transforms synthesize the
// damage classes that cause retakes (tilt, blur, compression, glare,
// dim light, busy backgrounds) from any input photo, so the pipeline
// can be stress-tested and the future fine-tune track (see
// docs/CAPTURE-LEARNING-LOOP.md) can be evaluated, all from synthetic
// variants of a single clean capture.
//
// Every function is deterministic (no randomness): the same input
// always yields the same variant, so fixture expectations are stable.

import sharp from 'sharp';
import { tiltPerspective } from './warp.js';
import { locateCard } from './locate.js';

// Perspective tilt: the flat input rendered as a quadrilateral.
// `quad` is fractions of the output, order TL, TR, BR, BL.
export async function tiltImage(buf, quad, outW = null, outH = null) {
  const meta = await sharp(buf).metadata();
  const W = outW || meta.width, H = outH || meta.height;
  return tiltPerspective(buf, quad, W, H);
}

// Gaussian blur at increasing severity (kid-hand shake proxy).
export async function blurImage(buf, sigma) {
  return sharp(buf).blur(sigma).toBuffer();
}

// JPEG recompression (the phone-path damage class).
export async function jpegImage(buf, quality) {
  return sharp(buf).jpeg({ quality }).toBuffer();
}

// Sleeve/glare: a soft white radial highlight, screen-blended.
export async function glareImage(buf, cx = 0.5, cy = 0.42, r = 0.45) {
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  const svg = `<svg width="${W}" height="${H}"><defs><radialGradient id="g" cx="${cx * 100}%" cy="${cy * 100}%" r="${r * 100}%"><stop offset="0%" stop-color="white" stop-opacity="0.95"/><stop offset="60%" stop-color="white" stop-opacity="0.45"/><stop offset="100%" stop-color="white" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(buf).composite([{ input: Buffer.from(svg), blend: 'screen' }]).toBuffer();
}

// Dim light: darken + a touch of blur (low-light phone shots lose
// both brightness and edge contrast).
export async function darkenImage(buf, factor = 0.55) {
  return sharp(buf).modulate({ brightness: factor }).blur(0.6).toBuffer();
}

// Busy background: the located card crop pasted onto a flat mid-tone
// background with a darker band (table edge proxy). When locate finds
// no box (e.g. a tight shot where the card fills the frame, so the
// chroma profile has no background contrast — the real Meowth photo
// behaves exactly this way), a center crop stands in: the variant's
// job is testing busy backgrounds, and a tight card crop is the right
// subject for that regardless of how it was found.
export async function swapBackground(buf) {
  const meta = await sharp(buf).metadata();
  const loc = await locateCard(buf, meta).catch(() => null);
  const box = (loc && loc.box && loc.mode !== 'frame')
    ? loc.box
    : { l: 0.1, t: 0.05, w: 0.8, h: 0.9 };
  const left = Math.max(0, Math.round(box.l * meta.width));
  const top = Math.max(0, Math.round(box.t * meta.height));
  const width = Math.min(meta.width - left, Math.round(box.w * meta.width));
  const height = Math.min(meta.height - top, Math.round(box.h * meta.height));
  const crop = await sharp(buf).extract({ left, top, width, height }).toBuffer();
  const bg = await sharp({
    create: {
      width: meta.width, height: meta.height, channels: 3,
      background: { r: 148, g: 138, b: 120 },
    },
  }).composite([{
    input: Buffer.from(
      `<svg width="${meta.width}" height="${meta.height}"><rect y="${Math.round(meta.height * 0.7)}" width="100%" height="30%" fill="#6b6257"/></svg>`
    ),
    top: 0, left: 0,
  }]).jpeg({ quality: 92 }).toBuffer();
  // Paste the card slightly rotated for realism (affine shear).
  const placed = await sharp(crop).affine([1, 0.06, -0.04, 1], { background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  const pm = await sharp(placed).metadata();
  return sharp(bg).composite([{
    input: placed,
    top: Math.max(0, Math.round((meta.height - pm.height) / 2)),
    left: Math.max(0, Math.round((meta.width - pm.width) / 2)),
  }]).jpeg({ quality: 92 }).toBuffer();
}

// The standard variant set: one entry per damage class, each named
// for the report. Tilt quads are modest (realistic hand-held tilt),
// not extreme — extreme tilt is a separate corner case.
export async function degradeAll(buf) {
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  const out = [];
  out.push({ name: 'orig', buf });
  out.push({
    name: 'tilt-light',
    buf: await tiltImage(buf, [
      { x: 0.10, y: 0.06 }, { x: 0.92, y: 0.10 },
      { x: 0.88, y: 0.94 }, { x: 0.06, y: 0.90 },
    ], W, H),
  });
  out.push({
    name: 'tilt-hard',
    buf: await tiltImage(buf, [
      { x: 0.18, y: 0.04 }, { x: 0.86, y: 0.16 },
      { x: 0.78, y: 0.96 }, { x: 0.08, y: 0.84 },
    ], W, H),
  });
  out.push({ name: 'blur3', buf: await blurImage(buf, 3) });
  out.push({ name: 'blur6', buf: await blurImage(buf, 6) });
  out.push({ name: 'jpeg50', buf: await jpegImage(buf, 50) });
  out.push({ name: 'glare', buf: await glareImage(buf) });
  out.push({ name: 'dark', buf: await darkenImage(buf) });
  out.push({ name: 'bgswap', buf: await swapBackground(buf) });
  return out.filter((v) => !!v.buf);
}
