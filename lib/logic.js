// Phase 3 "brain": pure functions over binders + resolved catalog
// cards. No I/O, no window, no React — everything here is unit-tested
// by scripts/test-phase3.mjs with fictional fixtures.
//
// Shapes:
//   BinderList = [{ ref, qty, card }]  — card is the resolved catalog
//   card object ({ref,id,lang,name,set,setId,setTotal,number,price,
//   priceUSD,priceEUR,currency,image,thumb,...}); price is USD.
//   BinderMap  = { [ref]: { qty, id?, addedAt } } (stored form)
//
// Fairness reuses the verdict's own band math (app/page.js checkTrade):
// diffRatio = (hi-lo)/hi; FAIR <= 0.15, widening x1.5 when any card in
// the comparison is EUR-sourced (a converted price is a softer estimate).

export const FAIR_BAND = 0.15;
export const ALMOST_BAND = 0.4;
export const EUR_WIDEN = 1.5;

export function fairBandFor(cardsA = [], cardsB = []) {
  const eur = [...cardsA, ...cardsB].some((c) => c && c.currency === 'EUR');
  return (eur ? FAIR_BAND * EUR_WIDEN : FAIR_BAND);
}
export function diffRatio(a, b) {
  const hi = Math.max(a, b);
  if (hi <= 0) return 0;
  return (hi - Math.min(a, b)) / hi;
}
export const priceOf = (card) => (card && typeof card.price === 'number' ? card.price : 0);

// Stored binder map + resolved card map -> BinderList (sorted by set,
// then printed number) — the working shape for everything below.
export function binderList(binderMap = {}, cardMap = {}) {
  const out = [];
  for (const [ref, e] of Object.entries(binderMap || {})) {
    const card = cardMap[ref];
    if (!card || !e || !(e.qty > 0)) continue;
    out.push({ ref, qty: e.qty, card });
  }
  out.sort((a, b) =>
    String(a.card.set).localeCompare(String(b.card.set)) ||
    String(a.card.number).localeCompare(String(b.card.number), undefined, { numeric: true }) ||
    String(a.card.name).localeCompare(String(b.card.name)));
  return out;
}

export function duplicates(list) {
  return (list || []).filter((e) => e.qty >= 2);
}
// Spare copies a kid could actually give away (one of each card kept).
export function spareCopies(list) {
  const out = [];
  for (const e of list || []) {
    for (let i = 0; i < e.qty - 1; i++) out.push({ ref: e.ref, card: e.card });
  }
  return out;
}

export function binderValue(list) {
  let total = 0, dupTotal = 0, count = 0, distinct = 0;
  for (const e of list || []) {
    const p = priceOf(e.card);
    total += p * e.qty;
    count += e.qty;
    distinct += 1;
    if (e.qty >= 2) dupTotal += p * (e.qty - 1);
  }
  return { total, duplicatesValue: dupTotal, count, distinct };
}

// Per-set progress for one binder. total = the set's printed total
// (setTotal) — falling back to the largest owned number when unknown.
// "Closest to done" first: highest pct, then fewest missing.
export function setProgress(list) {
  const bySet = new Map();
  for (const e of list || []) {
    const key = `${e.card.lang}:${e.card.setId}`;
    if (!bySet.has(key)) {
      bySet.set(key, {
        key, lang: e.card.lang, setId: e.card.setId, setName: e.card.set,
        ownedRefs: new Set(), total: e.card.setTotal || 0, maxNum: 0,
      });
    }
    const s = bySet.get(key);
    s.ownedRefs.add(e.ref);
    const n = parseInt(e.card.number, 10);
    if (Number.isFinite(n)) s.maxNum = Math.max(s.maxNum, n);
    if (e.card.setTotal) s.total = e.card.setTotal;
  }
  const out = [...bySet.values()].map((s) => {
    const total = s.total || s.maxNum;
    const owned = s.ownedRefs.size;
    return {
      key: s.key, lang: s.lang, setId: s.setId, setName: s.setName,
      owned, total, missing: Math.max(0, total - owned),
      pct: total > 0 ? owned / total : 0,
      ownedRefs: [...s.ownedRefs],
    };
  });
  out.sort((a, b) => (b.pct - a.pct) || (a.missing - b.missing) || String(a.setName).localeCompare(String(b.setName)));
  return out;
}

export function ownedRefSet(list) {
  return new Set((list || []).map((e) => e.ref));
}

// --- Trade suggestions ------------------------------------------------

// Perfect swaps: A's spare that B is missing, paired with B's spare
// that A is missing, when the two cards' values sit inside the fair
// band. Each spare is used in at most one pair (greedy, closest
// ratios first). Returns up to `cap` pairs:
//   [{ giveA: {ref,card}, giveB: {ref,card}, ratio }]
export function perfectSwaps(listA, listB, cap = 10) {
  const ownA = ownedRefSet(listA), ownB = ownedRefSet(listB);
  const aGives = duplicates(listA).filter((e) => !ownB.has(e.ref));
  const bGives = duplicates(listB).filter((e) => !ownA.has(e.ref));
  const pairs = [];
  const usedB = new Set();
  const candidates = [];
  for (const a of aGives) {
    for (const b of bGives) {
      const band = fairBandFor([a.card], [b.card]);
      const r = diffRatio(priceOf(a.card), priceOf(b.card));
      if (r <= band) candidates.push({ a, b, r });
    }
  }
  candidates.sort((x, y) => (x.r - y.r) || (priceOf(y.a.card) + priceOf(y.b.card)) - (priceOf(x.a.card) + priceOf(x.b.card)));
  const usedA = new Set();
  for ( const c of candidates) {
    if (usedA.has(c.a.ref) || usedB.has(c.b.ref)) continue;
    usedA.add(c.a.ref); usedB.add(c.b.ref);
    pairs.push({ giveA: { ref: c.a.ref, card: c.a.card }, giveB: { ref: c.b.ref, card: c.b.card }, ratio: c.r });
    if (pairs.length >= cap) break;
  }
  return pairs;
}

// One-way gift ideas: A's spare that B is missing, prioritized when
// the card's set is one B is close to completing (missing <=
// closeMissing, default 10). Each idea carries the closest-value B
// spare as the suggested return (may be null). Returns up to `cap`:
//   [{ give: {ref,card}, setKey, setMissing, returnCard: {ref,card}|null }]
export function giftIdeas(listA, listB, cap = 10, closeMissing = 10) {
  const ownA = ownedRefSet(listA);
  const ownB = ownedRefSet(listB);
  const progressB = new Map(setProgress(listB).map((s) => [s.key, s]));
  const bSpares = spareCopies(listB);
  const ideas = [];
  for (const e of duplicates(listA)) {
    if (ownB.has(e.ref)) continue;
    const key = `${e.card.lang}:${e.card.setId}`;
    const prog = progressB.get(key);
    if (!prog || prog.missing > closeMissing) continue;
    let best = null, bestDiff = Infinity;
    for (const s of bSpares) {
      if (ownA.has(s.ref)) continue; // a return A already has is no gift back
      const d = Math.abs(priceOf(s.card) - priceOf(e.card));
      if (d < bestDiff) { bestDiff = d; best = s; }
    }
    ideas.push({
      give: { ref: e.ref, card: e.card },
      setKey: key, setName: e.card.set, setMissing: prog.missing, setPct: prog.pct,
      returnCard: best ? { ref: best.ref, card: best.card } : null,
    });
  }
  ideas.sort((a, b) => (a.setMissing - b.setMissing) || (priceOf(b.give.card) - priceOf(a.give.card)));
  return ideas.slice(0, cap);
}

// Family cross-check: for a kid's missing refs, which OTHER binders
// hold a spare (qty >= 2)? otherBinders: { kidId: BinderList }.
// Returns Map ref -> [kidId,...].
export function spareHolders(missingRefs, otherBinders = {}) {
  const out = new Map();
  for (const ref of missingRefs || []) {
    const holders = [];
    for (const [kidId, list] of Object.entries(otherBinders)) {
      const hit = (list || []).find((e) => e.ref === ref && e.qty >= 2);
      if (hit) holders.push(kidId);
    }
    if (holders.length) out.set(ref, holders);
  }
  return out;
}

// --- Auto-balance ------------------------------------------------------

// Choose 1..maxCards spare copies from the LIGHT side that best close
// the gap (hiTotal - loTotal). A combo "lands in the band" when the
// post-add diffRatio <= band. Among in-band combos prefer the sum
// closest to the gap (least overshoot), then fewer cards; among
// out-of-band combos prefer closest sum too (honest closest).
// Returns { cards: [{ref,card}], sum, landsInBand, newRatio } or null.
export function autoBalance({ hiTotal, loTotal, spares, band = FAIR_BAND, maxCards = 3 }) {
  const gap = hiTotal - loTotal;
  if (!(gap > 0) || !spares || !spares.length) return null;
  // Only spares that can plausibly help: priced, and not wildly over
  // the gap on their own (a single card may overshoot a little if it
  // still lands in band — allow up to gap + band share of the new hi).
  const pool = spares
    .filter((s) => priceOf(s.card) > 0)
    .sort((a, b) => priceOf(b.card) - priceOf(a.card))
    .slice(0, 24);
  if (!pool.length) return null;
  let best = null;
  const consider = (combo) => {
    const sum = combo.reduce((t, s) => t + priceOf(s.card), 0);
    const newLo = loTotal + sum;
    const newRatio = diffRatio(hiTotal, newLo);
    const lands = newRatio <= band;
    const cand = { cards: combo, sum, landsInBand: lands, newRatio, score: Math.abs(sum - gap) };
    if (!best) { best = cand; return; }
    if (cand.landsInBand !== best.landsInBand) { if (cand.landsInBand) best = cand; return; }
    if (cand.score !== best.score) { if (cand.score < best.score) best = cand; return; }
    if (cand.cards.length < best.cards.length) best = cand;
  };
  const n = pool.length;
  for (let i = 0; i < n; i++) consider([pool[i]]);
  if (maxCards >= 2) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) consider([pool[i], pool[j]]);
  if (maxCards >= 3) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
      consider([pool[i], pool[j], pool[k]]);
    }
  }
  return best;
}

// --- Gift Radar ---------------------------------------------------------

// Missing cards of one set, cheapest first, under a budget cap.
// setCardsList: full set listing (card objects). ownedRefs: Set of
// refs the kid owns. budget: max USD price (Infinity = any). Cards
// with no known price sort last within the budget pass only when
// budget is Infinity (a grandparent can't act on "no price" at a cap).
export function giftRadar({ setCardsList = [], ownedRefs = new Set(), budget = Infinity, limit = 60 }) {
  const missing = (setCardsList || []).filter((c) => !ownedRefs.has(c.ref));
  const priced = missing.filter((c) => typeof c.price === 'number');
  const unpriced = missing.filter((c) => typeof c.price !== 'number');
  priced.sort((a, b) => a.price - b.price);
  let out = priced.filter((c) => c.price <= budget);
  if (budget === Infinity) out = out.concat(unpriced);
  return out.slice(0, limit);
}

// --- Badges ---------------------------------------------------------------

export const FAIR_TIERS = [
  { min: 25, name: 'Fair Trade Legend', stars: '⭐⭐⭐⭐⭐' },
  { min: 10, name: 'Super Fair Trader', stars: '⭐⭐⭐⭐' },
  { min: 5, name: 'Fair Trader', stars: '⭐⭐⭐' },
  { min: 1, name: 'First Fair Trade', stars: '⭐' },
];

export function fairTraderBadge(tradeCount) {
  const tier = FAIR_TIERS.find((t) => tradeCount >= t.min) || null;
  const next = [...FAIR_TIERS].reverse().find((t) => tradeCount < t.min) || null;
  return { count: tradeCount, tier, next };
}

// Trades in the log where this kid took part (either side).
export function kidFairTrades(trades = [], kidId) {
  return (trades || []).filter((t) => t && (t.aKid === kidId || t.bKid === kidId) && t.fair);
}

// Set badges from progress: explorer at >= 50%, crown at 100%.
export function setBadges(progress = []) {
  return (progress || [])
    .filter((s) => s.pct >= 0.5)
    .map((s) => ({
      setKey: s.key, setName: s.setName, pct: s.pct,
      crown: s.pct >= 1, label: s.pct >= 1 ? '👑' : '🧭',
    }))
    .sort((a, b) => b.pct - a.pct);
}
