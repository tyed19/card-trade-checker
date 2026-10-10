# Fix pass 2026-10-10 — Charizard ex (SVP 074), Mega Charizard X ex (me02-013), Dark Gyarados (Celebrations)

User report: both Charizards failed in-app ("It wasn't able to get these two"),
then a third: Dark Gyarados (Celebrations Classic Collection reprint, printed
8/82), plus a pattern: "the blue 'my card' always fails — their card works."

## Diagnosis (evidence from live repro ×4/card + local stage diagnostics)

### Picture channel (all three cards)
CLIP genuinely cannot rank these prints. Measured with the committed model:
- Charizard svp-074: rank ~2936 (tight crop) / ~8224 (full frame), sim ~0.76.
  Production top-60 is shiny full-art mush; the true card never enters the pool,
  which starves every pool-dependent lane (cross-check, co-signals, veto cover).
- Mega Charizard X me02-013: rank ~180 even with a hand-tight crop (production
  locate box cuts the card at h=0.85, rank ~464). Still outside top-60.
- Dark Gyarados: the Celebrations print cel25cc-CC005 is ABSENT from the index —
  TCGdex has no image for ANY of the 25 Classic Collection cards, so none were
  ever embedded. The vintage twin base5-8 ranks only 58 (sim 0.7803).
No crop/prep variant rescues the pool. Fixes must come from the OCR channels.

### Charizard ex SVP 074 (sleeve)
- Locate FAILS (mode 'none') on the sleeved photo → frame-relative slices.
- Number cascade settles on a WRONG full read 011/73 (2 votes, from the
  "SVP EN 074" promo line) — candidates Carvanha #11 etc., saved from display
  only by the picture veto.
- Name reads junk ("AHH", 2 votes) — and because a full numberGuess AND a
  nameGuess both existed, the attack-rescue stage was SKIPPED entirely
  (condition was `!numberGuess || bareOnly || !nameGuesses.length`).
  Attack tokens ("Burning Darkness") were never collected → findCandidates'
  rescue never had its one winning channel. Even with tokens, findCandidates
  would skip rescue: the wrong-number candidate is "displayable with number
  evidence" internally (stillWeak=false); the veto only demotes it afterwards.
- Bare promo channel: a wide slice DID read "SVP | 0741" (074 + ★ misread as 1),
  but bare extraction never runs when a full guess exists, and "0741" (4 digits)
  is rejected by the bare token rules anyway.
- Phone-sim runs crowned a WRONG DISPLAYABLE: Porygon-Z #74 (score 77,
  displayable) — bare 074 (no hint) claimed a pool member from a regular set;
  the gate's bare+pictSim clause (≥0.78) fired at sim 0.855. The true promo was
  not in the pool to compete. Any bare read can do this to any same-number pool
  card; Dialga (svp-180, promo set) is the legitimate user of that clause.

### Mega Charizard X ex me02-013 (glare)
- Number stage consumed 21.9–26.7s of the 26s OCR budget (zero-vote grind:
  10 tight + 10 secondary + 10 negated + threshold passes over glare noise).
  Name and attack stages then started past the deadline: every pass threw
  'ocr-budget-exceeded', nameTexts EMPTY, attackTokens EMPTY. Phone-sim runs
  died at the 50s route deadline outright. (The Abomasnow starvation class,
  now in the number stage itself.)
- The digits WERE partially read on the full frame: "(011,094" / "(11,094" —
  013/094 with the slash read as a comma and 3→1. numbersFromText has no
  comma repair, so even that evidence was discarded.
- Attack "Inferno X" is a proven rescue token (pokemontcg: me2-13, $5.04) —
  unreachable while the budget is starved.

### Dark Gyarados (Celebrations reprint, clean photo)
- Vintage WotC layout prints the number bottom-RIGHT; every number box is
  bottom-LEFT. Number stage read flavor text for 12s, found nothing.
- Name OCR failed completely on the vintage name band (junk tokens only).
- Attack tokens were rich (Dark/Power/Gyarado/Beam…) but "Final" (of
  "Final Beam") fell below the top-6 assembly cut and pokemontcg lists the
  card's attack as "Ice Beam" — one-token matches are suppressed when any
  card confirms 2 tokens, so the rescue cannot crown it either.
- The catalog row cel25cc-CC005 has localId "CC005" (printed number is 8/82),
  NO image, EUR €6.25. The vintage original base5-8 ($222.18) must never be
  crowned for this photo (35x price error). pokemontcg DOES carry the
  reprint: cel25c-8_A, $5.24, image images.pokemontcg.io/cel25c/8_A_hires.png
  (verified 200) — the "_A" suffix was the missing piece.

### Client (MY-vs-THEIR asymmetry)
- app/page.js onPhoto is ONE shared handler for both sides: same endpoint,
  params, processing. No per-side request difference exists.
- Doubled "Tap your card! 👇" (user screenshot): on choices, status is set to
  'Tap your card! 👇' AND the choices block renders its own .q heading with
  the same text — always doubled, both sides. (Binder ScanSession does not
  double: it never sets that status text.)
- Stale choices: onPhoto does NOT clear choices when a scan starts, and the
  choices block renders regardless of busy → a previous photo's choices stay
  visible/tappable during a re-scan; pickChoice mid-scan adds the WRONG card,
  then the in-flight response overwrites state. No request-sequence guard:
  overlapping same-side requests resolve last-writer-wins.
- Cold-start asymmetry (mechanism for "MY fails, THEIR works"): MY is scanned
  first and pays Vercel cold start + CLIP load + tesseract init against the
  hard 50s deadline; THEIR scan runs warm. warmPict() exists but had NO caller.
  All three cards ALSO fail at the endpoint level (proven by direct POSTs),
  so the failures are primarily server-side identification; the client issues
  are real secondary defects that amplify them on the first scan.

## Fixes (this pass)
Server:
1. ocr.js — number-stage soft cap (50% of budget, full reads only) so name +
   attack stages always get their share; cascade steps honor it.
2. ocr.js — attack rescue trigger: a weak name (no guess, top rec <2 votes,
   or top guess <5 chars) no longer suppresses the rescue.
3. ocr.js — numbersFromText comma repair: "011,094" → 11/94 (strict shape:
   second group exactly 3 digits, totals sanity-checked by push()).
4. ocr.js — vintage bottom-RIGHT number boxes, only when the left channel
   found zero votes.
5. ocr.js — bareNumbersFromText: a 4-digit token ending in '1' in a
   promo-prefixed slice also yields its first 3 digits (the "074★"→"0741"
   star-glued read).
6. identify.js — gate: the bare+pictSim clause needs pictSim ≥0.86 for
   non-promo prints (promo prints keep 0.78). Closes the Porygon-Z hole
   without touching the Dialga path.
7. identify.js — findCandidates: a displayable top candidate that the
   picture pool contradicts (absent from pool) no longer blocks the attack
   rescue when attack tokens exist (the veto demotes it later anyway).
8. hybrid.js — matchKind honors catalog printedNum/printedTotal (Celebrations
   Classic Collection aliasing).
9. pictmatch.js — candidateFromCatalog: non-TCGdex image URLs (no /low.png
   suffix) are used as-is instead of getting '/high.png' appended.
Data:
10. data/cc-overrides.json (derived from pokemontcg cel25c: image URL,
    printedNum, printedTotal from the vintage twin) applied to catalog-en.json
    (image + printedNum + printedTotal for all 25 cel25cc cards) and the 25
    images embedded + appended to index-full. build-catalog.mjs re-applies
    the overrides on nightly rebuilds so coverage survives refreshes.
Client:
11. page.js — choices heading no longer duplicated (status '' when choices
    show); choices cleared at scan start; per-side request token drops
    stale responses.
12. /api/warm + page-load warm ping (best-effort cold-start mitigation:
    warms CLIP + tesseract on the instance that serves the page region).

Invariants kept: gate not weakened anywhere (fix 6 TIGHTENS it); the veto is
untouched; base5-8 can only be beaten, never auto-crowned — CC005 wins the
Gyarados pool claim on its own art similarity, with both prints shown as
honest tap choices when both are displayable.

## Additional root causes found while fixing (local pipeline traces)

11. cardbook.nameSimilarity degenerate-norm flaw (PRE-EXISTING, exposed by
    fixes 1-2): normName strips kana, so every Japanese "…V" card normalizes
    to "v" (length 1). The substring shortcut `a.includes(b) -> 0.92` then
    fired for ANY guess containing the letter v ("AGE ZV om", "E volves
    Chanmeleon") — scoring 0.92 name agreement against every JA V card in
    the pool. Paired with shiny art (sim >= 0.78) the hybrid coName signal
    made three wrong JA cards displayable on the Mega Charizard photo the
    moment the name stage started running. Fix: a candidate name that
    normalizes to <3 chars can never name-match (returns 0); JA prints are
    identified by number/twin machinery, not Latin name OCR.
12. Name-guess ranking discarded a clean read: the pipeline DID read
    "MegaCharizard X(@X Za LIC" (frame box 3, after widening the secondary
    name assist from 3 to 5 boxes — the winning box was one past the cap),
    but nameRecsFromTexts ranked six 1-vote junk recs ahead of it on
    firstIdx and nameGuessesFromTexts cut at 6. Fixes: vote ties break
    toward multi-token/longer recs; cleanNameLine splits camel-humped
    tokens ("MegaCharizard" -> "Mega Charizard"); findCandidates searches
    4 name guesses instead of 3 (guesses kept: 5).
13. Ability titles were invisible to the rescue: pokemontcgSearchAttack
    only queried attacks.name and mapPokemontcg dropped abilities. For
    Charizard ex the readable big title is its ABILITY "Infernal Reign"
    (the attack line sits in the sleeve-glare zone and no OCR variant
    reads "Burning Darkness" on this photo). Fixes: the search queries
    attacks OR abilities; ability names fold into candidate attacks;
    the rescue verifies tokens fuzzily (a glue-merged token containing
    a title's first word counts — "InfernaljRe" + "Reign" = the two
    confirmations); OCR attack assembly keeps 8 tokens (was 6 — "Reign"
    was being cut) and the rescue searches all 8 (was 5).
14. candidateFromCatalog priced EN EUR-only rows as null (the EUR->USD
    conversion existed only in the JA branch): CC005 came back displayable
    but priceless ($0 in a trade). EN rows with eur but no usd now get
    the same treatment as JA rows (converted, currency stays EUR so the
    fairness band widens). This affected ~1,000 Cardmarket-only EN rows,
    not just the Classic Collection.
15. Name prefix variants (ocr.js nameGuessesFromTexts): a name-band read
    runs past the name into HP/rule text ("Mega Charizard X Za LIC") and
    the junk tail drags similarity to 0.74, under every match bar; the
    clean 3-token prefix scores 0.84. Prefixes of the top reads are now
    searched/scored alongside the full lines.
16. Digit-variant last resort (identify.js findCandidates): when nothing
    is displayable and a fetched candidate has nameSim >= 0.8, a set
    total EXACTLY matching the read, and a number exactly one digit off
    the read, it earns a discounted number match (+70 vs the exact
    read's +100). The exact-read card (Charmander, on the Mega photo)
    still has to be — and is — removed by the picture veto; the variant
    survivor displays on name+total+art evidence. All three conditions
    required; fires only when the alternative is a retake.
