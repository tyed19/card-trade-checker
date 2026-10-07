// Public Gift Radar page: /gift/<encoded>
// The link encodes a kid's first name + wanted card refs (lib/links.js).
// This page renders entirely from the committed server catalog — no
// app state, no login, works on any device. Read-only and simple on
// purpose: it is the page grandparents get texted.

import { decodePayload } from '../../../lib/links';
import { resolvePairs } from '../../../lib/catalog';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return { title: 'Gift ideas 🎁 — Card Trade Checker' };
}

export default async function GiftPage({ params }) {
  const { code } = await params;
  const payload = decodePayload(code);
  if (!payload || !payload.entries.length) {
    return (
      <main>
        <h1>🎁 Gift list</h1>
        <div className="giftNote">This gift link doesn&rsquo;t look right — ask for a fresh one!</div>
      </main>
    );
  }
  const resolved = await resolvePairs(payload.entries.map((e) => ({ ref: e.ref, id: null })));
  const cards = resolved.filter((c) => !c.missing);
  const total = cards.reduce((t, c) => t + (typeof c.price === 'number' ? c.price : 0), 0);
  const kid = payload.kid || 'your favorite trainer';
  return (
    <main>
      <h1>🎁 Cards {kid} would love!</h1>
      <p className="giftSub">
        These are the cards {kid} is missing from their closest-to-finished sets.
        Prices are ballpark market prices (they wiggle a little day to day).
      </p>
      <div className="giftGrid">
        {cards.map((c) => (
          <div key={c.ref} className="giftCard">
            {c.image
              ? <img src={c.image} alt={c.name} loading="lazy" />
              : <div className="noArt">{c.name}</div>}
            <div className="giftName">{c.name}</div>
            <div className="giftMeta">{c.set} · #{c.number}</div>
            <div className="giftPrice">{typeof c.price === 'number' ? `about $${c.price.toFixed(2)}` : 'price varies'}</div>
          </div>
        ))}
      </div>
      <div className="giftTotal">Everything on this list: about ${total.toFixed(2)}</div>
      <p className="giftFoot">
        Made with the family Card Trade Checker. Tip: check the card number on the
        bottom of the card matches before buying — same Pokémon, different set, different card!
      </p>
    </main>
  );
}
