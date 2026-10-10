// Apply data/cc-overrides.json to the committed data artifacts:
//   1. catalog-en.json — cel25cc rows gain image + printedNum/printedTotal.
//   2. index-full — the 25 reprint images are embedded with the committed
//      CLIP model and APPENDED (ids not already indexed), so the picture
//      pool can finally contain the Classic Collection prints.
// Idempotent: rows already carrying the override values and ids already
// in the index are skipped. Nightly refreshes re-apply the catalog side
// via scripts/build-catalog.mjs; the embed side persists because the
// refresh embeds incrementally with --seed-from full.
//   node scripts/apply-cc-overrides.mjs
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'data');
const overrides = JSON.parse(fs.readFileSync(path.join(DATA, 'cc-overrides.json'), 'utf8'));

// ---------- 1. catalog ----------
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog-en.json'), 'utf8'));
let patched = 0;
for (const row of catalog) {
  const o = overrides[row.id];
  if (!o) continue;
  row.image = o.image;
  row.printedNum = o.printedNum;
  row.printedTotal = o.printedTotal;
  patched++;
}
fs.writeFileSync(path.join(DATA, 'catalog-en.json'), JSON.stringify(catalog));
console.log(`catalog rows patched: ${patched}`);

// ---------- 2. index append ----------
const metaPath = path.join(DATA, 'index-full.json');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const scalesPath = path.join(DATA, 'index-full.scales.json');
const scales = JSON.parse(fs.readFileSync(scalesPath, 'utf8'));
const have = new Set(meta.ids.map((e) => e.id));
const todo = Object.keys(overrides).filter((id) => !have.has(id));
console.log(`index: ${meta.count} vectors, appending ${todo.length}`);
if (todo.length) {
  const tf = await import('@xenova/transformers');
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = path.join(process.cwd(), 'models');
  const processor = await tf.AutoProcessor.from_pretrained('Xenova/clip-vit-base-patch32');
  const vision = await tf.CLIPVisionModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32', { quantized: true });
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const chunks = [];
  for (const id of todo) {
    const o = overrides[id];
    const res = await fetch(o.image);
    if (!res.ok) { console.log(`IMAGE FAIL ${id} ${o.image} -> ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await tf.RawImage.fromBlob(new Blob([buf]));
    const inputs = await processor(img);
    const out = await vision(inputs);
    const v = Float32Array.from(out.image_embeds.data);
    let norm = 0; for (const x of v) norm += x * x; norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    let max = 0; for (const x of v) max = Math.max(max, Math.abs(x));
    const scale = max / 127 || 1;
    const q = new Int8Array(v.length);
    for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / scale);
    chunks.push(Buffer.from(q.buffer, q.byteOffset, q.byteLength));
    scales.push(scale);
    const row = byId.get(id);
    meta.ids.push({ lang: 'en', id, name: row.name, setId: row.setId, setName: row.setName, localId: row.localId });
    console.log(`embedded ${id} (${row.name})`);
  }
  if (chunks.length) {
    fs.appendFileSync(path.join(DATA, 'index-full.bin'), Buffer.concat(chunks));
    meta.count = meta.ids.length;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    fs.writeFileSync(scalesPath, JSON.stringify(scales));
  }
}
console.log(`index now: ${meta.count} vectors, ${scales.length} scales`);
