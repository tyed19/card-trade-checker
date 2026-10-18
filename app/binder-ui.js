'use client';

// Phase 3 kid-facing UI: binders, set pages, scan-a-binder, trade
// ideas, badges, and the grown-ups parent layer. All state comes from
// lib/store.js (on-device); all card facts resolve through /api/cards
// and /api/set against the server catalog (lib/catalog.js). Prices
// appear in the ParentLayer (grown-ups) and — at the owner's explicit
// request — on the binder screens (per-card price + binder total).
// The trade panels and verdict stay price-free.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as store from '../lib/store';
import {
  binderList, duplicates, setProgress, binderValue, perfectSwaps, giftIdeas,
  spareHolders, giftRadar, fairTraderBadge, kidFairTrades, setBadges, ownedRefSet,
  radarSets, normalizeFairness, fmtCushion, CUSHION_CHOICES, fmtPriceLine,
} from '../lib/logic';

// "1 kind" / "3 kinds" — the count word agrees with the number.
const kindWord = (n) => `${n} kind${n === 1 ? '' : 's'}`;
import { giftPath, binderImportPath } from '../lib/links';
import { takeNativePhoto } from '../lib/native';
import {
  IconScales, IconBinder, IconCards, IconCardPlus, IconCamera, IconBulb,
  IconStar, IconCheck, IconX, IconGift, IconSwap, IconTrash,
  IconPlus, IconMinus, IconBack, IconCompass, IconCrown, IconTag, IconPlay,
  IconLink,
} from './icons';

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

export function KidSwitcher({ kids, value, onChange, big = false, trailing = null }) {
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
      {trailing}
    </div>
  );
}

// Kid navigation: kid switcher on top, then THREE big buttons.
// Trade Ideas and Badges used to be tabs of their own — they now
// live inside the binder (a Trade Ideas button and a badges section
// at the bottom of BinderHome). Nav taps speak their label via the
// onNav callback page.js passes in (falls back to plain navigation).
export function KidBar({ state, view, go, onNav, onAddKid }) {
  const active = state.kids.find((k) => k.id === state.activeKidId) || state.kids[0];
  if (!state.kids.length) return null;
  const nav = onNav || ((v) => go(v));
  const binderOn = view === 'binder' || view === 'set' || view === 'ideas' || view === 'profile';
  return (
    <div className="kidBar">
      <KidSwitcher
        kids={state.kids}
        value={active ? active.id : null}
        onChange={(id) => { store.setActiveKid(id); if (view === 'set') go('binder'); }}
        trailing={onAddKid ? (
          <button className="kidAvatar addKid" onClick={onAddKid} title="Add a kid">
            <span className="kidEmoji addKidPlus"><IconPlus size={26} /></span>
            <span className="kidName">Add a kid</span>
          </button>
        ) : null}
      />
      <div className="kidNav">
        <button className={view === 'trade' ? 'on' : ''} onClick={() => nav('trade', 'Trade!')}>
          <IconScales size={30} /><span>Trade</span>
        </button>
        <button className={binderOn ? 'on' : ''} onClick={() => nav('binder', 'My Binder!')}>
          <IconBinder size={30} /><span>My Binder</span>
        </button>
        <button className={view === 'scan' ? 'on' : ''} onClick={() => nav('scan', 'Add Cards!')}>
          <IconCardPlus size={30} /><span>Add Cards</span>
        </button>
      </div>
    </div>
  );
}

export function CardTile({ entry, onTap, badge, showPrice = false }) {
  const c = entry.card || entry;
  const qty = entry.qty || 1;
  const priceLine = fmtPriceLine(c, qty);
  return (
    <button className="cardTile" onClick={onTap}>
      {c.thumb || c.image
        ? <img src={c.thumb || c.image} alt={c.name} loading="lazy" />
        : <div className="noArt">{c.name}</div>}
      {entry.qty > 1 && <span className="qtyBadge">×{entry.qty}</span>}
      {badge}
      {showPrice && (priceLine
        ? <span className="tilePrice">{priceLine}</span>
        : <span className="tilePrice none">no price</span>)}
    </button>
  );
}

// ---------- Binder home ----------

export function BinderHome({ kid, go, kidCount = 0 }) {
  const state = useStoreState();
  const { list, loading } = useKidBinder(kid ? kid.id : null);
  const [doublesOnly, setDoublesOnly] = useState(false);
  const [selRef, setSelRef] = useState(null);
  const progress = useMemo(() => setProgress(list), [list]);
  // SAME helper the grown-ups ParentLayer uses for binder value —
  // one summation, so the kid binder total and the parent number can
  // never drift apart.
  const value = useMemo(() => binderValue(list), [list]);
  // "All my cards": ONE flat grid, most recently added first. The
  // stored binder map carries addedAt per ref (binderList drops it),
  // so sort the resolved list against the raw map. Set grouping is
  // demoted to the set chips above, which open the set pages.
  const allCards = useMemo(() => {
    if (!kid) return list;
    const raw = state.binders[kid.id] || {};
    return [...list].sort((a, b) => ((raw[b.ref] && raw[b.ref].addedAt) || 0) - ((raw[a.ref] && raw[a.ref].addedAt) || 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, kid, state.binders]);
  if (!kid) return <div className="screenNote">Add a kid in the grown-ups section first!</div>;
  const shown = doublesOnly ? duplicates(list) : allCards;
  const sel = selRef ? list.find((e) => e.ref === selRef) : null;
  return (
    <div className="screen">
      <h2 className="screenTitle">{kid.emoji} {kid.name}&rsquo;s Binder</h2>
      {list.length > 0 && (
        <div className="binderTotal">
          <div className="binderTotalMain"><IconTag /> Binder total: ${value.total.toFixed(2)}</div>
          {duplicates(list).length > 0 && (
            <div className="binderTotalSub"><IconSwap size={18} /> Doubles (trade pile): ${value.duplicatesValue.toFixed(2)}</div>
          )}
          {value.unpriced > 0 && (
            <div className="binderTotalNote">
              ({value.unpriced} card{value.unpriced === 1 ? ' has' : 's have'} no price yet)
            </div>
          )}
        </div>
      )}
      <div className="chipRow">
        <span className="chip"><IconCards size={18} /> {list.reduce((a, e) => a + e.qty, 0)} cards</span>
        <button className={`chip btn${doublesOnly ? ' on' : ''}`} onClick={() => setDoublesOnly(!doublesOnly)}>
          <IconSwap size={18} /> Doubles (trade pile){doublesOnly ? ' (on)' : ''}
        </button>
        {/* Same scan-a-binder flow the kid bar's Add Cards button
            opens — go('scan') is the one shared entry point. */}
        <button className="chip btn" onClick={() => go('scan')}><IconPlus size={18} /> Add cards</button>
      </div>
      <button className="ideasBtn" onClick={() => go('ideas')}>
        <IconBulb size={26} /><span>Trade Ideas</span>
      </button>
      {kidCount >= 2 && <div className="ideasHint">Swap ideas between binders!</div>}
      {kidCount < 2 && <div className="ideasHint">Ideas need two kids — ask a grown-up to add one!</div>}
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
        <div className="screenNote">No cards yet! Tap Add Cards and scan the binder in.</div>
      )}
      {doublesOnly && shown.length > 0 && (
        <div className="binderSubtotal"><IconSwap /> Doubles (trade pile): ${value.duplicatesValue.toFixed(2)}</div>
      )}
      {doublesOnly && !shown.length && list.length > 0 && (
        <div className="screenNote">No doubles yet — scan a second copy of a card and it lands here!</div>
      )}
      {!doublesOnly && list.length > 0 && <h3 className="binderAllHead">All my cards</h3>}
      {shown.length > 0 && (
        <div className="cardGrid">
          {shown.map((e) => (
            <CardTile key={e.ref} entry={e} showPrice onTap={() => setSelRef(selRef === e.ref ? null : e.ref)} />
          ))}
        </div>
      )}
      {sel && (
        <div className="qtySheet">
          <div className="qtyName">{sel.card.name} — #{sel.card.number}</div>
          <div className="qtyRow">
            <button onClick={() => store.setBinderQty(kid.id, sel.ref, sel.qty - 1)} aria-label="one less"><IconMinus /></button>
            <span>×{sel.qty}</span>
            <button onClick={() => store.setBinderQty(kid.id, sel.ref, sel.qty + 1)} aria-label="one more"><IconPlus /></button>
            <button className="removeBtn" onClick={() => { store.removeFromBinder(kid.id, sel.ref); setSelRef(null); }}><IconTrash size={19} /> Remove</button>
          </div>
        </div>
      )}
      <BadgesSection kid={kid} />
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
  // This kid's owned entries in THIS set — valued with the same
  // binderValue() helper as the binder banner and ParentLayer.
  const setValue = useMemo(
    () => binderValue(list.filter((e) => e.card.lang === lang && String(e.card.setId) === String(setId))),
    [list, lang, setId]
  );
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
  if (!kid) return <div className="screenNote">Pick a kid first!</div>;
  if (err) return <div className="screen"><button className="backBtn" onClick={() => go('binder')}><IconBack size={19} /> Binder</button><div className="screenNote">{err}</div></div>;
  if (!setData) return <div className="screenNote">Loading the set…</div>;
  return (
    <div className="screen">
      <button className="backBtn" onClick={() => go('binder')}><IconBack size={19} /> Binder</button>
      <h2 className="screenTitle">{setData.set.name}</h2>
      <div className="progressHead">
        <span>{ownedCount} / {totalShown}</span>
        <span className="bar big"><span style={{ width: Math.round((ownedCount / totalShown) * 100) + '%' }} /></span>
        <span>{Math.round((ownedCount / totalShown) * 100)}%</span>
      </div>
      {ownedCount > 0 && (
        <div className="setValueLine">
          <IconTag size={19} /> Your cards in this set: ${setValue.total.toFixed(2)}
          {setValue.unpriced > 0 && (
            <span className="setValueNote"> ({setValue.unpriced} card{setValue.unpriced === 1 ? ' has' : 's have'} no price yet)</span>
          )}
        </div>
      )}
      <div className="cardGrid setGrid">
        {setData.cards.map((c) => {
          const has = owned.has(c.ref);
          const ownEntry = has ? list.find((e) => e.ref === c.ref) : null;
          const qty = ownEntry ? ownEntry.qty : 0;
          const priceLine = fmtPriceLine(c, has ? qty : 1);
          const holderKids = holders.get(c.ref) || [];
          const holder = holderKids.length ? state.kids.find((k) => k.id === holderKids[0]) : null;
          return (
            <div key={c.ref} className={`setSlot${has ? '' : ' ghost'}`}>
              <div className="slotArt">
                {c.thumb || c.image
                  ? <img src={c.thumb || c.image} alt={c.name} loading="lazy" />
                  : <div className="noArt">{c.name}</div>}
                <span className="slotNum">#{c.number}</span>
                {has && <span className="slotQty">×{qty}</span>}
                {holder && <span className="spareTag">{holder.emoji} has a spare!</span>}
              </div>
              {has && (priceLine
                ? <span className="slotPrice">{priceLine}</span>
                : <span className="slotPrice none">no price</span>)}
              {!has && priceLine && <span className="slotPrice muted">{priceLine}</span>}
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
  if (!kid) return <div className="screenNote">Add a kid in the grown-ups section first!</div>;

  // Same bridge as the trade panels: native shell → camera plugin,
  // browser (or any plugin failure) → the hidden file input below. A
  // cancelled camera is a no-op. The file from either source flows
  // through the identical shrink + identify pipeline in onPhotoFile.
  async function onTakePicture() {
    const shot = await takeNativePhoto();
    if (shot === 'cancelled') return;
    if (shot) { onPhotoFile(shot); return; }
    fileRef.current && fileRef.current.click();
  }

  function onPhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) onPhotoFile(file);
  }

  async function onPhotoFile(file) {
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
        if (json.stumped) { setStatus('That one stumped me! Skip it for now.'); playClip('stumped', ''); }
        else if (json.error === 'unreadable' || json.error === 'no-card') { setStatus('I couldn\'t read that one — try again!'); playClip('unreadable', ''); }
        else { setStatus('Something went wrong — try again!'); playClip('wrong', ''); }
        return;
      }
      const shown = (json.candidates || []).filter((c) => c.displayable);
      if (!shown.length) {
        if (json.stumped) { setStatus('That one stumped me! Skip it for now.'); playClip('stumped', ''); }
        else { setStatus('I couldn\'t read that one — try again!'); playClip('unreadable', ''); }
        return;
      }
      setChoices(shown.slice(0, 3));
      playClip('tap', '');
    } catch {
      setStatus('Something went wrong — try again!');
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
      setStatus('That card isn\'t in our card book yet — skip it for now.');
    }
  }

  return (
    <div className="screen">
      <h2 className="screenTitle"><IconCardPlus /> Add cards to {kid.emoji} {kid.name}&rsquo;s binder</h2>
      <div className="scanCount">{count} card{count === 1 ? '' : 's'} added!</div>
      {last && (
        <div className="lastAdded">
          {last.thumb || last.image ? <img src={last.thumb || last.image} alt={last.name} /> : null}
          <span><IconStar size={20} /> {last.name}</span>
        </div>
      )}
      <div className="status" role="status">{status}</div>
      {choices ? (
        <div className="choices">
          <div className="q">Tap your card!</div>
          <div className={`choiceGrid${choices.length === 1 ? ' one' : ''}`}>
            {choices.map((c, i) => (
              <button key={i} className="choiceBtn" onClick={() => pick(c)}>
                <img src={c.image} alt={c.name} />
              </button>
            ))}
          </div>
          <button className="noneBtn" onClick={() => { setChoices(null); setStatus('No problem — try the photo again!'); playClip('takeAgain', ''); }}>
            <IconX /> NONE OF THESE — TAKE IT AGAIN
          </button>
        </div>
      ) : (
        <>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
          <button className="photoBtn big" disabled={busy} onClick={onTakePicture}>
            {busy ? 'Looking…' : <><IconCamera size={30} /> TAKE A PICTURE</>}
          </button>
        </>
      )}
      <button className="againBtn" onClick={() => go('binder')}><IconCheck /> DONE</button>
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
        <button className="againBtn" onClick={onClose}><IconCheck /> DONE</button>
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
  const swaps = useMemo(
    () => (A && B ? perfectSwaps(listA, listB, 10, { fairness: state.fairness }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listA, listB, A, B, state.fairness]
  );
  const giftsAB = useMemo(() => (A && B ? giftIdeas(listA, listB) : []), [listA, listB, A, B]);
  const giftsBA = useMemo(() => (A && B ? giftIdeas(listB, listA) : []), [listA, listB, A, B]);
  if (kids.length < 2) return <div className="screenNote">Trade ideas need two kids — ask a grown-up to add another in the grown-ups section!</div>;
  if (!A || !B) return <div className="screenNote">Pick two kids!</div>;
  const pairCard = (give, get, kidGive, kidGet, onStart) => (
    <div className="ideaCard">
      <div className="ideaSide">
        <span className="ideaKid">{kidGive.emoji} {kidGive.name} gives</span>
        {give.card.thumb || give.card.image ? <img src={give.card.thumb || give.card.image} alt={give.card.name} /> : <div className="noArt">{give.card.name}</div>}
      </div>
      <div className="ideaArrow"><IconSwap size={30} /></div>
      <div className="ideaSide">
        <span className="ideaKid">{kidGet.emoji} {kidGet.name} gives</span>
        {get ? (get.card.thumb || get.card.image ? <img src={get.card.thumb || get.card.image} alt={get.card.name} /> : <div className="noArt">{get.card.name}</div>) : <div className="noArt"><IconGift size={30} /><br />a surprise!</div>}
      </div>
      <button className="goBtnSmall" onClick={onStart}><IconPlay size={18} /> Start this trade</button>
      <details className="ideaDetail">
        <summary>Grown-ups: values</summary>
        {give.card.name} {typeof give.card.price === 'number' ? `$${give.card.price.toFixed(2)}` : 'no price'}
        {get ? <> ↔ {get.card.name} {typeof get.card.price === 'number' ? `$${get.card.price.toFixed(2)}` : 'no price'}</> : null}
      </details>
    </div>
  );
  return (
    <div className="screen">
      <button className="backBtn" onClick={() => go('binder')}><IconBack size={19} /> Binder</button>
      <h2 className="screenTitle"><IconBulb /> Trade ideas</h2>
      <div className="ideaPickers">
        <KidSwitcher kids={kids} value={A.id} onChange={(id) => { setAId(id); if (id === B.id) setBId(A.id); }} />
        <span className="ideaVs"><IconSwap size={28} /></span>
        <KidSwitcher kids={kids.filter((k) => k.id !== A.id)} value={B.id} onChange={setBId} />
      </div>
      {loading && <div className="screenNote">Thinking…</div>}
      <h3 className="ideaHead"><IconStar /> Perfect swaps</h3>
      {!swaps.length && <div className="screenNote">No perfect swaps yet — scan more cards into both binders!</div>}
      {swaps.map((s, i) => (
        <div key={i}>{pairCard(s.giveA, s.giveB, A, B, () => onStartTrade({
          aKid: A.id, bKid: B.id, aCards: [s.giveA.card], bCards: [s.giveB.card],
        }))}</div>
      ))}
      <h3 className="ideaHead"><IconGift /> Almost-finishing gifts</h3>
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

// ---------- Badges (was the "Me" tab; now a section of the binder) ----------

// The Fair Trader badge content that used to fill the ⭐ Me screen,
// as a section rendered at the bottom of the binder for the active
// kid. Star rows are drawn with the custom star icon — the tier's
// star COUNT comes from lib/logic.js FAIR_TIERS order (tier index),
// not from its display string.
const TIER_STAR_COUNT = { 'First Fair Trade': 1, 'Fair Trader': 3, 'Super Fair Trader': 4, 'Fair Trade Legend': 5 };

export function BadgesSection({ kid }) {
  const state = useStoreState();
  const { list } = useKidBinder(kid ? kid.id : null);
  if (!kid) return null;
  const trades = kidFairTrades(state.trades, kid.id);
  const badge = fairTraderBadge(trades.length);
  const progress = setProgress(list);
  const sb = setBadges(progress);
  const starCount = badge.tier ? (TIER_STAR_COUNT[badge.tier.name] || 1) : 0;
  return (
    <div className="badgesWrap">
      <h3 className="ideaHead"><IconStar /> My badges</h3>
      <div className="badgeCard">
        <div className="badgeTitle">Fair Trader</div>
        <div className="badgeStars">
          {starCount > 0
            ? Array.from({ length: starCount }, (_, i) => <IconStar key={i} size={30} />)
            : <span className="badgeStarEmpty"><IconStar size={30} /></span>}
        </div>
        <div className="badgeBig">{trades.length}</div>
        <div className="badgeName">{badge.tier ? badge.tier.name : 'Make a fair trade to earn your first star!'}</div>
        {badge.next && badge.tier && <div className="badgeNext">{badge.next.min - trades.length} more to “{badge.next.name}”</div>}
      </div>
      <h3 className="ideaHead"><IconCompass /> Set Explorer</h3>
      {!sb.length && <div className="screenNote">Finish half of a set to earn a badge!</div>}
      <div className="setBadgeGrid">
        {sb.map((b) => (
          <div key={b.setKey} className="setBadge">
            <span className="setBadgeIcon">{b.crown ? <IconCrown size={30} /> : <IconCompass size={30} />}</span>
            <span className="setBadgeName">{b.setName}</span>
            <span className="setBadgePct">{Math.round(b.pct * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Kept for compatibility: the profile view is now just the kid's
// head + the badges section (the binder renders the same section
// inline; nothing links here from the kid bar anymore).
export function ProfileScreen({ kid, go }) {
  if (!kid) return <div className="screenNote">Add a kid in the grown-ups section first!</div>;
  return (
    <div className="screen">
      <div className="profileHead" style={{ borderColor: kid.color }}>
        <span className="profileEmoji">{kid.emoji}</span>
        <span className="profileName">{kid.name}</span>
      </div>
      <BadgesSection kid={kid} />
      <button className="againBtn" onClick={() => go('binder')}><IconBinder /> Open my binder</button>
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

export function ParentLayer({ onOpenBinder } = {}) {
  const state = useStoreState();
  const [selKidId, setSelKidId] = useState(null);
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState(store.KID_EMOJIS[0]);
  const selKid = state.kids.find((k) => k.id === (selKidId || state.activeKidId)) || state.kids[0] || null;
  const { list } = useKidBinder(selKid ? selKid.id : null);
  const value = useMemo(() => binderValue(list), [list]);
  const progress = useMemo(() => setProgress(list), [list]);
  // Gift Radar headlines only sets with meaningful progress
  // (>= 10% owned or >= 15 cards) — see lib/logic.js radarSets.
  const topSets = useMemo(() => radarSets(progress), [progress]);
  const fairness = normalizeFairness(state.fairness);
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
      <h4 id="kids-binders"><IconBinder size={19} /> Kids &amp; binders</h4>
      {state.kids.map((k) => (
        <div key={k.id} className="row">
          <button className="go" title="Change picture" onClick={() => {
            const i = store.KID_EMOJIS.indexOf(k.emoji);
            store.renameKid(k.id, undefined, store.KID_EMOJIS[(i + 1) % store.KID_EMOJIS.length]);
          }}>{k.emoji}</button>
          <input defaultValue={k.name} key={k.id + k.name} style={{ flex: '1 1 120px' }}
            onBlur={(e) => store.renameKid(k.id, e.target.value)} />
          <span>{kindWord(state.binders[k.id] ? Object.keys(state.binders[k.id]).length : 0)}</span>
          <button className="go" onClick={() => { setSelKidId(k.id); if (onOpenBinder) onOpenBinder(k.id); }}><IconBinder size={17} /> Open binder</button>
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
        }}><IconPlus size={17} /> Add kid</button>
      </div>
      <h4><IconScales size={19} /> Fairness cushion</h4>
      <p>
        How close the two sides of a trade must be to count as FAIR.
        “Percentage (standard)” compares the gap to the bigger side&rsquo;s value (fair within 15%);
        a fixed cushion uses plain dollars instead — handy for cheap cards, where 15% is pennies.
        ALMOST FAIR allows 3x the window either way, and any window widens x1.5 when a
        Japanese (EUR-priced) card is in the trade.
      </p>
      <div className="row">
        <button className="go"
          style={fairness.mode === 'pct' ? { outline: '3px solid #f5b301' } : undefined}
          onClick={() => store.setFairness({ mode: 'pct' })}>Percentage (standard)</button>
        {CUSHION_CHOICES.map((c) => (
          <button key={c} className="go"
            style={fairness.mode === 'cushion' && fairness.cents === c ? { outline: '3px solid #f5b301' } : undefined}
            onClick={() => store.setFairness({ mode: 'cushion', cents: c })}>{fmtCushion(c)}</button>
        ))}
      </div>
      {selKid && (
        <>
          <h4>Parent view — values &amp; gift ideas for {selKid.name.split(' ')[0]}</h4>
          <p>Everything below follows the kid picked with Open binder above.</p>
          <h4><IconBinder size={19} /> {selKid.emoji} {selKid.name}&rsquo;s binder value</h4>
          <p>
            {value.count} card{value.count === 1 ? '' : 's'} ({kindWord(value.distinct)}) worth about <b>${value.total.toFixed(2)}</b>.
            Doubles (trade pile) worth about <b>${value.duplicatesValue.toFixed(2)}</b>.
            Japanese cards are counted at their converted USD value, same as trades.
          </p>
          <h4><IconGift size={19} /> Gift Radar — {selKid.name.split(' ')[0]}&rsquo;s closest sets</h4>
          <p>
            Cards {selKid.name.split(' ')[0]} is <b>MISSING</b> from the sets he&rsquo;s closest to
            finishing — gift ideas for family. These aren&rsquo;t his cards; they&rsquo;re what&rsquo;s
            left to complete the set.
          </p>
          {!progress.length && <p>No cards yet — scan some into the binder and gift ideas appear here.</p>}
          {!!progress.length && !topSets.length && (
            <p>No set is close yet — once {selKid.name.split(' ')[0]} has a good chunk of one set scanned in, gift ideas will show up here.</p>
          )}
          {!!topSets.length && (
            <>
              <p>{topSets.map((s) => `${s.setName} (${s.owned}/${s.total})`).join(' · ')}</p>
              <div className="row">
                {['any', '5', '10', '25'].map((b) => (
                  <button key={b} className="go" style={budget === b ? { outline: '3px solid #f5b301' } : undefined}
                    onClick={() => setBudget(b)}>{b === 'any' ? 'Any price' : `Under $${b}`}</button>
                ))}
              </div>
              {!!radar.length && (
                <p>{radar.length > 10
                  ? `Cheapest 10 of ${radar.length} missing`
                  : `All ${radar.length} missing card${radar.length === 1 ? '' : 's'}`}:</p>
              )}
              {radar.slice(0, 10).map((c) => (
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
          <h4><IconLink size={19} /> Move or share this binder</h4>
          <p>Anyone opening this link on another device can import a copy of {selKid.name}&rsquo;s binder (it asks first, and merges by adding quantities).</p>
          <CopyLink value={shareBinder} />
        </>
      )}
    </div>
  );
}
