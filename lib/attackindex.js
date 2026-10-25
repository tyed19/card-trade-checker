// Local attack/ability-title + HP index (data/attacks-en.json, built
// by scripts/build-attack-index.mjs from TCGdex details).
//
// Why it exists: the rescue channel used to find cards by attack word
// ONLY through the pokemontcg.io wildcard search — a flaky API whose
// per-token failures and retries ate the 30–45s slow lanes and
// sometimes skipped the rescue entirely when the route deadline
// arrived first. The local index answers the same question
// ("which cards print a title this token confirms?") in milliseconds
// from our own data, so the rescue no longer depends on that API.
//
// Confirmation semantics mirror lib/identify.js tokenConfirms exactly
// (duplicated, not imported — identify.js imports this module, so an
// import back would be a cycle; the codebase already duplicates the
// junk-token rules between ocr.js and identify.js the same way):
// a token confirms a card when a printed title contains it, or when
// the token is an OCR glue-merge containing the title's first word
// ("InfernaliRe" read off "Infernal Reign").
// A missing/unreadable file is NOT an error: the caller falls back to
// the API rescue (the index is still building on first deploy, and
// the nightly refresh regenerates it).

import fs from 'node:fs';
import path from 'node:path';

const seg = (...parts) => [process.cwd(), ...parts].join(path.sep);

let indexPromise = null;

function loadIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      try {
        const raw = fs.readFileSync(seg('data', 'attacks-en.json'), 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();
  }
  return indexPromise;
}

export async function attackIndexReady() {
  return (await loadIndex()) !== null;
}

export async function titlesFor(id) {
  const idx = await loadIndex();
  return (idx && idx[id] && idx[id].t) || [];
}

export async function hpFor(id) {
  const idx = await loadIndex();
  const hp = idx && idx[id] && idx[id].hp;
  return typeof hp === 'number' ? hp : null;
}

function tokenConfirmsTitle(titles, token) {
  const tokL = String(token || '').toLowerCase();
  if (!tokL) return false;
  return (titles || []).some((a) => {
    const al = String(a || '').toLowerCase();
    if (al.includes(tokL)) return true;
    const first = al.split(/[^a-z]+/).filter(Boolean)[0] || '';
    return tokL.length >= 6 && first.length >= 5 && tokL.includes(first);
  });
}

// Find cards whose printed titles confirm any of `tokens`.
// Returns a Map id -> { titles, hp, tokens: Set } in the same shape
// the API rescue's byCard uses, so callers can swap sources without
// reshaping the downstream scoring/gate path.
export async function localAttackSearch(tokens) {
  const idx = await loadIndex();
  const out = new Map();
  if (!idx || !tokens || !tokens.length) return out;
  for (const [id, row] of Object.entries(idx)) {
    const titles = row.t || [];
    if (!titles.length) continue;
    const hit = new Set();
    for (const t of tokens) {
      if (tokenConfirmsTitle(titles, t)) hit.add(t);
    }
    if (hit.size) out.set(id, { titles, hp: typeof row.hp === 'number' ? row.hp : null, tokens: hit });
  }
  return out;
}
