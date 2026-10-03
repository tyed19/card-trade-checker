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

async function makeWorker() {
  const { createWorker } = await import('tesseract.js');
  const attempts = [
    () => {
      const dataInfo = require('@tesseract.js-data/eng'); // { langPath, gzip }
      const corePkg = path.dirname(require.resolve('tesseract.js-core/package.json'));
      return createWorker('eng', 1, {
        langPath: dataInfo.langPath,
        gzip: true,
        corePath: corePkg,
        cacheMethod: 'none',
        logger: () => {},
      });
    },
    () => createWorker('eng', 1, { cacheMethod: 'none', logger: () => {} }),
  ];
  let lastErr = null;
  for (const attempt of attempts) {
    try { return await attempt(); } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('OCR worker failed to start');
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = makeWorker().catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

async function recognize(buffer, { psm = '11', whitelist = '' } = {}) {
  const run = async () => {
    const worker = await getWorker();
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
        tessedit_char_whitelist: whitelist || '',
      });
    } catch { /* non-fatal */ }
    const out = await worker.recognize(buffer);
    return (out && out.data && out.data.text) || '';
  };
  const result = ocrChain.then(run, run);
  ocrChain = result.catch(() => {});
  return result;
}

// ---------- image prep ----------

async function slice(img, meta, { l, t, w, h }, { width = 2000, negate = false, thresh = 0 } = {}) {
  const left = Math.max(0, Math.round(l * meta.width));
  const top = Math.max(0, Math.round(t * meta.height));
  const cw = Math.min(meta.width - left, Math.round(w * meta.width));
  const ch = Math.min(meta.height - top, Math.round(h * meta.height));
  let pipe = sharp(img).extract({ left, top, width: cw, height: ch }).resize({ width });
  if (negate) pipe = pipe.negate();
  pipe = pipe.grayscale().normalize();
  if (thresh) pipe = pipe.threshold(thresh);
  pipe = pipe.sharpen();
  return pipe.png().toBuffer();
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
  const img = await sharp(buffer).rotate().toBuffer(); // honor EXIF orientation
  const meta = await sharp(img).metadata();
  const debug = { numberTexts: [], nameTexts: [] };

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
      const b = await slice(img, meta, box, { width: 2000 });
      const txt = await recognize(b, { psm: '11' });
      debug.numberTexts.push(txt.slice(0, 80));
      addNums(txt);
    } catch { /* next */ }
  }
  if (!numVotes.size) {
    for (const box of NUMBER_BOXES) {
      try {
        const b = await slice(img, meta, box, { width: 2000, negate: true });
        const txt = await recognize(b, { psm: '11' });
        debug.numberTexts.push('NEG:' + txt.slice(0, 80));
        addNums(txt);
      } catch { /* next */ }
    }
  }
  const numberGuesses = [...numVotes.values()].sort((a, b) => b.votes - a.votes).slice(0, 3);
  const numberGuess = numberGuesses[0] || null;

  // --- card name: plain + negated slices ---
  const nameTexts = [];
  for (const box of NAME_BOXES) {
    try {
      const b = await slice(img, meta, box, { width: 1600 });
      nameTexts.push(await recognize(b, { psm: '11' }));
    } catch { /* next */ }
  }
  for (const box of NAME_BOXES.slice(0, 3)) {
    try {
      const b = await slice(img, meta, box, { width: 1600, negate: true });
      nameTexts.push(await recognize(b, { psm: '11' }));
    } catch { /* next */ }
  }
  debug.nameTexts = nameTexts.map((t) => t.replace(/\n/g, ' / ').slice(0, 100));
  const nameGuesses = nameGuessesFromTexts(nameTexts);

  // --- attack names (rescue channel): big print mid-card ---
  // Deterministic union pass: OCR the attack band with several
  // preprocessing variants and UNION the tokens across all of them (and
  // across both attacks on the card). Title/number OCR genuinely fails
  // on some glare/embossed full-art cards (e.g. Mega Abomasnow ex, whose
  // only reliable read is "Hammer" + "Lanche" from Hammer-lanche), and a
  // single-variant pass made that rescue a coin flip.
  const attackGuesses = [];
  const topNameLen = (nameGuesses[0] || '').replace(/[^A-Za-z]/g, '').length;
  if (!numberGuess || !nameGuesses.length || topNameLen < 5) {
    const ATTACK_BOXES = [
      { l: 0.08, t: 0.5, w: 0.84, h: 0.055 },
      { l: 0.08, t: 0.545, w: 0.84, h: 0.055 },
      { l: 0.08, t: 0.59, w: 0.84, h: 0.055 },
      { l: 0.08, t: 0.635, w: 0.84, h: 0.055 },
      { l: 0.08, t: 0.68, w: 0.84, h: 0.055 },
      { l: 0.05, t: 0.52, w: 0.9, h: 0.2 },
    ];
    // Narrow rows: plain + threshold. The wide whole-attack-area box
    // additionally gets the negated variant. 13 OCR passes total.
    const passes = [];
    for (const box of ATTACK_BOXES.slice(0, 5)) {
      passes.push([box, { width: 1800 }], [box, { width: 1800, thresh: 150 }]);
    }
    const wide = ATTACK_BOXES[5];
    passes.push(
      [wide, { width: 1800 }],
      [wide, { width: 1800, thresh: 150 }],
      [wide, { width: 1800, negate: true }],
    );
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
    for (const [box, variant] of passes) {
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
    }
    attackGuesses.push(
      ...[...tokenVotes.entries()]
        .sort((a, b) => (b[1].votes - a[1].votes) || (a[1].first - b[1].first))
        .map(([tok]) => tok)
    );
    debug.attackTokens = attackGuesses.map((t) => `${t}(${tokenVotes.get(t).votes})`);
  }

  return { nameGuess: nameGuesses[0] || '', nameGuesses, numberGuess, numberGuesses, attackGuesses: attackGuesses.slice(0, 6), debug };
}
