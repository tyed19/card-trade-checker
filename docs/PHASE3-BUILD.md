# Phase 3 Build — Binders, Suggestions, Completion, Parent Layer, Badges

**Base:** production `491370e` (Phase 2 hybrid live).
**Architecture (parent decision):** NO server database, NO new accounts.
Binders live on-device (localStorage, versioned key `ctc.phase3.v1`).
Portability via share links encoding compact catalog row refs
(`e<idx>` EN / `j<idx>` JA into `data/catalog-*.json` arrays). Server
renders shared pages (Gift Radar) from the committed catalog data.

Card refs also carry the catalog `id`; the resolver verifies the id
against the row and repairs the ref if a nightly catalog rebuild ever
shifts row order — binders self-heal, links are point-in-time.

## Stage log

- [x] Stage 1 — data layer: `lib/catalog.js` (server catalog access +
  ref system), `app/api/cards` (batch resolve refs/ids), `app/api/set`
  (full set listing for set pages), `lib/store.js` (on-device store),
  `lib/links.js` (share-link encode/decode).
- [x] Stage 2 — kid binder UI (`app/binder-ui.js` + page wiring +
  CSS): kid switcher/nav bar, binder home (picture grid, qty badges,
  set chips closest-first, doubles filter, qty sheet), set pages
  (ghost slots, spare-holder markers, confetti milestones at
  25/50/75/100% reusing existing clips — no new audio), scan-a-binder
  session reusing the identify pipeline + choices UI, from-binder
  trade picker per side (per-side kid assignment is one tap on the
  side's avatar row; picker respects owned quantities).
- [x] Stage 3 (logic half) — `lib/logic.js` pure functions (duplicates,
  perfect swaps, one-way gifts, auto-balance, gift radar, badges) +
  fixture tests `scripts/test-phase3.mjs`: **16/16 pass**, including
  the forced greedy auto-balance case ($6+$5 beats the $13.70 single
  for an $11.40 gap), gift-radar budget/sort, export→import round
  trip identical, import merge qty sums. UI wiring (MAKE IT FAIR,
  "We traded!") lands with Stage 2/3 UI below.
- [x] Stage 4 — parent layer (in the grown-ups box): kid profile
  management (add/rename/emoji/delete), per-kid binder value
  (qty-weighted total + doubles value + counts; EUR cards at converted
  USD), Gift Radar (3 closest sets, price ascending, budget filter
  $5/$10/$25/any, share link), binder share/import link (import offer
  banner on `/?import=…`, merges with qty sum after explicit tap).
  Public page: `app/gift/[code]/page.js` renders from server catalog.
- [x] Stage 5 — badges (⭐ profile screen): Fair Trader tiers
  1/5/10/25 from the on-device trade log ("We traded!" on FAIR
  verdicts; optional explicit binder move between the two assigned
  kids), Set Explorer badges ≥50%, 👑 at 100%. Computed from
  binder + log state only.
- [x] Stage 3 (UI half) — 💡 Ideas screen (perfect swaps + one-way
  finishing gifts, "Start this trade" preloads sides + kid
  assignment), ⚖️ MAKE IT FAIR on ALMOST/NOT FAIR verdicts, family
  cross-check markers on set pages.
- [x] Verify — fixture tests ✅ 16/16; production build ✅ green;
  local walk ✅ (endpoints, ref repair, gift page total exact,
  identify Victini + Meowth correct, no wrong displayables);
  live spot checks ✅ (below).
- [x] ROADMAP.md status updates (Phase 2 binders + Phase 3).

## Verification record (2026-10-07)

- **Fixture tests:** `node scripts/test-phase3.mjs` → **16/16 pass**
  (duplicates, value, set progress, perfect swaps, gift ideas,
  spare holders, auto-balance ×4 incl. the forced greedy case,
  gift radar sort/budget, badge tiers, ref↔code + payload round
  trips incl. unicode kid names, store ops + import merge sums,
  trade move + badge counting). The round-trip test caught a real
  bug before any UI shipped: lowercase `x` as the qty separator
  collides with base36 digits — separator is now capital `X`.
- **Build:** `npm run build` green; routes `/`, `/api/cards`,
  `/api/set`, `/api/identify`, `/gift/[code]` all present.
- **Local walk (production build, port 3107):** home 200; /api/cards
  pairs+ids resolve (Flapple VMAX e14008 $2.33, Meowth e22394
  $13.18 — nightly price drift vs the Phase 2 $13.70 snapshot);
  wrong-ref+correct-id pair **repaired** to the right row;
  /api/set Battle Styles 183 cards; /gift sample renders "Cards
  Alex would love!" with total **$15.74 = exact sum** of its 3
  cards; bad gift code → friendly error page; homepage SSR carries
  the Phase 3 hint bar + untouched CHECK THE TRADE flow.
  Identify regression (local): Victini ✅ #20 $0.33 displayable
  (5.2s); Meowth ✅ #106 displayable #1 (21.8s), zero wrong
  displayables.
- **Deploy:** commit `4bad1d3` pushed; GitHub deployment 6920617220
  (Production, sha 4bad1d3) status **success**.
- **Live spot checks:** home 200; /gift sample 200 with exact total;
  /api/cards + /api/set correct; identify Victini ✅ (6.3s) and
  Meowth ✅ #106 displayable #1 (17.2s), zero wrong displayables.
  **No Phase 2 regression.**

## Known limitations (plain)

- Client-rendered kid screens (binder grid, set ghosts, picker,
  MAKE IT FAIR) were verified via build + the exact API contracts
  they consume + fixture-proven logic/state — this environment has
  no headless browser, so no pixel-level DOM walk was possible.
  First real-device tap-through is the remaining proof.
- Share links are point-in-time: if a nightly catalog rebuild shifts
  row order between link creation and opening, a link could resolve
  a neighboring card (on-device binders self-heal via stored ids;
  links cannot carry ids without ballooning). Links are meant to be
  opened promptly (texted to grandma), so the window is small.
- "Trade-up" recommender (3 small doubles → 1 wanted card) from the
  roadmap's parent layer is represented by the Ideas screen's swaps,
  not a dedicated feature.
- Binder moves on "We traded!" only move cards that resolve to
  catalog refs; unresolvable cards (e.g. demo cards) are logged in
  the trade count but not moved — by design, never silent.

## Design notes

- **Refs:** `e12345` / `j6789` = row index into catalog-en/ja arrays.
  Link payload packs card codes (idx*2 + langBit) in base36, qty as
  `X<n>` (capital X — base36 output is lowercase, so the separator is
  unambiguous; fixture tests caught the lowercase-x collision);
  envelope JSON {v, t, kid, c} → base64url.
- **Prices:** resolved server-side mirroring candidateFromCatalog —
  EN = catalog USD; JA = Cardmarket EUR × ECB daily rate (currency EUR
  kept on the card object; verdict math uses the USD `price` field).
- **Catalog API justification:** binder grids need 100+ cards resolved;
  shipping the 8MB catalogs to the browser is worse than one batch
  POST. `/api/cards` resolves refs and/or catalog ids in one round trip.
- **Fair band reuse:** suggestions + auto-balance use the verdict's own
  band math (15% fair, ×1.5 wider when any card is EUR-sourced).
