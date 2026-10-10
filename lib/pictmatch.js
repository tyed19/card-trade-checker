// Picture-matching: CLIP-embed the photo's card and rank it against our
// OWN catalog index (data/index-full.*), built nightly from TCGdex.
// This is the Phase 2 primary identifier; OCR (lib/ocr.js) confirms and
// rescues — see lib/hybrid.js for the zone policy and docs/PHASE2-BUILD.md
// for the calibration evidence.
//
// Everything loads lazily on first use and is cached in module scope:
// the int8 index (dequantized once to float32, ~53MB), the EN+JA
// catalogs, and the quantized CLIP vision model (~85MB on disk, loaded
// from the committed models/ dir — never downloaded at runtime).

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { locateCard } from './locate.js';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const INDEX_NAME = process.env.PICT_INDEX || 'full';
// Built via array joins on purpose: a literal path.join(process.cwd(),
// 'data') makes Turbopack try to ingest the whole project root as a
// context module (the ocr.js tessPaths lesson).
const seg = (...parts) => [process.cwd(), ...parts].join(path.sep);
const DATA_DIR = seg('data');
const MODELS_DIR = seg('models');

let statePromise = null;

function loadDataFiles() {
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `index-${INDEX_NAME}.json`), 'utf8'));
  const scales = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `index-${INDEX_NAME}.scales.json`), 'utf8'));
  const bin = fs.readFileSync(path.join(DATA_DIR, `index-${INDEX_NAME}.bin`));
  const { dims, count } = meta;
  if (bin.length !== count * dims) throw new Error(`index bin size mismatch: ${bin.length} vs ${count}x${dims}`);
  const mat = new Float32Array(count * dims);
  for (let i = 0; i < count; i++) {
    const s = scales[i], off = i * dims;
    for (let j = 0; j < dims; j++) mat[off + j] = bin.readInt8(off + j) * s;
  }
  const catalogs = new Map(); // "lang:id" -> catalog entry (with lang)
  for (const lang of ['en', 'ja']) {
    const cat = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `catalog-${lang}.json`), 'utf8'));
    for (const c of cat) catalogs.set(`${lang}:${c.id}`, { ...c, lang });
  }
  return { meta, mat, dims, count, catalogs };
}

async function loadAll() {
  if (!statePromise) {
    statePromise = (async () => {
      const t0 = Date.now();
      const data = loadDataFiles();
      const tf = await import('@xenova/transformers');
      tf.env.allowRemoteModels = false;
      tf.env.allowLocalModels = true;
      tf.env.localModelPath = MODELS_DIR;
      const processor = await tf.AutoProcessor.from_pretrained(MODEL_ID);
      const vision = await tf.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });
      return { ...data, processor, vision, loadMs: Date.now() - t0 };
    })().catch((err) => { statePromise = null; throw err; });
  }
  return statePromise;
}

// Pre-warm hook (route may call it fire-and-forget): starts the load so
// the first real scan on a fresh instance is less likely to pay it.
export function warmPict() {
  loadAll().catch(() => { /* a failed warm-up must never break a request */ });
}

async function embedBuffer(S, buf) {
  const { RawImage } = await import('@xenova/transformers');
  const img = await RawImage.fromBlob(new Blob([buf]));
  const inputs = await S.processor(img);
  const out = await S.vision(inputs);
  const v = Float32Array.from(out.image_embeds.data);
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// Prep mirrors the spike eval + production OCR: EXIF-rotate, normalize
// width, locate the card, embed the crop when a box was found (mode
// other than 'frame'), else the full photo.
export async function matchPhoto(buffer, { topK = 25 } = {}) {
  const t0 = Date.now();
  const S = await loadAll();
  const loadMs = S.loadMs;
  let img = await sharp(buffer).rotate().toBuffer();
  const m0 = await sharp(img).metadata();
  if (m0.width > 1800) img = await sharp(img).resize({ width: 1800 }).jpeg({ quality: 90 }).toBuffer();
  const meta = await sharp(img).metadata();
  const loc = await locateCard(img, meta).catch(() => null);
  let embedBuf = img, used = 'full';
  if (loc && loc.box && loc.mode !== 'frame') {
    try {
      embedBuf = await sharp(img).extract({
        left: Math.max(0, Math.round(loc.box.l * meta.width)),
        top: Math.max(0, Math.round(loc.box.t * meta.height)),
        width: Math.min(meta.width - Math.round(loc.box.l * meta.width), Math.round(loc.box.w * meta.width)),
        height: Math.min(meta.height - Math.round(loc.box.t * meta.height), Math.round(loc.box.h * meta.height)),
      }).toBuffer();
      used = `crop:${loc.mode}`;
    } catch { embedBuf = img; used = 'full'; }
  }
  const prepMs = Date.now() - t0;
  const ti = Date.now();
  const q = await embedBuffer(S, embedBuf);
  const inferMs = Date.now() - ti;
  const ts = Date.now();
  const { mat, dims, count, meta: idxMeta } = S;
  const sims = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let s = 0; const off = i * dims;
    for (let j = 0; j < dims; j++) s += q[j] * mat[off + j];
    sims[i] = s;
  }
  const order = [...sims.keys()].sort((a, b) => sims[b] - sims[a]);
  const scanMs = Date.now() - ts;
  const ranked = order.slice(0, topK).map((pos, r) => {
    const e = idxMeta.ids[pos];
    return { key: `${e.lang}:${e.id}`, lang: e.lang, id: e.id, sim: Math.round(sims[pos] * 10000) / 10000, rank: r + 1 };
  });
  const topSim = ranked.length ? ranked[0].sim : 0;
  const margin = ranked.length > 1 ? Math.round((ranked[0].sim - ranked[1].sim) * 10000) / 10000 : 1;
  return {
    ranked, topSim, margin, used,
    timings: { loadMs, prepMs, inferMs, scanMs, totalMs: Date.now() - t0 },
    indexCount: count,
  };
}

export async function catalogEntry(lang, id) {
  const S = await loadAll();
  return S.catalogs.get(`${lang}:${id}`) || null;
}

// ---------- EUR -> USD (for JA catalog prices) ----------
// ECB daily reference rate (EURUSD), fetched once and cached 24h in
// module scope. Hard fallback 1.08 if the fetch fails.
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
    // Keep the last known (or fallback) rate; retry in ~1h, not 24h.
    rateCache = { rate: rateCache.rate || 1.08, at: now - 23 * 3600 * 1000 };
  }
  return rateCache.rate;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Build a client-ready candidate from a catalog entry + picture evidence.
// EN: price is the catalog USD (TCGplayer). JA: the catalog carries only
// EUR (Cardmarket trend), converted at the ECB daily rate; the EUR
// origin stays on the candidate (currency:'EUR', priceEUR) so the
// grown-ups layer can show it. `price` is always the USD figure — the
// client verdict sums price uniformly.
export async function candidateFromCatalog(entry, { sim = null, rank = null } = {}) {
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
    if (price === null && priceEUR !== null) {
      // EN rows can be Cardmarket-only too (TCGdex carries no TCGplayer
      // price for them — all 25 Celebrations Classic Collection cards,
      // for one). Price them like JA rows: EUR converted, currency left
      // as EUR so the trade checker widens its fairness band for the
      // softer estimate. Without this a correctly identified card came
      // back priceless and silently counted as $0 in a trade.
      currency = 'EUR';
      priceUSD = round2(priceEUR * (await eurUsdRate()));
      price = priceUSD;
    }
  }
  return {
    source: 'catalog',
    lang: entry.lang,
    id: entry.id,
    name: entry.name,
    set: entry.setName || '',
    setId: entry.setId || '',
    setTotal: entry.setTotal ?? null,
    number: String(entry.localId ?? ''),
    price, priceUSD, priceEUR, currency,
    variants: {},
    // TCGdex art is stored as a /low.png URL whose /high.png sibling is
    // the full art. Override images (Celebrations Classic Collection,
    // sourced from pokemontcg) are already full URLs — use them as-is.
    image: base ? (base === entry.image ? base : `${base}/high.png`) : null,
    attacks: [],
    pictSim: sim,
    pictRank: rank,
  };
}
