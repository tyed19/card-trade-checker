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

const require = createRequire(import.meta.url);

let workerPromise = null;
let ocrChain = Promise.resolve(); // serialize jobs (worker params are global)
let activeDeadline = 0; // ms epoch; passes stop starting once past it
let stageStats = null; // per-read timing evidence (returned to the route)

const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
]);

let initAttempts = []; // evidence: which worker-init config worked, how long
let initLog = []; // tesseract logger statuses captured during init (where it stalls)

async function makeWorker() {
  const { createWorker } = await import('tesseract.js');
  const fs = await import('node:fs');
  // NEVER require.resolve() here: Next's bundler shims it into a numeric
  // module id (observed live AND locally: 'path argument must be of type
  // string. Received type number'), which killed worker init before any
  // attempt could run. Real files live in the deployed node_modules,
  // reachable from the process working directory on Vercel and locally.
  const nm = path.join(process.cwd(), 'node_modules');
  const fsPaths = {
    workerPath: path.join(nm, 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
    corePath: path.join(nm, 'tesseract.js-core'),
    langPath: path.join(nm, '@tesseract.js-data', 'eng', '4.0.0'),
  };
  const pathsOk = Object.fromEntries(
    Object.entries(fsPaths).map(([k, v]) => [k, fs.existsSync(v)])
  );
  // Each attempt is timeboxed INSIDE makeWorker: a createWorker that
  // hangs (observed on Vercel: the promise never settles, so the old
  // try/catch fallback never engaged) must not block the next attempt.
  const captureLog = (m) => {
    if (m && m.status && initLog.length < 80) initLog.push(`${m.status}:${Math.round((m.progress || 0) * 100)}`);
  };
  const attempts = [
    ['fs-paths', {
      ...fsPaths, gzip: true,
      cachePath: '/tmp', cacheMethod: 'none', logger: captureLog,
    }, 25000],
    ['package-defaults', { cachePath: '/tmp', cacheMethod: 'none', logger: captureLog }, 14000],
  ];
  let lastErr = null;
  for (const [label, opts, timeoutMs] of attempts) {
    const t0 = Date.now();
    try {
      const w = await withTimeout(createWorker('eng', 1, opts), timeoutMs, 'init-timeout');
      initAttempts.push({ label, ms: Date.now() - t0, ok: true, pathsOk });
      return w;
    } catch (err) {
      initAttempts.push({ label, ms: Date.now() - t0, error: String(err && err.message || err), pathsOk });
      lastErr = err;
    }
  }
  throw lastErr || new Error('OCR worker failed to start');
}

function getWorker() {
  if (!workerPromise) {
    const t0 = Date.now();
    workerPromise = makeWorker()
      .then((w) => { if (stageStats) stageStats.workerInitMs = Date.now() - t0; return w; })
      .catch((err) => { workerPromise = null; throw err; });
  }
  return withTimeout(workerPromise, 46000, 'worker-init-timeout');
}

async function resetWorker() {
  const p = workerPromise;
  workerPromise = null;
  try {
    const w = await p;
    await w.terminate();
  } catch { /* already dead */ }
}

async function recognize(buffer, { psm = '11', whitelist = '' } = {}) {
  if (activeDeadline && Date.now() > activeDeadline) throw new Error('ocr-budget-exceeded');
  const run = async () => {
    if (activeDeadline && Date.now() > activeDeadline) throw new Error('ocr-budget-exceeded');
    let worker;
    try {
      worker = await getWorker();
    } catch (err) {
      if (stageStats) stageStats.lastError = 'getWorker: ' + String(err && err.message || err);
      throw err;
    }
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
        tessedit_char_whitelist: whitelist || '',
      });
    } catch { /* non-fatal */ }
    const t0 = Date.now();
    try {
      // A single recognize() hanging (observed in serverless, never
      // locally) must not eat the whole budget: cap it, and rebuild the
      // worker — a wedged tesseract worker does not recover on its own.
      const out = await withTimeout(worker.recognize(buffer), 9000, 'recognize-timeout');
      if (stageStats) { stageStats.passes++; stageStats.passMs += Date.now() - t0; }
      return (out && out.data && out.data.text) || '';
    } catch (err) {
      if (stageStats) {
        stageStats.timeouts++; stageStats.passMs += Date.now() - t0;
        stageStats.lastError = String(err && err.message || err);
      }
      if (String(err && err.message) === 'recognize-timeout') resetWorker();
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
  return out;
}

// ---------- name ----------

const NAME_BOXES = [
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

function nameGuessesFromTexts(texts) {
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
    .sort((a, b) => (b.votes - a.votes) || (a.firstIdx - b.firstIdx))
    .map((r) => r.name)
    .slice(0, 6);
}

// ---------- main entry ----------

export async function readCardPhoto(buffer) {
  // Serverless time budget: the whole read must yield control well inside
  // the platform function cap (60s on Vercel Hobby), leaving room for the
  // card-book lookups. Passes stop starting once the budget is spent and
  // whatever was read so far is returned.
  activeDeadline = Date.now() + (parseInt(process.env.OCR_BUDGET_MS || '30000', 10) || 30000);
  stageStats = { workerInitMs: null, passes: 0, passMs: 0, timeouts: 0, stagesMs: {}, initAttempts, initLog };
  const stageT0 = Date.now();
  const rotated = await sharp(buffer).rotate().toBuffer(); // honor EXIF orientation
  const rMeta = await sharp(rotated).metadata();
  // Normalize to a working width once: band fractions are relative, and
  // real card photos (3000px+) make every per-slice decode needlessly slow.
  const img = rMeta.width > 1400
    ? await sharp(rotated).resize({ width: 1400 }).jpeg({ quality: 90 }).toBuffer()
    : rotated;
  const meta = await sharp(img).metadata();
  const debug = { numberTexts: [], nameTexts: [] };
  stageStats.stagesMs.prep = Date.now() - stageT0;

  // --- collector number: plain pass, then negated pass for what failed ---
  const numVotes = new Map();
  const addNums = (txt) => {
    for (const n of numbersFromText(txt)) {
      const key = n.padded + '/' + n.total;
      numVotes.set(key, { ...n, votes: (numVotes.get(key)?.votes || 0) + 1 });
    }
  };
  for (const box of NUMBER_BOXES) {
    try {
      const b = await slice(img, meta, box, { width: 2000, fmt: 'png' });
      const txt = await recognize(b, { psm: '11' });
      debug.numberTexts.push(txt.slice(0, 80));
      addNums(txt);
      // Strong consensus (same NNN/TTT from 3+ slices) — stop early.
      const top = Math.max(0, ...[...numVotes.values()].map((v) => v.votes));
      if (top >= 3) break;
    } catch { /* next */ }
  }
  if (!numVotes.size) {
    for (const box of NUMBER_BOXES) {
      try {
        const b = await slice(img, meta, box, { width: 2000, negate: true, fmt: 'png' });
        const txt = await recognize(b, { psm: '11' });
        debug.numberTexts.push('NEG:' + txt.slice(0, 80));
        addNums(txt);
      } catch { /* next */ }
    }
  }
  const numberGuesses = [...numVotes.values()].sort((a, b) => b.votes - a.votes).slice(0, 3);
  const numberGuess = numberGuesses[0] || null;
  stageStats.stagesMs.number = Date.now() - stageT0 - stageStats.stagesMs.prep;

  // --- card name: plain slices, stop once a usable guess exists;
  // negated slices only when the plain ones produced nothing ---
  const nameTexts = [];
  for (let i = 0; i < NAME_BOXES.length; i++) {
    try {
      const b = await slice(img, meta, NAME_BOXES[i], { width: 1600, fmt: 'png' });
      nameTexts.push(await recognize(b, { psm: '11' }));
    } catch { /* next */ }
    if (i >= 2 && nameGuessesFromTexts(nameTexts).length) break;
  }
  if (!nameGuessesFromTexts(nameTexts).length) {
    for (const box of NAME_BOXES.slice(0, 3)) {
      try {
        const b = await slice(img, meta, box, { width: 2000, negate: true, fmt: 'png' });
        nameTexts.push(await recognize(b, { psm: '11' }));
      } catch { /* next */ }
    }
  }
  debug.nameTexts = nameTexts.map((t) => t.replace(/\n/g, ' / ').slice(0, 100));
  const nameGuesses = nameGuessesFromTexts(nameTexts);
  stageStats.stagesMs.name = Date.now() - stageT0 - stageStats.stagesMs.prep - stageStats.stagesMs.number;

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
  if (!numberGuess || !nameGuesses.length) {
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
      'energy', 'discard', 'damage', 'during', 'opponent', 'opponents', 'attach',
      'active', 'bench', 'cards', 'basic', 'flip', 'coins', 'heads', 'tails',
      'weakness', 'resistance', 'retreat', 'pokemon', 'pokmon', 'attack', 'does',
      'each', 'from', 'your', 'this', 'that', 'with', 'take', 'prize', 'deck',
      'next', 'turn', 'less', 'counters', 'counter', 'defending', 'before',
    ]);
    const tokenVotes = new Map(); // Cap token -> { votes, first }
    let seq = 0;
    const addToken = (raw) => {
      const word = (raw || '').trim();
      if (word.length < 4) return;
      if (ATTACK_STOP.has(word.toLowerCase())) return;
      if (!/^[A-Z][a-z]/.test(word) && !/^[a-z]{5,}$/.test(word)) return;
      const cap = word.charAt(0).toUpperCase() + word.slice(1);
      const rec = tokenVotes.get(cap) || { votes: 0, first: seq++ };
      rec.votes++;
      tokenVotes.set(cap, rec);
    };
    const runPass = async (box, variant) => {
      try {
        const b = await slice(img, meta, box, variant);
        const txt = await recognize(b, { psm: '11' });
        for (const ln of (txt || '').split(/\r?\n/)) {
          for (const w of ln.replace(/[^A-Za-z\- ]+/g, ' ').split(/\s+/)) {
            if (!w) continue;
            // "Hammer-lanche" -> Hammer + Lanche (+ the joined form)
            for (const part of w.split('-')) addToken(part);
            if (w.includes('-')) addToken(w.replace(/-/g, ''));
          }
        }
      } catch { /* next variant/box */ }
    };
    // Staged union: fast variants first (rows plain + wide plain/thresh).
    // Heavier variants only run while tokens are scarce AND the time
    // budget has room — on slow serverless CPUs the full 13-pass union
    // blew the 60s function cap and every request died as a 504.
    for (const box of rows) await runPass(box, { width: 1300 });
    await runPass(wide, { width: 1300 });
    await runPass(wide, { width: 1300, thresh: 150 });
    if (tokenVotes.size < 3) {
      for (const box of rows) {
        if (tokenVotes.size >= 3) break;
        await runPass(box, { width: 1300, thresh: 150 });
      }
    }
    if (tokenVotes.size < 3) await runPass(wide, { width: 1300, negate: true });
    attackGuesses.push(
      ...[...tokenVotes.entries()]
        .sort((a, b) => (b[1].votes - a[1].votes) || (a[1].first - b[1].first))
        .map(([tok]) => tok)
    );
    debug.attackTokens = attackGuesses.map((t) => `${t}(${tokenVotes.get(t).votes})`);
  }

  stageStats.stagesMs.total = Date.now() - stageT0;
  return { nameGuess: nameGuesses[0] || '', nameGuesses, numberGuess, numberGuesses, attackGuesses: attackGuesses.slice(0, 6), debug, ocrTiming: stageStats };
}
