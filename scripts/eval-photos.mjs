#!/usr/bin/env node
// Phase 2 spike, Step 3 — accuracy eval: embed the 8 real user photos, rank against the index.
//
//   node scripts/eval-photos.mjs main
//
// Uses the app's own lib/locate.js to crop each photo exactly like production does
// (crop when a box is found and mode !== 'frame', else the full photo), then reports
// top-5 by cosine similarity + the rank/similarity of the CORRECT print, plus timing.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { locateCard } from '../lib/locate.js';

const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await import('@xenova/transformers');

const outName = process.argv[2] || 'main';
const DATA = path.resolve('data');
const M = process.env.HOME + '/workspace/user/media_library/image';

// ---------- load index ----------
const meta = JSON.parse(fs.readFileSync(path.join(DATA, `index-${outName}.json`), 'utf8'));
const scales = JSON.parse(fs.readFileSync(path.join(DATA, `index-${outName}.scales.json`), 'utf8'));
const bin = fs.readFileSync(path.join(DATA, `index-${outName}.bin`));
const { dims, count } = meta;
const mat = new Float32Array(count * dims);
for (let i = 0; i < count; i++) {
  const s = scales[i], off = i * dims;
  for (let j = 0; j < dims; j++) mat[off + j] = (bin.readInt8(off + j)) * s;
}
console.log(`index: ${count} vectors x ${dims} dims`);

// catalogs (for resolving correct prints)
const catEn = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog-en.json'), 'utf8'));
const catJa = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog-ja.json'), 'utf8'));
const strip0 = (s) => String(s).replace(/^0+/, '') || '0';
function findCard(cat, pred) { return cat.find(pred); }

// ---------- model ----------
const tLoad0 = Date.now();
const processor = await AutoProcessor.from_pretrained(meta.model);
const vision = await CLIPVisionModelWithProjection.from_pretrained(meta.model, { quantized: true });
const coldLoadMs = Date.now() - tLoad0;

async function embedBuffer(buf) {
  const img = await RawImage.fromBlob(new Blob([buf]));
  const inputs = await processor(img);
  const out = await vision(inputs);
  const v = Float32Array.from(out.image_embeds.data);
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function rankAll(q) {
  const t0 = Date.now();
  const sims = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let s = 0; const off = i * dims;
    for (let j = 0; j < dims; j++) s += q[j] * mat[off + j];
    sims[i] = s;
  }
  const scanMs = Date.now() - t0;
  const order = [...sims.keys()].sort((a, b) => sims[b] - sims[a]);
  return { sims, order, scanMs };
}

// ---------- photo prep (mirrors production) ----------
async function prepPhoto(file) {
  let buf = fs.readFileSync(file);
  buf = await sharp(buf).rotate().toBuffer(); // EXIF orientation, as production does
  const m = await sharp(buf).metadata();
  const loc = await locateCard(buf, m).catch(() => null);
  if (loc?.box && loc.mode !== 'frame') {
    const crop = await sharp(buf).extract({
      left: Math.max(0, Math.round(loc.box.l * m.width)),
      top: Math.max(0, Math.round(loc.box.t * m.height)),
      width: Math.min(m.width, Math.round(loc.box.w * m.width)),
      height: Math.min(m.height, Math.round(loc.box.h * m.height)),
    }).toBuffer();
    return { buf: crop, used: `located crop (mode=${loc.mode}, conf=${loc.confidence?.toFixed?.(2)}, box l${loc.box.l.toFixed(2)} t${loc.box.t.toFixed(2)} w${loc.box.w.toFixed(2)} h${loc.box.h.toFixed(2)})` };
  }
  return { buf, used: `full photo (locate mode=${loc?.mode ?? 'error'})` };
}

const TESTS = [
  { name: 'Victini', file: `${M}/67/67c1a18b2fd2f14f8af2b9448bbbbcdf9bda5efe40b75da07648f31e4d6e073a.jpg`,
    correct: () => findCard(catEn, (c) => c.setName === 'Evolving Skies' && strip0(c.localId) === '20' && c.name === 'Victini') },
  { name: 'Dialga ex (SVP promo)', file: `${M}/71/715aa8c78b4e62130cff4afeecabb8f4eb9c1c37fd4eebfa42fc95983b59461c.jpg`,
    correct: () => findCard(catEn, (c) => c.setId === 'svp' && strip0(c.localId) === '180') },
  { name: 'Meowth', file: `${M}/f2/f25135ea86483913d950ab86388bd6e18b05653204063bb1b910342e3ddd0b97.jpg`,
    correct: () => findCard(catEn, (c) => c.setName === 'Phantasmal Flames' && strip0(c.localId) === '106') },
  { name: 'Flapple VMAX', file: `${M}/0f/0f616951db4912e14021ba7da3cc194275bbe4edfa4dbd2019b088059eb3c4e4.jpg`,
    correct: () => findCard(catEn, (c) => c.setName === 'Battle Styles' && strip0(c.localId) === '19') },
  { name: 'Mega Abomasnow ex', file: `${M}/67/67c66b812a806ef2c815b0dbc8e3fcd23726a0ef910ee12bbc22d3cbd25a5279.jpg`,
    correct: () => findCard(catEn, (c) => c.name === 'Mega Abomasnow ex' && strip0(c.localId) === '157') },
  { name: 'Galvantula ex (screenshot crop)', file: path.join(DATA, 'galvantula-crop.jpg'),
    correct: () => findCard(catEn, (c) => c.setName === 'Stellar Crown' && strip0(c.localId) === '51') },
  { name: 'Tyranitar ex', file: `${M}/4d/4d45f593e06c7dd9a1bcc9747203d895603d15339d3a0b8d0e7553c9a5ef0d24.jpg`,
    correct: () => findCard(catEn, (c) => c.setName === 'Prismatic Evolutions' && strip0(c.localId) === '64') },
  { name: 'Dragonite VSTAR (JP)', file: `${M}/cc/ccd9fea931fa5736830effbe3f81551cf8c952728f165ea976697257d223fcc7.jpg`,
    correct: () => findCard(catJa, (c) => c.setId === 'S10b' && strip0(c.localId) === '50'),
    twin: () => findCard(catEn, (c) => c.setName === 'Pokémon GO' && strip0(c.localId) === '50'),
    reportBestJa: true },
];

const keyOf = (lang, id) => `${lang}:${id}`;
const indexPos = new Map(meta.ids.map((e, i) => [keyOf(e.lang, e.id), i]));

console.log(`model cold load: ${coldLoadMs}ms`);
const results = [];
let firstPhoto = true;
for (const t of TESTS) {
  const { buf, used } = await prepPhoto(t.file);
  const ti = Date.now();
  const q = await embedBuffer(buf);
  const inferMs = Date.now() - ti;
  const { sims, order, scanMs } = rankAll(q);
  const fmt = (i) => { const e = meta.ids[i]; return `${e.name} (${e.setName} #${e.localId}, ${e.lang}) sim=${sims[i].toFixed(4)}`; };
  const top5 = order.slice(0, 5).map(fmt);
  const corr = t.correct();
  let corrInfo = 'correct print NOT FOUND in catalog';
  if (corr) {
    const pos = indexPos.get(keyOf(corr.lang || (t.name.includes('(JP)') ? 'ja' : 'en'), corr.id));
    // catalog entries carry no lang; derive: search ids by id+lang from meta
    corrInfo = pos === undefined ? `correct print ${corr.id} NOT IN INDEX` : `rank ${order.indexOf(pos) + 1}, sim=${sims[pos].toFixed(4)}`;
    if (pos !== undefined) corrInfo += ` [${corr.name} / ${corr.setName} #${corr.localId} / ${corr.id}]`;
  }
  let twinInfo = null;
  if (t.twin) {
    const tw = t.twin();
    if (tw) {
      const pos = indexPos.get(keyOf('en', tw.id));
      twinInfo = pos === undefined ? `EN twin ${tw.id} NOT IN INDEX` : `EN twin rank ${order.indexOf(pos) + 1}, sim=${sims[pos].toFixed(4)}`;
    }
  }
  let bestJaInfo = null;
  if (t.reportBestJa) {
    const jaPos = order.find((i) => meta.ids[i].lang === 'ja');
    bestJaInfo = jaPos === undefined ? 'no JA entries in index' : `best JA entry: rank ${order.indexOf(jaPos) + 1} — ${fmt(jaPos)}`;
  }
  console.log(`\n### ${t.name}${firstPhoto ? ' (first photo — includes warm-up)' : ''}`);
  console.log(`prep: ${used}; infer: ${inferMs}ms; full-index scan: ${scanMs}ms`);
  console.log('top5:'); top5.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(`correct: ${corrInfo}`);
  if (twinInfo) console.log(`twin: ${twinInfo}`);
  if (bestJaInfo) console.log(`bestJa: ${bestJaInfo}`);
  results.push({ name: t.name, used, inferMs, scanMs, top5, corrInfo, twinInfo, bestJaInfo });
  firstPhoto = false;
}
fs.writeFileSync(path.join(DATA, 'eval-results.json'), JSON.stringify({ coldLoadMs, results }, null, 2));
console.log('\nwrote data/eval-results.json');
