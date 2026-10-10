#!/usr/bin/env node
// Phase 2 spike, Step 1 — pull the FULL TCGdex catalog (one language) into our own JSON.
//
//   node scripts/build-catalog.mjs en
//   node scripts/build-catalog.mjs ja
//
// Output: data/catalog-<lang>.json  (gitignored) + stats printed at the end.
// Detail fetches are checkpointed to data/details-<lang>.jsonl so a rerun resumes
// where it left off instead of starting over.
import fs from 'node:fs';
import path from 'node:path';

const lang = process.argv[2];
if (!['en', 'ja'].includes(lang)) { console.error('usage: build-catalog.mjs en|ja'); process.exit(1); }
const BASE = `https://api.tcgdex.net/v2/${lang}`;
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

// ---------- pricing extraction (handles legacy `pricing` and `variants_detailed`) ----------
function extractPricing(detail) {
  let usd = null, usdVariant = null, eur = null;
  const p = detail.pricing;
  if (p?.tcgplayer) {
    for (const v of ['holofoil', 'normal', 'reverse-holofoil', '1st-edition-holofoil', '1st-edition']) {
      const mp = p.tcgplayer[v]?.marketPrice;
      if (typeof mp === 'number' && mp > 0) { usd = mp; usdVariant = v; break; }
    }
    // any other variant key as last resort
    if (usd === null) {
      for (const [v, o] of Object.entries(p.tcgplayer)) {
        if (o && typeof o.marketPrice === 'number' && o.marketPrice > 0) { usd = o.marketPrice; usdVariant = v; break; }
      }
    }
  }
  if (p?.cardmarket) {
    if (typeof p.cardmarket.trend === 'number') eur = p.cardmarket.trend;
    else if (typeof p.cardmarket.avg === 'number') eur = p.cardmarket.avg;
  }
  if ((usd === null || eur === null) && Array.isArray(detail.variants_detailed)) {
    for (const vd of detail.variants_detailed) {
      const tp = vd?.pricing?.tcgplayer, cm = vd?.pricing?.cardmarket;
      if (usd === null && tp) {
        for (const [v, o] of Object.entries(tp)) {
          if (o && typeof o.marketPrice === 'number' && o.marketPrice > 0) { usd = o.marketPrice; usdVariant = `${vd.type}:${v}`; break; }
        }
      }
      if (eur === null && cm && typeof cm.trend === 'number') eur = cm.trend;
      if (usd !== null && eur !== null) break;
    }
  }
  return { usd, usdVariant, eur };
}

const t0 = Date.now();

// ---------- sets + briefs ----------
console.log(`[${lang}] fetching set list…`);
const sets = await fetchJson(`${BASE}/sets`);
console.log(`[${lang}] ${sets.length} sets`);
const cards = []; // {id,name,setId,setName,localId,image}
let si = 0;
const failedSets = [];
async function pullSet(s) {
  try {
    const full = await fetchJson(`${BASE}/sets/${encodeURIComponent(s.id)}`);
    if (!full?.cards) { failedSets.push(s); return; }
    // Printed set total (the TTT in NNN/TTT) — the hybrid's number
    // cross-check requires total agreement before a pool member may
    // claim a full-number match (a same-localId card from another set
    // is a different card).
    const setTotal = full.cardCount?.official ?? full.cardCount?.total ?? null;
    for (const c of full.cards) {
      cards.push({
        id: c.id, name: c.name, setId: s.id, setName: full.name || s.name,
        localId: c.localId, image: c.image ? `${c.image}/low.png` : null,
        setTotal,
      });
    }
  } catch { failedSets.push(s); }
}
for (const s of sets) {
  await pullSet(s);
  si++;
  if (si % 40 === 0) console.log(`[${lang}] sets ${si}/${sets.length}, cards so far ${cards.length}`);
}
if (failedSets.length) {
  console.log(`[${lang}] retrying ${failedSets.length} failed sets…`);
  const retry = [...failedSets]; failedSets.length = 0;
  for (const s of retry) { await sleep(1000); await pullSet(s); }
  if (failedSets.length) console.log(`[${lang}] WARNING: ${failedSets.length} sets still failing: ${failedSets.map((s) => s.id).join(',')}`);
}
console.log(`[${lang}] briefs complete: ${cards.length} cards in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------- details (resumable) ----------
const detailsPath = path.join(DATA, `details-${lang}.jsonl`);
const done = new Map();
if (fs.existsSync(detailsPath)) {
  for (const line of fs.readFileSync(detailsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); done.set(o.id, o); } catch { /* partial line */ }
  }
}
console.log(`[${lang}] details already cached: ${done.size}/${cards.length}`);
const out = fs.createWriteStream(detailsPath, { flags: 'a' });
const queue = cards.filter((c) => !done.has(c.id));
let fetched = 0, failed = 0;
const CONC = 14;
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    try {
      const d = await fetchJson(`${BASE}/cards/${encodeURIComponent(c.id)}`);
      if (!d) { failed++; continue; }
      const rec = { id: c.id, rarity: d.rarity || null, ...extractPricing(d) };
      done.set(c.id, rec);
      out.write(JSON.stringify(rec) + '\n');
    } catch { failed++; }
    fetched++;
    if (fetched % 1000 === 0) console.log(`[${lang}] details ${done.size}/${cards.length} (failed ${failed}) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
out.end();
console.log(`[${lang}] details done: ${done.size}/${cards.length}, failed ${failed}`);

// ---------- assemble catalog ----------
const catalog = cards.map((c) => {
  const d = done.get(c.id) || {};
  return { ...c, rarity: d.rarity ?? null, usd: d.usd ?? null, eur: d.eur ?? null, usdVariant: d.usdVariant ?? null };
});
if (lang === 'en') {
  // Celebrations Classic Collection (cel25cc): TCGdex carries these 25
  // reprints with NO image and a localId (CC005) that is not the number
  // printed on the card (8/82). Re-apply the committed overrides so the
  // nightly rebuild keeps their art + printed-number aliases — without
  // this the rows revert to image-less and drop out of the picture index
  // on the next incremental embed pass. See docs/FIX-CHARIZARD-GYARADOS.md.
  try {
    const overrides = JSON.parse(fs.readFileSync(path.join(DATA, 'cc-overrides.json'), 'utf8'));
    let n = 0;
    for (const row of catalog) {
      const o = overrides[row.id];
      if (o) { row.image = o.image; row.printedNum = o.printedNum; row.printedTotal = o.printedTotal; n++; }
    }
    console.log(`[en] cc-overrides applied to ${n} rows`);
  } catch { console.log('[en] no cc-overrides.json — skipped'); }
}
const outPath = path.join(DATA, `catalog-${lang}.json`);
fs.writeFileSync(outPath, JSON.stringify(catalog));
const bytes = fs.statSync(outPath).size;
const withUsd = catalog.filter((c) => c.usd !== null).length;
const withEur = catalog.filter((c) => c.eur !== null).length;
const withImg = catalog.filter((c) => c.image).length;
const stats = {
  lang, cards: catalog.length, sets: sets.length,
  withImage: withImg, withUsd, withEur,
  pctUsd: +(100 * withUsd / catalog.length).toFixed(1),
  jsonMB: +(bytes / 1048576).toFixed(2),
  durationSec: +((Date.now() - t0) / 1000).toFixed(1),
};
fs.writeFileSync(path.join(DATA, `catalog-stats-${lang}.json`), JSON.stringify(stats, null, 2));
console.log(`[${lang}] STATS`, JSON.stringify(stats));
