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
// Every candidate carries its evidence (numberMatch / bareNumMatch /
// nameSim / attackTokens / score). A candidate is DISPLAYABLE —
// allowed to be shown to a kid as a picture choice — only when the
// evidence is structural, not just a big number: the printed collector
// number matched (NNN/TTT), OR two different attack words matched, OR
// a strong name match with a strong score, OR an overwhelming score.
// A one-token attack-only guess (the Onix-GX pattern: right attack
// word fragment, wrong card entirely) is capped and never displayable
// on its own. A BARE number match (promo cards: "SVP 180", no printed
// total) is weaker evidence — the same bare number exists in dozens of
// sets — so it only displays with corroboration: a decent name match
// or at least one verified attack word.
// Promo-style printings (Black Star promos and friends) are the cards
// bare numbers actually belong to: their set ids are stable across the
// TCGdex / pokemontcg / catalog id schemes ("svp-074", "swshp-SWSH255").
const PROMO_SET_IDS = new Set(['svp', 'swshp', 'smp', 'xyp', 'bwp', 'dpp', 'hgssp']);
function isPromoPrint(cand) {
  const id = String((cand && cand.id) || '').toLowerCase();
  if (!id) return false;
  return PROMO_SET_IDS.has(id.replace(/-[^-]+$/, ''));
}

function gateOf(cand) {
  const numberMatch = cand.numberMatch === true;
  const bareNumMatch = cand.bareNumMatch === true;
  const nameSim = cand.nameSim || 0;
  const attackTokens = cand.attackTokens || 0;
  let score = cand.score || 0;
  const oneTokenOnly = attackTokens === 1 && !numberMatch && !bareNumMatch && nameSim < 0.8;
  if (oneTokenOnly) score = Math.min(score, 69);
  const displayable = !oneTokenOnly && (
    numberMatch ||
    attackTokens >= 2 ||
    // A bare (promo) number is weak alone; the picture match is an
    // independent second channel, so it corroborates like a name does.
    // BUT the art threshold depends on the print: for a promo print the
    // bare number is at least the right KIND of evidence (0.78). For a
    // regular-set print, a bare read means the printed "/total" half was
    // never seen — the same bare number sits in dozens of sets, and a
    // shiny-mush pool twin at 0.85 once got crowned this way (real case:
    // a Charizard ex promo photo crowned Porygon-Z #74, sim 0.855, the
    // true card absent from the pool). Regular prints need near-proof
    // art (0.86, the pure-picture lane's own bar) or name/attack help.
    (bareNumMatch && (nameSim >= 0.6 || attackTokens >= 1
      || (cand.pictSim || 0) >= (isPromoPrint(cand) ? 0.78 : 0.86))) ||
    (nameSim >= 0.8 && score >= 90) ||
    score >= 130 ||
    // Picture-matching evidence (Phase 2): the hybrid sets these only
    // under its zone rules — a confident-zone win, a same-art neighbor
    // group the number read could not split (the kid's eyes are the
    // tiebreak, both prints are honest choices), or art + a name
    // FRAGMENT agreeing (two channels, print-level honest).
    cand.pictConfident === true ||
    cand.pictNeighbor === true ||
    cand.pictNameArt === true
  );
  return { score, displayable };
}

function applyGate(cand) {
  const g = gateOf(cand);
  cand.score = g.score;
  cand.displayable = g.displayable;
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

export async function findCandidates({ nameGuess = '', nameGuesses = [], numberGuess = null, numberGuesses = [], attackGuesses = [], photoBuffer = null, deadlineAt = 0, pictPool = null }) {
  // Soft deadline (epoch ms) from the route: optional lookup stages
  // are skipped as it approaches, so a flaky upstream degrades the
  // answer to "safe retake" instead of eating the whole function
  // budget and dying as a 50s 'slow' error (seen live on Abomasnow
  // once the gate started sending its reads to the rescue channel).
  const timeLeft = () => (deadlineAt ? deadlineAt - Date.now() : Infinity);
  const guesses = [...new Set([nameGuess, ...(nameGuesses || [])].filter(Boolean))].slice(0, 5);
  const numList = [...(numberGuesses && numberGuesses.length ? numberGuesses : numberGuess ? [numberGuess] : [])];
  const primaryNum = numList[0] || null;
  // A bare (promo) number: localId equality alone is NOT evidence —
  // 42 different cards answer to localId 180. It needs the name, the
  // promo hint, or a verified attack alongside it (see applyGate).
  const primaryIsBare = !!(primaryNum && primaryNum.bare);
  const promoHint = primaryIsBare && primaryNum.hint ? String(primaryNum.hint).toLowerCase() : null;
  const hintMatch = (resume) => {
    if (!promoHint || !resume) return false;
    const id = String(resume.id || '').toLowerCase();
    return id.startsWith(promoHint + '-') || id.startsWith(promoHint);
  };
  // OCR attack words that a candidate's real printed attacks confirm.
  const verifiedAttackCount = (cand) => (attackGuesses || []).reduce(
    (n, t) => n + ((cand.attacks || []).some((a) => a.toLowerCase().includes(String(t).toLowerCase())) ? 1 : 0),
    0
  );
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
    for (const g of guesses.slice(0, 4)) {
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
    if (primaryIsBare) {
      // Bare number: a localId hit is only worth a detail fetch when
      // the name is at least plausible or the id carries the promo
      // hint — otherwise the 40+ cards sharing the bare number flood
      // the pool and push the real one out.
      const before = pool;
      pool = pool.filter((p) => p.sim >= 0.45 || (p.numMatch && hintMatch(p.resume)));
      if (before.some((p) => p.numMatch) && !pool.some((p) => p.numMatch)) {
        pool.push(...before.filter((p) => p.numMatch).sort((a, b) => b.sim - a.sim).slice(0, 3));
      }
    } else {
      pool = pool.filter((p) => p.numMatch || p.sim >= 0.45);
    }
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
    if (primaryIsBare) {
      // Bare number: localId equality is a hint, not evidence — rank
      // by name similarity with only a small bump for the number, or
      // same-name prints from big sets push the real (corroborated)
      // card out of the detail pool entirely.
      pool.sort((a, b) => (b.sim + (b.numMatch ? 0.15 : 0)) - (a.sim + (a.numMatch ? 0.15 : 0)));
    }
    pool = pool.slice(0, poolLimit);

    // Detail fetches + art comparison in parallel — sequential rounds of
    // retried fetches were a major slice of the old >60s runtimes.
    const scored = await Promise.all(pool.map(async ({ resume, numMatch, sim }) => {
      try {
        const detail = await tcgdexDetail(resume.id);
        const cand = candidateFromTcgdex(detail, resume);
        // A full NNN/TTT match is the strongest evidence there is
        // (+100). A BARE match is worth only a nudge (+30): the same
        // bare number exists in dozens of sets, and +100 let a lone
        // misread number ("150" off a holo texture) drag wrong cards
        // over the gate's raw-score line.
        let score = (numMatch ? (primaryIsBare ? 30 : 100) : 0) + sim * 55;
        if (primaryNum && primaryNum.total && cand.setTotal) {
          score += String(cand.setTotal) === String(primaryNum.total) ? 25 : -20;
        }
        const imgSim = await imageSimilarity(photoSig, cand.image);
        score += imgSim * 30;
        // Verified attack words refine the ranking: they are the only
        // signal that separates same-name prints before the gate
        // (a promo Dialga ex confirms 3 read attacks; its same-name
        // Celebrations print confirms 2 and used to outrank it).
        const atk = verifiedAttackCount(cand);
        score += atk * 8;
        return {
          ...cand, score: Math.round(score), imageMatch: Math.round(imgSim * 100) / 100,
          // A bare (promo) number match is tagged separately: localId
          // equality is real, but the gate demands corroboration for it.
          numberMatch: primaryIsBare ? false : numMatch,
          bareNumMatch: primaryIsBare && numMatch,
          nameSim: round2(sim), attackTokens: atk,
        };
      } catch { return null; }
    }));
    const out = scored.filter(Boolean);
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // Bare primaries get a much wider detail pool: the number can't
  // narrow the field, and exact-name prints (similarity 1.0) crowd out
  // the suffixed real card (0.92) — more name-led candidates deserve
  // a detail fetch so attack verification can separate them.
  let candidates = await runMainSearch(primaryIsBare ? 16 : 8);

  // Strong number read but ZERO candidates: that is an upstream hiccup,
  // not a bad photo (proven live: a perfect 106/94 read once came back
  // empty). Clear the response cache — a hiccup can be cached as a
  // successful-but-empty answer — and re-run the book lookups up to 2
  // more rounds with short pauses, with a wider detail pool.
  if (!candidates.length && strongNumberRead) {
    for (let round = 1; round <= 2 && !candidates.length; round++) {
      await sleep(900 * round);
      clearFetchCache();
      candidates = await runMainSearch(primaryIsBare ? 16 : 8);
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
        // Bare number: this branch searches by number ALONE, so a
        // same-number card from another set is meaningless without a
        // plausible name or the promo hint in its id.
        if (primaryIsBare
          && !(bestNameSim(c.name) >= 0.5 || (promoHint && String(c.id || '').toLowerCase().startsWith(promoHint)))) {
          continue;
        }
        if (candidates.some((x) => x.name === c.name && numEq(x.number, c.number) && x.set === c.set)) continue;
        let score = (primaryIsBare ? 30 : 100) + bestNameSim(c.name) * 10;
        if (primaryNum.total && c.setTotal && String(c.setTotal) === String(primaryNum.total)) score += 25;
        candidates.push({
          ...c, score: Math.round(score),
          numberMatch: !primaryIsBare, bareNumMatch: primaryIsBare,
          nameSim: round2(bestNameSim(c.name)), attackTokens: verifiedAttackCount(c),
        });
      }
      candidates.sort((a, b) => b.score - a.score);
    } catch { /* best-effort */ }
  }

  const strong = candidates.length && candidates[0].score >= 70 && candidates[0].price !== null;
  // The name fallback is the weakest channel (score-40 junk
  // historically) and it rides the flaky fallback API — deferred
  // until AFTER the attack rescue, and only called if the rescue
  // added nothing at all (see the call site below).
  const runNameFallback = async () => {
    if (strong || !(guesses.length || primaryNum) || timeLeft() <= 12000) return;
    try {
      const firstTok = normName(guesses[0] || '').split(' ')[0] || '';
      const fb = await pokemontcgSearch(firstTok, primaryNum ? primaryNum.num : '');
      for (const c of fb) {
        if (!candidates.some((x) => x.name === c.name && numEq(x.number, c.number))) {
          const fbNumMatch = !!(primaryNum && numEq(c.number, primaryNum.num));
          candidates.push({
            ...c,
            score: 40 + bestNameSim(c.name) * 20 + (fbNumMatch ? 30 : 0),
            numberMatch: fbNumMatch && !primaryIsBare,
            bareNumMatch: fbNumMatch && primaryIsBare,
            nameSim: round2(bestNameSim(c.name)), attackTokens: verifiedAttackCount(c),
          });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
    } catch { /* best-effort */ }
  };

  // Rescue channel: attack names are nearly unique per card. If we still
  // have nothing strong, search by the attack words the OCR did read and
  // let image similarity pick the right print among the few matches.
  // The trigger is the GATE, not a raw score: a name-only hit scores 74
  // (perfect name similarity + weak art match) while being completely
  // unproven — three wrong same-name prints once sat at 74 and blocked
  // the rescue that would have found the real card. And even a
  // DISPLAYABLE hit is not the end when its only evidence is name/art:
  // 41 prints share the exact name "Dialga", the real one (an ex
  // promo) ranked #42 by name — but its attacks are unique. So rescue
  // whenever the best displayable candidate lacks number evidence
  // (full or bare); attack verification then re-ranks honestly.
  const displayableNow = candidates.filter((c) => gateOf(c).displayable);
  const topDisplayable = displayableNow.sort((a, b) => b.score - a.score)[0] || null;
  // Pool contradiction: a displayable top pick the picture pool has
  // never heard of, on a photo whose attacks WERE read, is not proof —
  // a misread number can mint exactly that (real case: 011/73 off a
  // promo line crowned Carvanha #11 internally and blocked the rescue
  // that held the real Charizard; the hybrid's picture veto demoted it
  // afterwards, too late). Let the rescue run; its verified-attack
  // candidates compete on evidence and the veto remains the backstop.
  let topContradictedByPool = false;
  if (topDisplayable && pictPool && pictPool.length && (attackGuesses || []).length) {
    const keyOf = (name, number) => normName(name) + '|' + String(number ?? '').replace(/^0+/, '');
    const topKey = keyOf(topDisplayable.name, topDisplayable.number);
    topContradictedByPool = !pictPool.some((p) => keyOf(p.name, p.number) === topKey);
  }
  const stillWeak = !topDisplayable
    || !(topDisplayable.numberMatch || topDisplayable.bareNumMatch)
    || topContradictedByPool;
  const candidatesBeforeRescue = candidates.length;
  if (stillWeak && attackGuesses && attackGuesses.length && timeLeft() > 6000) {
    const sig = photoSig || (photoBuffer ? await photoSignature(photoBuffer) : null);
    // Collect cards per token, keeping only cards whose real attack list
    // contains the token. Cards matching 2+ tokens (e.g. Hammer + Lanche,
    // both inside "Hammer-lanche") are almost certainly the right card.
    const byCard = new Map();
    // Drop junk tokens before searching: OCR truncations and merged
    // rule-text words ('Damag', 'Thisiattack', 'Discarded') match
    // hundreds of cards and burn the rescue slots the real tokens
    // (e.g. Hammer + Lanche) need. Same rules as the OCR-side filter.
    let tokenList = (attackGuesses || [])
      .filter((t) => !rescueTokenIsJunk(t))
      .slice(0, 10);
    // A read token confirms a card when a printed title contains it —
    // or when the token is an OCR glue-merge that CONTAINS the title's
    // first word ("InfernaljRe" read off "Infernal Reign": the search
    // fetches the card via its clean token "Reign", and this check is
    // what lets the glued twin count as the second confirmation).
    const tokenConfirms = (attacks, token) => {
      const tokL = String(token || '').toLowerCase();
      if (!tokL) return false;
      return (attacks || []).some((a) => {
        const al = String(a || '').toLowerCase();
        if (al.includes(tokL)) return true;
        const first = al.split(/[^a-z]+/).filter(Boolean)[0] || '';
        return tokL.length >= 6 && first.length >= 5 && tokL.includes(first);
      });
    };
    const collect = async () => {
      const perToken = await Promise.allSettled(tokenList.map((t) => pokemontcgSearchAttack(t)));
      perToken.forEach((res, ti) => {
        if (res.status !== 'fulfilled') return;
        const token = tokenList[ti];
        for (const c of res.value || []) {
          if (!tokenConfirms(c.attacks, token)) continue;
          const key = c.id;
          const rec = byCard.get(key) || { card: c, tokens: new Set() };
          rec.tokens.add(token);
          byCard.set(key, rec);
        }
      });
      // Crediting pass: a card fetched by ONE token's search is checked
      // against ALL of them. Without this, a card whose clean token
      // ("Reign") fetched it never got credit for its glued twin
      // ("InfernaljRe" — a search for the glued form returns nothing),
      // and the two-confirmation bar was unreachable for exactly the
      // cards the fuzzy check exists for.
      for (const rec of byCard.values()) {
        for (const t of tokenList) {
          if (!rec.tokens.has(t) && tokenConfirms(rec.card.attacks, t)) rec.tokens.add(t);
        }
      }
    };
    await collect();
    // The attack-search API is flaky (documented ~25%+ failure): if no
    // card confirmed 2+ tokens, one more round after a breath — a
    // two-token confirmation (Hammer + Lanche) is the whole rescue.
    // Round 2 only re-searches the top-3 (highest-voted) tokens and
    // only while the deadline still has real room.
    if (tokenList.length >= 2 && ![...byCard.values()].some((r) => r.tokens.size >= 2) && timeLeft() > 9000) {
      await new Promise((r) => setTimeout(r, 1500));
      const fullList = tokenList;
      tokenList = tokenList.slice(0, 3);
      await collect();
      tokenList = fullList;
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
      // 20/token: three independently-read attack words ALL printed on
      // one card is near-proof (a promo Dialga ex confirming Bellow +
      // Metal + Blast must outrank a same-name print confirming two).
      let score = 40 + tokens.size * 20 + imgSim * 40;
      if (numMatch) score += 40;
      return {
        ...c, score: Math.round(score), imageMatch: Math.round(imgSim * 100) / 100,
        viaAttack: [...tokens].join('+'),
        numberMatch: numMatch && !primaryIsBare,
        bareNumMatch: numMatch && primaryIsBare,
        nameSim: round2(bestNameSim(c.name)), attackTokens: tokens.size,
      };
    }));
    for (const r of rescued) if (r) candidates.push(r);
    candidates.sort((a, b) => b.score - a.score);
  }

  // Name fallback last: only when the rescue produced nothing at all.
  if (candidates.length === candidatesBeforeRescue) await runNameFallback();

  // Digit-variant last resort: nothing displayable, but the book holds
  // a candidate whose NAME matches strongly, whose SET TOTAL matches
  // the read exactly, and whose number is exactly ONE digit off the
  // read (the classic OCR shape confusion — a glare photo read 011/94
  // for a printed 013/94 while its "(011,094" comma twin proved the
  // total). The exact-read card keeps its full +100; a variant earns a
  // discounted number match (+70) and still has to survive the gate
  // and the hybrid's picture veto. One digit only, same total, strong
  // name — all three, or it stays a mention.
  if (primaryNum && !primaryNum.bare && primaryNum.total
    && !candidates.some((c) => gateOf(c).displayable)) {
    const readPadded = String(primaryNum.padded || primaryNum.num).padStart(3, '0');
    const oneDigitOff = (num) => {
      const p = String(num || '').replace(/^0+(?=\d)/, '').padStart(3, '0');
      if (p.length !== readPadded.length) return false;
      let diff = 0;
      for (let i = 0; i < p.length; i++) if (p[i] !== readPadded[i]) diff++;
      return diff === 1;
    };
    for (const c of candidates) {
      if (c.numberMatch || c.bareNumMatch) continue;
      if ((c.nameSim || 0) < 0.8) continue;
      if (!c.setTotal || String(c.setTotal) !== String(primaryNum.total)) continue;
      if (!oneDigitOff(c.number)) continue;
      c.numberMatch = true;
      c.digitVariant = true;
      c.score += 70;
    }
    candidates.sort((a, b) => b.score - a.score);
  }

  // Price backfill: TCGdex carries no TCGplayer price for some cards
  // (Black Star promos especially — svp-180 is Cardmarket-only there),
  // which would leave a correctly identified card unusable in a trade
  // verdict. If the top candidate has no price, ask the fallback book
  // for the exact same card (name + number) and borrow its price.
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length && candidates[0].price === null && timeLeft() > 5000) {
    try {
      const top = candidates[0];
      const alt = await pokemontcgSearch(top.name, top.number);
      const hit = (alt || []).find(
        (c) => c.name === top.name && numEq(c.number, top.number) && c.price !== null && c.price !== undefined
      );
      if (hit) {
        top.price = hit.price;
        if (!top.variants || !Object.keys(top.variants).length) top.variants = hit.variants;
        top.priceSource = 'pokemontcg';
      }
    } catch { /* best-effort */ }
  }

  // Phase 2 intersection boost: when picture-matching independently
  // ranked this exact print in its top-25, two channels agree — worth a
  // real score bump (it can lift an OCR candidate over the gate's raw
  // score line and re-orders rivals honestly). Identity = normalized
  // name + localId, stable across the TCGdex/pokemontcg id schemes.
  if (pictPool && pictPool.length) {
    const poolMap = new Map();
    for (const p of pictPool) {
      const k = normName(p.name) + '|' + String(p.number ?? '').replace(/^0+/, '');
      if (!poolMap.has(k)) poolMap.set(k, p);
    }
    for (const c of candidates) {
      const k = normName(c.name) + '|' + String(c.number ?? '').replace(/^0+/, '');
      const hit = poolMap.get(k);
      if (hit) {
        c.pictSim = hit.sim;
        c.pictRank = hit.rank;
        c.score += 25;
        c.viaPicture = true;
      }
    }
    candidates.sort((a, b) => b.score - a.score);
  }

  // Confidence gate: tag every candidate displayable or not (one-token
  // attack-only guesses get score-capped here too), then rank —
  // displayable candidates first, so a proven card is never cut from
  // the returned 3 in favor of higher-scored unproven filler. The full
  // list still goes back for the grown-ups/debug view; the client only
  // ever shows pictures for displayable ones.
  for (const c of candidates) applyGate(c);
  candidates.sort((a, b) => ((b.displayable ? 1 : 0) - (a.displayable ? 1 : 0)) || (b.score - a.score));
  return candidates.slice(0, 3);
}

export { fetchJson, applyGate, gateOf };
