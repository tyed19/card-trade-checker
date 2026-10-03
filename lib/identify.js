// Turn OCR guesses (names + collector numbers) into ranked real cards.
// Identification leans on the collector number (plain print, OCR-friendly),
// the printed set total, fuzzy name matching, and — as a tiebreaker —
// a downscaled image comparison against each candidate's official art.

import sharp from 'sharp';
import {
  fetchJson,
  clearFetchCache,
  tcgdexSearchByName,
  tcgdexSearchByLocalId,
  tcgdexDetail,
  tcgdexSetTotals,
  candidateFromTcgdex,
  pokemontcgSearch,
  pokemontcgSearchAttack,
  nameSimilarity,
  normName,
} from './cardbook.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round((n || 0) * 100) / 100;

// ---------- confidence gate ----------
// Every candidate carries its evidence (numberMatch / nameSim /
// attackTokens / score). A candidate is DISPLAYABLE — allowed to be
// shown to a kid as a picture choice — only when the evidence is
// structural, not just a big number: the printed collector number
// matched, OR two different attack words matched, OR a strong name
// match with a strong score, OR an overwhelming score. A one-token
// attack-only guess (the Onix-GX pattern: right attack word fragment,
// wrong card entirely) is capped and never displayable on its own.
function applyGate(cand) {
  const numberMatch = cand.numberMatch === true;
  const nameSim = cand.nameSim || 0;
  const attackTokens = cand.attackTokens || 0;
  let score = cand.score || 0;
  const oneTokenOnly = attackTokens === 1 && !numberMatch && nameSim < 0.8;
  if (oneTokenOnly) score = Math.min(score, 69);
  cand.score = score;
  cand.displayable = !oneTokenOnly && (
    numberMatch ||
    attackTokens >= 2 ||
    (nameSim >= 0.8 && score >= 90) ||
    score >= 130
  );
  return cand;
}

// ---------- rescue-token hygiene ----------
// Same rules as the OCR-side filter (lib/ocr.js): exact stopwords,
// truncations that are strict prefixes of a stopword ('Damag'), and
// merged junk with a stopword as prefix/suffix fragment ('Thisiattack',
// 'Discarded') never get to consume a rescue-search slot.
const RESCUE_STOP = new Set([
  'energy', 'discard', 'discarded', 'damage', 'during', 'opponent', 'opponents',
  'attach', 'active', 'bench', 'cards', 'basic', 'flip', 'coins', 'heads', 'tails',
  'weakness', 'resistance', 'retreat', 'pokemon', 'pokmon', 'attack', 'does',
  'each', 'from', 'your', 'this', 'that', 'with', 'take', 'prize', 'deck',
  'next', 'turn', 'less', 'counters', 'counter', 'defending', 'before',
  'knocked', 'shuffle', 'search', 'draw', 'evolves', 'evolved', 'special',
  'condition', 'cant', 'cannot', 'instead', 'already', 'amount', 'their',
  'they', 'them', 'then', 'than', 'more', 'also', 'once', 'plus', 'times',
]);

function rescueTokenIsJunk(token) {
  const lower = (token || '').toLowerCase();
  if (!lower || RESCUE_STOP.has(lower)) return true;
  for (const w of RESCUE_STOP) {
    if (w.length < 4) continue;
    if (w.length > lower.length && w.startsWith(lower)) return true;
    if (lower.length > w.length && (lower.startsWith(w) || lower.endsWith(w))) return true;
  }
  return false;
}

function queryNames(nameGuess) {
  const q = new Set();
  const clean = (nameGuess || '').trim();
  if (!clean) return [];
  const push = (s) => { const v = (s || '').trim(); if (v.length >= 3) q.add(v); };
  push(clean);
  const noMega = clean.replace(/^mega\s+/i, '');
  push(noMega);
  const toks = noMega.split(/\s+/);
  if (toks.length >= 2) push(toks.slice(0, 2).join(' '));
  const first = toks[0];
  push(first);
  for (const suf of ['ex', 'VMAX', 'V', 'GX']) {
    push(`${first} ${suf}`);
    if (toks.length >= 2) push(`${toks[0]} ${toks[1]} ${suf}`);
  }
  return [...q].slice(0, 8);
}

function numEq(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/^0+/, '') === String(b).replace(/^0+/, '');
}

async function photoSignature(photoBuffer) {
  try {
    const meta = await sharp(photoBuffer).metadata();
    const crop = await sharp(photoBuffer)
      .extract({
        left: Math.round(0.06 * meta.width),
        top: Math.round(0.04 * meta.height),
        width: Math.round(0.88 * meta.width),
        height: Math.round(0.9 * meta.height),
      })
      .resize(40, 56)
      .removeAlpha()
      .raw()
      .toBuffer();
    return crop;
  } catch { return null; }
}

async function imageSimilarity(photoSig, imageUrl) {
  if (!photoSig || !imageUrl) return 0;
  const urls = [imageUrl.replace('/high.png', '/low.png'), imageUrl];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const cand = await sharp(buf).resize(40, 56).removeAlpha().raw().toBuffer();
      if (cand.length !== photoSig.length) continue;
      let diff = 0;
      for (let i = 0; i < cand.length; i++) diff += Math.abs(cand[i] - photoSig[i]);
      const mad = diff / cand.length; // 0..255
      return Math.max(0, 1 - mad / 160);
    } catch { /* next url */ }
  }
  return 0;
}

export async function findCandidates({ nameGuess = '', nameGuesses = [], numberGuess = null, numberGuesses = [], attackGuesses = [], photoBuffer = null }) {
  const guesses = [...new Set([nameGuess, ...(nameGuesses || [])].filter(Boolean))].slice(0, 4);
  const numList = [...(numberGuesses && numberGuesses.length ? numberGuesses : numberGuess ? [numberGuess] : [])];
  const primaryNum = numList[0] || null;
  // The number was really read (voted on by several slices, or at least
  // present) — an empty result then means the card BOOK failed us, not
  // the photo, and earns real retries below.
  const strongNumberRead = !!primaryNum && ((primaryNum.votes || 0) >= 2 || !!numberGuess);

  const bestNameSim = (name) => Math.max(0, ...guesses.map((g) => nameSimilarity(g, name)));
  const photoSig = photoBuffer ? await photoSignature(photoBuffer) : null;

  // One full round of TCGdex name/localId searches -> scored candidates,
  // each tagged with its evidence for the confidence gate.
  async function runMainSearch(poolLimit) {
    const byId = new Map();
    const searches = [];
    for (const g of guesses.slice(0, 3)) {
      for (const q of queryNames(g)) searches.push(tcgdexSearchByName(q).catch(() => []));
    }
    for (const n of numList.slice(0, 2)) {
      searches.push(tcgdexSearchByLocalId(n.padded).catch(() => []));
      searches.push(tcgdexSearchByLocalId(n.num).catch(() => []));
    }
    const results = await Promise.allSettled(searches);
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const resume of r.value || []) {
        if (resume && resume.id && !byId.has(resume.id)) byId.set(resume.id, resume);
      }
    }

    // pre-score resumes, keep a sane detail-fetch pool
    let pool = [...byId.values()].map((resume) => {
      const numMatch = primaryNum ? numEq(resume.localId, primaryNum.num) : false;
      return { resume, numMatch, sim: bestNameSim(resume.name) };
    });
    pool = pool.filter((p) => p.numMatch || p.sim >= 0.45);
    // If we read the printed set total (the "/163"), use the set list to throw
    // out same-number cards from other sets BEFORE spending detail fetches.
    if (primaryNum && primaryNum.total && pool.some((p) => p.numMatch)) {
      const totals = await tcgdexSetTotals();
      if (totals.size) {
        const setIdOf = (id) => id.replace(/-[^-]+$/, '');
        const matching = pool.filter((p) => !p.numMatch || totals.get(setIdOf(p.resume.id)) === String(primaryNum.total));
        if (matching.some((p) => p.numMatch)) pool = matching;
      }
    }
    pool.sort((a, b) => (b.numMatch - a.numMatch) || (b.sim - a.sim));
    pool = pool.slice(0, poolLimit);

    // Detail fetches + art comparison in parallel — sequential rounds of
    // retried fetches were a major slice of the old >60s runtimes.
    const scored = await Promise.all(pool.map(async ({ resume, numMatch, sim }) => {
      try {
        const detail = await tcgdexDetail(resume.id);
        const cand = candidateFromTcgdex(detail, resume);
        let score = (numMatch ? 100 : 0) + sim * 55;
        if (primaryNum && primaryNum.total && cand.setTotal) {
          score += String(cand.setTotal) === String(primaryNum.total) ? 25 : -20;
        }
        const imgSim = await imageSimilarity(photoSig, cand.image);
        score += imgSim * 30;
        return {
          ...cand, score: Math.round(score), imageMatch: Math.round(imgSim * 100) / 100,
          numberMatch: numMatch, nameSim: round2(sim), attackTokens: 0,
        };
      } catch { return null; }
    }));
    const out = scored.filter(Boolean);
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  let candidates = await runMainSearch(5);

  // Strong number read but ZERO candidates: that is an upstream hiccup,
  // not a bad photo (proven live: a perfect 106/94 read once came back
  // empty). Clear the response cache — a hiccup can be cached as a
  // successful-but-empty answer — and re-run the book lookups up to 2
  // more rounds with short pauses, with a wider detail pool.
  if (!candidates.length && strongNumberRead) {
    for (let round = 1; round <= 2 && !candidates.length; round++) {
      await sleep(900 * round);
      clearFetchCache();
      candidates = await runMainSearch(8);
    }
  }

  // Still empty with a number in hand: ask the fallback book by NUMBER
  // alone. A name query built from garbage name OCR ("cf CC") can never
  // find the card, but number:106 plus the printed set total can.
  if (!candidates.length && primaryNum) {
    try {
      const byNumber = await pokemontcgSearch('', primaryNum.num);
      for (const c of byNumber) {
        if (!numEq(c.number, primaryNum.num)) continue;
        if (candidates.some((x) => x.name === c.name && numEq(x.number, c.number) && x.set === c.set)) continue;
        let score = 100 + bestNameSim(c.name) * 10;
        if (primaryNum.total && c.setTotal && String(c.setTotal) === String(primaryNum.total)) score += 25;
        candidates.push({
          ...c, score: Math.round(score),
          numberMatch: true, nameSim: round2(bestNameSim(c.name)), attackTokens: 0,
        });
      }
      candidates.sort((a, b) => b.score - a.score);
    } catch { /* best-effort */ }
  }

  const strong = candidates.length && candidates[0].score >= 70 && candidates[0].price !== null;
  if (!strong && (guesses.length || primaryNum)) {
    try {
      const firstTok = normName(guesses[0] || '').split(' ')[0] || '';
      const fb = await pokemontcgSearch(firstTok, primaryNum ? primaryNum.num : '');
      for (const c of fb) {
        if (!candidates.some((x) => x.name === c.name && numEq(x.number, c.number))) {
          const fbNumMatch = !!(primaryNum && numEq(c.number, primaryNum.num));
          candidates.push({
            ...c,
            score: 40 + bestNameSim(c.name) * 20 + (fbNumMatch ? 30 : 0),
            numberMatch: fbNumMatch, nameSim: round2(bestNameSim(c.name)), attackTokens: 0,
          });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
    } catch { /* best-effort */ }
  }

  // Rescue channel: attack names are nearly unique per card. If we still
  // have nothing strong, search by the attack words the OCR did read and
  // let image similarity pick the right print among the few matches.
  const stillWeak = !candidates.length || candidates[0].score < 70;
  if (stillWeak && attackGuesses && attackGuesses.length) {
    const sig = photoSig || (photoBuffer ? await photoSignature(photoBuffer) : null);
    // Collect cards per token, keeping only cards whose real attack list
    // contains the token. Cards matching 2+ tokens (e.g. Hammer + Lanche,
    // both inside "Hammer-lanche") are almost certainly the right card.
    const byCard = new Map();
    // Drop junk tokens before searching: OCR truncations and merged
    // rule-text words ('Damag', 'Thisiattack', 'Discarded') match
    // hundreds of cards and burn the rescue slots the real tokens
    // (e.g. Hammer + Lanche) need. Same rules as the OCR-side filter.
    const tokenList = (attackGuesses || [])
      .filter((t) => !rescueTokenIsJunk(t))
      .slice(0, 5);
    const collect = async () => {
      const perToken = await Promise.allSettled(tokenList.map((t) => pokemontcgSearchAttack(t)));
      perToken.forEach((res, ti) => {
        if (res.status !== 'fulfilled') return;
        const token = tokenList[ti];
        for (const c of res.value || []) {
          if (!(c.attacks || []).some((a) => a.toLowerCase().includes(token.toLowerCase()))) continue;
          const key = c.id;
          const rec = byCard.get(key) || { card: c, tokens: new Set() };
          rec.tokens.add(token);
          byCard.set(key, rec);
        }
      });
    };
    await collect();
    // The attack-search API is flaky (documented ~25%+ failure): if no
    // card confirmed 2+ tokens, one more round after a breath — a
    // two-token confirmation (Hammer + Lanche) is the whole rescue.
    if (tokenList.length >= 2 && ![...byCard.values()].some((r) => r.tokens.size >= 2)) {
      await new Promise((r) => setTimeout(r, 1500));
      await collect();
    }
    // If any card matched 2+ tokens it is almost certainly real —
    // suppress one-token noise entirely in that case.
    const hasMulti = [...byCard.values()].some((r) => r.tokens.size >= 2);
    const ranked = [...byCard.values()]
      .filter((r) => !hasMulti || r.tokens.size >= 2)
      .sort((a, b) => b.tokens.size - a.tokens.size).slice(0, 6);
    const rescued = await Promise.all(ranked.map(async ({ card: c, tokens }) => {
      if (candidates.some((x) => x.name === c.name && numEq(x.number, c.number) && x.set === c.set)) return null;
      const imgSim = await imageSimilarity(sig, c.image);
      const numMatch = !!(primaryNum && numEq(c.number, primaryNum.num));
      let score = 40 + tokens.size * 15 + imgSim * 40;
      if (numMatch) score += 40;
      return {
        ...c, score: Math.round(score), imageMatch: Math.round(imgSim * 100) / 100,
        viaAttack: [...tokens].join('+'),
        numberMatch: numMatch, nameSim: round2(bestNameSim(c.name)), attackTokens: tokens.size,
      };
    }));
    for (const r of rescued) if (r) candidates.push(r);
    candidates.sort((a, b) => b.score - a.score);
  }

  // Confidence gate: tag every candidate displayable or not (one-token
  // attack-only guesses get score-capped here too), then rank. The full
  // list still goes back for the grown-ups/debug view; the client only
  // ever shows pictures for displayable ones.
  for (const c of candidates) applyGate(c);
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3);
}

export { fetchJson };
