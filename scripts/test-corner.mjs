#!/usr/bin/env node
// Fixtures for the RESET's capture-success logic (lib/hybrid.js):
// corner-first guess priority (mergeCornerGuesses) and the fast-path
// safety filter (selectFastCandidates). The OCR corner read itself
// (readCornerNumber) needs tesseract and is verified live, not here:
// these fixtures pin the rules that keep a close-up honest — corner
// guesses outrank full-frame guesses, and a fast-path candidate needs
// FULL number + set-total agreement AND the banked name agreeing.
// A close-up alone never creates a choice.
import { mergeCornerGuesses, selectFastCandidates, applyCornerShotRule } from '../lib/hybrid.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}: got ${g}, want ${w}`); }
};
const g = (num, total, extra = {}) => ({ num: String(num), padded: String(num).padStart(3, '0'), total: total == null ? null : String(total), votes: 1, ...extra });
const c = (id, name, number, setTotal, nameSim, extra = {}) => ({ id, name, number: String(number), setTotal, nameSim, score: 0, displayable: false, ...extra });

// ---- mergeCornerGuesses ----
// 1. Corner guesses come first, full-frame guesses after, deduped.
check('corner first, deduped',
  mergeCornerGuesses([g(25, 162)], [g(25, 162), g(203, 162)]).map((x) => `${x.padded}/${x.total}`),
  ['025/162', '203/162']);
// 2. A corner guess that differs from the frame guess wins the front.
check('corner guess fronts a conflicting frame guess',
  mergeCornerGuesses([g(25, 162)], [g(98, 162)]).map((x) => x.padded),
  ['025', '098']);
// 3. Empty corner input leaves the frame guesses untouched.
check('empty corner input is a no-op',
  mergeCornerGuesses([], [g(25, 162)]).map((x) => x.padded), ['025']);
// 4. Bare flag distinguishes otherwise-identical guesses.
check('bare flag keeps distinct keys',
  mergeCornerGuesses([g(180, null, { bare: true })], [g(180, null)]).length, 2);

// ---- selectFastCandidates ----
// 5. Iron Leaves fast path: corner 025/162 + banked name 0.92 ->
//    the true TEF print qualifies, displayable, numberMatch set.
{
  const out = selectFastCandidates(
    [c('sv05-25', 'Iron Leaves ex', '25', '162', 0.92), c('sv05-203', 'Iron Leaves ex', '203', '162', 0.92)],
    [g(25, 162)],
  );
  check('fast path crowns the number-named print only',
    out.map((x) => x.id), ['sv05-25']);
  check('fast path sets numberMatch', out[0] && out[0].numberMatch, true);
  check('fast path sets displayable', out[0] && out[0].displayable, true);
}
// 6. Total disagreement blocks: corner 025/162 must not crown a
//    same-number print from a 198-total set.
check('total disagreement blocks',
  selectFastCandidates([c('x-25', 'Iron Leaves ex', '25', '198', 0.92)], [g(25, 162)]).length, 0);
// 7. Weak banked name blocks: a corner number alone is not two
//    signals (the Meowth phone-sim lesson, inverted — the name
//    must actually agree).
check('weak name blocks',
  selectFastCandidates([c('sv05-25', 'Iron Leaves ex', '25', '162', 0.4)], [g(25, 162)]).length, 0);
// 8. Name bar is 0.6 (Tye's decision): 0.6 qualifies, 0.59 does not.
check('name bar 0.6 qualifies',
  selectFastCandidates([c('sv05-25', 'Iron Leaves ex', '25', '162', 0.6)], [g(25, 162)]).length, 1);
check('name bar 0.59 blocks',
  selectFastCandidates([c('sv05-25', 'Iron Leaves ex', '25', '162', 0.59)], [g(25, 162)]).length, 0);
// 9. Leading zeros are not evidence: '025' matches '25'.
check('leading-zero-insensitive number match',
  selectFastCandidates([c('sv05-25', 'Iron Leaves ex', '25', '162', 0.9)], [g(25, 162)]).length, 1);
// 10. Unknown set total on either side does not block (the
//     both-known rule, same as the rescue path).
check('unknown total does not block',
  selectFastCandidates([c('sv05-25', 'Iron Leaves ex', '25', null, 0.9)], [g(25, 162)]).length, 1);
// 11. A bare corner guess never qualifies the fast path (a bare
//     number sits in dozens of sets).
check('bare corner guess never qualifies',
  selectFastCandidates([c('svp-180', 'Dialga ex', '180', null, 0.95)], [g(180, null, { bare: true })]).length, 0);
// 12. A wrong-number candidate never qualifies, even with a hot name.
check('wrong number never qualifies',
  selectFastCandidates([c('sv05-203', 'Iron Leaves ex', '203', '162', 0.99)], [g(25, 162)]).length, 0);

// ---- applyCornerShotRule ----
// The rule demotes in place; the helper below reports survivors.
const ruled = (list, guesses) => {
  const copy = list.map((x) => ({ ...x }));
  applyCornerShotRule(copy, guesses);
  return copy.filter((x) => x.displayable).map((x) => x.id);
};
// 13. Banette case (production, JP Charizard strip): a glare-misread
// corner number (001/100, total agreement) with junk prior names
// must NOT stay displayable — no name agreement, no offer.
check('corner rule demotes wrong-Pokemon number crown',
  ruled([
    { id: 'banette-1', name: 'Banette', number: '1', displayable: true, numberMatch: true, nameSim: 0.22 },
    { id: 'dusknoir-1', name: 'Dusknoir', number: '1', displayable: true, numberMatch: true, nameSim: 0.19 },
  ], ['id yy moan', 'ON ad NP']), []);
// 14. Iron Leaves case: the true print keeps its offer — full number
// match AND the banked prior name agreeing (OCR read "Iron eaves").
check('corner rule keeps number+name agreement',
  ruled([
    { id: 'sv05-25', name: 'Iron Leaves ex', number: '25', displayable: true, numberMatch: true, nameSim: 0 },
  ], ['Iron eaves Ei a']), ['sv05-25']);
// 15. A candidate's own nameSim counts even with no prior names.
check('corner rule keeps own nameSim agreement',
  ruled([
    { id: 'sv05-25', name: 'Iron Leaves ex', number: '25', displayable: true, numberMatch: true, nameSim: 0.86 },
  ], []), ['sv05-25']);
// 16. No full number match, hot name or not: a corner fragment's art
// or bare number never crowns on its own.
check('corner rule demotes art-only candidate',
  ruled([
    { id: 'sv05-203', name: 'Iron Leaves ex', number: '203', displayable: true, numberMatch: false, nameSim: 0.99, pictSim: 0.85 },
  ], ['Iron Leaves ex']), []);
check('corner rule demotes bare-number candidate',
  ruled([
    { id: 'svp-180', name: 'Dialga ex', number: '180', displayable: true, numberMatch: false, bareNumMatch: true, nameSim: 0.95 },
  ], ['Dialga ex']), []);
// 17. Non-displayable candidates are untouched (no resurrection).
check('corner rule never resurrects',
  ruled([
    { id: 'raichu-98', name: 'Raichu ex', number: '98', displayable: false, numberMatch: true, nameSim: 0.9 },
  ], ['Raichu ex']), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
