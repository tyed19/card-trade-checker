// Hybrid identification: picture-matching proposes, OCR confirms/rescues.
//
// Zone policy (calibration evidence in docs/PHASE2-BUILD.md — measured
// top-1 margins cannot separate right from wrong picture picks, so the
// collector-number co-signal against the picture pool does):
//   picture-confident  sim >= 0.80, margin >= 0.01, no same-name rival
//                      in the top-5 -> catalog answer, no OCR at all.
//   picture-neighbor   sim >= 0.80 with same-name/same-art rivals ->
//                      number-band-only OCR disambiguates the print;
//                      if it can't, the rival prints are all offered
//                      (the kid's eyes break the tie).
//   picture-ambiguous  sim >= 0.70 otherwise -> number-band cross-check
//                      against the picture top-10; a pool member whose
//                      localId matches ANY OCR number guess (full or
//                      bare) wins with numberMatch evidence. No match ->
//                      full OCR pipeline with the picture pool as an
//                      intersection boost, plus picture candidates that
//                      earn a co-signal from the full reading. An OCR
//                      numberMatch always outranks art similarity.
//   ocr-fallback       sim < 0.70 (or picture path unavailable) ->
//                      today's full OCR pipeline, untouched.
// The picture path races a ~20s soft budget; on timeout/failure the
// request falls through to OCR rather than dying.

import { matchPhoto, catalogEntry, candidateFromCatalog } from './pictmatch.js';
import { readCardPhoto } from './ocr.js';
import { findCandidates, applyGate } from './identify.js';
import { nameSimilarity, normName, pokemontcgSearch } from './cardbook.js';

const PICT_BUDGET_MS = 20000;
const CONF_SIM = 0.80;
const CONF_PURE_SIM = 0.86; // above every observed wrong pick (max .833)
const CONF_MARGIN = 0.01;
const AMBIG_FLOOR = 0.70;
const POOL_N = 60;   // picture pool depth: art nominates widely…
const CHECK_N = 60;  // …the number cross-check scans the whole pool
const BOOST_N = 25;  // findCandidates intersection boost uses the top-25

const strip0 = (s) => String(s ?? '').replace(/^0+/, '') || '0';
const numEqLoose = (a, b) => strip0(a) === strip0(b);
// Same-name grouping key. normName() erases non-Latin scripts entirely
// (a Japanese name collapses to its Latin suffix junk, e.g. "v"), which
// made UNRELATED Japanese cards look like one same-name group — never
// group on a key shorter than 3 chars; fall back to the raw name.
export function nameKey(name) {
  const n = normName(name);
  return n.length >= 3 ? n : String(name || '').trim().toLowerCase();
}
const identityKey = (name, number) => nameKey(name) + '|' + strip0(number);
const round2 = (n) => Math.round((n || 0) * 100) / 100;

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label || 'timeout')), ms)),
  ]);
}

// Japanese-printing signal from the OCR slice texts: JP cards print a
// lowercase set code ("s10b") and letter rarities ("RRR") on the
// illustrator line; EN cards print neither.
function jpSignal(reading) {
  if (!reading || !reading.debug) return false;
  const texts = [...(reading.debug.numberTexts || []), ...(reading.debug.nameTexts || [])].join(' \n ');
  return /\bs\d{2}[a-z]\b/.test(texts) || /\bRRR\b/.test(texts);
}

// Does OCR number guess g claim pool member p? Returns 'full', 'bare',
// or null. A FULL NNN/TTT guess only claims a member whose printed set
// total agrees (when both are known): #106 in a 94-card set is a
// different card from #106 in a 98-card set — comparing localIds alone
// crowned a Japanese Skuntank V for the Meowth photo. Exception (the
// twin rule): when the photo reads as a JAPANESE printing (jp), an EN
// pool member may claim on localId alone — JP and EN printings of one
// set carry different totals (s10b 050/071 vs Pokémon GO #050 of 78),
// and the EN twin is exactly the fallback for sets missing from JA data.
function matchKind(g, p, jp = false) {
  // Celebrations Classic Collection rows carry a printedNum alias: the
  // physical card prints the ORIGINAL set's number (Dark Gyarados
  // prints 8/82) while its catalog localId is CC005 and it has no
  // TCGdex image at all. Matching uses the printed identity when the
  // catalog row carries one (see data/cc-overrides.json).
  const printedNum = p.entry.printedNum ?? p.entry.localId;
  if (!numEqLoose(g.num, printedNum)) return null;
  if (g.bare) return 'bare';
  if (jp && p.lang === 'en') return 'full';
  const effTotal = p.entry.printedTotal ?? p.entry.setTotal;
  if (g.total && effTotal && Number(g.total) !== Number(effTotal)) return null;
  return 'full';
}

// The set code printed on a Japanese card's illustrator line ("s10b"),
// when the OCR slices caught it. Decisive between same-number sets:
// s10a and s10b both print totals of 71, so 050/071 alone cannot tell a
// Dark Phantasma card from a Pokémon GO one — the code can.
function jpSetCode(reading) {
  if (!reading || !reading.debug) return null;
  const texts = [...(reading.debug.numberTexts || []), ...(reading.debug.nameTexts || [])].join(' ').toLowerCase();
  const m = texts.match(/\b(s\d{1,2}[a-z]|sv\d{1,2}[a-z]?|sm\d{1,2}[a-z]?|m\d{1,2}[a-z]?)\b/);
  return m ? m[1] : null;
}

// Name-fragment agreement: an OCR name guess whose token (len >= 5) is
// a near-match of a pool card's name token ("Tvranitar" ~ "Tyranitar",
// sim 0.89). Garbled full-name reads fail nameSimilarity's 0.8 bar even
// when one strong token survives — this catches the survivor.
function nameFragHit(guesses, poolName) {
  const poolTokens = String(poolName || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 5);
  if (!poolTokens.length) return false;
  for (const g of guesses || []) {
    const toks = String(g || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 5);
    for (const t of toks) {
      for (const pt of poolTokens) {
        if (Math.abs(t.length - pt.length) <= 2 && nameSimilarity(t, pt) >= 0.72) return true;
      }
    }
  }
  return false;
}

async function priceBackfill(cand) {
  if (!cand || (cand.price !== null && cand.price !== undefined)) return;
  if (cand.lang && !String(cand.lang).startsWith('en')) return;
  try {
    // Best-effort only: the fallback book is flaky and its retry chain
    // can eat 20s+ — never let a price fill endanger the request.
    const alt = await withTimeout(pokemontcgSearch(cand.name, cand.number), 6000, 'backfill-timeout').catch(() => null);
    const hit = (alt || []).find(
      (c) => c.name === cand.name && numEqLoose(c.number, cand.number) && c.price !== null && c.price !== undefined
    );
    if (hit) { cand.price = hit.price; cand.priceUSD = hit.price; cand.priceSource = 'pokemontcg'; }
  } catch { /* best-effort */ }
}

async function ocrPath(buffer, deadlineAt, pictPoolLight, zone) {
  const t0 = Date.now();
  const reading = await readCardPhoto(buffer);
  const candidates = await findCandidates({
    ...reading, photoBuffer: buffer, deadlineAt, pictPool: pictPoolLight,
  });
  return { zone, reading, candidates, ocrMs: Date.now() - t0 };
}

export async function identifyPhoto(buffer, { deadlineAt = 0 } = {}) {
  const t0 = Date.now();
  let pict = null;
  try {
    pict = await withTimeout(matchPhoto(buffer, { topK: POOL_N }), PICT_BUDGET_MS, 'pict-timeout');
  } catch { pict = null; }

  if (!pict || !pict.ranked.length) {
    const r = await ocrPath(buffer, deadlineAt, null, pict ? 'ocr-fallback' : 'ocr-only');
    return { ...r, pict, pictMs: Date.now() - t0 - (r.ocrMs || 0) };
  }

  // Resolve the picture pool against the catalog. All POOL_N entries
  // stay light ({entry, name, number}); full priced candidates are
  // built lazily for the few entries a zone actually returns.
  const pool = [];
  for (const r of pict.ranked) {
    const entry = await catalogEntry(r.lang, r.id).catch(() => null);
    if (!entry) continue;
    pool.push({ ...r, entry, name: entry.name, number: String(entry.localId ?? '') });
  }
  const poolLight = pool.slice(0, BOOST_N).map((p) => ({ name: p.name, number: p.number, sim: p.sim, rank: p.rank }));
  const ensureCand = async (p) => {
    if (!p.cand) p.cand = await candidateFromCatalog(p.entry, { sim: p.sim, rank: p.rank });
    return p.cand;
  };
  for (const p of pool.slice(0, 5)) await ensureCand(p);

  if (pict.topSim < AMBIG_FLOOR) {
    const r = await ocrPath(buffer, deadlineAt, poolLight, 'ocr-fallback');
    return { ...r, pict, pictMs: pict.timings.totalMs };
  }

  const top = pool[0];
  const topKey = nameKey(top.entry.name);
  const nameGroup = pool.slice(0, 5).filter(
    (p) => nameKey(p.entry.name) === topKey && p.sim >= top.sim - 0.03
  );
  const neighborThreat = nameGroup.length > 1;

  // ---- pure-picture lane: only for art matches stronger than every
  // observed wrong pick, with a real margin and no same-name rivals.
  // (0.80–0.86 always takes the number co-signal below — a wrong card
  // measured sim .8322 on a real photo, so that band is never trusted
  // on art alone.)
  if (pict.topSim >= CONF_PURE_SIM && pict.margin >= CONF_MARGIN && !neighborThreat) {
    const cand = top.cand;
    cand.pictConfident = true;
    cand.score = Math.round(top.sim * 200);
    applyGate(cand);
    await priceBackfill(cand);
    return { zone: 'picture-confident', reading: null, candidates: [cand], pict, ocrMs: 0, pictMs: pict.timings.totalMs };
  }

  // ---- ambiguous / neighbor: number-band cross-check against the pool ----
  const targets = pool.slice(0, CHECK_N).map((p) => String(p.entry.localId ?? ''));
  const numReading = await readCardPhoto(buffer, {
    only: 'number', numberTargets: targets, budgetMs: 9000,
  }).catch(() => null);
  const guesses = (numReading && numReading.numberGuesses) || [];
  const jp = jpSignal(numReading);
  const matched = pool.slice(0, CHECK_N)
    .map((p) => {
      let kind = null;
      for (const g of guesses) {
        const k = matchKind(g, p, jp);
        if (k === 'full') { kind = 'full'; break; }
        if (k === 'bare') kind = 'bare';
      }
      return kind ? { p, kind } : null;
    })
    .filter(Boolean);

  if (matched.length) {
    // A full-number winner outranks bare winners entirely (a stray bare
    // guess — e.g. the HP read as a number — must not add junk choices
    // beside a real full match).
    let winners = matched.some((w) => w.kind === 'full')
      ? matched.filter((w) => w.kind === 'full')
      : matched;
    if (jp) {
      const jaW = winners.filter((w) => w.p.lang === 'ja');
      const enW = winners.filter((w) => w.p.lang === 'en');
      const code = jpSetCode(numReading);
      if (code) {
        const codeW = winners.filter((w) => String(w.p.entry.setId).toLowerCase() === code);
        if (codeW.length) winners = codeW;
        else if (enW.length) winners = enW; // the JP set is missing from JA data → EN twin
        else if (jaW.length) winners = jaW;
      } else if (jaW.length && enW.length) {
        // JA print and EN twin both matched the number and no set code
        // was read: offer both — when the art is roughly tied the twin
        // leads (the EN book is this family's primary), a clearly
        // stronger JA art match leads instead.
        const bestJa = Math.max(...jaW.map((w) => w.p.sim));
        const bestEn = Math.max(...enW.map((w) => w.p.sim));
        winners = bestEn >= bestJa - 0.02 ? [...enW, ...jaW] : [...jaW, ...enW];
      } else if (jaW.length) {
        winners = jaW;
      }
    }
    const out = [];
    for (const w of winners) {
      const cand = await ensureCand(w.p);
      if (w.kind === 'bare') cand.bareNumMatch = true; else cand.numberMatch = true;
      // Score mirrors the OCR book's own weights (full +100, bare +30):
      // a bare winner must NOT clear the gate's raw-score line on its
      // own — it displays only via the bare + art-corroboration clause.
      cand.score = Math.round((w.kind === 'bare' ? 30 : 100) + w.p.sim * 55);
      // JP photo: any EN winner is the twin stand-in — label it proxy
      // so the grown-ups layer can say the price is the English twin's.
      if (jp && cand.lang === 'en') { cand.proxy = true; cand.lang = 'en-proxy'; }
      applyGate(cand);
      await priceBackfill(cand);
      out.push(cand);
    }
    // Displayable first; within that, keep the winner-selection order
    // (pool art order / twin preference) — it is the print-level signal.
    out.sort((a, b) => ((b.displayable ? 1 : 0) - (a.displayable ? 1 : 0)));
    if (out.some((c) => c.displayable)) {
      return {
        zone: neighborThreat ? 'picture-neighbor' : 'picture+number',
        reading: numReading, candidates: out, pict,
        ocrMs: (numReading && numReading.ocrTiming && numReading.ocrTiming.stagesMs.total) || 0,
        pictMs: pict.timings.totalMs,
      };
    }
    // Matches existed but none earned displayable (e.g. a bare number
    // with weak art) — do not settle; escalate to the full pipeline.
  }

  // Neighbor fallback: the number read split nothing — offer the whole
  // same-art group; the kid's eyes are the tiebreak.
  if (neighborThreat && pict.topSim >= CONF_SIM) {
    const out = [];
    for (const p of nameGroup) {
      if (!p.cand) p.cand = await candidateFromCatalog(p.entry, { sim: p.sim, rank: p.rank });
      const cand = p.cand;
      cand.pictNeighbor = true;
      cand.score = Math.round(p.sim * 200);
      applyGate(cand);
      out.push(cand);
    }
    return {
      zone: 'picture-neighbor', reading: numReading, candidates: out,
      ocrMs: (numReading && numReading.ocrTiming && numReading.ocrTiming.stagesMs.total) || 0,
      pictMs: pict.timings.totalMs,
    };
  }

  // ---- escalation: full OCR, pool as intersection boost + co-signals ----
  const reading = await readCardPhoto(buffer);
  // The cross-check already paid for a number cascade: union its guesses
  // into the full reading so that work is never thrown away (the full
  // read can come back thinner when its own budget cuts passes short).
  if (numReading && (numReading.numberGuesses || []).length) {
    const seen = new Set((reading.numberGuesses || []).map((g) => `${g.padded}/${g.total || ''}/${g.bare ? 'b' : ''}`));
    for (const g of numReading.numberGuesses) {
      const k = `${g.padded}/${g.total || ''}/${g.bare ? 'b' : ''}`;
      if (!seen.has(k)) { reading.numberGuesses.push(g); seen.add(k); }
    }
    if (!reading.numberGuess && numReading.numberGuess) reading.numberGuess = numReading.numberGuess;
  }
  let candidates = await findCandidates({
    ...reading, photoBuffer: buffer, deadlineAt, pictPool: poolLight,
  });
  const inResults = new Set(candidates.map((c) => identityKey(c.name, c.number)));
  const jpFull = jpSignal(reading) || jp;
  for (const p of pool.slice(0, CHECK_N)) {
    if (inResults.has(identityKey(p.entry.name, p.entry.localId))) continue;
    let gMatch = null, gKind = null;
    for (const g of reading.numberGuesses || []) {
      const k = matchKind(g, p, jpFull);
      if (k === 'full') { gMatch = g; gKind = 'full'; break; }
      if (k === 'bare' && !gMatch) { gMatch = g; gKind = 'bare'; }
    }
    const nSim = Math.max(0, ...(reading.nameGuesses || []).map((g) => nameSimilarity(g, p.entry.name)));
    const coNumber = !!gMatch;
    const coName = nSim >= 0.8 && p.sim >= 0.78;
    // Fragment agreement is the weakest co-signal — one name token
    // ("Charizard") is shared by ~50 prints — so its art bar sits
    // above the shiny-mush band (0.78-0.83), not at it: a Mega
    // Charizard phone photo crowned a Power Keepers Charizard ex at
    // sim 0.8264 on a fragment hit alone. Full-name agreement
    // (coName) keeps the 0.78 floor; a bare fragment needs 0.84.
    const coFrag = !coNumber && !coName && p.sim >= 0.84 && nameFragHit(reading.nameGuesses, p.entry.name);
    if (!coNumber && !coName && !coFrag) continue;
    const cand = await ensureCand(p);
    if (coNumber) { if (gKind === 'bare') cand.bareNumMatch = true; else cand.numberMatch = true; }
    if (coFrag) cand.pictNameArt = true;
    cand.nameSim = round2(nSim);
    // Score: number evidence mirrors the book (full +100 / bare +30);
    // a name co-signal scores like the book's name channel (55 x sim)
    // PLUS the art channel (55 x pictSim) so a true name+art agreement
    // can clear the gate's name clause (nameSim >= 0.8 and score >= 90).
    cand.score = Math.round(
      (coNumber ? (gKind === 'bare' ? 30 : 100) : coName ? 55 * nSim : 40) + p.sim * 55
    );
    applyGate(cand);
    if (cand.displayable) candidates.push(cand);
  }
  // Picture veto: when art has a strong opinion (topSim >= 0.80) an
  // OCR-book winner that agrees with the picture on NOTHING — absent
  // from the picture top-60, zero image-hash match, weak name, no
  // attack confirmation — is presumed a flipped-digit read (the
  // Tyranitar 064->004 case crowned Budew with exactly this profile)
  // and demoted to a non-displayable mention. Any single corroborating
  // channel saves the candidate.
  if (pict.topSim >= CONF_SIM) {
    const poolKeys = new Set(pool.map((p) => identityKey(p.entry.name, p.entry.localId)));
    for (const c of candidates) {
      if (!c.displayable || c.source === 'catalog') continue;
      if (poolKeys.has(identityKey(c.name, c.number))) continue;
      if ((c.imageMatch || 0) >= 0.65) continue; // dHash in the .5s is noise (a green Garbodor scored .57 vs a Flapple photo)
      if ((c.nameSim || 0) >= 0.5) continue;
      if ((c.attackTokens || 0) >= 2) continue;
      c.displayable = false;
      c.demotedByPicture = true;
    }
  }
  // JP proxy tagging: the photo is a Japanese printing, everything
  // displayable is the EN book's twin, and no JA printing is on offer.
  if (jpFull && candidates.some((c) => c.displayable)
    && !candidates.some((c) => c.displayable && c.lang === 'ja')) {
    for (const c of candidates) {
      if (c.displayable && c.lang !== 'ja') {
        c.proxy = true; c.lang = 'en-proxy';
      }
    }
  }
  // Final ordering: displayable first; when art is strong, pool members
  // order by art similarity ahead of book-only candidates (art is the
  // only print-level signal when the number band failed — the Dialga
  // promo case, where three wrong Dialga prints outscored the true one
  // on name evidence alone).
  const poolKeysAll = new Set(pool.map((p) => identityKey(p.entry.name, p.entry.localId)));
  const inPool = (c) => c.source === 'catalog' || poolKeysAll.has(identityKey(c.name, c.number));
  candidates.sort((a, b) => {
    const d = ((b.displayable ? 1 : 0) - (a.displayable ? 1 : 0));
    if (d) return d;
    if (pict.topSim >= CONF_SIM) {
      const ip = (inPool(b) ? 1 : 0) - (inPool(a) ? 1 : 0);
      if (ip) return ip;
      const ps = (b.pictSim || 0) - (a.pictSim || 0);
      if (ps) return ps;
    }
    return (b.score || 0) - (a.score || 0);
  });
  return {
    zone: 'picture+ocr', reading, candidates: candidates.slice(0, 6), pict,
    ocrMs: ((numReading && numReading.ocrTiming && numReading.ocrTiming.stagesMs.total) || 0)
      + ((reading.ocrTiming && reading.ocrTiming.stagesMs.total) || 0),
    pictMs: pict.timings.totalMs,
  };
}
