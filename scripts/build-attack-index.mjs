#!/usr/bin/env node
// Build the LOCAL attack/ability-title + HP index the rescue channel
// searches instead of the flaky pokemontcg.io attack API.
//
//   node scripts/build-attack-index.mjs
//
// Input:  data/catalog-en.json (card ids)
// Cache:  data/attack-details-en.jsonl (resumable: {id, titles, hp})
// Output: data/attacks-en.json — compact {id: {t: [titles], hp?}}
//   Titles = abilities[].name + attacks[].name (deduped, original
//   case). Rows with neither titles nor HP are omitted.
//
// Why a separate file (not catalog columns): the picture index embeds
// from the catalog and pictmatch loads both catalogs fully into
// memory on the picture path; the attack index is only needed by the
// OCR rescue path, so it loads lazily there instead of taxing every
// picture match. The nightly refresh workflow runs this script right
// after the catalog rebuild, so new cards flow in incrementally via
// the cache (only uncached ids are fetched).
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.tcgdex.net/v2/en';
const DATA = path.resolve('data');
fs.mkdirSync(DATA, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(to);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(Math.min(15000, 800 * 2 ** i));
    }
  }
}

const t0 = Date.now();
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog-en.json'), 'utf8'));

// Assemble + atomically write the runtime file from the cache. Called
// incrementally during the fetch (so a partial run still leaves a
// usable index — missing cards simply fall back to the API rescue)
// and once at the end for the final file.
function writeIndexFile() {
  const index = {};
  for (const id of ids) {
    const d = done.get(id);
    if (!d) continue;
    if (!d.titles.length && (d.hp === null || d.hp === undefined)) continue;
    const row = { t: d.titles };
    if (d.hp !== null && d.hp !== undefined) row.hp = d.hp;
    index[id] = row;
  }
  const outPath = path.join(DATA, 'attacks-en.json');
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(index));
  fs.renameSync(tmpPath, outPath);
  return index;
}
const ids = catalog.map((c) => c.id);
console.log(`[attack-index] catalog ids: ${ids.length}`);

const cachePath = path.join(DATA, 'attack-details-en.jsonl');
const done = new Map();
if (fs.existsSync(cachePath)) {
  for (const line of fs.readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.id) done.set(o.id, o); } catch { /* partial line */ }
  }
}
console.log(`[attack-index] cached: ${done.size}/${ids.length}`);
const out = fs.createWriteStream(cachePath, { flags: 'a' });
// Priority first: ATTACK_PRIORITY="svp-074,xy12-11,..." fetches the
// verification set before the bulk, so a partial run still yields a
// usable index for the cards under active test. Uncached priority ids
// jump the queue; everything else keeps catalog order.
const priority = (process.env.ATTACK_PRIORITY || '').split(',').map((s) => s.trim()).filter(Boolean);
const rest = ids.filter((id) => !done.has(id));
const queue = [
  ...priority.filter((id) => ids.includes(id) && !done.has(id)),
  ...rest.filter((id) => !priority.includes(id)),
];
let fetched = 0, failed = 0;
const CONC = 14;
async function worker() {
  while (queue.length) {
    const id = queue.shift();
    try {
      const d = await fetchJson(`${BASE}/cards/${encodeURIComponent(id)}`);
      if (!d) { failed++; continue; }
      const titles = [];
      for (const a of [...(d.abilities || []), ...(d.attacks || [])]) {
        if (a && a.name && !titles.includes(a.name)) titles.push(a.name);
      }
      const hp = typeof d.hp === 'number' ? d.hp : null;
      const rec = { id, titles, hp };
      done.set(id, rec);
      out.write(JSON.stringify(rec) + '\n');
    } catch { failed++; }
    fetched++;
    if (fetched % 500 === 0) {
      const idx = writeIndexFile();
      console.log(`[attack-index] ${done.size}/${ids.length} (failed ${failed}, indexed ${Object.keys(idx).length}) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
out.end();
console.log(`[attack-index] details done: ${done.size}/${ids.length}, failed ${failed}`);

// Assemble the compact runtime file (final).
const index = writeIndexFile();
let withTitles = 0, withHp = 0;
for (const id of ids) {
  const d = done.get(id);
  if (!d) continue;
  if (d.titles.length) withTitles++;
  if (d.hp !== null && d.hp !== undefined) withHp++;
}
const bytes = fs.statSync(path.join(DATA, 'attacks-en.json')).size;
console.log(`[attack-index] STATS`, JSON.stringify({
  cards: ids.length, indexed: Object.keys(index).length,
  withTitles, withHp, jsonMB: +(bytes / 1048576).toFixed(2),
  durationSec: +((Date.now() - t0) / 1000).toFixed(1),
}));
