'use client';

import { useEffect, useRef, useState } from 'react';

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

const emptySide = () => ({ cards: [], choices: null, busy: false, status: '' });

// Shrink big phone photos before upload: full-size images made the
// server OCR blow its time limit (the live 504s). Card bands are read
// from relative positions, so shrinking loses nothing geometrically —
// but the collector-number digits are tiny, so keep as much resolution
// as the time budget tolerates: 2400px max dimension at JPEG q90 (a
// fresh iPhone photo is 4032px; at 1800 the number digits were already
// marginal, and a 2400px portrait JPEG is ~1MB, far under any limit).
// EXIF orientation is requested explicitly ('from-image'): a phone
// portrait shot is stored as landscape pixels + a rotate flag, and if
// the bitmap ignores the flag the canvas bakes a SIDEWAYS photo with
// no flag left for the server to fix — every reading band then lands
// wrong. Where the option is unsupported it throws and we fall back
// to the plain call.
async function shrinkForUpload(file) {
  try {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(file);
    }
    const MAX = 2400;
    if (Math.max(bmp.width, bmp.height) <= MAX) { bmp.close?.(); return file; }
    const scale = MAX / Math.max(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (!blob) return file;
    return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

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
    return () => window.removeEventListener('pointerdown', warm);
  }, []);

  const [sides, setSides] = useState({ mine: emptySide(), theirs: emptySide() });
  const [verdict, setVerdict] = useState(null);
  const [grownOpen, setGrownOpen] = useState(false);
  const [manual, setManual] = useState({ name: '', number: '', side: 'mine', results: [], busy: false });
  const fileRefs = { mine: useRef(null), theirs: useRef(null) };

  const setSide = (side, patch) =>
    setSides((prev) => ({ ...prev, [side]: { ...prev[side], ...patch } }));

  async function onPhoto(side, file) {
    if (!file) return;
    setVerdict(null);
    setSide(side, { busy: true, status: '🔎 Looking at your card…' });
    playClip('looking', 'Looking at your card');
    try {
      const upload = await shrinkForUpload(file);
      const form = new FormData();
      form.append('photo', upload);
      const res = await fetch('/api/identify', { method: 'POST', body: form });
      const json = await res.json();
      // Picture choices are shown ONLY for server-gated displayable
      // candidates. A weak guess is never presented as an answer: with
      // no displayable candidate we go to the honest retake state.
      const choices = json.ok && json.confident
        ? (json.candidates || []).filter((c) => c.displayable).slice(0, 3)
        : [];
      if (choices.length) {
        setSide(side, { busy: false, choices, status: 'Tap your card! 👇' });
        playClip('tap', 'Tap your card!');
      } else if (json.ok && json.stumped) {
        // The photo read fine (a solid number) but the card book came
        // back empty — don't blame the kid's photo for that.
        setSide(side, { busy: false, choices: null, status: '🤔 That one stumped me! One more try!' });
        playClip('stumped', 'That one stumped me! Try again!');
      } else if (json.ok) {
        setSide(side, { busy: false, choices: null, status: '😕 I could not read that one. Flat + bright, try again!' });
        playClip('unreadable', 'I could not read that one. Try again, flat and bright!');
      } else {
        setSide(side, { busy: false, choices: null, status: '😕 Something went wrong. Tap TRY AGAIN!' });
        playClip('wrong', 'Something went wrong. Try again!');
      }
    } catch {
      setSide(side, { busy: false, choices: null, status: '😕 Something went wrong. Tap TRY AGAIN!' });
      playClip('wrong', 'Something went wrong. Try again!');
    }
  }

  function pickChoice(side, cand) {
    const s = sides[side];
    if (!s.choices) return;
    setSide(side, { cards: [...s.cards, cand], choices: null, status: '⭐ Got it!' });
    playClip('gotIt', 'Got it!');
  }

  function noneOfThese(side) {
    setSide(side, { choices: null, status: 'OK! Take the picture again 📸' });
    playClip('takeAgain', 'OK! Take the picture again');
  }

  function removeCard(side, idx) {
    setSide(side, { cards: sides[side].cards.filter((_, i) => i !== idx) });
    setVerdict(null);
  }

  async function checkTrade() {
    const allCards = [...sides.mine.cards, ...sides.theirs.cards];
    // Japanese printings are priced from Cardmarket (EUR) and converted —
    // that estimate is softer than a USD TCGplayer price, so when any
    // card in the trade is EUR-sourced the fair window widens x1.5.
    const eurInTrade = allCards.some((c) => c.currency === 'EUR');
    const fairBand = eurInTrade ? 0.15 * 1.5 : 0.15;
    const almostBand = eurInTrade ? 0.4 * 1.5 : 0.4;
    const mineTotal = sides.mine.cards.reduce((sum, c) => sum + (c.price || 0), 0);
    const theirsTotal = sides.theirs.cards.reduce((sum, c) => sum + (c.price || 0), 0);
    const hi = Math.max(mineTotal, theirsTotal);
    const lo = Math.min(mineTotal, theirsTotal);
    const diffRatio = hi > 0 ? (hi - lo) / hi : 0;
    let v;
    if (diffRatio <= fairBand) {
      v = { kind: 'fair', face: '😄', big: 'FAIR TRADE!', sub: 'Both sides match. Trade away! 🎉' };
      try {
        const confetti = (await import('canvas-confetti')).default;
        confetti({ particleCount: 180, spread: 80, origin: { y: 0.7 } });
      } catch { /* no confetti, no problem */ }
    } else if (diffRatio <= almostBand) {
      v = { kind: 'almost', face: '😐', big: 'ALMOST FAIR!', sub: 'Pretty close! A little more would make it fair.' };
    } else {
      const lighterSide = mineTotal < theirsTotal ? sides.mine : sides.theirs;
      const lighterName = mineTotal < theirsTotal ? 'MY side' : 'THEIR side';
      const avg = lighterSide.cards.length ? lo / lighterSide.cards.length : lo || 1;
      const extra = Math.max(1, Math.round((hi - lo) / (avg || 1)));
      v = {
        kind: 'notfair', face: '😟', big: 'NOT FAIR!',
        sub: `${lighterName} needs about ${extra} more card${extra > 1 ? 's' : ''} like theirs!`,
        extra, lighterName,
      };
    }
    setVerdict(v);
    // FAIR and ALMOST lines are fully static -> recorded clips. The
    // NOT FAIR headline is a clip too, but its detail line contains
    // the lighter side + a card count, so that part is synthesized
    // right after the clip finishes.
    if (v.kind === 'fair') {
      playClip('fair', v.big + ' ' + v.sub);
    } else if (v.kind === 'almost') {
      playClip('almost', v.big + ' ' + v.sub);
    } else {
      playClip('notfair', v.big).then(() => synthSpeak(v.sub));
    }
    setTimeout(() => {
      document.querySelector('.verdict')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  }

  function loadDemo() {
    setSides({
      mine: { ...emptySide(), cards: [DEMO.mine], status: '⭐ Got it!' },
      theirs: { ...emptySide(), cards: [DEMO.theirs], status: '⭐ Got it!' },
    });
    setVerdict(null);
    playClip('demo', 'Pretend cards ready! Tap Check the Trade!');
  }

  function resetAll() {
    setSides({ mine: emptySide(), theirs: emptySide() });
    setVerdict(null);
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
    setVerdict(null);
  }

  const bothReady = sides.mine.cards.length > 0 && sides.theirs.cards.length > 0;

  const Panel = ({ side, label, cls }) => {
    const s = sides[side];
    return (
      <section className={`panel ${cls}`}>
        <h2>{label}</h2>
        <input
          ref={fileRefs[side]}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => { onPhoto(side, e.target.files && e.target.files[0]); e.target.value = ''; }}
        />
        <button className="photoBtn" disabled={s.busy} onClick={() => fileRefs[side].current && fileRefs[side].current.click()}>
          📸 {s.busy ? 'LOOKING…' : 'TAKE A PICTURE'}
        </button>
        <div className="status">{s.status}</div>

        {s.choices && s.choices.length > 0 && (
          <div className="choices">
            <div className="q">Tap your card! 👇</div>
            <div className={`choiceGrid${s.choices.length === 1 ? ' one' : ''}`}>
              {s.choices.map((c, i) => (
                <button className="choiceBtn" key={c.id + '-' + i} onClick={() => pickChoice(side, c)}>
                  {c.image && <img src={c.image} alt={c.name} />}
                </button>
              ))}
            </div>
            <button className="noneBtn" onClick={() => noneOfThese(side)}>🚫 NONE OF THESE</button>
          </div>
        )}

        {s.cards.length > 0 && (
          <div className="thumbs">
            {s.cards.map((c, i) => (
              <div className="thumb" key={c.id + '-' + i}>
                {c.image && <img src={c.image} alt={c.name} />}
                <button aria-label="remove" onClick={() => removeCard(side, i)}>×</button>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  };

  return (
    <main>
      <h1 className="title">⚡ Card Trade Checker ⚡</h1>
      <div className="steps">
        <span>📸 Take a picture</span><span>👉 Tap your card</span><span>⚖️ Check!</span>
      </div>

      <div className="panels">
        <Panel side="mine" label="🔵 MY CARD" cls="mine" />
        <Panel side="theirs" label="🔴 THEIR CARD" cls="theirs" />
      </div>

      <div className="demoRow">
        <button className="demoBtn" onClick={loadDemo}>🎲 Pretend cards</button>
      </div>

      <div className="checkWrap">
        <button className="checkBtn" disabled={!bothReady} onClick={checkTrade}>
          ⚖️ CHECK THE TRADE
        </button>
      </div>

      {verdict && (
        <div className={`verdict ${verdict.kind}`}>
          <div className="face">{verdict.face}</div>
          <div className="big">{verdict.big}</div>
          <div className="sub">{verdict.sub}</div>
          <button className="againBtn" onClick={resetAll}>🔁 New trade</button>
        </div>
      )}

      <div className="grownups">
        <button onClick={() => setGrownOpen(!grownOpen)}>
          Grown-ups: card names, prices &amp; manual search {grownOpen ? '▲' : '▼'}
        </button>
        {grownOpen && (
          <div className="grownBox">
            <strong>What the app found</strong>
            <table>
              <thead><tr><th>Side</th><th>Card</th><th>No.</th><th>Price</th></tr></thead>
              <tbody>
                {['mine', 'theirs'].map((side) =>
                  sides[side].cards.map((c, i) => (
                    <tr key={side + i}>
                      <td>{side === 'mine' ? 'Mine' : 'Theirs'}</td>
                      <td>{c.name} ({c.set})</td>
                      <td>{c.number}</td>
                      <td>{c.price != null ? '$' + c.price.toFixed(2) : '—'}</td>
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
                {manual.busy ? 'Searching…' : 'Search'}
              </button>
            </div>
            {manual.results.map((c) => (
              <div className="manualResult" key={c.id}>
                {c.image && <img src={c.image} alt={c.name} />}
                <span>{c.name} — {c.set} #{c.number} — {c.price != null ? '$' + c.price.toFixed(2) : 'no price'}</span>
                <button className="go" onClick={() => manualAdd(c)}>Add</button>
              </div>
            ))}
            <p style={{ opacity: 0.75 }}>
              Prices come from the app's own card catalog (TCGplayer market for English cards, Cardmarket trend
              converted from EUR for Japanese cards, via TCGdex data), refreshed nightly.
              Demo cards use fixed example prices. Verdict: within 15% is fair, within 40% is almost fair —
              both windows widen x1.5 when a EUR-priced (Japanese) card is part of the trade.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
