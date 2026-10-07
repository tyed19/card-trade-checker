// Server-side access to the committed catalogs (data/catalog-en.json,
// data/catalog-ja.json) for the Phase 3 features: binder card
// resolution, set listings, and the public Gift Radar page.
//
// Deliberately separate from lib/pictmatch.js: that module also loads
// the CLIP model and the embedding index. This one reads only the two
// catalog JSONs (~8MB), cached in module scope after first use.
//
// REF SYSTEM: a card ref is "e<rowIndex>" (English catalog) or
// "j<rowIndex>" (Japanese catalog) — the row's position in the
// committed catalog array. Compact enough for share links (<=6 chars).
// Binders also store the catalog `id` next to the ref; resolvePairs()
// verifies id-vs-row and repairs the ref if a nightly catalog rebuild
// ever shifts row order.

import fs from 'node:fs';
import path from 'node:path';

const seg = (...parts) => [process.cwd(), ...parts].join(path.sep);
const DATA_DIR = seg('data');

let cache = null;

function load() {
  if (cache) return cache;
  const langs = {};
  const byId = new Map(); // "lang:id" -> { entry, ref }
  const bySet = new Map(); // "lang:setId" -> { lang, setId, setName, setTotal, refs: [] }
  for (const [lang, ch] of [['en', 'e'], ['ja', 'j']]) {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `catalog-${lang}.json`), 'utf8'));
    langs[lang] = rows;
    rows.forEach((entry, i) => {
      const ref = ch + i;
      byId.set(`${lang}:${entry.id}`, { entry, ref });
      const sk = `${lang}:${entry.setId}`;
      if (!bySet.has(sk)) {
        bySet.set(sk, {
          lang, setId: entry.setId, setName: entry.setName || entry.setId,
          setTotal: entry.setTotal ?? null, refs: [],
        });
      }
      bySet.get(sk).refs.push(ref);
    });
  }
  cache = { langs, byId, bySet };
  return cache;
}

export function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  const m = ref.match(/^([ej])(\d+)$/);
  if (!m) return null;
  return { lang: m[1] === 'e' ? 'en' : 'ja', idx: parseInt(m[2], 10), ref };
}

export function entryByRef(ref) {
  const p = parseRef(ref);
  if (!p) return null;
  const { langs } = load();
  const entry = langs[p.lang][p.idx];
  if (!entry) return null;
  return { ...entry, lang: p.lang };
}

export function refForId(lang, id) {
  const { byId } = load();
  const hit = byId.get(`${lang}:${id}`);
  return hit ? hit.ref : null;
}

// ---------- EUR -> USD (mirrors lib/pictmatch.js) ----------
// JA catalog prices are Cardmarket EUR; converted at the ECB daily
// rate, cached 24h in module scope, hard fallback 1.08.
let rateCache = { rate: 1.08, at: 0 };
export async function eurUsdRate() {
  const now = Date.now();
  if (rateCache.at && now - rateCache.at < 24 * 3600 * 1000) return rateCache.rate;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('ECB HTTP ' + res.status);
    const xml = await res.text();
    const m = xml.match(/currency="USD"\s+rate="([\d.]+)"/);
    if (!m) throw new Error('ECB rate not found');
    rateCache = { rate: parseFloat(m[1]), at: now };
  } catch {
    rateCache = { rate: rateCache.rate || 1.08, at: now - 23 * 3600 * 1000 };
  }
  return rateCache.rate;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Client-ready card object for a catalog entry — same price semantics
// as candidateFromCatalog (lib/pictmatch.js): `price` is always USD.
export async function cardObject(entry, ref) {
  if (!entry) return null;
  const base = entry.image ? entry.image.replace(/\/low\.png$/, '') : null;
  let price = null, priceUSD = null, priceEUR = null, currency = 'USD';
  if (entry.lang === 'ja') {
    currency = 'EUR';
    priceEUR = typeof entry.eur === 'number' ? entry.eur : null;
    if (priceEUR !== null) priceUSD = round2(priceEUR * (await eurUsdRate()));
    price = priceUSD;
  } else {
    priceUSD = typeof entry.usd === 'number' ? entry.usd : null;
    priceEUR = typeof entry.eur === 'number' ? entry.eur : null;
    price = priceUSD;
  }
  return {
    ref, id: entry.id, lang: entry.lang,
    name: entry.name,
    set: entry.setName || '', setId: entry.setId || '',
    setTotal: entry.setTotal ?? null,
    number: String(entry.localId ?? ''),
    rarity: entry.rarity || '',
    price, priceUSD, priceEUR, currency,
    image: base ? `${base}/high.png` : null,
    thumb: entry.image || null,
  };
}

export async function resolveRef(ref) {
  const entry = entryByRef(ref);
  if (!entry) return null;
  return cardObject(entry, ref);
}

// Resolve binder-style {ref, id} pairs. If the row at `ref` no longer
// carries `id` (catalog rows shifted), repair via the id index and
// report the corrected ref so the client can heal its stored state.
export async function resolvePairs(pairs) {
  const out = [];
  for (const p of pairs || []) {
    if (!p || !p.ref) continue;
    let entry = entryByRef(p.ref);
    let ref = p.ref;
    if (entry && p.id && entry.id !== p.id) {
      const fixed = refForId(entry.lang, p.id);
      if (fixed) {
        ref = fixed;
        entry = entryByRef(fixed);
      }
    }
    if (!entry) { out.push({ ref: p.ref, id: p.id || null, missing: true }); continue; }
    const card = await cardObject(entry, ref);
    out.push({ ...card, requestedRef: p.ref, repaired: ref !== p.ref });
  }
  return out;
}

export async function resolveIds(ids) {
  // ids: [{lang, id}] — lang defaults to 'en'; 'en-proxy' counts as en.
  const out = [];
  for (const it of ids || []) {
    if (!it || !it.id) continue;
    let lang = it.lang && String(it.lang).startsWith('ja') ? 'ja' : 'en';
    let ref = refForId(lang, it.id);
    if (!ref && lang === 'en') ref = refForId('ja', it.id);
    if (!ref) { out.push({ id: it.id, missing: true }); continue; }
    const entry = entryByRef(ref);
    out.push(await cardObject(entry, ref));
  }
  return out;
}

// Full set listing (for set pages + gift radar): every card of the set
// in printed-number order, as card objects.
export async function setCards(lang, setId) {
  const { bySet, langs } = load();
  const meta = bySet.get(`${lang}:${setId}`);
  if (!meta) return null;
  const rows = meta.refs.map((ref) => {
    const p = parseRef(ref);
    return { ref, entry: { ...langs[p.lang][p.idx], lang: p.lang } };
  });
  rows.sort((a, b) => {
    const na = parseInt(a.entry.localId, 10), nb = parseInt(b.entry.localId, 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.entry.localId).localeCompare(String(b.entry.localId), undefined, { numeric: true });
  });
  const cards = [];
  for (const r of rows) cards.push(await cardObject(r.entry, r.ref));
  return {
    set: { lang, setId: meta.setId, name: meta.setName, total: meta.setTotal, count: cards.length },
    cards,
  };
}

export function catalogStats() {
  const { langs } = load();
  return { en: langs.en.length, ja: langs.ja.length };
}
