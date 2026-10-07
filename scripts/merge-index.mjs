#!/usr/bin/env node
// Merge several embedding index parts into one index.
//
//   node scripts/merge-index.mjs --out full --from full0,full1
//   node scripts/merge-index.mjs --out full --from full,incr     (incremental extend)
//
// Reads data/index-<name>.{bin,json,scales.json} per part, concatenates in
// the given order, de-dupes by lang:id (first part wins), and writes
// data/index-<out>.{bin,json,scales.json} (via temp files + rename, so an
// input may share the output's name).
import fs from 'node:fs';
import path from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
const outName = args.out || 'full';
const parts = (args.from || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!parts.length) { console.error('usage: merge-index.mjs --out <name> --from a,b,...'); process.exit(1); }
const DATA = path.resolve('data');

const seen = new Set();
const ids = [];
const scales = [];
const bins = [];
let dims = null, model = null, totalIn = 0;
for (const name of parts) {
  const meta = JSON.parse(fs.readFileSync(path.join(DATA, `index-${name}.json`), 'utf8'));
  const sc = JSON.parse(fs.readFileSync(path.join(DATA, `index-${name}.scales.json`), 'utf8'));
  const bin = fs.readFileSync(path.join(DATA, `index-${name}.bin`));
  if (dims === null) { dims = meta.dims; model = meta.model; }
  if (meta.dims !== dims) { console.error(`dims mismatch in ${name}: ${meta.dims} vs ${dims}`); process.exit(1); }
  if (bin.length !== meta.count * dims) { console.error(`bin size mismatch in ${name}: ${bin.length} != ${meta.count} x ${dims}`); process.exit(1); }
  if (sc.length !== meta.count) { console.error(`scales mismatch in ${name}`); process.exit(1); }
  let kept = 0;
  for (let i = 0; i < meta.count; i++) {
    const e = meta.ids[i];
    const key = `${e.lang}:${e.id}`;
    totalIn++;
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(e);
    scales.push(sc[i]);
    bins.push(bin.subarray(i * dims, (i + 1) * dims));
    kept++;
  }
  console.log(`part ${name}: ${meta.count} vectors, kept ${kept}`);
}
const binOut = Buffer.concat(bins);
fs.writeFileSync(path.join(DATA, `index-${outName}.bin.tmp`), binOut);
fs.writeFileSync(path.join(DATA, `index-${outName}.json.tmp`), JSON.stringify({ model, dims, count: ids.length, ids, mergedFrom: parts, mergedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(DATA, `index-${outName}.scales.json.tmp`), JSON.stringify(scales));
for (const ext of ['bin', 'json', 'scales.json']) {
  fs.renameSync(path.join(DATA, `index-${outName}.${ext}.tmp`), path.join(DATA, `index-${outName}.${ext}`));
}
console.log(`MERGED -> index-${outName}: ${ids.length} vectors (from ${totalIn}), binMB=${(binOut.length / 1048576).toFixed(2)}`);
