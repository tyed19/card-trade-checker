import { NextResponse } from 'next/server';
import { setCards } from '../../../lib/catalog';

export const runtime = 'nodejs';

// Full set listing for the Phase 3 set pages + Gift Radar:
//   GET /api/set?lang=en&setId=swsh5
// Returns every card of the set (printed-number order) as card objects
// with refs, so the client can render owned cards + ghost slots.
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const lang = searchParams.get('lang') === 'ja' ? 'ja' : 'en';
    const setId = searchParams.get('setId') || '';
    if (!setId) return NextResponse.json({ ok: false, error: 'setId required' }, { status: 400 });
    const out = await setCards(lang, setId);
    if (!out) return NextResponse.json({ ok: false, error: 'set not found' }, { status: 404 });
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'set-failed', debugError: String(err && err.message || err) },
      { status: 500 }
    );
  }
}
