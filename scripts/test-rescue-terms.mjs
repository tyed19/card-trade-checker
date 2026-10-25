// Glued-title search-term fixtures: lib/identify.js deriveGluedSearchTerms.
// Sleeve glare merges a printed title into one camel-glued token; the
// glued form matches nothing in the book search, so the rescue must
// derive searchable terms from the glue seam (proven 2026-10-25 on a
// real Android capture of Charizard ex SVP 074, whose ability read as
// "InfernaliRe" in every slice while "*Infernal*" demonstrably returns
// svp-74). Run: node scripts/test-rescue-terms.mjs (exit 1 on failure)

import assert from 'node:assert';
import { deriveGluedSearchTerms } from '../lib/identify.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

console.log('deriveGluedSearchTerms: searchable terms from camel-glued titles');
ok('InfernaliRe (real capture) yields Infernal', () => {
  const terms = deriveGluedSearchTerms('InfernaliRe');
  assert.ok(terms.includes('Infernal'), `got ${terms}`);
  assert.ok(terms.includes('Infernali'), `got ${terms}`);
});
ok('InfernaljRe (October capture) yields Infernal', () => {
  const terms = deriveGluedSearchTerms('InfernaljRe');
  assert.ok(terms.includes('Infernal'), `got ${terms}`);
});
ok('BurningDarkness yields both words', () => {
  const terms = deriveGluedSearchTerms('BurningDarkness');
  assert.ok(terms.includes('Burning'), `got ${terms}`);
  assert.ok(terms.includes('Darkness'), `got ${terms}`);
});
ok('clean token yields nothing', () => {
  assert.deepEqual(deriveGluedSearchTerms('Reign'), []);
  assert.deepEqual(deriveGluedSearchTerms('Ability'), []);
});
ok('short token yields nothing', () => {
  assert.deepEqual(deriveGluedSearchTerms('FireBlast'.slice(0, 7)), []);
});
ok('junk right part is filtered', () => {
  // "SomethingDamage": right part is a rescue stopword, must not be a term.
  const terms = deriveGluedSearchTerms('SomethingDamage');
  assert.ok(!terms.includes('Damage'), `got ${terms}`);
  assert.ok(terms.includes('Something'), `got ${terms}`);
});
ok('derived terms are usable as book-search substrings', () => {
  // Every derived term of length >= 4 is a substring of some printed
  // title by construction here; the key property is that the seam
  // terms for the Charizard capture contain the ability's first word.
  const terms = deriveGluedSearchTerms('InfernaliRe');
  assert.ok(terms.some((t) => 'infernal reign'.includes(t.toLowerCase())));
});

console.log(`\n${passed} rescue-term fixtures passed`);
