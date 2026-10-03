// Card book lookups: TCGdex first, Pokemon TCG API as fallback.
// Both are flaky free services, so every call retries with backoff,
// and successful results are cached in memory for a few minutes.

const cache = new Map(); // key -> { at, value }
const CACHE_MS = 10 * 60 * 1000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  return null;
}
function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, tries = 3) {
  const key = 'GET:' + url;
  const cached = cacheGet(key);
  if (cached) return cached;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'card-trade-checker/1.0 (family app)' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      // TCGdex sometimes answers plain-text errors like "no available server"
      if (!text || (!text.startsWith('{') && !text.startsWith('['))) {
        throw new Error('Non-JSON response: ' + text.slice(0, 60));
      }
      const json = JSON.parse(text);
      cacheSet(key, json);
      return json;
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(300 * Math.pow(1.7, i) + Math.random() * 200);
    }
  }
  throw lastErr || new Error('fetch failed: ' + url);
}

// ---------- similarity helpers ----------

export function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

// 0..1 similarity between an OCR guess and a real card name.
export function nameSimilarity(guess, real) {
  const a = normName(guess), b = normName(real);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.92;
  const aTok = new Set(a.split(' ')), bTok = new Set(b.split(' '));
  let shared = 0;
  aTok.forEach((t) => { if (bTok.has(t)) shared++; });
  const tokenScore = shared / Math.max(aTok.size, bTok.size);
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.max(tokenScore, lev);
}

// ---------- TCGdex ----------

const TCGDEX = 'https://api.tcgdex.net/v2/en';

export async function tcgdexSearchByName(name) {
  const url = `${TCGDEX}/cards?name=${encodeURIComponent(name)}`;
  const json = await fetchJson(url);
  return Array.isArray(json) ? json : [];
}

export async function tcgdexSearchByLocalId(localId) {
  const url = `${TCGDEX}/cards?localId=${encodeURIComponent(localId)}`;
  const json = await fetchJson(url);
  return Array.isArray(json) ? json : [];
}

export async function tcgdexDetail(id) {
  const url = `${TCGDEX}/cards/${encodeURIComponent(id)}`;
  return fetchJson(url);
}

// Set list (id -> printed total), for prefiltering by the denominator
// a kid's card shows next to its number (e.g. 019/163 -> set total 163).
export async function tcgdexSetTotals() {
  try {
    const sets = await fetchJson(`${TCGDEX}/sets`);
    const map = new Map();
    for (const s of Array.isArray(sets) ? sets : []) {
      const total = s.cardCount && (s.cardCount.official || s.cardCount.total);
      if (s.id && total) map.set(s.id, String(total));
    }
    return map;
  } catch {
    return new Map();
  }
}

export function tcgdexPrices(detail) {
  const tp = detail && detail.pricing && detail.pricing.tcgplayer;
  if (!tp) return { price: null, variants: {} };
  const variants = {};
  for (const k of ['normal', 'holofoil', 'reverseHolofoil', '1stEditionHolofoil', '1stEditionNormal']) {
    const v = tp[k];
    if (v && typeof v.marketPrice === 'number') variants[k] = v.marketPrice;
  }
  // Prefer the shiny/holo price when there is one — that's the card kids trade.
  const price =
    variants.holofoil ?? variants['1stEditionHolofoil'] ?? variants.normal ??
    variants.reverseHolofoil ?? variants['1stEditionNormal'] ?? null;
  return { price, variants };
}

export function candidateFromTcgdex(detail, resume) {
  const { price, variants } = tcgdexPrices(detail);
  const localId = detail.localId || (resume && resume.localId) || '';
  const base = detail.image || (resume && resume.image) || '';
  return {
    source: 'tcgdex',
    id: detail.id,
    name: detail.name,
    set: detail.set ? detail.set.name : '',
    setTotal: detail.set && detail.set.cardCount ? (detail.set.cardCount.official || detail.set.cardCount.total) : null,
    number: String(localId),
    price,
    variants,
    image: base ? `${base}/high.png` : null,
    attacks: (detail.attacks || []).map((a) => a.name),
  };
}

// ---------- Pokemon TCG API (fallback) ----------

function mapPokemontcg(c) {
  const prices = {};
  const tp = c.tcgplayer && c.tcgplayer.prices;
  if (tp) {
    for (const [k, v] of Object.entries(tp)) {
      if (v && typeof v.market === 'number') prices[k] = v.market;
    }
  }
  const price = prices.holofoil ?? prices.normal ?? prices.reverseHolofoil ?? Object.values(prices)[0] ?? null;
  return {
    source: 'pokemontcg',
    id: c.id,
    name: c.name,
    set: c.set ? c.set.name : '',
    setTotal: c.set ? c.set.printedTotal : null,
    number: String(c.number || ''),
    price,
    variants: prices,
    image: c.images ? c.images.large || c.images.small : null,
    attacks: (c.attacks || []).map((a) => a.name),
  };
}

export async function pokemontcgSearch(name, number) {
  const parts = [];
  if (name) parts.push(`name:"${name.replace(/"/g, '')}"`);
  if (number) parts.push(`number:${number}`);
  if (!parts.length) return [];
  const q = encodeURIComponent(parts.join(' '));
  const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=20`;
  const json = await fetchJson(url, 3);
  return ((json && json.data) || []).map(mapPokemontcg);
}

// Rescue channel: find cards by an attack name fragment (nearly unique).
export async function pokemontcgSearchAttack(token) {
  const clean = (token || '').replace(/[^A-Za-z\-]/g, '');
  if (clean.length < 4) return [];
  const q = encodeURIComponent(`attacks.name:"*${clean}*"`);
  const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=250`;
  const json = await fetchJson(url, 3);
  return ((json && json.data) || []).map(mapPokemontcg);
}
