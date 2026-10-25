#!/usr/bin/env node
// Fixtures for suppressTiedGroups (lib/identify.js) — the
// indistinguishable-tie guard. Cases mirror real production outputs:
// the Charizard ex SVP 074 rescue cluster (nine same-title prints,
// scores 123–127, no discriminating evidence) must yield NO
// displayable candidate, while a number-evidenced top or a clear art
// lead must survive untouched.
import { suppressTiedGroups } from '../lib/identify.js';

const cand = (id, name, score, extra = {}) => ({
  id, name, score, displayable: true, numberMatch: false, bareNumMatch: false, nameSim: 0.17, ...extra,
});

let pass = 0, fail = 0;
const check = (label, got, want) => {
  if (got === want) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}: got ${got}, want ${want}`); }
};
const disp = (list) => list.filter((c) => c.displayable).map((c) => c.id);

// 1. Bug 1 cluster: Charizard ex family tied 123–127 + Infernape +
//    Ceruledge singletons, none evidenced -> NOTHING displayable
//    (layer 1 demotes the family; layer 2 withholds the singletons
//    because the best answer itself was tied).
{
  const list = [
    cand('sv4pt5-234', 'Charizard ex', 127), cand('sv3-223', 'Charizard ex', 126),
    cand('svp-196', 'Charizard ex', 126), cand('sv3-125', 'Charizard ex', 125),
    cand('sv3-228', 'Charizard ex', 125), cand('sv4pt5-54', 'Charizard ex', 125),
    cand('sv3-215', 'Charizard ex', 124), cand('svp-74', 'Charizard ex', 124),
    cand('svp-56', 'Charizard ex', 123),
    cand('swsh9-26', 'Infernape', 123), cand('me2-20', 'Ceruledge', 123),
  ];
  suppressTiedGroups(list);
  check('bug1 cluster -> zero displayable', disp(list).length, 0);
}

// 2. Trustworthy top survives: number-matched card above a tied
//    family below -> top stays, family demoted.
{
  const list = [
    cand('xy12-11', 'Charizard', 240, { numberMatch: true }),
    cand('base1-4', 'Charizard', 127), cand('base4-4', 'Charizard', 126),
  ];
  suppressTiedGroups(list);
  check('evidenced top survives, tied family demoted', disp(list).join(','), 'xy12-11');
}

// 3. Clear art lead: same-name pair, 15-point spread, no other
//    evidence -> both survive (art genuinely distinguished one).
{
  const list = [cand('a-1', 'Pikachu', 140), cand('a-2', 'Pikachu', 125)];
  suppressTiedGroups(list);
  check('clear art lead survives', disp(list).length, 2);
}

// 4. Evidence inside the group saves only the evidenced member:
//    the number-matched print is the answer; the attack-only sibling
//    is a distractor and must not stay a tap choice.
{
  const list = [
    cand('b-1', 'Gyarados', 130, { numberMatch: true }),
    cand('b-2', 'Gyarados', 128),
  ];
  suppressTiedGroups(list);
  check('evidenced member survives, plain sibling demoted', disp(list).join(','), 'b-1');
}

// 5. Singleton: a lone displayable is never a tie.
{
  const list = [cand('c-1', 'Mewtwo', 120)];
  suppressTiedGroups(list);
  check('singleton survives', disp(list).length, 1);
}

// 6. Different names, close scores: not a same-name tie.
{
  const list = [cand('d-1', 'Infernape', 123), cand('d-2', 'Ceruledge', 123)];
  suppressTiedGroups(list);
  check('different names survive', disp(list).length, 2);
}

// 7. Strong name evidence saves a tied group (nameSim >= 0.8).
{
  const list = [
    cand('e-1', 'Dialga', 130, { nameSim: 0.92 }),
    cand('e-2', 'Dialga', 129, { nameSim: 0.9 }),
  ];
  suppressTiedGroups(list);
  check('strong-name group survives', disp(list).length, 2);
}

// 8. Non-displayable input untouched: the guard only demotes
//    displayable candidates, never promotes.
{
  const list = [cand('f-1', 'Onix', 60, { displayable: false })];
  suppressTiedGroups(list);
  check('non-displayable stays non-displayable', disp(list).length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
