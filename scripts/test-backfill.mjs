// Backfill set-match fixtures: lib/cardbook.js backfillSetMatch, the
// gate lib/hybrid.js priceBackfill now applies before a pokemontcg hit
// may donate its price to a catalog candidate. Candidate shapes use
// real catalog-en.json rows; hit shapes use the pokemontcg dialect
// (set ids sv7 / me1 / sv8pt5 / me55, official set names, printedTotal).
// Run: node scripts/test-backfill.mjs   (exit 1 on any failure)

import assert from 'node:assert';
import { backfillSetMatch } from '../lib/cardbook.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

console.log('backfillSetMatch: donations accepted only on positive set agreement');
ok('same set, name equal (ids spelled sv07 vs sv7)', () => {
  const cand = { set: 'Stellar Crown', setId: 'sv07', setTotal: 142 };
  const hit = { set: 'Stellar Crown', setTotal: 142, id: 'sv7-51' };
  assert.equal(backfillSetMatch(cand, hit), true);
});
ok('same set, de-padded id equal with candidate name missing (me01 vs me1)', () => {
  const cand = { set: '', setId: 'me01', setTotal: null };
  const hit = { set: 'Mega Evolution', setTotal: 132, id: 'me1-157' };
  assert.equal(backfillSetMatch(cand, hit), true);
});
ok('same set, id equal despite renamed set + different totals (SVP promos)', () => {
  // TCGdex calls the set "SVP Black Star Promos" (total 225);
  // pokemontcg calls it "Scarlet & Violet Black Star Promos". Neither
  // name contains the other, so only the shared set id can vouch.
  const cand = { set: 'SVP Black Star Promos', setId: 'svp', setTotal: 225 };
  const hit = { set: 'Scarlet & Violet Black Star Promos', setTotal: 198, id: 'svp-180' };
  assert.equal(backfillSetMatch(cand, hit), true);
});
ok('same set, name containment (TCGdex "151" vs "Scarlet & Violet 151")', () => {
  const cand = { set: '151', setId: 'sv03.5', setTotal: 165 };
  const hit = { set: 'Scarlet & Violet 151', setTotal: 165, id: 'sv3pt5-1' };
  assert.equal(backfillSetMatch(cand, hit), true);
});
ok('same set, totals vouch when both names are missing (30th: ids share nothing)', () => {
  const cand = { set: '', setId: '30th', setTotal: 128 };
  const hit = { set: '', setTotal: 128, id: 'me55-18' };
  assert.equal(backfillSetMatch(cand, hit), true);
});

console.log('backfillSetMatch: wrong-set donations refused');
ok('parallel twin sets with equal totals (Black Bolt vs White Flare)', () => {
  // Both sets hold 86 cards and print same-name/same-number cards;
  // totals must not override genuinely different set names.
  const cand = { set: 'Black Bolt', setId: 'sv10.5b', setTotal: 86 };
  const hit = { set: 'White Flare', setTotal: 86, id: 'sv10pt5w-86' };
  assert.equal(backfillSetMatch(cand, hit), false);
});
ok('plain different set (Battle Styles vs Rebel Clash)', () => {
  const cand = { set: 'Battle Styles', setId: 'swsh5', setTotal: 163 };
  const hit = { set: 'Rebel Clash', setTotal: 192, id: 'swsh2-19' };
  assert.equal(backfillSetMatch(cand, hit), false);
});
ok('no set signal on either side', () => {
  const cand = { set: '', setId: '', setTotal: null };
  const hit = { set: '', setTotal: null, id: 'x-1' };
  assert.equal(backfillSetMatch(cand, hit), false);
});
ok('null inputs refuse', () => {
  assert.equal(backfillSetMatch(null, { set: 'X', id: 'x-1' }), false);
  assert.equal(backfillSetMatch({ set: 'X', setId: 'x' }, null), false);
});

console.log(`\n${passed} backfill fixtures passed`);
