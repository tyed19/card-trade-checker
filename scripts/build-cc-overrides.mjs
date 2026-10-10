// Derive data/cc-overrides.json for the Celebrations Classic Collection
// (cel25cc-CC001..CC025). TCGdex carries these 25 cards with NO image and
// a localId (CC005) that does not match the number printed on the physical
// card (8/82 — the original Team Rocket printing's number, stamp and all).
// pokemontcg.io carries the reprints as cel25c-<printedNum>_A with art and
// prices, so for each catalog row we record:
//   image       — the reprint's art (pokemontcg _hires URL)
//   printedNum  — the number printed on the physical card
//   printedTotal— the original set's total (from the vintage catalog twin)
// lib/hybrid.js matchKind matches OCR number reads against printedNum /
// printedTotal when present; candidateFromCatalog uses the image as-is.
// Run once (and again if the set is ever re-derived):
//   node scripts/build-cc-overrides.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pokemontcgSearch } from '../lib/cardbook.js';

const DATA = path.join(process.cwd(), 'data');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog-en.json'), 'utf8'));
const ccRows = catalog.filter((c) => c.setId === 'cel25cc');
console.log(`cel25cc rows: ${ccRows.length}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overrides = {};
for (const row of ccRows) {
  let hit = null;
  for (let attempt = 0; attempt < 3 && !hit; attempt++) {
    try {
      const res = await pokemontcgSearch(row.name, '');
      hit = (res || []).find((c) => /Classic Collection/i.test(c.set || '')) || null;
    } catch { /* retry */ }
    if (!hit) await sleep(1200);
  }
  if (!hit) { console.log(`MISS ${row.id} ${row.name}`); continue; }
  const printedNum = String(hit.number);
  // Vintage twin: same name + same printed number in an older set. The
  // famous original is the priciest twin (reprints of it exist in many
  // sets, but only the original printing carries the original total).
  const twins = catalog.filter((c) => c.id !== row.id && c.setId !== 'cel25cc'
    && c.name === row.name && String(c.localId) === printedNum && c.setTotal && c.setTotal !== 25);
  twins.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const twin = twins[0] || null;
  const image = String(hit.image || '').startsWith('http') ? hit.image : `https://${String(hit.image || '').replace(/^\/+/, '')}`;
  overrides[row.id] = {
    image,
    printedNum,
    printedTotal: twin ? twin.setTotal : null,
  };
  console.log(`${row.id} ${row.name} -> printed ${printedNum}/${twin ? twin.setTotal : '?'} (twin ${twin ? twin.id : 'NONE'}, ptcg ${hit.id}, $${hit.price})`);
  await sleep(400);
}
fs.writeFileSync(path.join(DATA, 'cc-overrides.json'), JSON.stringify(overrides, null, 2));
console.log(`wrote ${Object.keys(overrides).length} overrides`);
