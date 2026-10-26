# Capture learning loop: small-model track (design)

Status: Phase A built (synthetic degradation harness, 2026-10-25).
Phase B explicitly NOT built — it needs Tye's separate opt-in design
decision first (see the boundary at the bottom).

## The question

"Can we train a small model as more cards get scanned?" The honest
answer is two-part:

1. Most of the benefit is available WITHOUT any user data: the
   degradation harness (lib/degrade.js) synthesizes phone-like damage
   (tilt, blur, compression, glare, dim light, busy backgrounds) from
   any clean capture, so the pipeline can be measured and improved
   against the damage classes that actually cause retakes.
2. A fine-tune on real scans could still help on top — but only the
   residual cases the synthetic set cannot cover (real sleeve glare
   patterns, real hand-held framing, real background clutter). That
   track is gated on privacy design, not on modeling difficulty.

## Phase A — built now (zero user data)

- `lib/degrade.js`: deterministic transforms (tilt via true
  perspective in lib/warp.js, blur, JPEG recompression, screen-blend
  glare, dim light, background swap via the locate crop).
- `scripts/degrade-photo.mjs`: writes variants to /tmp (never the
  repo) and optionally POSTs each to /api/identify for a per-variant
  verdict report.
- `scripts/verify-capture.mjs`: first-shot success per card per lane
  (raw / old phone-sim / new crop-sim). THIS is the metric a future
  fine-tune must move: first-shot success on the crop-sim lane, with
  zero wrong tops, on the hard set (SVP 074, Evolutions 11/108,
  Meowth, Mega Abomasnow) plus the 8-card regression set.
- `scripts/test-capture.mjs`: committed fixtures for the quality
  metrics, the warp round-trip, and the degradation transforms.

## Phase A — design for a future fine-tune (not built)

If Tye later approves the privacy design, the fine-tune track would
be:

### What to train

Two candidate small models, in order of value:

1. **Card-crop + corner model** (highest value): a lightweight
   detector that returns the card quadrilateral from a phone photo,
   replacing the chroma-profile box + Sobel edge fit (lib/locate.js,
   lib/warp.js). Failure mode today is exactly here: sleeved/glare
   cards defeat chroma, and the warp gates then refuse to fire.
   Architecture sketch: a small object-detection backbone
   (MobileNet/EdgeNet class) fine-tuned to 4 corner points, exported
   to ONNX and run server-side next to the CLIP model (same
   onnxruntime-node already in the bundle).
2. **Picture-lane adapter** (second): a low-rank adapter on the CLIP
   vision tower, trained on degraded-vs-clean pairs, so art matching
   tolerates blur/glare better. Higher effort (the index would need
   re-embedding), lower marginal value while the crop + OCR path
   carries the card.

Explicitly NOT proposed: training an OCR replacement. Tesseract +
band geometry + the card book is the corroborating evidence channel;
replacing it with a learned reader would remove the independent
signal the two-signal rule depends on.

### Training-data format (if ever collected)

One record per confirmed scan (see boundary — collection itself is
Phase B):

```json
{
  "photoHash": "sha256 of the (already cropped) card image",
  "degradationTags": ["tilt", "glare"],
  "confirmedCard": { "lang": "en", "id": "svp-74" },
  "evidence": { "numberMatch": true, "nameSim": 0.67, "pictSim": 0.88 },
  "confirmedBy": "kid-tap-choice | grown-ups-manual | second-photo-merge"
}
```

Notes: labels come from CONFIRMED outcomes only (a tapped choice,
a grown-ups manual match) — never from a raw first guess, or the
model learns the pipeline's own mistakes. Raw photos are never the
training rows; crops + labels are. The degradation tags let the
trainer oversample the failing classes instead of the common ones.

### Where it plugs in

- Corner model: `lib/warp.js` — `detectCardCorners()` gains a
  model-backed implementation behind the same return contract
  (corners or null, same sanity gates). The axis/Sobel detector stays
  as the fallback, so a model failure degrades to today's behavior.
- Picture adapter: `lib/pictmatch.js` — the vision model load gains
  an adapter path; `scripts/embed-index.mjs` gains a re-embed step
  (the committed index must be rebuilt from the same adapter, or
  query and index embeddings drift apart — the classic footgun).
- Evaluation protocol (non-negotiable): the fine-tune must beat the
  CURRENT tree on `scripts/verify-capture.mjs` (first-shot success,
  zero wrong tops) AND on the full fixture suites before it ships.
  A model that trades a wrong top for a faster first shot fails.

### What "more scans" would actually need to reach

Useful fine-tuning starts around 500–2,000 confirmed, labeled,
degradation-tagged crops spanning the failing classes — not raw scan
volume. A hundred clean Victini-style photos teach nothing; twenty
sleeved-glare Charizards teach a lot. The harness exists precisely so
this threshold can be approached synthetically first.

## Phase B — boundary (read before building anything here)

The app's current privacy promise is load-bearing:

- Card photos are processed in server memory, never stored, never
  sent to third parties (see the Play Data safety story and the
  COPPA-safe architecture: all kid data stays on-device).
- Collecting real scans for training would break that promise.

Phase B therefore needs Tye's SEPARATE, explicit opt-in design
decision before any code is written, covering at minimum:

- A grown-ups-only toggle, default OFF, in plain language.
- What is stored (crops only, never full photos; no faces, no
  backgrounds, no metadata) and for how long.
- On-device labeling (the confirmation already happens on-device)
  so raw photos never leave the phone for labeling.
- A deletion path and a Data safety / privacy-policy update before
  any collection ships.

Until that decision exists, the learning loop is: synthetic
degradations in, first-shot metrics out, pipeline fixes shipped —
no user photos involved.
