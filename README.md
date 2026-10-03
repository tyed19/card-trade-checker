# Card Trade Checker

A photo-only Pokémon card trade checker built for little kids (and their cousins).

**Flow:** take a picture of MY card → the server reads the card name + collector
number off the photo and finds the exact print → tap ✅ YES on the matching
picture → same for THEIR card → tap **CHECK THE TRADE** → a huge spoken
FAIR / ALMOST FAIR / NOT FAIR verdict. No typing, no reading, no accounts.

## How it works

- `app/page.js` — the kid client (big buttons, speechSynthesis read-aloud,
  multi-card sides, pretend-cards demo with fixed example prices).
- `app/api/identify/route.js` — `POST` a photo (multipart `photo`) and get back
  ranked candidate cards. `GET ?name=&number=` is the grown-ups manual fallback.
- `lib/ocr.js` — server-side OCR: sharp crops the name band (top) and the
  collector-number band (bottom-left), tries several preprocessing variants,
  and reads them with tesseract.js (language data vendored via
  `@tesseract.js-data/eng`).
- `lib/cardbook.js` — card data: TCGdex (`api.tcgdex.net`) first, Pokémon TCG
  API (`api.pokemontcg.io`) as fallback. Both free services are flaky, so all
  calls retry with backoff and results are cached in memory for 10 minutes.
  Prices are TCGplayer market prices.
- `lib/identify.js` — matches the OCR guess to real prints: expanded name
  queries, exact collector-number match preferred, fuzzy name scoring.

Kids never see dollar amounts; a collapsed "Grown-ups" section at the bottom
shows names, numbers, prices, and a manual search.

## Run it

```bash
npm install
npm run build
npm start        # http://localhost:3000
```

## Notes / limitations

- OCR reads best with the card flat, filling most of the frame, in bright,
  non-glare light. Holographic glare is the main enemy.
- Free card-book APIs occasionally fail; the server retries, and the client
  offers a spoken "try again" plus the grown-ups manual search as last resort.
