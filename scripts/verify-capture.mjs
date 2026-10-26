#!/usr/bin/env node
// First-shot verification for the capture overhaul:
//   node scripts/verify-capture.mjs --base http://localhost:3100 [--only Meowth,SVP074]
//
// For each hard + regression card, posts three lanes:
//   raw      — the original photo as-is (the pre-overhaul as-is lane)
//   phonesim — whole frame resized to 2400px / JPEG q90 (the OLD client
//              path: the lane that crushed Meowth's name 0.67 -> 0.25)
//   cropsim  — locate-crop + 1800px / JPEG q95 with cropped=1 (the NEW
//              client path, simulated server-side with the same box
//              algorithm the browser port uses)
// Reports per card per lane: zone, confident, whether the top
// displayable pick is the CORRECT print (first-shot success), a WRONG
// top (must never happen), or a retake. The metric Tye cares about
// is first-shot success on the cropsim lane with zero wrong tops.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { locateCard } from '../lib/locate.js';

const argv = process.argv.slice(2);
const get = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const BASE = get('--base', 'http://localhost:3100');
const ONLY = (get('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const M = path.join(process.env.HOME, 'workspace/user/media_library/image');
const REPO = path.resolve('.');

const TESTS = [
  { name: 'SVP074-sleeved', file: `${M}/0a/0a8e4e2b6589c8b8fcbca644feb84e7e18484605d81eff42b5495bd77ab29fab.jpg`, want: { name: 'Charizard ex', number: '74' } },
  { name: 'Evolutions-11', file: `${M}/61/617f0bdb93bc0ccf7f6129c003e6bf602e9b210824f5db0945b2c19fee94f00a.jpg`, want: { name: 'Charizard', number: '11' } },
  { name: 'Meowth', file: `${M}/f2/f25135ea86483913d950ab86388bd6e18b05653204063bb1b910342e3ddd0b97.jpg`, want: { name: 'Meowth', number: '106' } },
  { name: 'MegaAbomasnow', file: `${M}/67/67c66b812a806ef2c815b0dbc8e3fcd23726a0ef910ee12bbc22d3cbd25a5279.jpg`, want: { name: 'Mega Abomasnow ex', number: '157' } },
  { name: 'Flapple', file: `${M}/0f/0f616951db4912e14021ba7da3cc194275bbe4edfa4dbd2019b088059eb3c4e4.jpg`, want: { name: 'Flapple VMAX', number: '19' } },
  { name: 'Galvantula', file: `${REPO}/data/galvantula-crop.jpg`, want: { name: 'Galvantula ex', number: '51' } },
  { name: 'Victini', file: `${M}/67/67c1a18b2fd2f14f8af2b9448bbbbcdf9bda5efe40b75da07648f31e4d6e073a.jpg`, want: { name: 'Victini', number: '20' } },
  { name: 'Dialga-promo', file: `${M}/71/715aa8c78b4e62130cff4afeecabb8f4eb9c1c37fd4eebfa42fc95983b59461c.jpg`, want: { name: 'Dialga ex', number: '180' } },
  { name: 'Tyranitar', file: `${M}/4d/4d45f593e06c7dd9a1bcc9747203d895603d15339d3a0b8d0e7553c9a5ef0d24.jpg`, want: { name: 'Tyranitar ex', number: '64' } },
  { name: 'Dragonite-JP', file: `${M}/cc/ccd9fea931fa5736830effbe3f81551cf8c952728f165ea976697257d223fcc7.jpg`, want: { name: 'Dragonite VSTAR', number: '50' } },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const isWant = (c, want) => norm(c.name) === norm(want.name) && String(c.number).replace(/^0+/, '') === want.number;

async function phoneSim(buf) {
  const rot = await sharp(buf).rotate().toBuffer();
  const meta = await sharp(rot).metadata();
  const scale = Math.min(1, 2400 / Math.max(meta.width, meta.height));
  if (scale === 1) return rot;
  return sharp(rot).resize(Math.round(meta.width * scale), Math.round(meta.height * scale)).jpeg({ quality: 90 }).toBuffer();
}

async function cropSim(buf) {
  const rot = await sharp(buf).rotate().toBuffer();
  const meta = await sharp(rot).metadata();
  const loc = await locateCard(rot, meta).catch(() => null);
  if (!loc || !loc.box || loc.mode === 'frame') return { buf: rot, cropped: false };
  const left = Math.max(0, Math.round(loc.box.l * meta.width));
  const top = Math.max(0, Math.round(loc.box.t * meta.height));
  const width = Math.min(meta.width - left, Math.round(loc.box.w * meta.width));
  const height = Math.min(meta.height - top, Math.round(loc.box.h * meta.height));
  if (width <= 60 || height <= 60) return { buf: rot, cropped: false };
  const scale = Math.min(1, 1800 / Math.max(width, height));
  const crop = await sharp(rot).extract({ left, top, width, height })
    .resize(Math.round(width * scale), Math.round(height * scale))
    .jpeg({ quality: 95 }).toBuffer();
  return { buf: crop, cropped: true };
}

async function post(buf, cropped) {
  const form = new FormData();
  form.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'card.jpg');
  if (cropped) form.append('cropped', '1');
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/identify`, { method: 'POST', body: form });
  const json = await res.json();
  return { json, ms: Date.now() - t0 };
}

let firstShot = 0, retakes = 0, wrong = 0, total = 0;
for (const t of TESTS) {
  if (ONLY.length && !ONLY.some((o) => t.name.toLowerCase().includes(o.toLowerCase()))) continue;
  if (!fs.existsSync(t.file)) { console.log(`${t.name}: MISSING FILE`); continue; }
  const orig = fs.readFileSync(t.file);
  const lanes = [
    { lane: 'raw', buf: orig, cropped: false },
    { lane: 'phonesim', buf: await phoneSim(orig), cropped: false },
  ];
  const cs = await cropSim(orig);
  lanes.push({ lane: 'cropsim', buf: cs.buf, cropped: cs.cropped });
  for (const l of lanes) {
    total++;
    let row;
    try {
      const { json, ms } = await post(l.buf, l.cropped);
      const disp = (json.candidates || []).filter((c) => c.displayable);
      const top = disp[0] || null;
      const verdict = !top ? 'RETAKE'
        : isWant(top, t.want) ? 'FIRST-SHOT-OK'
        : 'WRONG-TOP';
      if (verdict === 'FIRST-SHOT-OK') firstShot++;
      else if (verdict === 'WRONG-TOP') wrong++;
      else retakes++;
      row = `${t.name} [${l.lane}${l.cropped ? '+cropflag' : ''}]: ${verdict} zone=${json.zone || json.error || '?'} top=${top ? `${top.name} #${top.number}` : 'none'} ms=${ms} hint=${json.retakeHint ? 'yes' : 'no'}`;
    } catch (err) {
      retakes++;
      row = `${t.name} [${l.lane}]: ERROR ${String(err && err.message || err)}`;
    }
    console.log(row);
  }
}
console.log(`\nTOTAL ${total}: first-shot ${firstShot}, retakes ${retakes}, WRONG TOPS ${wrong}`);
process.exit(wrong ? 2 : 0);
