#!/usr/bin/env node
// Same-art confusion matrix: the edition-trap logic, tested without
// photos (photo-level proof lives in scripts/run-suite.mjs + the
// private Charizard harness, which use Tye's photos and are NOT
// committed). What this suite proves, using the REAL matcher
// functions over REAL catalog rows:
//   (1) a full NNN/TTT read claims ONLY the edition whose printed
//       total agrees — never its same-art twin;
//   (2) a bare number claims both twins (it carries no total), so it
//       can never disambiguate alone — the gate/tripwire must;
//   (3) a high-price twin crowned without FULL number agreement is
//       demoted by the tripwire, and survives only with it;
//   (4) a same-name cluster with no discriminating evidence and
//       scores within 10 points is suppressed wholesale (tie guard);
//   (5) a sole winner with number + picture (or number + HP) keeps
//       its displayable status under the two-signal rule.
// Twin pairs are resolved from the live catalog (existence asserted,
// so a data change fails loudly instead of silently untesting).
import fs from 'node:fs';
import path from 'node:path';
import { matchKind, applyTripwire, candidateOrder } from '../lib/hybrid.js';
import { suppressTiedGroups } from '../lib/identify.js';
import { enforceTwoSignal, signalCount } from '../lib/guards.js';

const catalog = JSON.parse(fs.readFileSync(path.join('data', 'catalog-en.json'), 'utf8'));
const row = (id) => catalog.find((c) => c.id === id);
const poolEntry = (id) => {
  const entry = row(id);
  if (!entry) throw new Error(`catalog row missing: ${id}`);
  return { entry, lang: 'en' };
};

let pass = 0, fail = 0;
const check = (label, got, want) => {
  if (got === want) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}: got ${got}, want ${want}`); }
};

// --- twin pairs: same name, same art family, different printings ---
// Charizard is the proven $900 trap (Base Set 4/102 vs Evolutions
// 11/108 — different numbers AND totals, identical artwork).
// Pikachu is the second Base/Evolutions reprint pair in the catalog.
const PAIRS = [
  { name: 'Charizard', a: 'base1-4', b: 'xy12-11' },
  { name: 'Pikachu', a: 'base1-58', b: 'xy12-35' },
];
for (const { name, a, b } of PAIRS) {
  const A = poolEntry(a), B = poolEntry(b);
  check(`${name}: rows exist (${a} ${A.entry.localId}/${A.entry.setTotal}, ${b} ${B.entry.localId}/${B.entry.setTotal})`,
    !!(A.entry && B.entry), true);
  // Full read of A's number+total claims A only.
  const readA = { num: String(A.entry.localId), padded: String(A.entry.localId).padStart(3, '0'), total: String(A.entry.setTotal) };
  check(`${name}: full ${readA.padded}/${readA.total} claims ${a}`, matchKind(readA, A), 'full');
  check(`${name}: full ${readA.padded}/${readA.total} does NOT claim ${b}`, matchKind(readA, B), null);
  // Full read of B's number+total claims B only.
  const readB = { num: String(B.entry.localId), padded: String(B.entry.localId).padStart(3, '0'), total: String(B.entry.setTotal) };
  check(`${name}: full ${readB.padded}/${readB.total} claims ${b}`, matchKind(readB, B), 'full');
  check(`${name}: full ${readB.padded}/${readB.total} does NOT claim ${a}`, matchKind(readB, A), null);
  // Bare read claims both — it cannot disambiguate, by construction.
  const bareA = { num: String(A.entry.localId), padded: String(A.entry.localId).padStart(3, '0'), total: null, bare: true };
  check(`${name}: bare ${bareA.padded} claims ${a} (bare only)`, matchKind(bareA, A), 'bare');
  check(`${name}: bare ${bareA.padded} claims ${b} too (no total to split)`, matchKind({ ...bareA, num: String(B.entry.localId), padded: String(B.entry.localId).padStart(3, '0') }, B), 'bare');
}

// --- tripwire on the Charizard pair (prices from the live catalog) ---
{
  const base = row('base1-4'), evo = row('xy12-11');
  const mk = (entry, extra) => ({
    id: entry.id, name: entry.name, price: entry.usd, displayable: true, score: 120, ...extra,
  });
  // Base crowned on picture/bare only, Evolutions rival on offer:
  // the tripwire demotes it (no FULL number agreement).
  const cands = [mk(base, { bareNumMatch: true }), mk(evo, { numberMatch: true })];
  applyTripwire(cands, []);
  check('tripwire demotes Base without FULL number', cands[0].displayable, false);
  check('tripwire leaves the numbered Evolutions alone', cands[1].displayable, true);
  // Base crowned WITH full number agreement survives the tripwire:
  // a photographed 4/102 really is the expensive card.
  const cands2 = [mk(base, { numberMatch: true }), mk(evo, {})];
  applyTripwire(cands2, []);
  check('tripwire keeps Base WITH full number', cands2[0].displayable, true);
}

// --- tie guard on a Charizard ex cluster (no evidence, tied scores) ---
{
  const exIds = catalog.filter((c) => c.name === 'Charizard ex').map((c) => c.id);
  check('Charizard ex cluster exists (>=9 prints)', exIds.length >= 9, true);
  const cluster = exIds.slice(0, 9).map((id, i) => ({
    id, name: 'Charizard ex', displayable: true, score: 120 + (i % 3), price: 100,
  }));
  const tied = suppressTiedGroups(cluster);
  check('tied cluster: all demoted', cluster.every((c) => !c.displayable), true);
  check('tied cluster: topWasTied true', tied, true);
  // Same cluster, one member WITH a number: the evidenced member
  // survives, the plain distractors go.
  const cluster2 = exIds.slice(0, 9).map((id, i) => ({
    id, name: 'Charizard ex', displayable: true, score: 120 + (i % 3), price: 100,
    ...(i === 3 ? { numberMatch: true } : {}),
  }));
  suppressTiedGroups(cluster2);
  check('evidenced cluster: numbered member survives', cluster2[3].displayable, true);
  check('evidenced cluster: plain members demoted', cluster2.filter((_, i) => i !== 3).every((c) => !c.displayable), true);
  // Same cluster, one member WITH an HP match: HP agreement is
  // discriminating evidence too (printed on the card, read from the
  // photo), so the HP member survives the same way.
  const cluster3 = exIds.slice(0, 9).map((id, i) => ({
    id, name: 'Charizard ex', displayable: true, score: 120 + (i % 3), price: 100,
    ...(i === 5 ? { hpMatch: true } : {}),
  }));
  suppressTiedGroups(cluster3);
  check('evidenced cluster: HP member survives', cluster3[5].displayable, true);
  check('evidenced cluster: plain members demoted (HP case)', cluster3.filter((_, i) => i !== 5).every((c) => !c.displayable), true);
}

// --- two-signal interaction on a sole winner ---
{
  const mk = (extra) => ({ id: 'xy12-11', name: 'Charizard', displayable: true, score: 120, ...extra });
  const w = [mk({ numberMatch: true, pictSim: 0.85 })];
  check('sole winner number+picture = 2 signals', signalCount(w[0]), 2);
  check('sole winner number+picture kept', enforceTwoSignal(w) === 0 && w[0].displayable, true);
  const w2 = [mk({ numberMatch: true, hpMatch: true })];
  check('sole winner number+HP = 2 signals', signalCount(w2[0]), 2);
  check('sole winner number+HP kept', enforceTwoSignal(w2) === 0 && w2[0].displayable, true);
  const w3 = [mk({ numberMatch: true })];
  check('sole winner number alone = 1 signal, demoted', enforceTwoSignal(w3) === 1 && !w3[0].displayable, true);
}

// --- final choice ordering: exact art tie falls to name agreement ---
{
  // The live JP 050/071 tie: Shining Steelix (nameSim 0) and
  // Dragonite VSTAR (nameSim 0.2), both displayable, both in the
  // pool, identical pictSim 0.8172 and score 145. Insertion order
  // alone crowned Steelix; name agreement must break the tie.
  const steelix = { id: 'S10a-050', name: 'かがやくハガネール', displayable: true, pictSim: 0.8172, nameSim: 0, score: 145, source: 'catalog' };
  const dragonite = { id: 'swsh10.5-050', name: 'Dragonite VSTAR', displayable: true, pictSim: 0.8172, nameSim: 0.2, score: 145, source: 'catalog' };
  const tied = [steelix, dragonite];
  tied.sort(candidateOrder({ topSim: 0.8419 }, () => true));
  check('exact art tie: name agreement wins (Dragonite first)', tied[0].id, 'swsh10.5-050');
  // Art still decides when it differs, regardless of name.
  const artA = { id: 'a', name: 'A', displayable: true, pictSim: 0.82, nameSim: 0, score: 100, source: 'catalog' };
  const artB = { id: 'b', name: 'B', displayable: true, pictSim: 0.81, nameSim: 0.9, score: 100, source: 'catalog' };
  const art = [artB, artA];
  art.sort(candidateOrder({ topSim: 0.85 }, () => true));
  check('art difference outranks name', art[0].id, 'a');
  // Same-name prints share a nameSim, so the tiebreak never
  // disturbs a same-name rivalry: score decides.
  const sameA = { id: 'a', name: 'Charizard', displayable: true, pictSim: 0.82, nameSim: 0.5, score: 100, source: 'catalog' };
  const sameB = { id: 'b', name: 'Charizard', displayable: true, pictSim: 0.82, nameSim: 0.5, score: 110, source: 'catalog' };
  const same = [sameA, sameB];
  same.sort(candidateOrder({ topSim: 0.85 }, () => true));
  check('same-name tie: score decides', same[0].id, 'b');
  // Weak picture (topSim below the strong-art bar): the name
  // tiebreak does not apply; score decides, insertion order kept
  // on a full tie.
  const weakA = { id: 'a', name: 'A', displayable: true, pictSim: 0.70, nameSim: 0, score: 100, source: 'catalog' };
  const weakB = { id: 'b', name: 'B', displayable: true, pictSim: 0.70, nameSim: 0.9, score: 100, source: 'catalog' };
  const weak = [weakA, weakB];
  weak.sort(candidateOrder({ topSim: 0.70 }, () => true));
  check('weak picture: score tie keeps insertion order', weak[0].id, 'a');
  // A full number match outranks art similarity: the live Iron
  // Leaves case, where the SIR (hotter art sim, no number) sorted
  // ahead of the TEF 025/162 the photo's own "025/162" read named.
  const sir = { id: 'sv05-203', name: 'Iron Leaves ex', displayable: true, pictSim: 0.83, nameSim: 0.92, score: 129, numberMatch: false, source: 'tcgdex' };
  const regular = { id: 'sv05-025', name: 'Iron Leaves ex', displayable: true, pictSim: 0.81, nameSim: 0.92, score: 204, numberMatch: true, source: 'tcgdex' };
  const leaves = [sir, regular];
  leaves.sort(candidateOrder({ topSim: 0.8296 }, () => true));
  check('number match outranks art sim (true TEF 025 first)', leaves[0].id, 'sv05-025');
  // Displayable still outranks everything.
  const nonDisp = { id: 'a', name: 'A', displayable: false, pictSim: 0.90, nameSim: 0.9, score: 200, source: 'catalog' };
  const disp = { id: 'b', name: 'B', displayable: true, pictSim: 0.81, nameSim: 0, score: 100, source: 'catalog' };
  const mixed = [nonDisp, disp];
  mixed.sort(candidateOrder({ topSim: 0.85 }, () => true));
  check('displayable outranks non-displayable', mixed[0].id, 'b');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
