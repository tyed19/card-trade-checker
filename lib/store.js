// On-device Phase 3 store: kid profiles, per-kid binders, and the
// fair-trade log. Everything lives in localStorage under one
// versioned key — no server database, no accounts (Phase 3
// architecture decision). Prices/art are NEVER stored; binder entries
// keep only { ref, id, qty, addedAt } and resolve against the catalog.
//
// localStorage is touched lazily inside functions (never at module
// top) so the module is import-safe during SSR and in node tests with
// a shim.

export const STORE_KEY = 'ctc.phase3.v1';

export const KID_EMOJIS = ['🦊', '🐰', '🦁', '🐢', '🦄', '🐙', '🐳', '🦖', '🐼', '🦉', '🐶', '🦋'];
export const KID_COLORS = ['#1e4fa3', '#a31621', '#14532d', '#713f12', '#4c1d95', '#0f766e', '#9d174d', '#1f3a68'];

export const emptyState = () => ({
  v: 1,
  kids: [],            // [{id, name, emoji, color}]
  binders: {},         // { [kidId]: { [ref]: {qty, id, addedAt} } }
  trades: [],          // [{id, at, aKid, bKid, fair, aRefs:[], bRefs:[]}]
  activeKidId: null,
});

let state = null;
const listeners = new Set();

function load() {
  if (state) return state;
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 1 && Array.isArray(parsed.kids)) {
        state = { ...emptyState(), ...parsed };
        return state;
      }
    }
  } catch { /* corrupted storage -> start fresh rather than crash */ }
  state = emptyState();
  return state;
}

function persist() {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch { /* storage full/blocked: state still lives in memory */ }
}

export function getState() { return load(); }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
// useSyncExternalStore server snapshot: a stable empty state.
const SERVER_STATE = emptyState();
export function getServerState() { return SERVER_STATE; }

export function update(mutator) {
  const s = load();
  mutator(s);
  // Fresh top-level containers so useSyncExternalStore sees a new
  // snapshot (Object.is) and React re-renders.
  state = { ...s, kids: [...s.kids], binders: { ...s.binders }, trades: [...s.trades] };
  persist();
  for (const fn of [...listeners]) fn();
}

// Repair a stored binder ref whose catalog row shifted (the resolver
// verified the entry's id lives at a different row now).
export function healBinderRef(kidId, oldRef, newRef, id) {
  if (!oldRef || !newRef || oldRef === newRef) return;
  update((st) => {
    const b = st.binders[kidId];
    if (!b || !b[oldRef]) return;
    const cur = b[oldRef];
    const dst = b[newRef];
    b[newRef] = {
      qty: (dst ? dst.qty : 0) + cur.qty,
      id: id || cur.id || (dst && dst.id) || null,
      addedAt: dst ? dst.addedAt : cur.addedAt,
    };
    delete b[oldRef];
  });
}

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

// --- Kids ---------------------------------------------------------------

export function addKid(name, emoji) {
  const s = load();
  const i = s.kids.length;
  const kid = {
    id: 'k' + uid(),
    name: String(name || '').trim() || 'Kid ' + (i + 1),
    emoji: emoji || KID_EMOJIS[i % KID_EMOJIS.length],
    color: KID_COLORS[i % KID_COLORS.length],
  };
  update((st) => {
    st.kids.push(kid);
    st.binders[kid.id] = st.binders[kid.id] || {};
    if (!st.activeKidId) st.activeKidId = kid.id;
  });
  return kid;
}

export function renameKid(kidId, name, emoji) {
  update((st) => {
    const k = st.kids.find((x) => x.id === kidId);
    if (k) {
      if (name !== undefined) k.name = String(name).trim() || k.name;
      if (emoji !== undefined) k.emoji = emoji;
    }
  });
}

export function deleteKid(kidId) {
  update((st) => {
    st.kids = st.kids.filter((x) => x.id !== kidId);
    delete st.binders[kidId];
    if (st.activeKidId === kidId) st.activeKidId = st.kids.length ? st.kids[0].id : null;
  });
}

export function setActiveKid(kidId) {
  update((st) => { st.activeKidId = kidId; });
}

// --- Binder ---------------------------------------------------------------

export function addToBinder(kidId, ref, id, qty = 1) {
  if (!kidId || !ref) return;
  update((st) => {
    const b = (st.binders[kidId] = st.binders[kidId] || {});
    const cur = b[ref];
    b[ref] = {
      qty: (cur ? cur.qty : 0) + qty,
      id: id || (cur && cur.id) || null,
      addedAt: cur ? cur.addedAt : Date.now(),
    };
  });
}

export function setBinderQty(kidId, ref, qty) {
  update((st) => {
    const b = st.binders[kidId];
    if (!b || !b[ref]) return;
    if (qty <= 0) delete b[ref];
    else b[ref] = { ...b[ref], qty };
  });
}

export function removeFromBinder(kidId, ref) { setBinderQty(kidId, ref, 0); }

// Merge imported entries ([{ref, qty}], ids unknown at import time —
// resolved/healed on next binder render via pair resolution).
export function importBinder(kidId, entries, { merge = true } = {}) {
  update((st) => {
    const b = (st.binders[kidId] = st.binders[kidId] || {});
    for (const e of entries || []) {
      if (!e || !e.ref) continue;
      const cur = b[e.ref];
      b[e.ref] = {
        qty: merge && cur ? cur.qty + e.qty : e.qty,
        id: (cur && cur.id) || null,
        addedAt: cur ? cur.addedAt : Date.now(),
      };
    }
  });
}

// Apply a binder change caused by a completed trade: remove refs from
// the giver, add to the receiver. refs: [ref,...] (one per card).
export function applyTradeMove(fromKid, toKid, refs) {
  if (!fromKid || !toKid || fromKid === toKid) return;
  update((st) => {
    const from = st.binders[fromKid] || {};
    const to = (st.binders[toKid] = st.binders[toKid] || {});
    for (const ref of refs || []) {
      const cur = from[ref];
      if (cur) {
        if (cur.qty <= 1) delete from[ref];
        else from[ref] = { ...cur, qty: cur.qty - 1 };
      }
      const dst = to[ref];
      to[ref] = { qty: (dst ? dst.qty : 0) + 1, id: (dst && dst.id) || (cur && cur.id) || null, addedAt: dst ? dst.addedAt : Date.now() };
    }
  });
}

// --- Trade log --------------------------------------------------------------

export function logTrade({ aKid, bKid, aRefs = [], bRefs = [] }) {
  const entry = {
    id: 't' + uid(), at: Date.now(),
    aKid: aKid || null, bKid: bKid || null, fair: true,
    aRefs, bRefs,
  };
  update((st) => { st.trades.push(entry); });
  return entry;
}
