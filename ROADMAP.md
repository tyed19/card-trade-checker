# Card Trade Checker — Product Roadmap

A photo-only Pokémon card trade checker for little kids and their cousins:
take a picture of each side's card, get a huge FAIR / NOT FAIR verdict read
out loud. No typing, no reading, no accounts.

This document is the product direction for the app — where it stands, where
it goes next, and the rules every version has to keep.

## Where it stands today

The first real version of the app is built and pushed to this repo
(Next.js, deployed by importing the repo into Vercel).

- **Kid flow:** take a picture → the server identifies the card → tap the
  matching picture (✅ YES / NO) → same for the other side → tap
  **CHECK THE TRADE** → a big spoken FAIR / ALMOST FAIR / NOT FAIR
  verdict. Each side can hold several cards. A pretend-cards demo mode
  works without any real cards.
- **How identification works today:** the photo goes to the server
  (`/api/identify`), which reads the card's name band (top) and collector
  number band (bottom) with OCR, trying several image clean-ups. If the
  name/number read fails — common on shiny full-art cards — a rescue
  channel reads the attack names off the card and searches by those
  instead. The match is looked up in the free card books (TCGdex first,
  Pokémon TCG API as fallback), both with retries, and priced from
  TCGplayer market prices.
- **Verified on real photos:** the identification endpoint was tested
  against the family's own cards, twice per photo, with identical results
  both runs:
  - Flapple VMAX — Battle Styles #19 — $2.32
  - Mega Abomasnow ex — Mega Evolution #157 — $1.90 (identified via the
    attack-name rescue, because its glare/embossed title won't read)
  - Meowth — Phantasmal Flames #106 — $13.70
- **Grown-ups layer:** a collapsed section under the kid flow shows card
  names, numbers, and prices, and offers a manual name + number search
  as a last resort. Kids never see dollar amounts.
- **Known limits today:** identification takes roughly 15–45 seconds per
  card (OCR passes plus retries against flaky free APIs), and the Vercel
  route has a 60-second cap that can clip the slowest reads. Hard photos
  — full-art, embossed, high glare — are the toughest cases.

## The core idea

The trade checker is the wedge, not the whole product.

A checker on its own is a utility. But every time a kid scans a card to
check a trade, the app learns what's in that kid's binder. **Once the app
knows each kid's binder, it can see how the family's binders fit
together** — who has whose missing cards, whose duplicates could complete
someone else's set, and which trade would be fair *and* useful to both
sides.

That is the difference from existing collector apps: Collectr and similar
apps know one collector's portfolio. This would know a family's binders,
side by side.

It is family-only by design: known people (siblings, cousins, close
friends), trading in person. **No strangers, no chat, no open
marketplace.** That is a deliberate choice, not a missing feature — it is
also what separates this from family-trading apps built around meeting
other collectors.

## Phase 2 — Fast + Binders

Goal: make identification quick, and start remembering collections.

**Status (2026-10-07): COMPLETE. Identification shipped in `3bacb32`;
binders shipped with Phase 3 (see below) — on-device per-kid binders
with a scan-in session, duplicates, and tap-to-trade from the binder.**

- **Own the card book.** ✅ **Done.** Sync the full card catalog and prices into the
  app's own database on a nightly job, instead of calling free external
  APIs live during every scan. A scan should ask our own database, which
  answers fast and doesn't go down. (The free card books are unreliable
  and one of them is retiring — see Risks below.)
  *As built: EN 23,736 + JA 12,781 cards committed under `data/`
  (refreshed nightly by `.github/workflows/refresh-data.yml`, which
  re-pulls TCGdex, embeds only new cards, and commits so Vercel
  auto-redeploys). No external database service.*
- **Picture-matching identification.** ✅ **Done, as a hybrid.** Instead of reading tiny text off a
  shiny card, fingerprint every card's official artwork once (an image
  embedding index covering the whole catalog). A photo is fingerprinted
  the same way and matched against the index. Glare and busy full-art
  backgrounds stop mattering, because the match is on the artwork itself.
  Target: roughly 2–3 seconds per card, server-side.
  *As built: CLIP index of 25,847 prints; picture-matching proposes and
  OCR confirms/rescues (picture-only only at very high similarity —
  measured wrong picks reached sim .85, so the collector number
  co-decides). Verified live on the 8 real test photos + phone-sims:
  every photo correct-or-safe, zero wrong displayable picks; the
  picture-verified lane answers in ~1.2–1.5s server-side, hard cards
  escalate to the full OCR pipeline. Japanese cards are first-class
  (EUR pricing converted); a JP set missing from the data returns its
  English twin, labeled for grown-ups. Details: docs/PHASE2-BUILD.md.*
- **Binders.** ✅ **Done (2026-10-07, with Phase 3).** A "scan my binder" session mode: a grown-up or older kid
  scans a whole collection in one sitting. Cards are stored per kid,
  duplicates flagged. From then on, trades between cards the app already
  knows are just tapping pictures on both sides — effectively instant,
  with no recognition step at all. The slow scanner only runs when a
  genuinely new card shows up.
  *As built: binders live ON-DEVICE (localStorage, versioned schema) —
  no server database, no accounts. Cards are stored as compact catalog
  row refs (+ the catalog id, so a ref self-heals if a nightly rebuild
  ever shifts rows) and resolved through a batch `/api/cards` endpoint.
  A binder moves between devices via a share link that encodes
  (row, qty) pairs; importing merges quantities after a confirm.
  Details: docs/PHASE3-BUILD.md.*

## Phase 3 — Suggestions + Completion

Goal: with binders known, the app stops only judging trades and starts
proposing good ones.

**Status (2026-10-07): SHIPPED — all items below built and verified
(fixture tests 16/16, production build green, live spot checks in
docs/PHASE3-BUILD.md).**

- **Trade suggestions.** ✅ The app surfaces matches across the family's
  binders: "You have a double your cousin needs — and they have a double
  you need." *As built: 💡 Ideas screen per kid pair — perfect swaps
  (mutual doubles-for-needs inside the verdict's fair band) plus
  one-way "almost-finishing gifts" with a closest-value return; each
  idea preloads the trade in one tap. Prices stay in a collapsed
  grown-ups detail.*
- **Auto-balanced trade builder.** ✅ When a trade is lopsided, the app
  doesn't just say NOT FAIR — it proposes the add-on cards (from the
  lighter side's duplicates, where possible) that would make it even.
  *As built: ⚖️ MAKE IT FAIR on ALMOST/NOT FAIR verdicts searches the
  light side kid's spare copies for the 1–3 cards whose total best
  closes the gap (in-band preferred, least overshoot wins — fixture
  tests prove a $6+$5 pair beats a single $13.70 overshoot); when
  nothing lands in band it shows the closest and says so.*
- **Collection completion.** ✅ Per-set progress for each kid (for example,
  141 of 163), with the missing cards shown as ghost picture slots to
  hunt for. Sets that are closest to done are surfaced first, because
  finishing a set feels reachable at 12 cards away in a way it doesn't at
  100 away. A family cross-check shows when a card one kid needs is
  sitting in a cousin's duplicate pile.
  *As built: set chips closest-first on the binder home; set pages
  render the full set from `/api/set` with owned in color and missing
  as greyed ghost slots (number visible); ghost slots carry a
  "🦊 has a spare!" marker when another on-device binder holds a
  double; confetti at 25/50/75/100%.*
- **Parent layer.** ✅ (inside the grown-ups section, per kid)
  - Binder total value per kid, and duplicate trade-up ideas (turn three
    small doubles into one card the kid actually wants).
    *Binder value + doubles value shipped; the "three doubles → one
    card" trade-up framing is covered by the Ideas screen's swaps —
    a dedicated trade-up recommender is the one piece not built.*
  - **Gift Radar:** ✅ for birthdays and holidays, the exact missing cards a
    kid genuinely needs, in budget order — the answer to "what does he
    want?" that a parent or grandparent can actually act on. The list is
    shareable with grandparents.
    *As built: missing cards from the kid's 3 closest sets, price
    ascending, budget filter ($5/$10/$25/any), and a share link to a
    public `/gift/<encoded>` page (first name, pictures, set, number,
    price, list total) rendered from the server catalog — works on any
    device with zero app state.*
- **Kid motivation, without money.** ✅ Fair-trader badges for completing
  even trades, and a celebration when a set is completed. Progress and
  collecting are the game; prices stay in the grown-ups layer.
  *As built: ⭐ profile screen — Fair Trader tiers (1/5/10/25 logged
  fair trades, counted via the "We traded!" button on FAIR verdicts,
  with optional binder moves between assigned kids), Set Explorer
  badges at 50%+ and 👑 crowns at 100%, set-milestone confetti. All
  computed from binder + trade-log state; no tracking database.*

## Phase 4 — Native + instant

Goal: the point-and-it-knows feel of the big scanner apps.

- Wrap the same server in a native app (Expo, the same stack as the
  family's other apps), so the backend, binders, and data carry over
  unchanged.
- **Live camera scanning:** instead of take-a-photo-and-wait, the camera
  watches continuously, detects the card's edges, straightens the frame,
  and captures the sharp one itself.
- **On-device picture-matching:** a small version of the artwork index
  runs on the phone, for sub-second identification that doesn't even
  need internet. Prices come from the app's own database (Phase 2), kept
  current by the nightly sync.

## Standing design rules

These don't change between phases:

1. **A 5-year-old is the primary user.** Photo, pictures, and voice only.
   No typing and no reading required anywhere in the kid flow.
2. **Nothing between the photos and the button.** No walls of adult text
   in the middle of the kid flow — take a picture, tap the matching
   picture, tap CHECK THE TRADE.
3. **Verdicts are spoken.** Every status and verdict is read aloud for
   kids who can't read yet.
4. **Prices live in the grown-ups layer.** Kids see colors, faces, and
   fair / not fair. Dollar figures are shown only in the collapsed
   grown-ups section.
5. **A wrong answer is worse than "try again."** If a read isn't
   confident, the app asks for a retake (flat, bright light) or offers the
   grown-ups manual search — it does not guess and present a wrong card
   as fact. The picture-confirmation tap is part of that safety check.
6. **Prices are estimates.** Values are market estimates and depend on
   card condition; they guide a fair trade, they don't guarantee one.

## Open risks and notes

- **Pokémon IP.** The current version is for private, family use. Any
  public or commercial release needs the rebrand path first: a generic
  trading-card framing, Pokémon mentioned descriptively only (never in
  the branding, logo, or app name), a commercial data license underneath,
  and a clear not-affiliated disclaimer. No Pokémon permission is in
  place, and none should be assumed.
- **Free card-book APIs are a weak foundation.** They rate-limit keyless
  use and fail intermittently; pokemontcg.io additionally stops serving
  on 2027-03-01 and has closed new API-key registrations. This is the
  direct reason Phase 2 moves the catalog and prices into the app's own
  database.
- **Hard photos stay hard.** Full-art, embossed, and glare-heavy cards
  are the toughest identification cases. Picture-matching (Phase 2) and
  live capture (Phase 4) reduce the problem; until then, flat/bright
  retakes and the grown-ups manual search are the safety net.
