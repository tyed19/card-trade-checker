import { NextResponse } from 'next/server';
import { resolveRef, resolvePairs, resolveIds } from '../../../lib/catalog';

export const runtime = 'nodejs';

// Batch card resolution for Phase 3 binder UI. The browser never
// downloads the 8MB catalogs; it asks for exactly the cards it needs:
//   { refs:  ["e123", "j45", ...] }          -> cards keyed by ref
//   { pairs: [{ref, id}, ...] }              -> binder entries, with
//                                               id-verified ref repair
//   { ids:   [{lang, id}, ...] }             -> cards found by catalog
//                                               id (identify candidates)
// Response: { ok, cards: {...byRef}, list: [...], missing: [...] }
export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const cards = {};
    const list = [];
    const missing = [];
    const put = (card, key) => {
      if (!card) return;
      if (card.missing) { missing.push(key); return; }
      cards[card.ref] = card;
      list.push(card);
    };
    if (Array.isArray(body.refs)) {
      for (const ref of body.refs.slice(0, 600)) {
        const card = await resolveRef(ref);
        if (card) put(card); else missing.push(ref);
      }
    }
    if (Array.isArray(body.pairs)) {
      const resolved = await resolvePairs(body.pairs.slice(0, 600));
      for (const card of resolved) put(card, card.requestedRef || card.ref);
    }
    if (Array.isArray(body.ids)) {
      const resolved = await resolveIds(body.ids.slice(0, 200));
      for (const card of resolved) {
        if (card.missing) missing.push(card.id);
        else { cards[card.ref] = card; list.push(card); }
      }
    }
    return NextResponse.json({ ok: true, cards, list, missing });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'cards-failed', debugError: String(err && err.message || err) },
      { status: 500 }
    );
  }
}
