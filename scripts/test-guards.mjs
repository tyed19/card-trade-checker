#!/usr/bin/env node
// Fixtures for lib/guards.js — the anti-false-positive package:
// two-signal enforcement, high-price tripwire, set-total agreement.
import {
  signalCount, enforceTwoSignal, median, isPriceOutlier, totalAgrees,
  hasIndistinguishableRival,
} from '../lib/guards.js';

const cand = (id, name, extra = {}) => ({
  id, name, displayable: true, score: 100, price: null, ...extra,
});

let pass = 0, fail = 0;
const check = (label, got, want) => {
  if (got === want) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}: got ${got}, want ${want}`); }
};
const disp = (list) => list.filter((c) => c.displayable).map((c) => c.id);

// --- signalCount ---
check('picture alone (confident) = 1', signalCount(cand('a', 'X', { pictConfident: true })), 1);
check('picture (pool 0.85) + number = 2', signalCount(cand('a', 'X', { pictSim: 0.85, numberMatch: true })), 2);
check('picture (pool 0.85) + bare number = 2', signalCount(cand('a', 'X', { pictSim: 0.85, bareNumMatch: true })), 2);
check('weak picture (0.72) + number = 1', signalCount(cand('a', 'X', { pictSim: 0.72, numberMatch: true })), 1);
check('picture + 2 attack tokens = 2', signalCount(cand('a', 'X', { pictSim: 0.9, attackTokens: 2 })), 2);
check('picture + 1 attack token = 1', signalCount(cand('a', 'X', { pictSim: 0.9, attackTokens: 1 })), 1);
check('picture + strong name = 2', signalCount(cand('a', 'X', { pictSim: 0.9, nameSim: 0.85 })), 2);
// Meowth decision (2026-10-25): the name bar is 0.6, the codebase's
// corroboration bar — a 0.67 name beside a full number match is two
// signals, not a retake; below 0.6 the name earns nothing.
check('number + name 0.67 = 2 (Meowth)', signalCount(cand('a', 'X', { numberMatch: true, nameSim: 0.67 })), 2);
check('number + name 0.59 = 1', signalCount(cand('a', 'X', { numberMatch: true, nameSim: 0.59 })), 1);
check('name 0.67 alone = 1', signalCount(cand('a', 'X', { nameSim: 0.67 })), 1);
check('number + HP match = 2', signalCount(cand('a', 'X', { numberMatch: true, hpMatch: true })), 2);
check('HP match alone = 1', signalCount(cand('a', 'X', { hpMatch: true })), 1);
check('number alone = 1', signalCount(cand('a', 'X', { numberMatch: true })), 1);
check('nothing = 0', signalCount(cand('a', 'X')), 0);

// --- enforceTwoSignal ---
{
  const list = [cand('a', 'X', { pictConfident: true })];
  check('sole single-signal demoted', enforceTwoSignal(list) === 1 && disp(list).length === 0, true);
}
{
  const list = [cand('a', 'X', { pictSim: 0.85, numberMatch: true })];
  check('sole two-signal kept', enforceTwoSignal(list) === 0 && disp(list).length === 1, true);
}
{
  // Choice list: two single-signal candidates stay (kid compares
  // different Pokémon by picture); the rule only bars SOLE choices.
  const list = [cand('a', 'X', { pictConfident: true }), cand('b', 'Y', { numberMatch: true })];
  check('choice list untouched', enforceTwoSignal(list) === 0 && disp(list).length === 2, true);
}
{
  const list = [cand('a', 'X', { displayable: false })];
  check('retake untouched', enforceTwoSignal(list) === 0 && disp(list).length === 0, true);
}

// --- median / tripwire ---
check('median odd', median([5, 99, 899]), 99);
check('median even', median([10, 20]), 15);
check('median empty', median([]), null);
check('Base $899.99 vs Evolutions ~$99 trips', isPriceOutlier(899.99, [99]), true);
check('Base $899.99 vs mixed rivals trips (median $99)', isPriceOutlier(899.99, [5, 99, 899]), true);
check('Charizard ex $256.92 vs $94.59 does NOT trip (2.7x)', isPriceOutlier(256.92, [94.59]), false);
check('$60 vs $10 trips (6x, $50 gap)', isPriceOutlier(60, [10]), true);
check('$30 vs $5 does NOT trip ($25 gap)', isPriceOutlier(30, [5]), false);
check('cheap top vs expensive rivals does NOT trip', isPriceOutlier(5, [99]), false);
check('no rivals does NOT trip', isPriceOutlier(899.99, []), false);
check('null price does NOT trip', isPriceOutlier(null, [99]), false);
check('null rival prices ignored', isPriceOutlier(899.99, [null, 99]), true);

// --- hasIndistinguishableRival (Evolutions 11/108 cropsim, 2026-10-26) ---
// Pool entries carry { entry: { name }, sim }. A same-name rival
// within 0.03 of the candidate's sim makes art non-discriminating.
const poolCand = (name, sim) => ({ entry: { name }, sim });
{
  const p = poolCand('Charizard', 0.8601);
  const pool = [p, poolCand('Charizard', 0.8518), poolCand('Pikachu', 0.9)];
  check('same-name rival within 0.03 = rivaled', hasIndistinguishableRival(p, pool), true);
  check('different-name high sim is NOT a rival', hasIndistinguishableRival(poolCand('Pikachu', 0.9), [p, poolCand('Charizard', 0.8518)]), false);
  check('same-name rival outside 0.03 = NOT rivaled', hasIndistinguishableRival(poolCand('Charizard', 0.9), [poolCand('Charizard', 0.85)]), false);
  check('single-member pool = NOT rivaled', hasIndistinguishableRival(p, [p]), false);
  check('exact 0.03 boundary counts as rivaled', hasIndistinguishableRival(poolCand('Charizard', 0.86), [poolCand('Charizard', 0.83)]), true);
}

// --- totalAgrees ---
check('108 vs 108 agrees', totalAgrees('108', '108'), true);
check('108 vs 102 disagrees', totalAgrees('108', '102'), false);
check('string vs number agrees', totalAgrees('108', 108), true);
check('missing read total agrees vacuously', totalAgrees(undefined, '102'), true);
check('missing candidate total agrees vacuously', totalAgrees('108', null), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
