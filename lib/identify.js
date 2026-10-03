// Turn OCR guesses (names + collector numbers) into ranked real cards.
// Identification leans on the collector number (plain print, OCR-friendly),
// the printed set total, fuzzy name matching, and — as a tiebreaker —
// a downscaled image comparison against each candidate's official art.

import sharp from 'sharp';
import {
  fetchJson,
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
  const bestNameSim = (name) => Math.max(0, ...guesses.map((g) => nameSimilarity(g, name)));
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
  pool = pool.slice(0, 5);

  const photoSig = photoBuffer ? await photoSignature(photoBuffer) : null;

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
      return { ...cand, score: Math.round(score), imageMatch: Math.round(imgSim * 100) / 100 };
    } catch { return null; }
  }));
  const candidates = scored.filter(Boolean);
  candidates.sort((a, b) => b.score - a.score);

  const strong = candidates.length && candidates[0].score >= 70 && candidates[0].price !== null;
  if (!strong && (guesses.length || primaryNum)) {
    try {
      const firstTok = normName(guesses[0] || '').split(' ')[0] || '';
      const fb = await pokemontcgSearch(firstTok, primaryNum ? primaryNum.num : '');
      for (const c of fb) {
        if (!candidates.some((x) => x.name === c.name && numEq(x.number, c.number))) {
          candidates.push({ ...c, score: 40 + bestNameSim(c.name) * 20 + (primaryNum && numEq(c.number, primaryNum.num) ? 30 : 0) });
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
    const tokenList = attackGuesses.slice(0, 5);
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
    const ranked = [...byCard.values()].sort((a, b) => b.tokens.size - a.tokens.size).slice(0, 6);
    const rescued = await Promise.all(ranked.map(async ({ card: c, tokens }) => {
      if (candidates.some((x) => x.name === c.name && numEq(x.number, c.number) && x.set === c.set)) return null;
      const imgSim = await imageSimilarity(sig, c.image);
      let score = 40 + tokens.size * 15 + imgSim * 40;
      if (primaryNum && numEq(c.number, primaryNum.num)) score += 40;
      return { ...c, score: Math.round(score), imageMatch: Math.round(imgSim * 100) / 100, viaAttack: [...tokens].join('+') };
    }));
    for (const r of rescued) if (r) candidates.push(r);
    candidates.sort((a, b) => b.score - a.score);
  }

  return candidates.slice(0, 3);
}

export { fetchJson };
