'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStoreState, useAllBinders, KidBar, KidSwitcher, BinderHome, SetPage,
  ScanSession, BinderPicker, IdeasScreen, ProfileScreen, ParentLayer,
  addCandidateToBinder, resolveCandidateRef,
} from './binder-ui';
import {
  IconScales, IconBinder, IconCards, IconCamera, IconCheck,
  IconX, IconLock, IconSwap, IconSearch, IconHandshake, IconPlus,
  IconBack, IconRefresh, IconDice, IconStar,
} from './icons';
import * as store from '../lib/store';
import { spareCopies, autoBalance, verdictKind, fairnessBand, normalizeFairness, fmtCushion, fmtPriceLine, priceCoverage, tradeIsUnpriceable, FAIR_BAND } from '../lib/logic';
import { decodePayload } from '../lib/links';
import { takeNativePhoto, verdictHaptic, isNative } from '../lib/native';
import { captureEntry, afterPreviewAutoFail, handoffNotice } from '../lib/capture-route';
import { prepareForUpload, assessBitmap } from '../lib/capture';
import CameraPreview from './camera-preview';

const DEMO = {
  mine: {
    id: 'demo-flapple', name: 'Flapple VMAX', set: 'Battle Styles', number: '019',
    price: 2.32, variants: { holofoil: 2.32 },
    image: 'https://assets.tcgdex.net/en/swsh/swsh5/19/high.png',
  },
  theirs: {
    id: 'demo-abomasnow', name: 'Mega Abomasnow ex', set: 'Mega Evolution', number: '157',
    price: 1.9, variants: { holofoil: 1.9 },
    image: 'https://images.pokemontcg.io/me1/157_hires.png',
  },
};

// ---------- Voice ----------
// Every fixed line in the app has a pre-recorded clip (warm human
// voice) under public/audio — the built-in speechSynthesis voice was
// the robot the kids hated. Dynamic lines (only the NOT FAIR detail,
// which contains a card count) still use the synthesizer, but with
// the best system voice we can find and friendlier prosody. If a
// clip fails to load or play, we fall back to the synthesizer for
// that line — speech is a bonus, never silence, never a blocker.

const CLIPS = {
  looking: '/audio/looking.mp3',
  tap: '/audio/tap-your-card.mp3',
  stumped: '/audio/stumped.mp3',
  unreadable: '/audio/couldnt-read.mp3',
  wrong: '/audio/something-wrong.mp3',
  gotIt: '/audio/got-it.mp3',
  takeAgain: '/audio/take-again.mp3',
  fair: '/audio/verdict-fair.mp3',
  almost: '/audio/verdict-almost.mp3',
  notfair: '/audio/verdict-notfair.mp3',
  demo: '/audio/demo-ready.mp3',
  allClear: '/audio/all-clear.mp3',
};

const clipEls = {};
let currentClip = null;

function getClipEl(src) {
  if (!clipEls[src]) {
    const a = new Audio();
    a.preload = 'auto';
    a.src = src;
    clipEls[src] = a;
  }
  return clipEls[src];
}

function stopAllSpeech() {
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  if (currentClip) {
    try { currentClip.pause(); currentClip.currentTime = 0; } catch { /* ignore */ }
    currentClip = null;
  }
}

// Preference order for the fallback system voice: warm, natural
// en-US voices first; novelty/compact voices are excluded outright.
const VOICE_PREFS = [
  /samantha/i,
  /google us english/i,
  /natural/i,
  /neural/i,
  /karen/i,
  /moira/i,
  /zira/i,
  /aria/i,
];
const VOICE_AVOID = /fred|zarvox|trinoids|albert|bad news|good news|bahh|bells|boing|bubbles|cellos|deranged|hysterical|jester|pipe organ|wobble|whisper|superstar|compact/i;

function pickVoice() {
  try {
    const voices = window.speechSynthesis?.getVoices() || [];
    if (!voices.length) return null;
    const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang || ''));
    const pool = (en.length ? en : voices).filter((v) => !VOICE_AVOID.test(v.name || ''));
    if (!pool.length) return null;
    for (const re of VOICE_PREFS) {
      const hit = pool.find((v) => re.test(v.name) && /^en[-_]US/i.test(v.lang || ''));
      if (hit) return hit;
    }
    for (const re of VOICE_PREFS) {
      const hit = pool.find((v) => re.test(v.name));
      if (hit) return hit;
    }
    return pool.find((v) => v.default) || pool[0];
  } catch { return null; }
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  // Voices load asynchronously; re-pick whenever the list changes
  // (pickVoice() is also called fresh at every synthSpeak()).
  try { window.speechSynthesis.onvoiceschanged = () => pickVoice(); } catch { /* ignore */ }
}

function synthSpeak(text) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (currentClip) {
      try { currentClip.pause(); currentClip.currentTime = 0; } catch { /* ignore */ }
      currentClip = null;
    }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 0.98;
    u.pitch = 1.1;
    synth.speak(u);
  } catch { /* speech is a bonus, never a blocker */ }
}

// Play the recorded clip for a fixed line. Resolves when the clip
// ends (or after falling back to the synthesizer for that line).
function playClip(key, fallbackText) {
  const src = CLIPS[key];
  if (!src) { if (fallbackText) synthSpeak(fallbackText); return Promise.resolve(); }
  stopAllSpeech();
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (!ok && fallbackText) synthSpeak(fallbackText);
      resolve();
    };
    try {
      const el = getClipEl(src);
      currentClip = el;
      el.onended = () => { if (currentClip === el) currentClip = null; done(true); };
      el.onerror = () => done(false);
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => done(false));
    } catch { done(false); }
  });
}

const emptySide = () => ({ cards: [], choices: null, busy: false, status: '', hint: null, progress: null, failureKind: null });

// Upload prep lives in lib/capture.js now (capture overhaul): crop to
// the card and upload the crop at high quality, with a pre-submit
// blur gate. The old whole-frame 2400px/q90 shrink survives inside
// prepareForUpload as the fallback when no card box is found.

export default function Home() {
  // Preload the voice clips on the first tap anywhere, so they start
  // instantly when spoken later (and a gesture-warmed <audio> element
  // satisfies iOS autoplay rules for the tap-driven flow).
  useEffect(() => {
    const warm = () => {
      Object.values(CLIPS).forEach((src) => { try { getClipEl(src).load(); } catch { /* ignore */ } });
      window.removeEventListener('pointerdown', warm);
    };
    window.addEventListener('pointerdown', warm);
    // Warm the identify backend (CLIP model + OCR worker) so the FIRST
    // scan of a session doesn't pay cold-start inside its deadline —
    // the first scan is virtually always the blue MY CARD side, which
    // is why slow first scans looked like a my-side bug. Best-effort:
    // serverless instances are reused opportunistically, not guaranteed.
    try { fetch('/api/warm').catch(() => {}); } catch { /* ignore */ }
    return () => window.removeEventListener('pointerdown', warm);
  }, []);

  const [sides, setSides] = useState({ mine: emptySide(), theirs: emptySide() });
  const [verdict, setVerdict] = useState(null);
  // True after a card change wiped a verdict: the flow shows a
  // "cards changed — tap CHECK again" note instead of a stale answer.
  const [staleNote, setStaleNote] = useState(false);
  // Grown-ups is its own full screen now, not a collapsible at the
  // bottom of the kid scroll. grownFrom = the kid view we came from
  // (null = grown-ups closed). It doubles as the context gate: the
  // trade-only blocks inside the grown-ups screen render only when
  // grownFrom === 'trade' — entering from the binder keeps the
  // price-compare table and manual search out, as the owner asked.
  const [grownFrom, setGrownFrom] = useState(null);
  const [grownHint, setGrownHint] = useState(false);
  // Set by the kid-switcher's "Add a kid" tile: once the grown-ups
  // screen opens, scroll straight to Kids & binders (see the effect
  // below the grownOpen derivation).
  const [grownJumpKids, setGrownJumpKids] = useState(false);
  const grownPress = useRef({ timer: null, opened: false });
  const [manual, setManual] = useState({ name: '', number: '', side: 'mine', results: [], busy: false });
  const fileRefs = { mine: useRef(null), theirs: useRef(null) };
  // Per-side scan sequence: a response may only write state for the
  // scan that is still current on that side (see onPhoto).
  const scanSeq = useRef({ mine: 0, theirs: 0 });
  // Two-photo merge: the last failed scan's OCR summary, sent back
  // with a tilted second capture so the server can combine both
  // photos' text evidence (see lib/hybrid.js). Cleared when the kid
  // rejects the choices (NONE OF THESE) — that evidence pointed at
  // the wrong cards and must not ride along.
  const lastOcrRef = useRef({ mine: null, theirs: null });
  // The hidden file input is shared by normal and second-photo picks:
  // this flag tells its onChange which kind the next pick is.
  const secondPhotoPick = useRef({ mine: false, theirs: false });
  // Live guided preview (native camera preview): null, or
  // { side, second, stage }. The preview runs wherever getUserMedia
  // exists — including inside the native shell (see
  // lib/capture-route.js). The native Camera plugin is strictly a
  // fallback: its ACTION_IMAGE_CAPTURE intent can resolve to Google
  // Lens on some Android phones. `stage` is progressive capture's
  // missing piece ('number' | 'tilt' | 'straight' | null): the
  // preview highlights just that piece (the number stage grows and
  // pulses the two bottom-edge dots) and is otherwise unchanged.
  const [preview, setPreview] = useState(null);
  // Warm again when the capture preview opens: the identify call
  // follows seconds later, and a fresh ping right before it beats a
  // page-mount ping from minutes ago on serverless (instances are
  // reused opportunistically, never guaranteed). One effect covers
  // every preview-open path (photo button, second photo, progressive
  // next shot) — the preview component itself is untouched. (This
  // must sit AFTER the preview state above: the dep array evaluates
  // during render, so referencing preview earlier is a TDZ error.)
  useEffect(() => {
    if (!preview) return;
    try { fetch('/api/warm').catch(() => {}); } catch { /* ignore */ }
  }, [preview]);
  // Camera-failure notice: set when the preview AND (in the shell)
  // the native-plugin fallback both missed, so the failure is named
  // with the way back instead of silently dropping to the picker.
  // Shape: { side, second, denied } or null. Cleared on the next
  // capture attempt.
  const [camNotice, setCamNotice] = useState(null);
  // Camera-handoff interstitial: set whenever an AUTOMATIC fallback
  // is about to open the phone's dumb camera (native intent or the
  // capture file input after a preview failure), so the failure is
  // named and the framing guidance lands BEFORE the user shoots —
  // never silently mid-flight. Shape: { side, second,
  // kind: 'native' | 'picker', denied, noApi } or null. The handoff
  // fires only on the user's "Open camera" tap; "Never mind" closes
  // it with nothing opened (same cancel semantics as backing out of
  // the camera itself). Deliberate escapes (the preview's "Use photo
  // picker instead", the camNotice's "Pick a photo") stay immediate:
  // the user already chose to leave, so there is nothing to explain.
  const [camHandoff, setCamHandoff] = useState(null);
  const entryPath = () => {
    try {
      return captureEntry({ isNative: isNative(), hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) });
    } catch { return 'picker'; }
  };

  // ---- Phase 3 state: views, per-side kid assignment, pickers ----
  const binderState = useStoreState();
  const { lists: allLists } = useAllBinders();
  const [view, setView] = useState('trade');
  const [setKey, setSetKey] = useState(null);
  const [sideKids, setSideKids] = useState({ mine: null, theirs: null });
  const [pickerSide, setPickerSide] = useState(null);
  const [binderPick, setBinderPick] = useState(null); // candidate awaiting a kid choice
  const [binderMsg, setBinderMsg] = useState('');
  const [tradedDone, setTradedDone] = useState(false);
  const [importOffer, setImportOffer] = useState(null);
  const activeKid = binderState.kids.find((k) => k.id === binderState.activeKidId) || binderState.kids[0] || null;

  useEffect(() => {
    if (!binderMsg) return;
    const t = setTimeout(() => setBinderMsg(''), 2600);
    return () => clearTimeout(t);
  }, [binderMsg]);

  // Binder share links land on /?import=<encoded>: offer the import
  // once, then scrub the param so a reload doesn't re-offer.
  useEffect(() => {
    try {
      const code = new URLSearchParams(window.location.search).get('import');
      if (code) {
        const p = decodePayload(code);
        if (p && p.t === 'binder' && p.entries.length) setImportOffer(p);
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch { /* malformed link: ignore */ }
  }, []);

  function go(v, param) {
    setView(v);
    if (v === 'set') setSetKey(param);
    try { window.scrollTo({ top: 0 }); } catch { /* ignore */ }
  }

  // Kid-bar navigation: speak the label, then go. Only nav taps
  // speak — other go() calls (back buttons, deep links) stay quiet,
  // and a nav tap never coincides with verdict speech.
  function navGo(v, label) {
    if (label) synthSpeak(label);
    go(v);
  }

  // Grown-ups entry: LONG-PRESS (~600ms) opens the screen; a plain
  // tap just shows the hint. Pointer handlers (not click) so the
  // press duration is measurable on touch and mouse alike.
  function grownPressStart() {
    grownPress.current.opened = false;
    clearTimeout(grownPress.current.timer);
    grownPress.current.timer = setTimeout(() => {
      grownPress.current.opened = true;
      setGrownHint(false);
      setGrownFrom(view);
      try { window.scrollTo({ top: 0 }); } catch { /* ignore */ }
    }, 600);
  }
  function grownPressEnd() {
    clearTimeout(grownPress.current.timer);
    if (!grownPress.current.opened) {
      setGrownHint(true);
      setTimeout(() => setGrownHint(false), 2400);
    }
    grownPress.current.opened = false;
  }
  function grownPressCancel() {
    clearTimeout(grownPress.current.timer);
    grownPress.current.opened = false;
  }

  // The kid-switcher's "＋ Add a kid" tile: a second, obvious door
  // for this one job. It opens the grown-ups screen directly at
  // Kids & binders — NO long-press. Adding a kid creates an empty,
  // deletable profile, which is harmless on a family device; kid
  // deletion and renaming stay grown-ups-only, as before.
  function openGrownAtKids() {
    setGrownFrom(view);
    setGrownJumpKids(true);
    try { window.scrollTo({ top: 0 }); } catch { /* ignore */ }
  }

  function startTradeFromIdeas({ aKid, bKid, aCards, bCards }) {
    setSides({
      mine: { ...emptySide(), cards: aCards, status: aCards.length ? 'Got it!' : '' },
      theirs: { ...emptySide(), cards: bCards, status: bCards.length ? 'Got it!' : '' },
    });
    setSideKids({ mine: aKid, theirs: bKid });
    setVerdict(null);
    setStaleNote(false);
    setTradedDone(false);
    setView('trade');
    try { window.scrollTo({ top: 0 }); } catch { /* ignore */ }
  }

  async function chooseBinderKid(kidId) {
    const cand = binderPick;
    const kid = binderState.kids.find((k) => k.id === kidId);
    setBinderPick(null);
    if (!cand || !kid) return;
    const card = await addCandidateToBinder(kidId, cand);
    setBinderMsg(card ? `Added to ${kid.name}'s binder!` : "That card isn't in our card book yet.");
  }

  const setSide = (side, patch) =>
    setSides((prev) => ({ ...prev, [side]: { ...prev[side], ...patch } }));

  // A side's cards changed (add or remove, ANY path): a verdict on
  // screen was computed from the OLD contents and must never sit over
  // new totals — clear it, flag the stale note, and reset the traded
  // flag. 🤝 "We traded!" reads the sides at tap time, so logging
  // always operates on the final contents. This is the ONE append/
  // change path used pre- and post-verdict alike; the only full
  // reset remains the explicit 🔁 New trade button (resetAll).
  function cardsChanged() {
    if (verdict) { setVerdict(null); setStaleNote(true); }
    setTradedDone(false);
  }

  // Photo button: inside the native shell, use the real camera
  // plugin (better capture, no file-picker detour); in a browser —
  // or if the plugin fails for any reason — click the hidden file
  // input exactly as before. A cancelled camera is a no-op, never a
  // fallback (the kid just changed their mind).
  async function onPhotoButton(side) {
    // Guided preview first everywhere it exists — inside the shell
    // this keeps capture in-app instead of handing off to the phone's
    // camera app (or Lens). Native plugin only when the preview
    // can't run; picker is terminal.
    setCamHandoff(null);
    const path = entryPath();
    // RESET continuation: when this side already banked progress
    // (a shot that read some signals but not enough for choices),
    // the SAME button re-opens the SAME preview — with the banked
    // pieces as outline fill and the missing piece pulsing — and
    // the shot carries the banked OCR (second: true). There is no
    // separate continuation screen anymore; the button IS the way
    // back in. Native/picker paths thread the same continuation
    // flag so they merge evidence too.
    const s = sides[side];
    const cont = !!(s.progress && !(s.choices && s.choices.length) && !s.busy);
    if (path === 'preview') {
      setCamNotice(null);
      setPreview(cont
        ? { side, second: true, stage: s.progress.missing, locked: s.progress }
        : { side, second: false });
      return;
    }
    if (path === 'native') {
      // No getUserMedia here at all: stop at the handoff banner
      // (names the failure + framing guidance) instead of silently
      // opening the phone's camera.
      setCamHandoff({ side, second: cont, kind: 'native', denied: false, noApi: true });
      return;
    }
    if (cont) secondPhotoPick.current[side] = true;
    fileRefs[side].current && fileRefs[side].current.click();
  }

  function onPreviewCapture(file) {
    if (!preview) return;
    const { side, second } = preview;
    setPreview(null);
    onPhoto(side, file, second);
  }

  function onPreviewFallback() {
    if (!preview) return;
    const { side, second } = preview;
    setPreview(null);
    if (second) secondPhotoPick.current[side] = true;
    fileRefs[side].current && fileRefs[side].current.click();
  }

  // The preview itself failed (no camera, denied permission, no API):
  // in the shell, retry via the native plugin before giving up; in a
  // browser the picker is the only fallback. A plugin cancel means
  // the kid backed out — never open the picker on top. In the shell,
  // when the plugin ALSO misses, name the failure with a small
  // notice (Settings path back + picker button) instead of silently
  // dropping to the picker — a silent fallback reads as "the app is
  // broken". The notice is general robustness: a denial is only one
  // possible cause, and the text says so.
  async function onPreviewAutoFail(reason) {
    if (!preview) return;
    const { side, second } = preview;
    setPreview(null);
    const denied = reason === 'NotAllowedError' || reason === 'SecurityError';
    // Either automatic fallback opens a dumb camera, so both stop at
    // the handoff banner first — the failure gets named and the
    // framing guidance lands before the user shoots. (Previously
    // both fired immediately and silently: that is exactly how the
    // Android field report happened — system camera, tiny/far card,
    // blur-gate rejection, no idea the preview had failed.)
    if (afterPreviewAutoFail({ isNative: isNative() }) === 'native') {
      setCamHandoff({ side, second, kind: 'native', denied, noApi: false });
      return;
    }
    setCamHandoff({ side, second, kind: 'picker', denied, noApi: false });
  }

  // The handoff banner's "Open camera": fire the stored fallback now
  // that the user has seen the failure + framing guidance. A plugin
  // cancel closes with nothing opened; a plugin miss falls through
  // to the existing camNotice (Settings path back + picker button).
  async function onCamHandoffOpen() {
    if (!camHandoff) return;
    const { side, second, kind, denied } = camHandoff;
    setCamHandoff(null);
    if (kind === 'native') {
      const shot = await takeNativePhoto();
      if (shot === 'cancelled') return;
      if (shot) { onPhoto(side, shot, second); return; }
      setCamNotice({ side, second, denied });
      return;
    }
    if (second) secondPhotoPick.current[side] = true;
    fileRefs[side].current && fileRefs[side].current.click();
  }

  function onCamNoticePick() {
    if (!camNotice) return;
    const { side, second } = camNotice;
    setCamNotice(null);
    if (second) secondPhotoPick.current[side] = true;
    fileRefs[side].current && fileRefs[side].current.click();
  }

  // Second-photo capture: same camera path as the normal button, but
  // the upload carries the first photo's OCR summary so the server
  // merges both photos' evidence. Only ever offered after a hard
  // fail (see the secondPhoto flag on the retake state) — the happy
  // path never sees this button. When a progress summary exists,
  // the normal TAKE A PICTURE button already re-opens the preview
  // as a continuation (see onPhotoButton), so this button is only
  // the tilt-shot offer for hard fails.
  async function onSecondPhoto(side) {
    const path = entryPath();
    if (path === 'preview') { setCamNotice(null); setCamHandoff(null); setPreview({ side, second: true }); return; }
    if (path === 'native') {
      setCamHandoff({ side, second: true, kind: 'native', denied: false, noApi: true });
      return;
    }
    secondPhotoPick.current[side] = true;
    fileRefs[side].current && fileRefs[side].current.click();
  }

  async function onPhoto(side, file, withPrior = false) {
    if (!file) return;
    // New scan, new sequence: any response still in flight for this
    // side belongs to an older photo and must never write state again.
    // Choices are cleared NOW — previously the last photo's choices
    // stayed visible (and tappable!) during the whole re-scan, so a
    // mid-scan tap added the WRONG card before the response landed.
    const seq = ++scanSeq.current[side];
    const stale = () => scanSeq.current[side] !== seq;
    // The verdict is deliberately NOT cleared here: starting a scan
    // changes nothing yet, and a failed/stumped photo must not throw
    // away a good valuation. It clears in cardsChanged() the moment
    // a card actually lands on (or leaves) a side.
    // A fresh scan (not a continuation) clears the banked
    // progress: the new photo's own result will set it again. A
    // continuation shot keeps the last progress until its response
    // lands, so the kid never watches banked pieces blink away
    // mid-scan.
    setSide(side, { busy: true, choices: null, status: 'Looking at your card…', hint: null, secondPhoto: false, failureKind: null, ...(withPrior ? {} : { progress: null }) });
    playClip('looking', 'Looking at your card');
    try {
      // Crop-first upload (capture overhaul) + pre-submit blur gate:
      // a blurry shot fails HERE in under a second with a retry,
      // never after a 10-50s server round-trip that was doomed from
      // the start. Glare never blocks (weakly separable — see
      // lib/shotquality.js); it only earns a tilt hint later.
      const { file: upload, cropped } = await prepareForUpload(file);
      try {
        const bmp = await createImageBitmap(upload, { imageOrientation: 'from-image' }).catch(() => null)
          || await createImageBitmap(upload).catch(() => null);
        if (bmp) {
          try {
            const verdict = await assessBitmap(bmp);
            if (verdict.verdict === 'blurry') {
              if (stale()) return;
              setSide(side, { busy: false, choices: null, status: 'That photo is blurry! Hold still and try again!', hint: null, secondPhoto: false });
              playClip('unreadable', 'That photo is blurry! Hold still and try again!');
              return;
            }
          } finally {
            try { bmp.close?.(); } catch { /* ignore */ }
          }
        }
      } catch { /* pre-check never blocks on its own failure */ }
      const form = new FormData();
      form.append('photo', upload);
      if (cropped) form.append('cropped', '1');
      if (withPrior && lastOcrRef.current[side]) {
        form.append('priorOcr', JSON.stringify(lastOcrRef.current[side]));
        // RESET capture-success flags, derived from the banked
        // progress — uniform across preview, native, and picker
        // paths. corner: the next shot is a close-up of the bottom
        // number corner (the missing piece); the server runs
        // corner-first number extraction and merges with the
        // banked evidence. fast: picture+name are already banked
        // and only the number is missing, so the server skips the
        // full re-read and goes straight to targeted number-corner
        // extraction, falling back to the normal path when the
        // number does not resolve. Neither flag can create a
        // choice on its own — the confidence gate still decides.
        const p = sides[side].progress;
        if (p && p.missing === 'number') form.append('corner', '1');
        if (p && p.picture && p.name && !p.number) form.append('fast', '1');
      }
      const res = await fetch('/api/identify', { method: 'POST', body: form });
      const json = await res.json();
      if (stale()) return;
      if (json.ok && json.ocr) lastOcrRef.current[side] = json.ocr;
      // Picture choices are shown ONLY for server-gated displayable
      // candidates. A weak guess is never presented as an answer: with
      // no displayable candidate we go to the honest retake state.
      const choices = json.ok && json.confident
        ? (json.candidates || []).filter((c) => c.displayable).slice(0, 3)
        : [];
      if (choices.length) {
        // Status stays EMPTY here: the choices block renders its own
        // "Tap your card!" heading — setting it here too printed the
        // heading twice (the doubled heading in the user's screenshot).
        setSide(side, { busy: false, choices, status: '', hint: null, secondPhoto: false, progress: null, failureKind: null });
        playClip('tap', 'Tap your card!');
      } else if (json.ok && json.stumped) {
        // The photo read fine (a solid number) but the card book came
        // back empty — don't blame the kid's photo for that. No
        // banked progress here: another angle cannot fix the book.
        setSide(side, { busy: false, choices: null, status: 'That one stumped me! One more try!', hint: json.retakeHint || null, secondPhoto: json.secondPhoto === true, progress: null, failureKind: null });
        playClip('stumped', 'That one stumped me! Try again!');
      } else if (json.ok && json.progress) {
        // Banked progress: this shot read some signals but not
        // enough for a confident ID. Do NOT loop on generic retakes:
        // the next TAKE A PICTURE tap re-opens the preview with
        // the banked pieces as outline fill and the missing
        // piece's segment pulsing, and the moment the banked
        // signals satisfy the existing gate the choices branch above
        // fires on its own — no extra tap. The second-photo
        // button is suppressed while progress is banked (the
        // continuation shot IS the second shot, with segment
        // guidance). The grown-ups hint line stays: the outline
        // is the kid's signal, the hint is the grown-ups'
        // explanation of the same stage. Safety is untouched:
        // banked progress never creates a choice.
        setSide(side, { busy: false, choices: null, status: '', hint: json.retakeHint || null, secondPhoto: false, progress: json.progress, failureKind: json.failureKind || null });
        playClip('takeAgain', 'OK! Take the picture again');
      } else if (json.ok) {
        setSide(side, { busy: false, choices: null, status: 'I could not read that one. Flat + bright, try again!', hint: json.retakeHint || null, secondPhoto: json.secondPhoto === true, failureKind: null });
        playClip('unreadable', 'I could not read that one. Try again, flat and bright!');
      } else {
        setSide(side, { busy: false, choices: null, status: 'Something went wrong. Tap TRY AGAIN!', hint: null, secondPhoto: false, failureKind: json.failureKind || 'server' });
        playClip('wrong', 'Something went wrong. Try again!');
      }
    } catch {
      if (stale()) return;
      setSide(side, { busy: false, choices: null, status: 'Something went wrong. Tap TRY AGAIN!', secondPhoto: false, failureKind: 'network' });
      playClip('wrong', 'Something went wrong. Try again!');
    }
  }

  function pickChoice(side, cand) {
    const s = sides[side];
    if (!s.choices) return;
    setSide(side, { cards: [...s.cards, cand], choices: null, status: 'Got it!', hint: null, secondPhoto: false, progress: null });
    cardsChanged(); // append: existing cards/kid assignment stay put
    playClip('gotIt', 'Got it!');
  }

  function noneOfThese(side) {
    // The rejected choices came from this photo's evidence — it must
    // not ride along into a second-photo merge, and the banked
    // progress built from that evidence goes with it.
    lastOcrRef.current[side] = null;
    setSide(side, { choices: null, status: 'OK! Take the picture again!', hint: null, secondPhoto: false, progress: null });
    playClip('takeAgain', 'OK! Take the picture again');
  }

  function removeCard(side, idx) {
    setSide(side, { cards: sides[side].cards.filter((_, i) => i !== idx) });
    cardsChanged();
  }

  // Grown-ups-only, plain-words statement of the rule behind a
  // verdict when the fairness cushion setting is in play (in
  // percentage mode the static explainer below already says it).
  function fairnessRuleNote(band, gap) {
    if (!band || band.mode !== 'cushion') return null;
    const base = fmtCushion(band.cents);
    const eff = fmtCushion(Math.round(band.cents * band.widen));
    return band.eur
      ? `Verdict rule: your ${base} fairness cushion, widened to ${eff} because a Japanese (EUR-priced) card is in this trade. The two sides are $${gap.toFixed(2)} apart.`
      : `Verdict rule: your ${base} fairness cushion. The two sides are $${gap.toFixed(2)} apart.`;
  }

  // Kid-simple line naming the cards a verdict could NOT count
  // because the data has no price for them — shown inside the verdict
  // box so a partial-price comparison never silently treats them as
  // $0.00. (The all-unpriced case gets its own verdict kind instead.)
  function unpricedNoteText(v) {
    const bits = [];
    if (v.unpricedMine) bits.push(`${v.unpricedMine} card${v.unpricedMine > 1 ? 's' : ''} on MY side`);
    if (v.unpricedTheirs) bits.push(`${v.unpricedTheirs} card${v.unpricedTheirs > 1 ? 's' : ''} on THEIR side`);
    if (!bits.length) return null;
    const total = (v.unpricedMine || 0) + (v.unpricedTheirs || 0);
    return `No price for ${bits.join(' and ')} — we didn't count ${total > 1 ? 'them' : 'it'}!`;
  }

  async function checkTrade(mCards = sides.mine.cards, tCards = sides.theirs.cards) {
    const allCards = [...mCards, ...tCards];
    // Japanese printings are priced from Cardmarket (EUR) and converted —
    // that estimate is softer than a USD TCGplayer price, so when any
    // card in the trade is EUR-sourced the fair window widens x1.5.
    // The verdict itself comes from the ONE shared predicate
    // (lib/logic.js verdictKind), driven by the grown-ups fairness
    // setting: percentage bands or an absolute-dollar cushion.
    const eurInTrade = allCards.some((c) => c.currency === 'EUR');
    const mineTotal = mCards.reduce((sum, c) => sum + (c.price || 0), 0);
    const theirsTotal = tCards.reduce((sum, c) => sum + (c.price || 0), 0);
    const lo = Math.min(mineTotal, theirsTotal);
    const { kind, gap, band } = verdictKind(mineTotal, theirsTotal, {
      eur: eurInTrade, fairness: binderState.fairness,
    });
    // Price coverage: how many cards on each side the data actually
    // prices. Unpriced cards sum as $0 above, which used to let two
    // unpriced cards "match" at $0.00 = $0.00 and earn FAIR TRADE! —
    // when NOTHING on either side is priced there is no verdict to
    // give, only an honest "we don't know" (lib/logic.js).
    const mCov = priceCoverage(mCards);
    const tCov = priceCoverage(tCards);
    let v;
    if (tradeIsUnpriceable(mCards, tCards)) {
      v = {
        kind: 'noprices', faceIcon: 'search', big: 'NO PRICES FOUND!',
        sub: "We don't know what these cards cost yet, so we can't tell if this trade is fair.",
      };
    } else if (kind === 'fair') {
      v = { kind: 'fair', faceIcon: 'check', big: 'FAIR TRADE!', sub: 'Both sides match. Trade away!' };
      try {
        const confetti = (await import('canvas-confetti')).default;
        confetti({ particleCount: 180, spread: 80, origin: { y: 0.7 } });
      } catch { /* no confetti, no problem */ }
    } else if (kind === 'almost') {
      v = { kind: 'almost', faceIcon: 'scales', big: 'ALMOST FAIR!', sub: 'Pretty close! A little more would make it fair.' };
    } else {
      const lighterCards = mineTotal < theirsTotal ? mCards : tCards;
      const lighterName = mineTotal < theirsTotal ? 'MY side' : 'THEIR side';
      const avg = lighterCards.length ? lo / lighterCards.length : lo || 1;
      const extra = Math.max(1, Math.round(gap / (avg || 1)));
      v = {
        kind: 'notfair', faceIcon: 'x', big: 'NOT FAIR!',
        sub: `${lighterName} needs about ${extra} more card${extra > 1 ? 's' : ''} like theirs!`,
        extra, lighterName,
      };
    }
    v.mineTotal = mineTotal;
    v.theirsTotal = theirsTotal;
    v.unpricedMine = mCov.unpriced;
    v.unpricedTheirs = tCov.unpriced;
    // The cushion rule note explains a verdict derived from prices —
    // meaningless (and misleading) when there were no prices at all.
    v.ruleNote = v.kind === 'noprices' ? null : fairnessRuleNote(band, gap);
    setVerdict(v);
    setStaleNote(false);
    setTradedDone(false);
    // FAIR and ALMOST lines are fully static -> recorded clips. The
    // NOT FAIR headline is a clip too, but its detail line contains
    // the lighter side + a card count, so that part is synthesized
    // right after the clip finishes.
    if (v.kind === 'fair') {
      playClip('fair', v.big + ' ' + v.sub);
      verdictHaptic(); // native shell only; inert in a browser
    } else if (v.kind === 'almost') {
      playClip('almost', v.big + ' ' + v.sub);
    } else if (v.kind === 'noprices') {
      // No recorded clip exists for this line: playClip falls back to
      // the friendly system voice reading the on-screen words.
      playClip('noprices', v.big + ' ' + v.sub);
    } else {
      playClip('notfair', v.big).then(() => synthSpeak(v.sub));
    }
    setTimeout(() => {
      document.querySelector('.verdict')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  }

  function loadDemo() {
    setSides({
      mine: { ...emptySide(), cards: [DEMO.mine], status: 'Got it!' },
      theirs: { ...emptySide(), cards: [DEMO.theirs], status: 'Got it!' },
    });
    setVerdict(null);
    setStaleNote(false);
    playClip('demo', 'Pretend cards ready! Tap Check the Trade!');
  }

  function resetAll() {
    setSides({ mine: emptySide(), theirs: emptySide() });
    setVerdict(null);
    setStaleNote(false);
    playClip('allClear', 'All clear! Take a picture!');
  }

  async function manualSearch() {
    setManual((m) => ({ ...m, busy: true, results: [] }));
    try {
      const qs = new URLSearchParams();
      if (manual.name) qs.set('name', manual.name);
      if (manual.number) qs.set('number', manual.number);
      const res = await fetch('/api/identify?' + qs.toString());
      const json = await res.json();
      setManual((m) => ({ ...m, busy: false, results: json.candidates || [] }));
    } catch {
      setManual((m) => ({ ...m, busy: false, results: [] }));
    }
  }

  function manualAdd(cand) {
    const side = manual.side;
    setSide(side, { cards: [...sides[side].cards, cand] });
    cardsChanged();
  }

  // ---- Phase 3: auto-balance ("MAKE IT FAIR") ----
  // Derived, not stored: whenever a non-fair verdict is on screen,
  // search the LIGHT side kid's binder doubles for the best 1-3 cards
  // to close the gap. The light side's kid = the kid assigned to that
  // side, or the only kid when exactly one binder exists; otherwise
  // the button hides (we don't guess whose cards to offer).
  const balance = useMemo(() => {
    if (!verdict || verdict.kind === 'fair' || verdict.kind === 'noprices') return null;
    const light = verdict.mineTotal <= verdict.theirsTotal ? 'mine' : 'theirs';
    const kidId = sideKids[light] || (binderState.kids.length === 1 ? binderState.kids[0].id : null);
    if (!kidId) return null;
    let spares = spareCopies(allLists[kidId] || []);
    const used = {};
    for (const c of sides[light].cards) if (c.ref) used[c.ref] = (used[c.ref] || 0) + 1;
    spares = spares.filter((s) => {
      if (used[s.ref] > 0) { used[s.ref] -= 1; return false; }
      return true;
    });
    if (!spares.length) return null;
    const eur = [...sides.mine.cards, ...sides.theirs.cards].some((c) => c.currency === 'EUR');
    // Same shared predicate as the verdict: in percentage mode the
    // in-band test is the (possibly EUR-widened) ratio; in cushion
    // mode it is the absolute-dollar fairMax.
    const fb = fairnessBand({
      hi: Math.max(verdict.mineTotal, verdict.theirsTotal), eur,
    }, binderState.fairness);
    const res = autoBalance({
      hiTotal: Math.max(verdict.mineTotal, verdict.theirsTotal),
      loTotal: Math.min(verdict.mineTotal, verdict.theirsTotal),
      spares,
      band: fb.fairRatio != null ? fb.fairRatio : FAIR_BAND,
      absBand: fb.mode === 'cushion' ? fb.fairMax : null,
    });
    if (!res) return null;
    return { ...res, light, kid: binderState.kids.find((k) => k.id === kidId) || null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdict, sides, sideKids, allLists, binderState.fairness]);

  function applyBalance() {
    if (!balance || !verdict) return;
    const add = balance.cards.map((x) => x.card);
    const m = balance.light === 'mine' ? [...sides.mine.cards, ...add] : sides.mine.cards;
    const t = balance.light === 'theirs' ? [...sides.theirs.cards, ...add] : sides.theirs.cards;
    setSides({ mine: { ...sides.mine, cards: m }, theirs: { ...sides.theirs, cards: t } });
    checkTrade(m, t);
  }

  // ---- Phase 3: "We traded!" — log the fair trade; optionally move
  // the cards between the two assigned kids' binders (explicit tap,
  // never silent). Scanned cards resolve to catalog refs first; any
  // card that can't be resolved is logged but not moved.
  async function weTraded(move) {
    const aKid = sideKids.mine;
    const bKid = sideKids.theirs;
    const refsOf = async (cards) => {
      const refs = [];
      for (const c of cards) {
        const r = await resolveCandidateRef(c);
        if (r) refs.push(r.ref);
      }
      return refs;
    };
    const aRefs = await refsOf(sides.mine.cards);
    const bRefs = await refsOf(sides.theirs.cards);
    store.logTrade({ aKid, bKid, aRefs, bRefs });
    if (move && aKid && bKid && aKid !== bKid) {
      store.applyTradeMove(aKid, bKid, aRefs);
      store.applyTradeMove(bKid, aKid, bRefs);
    }
    setTradedDone(true);
  }

  const bothReady = sides.mine.cards.length > 0 && sides.theirs.cards.length > 0;

  // Grown-ups screen context: the trade-only blocks inside it (the
  // "What the app found" price-compare table and the manual search)
  // render only when the grown-ups screen was entered FROM the trade
  // view (grownFrom === 'trade'). Entering from the binder keeps them
  // out — they report on a trade the user isn't looking at, and
  // manual search even ADDS cards to a trade side. ParentLayer (Kids
  // & binders, Parent view, Fairness cushion) shows either way, as
  // does the price-provenance note: binder screens show prices from
  // the same catalog, so it explains those numbers too.
  const grownOpen = grownFrom !== null;
  const grownTradeCtx = grownFrom === 'trade';

  // "Add a kid" shortcut landing: after the grown-ups screen mounts,
  // scroll Kids & binders into view so the add form is right there.
  useEffect(() => {
    if (!grownOpen || !grownJumpKids) return;
    const t = setTimeout(() => {
      const el = document.getElementById('kids-binders');
      if (el) el.scrollIntoView({ block: 'start' });
      setGrownJumpKids(false);
    }, 80);
    return () => clearTimeout(t);
  }, [grownOpen, grownJumpKids]);

  const Panel = ({ side, label, cls }) => {
    const s = sides[side];
    // The panel's Total line: the SAME reduction checkTrade runs on
    // this side's cards (sum of (c.price || 0)) — one summation path,
    // so the number a parent sees here always matches the verdict.
    const sideTotal = s.cards.reduce((sum, c) => sum + (c.price || 0), 0);
    const sideKid = binderState.kids.find((k) => k.id === sideKids[side]) || null;
    const usedCounts = {};
    for (const c of s.cards) if (c.ref) usedCounts[c.ref] = (usedCounts[c.ref] || 0) + 1;
    return (
      <section className={`panel ${cls}`}>
        <h2>{label}</h2>
        {binderState.kids.length > 0 && (
          <div className="sideKidRow">
            <span className="sideKidLabel">Who?</span>
            {binderState.kids.map((k) => (
              <button
                key={k.id}
                className={`sideKidBtn${sideKids[side] === k.id ? ' sel' : ''}`}
                style={{ borderColor: k.color }}
                onClick={() => setSideKids((prev) => ({ ...prev, [side]: prev[side] === k.id ? null : k.id }))}
              >{k.emoji}</button>
            ))}
            {sideKid && (
              <button className="pickerBtn" onClick={() => setPickerSide(side)}><IconBinder size={18} /> PICK FROM BINDER</button>
            )}
          </div>
        )}
        <input
          ref={fileRefs[side]}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => { const second = secondPhotoPick.current[side]; secondPhotoPick.current[side] = false; onPhoto(side, e.target.files && e.target.files[0], second); e.target.value = ''; }}
        />
        <button className="photoBtn" disabled={s.busy} onClick={() => onPhotoButton(side)}>
          {s.busy ? 'LOOKING…' : s.cards.length
            ? <><IconPlus size={30} /> ADD A CARD</>
            : <><IconCamera size={30} /> TAKE A PICTURE</>}
        </button>
        <div className="status">{s.status}</div>
        {s.hint ? <div className="retakeHint">{s.hint}</div> : null}
        {/* RESET: no separate ring screen, no "Next picture" button.
            When progress is banked, the TAKE A PICTURE button above
            re-opens the preview with the banked pieces as outline
            fill and the missing piece's segment pulsing (see
            onPhotoButton); the moment the banked signals satisfy
            the gate, choices appear on their own. */}
        {s.secondPhoto && !s.progress && !s.busy && !(s.choices && s.choices.length) ? (
          <button className="secondPhotoBtn" onClick={() => onSecondPhoto(side)}>
            <IconCamera size={26} /> Try a tilted photo
          </button>
        ) : null}

        {s.choices && s.choices.length > 0 && (
          <div className="choices">
            <div className="q">Tap your card!</div>
            <div className={`choiceGrid${s.choices.length === 1 ? ' one' : ''}`}>
              {s.choices.map((c, i) => (
                <button className="choiceBtn" key={c.id + '-' + i} onClick={() => pickChoice(side, c)}>
                  {c.image && (
                    <img
                      src={c.image}
                      alt={c.name}
                      onError={(e) => {
                        // A broken picture must never leave an
                        // unidentifiable choice: try the fallback art
                        // once, then drop the img and leave the name.
                        const img = e.currentTarget;
                        if (c.imageFallback && !img.dataset.fbTried) {
                          img.dataset.fbTried = '1';
                          img.src = c.imageFallback;
                        } else {
                          img.style.display = 'none';
                        }
                      }}
                    />
                  )}
                  {/* Name is ALWAYS rendered: 1,724 catalog rows carry no
                      image at all, so an image-only pill can be blank
                      with nothing for a kid to tap on purpose. */}
                  <span className="choiceName">{c.name}</span>
                </button>
              ))}
            </div>
            <button className="noneBtn" onClick={() => noneOfThese(side)}><IconX /> NONE OF THESE</button>
          </div>
        )}

        {s.cards.length > 0 && (
          <div className="thumbs">
            {s.cards.map((c, i) => {
              const priceLine = fmtPriceLine(c);
              return (
                <div className="thumbCol" key={c.id + '-' + i}>
                  <div className="thumb">
                    {c.image && <img src={c.image} alt={c.name} />}
                    <button className="removeBtn" aria-label="Remove this card from the trade" title="Remove from trade" onClick={() => removeCard(side, i)}>×</button>
                    {binderState.kids.length > 0 && (
                      <button className="addBtn" aria-label="add to binder" title="Add to a binder" onClick={() => setBinderPick(c)}><IconPlus size={16} /></button>
                    )}
                  </div>
                  {priceLine
                    ? <span className="thumbPrice">{priceLine}</span>
                    : <span className="thumbPrice none">no price</span>}
                </div>
              );
            })}
          </div>
        )}
        {s.cards.length > 0 && (
          <div className="sideTotal">Total: ${sideTotal.toFixed(2)}</div>
        )}
        {pickerSide === side && sideKid && (
          <BinderPicker
            kid={sideKid}
            usedCounts={usedCounts}
            onPick={(card) => {
              setSide(side, { cards: [...sides[side].cards, card], status: 'Got it!' });
              cardsChanged(); // binder picks append, same as photo picks
            }}
            onClose={() => setPickerSide(null)}
          />
        )}
      </section>
    );
  };

  return (
    <main>
      {camNotice ? (
        <div className="camNotice" role="status">
          <span>{camNotice.denied
            ? 'Camera is blocked — allow Camera in Settings → FairSwap → Camera, or pick a photo instead.'
            : 'Camera didn\u2019t open — check Settings → FairSwap → Camera, or pick a photo instead.'}</span>
          <button onClick={onCamNoticePick}>Pick a photo</button>
          <button className="camNoticeX" onClick={() => setCamNotice(null)} aria-label="Dismiss">✕</button>
        </div>
      ) : null}
      {camHandoff ? (
        <div className="camNotice camHandoff" role="alertdialog" aria-label="Camera handoff">
          <span>{handoffNotice({ denied: camHandoff.denied, noApi: camHandoff.noApi }).title}</span>
          <span>{handoffNotice({ denied: camHandoff.denied, noApi: camHandoff.noApi }).guidance}</span>
          {handoffNotice({ denied: camHandoff.denied, noApi: camHandoff.noApi }).settings
            ? <span>{handoffNotice({ denied: camHandoff.denied, noApi: camHandoff.noApi }).settings}</span>
            : null}
          <div className="camHandoffRow">
            <button onClick={onCamHandoffOpen}>Open camera</button>
            <button className="camNoticeX" onClick={() => setCamHandoff(null)} aria-label="Never mind">✕</button>
          </div>
        </div>
      ) : null}
      <h1 className="title"><IconSwap size={34} /> Card Trade Checker <IconSwap size={34} /></h1>
      <div className="steps">
        <span><IconCamera size={19} /> Take a picture</span><span><IconCards size={19} /> Tap your card</span><span><IconScales size={19} /> Check!</span>
      </div>

      {!grownOpen && <KidBar state={binderState} view={view} go={go} onNav={navGo} onAddKid={openGrownAtKids} />}
      {!grownOpen && (
        <div className="grownEntryRow">
          <button
            className="grownEntryBtn"
            onPointerDown={grownPressStart}
            onPointerUp={grownPressEnd}
            onPointerLeave={grownPressCancel}
            onPointerCancel={grownPressCancel}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span className="grownMain"><IconLock size={16} /> Grown-ups</span>
            <span className="grownSub">Hold to open</span>
          </button>
          {grownHint && <div className="grownHint">Hold to open — grown-ups only</div>}
        </div>
      )}
      {binderState.kids.length === 0 && !grownOpen && (
        <div className="hintBar">Grown-ups: press and HOLD the Grown-ups button above to add your kids and unlock binders, trade ideas and badges!</div>
      )}
      {binderMsg && <div className="binderMsg">{binderMsg}</div>}
      {importOffer && !grownOpen && (
        <div className="importBanner">
          <div><IconBinder size={20} /> <strong>{importOffer.kid || 'A friend'}</strong> shared a binder: {importOffer.entries.reduce((a, e) => a + e.qty, 0)} cards!</div>
          <div className="importRow">
            <span>Add to:</span>
            {binderState.kids.map((k) => (
              <button key={k.id} className="goBtnSmall" onClick={() => {
                store.importBinder(k.id, importOffer.entries);
                setImportOffer(null);
                setBinderMsg(`Binder added to ${k.name}!`);
              }}>{k.emoji} {k.name}</button>
            ))}
            <button className="goBtnSmall" onClick={() => {
              const k = store.addKid(importOffer.kid || 'New kid');
              store.importBinder(k.id, importOffer.entries);
              setImportOffer(null);
              setBinderMsg(`Binder added for ${k.name}!`);
            }}><IconPlus size={17} /> New kid{importOffer.kid ? ` (${importOffer.kid})` : ''}</button>
            <button className="goBtnSmall" onClick={() => setImportOffer(null)}>No thanks</button>
          </div>
        </div>
      )}

      {!grownOpen && view === 'binder' && <BinderHome kid={activeKid} go={go} kidCount={binderState.kids.length} />}
      {!grownOpen && view === 'set' && <SetPage kid={activeKid} setKey={setKey} go={go} />}
      {!grownOpen && view === 'scan' && <ScanSession kid={activeKid} go={go} prepareForUpload={prepareForUpload} playClip={playClip} />}
      {!grownOpen && view === 'ideas' && <IdeasScreen go={go} onStartTrade={startTradeFromIdeas} />}
      {!grownOpen && view === 'profile' && <ProfileScreen kid={activeKid} go={go} />}

      {!grownOpen && view === 'trade' && (
      <>
      <div className="panels">
        <Panel side="mine" label={<><span className="panelDot mineDot" /> MY CARD</>} cls="mine" />
        <Panel side="theirs" label={<><span className="panelDot theirsDot" /> THEIR CARD</>} cls="theirs" />
      </div>

      <div className="demoRow">
        <button className="demoBtn" onClick={loadDemo}><IconDice size={20} /> Pretend cards</button>
      </div>

      {staleNote && !verdict && (
        <div className="staleNote"><IconRefresh size={20} /> Cards changed! Tap CHECK THE TRADE to get the new answer!</div>
      )}

      <div className="checkWrap">
        <button className="checkBtn" disabled={!bothReady} onClick={() => checkTrade()}>
          <IconScales size={38} /> CHECK THE TRADE
        </button>
      </div>

      {verdict && (
        <div className={`verdict ${verdict.kind}`}>
          <div className="face">
            {verdict.faceIcon === 'check' && <IconCheck size={72} />}
            {verdict.faceIcon === 'scales' && <IconScales size={72} />}
            {verdict.faceIcon === 'x' && <IconX size={72} />}
            {verdict.faceIcon === 'search' && <IconSearch size={72} />}
          </div>
          <div className="big">{verdict.big}</div>
          <div className="sub">{verdict.sub}</div>
          {verdict.kind !== 'noprices' && unpricedNoteText(verdict) && (
            <div className="unpricedNote">{unpricedNoteText(verdict)}</div>
          )}
          {verdict.kind !== 'fair' && balance && (
            <div className="balanceBox">
              <div className="balanceHead"><IconScales size={25} /> MAKE IT FAIR{balance.kid ? ` — ${balance.kid.emoji} ${balance.kid.name}'s doubles` : ''}</div>
              <div className="balanceCards">
                {balance.cards.map((x, i) => (
                  <span key={i} className="balanceCard">
                    {x.card.image || x.card.thumb ? <img src={x.card.thumb || x.card.image} alt={x.card.name} /> : x.card.name}
                  </span>
                ))}
              </div>
              <div className="balanceNote">
                {balance.landsInBand
                  ? 'Add these to make it fair!'
                  : 'This is the closest we can get — it still won\'t be quite fair.'}
              </div>
              <button className="balanceBtn" onClick={applyBalance}><IconPlus /> ADD THESE!</button>
            </div>
          )}
          {verdict.kind === 'fair' && !tradedDone && (
            <div className="tradedRow">
              <button className="tradedBtn" onClick={() => weTraded(false)}><IconHandshake /> We traded!</button>
              {sideKids.mine && sideKids.theirs && sideKids.mine !== sideKids.theirs && (
                <button className="tradedBtn move" onClick={() => weTraded(true)}><IconSwap size={20} /> We traded — move the cards between binders too</button>
              )}
            </div>
          )}
          {verdict.kind === 'fair' && tradedDone && <div className="tradedDone"><IconStar size={22} /> Counted! Nice trading!</div>}
          <div className="addMoreRow">
            <span>Not done yet? Add more cards — nothing here is cleared:</span>
            <button className="againBtn addMore" onClick={() => fileRefs.mine.current && fileRefs.mine.current.click()}><IconPlus size={20} /> MY side</button>
            <button className="againBtn addMore" onClick={() => fileRefs.theirs.current && fileRefs.theirs.current.click()}><IconPlus size={20} /> THEIR side</button>
          </div>
          <button className="againBtn" onClick={resetAll}><IconRefresh size={22} /> New trade</button>
        </div>
      )}
      </>
      )}

      {binderPick && (
        <div className="pickerOverlay">
          <div className="pickerSheet">
            <h3><IconBinder size={22} /> Add “{binderPick.name}” to whose binder?</h3>
            <KidSwitcher kids={binderState.kids} value={null} onChange={chooseBinderKid} big />
            <button className="againBtn" onClick={() => setBinderPick(null)}>Cancel</button>
          </div>
        </div>
      )}

      {grownOpen && (
        <div className="grownScreen">
          <button className="backBtn" onClick={() => setGrownFrom(null)}><IconBack size={19} /> Back</button>
          <h2 className="screenTitle"><IconLock /> Grown-ups</h2>
          <div className="grownBox">
            {grownTradeCtx && (
            <>
            <strong>What the app found</strong>
            <table>
              <thead><tr><th>Side</th><th>Card</th><th>No.</th><th>Price</th><th></th></tr></thead>
              <tbody>
                {['mine', 'theirs'].map((side) =>
                  sides[side].cards.map((c, i) => (
                    <tr key={side + i}>
                      <td>{side === 'mine' ? 'Mine' : 'Theirs'}</td>
                      <td>{c.name} ({c.set})</td>
                      <td>{c.number}</td>
                      <td>{c.price != null ? '$' + c.price.toFixed(2) : '—'}</td>
                      <td>{binderState.kids.length > 0 && (
                        <button className="go" onClick={() => setBinderPick(c)}><IconPlus size={15} /> Binder</button>
                      )}</td>
                    </tr>
                  ))
                )}
                <tr>
                  <td colSpan={3}><strong>Totals</strong></td>
                  <td>
                    <strong>
                      ${sides.mine.cards.reduce((a, c) => a + (c.price || 0), 0).toFixed(2)}
                      {' vs '}
                      ${sides.theirs.cards.reduce((a, c) => a + (c.price || 0), 0).toFixed(2)}
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
            {grownTradeCtx && (sides.mine.failureKind || sides.theirs.failureKind) && (
              <p style={{ opacity: 0.85 }}>
                Last scan trouble (this note lives only on this screen — it is never stored or sent anywhere): {['mine', 'theirs'].filter((s) => sides[s].failureKind).map((s) => `${s === 'mine' ? 'My card' : 'Their card'} — ${sides[s].failureKind === 'deadline' ? 'took too long (the server was slow)' : sides[s].failureKind === 'network' ? 'network trouble reaching the server' : 'server error'}`).join(' · ')}
              </p>
            )}
            {['mine', 'theirs'].flatMap((side) => sides[side].cards).map((c, i) => (
              <div key={'note' + i} style={{ opacity: 0.85 }}>
                {c.proxy && (
                  <p>⚠️ {c.name} ({c.set}) #{c.number}: Japanese printing not in the card book — English twin price shown.</p>
                )}
                {c.currency === 'EUR' && c.priceEUR != null && (
                  <p>💱 {c.name} ({c.set}) #{c.number}: Japanese printing, priced from Cardmarket €{c.priceEUR.toFixed(2)} → ${c.price != null ? c.price.toFixed(2) : '—'}.</p>
                )}
              </div>
            ))}
            <div>Manual search — last resort if a photo will not read:</div>
            <div className="row">
              <input placeholder="Card name (e.g. Meowth)" value={manual.name}
                onChange={(e) => setManual({ ...manual, name: e.target.value })} />
              <input placeholder="Number (e.g. 106/094)" value={manual.number}
                onChange={(e) => setManual({ ...manual, number: e.target.value })} />
            </div>
            <div className="row">
              <select value={manual.side} onChange={(e) => setManual({ ...manual, side: e.target.value })}>
                <option value="mine">Add to MY side</option>
                <option value="theirs">Add to THEIR side</option>
              </select>
              <button className="go" disabled={manual.busy} onClick={manualSearch}>
                {manual.busy ? 'Searching…' : <><IconSearch size={16} /> Search</>}
              </button>
            </div>
            {manual.results.map((c) => (
              <div className="manualResult" key={c.id}>
                {c.image && <img src={c.image} alt={c.name} />}
                <span>{c.name} — {c.set} #{c.number} — {c.price != null ? '$' + c.price.toFixed(2) : 'no price'}</span>
                <button className="go" onClick={() => manualAdd(c)}>Add</button>
                {binderState.kids.length > 0 && (
                  <button className="go" onClick={() => setBinderPick(c)}><IconPlus size={15} /> Binder</button>
                )}
              </div>
            ))}
            </>
            )}
            <p style={{ opacity: 0.75 }}>
              Prices come from the app's own card catalog (TCGplayer market for English cards, Cardmarket trend
              converted from EUR for Japanese cards, via TCGdex data), refreshed nightly.
              Demo cards use fixed example prices.{' '}
              {normalizeFairness(binderState.fairness).mode === 'cushion' ? (
                <>Verdict: your fairness cushion is set to {fmtCushion(normalizeFairness(binderState.fairness).cents)} —
                a trade is fair when the two sides are within that much of each other, almost fair within 3x that.
                The cushion widens x1.5 when a EUR-priced (Japanese) card is part of the trade.
                Change it under Fairness cushion below.</>
              ) : (
                <>Verdict: within 15% is fair, within 40% is almost fair —
                both windows widen x1.5 when a EUR-priced (Japanese) card is part of the trade.
                You can switch to a fixed-dollar window under Fairness cushion below.</>
              )}
            </p>
            {grownTradeCtx && verdict && verdict.ruleNote && <p style={{ opacity: 0.9 }}><IconScales size={17} /> {verdict.ruleNote}</p>}
            <ParentLayer onOpenBinder={(kidId) => {
              store.setActiveKid(kidId);
              setGrownFrom(null);
              go('binder');
            }} />
          </div>
        </div>
      )}
      {preview ? (
        <CameraPreview
          stage={preview.stage || null}
          locked={preview.locked || null}
          onCapture={onPreviewCapture}
          onClose={() => setPreview(null)}
          onFallback={onPreviewFallback}
          onAutoFail={onPreviewAutoFail}
        />
      ) : null}
    </main>
  );
}
