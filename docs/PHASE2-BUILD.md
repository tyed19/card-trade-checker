# Phase 2 Build — Picture-Matching Hybrid (server-side)

**Base:** production `e111954`. **Spike:** docs/SPIKE-PHASE2.md (all measurements there).
**Architecture:** HYBRID — picture-matching (CLIP, server-side, own catalog+index)
proposes; OCR confirms/rescues. This doc is checkpointed as each stage completes.

## Calibration decisions (from spike data, before coding)

Measured top-1 margins on the subset index: Victini **.0020** (correct),
Dialga **.0068** (correct), Galvantula **.0016** (correct) — but Flapple's
**wrong** top-1 (Tapu Koko VMAX) sits at margin **.0028** over the correct
Flapple. **Margins alone cannot separate right from wrong top-1s** — any
pure-picture confident rule that admits Victini also admits Flapple's wrong
pick. What separates them is the collector-number co-signal against the
picture pool (the spike's Step-4(c) design). Zones therefore:

- **picture-confident**: sim ≥ 0.80 AND margin over #2 ≥ 0.01 AND no same-name
  rival in top-5 → answer from catalog alone, no OCR. (Few of the 8 test
  photos land here; distinctive-art real-world cards will.)
- **picture-neighbor**: sim ≥ 0.80 but the top group contains same-name
  rivals (same-art prints, e.g. Galvantula #051 vs #159) → number-band-only
  OCR read disambiguates the print; unmatched group members stay as tap
  choices (the kid's eyes + the number break the tie).
- **picture-ambiguous**: sim ≥ 0.70 otherwise (incl. all tiny-margin packs)
  → cheap number-band cross-check against the picture top-10 first (any
  OCR number guess, full or bare, can corroborate a pool member →
  numberMatch evidence → displayable). If the number read is empty or
  matches nothing in the pool, escalate to the full existing OCR pipeline
  with the picture pool as an intersection boost; picture-only candidates
  can still earn displayable via a co-signal (number match vs any guess,
  or OCR name similarity ≥ 0.8 with sim ≥ 0.78). OCR numberMatch candidates
  override picture picks (number evidence outranks art).
- **no-match**: sim < 0.70 (the Meowth signature, 0.679) → today's full
  OCR path, untouched.

**Refinements from the subset-index smoke test (2026-10-06, pre-full-index):**
5. **Set-total agreement required for pool number matches** (`matchKind`):
   the Meowth photo's full number 106/**094** "matched" a Japanese
   Skuntank V #106 (a 98-card set) on localId alone and crowned it.
   Catalog entries now carry `setTotal` (printed total from the TCGdex
   set brief); a full-number guess only claims a pool member whose total
   agrees. Cross-check winners that end up non-displayable now fall
   through to escalation instead of settling.
6. **Shard incident**: both embedding shards were OOM-killed mid-run
   (during a concurrent `next build`). Bins held 76/59 un-flushed
   vectors past the progress files; truncated to the progress counts
   and resumed cleanly — merge-index validates sizes before shipping.
   (Lesson: no `next build` while shards run.)
1. **Pure-picture lane raised to sim ≥ 0.86.** A wrong card (Japanese
   Neolant V for the Dragonite photo) measured top-1 sim **.8322** — inside
   the original 0.80+margin confident band. So 0.80–0.86 always takes the
   number co-signal (early-exit keeps it fast); only ≥ 0.86 skips OCR.
2. **Cross-check window widened top-10 → top-25** — the EN Dragonite twin
   ranks ~12–29 by art; the number decides, art only nominates.
3. **Same-name grouping is script-safe**: `normName()` erases Japanese
   names to junk ("v"), which once grouped unrelated JA cards as
   "neighbors" and produced a wrong displayable pick. Grouping now uses
   `nameKey()` (raw-name fallback when the normalized key is < 3 chars)
   plus a 0.03 sim window.
4. **Escalation reuses the cross-check's number guesses** (union into the
   full reading) — the number stage is never paid for twice, which also
   protects the 50s route deadline on slow instances.

Picture path has its own ~20s soft budget (raced); on timeout/failure the
request falls through to the OCR path rather than dying.

## Stage log

- [x] Stage 1 — full data: catalogs EN 23,736 + JA 12,781 (now with
  `setTotal`); full index **25,847 vectors** (int8, 12.62MB bin) built in
  2 shards, merged + validated; `data/manifest.json` written; model
  committed under `models/` (89.1MB); `.gitignore` ships only the final
  artifacts; nightly workflow `.github/workflows/refresh-data.yml`
  (YAML-validated).
- [x] Stage 2 — lib/pictmatch.js + lib/hybrid.js + endpoint wiring +
  client fairness/proxy (code complete; verified in the Stage 3 suites)
- [x] Stage 3 (local) — full matrix 8 photos ×2 + 7 phone-sims against
  the production build: 22/23 correct-or-safe on the first pass; the one
  wrong top (Flapple phone-sim → Garbodor, a coherent 119/116 misread)
  fixed by the picture veto below and re-probed safe. Confirmed locally:
  Victini 1.3–1.6s (picture-neighbor/+number), Tyranitar as-is 1.6s,
  Tyranitar phone-sim correct via escalation + name-fragment rescue,
  Dialga phone-sim correct (true promo first), Dragonite ×3 all
  picture+number EN-twin PROXY. Abomasnow: safe-empty ×2 as-is, correct
  via picture+number on the sim (variance of the OCR channels, as
  before). Escalation walls run 15–49s locally — deadline-adjacent;
  live numbers in the final report.
- [ ] Stage 3 (live) + Stage 4 — after push/deploy.

**Late calibration fixes (from the phone-sim probes, all measured):**
7. **Pool score by match kind** — a bare-number co-signal scores +30
   (book weight), not +100: at +100 a bare winner cleared the gate's
   raw-score line alone and bypassed bare corroboration (Dialga sim's
   HP-150 Kabutops).
8. **Picture veto in escalation** — with topSim ≥ 0.80, an OCR-book
   winner absent from the picture top-60 with nameSim < 0.5, no
   2-token attack confirmation, and dHash < 0.65 is demoted (presumed
   flipped-digit read: Tyranitar 064→004's Budew/Abomasnow; Flapple's
   Garbodor at dHash .57 set the 0.65 bar).
9. **Name-fragment co-signal** (`pictNameArt`) — a ≥5-char OCR name
   token within edit-sim 0.72 of a pool name token + sim ≥ 0.78 makes
   the pool card displayable (rescues the true Tyranitar when its
   number flips and its name garbles).
10. **JP winner selection** — the printed set code (s10b) decides when
    read; else JA-strict and EN-twin matches are BOTH offered, twin
    first when art is within 0.02 (s10a/s10b share total 71, so the
    number alone cannot split Radiant Steelix from Dragonite).
11. **Escalation ordering** — with strong art, pool members order by
    pictSim ahead of book-only candidates (three wrong Dialga prints
    outscored the true promo on name evidence alone).

**Full-index picture ranks (2026-10-07, eval-photos on index-full):**
Victini #1 .8422 · Dialga #1 .8141 · Flapple #5 .8212 (top-1 wrong JA
.8290) · Galvantula #5 .8252 · Tyranitar #8 .8191 (top-1 wrong .8302) ·
Abomasnow #57 .8145 (top-1 wrong .8469!) · Meowth #4666 .6788 (genuine
miss) · Dragonite EN twin #55 .8133. Consequences, both implemented:
cross-check window widened to the top-60 (art nominates, number
decides), and the twin rule — for a Japanese-reading photo an EN pool
member matches on localId alone (JP/EN totals differ: 071 vs 78).
