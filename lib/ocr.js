// Server-side OCR for card photos.
//
// What actually works (tuned on real photos of real cards):
//  - Collector number: tight slices along the bottom-left, PSM 11
//    (sparse text), grayscale + normalize, some slices negated
//    (light text on gold/dark bars). Collect every "NNN/TTT" match and vote.
//  - Card name: thin slices across the top at several heights, PSM 11,
//    plain + negated. The name font is stylized, so we return several
//    cleaned guesses and let the card-book match decide which is real.

import sharp from 'sharp';
import path from 'node:path';
import { createRequire } from 'node:module';
import { locateCard } from './locate.js';

const require = createRequire(import.meta.url);

let tessPromise = null; // Promise<{ worker, call }> — see spawnTess()
let ocrChain = Promise.resolve(); // serialize jobs (worker params are global)
let activeDeadline = 0; // ms epoch; passes stop starting once past it
let stageStats = null; // per-read timing evidence (returned to the route)

const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
]);

let initAttempts = []; // evidence: worker-init outcome/timing
let initLog = []; // kept for response-shape compatibility

// ---------------------------------------------------------------------------
// Tesseract is driven through its RAW worker protocol, not createWorker().
// Why (all proven live on Vercel, 2026-10-03):
//  - createWorker() never settled on Vercel in ANY config (init-timeout
//    at 14–25s, zero logger progress, zero passes) while the identical
//    code initialized in ~0.6s locally — some bundler/runtime interop in
//    its main-thread plumbing silently deadlocks there.
//  - The raw protocol from this same route code works live: spawn the
//    worker script by absolute fs path (paths via process.cwd(), NEVER
//    require.resolve — the bundler shims it to a numeric module id),
//    then load -> loadLanguage -> initialize answered in ~250/290ms.
// ---------------------------------------------------------------------------

function tessPaths() {
  // Built via array joins on purpose: a literal path.join(process.cwd(),
  // 'node_modules', ...) makes Turbopack try to ingest the whole project
  // root as a context module (it failed the build on README.md).
  const seg = (...parts) => [process.cwd(), ...parts].join(path.sep);
  return {
    script: seg('node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
    corePath: seg('node_modules', 'tesseract.js-core'),
    langPath: seg('node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
  };
}

async function spawnTess() {
  const fs = await import('node:fs');
  const { Worker } = await import('node:worker_threads');
  const paths = tessPaths();
  const pathsOk = Object.fromEntries(
    Object.entries(paths).map(([k, v]) => [k, fs.existsSync(v)])
  );
  const t0 = Date.now();
  const worker = new Worker(paths.script);
  const pending = new Map();
  let seq = 0;
  worker.on('message', (m) => {
    if (!m || !m.jobId) return;
    const p = pending.get(m.jobId);
    if (!p) return;
    if (m.status === 'resolve') { pending.delete(m.jobId); p.resolve(m.data); }
    else if (m.status === 'reject') { pending.delete(m.jobId); p.reject(new Error(String(m.data))); }
    // 'progress' messages need no handling
  });
  worker.on('error', (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });
  const call = (action, payload, timeoutMs) => new Promise((resolve, reject) => {
    const jobId = 'j' + (++seq);
    const timer = setTimeout(() => {
      pending.delete(jobId);
      reject(new Error(action + '-timeout'));
    }, timeoutMs);
    pending.set(jobId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    worker.postMessage({ workerId: 'ctc', jobId, action, payload });
  });
  await call('load', { options: { lstmOnly: true, corePath: paths.corePath, logging: false } }, 20000);
  await call('loadLanguage', {
    langs: 'eng',
    options: {
      langPath: paths.langPath, dataPath: null, cachePath: '/tmp',
      cacheMethod: 'none', gzip: true, lstmOnly: true,
    },
  }, 20000);
  await call('initialize', { langs: 'eng', oem: 1, config: {} }, 20000);
  if (stageStats) stageStats.workerInitMs = Date.now() - t0;
  initAttempts.push({ label: 'raw-protocol', ms: Date.now() - t0, ok: true, pathsOk });
  return { worker, call, paramsKey: '' };
}

function getTess() {
  if (!tessPromise) {
    tessPromise = spawnTess().catch((err) => {
      initAttempts.push({ label: 'raw-protocol', error: String(err && err.message || err) });
      tessPromise = null;
      throw err;
    });
  }
  return tessPromise;
}

async function killTess() {
  const p = tessPromise;
  tessPromise = null;
  try {
    const t = await p;
    await t.worker.terminate();
  } catch { /* already dead */ }
}

async function recognize(buffer, { psm = '11', whitelist = '' } = {}) {
  if (activeDeadline && Date.now() > activeDeadline) throw new Error('ocr-budget-exceeded');
  const run = async () => {
    if (activeDeadline && Date.now() > activeDeadline) throw new Error('ocr-budget-exceeded');
    let tess;
    try {
      tess = await getTess();
    } catch (err) {
      if (stageStats) stageStats.lastError = 'getTess: ' + String(err && err.message || err);
      throw err;
    }
    // Every pass uses the same PSM/whitelist, so only pay the
    // setParameters round trip when they actually change (many-pass
    // cards were spending ~a third of their time re-setting them).
    const paramsKey = psm + '|' + (whitelist || '');
    if (tess.paramsKey !== paramsKey) {
      try {
        await tess.call('setParameters', {
          params: {
            tessedit_pageseg_mode: psm,
            tessedit_char_whitelist: whitelist || '',
          },
        }, 5000);
        tess.paramsKey = paramsKey;
      } catch { /* non-fatal */ }
    }
    const t0 = Date.now();
    try {
      // A single recognize hanging must not eat the whole budget: cap
      // it, and rebuild the worker — a wedged worker does not recover.
      const data = await tess.call('recognize', {
        image: new Uint8Array(buffer),
        options: {},
        output: { text: true },
      }, 8000);
      if (stageStats) { stageStats.passes++; stageStats.passMs += Date.now() - t0; }
      return (data && data.text) || '';
    } catch (err) {
      if (stageStats) {
        stageStats.timeouts++; stageStats.passMs += Date.now() - t0;
        stageStats.lastError = String(err && err.message || err);
      }
      if (String(err && err.message) === 'recognize-timeout') killTess();
      throw err;
    }
  };
  const result = ocrChain.then(run, run);
  ocrChain = result.catch(() => {});
  return result;
}

// ---------- image prep ----------

async function slice(img, meta, { l, t, w, h }, { width = 2000, negate = false, thresh = 0, fmt = 'jpeg' } = {}) {
  const left = Math.max(0, Math.round(l * meta.width));
  const top = Math.max(0, Math.round(t * meta.height));
  const cw = Math.min(meta.width - left, Math.round(w * meta.width));
  const ch = Math.min(meta.height - top, Math.round(h * meta.height));
  let pipe = sharp(img).extract({ left, top, width: cw, height: ch }).resize({ width });
  if (negate) pipe = pipe.negate();
  pipe = pipe.grayscale().normalize();
  if (thresh) pipe = pipe.threshold(thresh);
  pipe = pipe.sharpen();
  // PNG for the tiny-print bands (number/name): JPEG artifacts at these
  // text sizes measurably hurt digit OCR. JPEG is fine for attack bands.
  return fmt === 'png' ? pipe.png().toBuffer() : pipe.jpeg({ quality: 88 }).toBuffer();
}

// ---------- number ----------

const NUMBER_BOXES = [
  // Tight slices first: badge + digits only. Two layout traps make
  // the wide legacy boxes miss modern numbers entirely (proven by
  // grid probe on a real Victini photo): a wide slice lets the
  // layout analysis latch onto the flavor text sharing the number's
  // line, and a slice whose TOP EDGE cuts through the digit glyphs
  // gets the whole digit block discarded. The digit line sits just
  // under the illustrator line (card-rel y ~0.855-0.93), so these
  // start at/above the illustrator line with the digits inside.
  { l: 0.1, t: 0.85, w: 0.3, h: 0.06 },
  { l: 0.13, t: 0.865, w: 0.28, h: 0.055 },
  { l: 0.16, t: 0.875, w: 0.26, h: 0.05 },
  { l: 0.2, t: 0.855, w: 0.35, h: 0.04 },
  { l: 0.12, t: 0.77, w: 0.36, h: 0.06 },
  { l: 0.18, t: 0.782, w: 0.28, h: 0.045 },
  { l: 0.05, t: 0.755, w: 0.55, h: 0.1 },
  { l: 0.08, t: 0.82, w: 0.45, h: 0.06 },
  { l: 0.08, t: 0.855, w: 0.45, h: 0.06 },
  { l: 0.05, t: 0.88, w: 0.55, h: 0.07 },
];

export function numbersFromText(text) {
  const out = [];
  const push = (num, total) => {
    // sanity: collector numbers are >=1, totals are plausible set sizes,
    // and a card number never exceeds ~2.2x the printed total (secret rares)
    if (num >= 1 && total >= 40 && total <= 400 && num <= total * 2.2 + 10) {
      out.push({ num: String(num), padded: String(num).padStart(3, '0'), total: String(total) });
    }
  };
  const re = /(\d{1,3})\s*\/\s*(\d{1,3})/g;
  let m;
  while ((m = re.exec(text || '')) !== null) push(parseInt(m[1], 10), parseInt(m[2], 10));
  // Repair pass: embossed print makes OCR confuse digit shapes (1E2 -> 132).
  const CONF = { O: '0', o: '0', I: '1', l: '1', '|': '1', S: '5', s: '5', B: '8', E: '3', Z: '2' };
  const re2 = /([0-9OIl|SBsEZ]{1,3})\s*\/\s*([0-9OIl|SBsEZ]{1,3})/g;
  while ((m = re2.exec(text || '')) !== null) {
    const fix = (s) => s.split('').map((c) => CONF[c] ?? c).join('');
    if (/^\d+$/.test(fix(m[1])) && /^\d+$/.test(fix(m[2]))) push(parseInt(fix(m[1]), 10), parseInt(fix(m[2]), 10));
  }
  // Slash read as a digit: modern numbers print zero-padded as NNN/TTT,
  // and "0517142" is "051/142" with the '/' misread as 7 (or 1). Only
  // that exact 7-digit shape is unambiguous enough to repair.
  const re3 = /\b(\d{3})[17](\d{3})\b/g;
  while ((m = re3.exec(text || '')) !== null) push(parseInt(m[1], 10), parseInt(m[2], 10));
  return out;
}

// ---------- bare numbers (promo cards) ----------
// Black Star promos print NO "NNN/TTT" at all — just a bare number on
// the illustrator line next to the promo mark ("SVP EN 180" on a Dialga
// ex promo). The NNN/TTT channel can never fire on these cards, so the
// tight number slices also get scanned for:
//  - a promo prefix glued to digits ("SVP 180", "SWSH255", "SM 210"),
//    which carries a set hint the lookup can corroborate with;
//  - digits right before the rarity star ("180 ★");
//  - a standalone 2-3 digit token in a slice that carries illustrator-
//    line context ('Illus', a promo prefix, or the star) — the number
//    slices only cover the bottom-left strip, so a corroborated lone
//    number there is the collector number, not damage/HP print.
// A bare number repeats across dozens of sets, so downstream it only
// counts with corroboration (name similarity or a verified attack) —
// see the gate in lib/identify.js.
export function bareNumbersFromText(text) {
  const out = [];
  const byNum = new Map();
  const push = (num, hint) => {
    if (!(num >= 1 && num <= 400)) return;
    const key = String(num);
    const existing = byNum.get(key);
    if (existing) {
      if (!existing.hint && hint) existing.hint = hint;
      return;
    }
    const rec = { num: String(num), padded: String(num).padStart(3, '0'), total: null, bare: true, hint: hint || null };
    byNum.set(key, rec);
    out.push(rec);
  };
  const raw = text || '';
  let m;
  // Spaced: "SVP EN 180", "SVP 180", "SVP EN] 094" (bracket junk ok).
  const rePromo = /\b(SVP|SWSH|HGSS|SM|XY|BW|DP)\b\s*(?:EN|JP)?\s*[\]\)]?\s*(\d{1,3})\b/gi;
  while ((m = rePromo.exec(raw)) !== null) push(parseInt(m[2], 10), m[1].toUpperCase());
  // Glued: "SVPEN 094", "SWSH255", "XY174".
  const reGluedLang = /\b(SVP|SWSH|HGSS|SM|XY|BW|DP)(?:EN|JP)\s*(\d{1,3})\b/gi;
  while ((m = reGluedLang.exec(raw)) !== null) push(parseInt(m[2], 10), m[1].toUpperCase());
  const reGluedNum = /\b(SVP|SWSH|HGSS|SM|XY|BW|DP)(\d{1,3})\b/gi;
  while ((m = reGluedNum.exec(raw)) !== null) push(parseInt(m[2], 10), m[1].toUpperCase());
  // Remove full NNN/TTT matches so their digits don't re-fire standalone.
  const stripped = raw.replace(/[0-9OIl|SBsEZ]{1,3}\s*\/\s*[0-9OIl|SBsEZ]{1,3}/g, ' ');
  const reStar = /(\d{1,3})\s*(?:★|\*|✦)/g;
  while ((m = reStar.exec(stripped)) !== null) push(parseInt(m[1], 10), null);
  const hasContext = (s) => /illus/i.test(s)
    || /\b(SVP|SWSH|HGSS|SM|XY|BW|DP)\b/i.test(s)
    || /★/.test(s);
  // A corroborated token can carry OCR damage: one glued letter from
  // the badge ("B180", "180w") or digit-shape confusions ("1B0",
  // "I80"). Repair both before judging it.
  const DIGIT_CONF = { O: '0', o: '0', I: '1', l: '1', '|': '1', S: '5', s: '5', B: '8', E: '3', Z: '2' };
  const tokenToDigits = (tok) => {
    let t = tok;
    if (/^[A-Za-z]\d{2,3}$/.test(t)) t = t.slice(1);
    else if (/^\d{2,3}[A-Za-z]$/.test(t)) t = t.slice(0, -1);
    if (/^\d{2,3}$/.test(t)) return t;
    if (/^[0-9OIl|SBsEZ]{2,3}$/.test(t)) {
      const fixed = t.split('').map((c) => DIGIT_CONF[c] ?? c).join('');
      if (/^\d{2,3}$/.test(fixed)) return fixed;
    }
    return null;
  };
  const scanStandalone = (s) => {
    for (const tok of s.split(/[^A-Za-z0-9]+/)) {
      const d = tokenToDigits(tok);
      if (d) push(parseInt(d, 10), null);
    }
  };
  // Line-level: a standalone 2-3 digit token on a line carrying
  // illustrator-line context. (1-digit tokens are excluded here —
  // weakness "×2" shares these strips; a 1-digit promo number only
  // counts via the promo-prefix or star patterns above.)
  for (const line of stripped.split(/\r?\n/)) {
    if (!hasContext(line)) continue;
    scanStandalone(line);
  }
  // Slice-level: OCR routinely puts 'Illus.' and the digits on
  // DIFFERENT lines of the same thin slice, and mangles the badge
  // itself (a real Dialga promo read "Illus. PLANETA Tsuji" on one
  // line, "sve) 180" on the next). The slice is a ~2-line strip of the
  // card's bottom-left, so context anywhere in it corroborates a
  // 2-3 digit token anywhere in it.
  if (hasContext(stripped)) scanStandalone(stripped);
  return out;
}

// ---------- name ----------

const NAME_BOXES = [
  // Higher slices first: on a localized crop the name line can sit at
  // rel y 0.04-0.09 (the crop's top pad is thin), above the first
  // legacy slice.
  { l: 0.1, t: 0.03, w: 0.76, h: 0.06 },
  { l: 0.12, t: 0.055, w: 0.74, h: 0.055 },
  { l: 0.14, t: 0.085, w: 0.72, h: 0.055 },
  { l: 0.14, t: 0.115, w: 0.72, h: 0.055 },
  { l: 0.14, t: 0.145, w: 0.72, h: 0.055 },
  { l: 0.14, t: 0.175, w: 0.72, h: 0.055 },
  { l: 0.1, t: 0.2, w: 0.76, h: 0.06 },
];

const NAME_STOP_TOKENS = new Set([
  'basic', 'stage', 'stage1', 'stage2', 'hp', 'evolves', 'from', 'the',
  'illus', 'weakness', 'resistance', 'retreat', 'rule', 'when', 'your',
]);
const NAME_JUNK_LINE = /(illus|weakness|resistance|retreat|prize|knocked|©|copyright|nintendo|creatures|game\s*freak|takes|damage)/i;

export function cleanNameLine(rawLine) {
  if (!rawLine || NAME_JUNK_LINE.test(rawLine)) return '';
  let line = rawLine.replace(/[^A-Za-z0-9'\-. ]+/g, ' ').replace(/\s+/g, ' ').trim();
  line = line.replace(/\bHP\b\s*\d*/gi, ' ').replace(/\s+/g, ' ').trim();
  const toks = line.split(' ').filter((t) => {
    if (!t) return false;
    if (/^\d+$/.test(t)) return false;
    if (NAME_STOP_TOKENS.has(t.toLowerCase())) return false;
    return true;
  });
  const dedup = toks.filter((t, i) => i === 0 || t.toLowerCase() !== toks[i - 1].toLowerCase());
  const out = dedup.join(' ').trim();
  if (out.replace(/[^A-Za-z]/g, '').length < 3) return '';
  return out.slice(0, 34);
}

export function getStageStats() { return stageStats; }

function nameRecsFromTexts(texts) {
  const seen = new Map(); // norm -> {name, votes, firstIdx}
  texts.forEach((txt, ti) => {
    (txt || '').split(/\r?\n/).forEach((ln) => {
      const cleaned = cleanNameLine(ln);
      if (!cleaned) return;
      const key = cleaned.toLowerCase();
      const rec = seen.get(key) || { name: cleaned, votes: 0, firstIdx: ti };
      rec.votes++;
      seen.set(key, rec);
    });
  });
  return [...seen.values()]
    .sort((a, b) => (b.votes - a.votes) || (a.firstIdx - b.firstIdx));
}

function nameGuessesFromTexts(texts) {
  return nameRecsFromTexts(texts).map((r) => r.name).slice(0, 6);
}

// ---------- main entry ----------

export async function readCardPhoto(buffer) {
  // Serverless time budget: the whole read must yield control well inside
  // the platform function cap (60s on Vercel Hobby), leaving room for the
  // card-book lookups. Passes stop starting once the budget is spent and
  // whatever was read so far is returned.
  activeDeadline = Date.now() + (parseInt(process.env.OCR_BUDGET_MS || '26000', 10) || 26000);
  stageStats = { workerInitMs: null, passes: 0, passMs: 0, timeouts: 0, stagesMs: {}, initAttempts, initLog };
  const stageT0 = Date.now();
  const rotated = await sharp(buffer).rotate().toBuffer(); // honor EXIF orientation
  const rMeta = await sharp(rotated).metadata();
  // Normalize to a working width once: band fractions are relative, and
  // real card photos (3000px+) make every per-slice decode needlessly slow.
  // 1800 matches the client's upload cap (2400px max dimension = 1800px
  // wide for a portrait shot), so the digits the phone kept survive.
  const img = rMeta.width > 1800
    ? await sharp(rotated).resize({ width: 1800 }).jpeg({ quality: 90 }).toBuffer()
    : rotated;
  const meta = await sharp(img).metadata();
  const debug = { numberTexts: [], nameTexts: [] };
  stageStats.stagesMs.prep = Date.now() - stageT0;

  // --- card localization: the bands below are fractions of the CARD,
  // but real photos leave table margins around it (a card spanning
  // y 0.15-0.92 makes the frame-relative name boxes read tabletop and
  // the number boxes read the weakness bar). Locate the card, crop to
  // it, and run the bands on the crop; the full frame stays as a
  // merged-evidence fallback so a bad crop can never do worse than
  // the old frame-only behavior. ---
  const locateT0 = Date.now();
  const located = await locateCard(img, meta).catch(() => null);
  stageStats.stagesMs.locate = Date.now() - locateT0;
  stageStats.stagesMs.prep += stageStats.stagesMs.locate;
  stageStats.cardBox = located && located.box
    ? {
        l: Math.round(located.box.l * 100) / 100, t: Math.round(located.box.t * 100) / 100,
        w: Math.round(located.box.w * 100) / 100, h: Math.round(located.box.h * 100) / 100,
        mode: located.mode, confidence: Math.round(located.confidence * 100) / 100,
      }
    : { mode: located ? located.mode : 'error' };
  debug.cardBox = stageStats.cardBox;
  let cardFrame = null;
  if (located && located.box && located.mode !== 'frame') {
    try {
      const px = {
        left: Math.max(0, Math.round(located.box.l * meta.width)),
        top: Math.max(0, Math.round(located.box.t * meta.height)),
        width: Math.min(meta.width, Math.round(located.box.w * meta.width)),
        height: Math.min(meta.height, Math.round(located.box.h * meta.height)),
      };
      px.width = Math.min(px.width, meta.width - px.left);
      px.height = Math.min(px.height, meta.height - px.top);
      if (px.width > 60 && px.height > 60) {
        const cbuf = await sharp(img).extract(px).jpeg({ quality: 92 }).toBuffer();
        cardFrame = { img: cbuf, meta: await sharp(cbuf).metadata() };
      }
    } catch { cardFrame = null; }
  }
  const frameFull = { img, meta };
  const framePrimary = cardFrame || frameFull;
  const frameSecondary = cardFrame ? frameFull : null;

  // --- collector number: plain passes on the primary frame, then the
  // full frame as a merged vote source when a crop exists; negated
  // passes only for what still has no votes at all ---
  const numVotes = new Map();
  const addNums = (txt) => {
    for (const n of numbersFromText(txt)) {
      const key = n.padded + '/' + n.total;
      numVotes.set(key, { ...n, votes: (numVotes.get(key)?.votes || 0) + 1 });
    }
  };
  const topNumVotes = () => Math.max(0, ...[...numVotes.values()].map((v) => v.votes));
  // Raw texts of every number slice — kept for the bare-number
  // (promo) scan below. The winning slice for a real promo number was
  // a WIDE legacy box ("Illus. PLANETA Tsuji / sve) 180"), not one of
  // the tight boxes, so collection covers all of them; the bare
  // extractor's own context rules are the safety, not the box choice.
  const tightTexts = [];
  const runNumberBoxes = async (frame, boxes, opts = {}, collect = false) => {
    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi];
      try {
        const b = await slice(frame.img, frame.meta, box, { width: 2000, fmt: 'png', ...opts });
        const txt = await recognize(b, { psm: '11' });
        debug.numberTexts.push((opts.negate ? 'NEG:' : '') + txt.slice(0, 80));
        if (collect) tightTexts.push(txt);
        addNums(txt);
        // Strong consensus (same NNN/TTT from 3+ slices) — stop early.
        if (topNumVotes() >= 3) return;
      } catch { /* next */ }
    }
  };
  await runNumberBoxes(framePrimary, NUMBER_BOXES, {}, true);
  // The full-frame merge costs a second pass set; skip it when the
  // crop already produced a solid read (>=2 agreeing votes from a
  // confident box) — it exists for weak/empty crop reads.
  const solidCropRead = topNumVotes() >= 2 && located && located.confidence >= 0.5;
  if (topNumVotes() < 3 && !solidCropRead && frameSecondary) await runNumberBoxes(frameSecondary, NUMBER_BOXES, {}, true);
  if (!numVotes.size) {
    await runNumberBoxes(framePrimary, NUMBER_BOXES.slice(0, 5), { negate: true }, true);
    if (!numVotes.size && frameSecondary) {
      await runNumberBoxes(frameSecondary, NUMBER_BOXES.slice(0, 5), { negate: true }, true);
    }
  }
  if (!numVotes.size) {
    // Threshold variants of the strip: holo noise over a pale promo
    // bar defeats plain AND negated grayscale on some encodings (one
    // JPEG generation was enough to flip the read on a real Dialga
    // promo). A hard threshold separates the bold digits from shine.
    for (const box of [NUMBER_BOXES[8], NUMBER_BOXES[9], NUMBER_BOXES[0], NUMBER_BOXES[3]]) {
      try {
        const b = await slice(framePrimary.img, framePrimary.meta, box, { width: 2000, fmt: 'png', thresh: 150 });
        const txt = await recognize(b, { psm: '11' });
        debug.numberTexts.push('THR:' + txt.slice(0, 80));
        tightTexts.push(txt);
        addNums(txt);
        if (topNumVotes() >= 2) break;
      } catch { /* next */ }
    }
  }
  let numberGuesses = [...numVotes.values()].sort((a, b) => b.votes - a.votes).slice(0, 3);
  let numberGuess = numberGuesses[0] || null;

  // Bare-number (promo) fallback: no NNN/TTT anywhere, but the tight
  // illustrator-line slices may carry a bare collector number (see
  // bareNumbersFromText). Only consulted when the full-number channel
  // is completely empty — a real NNN/TTT always outranks a bare read.
  const computeBare = () => {
    if (numVotes.size || numberGuess || !tightTexts.length) return;
    const bareVotes = new Map(); // padded -> rec (hint merged in)
    for (const t of tightTexts) {
      for (const b of bareNumbersFromText(t)) {
        const rec = bareVotes.get(b.padded) || { ...b, votes: 0 };
        if (!rec.hint && b.hint) rec.hint = b.hint;
        rec.votes++;
        bareVotes.set(b.padded, rec);
      }
    }
    const bare = [...bareVotes.values()].sort((a, b) => b.votes - a.votes).slice(0, 2);
    if (bare.length) {
      numberGuesses = bare;
      numberGuess = bare[0];
      debug.bareNumbers = bare.map((b) => `${b.hint ? b.hint + ' ' : ''}${b.padded}(${b.votes}v)`);
    }
  };
  computeBare();
  stageStats.stagesMs.number = Date.now() - stageT0 - stageStats.stagesMs.prep;

  // --- card name: plain slices on the primary frame, stop once a
  // usable guess exists. When a crop exists and its best guess is not
  // solid (a bad crop reads art-text junk with 1 vote each), assist
  // with the full frame's most productive heights. Negated slices
  // only when no plain pass anywhere produced a guess. ---
  const nameTexts = [];
  const collectNameTexts = async (frame, boxes, opts = {}) => {
    for (let i = 0; i < boxes.length; i++) {
      try {
        const b = await slice(frame.img, frame.meta, boxes[i], { width: opts.width || 1600, fmt: 'png', ...(opts.negate ? { negate: true } : {}) });
        nameTexts.push(await recognize(b, { psm: '11' }));
      } catch { /* next */ }
      if (i >= 2 && nameGuessesFromTexts(nameTexts).length) break;
    }
  };
  await collectNameTexts(framePrimary, NAME_BOXES);
  if (frameSecondary) {
    const recs = nameRecsFromTexts(nameTexts);
    if (!recs.length || (recs[0].votes || 0) < 3) {
      await collectNameTexts(frameSecondary, NAME_BOXES.slice(0, 3));
    }
  }
  // Weak-name assist: a guess exists but no slice agrees with another
  // (top rec < 3 votes). Holo streaks and silver ex banners wash out
  // the plain grayscale pass — a hard-threshold variant of the top
  // slices often separates the bold name glyphs from the shine. A few
  // extra passes, only when the plain read is genuinely shaky.
  {
    const recs = nameRecsFromTexts(nameTexts);
    if (recs.length && (recs[0].votes || 0) < 3) {
      for (const box of NAME_BOXES.slice(0, 3)) {
        try {
          const b = await slice(framePrimary.img, framePrimary.meta, box, { width: 2000, fmt: 'png', thresh: 150 });
          nameTexts.push(await recognize(b, { psm: '11' }));
        } catch { /* next */ }
      }
    }
  }
  if (!nameGuessesFromTexts(nameTexts).length) {
    await collectNameTexts(framePrimary, NAME_BOXES.slice(0, 3), { negate: true, width: 2000 });
    if (!nameGuessesFromTexts(nameTexts).length && frameSecondary) {
      await collectNameTexts(frameSecondary, NAME_BOXES.slice(0, 3), { negate: true, width: 2000 });
    }
  }
  debug.nameTexts = nameTexts.map((t) => t.replace(/\n/g, ' / ').slice(0, 100));
  let nameGuesses = nameGuessesFromTexts(nameTexts);
  stageStats.stagesMs.name = Date.now() - stageT0 - stageStats.stagesMs.prep - stageStats.stagesMs.number;
  const slideT0 = Date.now();

  // --- sliding-window number scan: no crop was trusted and the fixed
  // boxes found no number, but a name WAS read — the card is in there
  // somewhere, just not where the bands assume. Sweep one wide low
  // slice across the lower half of the frame at several heights and
  // let the distinctive NNN/TTT pattern vote. ---
  if (!numberGuess && nameGuesses.length && !frameSecondary) {
    for (const tOff of [0.60, 0.68, 0.76, 0.84]) {
      // Leave the attack-rescue stage a real share of the budget:
      // the sweep is a nice-to-have, the rescue is a proven channel.
      if (activeDeadline && Date.now() > activeDeadline - 14000) break;
      // Tight slices (see NUMBER_BOXES note): a wide sweep slice
      // reads everything except the digits.
      for (const lOff of [0.08, 0.22]) {
        try {
          const b = await slice(img, meta, { l: lOff, t: tOff, w: 0.32, h: 0.045 }, { width: 2000, fmt: 'png' });
          const txt = await recognize(b, { psm: '11' });
          debug.numberTexts.push('SLIDE@' + tOff + '/' + lOff + ':' + txt.slice(0, 70));
          tightTexts.push(txt); // these slices sit on the same strip
          addNums(txt);
          if (topNumVotes() >= 2) break;
        } catch { /* next offset */ }
      }
      if (topNumVotes() >= 2) break;
    }
    if (numVotes.size) {
      numberGuesses = [...numVotes.values()].sort((a, b) => b.votes - a.votes).slice(0, 3);
      numberGuess = numberGuesses[0] || null;
    } else {
      computeBare(); // the sweep's texts may carry a bare promo number
    }
  }
  stageStats.stagesMs.slide = Date.now() - slideT0;

  // --- attack names (rescue channel): big print mid-card ---
  // Deterministic union pass: OCR the attack band with several
  // preprocessing variants and UNION the tokens across all of them (and
  // across both attacks on the card). Title/number OCR genuinely fails
  // on some glare/embossed full-art cards (e.g. Mega Abomasnow ex, whose
  // only reliable read is "Hammer" + "Lanche" from Hammer-lanche), and a
  // single-variant pass made that rescue a coin flip.
  const attackGuesses = [];
  // Attack rescue only when a primary channel is actually missing: if we
  // have a number AND at least one name guess, the card book resolves it
  // (observed live: the attack stage firing spuriously on readable cards
  // was pure latency). Abomasnow-class cards (no number read) still get it.
  // A BARE (promo) number alone is not a strong channel — it repeats
  // across sets and needs name/attack corroboration at the gate — so
  // bare-only reads keep the rescue too.
  const bareOnlyNumber = !!numberGuess && numberGuess.bare === true;
  if (!numberGuess || bareOnlyNumber || !nameGuesses.length) {
    const ATTACK_BOXES = [
      { l: 0.08, t: 0.5, w: 0.84, h: 0.055 },
      { l: 0.08, t: 0.545, w: 0.84, h: 0.055 },
      { l: 0.08, t: 0.59, w: 0.84, h: 0.055 },
      { l: 0.08, t: 0.635, w: 0.84, h: 0.055 },
      { l: 0.08, t: 0.68, w: 0.84, h: 0.055 },
      { l: 0.05, t: 0.52, w: 0.9, h: 0.2 },
    ];
    const rows = ATTACK_BOXES.slice(0, 5);
    const wide = ATTACK_BOXES[5];
    const ATTACK_STOP = new Set([
      'energy', 'discard', 'discarded', 'damage', 'during', 'opponent', 'opponents', 'attach',
      'active', 'bench', 'cards', 'basic', 'flip', 'coins', 'coin', 'heads', 'tails',
      'weakness', 'resistance', 'retreat', 'pokemon', 'pokmon', 'attack', 'does',
      'each', 'from', 'your', 'this', 'that', 'with', 'take', 'prize', 'deck',
      'next', 'turn', 'less', 'counters', 'counter', 'defending', 'before',
      'knocked', 'shuffle', 'search', 'draw', 'evolves', 'evolved', 'special',
      'condition', 'cannot', 'cant', 'instead', 'already', 'amount', 'their',
      'they', 'them', 'then', 'than', 'more', 'also', 'once', 'plus', 'times',
      'equal', 'both', 'were', 'will', 'into', 'only', 'just', 'even', 'used',
      'using', 'gets', 'way', 'put',
    ]);
    // A token is junk for rescue purposes when it IS a rule-text word,
    // is a truncation that is a strict prefix of one ('Damag' from
    // 'Damage'), or is a merged blob carrying one as a prefix/suffix
    // fragment ('Thisiattack', 'Discarded'). Junk tokens match hundreds
    // of cards in attack search and burn the slots real attack words
    // (Hammer, Lanche) need.
    const attackTokenIsJunk = (lower) => {
      if (ATTACK_STOP.has(lower)) return true;
      for (const w of ATTACK_STOP) {
        if (w.length < 4) continue;
        if (w.length > lower.length && w.startsWith(lower)) return true;
        if (lower.length > w.length && (lower.startsWith(w) || lower.endsWith(w))) return true;
      }
      return false;
    };
    const tokenVotes = new Map(); // Cap token -> { votes, first }
    const joinedParts = new Map(); // joined token -> [part tokens]
    let seq = 0;
    const capWord = (w) => w.charAt(0).toUpperCase() + w.slice(1);
    const addToken = (raw) => {
      let word = (raw || '').trim();
      if (word.length < 4) return;
      if (!/^[A-Z][a-z]/.test(word) && !/^[a-z]{5,}$/.test(word)) return;
      // OCR regularly glues a stray plural onto the last word it read
      // ("Hammers" for the printed "Hammer"): fold it back so the
      // votes land on the real attack word.
      if (word.length > 5 && /[a-z]s$/.test(word) && !/(ss|us|is)$/.test(word)) {
        word = word.slice(0, -1);
      }
      const cap = capWord(word);
      if (attackTokenIsJunk(cap.toLowerCase())) return;
      const rec = tokenVotes.get(cap) || { votes: 0, first: seq++ };
      rec.votes++;
      tokenVotes.set(cap, rec);
    };
    const runPass = async (box, variant, frame = framePrimary) => {
      try {
        const b = await slice(frame.img, frame.meta, box, variant);
        const txt = await recognize(b, { psm: '11' });
        for (const ln of (txt || '').split(/\r?\n/)) {
          for (const w of ln.replace(/[^A-Za-z\- ]+/g, ' ').split(/\s+/)) {
            if (!w) continue;
            // "Hammer-lanche" -> Hammer + Lanche (+ the joined form)
            const parts = w.split('-');
            for (const part of parts) addToken(part);
            if (w.includes('-')) {
              const joined = w.replace(/-/g, '');
              addToken(joined);
              const capJoined = capWord(joined);
              if (!joinedParts.has(capJoined)) {
                joinedParts.set(capJoined, parts.map(capWord));
              }
            }
          }
        }
      } catch { /* next variant/box */ }
    };
    // Staged union: fast variants first (rows plain + wide plain/thresh).
    // Heavier variants only run while the rescue is still short of TWO
    // agreed tokens (a two-token confirmation is what makes an attack
    // rescue trustworthy) AND the time budget has room — on slow
    // serverless CPUs the full 13-pass union blew the 60s function cap
    // and every request died as a 504.
    const strongTokenCount = () => [...tokenVotes.values()].filter((v) => v.votes >= 2).length;
    for (const box of rows) await runPass(box, { width: 1300 });
    await runPass(wide, { width: 1300 });
    await runPass(wide, { width: 1300, thresh: 150 });
    if (strongTokenCount() < 2) {
      for (const box of rows) {
        if (strongTokenCount() >= 2) break;
        await runPass(box, { width: 1300, thresh: 150 });
      }
    }
    if (strongTokenCount() < 2) await runPass(wide, { width: 1300, negate: true });
    // If a crop framing produced almost nothing, give the full frame
    // the fast first-stage passes too — a crop that clipped the attack
    // area must not silence the rescue channel.
    if (strongTokenCount() < 2 && frameSecondary && Date.now() < activeDeadline - 9000) {
      for (const box of rows) {
        if (strongTokenCount() >= 2) break;
        await runPass(box, { width: 1300 }, frameSecondary);
      }
      if (strongTokenCount() < 2) await runPass(wide, { width: 1300 }, frameSecondary);
    }
    // Assemble the rescue list from the voted tokens:
    //  - drop a joined form when both of its split parts were also read
    //    (searching "Hammerlanche" can never match printed "Hammer-lanche");
    //  - drop truncations that are strict prefixes of a longer surviving
    //    token (the un-split twin is the real word);
    //  - multi-vote tokens lead; single-vote tokens fill the rest, so a
    //    genuinely faint card still gets its best word searched.
    const keptEntries = [...tokenVotes.entries()].filter(([tok]) => {
      const parts = joinedParts.get(tok);
      if (parts && parts.length > 1 && parts.every((p) => p !== tok && tokenVotes.has(p))) return false;
      return true;
    });
    const noTrunc = keptEntries.filter(([tok]) =>
      !keptEntries.some(([u]) => u !== tok && u.length > tok.length && u.toLowerCase().startsWith(tok.toLowerCase()))
    );
    noTrunc.sort((a, b) => (b[1].votes - a[1].votes) || (a[1].first - b[1].first));
    const multiVote = noTrunc.filter(([, v]) => v.votes >= 2);
    const singleVote = noTrunc.filter(([, v]) => v.votes < 2);
    attackGuesses.push(...[...multiVote, ...singleVote].slice(0, 6).map(([tok]) => tok));
    debug.attackTokens = noTrunc.map(([t, v]) => `${t}(${v.votes})`);
  }

  stageStats.stagesMs.total = Date.now() - stageT0;
  return { nameGuess: nameGuesses[0] || '', nameGuesses, numberGuess, numberGuesses, attackGuesses: attackGuesses.slice(0, 6), debug, ocrTiming: stageStats };
}
