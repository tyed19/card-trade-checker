#!/usr/bin/env node
// Synthetic degradation runner (capture overhaul, Phase A):
//   node scripts/degrade-photo.mjs <photo> [--out /tmp/degrade-out]
//       [--base http://localhost:3100] [--identify] [--crop]
//
// Writes one degraded variant per damage class to --out (default
// /tmp/degrade-out — never the repo, so no user photo is committed),
// and with --identify POSTs each variant to <base>/api/identify and
// reports zone / confident / top displayable / timing. --crop mimics
// the new client path: locate-crop + q95 with cropped=1; without it
// variants post as plain whole-frame photos (cropped=0).
//
// The input photo itself is only read, never written anywhere except
// the --out dir the operator chose.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { degradeAll } from '../lib/degrade.js';
import { locateCard } from '../lib/locate.js';

const args = process.argv.slice(2);
const photo = args.find((a) => !a.startsWith('--'));
const get = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = get('--out', '/tmp/degrade-out');
const BASE = get('--base', 'http://localhost:3100');
const IDENTIFY = args.includes('--identify');
const CROP = args.includes('--crop');

if (!photo || !fs.existsSync(photo)) {
  console.error('usage: node scripts/degrade-photo.mjs <photo> [--out dir] [--base URL] [--identify] [--crop]');
  process.exit(1);
}

const orig = fs.readFileSync(photo);
const rotated = await sharp(orig).rotate().toBuffer();
const variants = await degradeAll(rotated);
fs.mkdirSync(OUT, { recursive: true });

async function clientCrop(buf) {
  const meta = await sharp(buf).metadata();
  const loc = await locateCard(buf, meta).catch(() => null);
  if (!loc || !loc.box || loc.mode === 'frame') return { buf, cropped: false };
  const left = Math.max(0, Math.round(loc.box.l * meta.width));
  const top = Math.max(0, Math.round(loc.box.t * meta.height));
  const width = Math.min(meta.width - left, Math.round(loc.box.w * meta.width));
  const height = Math.min(meta.height - top, Math.round(loc.box.h * meta.height));
  if (width <= 60 || height <= 60) return { buf, cropped: false };
  const scale = Math.min(1, 1800 / Math.max(width, height));
  const crop = await sharp(buf).extract({ left, top, width, height })
    .resize(Math.round(width * scale), Math.round(height * scale))
    .jpeg({ quality: 95 }).toBuffer();
  return { buf: crop, cropped: true };
}

const report = [];
for (const v of variants) {
  const file = path.join(OUT, `${v.name}.jpg`);
  fs.writeFileSync(file, v.buf);
  const row = { variant: v.name, bytes: v.buf.length };
  if (IDENTIFY) {
    let up = v.buf, cropped = false;
    if (CROP) ({ buf: up, cropped } = await clientCrop(v.buf));
    const form = new FormData();
    form.append('photo', new Blob([up], { type: 'image/jpeg' }), 'card.jpg');
    if (cropped) form.append('cropped', '1');
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/api/identify`, { method: 'POST', body: form });
      const json = await res.json();
      const disp = (json.candidates || []).filter((c) => c.displayable);
      row.zone = json.zone || json.error || 'no-response';
      row.confident = !!json.confident;
      row.top = disp.length ? `${disp[0].name} #${disp[0].number} ($${disp[0].price ?? '?'})` : null;
      row.retakeHint = json.retakeHint ? 'yes' : 'no';
      row.ms = Date.now() - t0;
    } catch (err) {
      row.error = String(err && err.message || err);
    }
  }
  report.push(row);
  console.log(JSON.stringify(row));
}
