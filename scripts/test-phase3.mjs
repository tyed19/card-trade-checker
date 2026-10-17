// Phase 3 fixture tests: pure logic (lib/logic.js), share links
// (lib/links.js), and the on-device store (lib/store.js, in-memory in
// node). All fixtures are FICTIONAL cards — no catalog access needed.
// Run: node scripts/test-phase3.mjs   (exit 1 on any failure)

import assert from 'node:assert';
import {
  binderList, duplicates, spareCopies, binderValue, setProgress,
  perfectSwaps, giftIdeas, spareHolders, autoBalance, giftRadar,
  fairTraderBadge, kidFairTrades, setBadges, FAIR_BAND,
  fairnessBand, verdictKind, normalizeFairness, fmtCushion,
  radarQualifies, radarSets,
} from '../lib/logic.js';
import { encodePayload, decodePayload, packCards, unpackCards, refToCode, codeToRef } from '../lib/links.js';
import * as store from '../lib/store.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

// --- fixture helpers -----------------------------------------------------
const mkCard = (ref, price, { setId = 'setA', setName = 'Set A', setTotal = 100, number = '1', lang = 'en', currency = 'USD' } = {}) => ({
  ref, id: 'fx-' + ref, lang, name: 'Card ' + ref, set: setName, setId, setTotal,
  number, price, priceUSD: price, priceEUR: currency === 'EUR' ? price : null,
  currency, image: null, thumb: null, rarity: 'Rare',
});
const B = (spec) => { // spec: [[ref, qty, card]] -> {map, cardMap}
  const map = {}, cardMap = {};
  for (const [ref, qty, card] of spec) { map[ref] = { qty, id: card.id }; cardMap[ref] = card; }
  return binderList(map, cardMap);
};

console.log('logic: duplicates + value + progress');
ok('duplicates are qty>=2 only', () => {
  const list = B([['e1', 1, mkCard('e1', 2)], ['e2', 3, mkCard('e2', 4)], ['e3', 2, mkCard('e3', 1)]]);
  assert.deepEqual(duplicates(list).map((e) => e.ref), ['e2', 'e3']);
  assert.equal(spareCopies(list).length, 3); // 2 spare of e2 + 1 of e3
});
ok('binderValue weights qty, duplicatesValue counts spares only', () => {
  const list = B([['e1', 2, mkCard('e1', 10)], ['e2', 1, mkCard('e2', 5)]]);
  const v = binderValue(list);
  assert.equal(v.total, 25); assert.equal(v.duplicatesValue, 10);
  assert.equal(v.count, 3); assert.equal(v.distinct, 2);
});
ok('binder total == parent-layer value on a mixed fixture (qty, EUR, unpriced)', () => {
  // The kid binder banner and the grown-ups ParentLayer both render
  // binderValue(list) — this fixture pins the shared math: qty-weighted
  // total, spare-copies doubles split, EUR card at its converted USD
  // price, and the unpriced count the banner's qualifier prints.
  const list = B([
    ['e1', 3, mkCard('e1', 0.68)],                                        // 3 x $0.68 = $2.04, spares $1.36
    ['j1', 2, mkCard('j1', 2.50, { lang: 'ja', currency: 'EUR', setId: 'sJ', setName: 'Set J' })], // EUR card, price already USD-converted: 2 x $2.50 = $5.00, spares $2.50
    ['e2', 2, mkCard('e2', null)],                                         // unpriced: $0, 2 copies / 1 kind
  ]);
  const v = binderValue(list); // the one helper both layers share
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(v.total, 7.04), `total ${v.total}`);
  assert.ok(near(v.duplicatesValue, 3.86), `duplicatesValue ${v.duplicatesValue}`);
  assert.equal(v.count, 7);
  assert.equal(v.distinct, 3);
  assert.equal(v.unpriced, 2);       // copies with no price
  assert.equal(v.unpricedKinds, 1);
  // every fixture card is a double here; the doubles view/filter agrees
  assert.deepEqual(duplicates(list).map((e) => e.ref), ['e1', 'e2', 'j1']); // binderList set/number sort order
  // a single-copy unpriced card: qualifier counts 1 copy
  const one = binderValue(B([['e9', 1, mkCard('e9', null)]]));
  assert.equal(one.total, 0); assert.equal(one.unpriced, 1); assert.equal(one.unpricedKinds, 1);
});
ok('setProgress groups, totals, closest-first sort', () => {
  const list = B([
    ['e1', 1, mkCard('e1', 1, { setId: 'sA', setTotal: 10, number: '1' })],
    ['e2', 1, mkCard('e2', 1, { setId: 'sA', setTotal: 10, number: '2' })],
    ['e3', 1, mkCard('e3', 1, { setId: 'sB', setName: 'Set B', setTotal: 4, number: '1' })],
    ['e4', 1, mkCard('e4', 1, { setId: 'sB', setName: 'Set B', setTotal: 4, number: '2' })],
    ['e5', 1, mkCard('e5', 1, { setId: 'sB', setName: 'Set B', setTotal: 4, number: '3' })],
  ]);
  const p = setProgress(list);
  assert.equal(p[0].setId, 'sB'); assert.equal(p[0].pct, 0.75); assert.equal(p[0].missing, 1);
  assert.equal(p[1].setId, 'sA'); assert.equal(p[1].owned, 2);
});

console.log('logic: suggestions');
ok('perfectSwaps pairs in-band mutual needs, skips out-of-band', () => {
  const a = B([
    ['e10', 2, mkCard('e10', 10)],           // A spare, B missing
    ['e11', 2, mkCard('e11', 50)],           // A spare, B missing, pricey
    ['e12', 1, mkCard('e12', 9)],            // A owns B's spare already? no—A owns it, so B spare of e12 must not pair
  ]);
  const b = B([
    ['e20', 2, mkCard('e20', 9)],            // B spare, A missing -> pairs with e10 (ratio .1)
    ['e21', 2, mkCard('e21', 3)],            // B spare, A missing -> vs e11 ratio .94, no pair
    ['e12', 2, mkCard('e12', 9)],            // B spare of a card A OWNS (qty1) -> not a need
  ]);
  const swaps = perfectSwaps(a, b);
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].giveA.ref, 'e10');
  assert.equal(swaps[0].giveB.ref, 'e20');
  assert.ok(swaps[0].ratio <= FAIR_BAND);
});
ok('giftIdeas needs B close to completing the set; return = closest B spare', () => {
  const a = B([['e30', 2, mkCard('e30', 8, { setId: 'sC', setName: 'Set C', setTotal: 20 })]]);
  const bCards = [];
  for (let i = 0; i < 15; i++) bCards.push(['x' + i, 1, mkCard('x' + i, 1, { setId: 'sC', setName: 'Set C', setTotal: 20, number: String(i + 2) })]);
  bCards.push(['e40', 2, mkCard('e40', 7)]); // B spare, value close to 8
  bCards.push(['e41', 2, mkCard('e41', 40)]);
  const b = B(bCards); // B owns 15/20 of Set C -> missing 5 (incl e30) <= 10
  const ideas = giftIdeas(a, b);
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].give.ref, 'e30');
  assert.equal(ideas[0].setMissing, 5);
  assert.equal(ideas[0].returnCard.ref, 'e40');
});
ok('spareHolders finds cousin spares for missing refs', () => {
  const cousin = B([['e50', 2, mkCard('e50', 1)], ['e51', 1, mkCard('e51', 1)]]);
  const holders = spareHolders(['e50', 'e51', 'e52'], { kidB: cousin });
  assert.deepEqual(holders.get('e50'), ['kidB']);
  assert.equal(holders.has('e51'), false); // qty 1 is not a spare
});

console.log('logic: auto-balance');
ok('greedy case: $6+$5 pair beats single $13.70 overshoot for an $11.40 gap', () => {
  const spares = [
    { ref: 'eM', card: mkCard('eM', 13.70) },  // Meowth-class single
    { ref: 'e6', card: mkCard('e6', 6.00) },
    { ref: 'e5', card: mkCard('e5', 5.00) },
    { ref: 'e1', card: mkCard('e1', 1.00) },
  ];
  const res = autoBalance({ hiTotal: 31.40, loTotal: 20.00, spares, band: FAIR_BAND });
  assert.ok(res, 'expected a combo');
  assert.deepEqual(res.cards.map((c) => c.ref).sort(), ['e5', 'e6']);
  assert.equal(res.sum, 11.00);
  assert.equal(res.landsInBand, true);
});
ok('single in-band card used when it is genuinely closest', () => {
  const spares = [{ ref: 'e9', card: mkCard('e9', 9.2) }, { ref: 'e2', card: mkCard('e2', 2) }];
  const res = autoBalance({ hiTotal: 30, loTotal: 20, spares, band: FAIR_BAND }); // gap 10
  assert.equal(res.cards.length, 1);
  assert.equal(res.cards[0].ref, 'e9'); // 9.2+2=11.2 (score 1.2) vs 9.2 (score 0.8, in band? (30-29.2)/30=.027 yes) -> e9 alone wins
  assert.equal(res.landsInBand, true);
});
ok('nothing in band -> closest combo, honestly flagged', () => {
  const spares = [{ ref: 'eA', card: mkCard('eA', 1) }, { ref: 'eB', card: mkCard('eB', 2) }];
  const res = autoBalance({ hiTotal: 100, loTotal: 10, spares, band: FAIR_BAND });
  assert.equal(res.landsInBand, false);
  assert.equal(res.sum, 3); // everything they've got
});
ok('no spares / no gap -> null', () => {
  assert.equal(autoBalance({ hiTotal: 10, loTotal: 10, spares: [{ ref: 'x', card: mkCard('x', 1) }] }), null);
  assert.equal(autoBalance({ hiTotal: 10, loTotal: 5, spares: [] }), null);
});

console.log('logic: gift radar + badges');
ok('giftRadar sorts missing by price, applies budget, unpriced last only when uncapped', () => {
  const setCards = [
    mkCard('g1', 3), mkCard('g2', 1), mkCard('g3', 20), mkCard('g4', null), mkCard('g5', 7),
  ];
  const owned = new Set(['g5']);
  const all = giftRadar({ setCardsList: setCards, ownedRefs: owned, budget: Infinity });
  assert.deepEqual(all.map((c) => c.ref), ['g2', 'g1', 'g3', 'g4']);
  const capped = giftRadar({ setCardsList: setCards, ownedRefs: owned, budget: 5 });
  assert.deepEqual(capped.map((c) => c.ref), ['g2', 'g1']);
});
ok('badges: fair tiers + set explorer/crown', () => {
  assert.equal(fairTraderBadge(0).tier, null);
  assert.equal(fairTraderBadge(1).tier.name, 'First Fair Trade');
  assert.equal(fairTraderBadge(5).tier.name, 'Fair Trader');
  assert.equal(fairTraderBadge(10).tier.name, 'Super Fair Trader');
  assert.equal(fairTraderBadge(25).tier.name, 'Fair Trade Legend');
  const badges = setBadges([
    { key: 'a', setName: 'A', pct: 0.4 }, { key: 'b', setName: 'B', pct: 0.5 },
    { key: 'c', setName: 'C', pct: 1 },
  ]);
  assert.deepEqual(badges.map((b) => b.setName), ['C', 'B']);
  assert.equal(badges[0].crown, true);
});

console.log('links: encode/decode');
ok('ref<->code round trip', () => {
  assert.equal(codeToRef(refToCode('e0')), 'e0');
  assert.equal(codeToRef(refToCode('e23735')), 'e23735');
  assert.equal(codeToRef(refToCode('j12780')), 'j12780');
  assert.equal(refToCode('nope'), null);
});
ok('payload round trip is identical (unicode kid name, JA ref, qty)', () => {
  const entries = [{ ref: 'e19', qty: 1 }, { ref: 'j50', qty: 3 }, { ref: 'e23735', qty: 12 }];
  const code = encodePayload({ t: 'gift', kid: 'Sofía 🦊', entries });
  const back = decodePayload(code);
  assert.equal(back.t, 'gift');
  assert.equal(back.kid, 'Sofía 🦊');
  assert.deepEqual(back.entries, entries);
  assert.deepEqual(unpackCards(packCards(entries)), entries);
  assert.equal(decodePayload('!!!garbage'), null);
  assert.equal(decodePayload(''), null);
});

console.log('store: profiles, binder ops, import merge, trade move, log');
ok('kid + binder + import merge sums quantities', () => {
  const kid = store.addKid('Alex', '🦊');
  assert.equal(store.getState().kids.length, 1);
  store.addToBinder(kid.id, 'e19', 'swsh5-19', 1);
  store.addToBinder(kid.id, 'e19', 'swsh5-19', 2);
  assert.equal(store.getState().binders[kid.id]['e19'].qty, 3);
  store.importBinder(kid.id, [{ ref: 'e19', qty: 2 }, { ref: 'j50', qty: 1 }]);
  assert.equal(store.getState().binders[kid.id]['e19'].qty, 5); // merge sums
  assert.equal(store.getState().binders[kid.id]['j50'].qty, 1);
  store.setBinderQty(kid.id, 'j50', 0);
  assert.equal(store.getState().binders[kid.id]['j50'], undefined);
});
ok('applyTradeMove decrements giver, increments receiver; log feeds badge count', () => {
  const st = store.getState();
  const a = st.kids[0];
  const b = store.addKid('Ben', '🐰');
  store.applyTradeMove(a.id, b.id, ['e19', 'e19']);
  assert.equal(store.getState().binders[a.id]['e19'].qty, 3);
  assert.equal(store.getState().binders[b.id]['e19'].qty, 2);
  store.logTrade({ aKid: a.id, bKid: b.id, aRefs: ['e19'], bRefs: [] });
  store.logTrade({ aKid: b.id, bKid: a.id, aRefs: [], bRefs: [] });
  assert.equal(kidFairTrades(store.getState().trades, a.id).length, 2);
  assert.equal(fairTraderBadge(kidFairTrades(store.getState().trades, a.id).length).tier.name, 'First Fair Trade');
});

console.log('logic: fairness setting — shared verdict predicate');
ok('percentage mode (default) is the legacy rule', () => {
  // $2.00 vs $2.20: ratio .091 <= .15 -> FAIR
  assert.equal(verdictKind(2.00, 2.20, {}).kind, 'fair');
  assert.equal(verdictKind(2.00, 2.20, { fairness: { mode: 'pct' } }).kind, 'fair');
  // $2.00 vs $2.90: ratio .310 -> not FAIR (it is ALMOST, <= .40)
  const v = verdictKind(2.00, 2.90, {});
  assert.notEqual(v.kind, 'fair');
  assert.equal(v.kind, 'almost');
  // $2.00 vs $4.00: ratio .50 -> NOT FAIR outright
  assert.equal(verdictKind(2.00, 4.00, {}).kind, 'notfair');
  // EUR widens x1.5 in pct mode too: ratio .20 fair only with EUR
  assert.equal(verdictKind(2.00, 2.50, {}).kind, 'almost');
  assert.equal(verdictKind(2.00, 2.50, { eur: true }).kind, 'fair');
  const b = fairnessBand({ hi: 100 }, undefined);
  assert.equal(b.fairMax, 15); assert.equal(b.almostMax, 40);
  const be = fairnessBand({ hi: 100, eur: true }, undefined);
  assert.ok(Math.abs(be.fairMax - 22.5) < 1e-9); assert.ok(Math.abs(be.almostMax - 60) < 1e-9);
});
ok('cushion 50¢: absolute-dollar windows, ALMOST = 3x', () => {
  const F = { mode: 'cushion', cents: 50 };
  assert.equal(verdictKind(2.00, 2.40, { fairness: F }).kind, 'fair');   // gap .40 <= .50
  const wide = verdictKind(2.00, 3.20, { fairness: F });                  // gap 1.20
  assert.notEqual(wide.kind, 'fair');
  assert.equal(wide.kind, 'almost');                                     // <= ALMOST cap 1.50
  assert.equal(wide.band.almostMax, 1.5);
  assert.equal(verdictKind(2.00, 2.90, { fairness: F }).kind, 'almost'); // gap .90
  assert.equal(verdictKind(2.00, 4.00, { fairness: F }).kind, 'notfair');// gap 2.00 > 1.50
});
ok('cushion 10¢: penny trades get a sane window', () => {
  const F = { mode: 'cushion', cents: 10 };
  assert.equal(verdictKind(0.33, 0.40, { fairness: F }).kind, 'fair');   // gap .07 <= .10
  const v = verdictKind(0.33, 0.50, { fairness: F });                    // gap .17
  assert.notEqual(v.kind, 'fair');
  assert.equal(v.kind, 'almost');                                        // <= .30
});
ok('cushion mode + EUR card widens the cushion x1.5', () => {
  const F = { mode: 'cushion', cents: 50 };
  // gap .70: FAIR only because 50¢ -> 75¢ with an EUR card involved
  assert.equal(verdictKind(2.00, 2.70, { fairness: F, eur: true }).kind, 'fair');
  assert.equal(verdictKind(2.00, 2.70, { fairness: F, eur: false }).kind, 'almost');
  assert.equal(fairnessBand({ eur: true }, F).fairMax, 0.75);
});
ok('normalizeFairness: junk and missing settings fall back to pct', () => {
  assert.deepEqual(normalizeFairness(undefined), { mode: 'pct' });
  assert.deepEqual(normalizeFairness(null), { mode: 'pct' });
  assert.deepEqual(normalizeFairness({ mode: 'cushion', cents: 999 }), { mode: 'pct' });
  assert.deepEqual(normalizeFairness({ mode: 'cushion', cents: 25 }), { mode: 'cushion', cents: 25 });
  assert.equal(fmtCushion(10), '10¢'); assert.equal(fmtCushion(50), '50¢');
  assert.equal(fmtCushion(100), '$1'); assert.equal(fmtCushion(200), '$2');
  assert.equal(fmtCushion(150), '$1.50');
});
ok('perfectSwaps honors the cushion setting via the shared predicate', () => {
  const a = B([['s1', 2, mkCard('s1', 2.00)]]);
  const b = B([['s2', 2, mkCard('s2', 2.40)]]);
  // gap .40 on a 2.40 hi = ratio .167 > .15: no pair under percentage
  assert.equal(perfectSwaps(a, b).length, 0);
  // ...but inside a 50¢ cushion: a pair
  assert.equal(perfectSwaps(a, b, 10, { fairness: { mode: 'cushion', cents: 50 } }).length, 1);
  // ...and outside a 25¢ cushion: no pair
  assert.equal(perfectSwaps(a, b, 10, { fairness: { mode: 'cushion', cents: 25 } }).length, 0);
});
ok('autoBalance absBand: in-band test is absolute dollars in cushion mode', () => {
  // gap $1.00; a $0.60 spare leaves a $0.40 gap: in the % band
  // (.133 <= .15) but outside a 25¢ cushion.
  const r1 = autoBalance({ hiTotal: 3, loTotal: 2, spares: [{ ref: 'x', card: mkCard('x', 0.60) }], absBand: 0.25 });
  assert.equal(r1.landsInBand, false);
  // a $0.80 spare leaves $0.20 <= 25¢: lands.
  const r2 = autoBalance({ hiTotal: 3, loTotal: 2, spares: [{ ref: 'y', card: mkCard('y', 0.80) }], absBand: 0.25 });
  assert.equal(r2.landsInBand, true);
});

console.log('logic: gift radar qualification');
ok('radarQualifies: 1/195 no, 30/195 yes (>=15 cards), 12/100 yes (12%)', () => {
  const one = B([['r1', 1, mkCard('r1', 1, { setId: 'big', setTotal: 195, number: '1' })]]);
  const p1 = setProgress(one)[0];
  assert.equal(p1.owned, 1); assert.equal(p1.total, 195);
  assert.equal(radarQualifies(p1), false);
  assert.equal(radarSets(setProgress(one)).length, 0);
  const many = [];
  for (let i = 0; i < 30; i++) many.push(['m' + i, 1, mkCard('m' + i, 1, { setId: 'big', setTotal: 195, number: String(i + 1) })]);
  const p30 = setProgress(B(many))[0];
  assert.equal(p30.owned, 30);
  assert.equal(radarQualifies(p30), true); // 30 >= 15 cards (pct is only ~15.4% too)
  const pctSet = [];
  for (let i = 0; i < 12; i++) pctSet.push(['p' + i, 1, mkCard('p' + i, 1, { setId: 'mid', setTotal: 100, number: String(i + 1) })]);
  const p12 = setProgress(B(pctSet))[0];
  assert.equal(p12.owned, 12); // < 15 cards...
  assert.equal(radarQualifies(p12), true); // ...but 12% >= 10%
  const under = [];
  for (let i = 0; i < 14; i++) under.push(['u' + i, 1, mkCard('u' + i, 1, { setId: 'big2', setTotal: 195, number: String(i + 1) })]);
  assert.equal(radarQualifies(setProgress(B(under))[0]), false); // 14 cards, 7.2%: neither bar
});

console.log('store: fairness setting + migration');
// A save written BEFORE the fairness field existed must load with
// the pct default and keep kids/binders intact. Fresh module
// instance + a localStorage shim holding the legacy JSON.
{
  const legacy = JSON.stringify({
    v: 1,
    kids: [{ id: 'kx', name: 'Legacy Kid', emoji: '🦊', color: '#123456' }],
    binders: { kx: { e19: { qty: 2, id: 'swsh5-19', addedAt: 1 } } },
    trades: [], activeKidId: 'kx',
    // note: NO fairness field — pre-setting save
  });
  globalThis.window = { localStorage: { getItem: () => legacy, setItem: () => {} } };
  try {
    const fresh = await import('../lib/store.js?fairness-migration=1');
    const st = fresh.getState();
    assert.equal(st.kids.length, 1);
    assert.equal(st.kids[0].name, 'Legacy Kid');
    assert.equal(st.binders.kx.e19.qty, 2);
    assert.deepEqual(st.fairness, { mode: 'pct' });
    fresh.setFairness({ mode: 'cushion', cents: 50 });
    assert.deepEqual(fresh.getState().fairness, { mode: 'cushion', cents: 50 });
    fresh.setFairness({ mode: 'pct' });
    assert.deepEqual(fresh.getState().fairness, { mode: 'pct' });
    passed++; console.log('  ✓ legacy save (no fairness field) migrates: pct default, kids/binders intact, setFairness round-trips');
  } finally {
    delete globalThis.window;
  }
}

console.log(`\nALL ${passed} FIXTURE TESTS PASSED`);
