# Phase 2 Spike — Picture-Matching + Own Card Database

**Purpose:** Decide the Phase 2 architecture (replace OCR-first identification with
picture-matching against our own catalog) using measured evidence, before building it.
**Status:** IN PROGRESS — this doc is updated after each step; gaps are marked honestly.
**Date:** 2026-10-06. **Base:** production commit `e111954`. No app behavior changes in this spike.

Test photos used throughout (the user's real cards):
Victini (Evolving Skies #20 EN), Dialga ex (SVP promo #180), Meowth (Phantasmal Flames #106),
Flapple VMAX (Battle Styles #19), Mega Abomasnow ex (Mega Evolution #157),
Galvantula ex (Stellar Crown #051, crop from app screenshot), Tyranitar ex (Prismatic Evolutions #064),
Dragonite VSTAR (JP Pokémon GO s10b #050 — JP test card, EN twin is Pokémon GO #050).

---

## Step 1 — Catalog pull (TCGdex → our own JSON)

_Script: `scripts/build-catalog.mjs` (resumable; details cached as JSONL under `data/`, which is gitignored)._

### English (en) — DONE
- Sets: **220**. Cards: **23,736**. Catalog JSON: **4.87MB**. Total pull ≈ **34 min**
  (briefs 76s; details 23,733/23,736, 3 failures).
- With image: **21,987 (92.6%)**. With USD (TCGplayer) price: **19,098 (80.5%)**.
  With EUR (Cardmarket) price: 20,117 (84.8%).

### Japanese (ja)
- Sets: **184**. Briefs: **12,781 cards**, pulled in **110s**.
- **⚠️ DATA GAP (measured):** TCGdex's Japanese database is patchy. Only **3,882 of 12,781
  briefs (30%) carry an image**, and entire Sword-&-Shield-era sets return **zero cards**
  (e.g. S1H, and **S10b "Pokémon GO" — the set containing the user's JP Dragonite VSTAR
  050/071 — has set metadata (71 cards official) but an empty card list and 404 card details**).
  Newer sets are complete (SV1S 108/108, SV-P 288/288, M1L 92/92).
  → **The user's JP test card does not exist in TCGdex JA at all** — no image, no price.
  Any JP support built on TCGdex alone silently misses older JP sets; Step 4/5 must
  source JP data elsewhere or lean on the EN twin (same art) for those cards.
- Detail pass: **DONE** — 12,781/12,781 details, 0 failures, total pull ≈ **22 min**.
- **Final JA stats:** cards **12,781**, sets **184**, catalog JSON **2.42MB**,
  with image **3,882 (30.4%)**, with EUR (Cardmarket) price **10,287 (80.5%)**,
  with USD (TCGplayer) price **0 (0.0%)** — TCGdex JA carries no USD pricing at all,
  so JP prices in Phase 2 are EUR-denominated (or converted) by construction.

### Shipping notes
- The full briefs list is one 2.4MB API call (`/v2/en/cards`, ~2s); set-by-set pulls are
  only needed to attach set names. Detail records (pricing/rarity) are the slow part:
  ~1,000 cards/45–110s at concurrency 14 against the live API (pace drops when jobs share it).
  A nightly rebuild at this pace is ~35 min (EN) + ~22 min (JA) — fine for a scheduled job.
- Measured catalog JSON sizes are small (EN 4.87MB, JA 2.42MB — ~200 bytes/card),
  so shipping the catalogs inside the function bundle is a non-issue size-wise.

---

## Step 2 — Embedding index (offline build)

- Model: **Xenova/clip-vit-base-patch32** (quantized ONNX vision encoder, 512-dim).
  Vision model file = **85MB** (`vision_model_quantized.onnx`); warm load ≈ **0.7–2.2s**,
  first-ever load incl. download ≈ 14s on this VM.
- Smoke test (before the index build): photo of Victini vs official art —
  cos(photo, official Victini) = **0.817** vs cos(photo, official Flapple) = 0.727.

### Subset build (measured) — `scripts/embed-index.mjs`
- **Scope embedded (exactly):** every image-bearing card from Battle Styles, Mega Evolution,
  Phantasmal Flames, Stellar Crown, Evolving Skies, Prismatic Evolutions, Pokémon GO (EN),
  Celebrations, Lost Thunder, Twilight Masquerade, SVP Black Star Promos (EN), and JP sets
  SV-P / M2a / S12 — **1,894 EN + 663 JP in-set cards** — plus **3,000 seeded-random EN +
  400 JP distractors**. **Total: 5,384 vectors.** (A subset, per the spike plan — the
  confusable neighborhoods of all 8 test cards are complete; ranks below are therefore
  *optimistic* vs. a full-catalog index, which adds ~5× more distractors.)
- Build: **1,127s (~19 min)** on this shared 2-core VM, **0 failures**.
  Avg inference **121ms**/image; the rest is image download + preprocessing.
- Index size: **2.63MB** int8 for 5,384 vectors (512 dims → 512 B/vector + per-vector scale).
- **Full-catalog extrapolation:** image-bearing cards = EN 21,987 + JA 3,882 = **25,869**
  → int8 index ≈ **13.2MB**; full build ≈ **~90 min** single-process on this VM
  (≈15–25 min sharded ×4 on a 4-vCPU CI runner; incremental nightly rebuilds only embed
  new/changed cards, so steady-state nightly cost is minutes).

---

## Step 3 — Accuracy eval on the 8 real photos

_Script: `scripts/eval-photos.mjs`. Prep mirrors production: EXIF-rotate → `lib/locate.js`
crop when a box is found (mode ≠ 'frame'), else the full photo. Galvantula's photo is a
manual crop from the user's app screenshot (left 165, top 375, 905×1300 of the 1320×2868
screenshot — the full card, number legible), matching prior passes' crop spec.
Model cold load in-process (warm disk cache): **725ms**. Photo inference: **179ms** first
photo (ONNX warm-up), then **47–101ms** steady. Full-index cosine scan (5,384 vectors,
naive typed-array loop): **4–15ms** → full 25,869-vector catalog ≈ 25–70ms extrapolated._

| # | Photo (prep) | Correct print rank | Sim | Notes |
|---|---|---|---|---|
| 1 | Victini (located crop) | **1** | 0.842 | clean win, margin +0.002 over #2 |
| 2 | Dialga ex SVP (full) | **1** | 0.814 | promo identified by picture alone |
| 3 | Meowth (full) | **928** | 0.679 | **hard miss** — see below |
| 4 | Flapple VMAX (located crop) | **2** | 0.821 | #1 is Tapu Koko VMAX (same set) at 0.824 — a 0.003 coin flip |
| 5 | Mega Abomasnow ex (full) | **13** | 0.815 | dense pack: #1 at 0.827, ranks 1–13 within 0.013 |
| 6 | Galvantula ex (manual crop) | **1** | 0.825 | its own full-art variant #159 ranks #4 (0.821) — same-art prints stay ambiguous by picture |
| 7 | Tyranitar ex (full) | **5** | 0.819 | dim light + fabric bg; correct card inside a tight top-5 (0.819–0.830) |
| 8 | Dragonite VSTAR **JP** (located crop) | **absent** | — | JP print **not in TCGdex at all** (Step 1 gap). EN twin (Pokémon GO #050, same art): **rank 12**, sim 0.813. Best JA entry overall was a wrong card (Lumineon V, S9) at rank 1 |

**Scoreboard:** top-1 = 3/8 · top-5 = 5/8 · top-15 = 6/8 · one hard miss (Meowth) · one
impossible-by-data (JP Dragonite). EN-only: top-1 3/7, top-5 5/7, top-15 6/7.

### What the failures teach (all measured, incl. supplementary runs)
- **Meowth is a model miss, not a prep bug.** A manual tight crop did *worse* (rank 2,401,
  sim 0.653) than the full photo (928, 0.679), and the indexed official art is verified to
  be the correct card. The sleeved, glare/shadow photo of this watercolor illustration
  embeds ~0.65–0.68 vs. its own art while every other card's photo sits at 0.81–0.84.
  A similarity floor (~0.80) cleanly separates this case → it should trigger fallback,
  not a wrong answer. (This is also the card where OCR's number read — 106/094, perfect —
  is strongest: the two channels' weaknesses are complementary.)
- **Localization helps when it works:** Flapple full-photo = rank 10 (0.775) vs. located
  crop = rank 2 (0.821). But locate failed (mode 'none') on 5 of 8 photos and produced a
  card-clipping crop (h 0.60) on the JP Dragonite — prep quality is a variable, not a given.
- **Same-art / same-set neighbors are the confusables** (Flapple vs. Tapu Koko VMAX;
  Galvantula #051 vs. its #159 full-art; Abomasnow inside a 13-card 0.013-wide pack).
  Picture similarity alone cannot reliably split these — the collector-number co-signal can.
- **JP photos don't match their EN twins reliably either** (twin rank 12 cropped / 29 full,
  sims 0.80–0.81, behind generic JP V/ex art) — JP support needs JP data, not twin-matching
  optimism.

---

## Step 4 — Runtime architecture decision

Platform facts (Vercel, verified against current docs summaries 2026-10-06):
function bundle limit **250MB uncompressed**; Hobby = **2GB RAM / 1 vCPU** (Fluid),
/tmp = 512MB. Measured component sizes: CLIP vision model (quantized) **85MB**;
onnxruntime Linux/x64 native lib **16MB** (the other ~75MB of the npm package is
other platforms and doesn't ship); full int8 index (EN+JA, image-bearing) **≈13.2MB**;
catalogs **7.3MB**; sharp libvips 16MB (already in the app).

### (a) Server-side embedding in the Vercel function — FEASIBLE, recommended primary
- Everything the matcher needs ≈ 85 (model) + 16 (runtime) + 13 (index) + 7 (catalogs)
  ≈ **121MB** on top of the existing app — **fits the 250MB bundle** with headroom;
  no cold-start downloads required. (transformers.js JS itself is a few MB bundled.)
- In-memory: index dequantized to float32 = 25,869 × 512 × 4B ≈ **53MB** — trivial vs 2GB.
- Warm timings (this 2-core VM ≈ Vercel's 1 vCPU, order-of-magnitude): model load
  **0.7–2.2s** once per warm instance; photo inference **50–180ms**; full-catalog
  cosine scan **<100ms** extrapolated; catalog price lookup = local array, ~0ms.
- Cold start penalty: one ONNX session build (~1–3s, estimate from local loads)
  on the first scan hitting a fresh instance; Fluid instance reuse makes this rare
  in practice for a family app, and it's still ≪ today's 8–45s OCR waits.

### (b) Browser-side embedding on the phone — NOT recommended as primary
- Model download = **85MB** before first use. Even with service-worker caching that's a
  brutal first load for a kids' web app on home Wi-Fi, and Safari cache eviction can
  force re-downloads.
- iPhone inference: **ESTIMATE (unverified, from general transformers.js-WASM
  experience): ~0.3–1.5s** per photo on recent iPhones via WASM; WebGPU could cut it
  but support/consistency in iOS Safari is still shaky. Plus the 13MB index +
  7MB catalog would also ship to the phone.
- Verdict: viable as a later offline nicety, wrong as the main path.

### (c) Hybrid — picture-match primary + OCR as co-signal/fallback — **RECOMMENDED**
Step 3 is unambiguous: picture-matching alone gets top-1 on 3/8 and outright misses
Meowth; OCR alone is today's 8–45s saga with its own hard classes. Their failure modes
are complementary (Meowth: picture sim 0.68 but number OCR perfect; Dialga promo:
no NNN/TTT for OCR, but picture rank 1). Design:
1. Photo → locate/crop → embed → rank against full index (~0.3s of compute).
2. **Confident zone:** top-1 sim ≥ ~0.80 **and** a clear margin (≥ ~0.01 over the best
   different-print) → answer immediately from the local catalog. (Victini, Dialga,
   Galvantula live here.)
3. **Ambiguous zone** (low sim, thin margin, or same-name/same-set neighbors in the
   top-K — Flapple, Abomasnow, Tyranitar, Galvantula-variant cases): run the existing
   OCR number/name channels *against the top-K candidate pool only* (number match
   against ≤10 candidates is a cheap, decisive vote), then re-rank. Kids still just
   tap among ≤3 gated pictures, exactly like today.
4. **No-match zone** (top sim < ~0.75 — the Meowth signature): fall back to the full
   current OCR pipeline unchanged. Worst case equals today's behavior, never worse.
- **Expected end-to-end latency (warm instance, measured components + network):**
  upload of the client-shrunk photo ~0.3–1.0s + locate ~0.05s + embed ~0.1–0.2s +
  scan <0.1s + local lookup ~0s ⇒ **≈0.6–1.5s for confident-zone cards** (the majority
  of binder scans); **≈3–10s** when the OCR co-signal fires; **8–45s only** on the
  rare full-fallback path. Compare today: 8–45s for *everything*.

### Shipping & freshness
- **Artifacts:** catalog JSONs (7.3MB) + int8 index (~13.2MB) + model (85MB, static —
  ships with the code, never rebuilt).
- **Nightly GitHub Action:** re-run `build-catalog` (EN ~35 min + JA ~22 min at API
  pace; prices are the only daily-changing part), re-embed **only new/changed card
  images** (image cache keyed by card id; steady-state ≈ minutes), upload artifacts
  to **Vercel Blob**, and trigger a redeploy whose build downloads the artifacts into
  the function bundle (keeps git free of ~20MB of daily-churning binaries, keeps
  runtime free of fetch latency). Price freshness ≤24h — fine for family trades.
- **JP cost:** +2.4MB catalog, +~2MB index (only 3,882 of 12,781 JP cards have images).
  The JP *data gap* (whole SWSH-era sets missing from TCGdex, incl. the user's S10b
  Dragonite; 0% USD pricing) is **not** solvable by this architecture alone — Stage 2
  should either add a JP data source or ship JP as: picture/OCR finds the card where
  data exists, EN-twin shown as a clearly-labeled stand-in choice where it doesn't,
  EUR pricing converted at a daily rate. Flagged as an open product decision.

---

## Step 5 — Recommendation + Stage-2 build plan

**Recommendation: build (c) — server-side hybrid.** Picture-matching (CLIP ViT-B/32,
quantized, in the Vercel function) as the primary identifier against our own nightly
catalog+index; the existing OCR pipeline demoted to (i) co-signal that disambiguates
the picture matcher's top-K and (ii) full fallback when picture confidence is low.
Do **not** build browser-side embedding as the primary path (85MB phone download).
Expected result: most scans answer in **~1–2s end-to-end**, hard cards in ~3–10s,
and nothing gets slower than today.

### Stage-2 checklist
- [ ] Full-catalog embedding build (EN 21,987 + JA 3,882 image-bearing cards) as a
      sharded CI job; publish index + catalogs to Vercel Blob with a version manifest.
- [ ] Nightly Action: catalog refresh (prices), incremental re-embed of new/changed
      images, artifact upload, redeploy with artifacts bundled at build time.
- [ ] Server: `lib/pictmatch.js` — lazy model/index singletons, locate→embed→rank,
      returns top-K with sims + margin; wire into `/api/identify` ahead of OCR.
- [ ] Confidence policy: confident / ambiguous / no-match zones per Step 4(c)
      thresholds (tune on the 8-photo suite + new photos as they arrive); ambiguous
      zone runs OCR number/name against top-K only; keep the existing confidence
      gate + tap-your-card UI contract unchanged (displayable rules stay).
- [ ] Acceptance suite: the same 8 photos must reach correct-print-as-tappable-choice
      (or honest stumped) through the *live* endpoint — with per-card latency logged;
      target: ≥5 of 8 under 3s, none over today's times, zero wrong displayables.
- [ ] JP decision (product): add a JP data source for TCGdex's missing sets, or ship
      the labeled EN-twin stand-in + EUR→USD conversion for JP prices.
- [ ] Retire-or-keep call on the OCR attack-rescue path once hybrid acceptance passes
      (it remains the Abomasnow-class safety net until the numbers say otherwise).

### Known limitations of this spike
- Index was a 5,384-vector subset (all confusable neighborhoods complete + 3,400
  distractors); production ranks vs. 25,869 vectors will be somewhat worse.
- Latency figures are from this shared 2-core VM, not from inside Vercel; Stage 2's
  first task should re-measure warm inference + cold start in the real function.
- Browser-side iPhone inference is an unverified estimate (Step 4b) — it wasn't
  load-bearing for the recommendation.
