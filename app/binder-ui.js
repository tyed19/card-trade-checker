'use client';

// Phase 3 kid-facing UI: binders, set pages, scan-a-binder, trade
// ideas, badges, and the grown-ups parent layer. All state comes from
// lib/store.js (on-device); all card facts resolve through /api/cards
// and /api/set against the server catalog (lib/catalog.js). Prices are
// shown ONLY in the ParentLayer (grown-ups) — kid screens are pictures,
// counts, and progress, per the standing design rules.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as store from '../lib/store';
import {
  binderList, duplicates, setProgress, binderValue, perfectSwaps, giftIdeas,
  spareHolders, giftRadar, fairTraderBadge, kidFairTrades, setBadges, ownedRefSet,
} from '../lib/logic';
import { giftPath, binderImportPath } from '../lib/links';

// ---------- store + resolution hooks ----------

export function useStoreState() {
  return useSyncExternalStore(store.subscribe, store.getState, store.getServerState);
}

const resolveCache = new Map(); // ref -> card object (session cache)

async function postCards(body) {
  const res = await fetch('/api/cards', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'cards failed');
  for (const c of Object.values(json.cards || {})) resolveCache.set(c.ref, c);
  return json;
}

// Resolve one kid's binder map into a BinderList, healing refs whose
// catalog row shifted (resolver verifies by stored id).
export function useKidBinder(kidId) {
  const state = useStoreState();
  const map = (kidId && state.binders[kidId]) || {};
  const sig = JSON.stringify(map);
  const [data, setData] = useState({ list: [], cardMap: {}, loading: false });
  useEffect(() => {
    const entries = Object.entries(map).map(([ref, e]) => ({ ref, id: e.id }));
    if (!kidId || !entries.length) { setData({ list: [], cardMap: {}, loading: false }); return; }
    let dead = false;
    setData((d) => ({ ...d, loading: true }));
    postCards({ pairs: entries })
      .then((json) => {
        if (dead) return;
        const cardMap = {};
        for (const c of json.list || []) {
          cardMap[c.ref] = c;
          if (c.repaired && c.requestedRef && c.requestedRef !== c.ref) {
            store.healBinderRef(kidId, c.requestedRef, c.ref, c.id);
          }
        }
        setData({ list: binderList(map, cardMap), cardMap, loading: false });
      })
      .catch(() => { if (!dead) setData({ list: [], cardMap: {}, loading: false }); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kidId, sig]);
  return data;
}

// Resolve ALL kids' binders at once (set-page cross-checks, ideas).
export function useAllBinders() {
  const state = useStoreState();
  const sig = JSON.stringify(state.binders);
  const [data, setData] = useState({ lists: {}, loading: false });
  useEffect(() => {
    const pairs = [];
    for (const [kidId, map] of Object.entries(state.binders || {})) {
      for (const [ref, e] of Object.entries(map || {})) pairs.push({ ref, id: e.id, kidId });
    }
    if (!pairs.length) { setData({ lists: {}, loading: false }); return; }
    let dead = false;
    setData((d) => ({ ...d, loading: true }));
    postCards({ pairs: pairs.map(({ ref, id }) => ({ ref, id })) })
      .then((json) => {
        if (dead) return;
        const cardMap = {};
        for (const c of json.list || []) cardMap[c.ref] = c;
        const lists = {};
        for (const kidId of Object.keys(state.binders || {})) {
          lists[kidId] = binderList(state.binders[kidId] || {}, cardMap);
        }
        setData({ lists, loading: false });
      })
      .catch(() => { if (!dead) setData({ lists: {}, loading: false }); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return data;
}

// Add an identify/manual candidate to a kid's binder: resolve its
// catalog id to a ref first. Returns the resolved card, or null when
// the card is not in our catalog (demo ids, odd fallback prints).
export async function addCandidateToBinder(kidId, cand) {
  if (!kidId || !cand || !cand.id) return null;
  if (cand.ref) { // already a catalog card object (binder/trade picker)
    store.addToBinder(kidId, cand.ref, cand.id, 1);
    return cand;
  }
  const lang = cand.lang && String(cand.lang).startsWith('ja') ? 'ja' : 'en';
  try {
    const json = await postCards({ ids: [{ lang, id: cand.id }] });
    const card = (json.list || [])[0];
    if (!card) return null;
    store.addToBinder(kidId, card.ref, card.id, 1);
    return card;
  } catch { return null; }
}

export async function resolveCandidateRef(cand) {
  if (!cand) return null;
  if (cand.ref) return cand;
  const lang = cand.lang && String(cand.lang).startsWith('ja') ? 'ja' : 'en';
  try {
    const json = await postCards({ ids: [{ lang, id: cand.id }] });
    return (json.list || [])[0] || null;
  } catch { return null; }
}

// ---------- shared bits ----------

export function KidSwitcher({ kids, value, onChange, big = false }) {
  if (!kids.length) return null;
  return (
    <div className={`kidSwitch${big ? ' big' : ''}`}>
      {kids.map((k) => (
        <button
          key={k.id}
          className={`kidAvatar${value === k.id ? ' sel' : ''}`}
          style={{ borderColor: k.color }}
          onClick={() => onChange(k.id)}
          title={k.name}
        >
          <span className="kidEmoji">{k.emoji}</span>
          <span className="kidName">{k.name}</span>
        </button>
      ))}
    </div>
  );
}

export function KidBar({ state, view, go }) {
  const active = state.kids.find((k) => k.id === state.activeKidId) || state.kids[0];
  if (!state.kids.length) return null;
  return (
    <div className="kidBar">
      <KidSwitcher
        kids={state.kids}
        value={active ? active.id : null}
        onChange={(id) => { store.setActiveKid(id); if (view === 'set') go('binder'); }}
      />
      <div className="kidNav">
        <button className={view === 'trade' ? 'on' : ''} onClick={() => go('trade')}>⚖️ Trade</button>
        <button className={view === 'binder' || view === 'set' ? 'on' : ''} onClick={() => go('binder')}>📚 Binder</button>
        <button className={view === 'scan' ? 'on' : ''} onClick={() => go('scan')}>➕ Add cards</button>
        <button className={view === 'ideas' ? 'on' : ''} onClick={() => go('ideas')} disabled={state.kids.length < 2}>💡 Ideas</button>
        <button className={view === 'profile' ? 'on' : ''} onClick={() => go('profile')}>⭐ Me</button>
      </div>
    </div>
  );
}

export function CardTile({ entry, onTap, badge }) {
  const c = entry.card || entry;
  return (
    <button className="cardTile" onClick={onTap}>
      {c.thumb || c.image
        ? <img src={c.thumb || c.image} alt={c.name} loading="lazy" />
        : <div className="noArt">{c.name}</div>}
      {entry.qty > 1 && <span className="qtyBadge">×{entry.qty}</span>}
      {badge}
    </button>
  );
}

// ---------- Binder home ----------

export function BinderHome({ kid, go }) {
  const { list, loading } = useKidBinder(kid ? kid.id : null);
  const [doublesOnly, setDoublesOnly] = useState(false);
  const [selRef, setSelRef] = useState(null);
  const progress = useMemo(() => setProgress(list), [list]);
  if (!kid) return <div className="screenNote">Add a kid in the grown-ups section below first! 👇</div>;
  const shown = doublesOnly ? duplicates(list) : list;
  const bySet = new Map();
  for (const e of shown) {
    const k = `${e.card.lang}:${e.card.setId}`;
    if (!bySet.has(k)) bySet.set(k, { name: e.card.set, items: [] });
    bySet.get(k).items.push(e);
  }
  const sel = selRef ? list.find((e) => e.ref === selRef) : null;
  return (
    <div className="screen">
      <h2 className="screenTitle">{kid.emoji} {kid.name}&rsquo;s Binder</h2>
      <div className="chipRow">
        <span className="chip">🃏 {list.reduce((a, e) => a + e.qty, 0)} cards</span>
        <button className={`chip btn${doublesOnly ? ' on' : ''}`} onClick={() => setDoublesOnly(!doublesOnly)}>
          🔁 Doubles (trade pile){doublesOnly ? ' ✓' : ''}
        </button>
        <button className="chip btn" onClick={() => go('scan')}>➕ Add cards</button>
      </div>
      {progress.length > 0 && (
        <div className="setChips">
          {progress.map((s) => (
            <button key={s.key} className="setChip" onClick={() => go('set', s.key)}>
              <span>{s.setName}</span>
              <span className="setNums">{s.owned}/{s.total}</span>
              <span className="bar"><span style={{ width: Math.round(s.pct * 100) + '%' }} /></span>
            </button>
          ))}
        </div>
      )}
      {loading && <div className="screenNote">Opening binder…</div>}
      {!loading && !list.length && (
        <div className="screenNote">No cards yet! Tap ➕ Add cards and scan the binder in. 📸</div>
      )}
      {[...bySet.entries()].map(([key, group]) => (
        <div key={key} className="binderGroup">
          <h3>{group.name}</h3>
          <div className="cardGrid">
            {group.items.map((e) => (
              <CardTile key={e.ref} entry={e} onTap={() => setSelRef(selRef === e.ref ? null : e.ref)} />
            ))}
          </div>
        </div>
      ))}
      {sel && (
        <div className="qtySheet">
          <div className="qtyName">{sel.card.name} — #{sel.card.number}</div>
          <div className="qtyRow">
            <button onClick={() => store.setBinderQty(kid.id, sel.ref, sel.qty - 1)}>➖</button>
            <span>×{sel.qty}</span>
            <button onClick={() => store.setBinderQty(kid.id, sel.ref, sel.qty + 1)}>➕</button>
            <button className="removeBtn" onClick={() => { store.removeFromBinder(kid.id, sel.ref); setSelRef(null); }}>🗑 Remove</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Set page ----------

const MILESTONES = [0.25, 0.5, 0.75, 1];
const celebratedSets = new Set();

export function SetPage({ kid, setKey, go }) {
  const [langRaw, setId] = String(setKey || 'en:').split(':');
  const lang = langRaw === 'ja' ? 'ja' : 'en';
  const { list } = useKidBinder(kid ? kid.id : null);
  const { lists } = useAllBinders();
  const [setData, setSetData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let dead = false;
    setSetData(null); setErr('');
    fetch(`/api/set?lang=${encodeURIComponent(lang)}&setId=${encodeURIComponent(setId)}`)
      .then((r) => r.json())
      .then((j) => { if (!dead) { if (j.ok) setSetData(j); else setErr('That set is not in our card book.'); } })
      .catch(() => { if (!dead) setErr('Could not load that set.'); });
    return () => { dead = true; };
  }, [lang, setId]);
  const owned = useMemo(() => ownedRefSet(list), [list]);
  const missingRefs = useMemo(
    () => (setData ? setData.cards.filter((c) => !owned.has(c.ref)).map((c) => c.ref) : []),
    [setData, owned]
  );
  const holders = useMemo(() => {
    if (!kid || !setData) return new Map();
    const others = {};
    for (const [kidId, l] of Object.entries(lists || {})) if (kidId !== kid.id) others[kidId] = l;
    return spareHolders(missingRefs, others);
  }, [lists, missingRefs, kid, setData]);
  const state = useStoreState();
  const ownedCount = setData ? setData.cards.filter((c) => owned.has(c.ref)).length : 0;
  const totalShown = setData ? (setData.set.total || setData.cards.length) : 0;
  const pct = totalShown ? ownedCount / totalShown : 0;
  useEffect(() => {
    if (!setData || !pct) return;
    const ck = `${kid ? kid.id : ''}:${setKey}`;
    for (const m of MILESTONES) {
      if (pct >= m && !celebratedSets.has(ck + ':' + m)) {
        celebratedSets.add(ck + ':' + m);
        import('canvas-confetti').then((mod) => {
          mod.default({ particleCount: m === 1 ? 260 : 140, spread: 85, origin: { y: 0.6 } });
        }).catch(() => {});
      }
    }
  }, [pct, setData, kid, setKey]);
  if (!kid) return <div className="screenNote">Pick a kid first! 👆</div>;
  if (err) return <div className="screen"><button className="backBtn" onClick={() => go('binder')}>⬅ Binder</button><div className="screenNote">{err}</div></div>;
  if (!setData) return <div className="screenNote">Loading the set…</div>;
  return (
    <div className="screen">
      <button className="backBtn" onClick={() => go('binder')}>⬅ Binder</button>
      <h2 className="screenTitle">{setData.set.name}</h2>
      <div className="progressHead">
        <span>{ownedCount} / {totalShown}</span>
        <span className="bar big"><span style={{ width: Math.round((ownedCount / totalShown) * 100) + '%' }} /></span>
        <span>{Math.round((ownedCount / totalShown) * 100)}%</span>
      </div>
      <div className="cardGrid setGrid">
        {setData.cards.map((c) => {
          const has = owned.has(c.ref);
          const holderKids = holders.get(c.ref) || [];
          const holder = holderKids.length ? state.kids.find((k) => k.id === holderKids[0]) : null;
          return (
            <div key={c.ref} className={`setSlot${has ? '' : ' ghost'}`}>
              {c.thumb || c.image
                ? <img src={c.thumb || c.image} alt={c.name} loading="lazy" />
                : <div className="noArt">{c.name}</div>}
              <span className="slotNum">#{c.number}</span>
              {has && <span className="slotQty">×{(list.find((e) => e.ref === c.ref) || {}).qty}</span>}
              {holder && <span className="spareTag">{holder.emoji} has a spare!</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Scan-a-binder session ----------
// Same server identify pipeline + candidate UI as the trade flow;
// every confirmed card goes straight into the active kid's binder.

export function ScanSession({ kid, go, shrinkForUpload, playClip }) {
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState(null);
  const [last, setLast] = useState(null);
  const fileRef = useRef(null);
  if (!kid) return <div className="screenNote">Add a kid in the grown-ups section below first! 👇</div>;

  async function onPhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setChoices(null); setStatus('');
    playClip('looking', '');
    try {
      const small = await shrinkForUpload(file);
      const form = new FormData();
      form.append('photo', small, 'card.jpg');
      const res = await fetch('/api/identify', { method: 'POST', body: form });
      const json = await res.json();
      if (!json.ok) {
        if (json.stumped) { setStatus('🤔 That one stumped me! Skip it for now.'); playClip('stumped', ''); }
        else if (json.error === 'unreadable' || json.error === 'no-card') { setStatus('😕 I couldn\'t read that one — try again!'); playClip('unreadable', ''); }
        else { setStatus('😕 Something went wrong — try again!'); playClip('wrong', ''); }
        return;
      }
      const shown = (json.candidates || []).filter((c) => c.displayable);
      if (!shown.length) {
        if (json.stumped) { setStatus('🤔 That one stumped me! Skip it for now.'); playClip('stumped', ''); }
        else { setStatus('😕 I couldn\'t read that one — try again!'); playClip('unreadable', ''); }
        return;
      }
      setChoices(shown.slice(0, 3));
      playClip('tap', '');
    } catch {
      setStatus('😕 Something went wrong — try again!');
      playClip('wrong', '');
    } finally { setBusy(false); }
  }

  async function pick(cand) {
    setChoices(null);
    const card = await addCandidateToBinder(kid.id, cand);
    if (card) {
      setCount((c) => c + 1);
      setLast(card);
      setStatus('');
      playClip('gotIt', '');
    } else {
      setStatus('😕 That card isn\'t in our card book yet — skip it for now.');
    }
  }

  return (
    <div className="screen">
      <h2 className="screenTitle">➕ Add cards to {kid.emoji} {kid.name}&rsquo;s binder</h2>
      <div className="scanCount">{count} card{count === 1 ? '' : 's'} added!</div>
      {last && (
        <div className="lastAdded">
          {last.thumb || last.image ? <img src={last.thumb || last.image} alt={last.name} /> : null}
          <span>⭐ {last.name}</span>
        </div>
      )}
      <div className="status" role="status">{status}</div>
      {choices ? (
        <div className="choices">
          <div className="q">Tap your card! 👇</div>
          <div className={`choiceGrid${choices.length === 1 ? ' one' : ''}`}>
            {choices.map((c, i) => (
              <button key={i} className="choiceBtn" onClick={() => pick(c)}>
                <img src={c.image} alt={c.name} />
              </button>
            ))}
          </div>
          <button className="noneBtn" onClick={() => { setChoices(null); setStatus('No problem — try the photo again!'); playClip('takeAgain', ''); }}>
            🚫 NONE OF THESE — TAKE IT AGAIN
          </button>
        </div>
      ) : (
        <>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
          <button className="photoBtn big" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}>
            {busy ? '👀 Looking…' : '📸 TAKE A PICTURE'}
          </button>
        </>
      )}
      <button className="againBtn" onClick={() => go('binder')}>✅ DONE</button>
    </div>
  );
}

// ---------- From-binder trade picker ----------

export function BinderPicker({ kid, onPick, onClose, usedCounts = {} }) {
  const { list, loading } = useKidBinder(kid ? kid.id : null);
  if (!kid) return null;
  return (
    <div className="pickerOverlay">
      <div className="pickerSheet">
        <h3>{kid.emoji} {kid.name}&rsquo;s binder — tap to add!</h3>
        {loading && <div className="screenNote">Opening binder…</div>}
        {!loading && !list.length && <div className="screenNote">No cards in this binder yet!</div>}
        <div className="cardGrid">
          {list.map((e) => {
            const used = usedCounts[e.ref] || 0;
            const left = e.qty - used;
            return (
              <div key={e.ref} className={left <= 0 ? 'pickedOut' : ''}>
                <CardTile
                  entry={{ ...e, qty: left }}
                  onTap={() => { if (left > 0) onPick(e.card); }}
                />
              </div>
            );
          })}
        </div>
        <button className="againBtn" onClick={onClose}>✅ DONE</button>
      </div>
    </div>
  );
}

// ---------- Trade ideas ----------

export function IdeasScreen({ go, onStartTrade }) {
  const state = useStoreState();
  const { lists, loading } = useAllBinders();
  const kids = state.kids;
  const [aId, setAId] = useState(null);
  const [bId, setBId] = useState(null);
  const A = kids.find((k) => k.id === (aId || state.activeKidId)) || kids[0];
  const B = kids.find((k) => k.id === bId && k.id !== (A && A.id)) || kids.find((k) => k.id !== (A && A.id));
  const listA = (A && lists[A.id]) || [];
  const listB = (B && lists[B.id]) || [];
  const swaps = useMemo(() => (A && B ? perfectSwaps(listA, listB) : []), [listA, listB, A, B]);
  const giftsAB = useMemo(() => (A && B ? giftIdeas(listA, listB) : []), [listA, listB, A, B]);
  const giftsBA = useMemo(() => (A && B ? giftIdeas(listB, listA) : []), [listA, listB, A, B]);
  if (kids.length < 2) return <div className="screenNote">Trade ideas need two kids — add another in the grown-ups section! 👇</div>;
  if (!A || !B) return <div className="screenNote">Pick two kids! 👆</div>;
  const pairCard = (give, get, kidGive, kidGet, onStart) => (
    <div className="ideaCard">
      <div className="ideaSide">
        <span className="ideaKid">{kidGive.emoji} {kidGive.name} gives</span>
        {give.card.thumb || give.card.image ? <img src={give.card.thumb || give.card.image} alt={give.card.name} /> : <div className="noArt">{give.card.name}</div>}
      </div>
      <div className="ideaArrow">🔀</div>
      <div className="ideaSide">
        <span className="ideaKid">{kidGet.emoji} {kidGet.name} gives</span>
        {get ? (get.card.thumb || get.card.image ? <img src={get.card.thumb || get.card.image} alt={get.card.name} /> : <div className="noArt">{get.card.name}</div>) : <div className="noArt">🎁 a surprise!</div>}
      </div>
      <button className="goBtnSmall" onClick={onStart}>▶️ Start this trade</button>
      <details className="ideaDetail">
        <summary>Grown-ups: values</summary>
        {give.card.name} {typeof give.card.price === 'number' ? `$${give.card.price.toFixed(2)}` : 'no price'}
        {get ? <> ↔ {get.card.name} {typeof get.card.price === 'number' ? `$${get.card.price.toFixed(2)}` : 'no price'}</> : null}
      </details>
    </div>
  );
  return (
    <div className="screen">
      <h2 className="screenTitle">💡 Trade ideas</h2>
      <div className="ideaPickers">
        <KidSwitcher kids={kids} value={A.id} onChange={(id) => { setAId(id); if (id === B.id) setBId(A.id); }} />
        <span className="ideaVs">🔀</span>
        <KidSwitcher kids={kids.filter((k) => k.id !== A.id)} value={B.id} onChange={setBId} />
      </div>
      {loading && <div className="screenNote">Thinking… 🤔</div>}
      <h3 className="ideaHead">⭐ Perfect swaps</h3>
      {!swaps.length && <div className="screenNote">No perfect swaps yet — scan more cards into both binders!</div>}
      {swaps.map((s, i) => (
        <div key={i}>{pairCard(s.giveA, s.giveB, A, B, () => onStartTrade({
          aKid: A.id, bKid: B.id, aCards: [s.giveA.card], bCards: [s.giveB.card],
        }))}</div>
      ))}
      <h3 className="ideaHead">🎁 Almost-finishing gifts</h3>
      {!giftsAB.length && !giftsBA.length && <div className="screenNote">No finishing gifts right now.</div>}
      {giftsAB.map((g, i) => (
        <div key={'ab' + i}>{pairCard(g.give, g.returnCard, A, B, () => onStartTrade({
          aKid: A.id, bKid: B.id, aCards: [g.give.card], bCards: g.returnCard ? [g.returnCard.card] : [],
        }))}</div>
      ))}
      {giftsBA.map((g, i) => (
        <div key={'ba' + i}>{pairCard(g.give, g.returnCard, B, A, () => onStartTrade({
          aKid: B.id, bKid: A.id, aCards: [g.give.card], bCards: g.returnCard ? [g.returnCard.card] : [],
        }))}</div>
      ))}
    </div>
  );
}

// ---------- Kid profile + badges ----------

export function ProfileScreen({ kid, go }) {
  const state = useStoreState();
  const { list } = useKidBinder(kid ? kid.id : null);
  if (!kid) return <div className="screenNote">Add a kid in the grown-ups section below first! 👇</div>;
  const trades = kidFairTrades(state.trades, kid.id);
  const badge = fairTraderBadge(trades.length);
  const progress = setProgress(list);
  const sb = setBadges(progress);
  return (
    <div className="screen">
      <div className="profileHead" style={{ borderColor: kid.color }}>
        <span className="profileEmoji">{kid.emoji}</span>
        <span className="profileName">{kid.name}</span>
      </div>
      <div className="badgeCard">
        <div className="badgeTitle">Fair Trader</div>
        <div className="badgeStars">{badge.tier ? badge.tier.stars : '☆'}</div>
        <div className="badgeBig">{trades.length}</div>
        <div className="badgeName">{badge.tier ? badge.tier.name : 'Make a fair trade to earn your first ⭐!'}</div>
        {badge.next && badge.tier && <div className="badgeNext">{badge.next.min - trades.length} more to “{badge.next.name}”</div>}
      </div>
      <h3 className="ideaHead">🧭 Set Explorer</h3>
      {!sb.length && <div className="screenNote">Finish half of a set to earn a badge!</div>}
      <div className="setBadgeGrid">
        {sb.map((b) => (
          <div key={b.setKey} className="setBadge">
            <span className="setBadgeIcon">{b.label}</span>
            <span className="setBadgeName">{b.setName}</span>
            <span className="setBadgePct">{Math.round(b.pct * 100)}%</span>
          </div>
        ))}
      </div>
      <button className="againBtn" onClick={() => go('binder')}>📚 Open my binder</button>
    </div>
  );
}

// ---------- Parent layer (rendered inside the grown-ups box) ----------

function CopyLink({ value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="row">
      <input readOnly value={value} onFocus={(e) => e.target.select()} style={{ flex: '1 1 240px' }} />
      <button className="go" onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }
        catch { /* input is selectable as fallback */ }
      }}>{copied ? 'Copied ✓' : 'Copy'}</button>
    </div>
  );
}

export function ParentLayer() {
  const state = useStoreState();
  const [selKidId, setSelKidId] = useState(null);
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState(store.KID_EMOJIS[0]);
  const selKid = state.kids.find((k) => k.id === (selKidId || state.activeKidId)) || state.kids[0] || null;
  const { list } = useKidBinder(selKid ? selKid.id : null);
  const value = useMemo(() => binderValue(list), [list]);
  const progress = useMemo(() => setProgress(list), [list]);
  const topSets = progress.slice(0, 3);
  const [budget, setBudget] = useState('any');
  const [setListings, setSetListings] = useState({});
  const topKey = topSets.map((s) => s.key).join('|');
  useEffect(() => {
    let dead = false;
    (async () => {
      const out = {};
      for (const s of topSets) {
        try {
          const r = await fetch(`/api/set?lang=${s.lang}&setId=${encodeURIComponent(s.setId)}`);
          const j = await r.json();
          if (j.ok) out[s.key] = j.cards;
        } catch { /* skip set */ }
      }
      if (!dead) setSetListings(out);
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topKey]);
  const radar = useMemo(() => {
    if (!selKid) return [];
    const cap = budget === 'any' ? Infinity : parseFloat(budget);
    const owned = ownedRefSet(list);
    let all = [];
    for (const s of topSets) {
      const cards = setListings[s.key];
      if (cards) all = all.concat(giftRadar({ setCardsList: cards, ownedRefs: owned, budget: cap, limit: 200 }));
    }
    all.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setListings, budget, list, topKey]);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const shareGift = radar.length
    ? origin + giftPath({ kid: selKid.name.split(' ')[0], entries: radar.slice(0, 60).map((c) => ({ ref: c.ref, qty: 1 })) })
    : '';
  const shareBinder = selKid && list.length
    ? origin + binderImportPath({ kid: selKid.name, entries: list.map((e) => ({ ref: e.ref, qty: e.qty })) })
    : '';
  return (
    <div className="parentLayer">
      <h4>👨‍👩‍👧 Kids &amp; binders</h4>
      {state.kids.map((k) => (
        <div key={k.id} className="row">
          <button className="go" title="Change picture" onClick={() => {
            const i = store.KID_EMOJIS.indexOf(k.emoji);
            store.renameKid(k.id, undefined, store.KID_EMOJIS[(i + 1) % store.KID_EMOJIS.length]);
          }}>{k.emoji}</button>
          <input defaultValue={k.name} key={k.id + k.name} style={{ flex: '1 1 120px' }}
            onBlur={(e) => store.renameKid(k.id, e.target.value)} />
          <span>{(state.binders[k.id] ? Object.keys(state.binders[k.id]).length : 0)} kinds</span>
          <button className="go" onClick={() => setSelKidId(k.id)}>View</button>
          <button className="go danger" onClick={() => {
            if (window.confirm(`Delete ${k.name} and their binder? This cannot be undone.`)) store.deleteKid(k.id);
          }}>Delete</button>
        </div>
      ))}
      <div className="row">
        <input placeholder="New kid's name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: '1 1 120px' }} />
        <button className="go" onClick={() => {
          const i = store.KID_EMOJIS.indexOf(newEmoji);
          setNewEmoji(store.KID_EMOJIS[(i + 1) % store.KID_EMOJIS.length]);
        }}>{newEmoji}</button>
        <button className="go" disabled={!newName.trim()} onClick={() => {
          const k = store.addKid(newName.trim(), newEmoji);
          setNewName(''); setSelKidId(k.id);
        }}>➕ Add kid</button>
      </div>
      {selKid && (
        <>
          <h4>📚 {selKid.emoji} {selKid.name}&rsquo;s binder value</h4>
          <p>
            {value.count} cards ({value.distinct} kinds) worth about <b>${value.total.toFixed(2)}</b>.
            Doubles (trade pile) worth about <b>${value.duplicatesValue.toFixed(2)}</b>.
            Japanese cards are counted at their converted USD value, same as trades.
          </p>
          <h4>🎁 Gift Radar — {selKid.name.split(' ')[0]}&rsquo;s closest sets</h4>
          {!topSets.length && <p>No cards yet — scan some into the binder and gift ideas appear here.</p>}
          {!!topSets.length && (
            <>
              <p>{topSets.map((s) => `${s.setName} (${s.owned}/${s.total})`).join(' · ')}</p>
              <div className="row">
                {['any', '5', '10', '25'].map((b) => (
                  <button key={b} className="go" style={budget === b ? { outline: '3px solid #f5b301' } : undefined}
                    onClick={() => setBudget(b)}>{b === 'any' ? 'Any price' : `Under $${b}`}</button>
                ))}
              </div>
              {radar.slice(0, 30).map((c) => (
                <div key={c.ref} className="manualResult">
                  {c.thumb ? <img src={c.thumb} alt={c.name} /> : null}
                  <span>{c.name} — {c.set} #{c.number} — {typeof c.price === 'number' ? `$${c.price.toFixed(2)}` : 'no price listed'}</span>
                </div>
              ))}
              {!radar.length && <p>Nothing missing under that budget in the closest sets.</p>}
              <p>Share this list (grandparent-proof page: name, pictures, prices, total):</p>
              <CopyLink value={shareGift} />
            </>
          )}
          <h4>🔗 Move or share this binder</h4>
          <p>Anyone opening this link on another device can import a copy of {selKid.name}&rsquo;s binder (it asks first, and merges by adding quantities).</p>
          <CopyLink value={shareBinder} />
        </>
      )}
    </div>
  );
}
