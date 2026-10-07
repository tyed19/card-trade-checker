#!/usr/bin/env node
// Phase 2 spike, Step 2 — build a CLIP image-embedding index over catalog cards.
//
//   node scripts/embed-index.mjs --catalogs en,ja --setnames "Battle Styles,..." --setids s10b --random 3000 --out main
//
// - Downloads each card's low-res official art (cached under data/imgcache/<lang>/).
// - Embeds with the CLIP vision encoder (@xenova/transformers), L2-normalizes,
//   quantizes each vector to int8 with a per-vector scale.
// - Resumable: progress kept in data/index-<out>.progress.json; rerun to continue.
// Outputs: data/index-<out>.bin (int8 vectors) + data/index-<out>.json (ids/scales/meta).
import fs from 'node:fs';
import path from 'node:path';

const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await import('@xenova/transformers');
// model files cache under node_modules/@xenova/transformers/.cache (default) — 85MB quantized vision model

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const langs = (args.catalogs || 'en').split(',');
const setNames = (args.setnames || '').split(',').map((s) => s.trim()).filter(Boolean);
const setIds = (args.setids || '').split(',').map((s) => s.trim()).filter(Boolean);
const randomSpec = (args.random || '0').split(',');
const randomFor = (li) => parseInt(randomSpec[Math.min(li, randomSpec.length - 1)] || '0', 10);
const outName = args.out || 'main';
const MODEL = args.model || 'Xenova/clip-vit-base-patch32';

const DATA = path.resolve('data');
// deterministic PRNG for the distractor sample
let seed = 1234567;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ---------- select cards ----------
let pool = [];
for (const lang of langs) {
  const cat = JSON.parse(fs.readFileSync(path.join(DATA, `catalog-${lang}.json`), 'utf8'));
  const inSets = cat.filter((c) => setIds.includes(c.setId) || setNames.some((n) => (c.setName || '').toLowerCase() === n.toLowerCase()));
  const rest = cat.filter((c) => !inSets.includes(c) && c.image);
  const shuffled = [...rest].sort(() => rnd() - 0.5);
  const randomN = randomFor(langs.indexOf(lang));
  const distractors = shuffled.slice(0, randomN); // per-language distractor count
  const picked = [...inSets.filter((c) => c.image), ...distractors];
  console.log(`[${lang}] in-set cards: ${inSets.length}, distractors picked: ${distractors.length}`);
  pool.push(...picked.map((c) => ({ ...c, lang })));
}
// de-dup by lang+id
pool = [...new Map(pool.map((c) => [`${c.lang}:${c.id}`, c])).values()];
console.log(`pool total: ${pool.length}`);

// ---------- resume state ----------
const progPath = path.join(DATA, `index-${outName}.progress.json`);
let doneIds = [];
if (fs.existsSync(progPath)) doneIds = JSON.parse(fs.readFileSync(progPath, 'utf8'));
const doneSet = new Set(doneIds);
const todo = pool.filter((c) => !doneSet.has(`${c.lang}:${c.id}`));
console.log(`already embedded: ${doneSet.size}, todo: ${todo.length}`);

// ---------- model ----------
const tLoad = Date.now();
const processor = await AutoProcessor.from_pretrained(MODEL);
const vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { quantized: true });
console.log(`model loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s`);

// ---------- storage ----------
const binPath = path.join(DATA, `index-${outName}.bin`);
const binFd = fs.openSync(binPath, 'a');
const scalesPath = path.join(DATA, `index-${outName}.scales.json`);
let scales = fs.existsSync(scalesPath) ? JSON.parse(fs.readFileSync(scalesPath, 'utf8')) : [];
let dims = null;

async function fetchImage(c) {
  const dir = path.join(DATA, 'imgcache', c.lang);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${c.id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.png`);
  if (fs.existsSync(fp)) return fs.readFileSync(fp);
  const res = await fetch(c.image);
  if (!res.ok) throw new Error(`img HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(fp, buf);
  return buf;
}

async function embedBuffer(buf) {
  const img = await RawImage.fromBlob(new Blob([buf]));
  const inputs = await processor(img);
  const out = await vision(inputs);
  const emb = out.image_embeds; // [1, dims]
  const v = Float32Array.from(emb.data);
  let norm = 0; for (const x of v) norm += x * x; norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function quantize(v) {
  let max = 0; for (const x of v) max = Math.max(max, Math.abs(x));
  const scale = max / 127 || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / scale);
  return { q, scale };
}

const t0 = Date.now();
let n = 0, fail = 0, inferMs = [];
// simple prefetch: keep up to 6 image downloads in flight ahead of inference
const PREFETCH = 6;
const inflight = new Map();
function prefetch(c) {
  if (!inflight.has(c.id)) inflight.set(c.id, fetchImage(c).catch((e) => e));
}
for (let i = 0; i < Math.min(PREFETCH, todo.length); i++) prefetch(todo[i]);

for (const c of todo) {
  prefetch(todo[Math.min(todo.length - 1, todo.indexOf(c) + PREFETCH)]);
  try {
    const buf = await inflight.get(c.id);
    inflight.delete(c.id);
    if (buf instanceof Error) throw buf;
    const ti = Date.now();
    const v = await embedBuffer(buf);
    inferMs.push(Date.now() - ti);
    if (!dims) dims = v.length;
    const { q, scale } = quantize(v);
    fs.writeSync(binFd, Buffer.from(q.buffer, q.byteOffset, q.byteLength));
    scales.push(scale);
    doneIds.push(`${c.lang}:${c.id}`);
    n++;
    if (n % 200 === 0) {
      fs.writeFileSync(progPath, JSON.stringify(doneIds));
      fs.writeFileSync(scalesPath, JSON.stringify(scales));
      const avg = inferMs.reduce((a, b) => a + b, 0) / inferMs.length;
      console.log(`embedded ${doneIds.length}/${pool.length} (avg infer ${avg.toFixed(0)}ms, ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
    }
  } catch (e) {
    fail++;
    if (fail <= 5) console.log(`FAIL ${c.lang}:${c.id}: ${e.message}`);
  }
}
fs.writeFileSync(progPath, JSON.stringify(doneIds));
fs.writeFileSync(scalesPath, JSON.stringify(scales));
fs.closeSync(binFd);

// ids in the exact order vectors were appended across ALL runs: doneIds order == append order
const byKey = new Map(pool.map((c) => [`${c.lang}:${c.id}`, c]));
const meta = {
  model: MODEL, dims, count: doneIds.length, failed: fail,
  ids: doneIds.map((k) => { const c = byKey.get(k); return c ? { lang: c.lang, id: c.id, name: c.name, setId: c.setId, setName: c.setName, localId: c.localId } : { id: k }; }),
  buildSec: +((Date.now() - t0) / 1000).toFixed(1),
};
fs.writeFileSync(path.join(DATA, `index-${outName}.json`), JSON.stringify(meta));
const binBytes = fs.statSync(binPath).size;
const avg = inferMs.length ? inferMs.reduce((a, b) => a + b, 0) / inferMs.length : 0;
console.log(`DONE vectors=${doneIds.length} dims=${dims} binMB=${(binBytes / 1048576).toFixed(2)} avgInferMs=${avg.toFixed(0)} failed=${fail}`);
