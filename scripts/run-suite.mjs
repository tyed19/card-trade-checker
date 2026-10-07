#!/usr/bin/env node
// End-to-end suite for /api/identify: the 8 real test photos, run as-is
// plus (optionally) phone-sim variants (2400px / JPEG q90, mirroring the
// client's upload shrink). Works against a local server or production.
//
//   node scripts/run-suite.mjs --base http://localhost:3100 [--sims] [--runs 2] [--only Tyranitar,Victini]
//
// Per photo it reports: zone taken, wall time, server totalMs, the top
// DISPLAYABLE candidate, whether the correct print is among the
// displayable choices, and flags a WRONG displayable top pick (the one
// outcome that must never happen).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--sims') args.sims = true;
  else if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
}
const BASE = args.base || 'http://localhost:3100';
const RUNS = parseInt(args.runs || '2', 10);
const ONLY = (args.only || '').split(',').map((s) => s.trim()).filter(Boolean);
const M = path.join(process.env.HOME, 'workspace/user/media_library/image');
const REPO = path.resolve('.');

const TESTS = [
  { name: 'Flapple VMAX', file: `${M}/0f/0f616951db4912e14021ba7da3cc194275bbe4edfa4dbd2019b088059eb3c4e4.jpg`, want: { name: 'Flapple VMAX', number: '19' } },
  { name: 'Mega Abomasnow ex', file: `${M}/67/67c66b812a806ef2c815b0dbc8e3fcd23726a0ef910ee12bbc22d3cbd25a5279.jpg`, want: { name: 'Mega Abomasnow ex', number: '157' } },
  { name: 'Meowth', file: `${M}/f2/f25135ea86483913d950ab86388bd6e18b05653204063bb1b910342e3ddd0b97.jpg`, want: { name: 'Meowth', number: '106' } },
  { name: 'Galvantula ex (crop)', file: `${REPO}/data/galvantula-crop.jpg`, want: { name: 'Galvantula ex', number: '51' }, sim: false },
  { name: 'Victini', file: `${M}/67/67c1a18b2fd2f14f8af2b9448bbbbcdf9bda5efe40b75da07648f31e4d6e073a.jpg`, want: { name: 'Victini', number: '20' }, sim: true },
  { name: 'Dialga ex (promo)', file: `${M}/71/715aa8c78b4e62130cff4afeecabb8f4eb9c1c37fd4eebfa42fc95983b59461c.jpg`, want: { name: 'Dialga ex', number: '180' } },
  { name: 'Tyranitar ex', file: `${M}/4d/4d45f593e06c7dd9a1bcc9747203d895603d15339d3a0b8d0e7553c9a5ef0d24.jpg`, want: { name: 'Tyranitar ex', number: '64' }, sim: true },
  { name: 'Dragonite VSTAR (JP)', file: `${M}/cc/ccd9fea931fa5736830effbe3f81551cf8c952728f165ea976697257d223fcc7.jpg`, want: { name: 'Dragonite VSTAR', number: '50' }, sim: true },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const isWant = (c, want) => norm(c.name) === norm(want.name) && String(c.number).replace(/^0+/, '') === want.number.replace(/^0+/, '');

async function post(buf, filename) {
  const fd = new FormData();
  fd.append('photo', new Blob([buf], { type: 'image/jpeg' }), filename);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/identify`, { method: 'POST', body: fd });
  const wall = Date.now() - t0;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, wall, json };
}

async function phoneSim(buf) {
  const m = await sharp(buf).metadata();
  let img = sharp(buf).rotate();
  if (m.width > 2400 || m.height > 2400) img = img.resize({ width: 2400, height: 2400, fit: 'inside' });
  return img.jpeg({ quality: 90 }).toBuffer();
}

const rows = [];
for (const t of TESTS) {
  if (ONLY.length && !ONLY.some((o) => t.name.toLowerCase().includes(o.toLowerCase()))) continue;
  const orig = fs.readFileSync(t.file);
  const variants = [{ label: 'as-is', buf: orig }];
  if (args.sims && t.sim !== false) variants.push({ label: 'phone-sim', buf: await phoneSim(orig) });
  else if (args.sims && t.sim === true) variants.push({ label: 'phone-sim', buf: await phoneSim(orig) });
  for (const v of variants) {
    const n = v.label === 'phone-sim' ? 1 : RUNS;
    for (let run = 1; run <= n; run++) {
      let out;
      try {
        out = await post(v.buf, `${t.name}.jpg`);
      } catch (err) {
        rows.push({ photo: t.name, variant: v.label, run, error: String(err && err.message || err) });
        console.log(`${t.name} [${v.label} #${run}] REQUEST FAILED: ${err && err.message}`);
        continue;
      }
      const { status, wall, json } = out;
      const cands = json.candidates || [];
      const disp = cands.filter((c) => c.displayable);
      const top = disp[0] || null;
      const correctPresent = disp.some((c) => isWant(c, t.want));
      const wrongTop = !!top && !isWant(top, t.want);
      const rec = {
        photo: t.name, variant: v.label, run, status, zone: json.zone || '-',
        wallMs: wall, serverMs: json.timing ? json.timing.totalMs : null,
        serverOcrMs: json.timing ? json.timing.ocrMs : null,
        topSim: json.timing && json.timing.pictmatch ? json.timing.pictmatch.topSim : null,
        topDisplayable: top ? `${top.name} #${top.number} (${top.set}) $${top.price}${top.proxy ? ' PROXY' : ''}${top.lang ? ' [' + top.lang + ']' : ''}` : '(none)',
        correctPresent, wrongTop, displayableN: disp.length,
        errorField: json.error || null, slow: !!json.retry,
      };
      rows.push(rec);
      console.log(`${t.name} [${v.label} #${run}] zone=${rec.zone} wall=${wall}ms server=${rec.serverMs}ms topSim=${rec.topSim} | top: ${rec.topDisplayable} | correct-in-choices=${correctPresent}${wrongTop ? ' *** WRONG TOP ***' : ''}`);
    }
  }
}
console.log('\n=== SUMMARY ===');
for (const r of rows) console.log(JSON.stringify(r));
