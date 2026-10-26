// Live guided capture — runs in a browser AND inside the native
// shell, where getUserMedia is served by the platform WebView
// (Capacitor's Android bridge grants VIDEO_CAPTURE from the app's
// CAMERA permission; iOS WKWebView from NSCameraUsageDescription).
// The native Camera plugin is only a fallback (see app/page.js):
// its capture intent can resolve to Google Lens on some phones.
//
// What it does, kid-simple:
//   - A video preview with a card-shaped outline (63:88, the real
//     card's aspect) and two dots on the bottom edge: the whole
//     bottom edge — where the collector number lives — must sit
//     inside the outline. No text wall, no instructions to read.
//   - Auto-capture when the shot is steady, sharp, AND well-framed:
//     samples the video every ~200ms. The three dots fill
//     fractionally as steadiness points accumulate (see lib/steady.js
//     — a shaky sample dents progress, it never wipes it), but dots
//     alone never fire. Firing needs 2 consecutive firing-grade
//     frames (still + sharp), 1s since the preview started (phone
//     autofocus settles), and a card framed inside the on-screen
//     outline (lib/framing.js, outline-relative — the video is
//     shown with object-fit: cover, so the outline the user frames
//     inside is a center crop of the analyzed frame, and judging
//     the box against the full frame edge was both unsatisfiable
//     and dishonest). When the gate blocks firing, a single short
//     guidance chip names the most-blocking reason, Chase
//     check-deposit style ("Move closer", "Show all four corners",
//     "Center the card in the outline", "Needs a darker
//     background", "Tilt a little", "Hold steady") — blocked
//     firing always explains itself, and a missing box never
//     produces a 'corners' chip: the fallback hold below is what
//     fires instead. 'corners' is reserved for a card actually cut
//     off by the frame edge; a fully visible card that merely
//     fails to cover the outline gets the alignment hint.
//   - Zonal outlines (see lib/zones.js) anchored to the DETECTED
//     card box in display pixels — never to the fixed guide, whose
//     bottom zone landed on the table whenever the card rode high
//     in the outline. No box -> no zones rendered at all.
//   - Focus: continuous autofocus is requested up front
//     (focusMode 'continuous' in constraints + reaffirmed on the
//     track), and tapping the preview shows a native-style focus
//     reticle at the tap point while attempting a refocus cycle
//     (continuous -> manual -> continuous). Honest limit: webviews
//     expose no true focus-point API, so on iOS WKWebView the
//     platform may ignore focusMode entirely — the tap then only
//     reaffirms continuous AF, and the reticle still confirms the
//     tap. Either way the preview, gate, chips, zones, and firing
//     rule are untouched by a focus attempt.
//   - Fallback hold: a box-detector miss must never permanently
//     veto auto-capture. A long unbroken run of firing-grade
//     frames (~2.6s) fires even without a framed box.
//   - A manual shutter for kids who don't want to wait, and a
//     "photo picker instead" escape that always works.
//   - A soft shine chip when the frame looks very washed out
//     (advisory only — single-frame glare detection is weakly
//     separable, so it never blocks anything).
//   - Progressive capture (optional `stage` prop): when the previous
//     shot banked everything except one piece, the outline
//     highlights just that piece — for the 'number' stage the two
//     bottom-edge dots grow and pulse, wordlessly pointing at the
//     collector-number corner. Other stages leave the outline
//     unchanged (the shine chip already covers glare live).
//
// Any failure (no camera, denied permission, getUserMedia missing)
// calls onAutoFail() when provided (the parent retries via the
// native plugin in the shell, else the picker) or onFallback() —
// the preview can never strand a kid without a way to take a photo.
// The "Use photo picker instead" button always calls onFallback().

'use client';

import { useEffect, useRef, useState } from 'react';
import { measureShot } from '../lib/shotquality.js';
import { steadyStep, steadyDotFill, SHARP_MIN, isFireSample, goodStreakStep, shouldFire, shouldFireFallback, FIRE_MIN_MS } from '../lib/steady.js';
import { analyzeCardPixels } from '../lib/capture.js';
import { assessFraming, luminanceContrast, guidanceFor, coverOutlineRect, coverBoxDisplayRect } from '../lib/framing.js';
import { ZONES, assessZoneQuality, deriveZoneDisplay, zoneDisplayRects } from '../lib/zones.js';
import { IconCamera, IconX } from './icons';

const SAMPLE_MS = 200;

function sampleFrame(video, canvas) {
  const W = 160;
  const scale = W / video.videoWidth;
  canvas.width = W;
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height, channels: 4 };
}

function frameDiff(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return Infinity;
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    sum += Math.abs(a.data[i * 4] - b.data[i * 4])
      + Math.abs(a.data[i * 4 + 1] - b.data[i * 4 + 1])
      + Math.abs(a.data[i * 4 + 2] - b.data[i * 4 + 2]);
  }
  return sum / (n * 3);
}

export default function CameraPreview({ stage, locked, onCapture, onClose, onFallback, onAutoFail }) {
  const videoRef = useRef(null);
  const outlineRef = useRef(null);
  const streamRef = useRef(null);
  const sampleRef = useRef(null);
  const prevRef = useRef(null);
  const progressRef = useRef(0);
  const goodStreakRef = useRef(0);
  const startRef = useRef(0);
  const bestRef = useRef(null); // sharpest recent full-res canvas
  const doneRef = useRef(false);
  const [guidance, setGuidance] = useState(null);
  const [steadyProgress, setSteadyProgress] = useState(0);
  // Live zonal quality, refreshed with every sample: null until a
  // card box exists to measure inside. Display-only — it never
  // fires, never locks, never touches the gate.
  const [zoneQuality, setZoneQuality] = useState(null);
  // Zone anchor: the detected card box + the guide outline, both in
  // display pixels relative to the video element (which fills the
  // preview container exactly, so these double as container
  // coordinates). Null until a box exists: zones then hide rather
  // than sit in the wrong place — guide-anchored zones put the
  // number zone on the table whenever the card rode high in the
  // guide (Iron Leaves, iPhone, 2026-10-25).
  const [zoneAnchor, setZoneAnchor] = useState(null);
  // Tap-to-focus reticle: { x, y, id } in preview-container pixels,
  // or null. Rendered only; the refocus attempt lives in focusAt.
  const [focusRing, setFocusRing] = useState(null);
  const focusTimerRef = useRef(null);
  // Set the instant a shot is taken, BEFORE any async work: the video
  // element is swapped for an uploading state synchronously, so a
  // stream-less video can never sit on screen — on Android WebView
  // that paints its grey play glyph over the frozen frame, which
  // flashed at the capture→upload transition.
  const [captured, setCaptured] = useState(false);

  useEffect(() => {
    let timer = null;
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('no-camera-api');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          // focusMode 'continuous' is requested up front; platforms
          // that don't support it ignore the unknown constraint,
          // and the track-level reaffirm below is equally guarded.
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, focusMode: 'continuous' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        try {
          const track = stream.getVideoTracks()[0];
          if (track && typeof track.applyConstraints === 'function') {
            const p = track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
        } catch { /* continuous AF stays a best-effort request */ }
        startRef.current = Date.now();
        timer = setInterval(() => {
          const v = videoRef.current;
          if (!v || v.videoWidth === 0 || doneRef.current) return;
          try {
            const canvas = sampleRef.current || (sampleRef.current = document.createElement('canvas'));
            const sample = sampleFrame(v, canvas);
            const m = measureShot(sample);
            const diff = frameDiff(prevRef.current, sample);
            prevRef.current = sample;
            // Dots: points only, never a trigger (see lib/steady.js).
            progressRef.current = steadyStep(progressRef.current, { diff, sharpness: m.sharpness });
            setSteadyProgress(progressRef.current);
            // Firing streak: any non-fire sample resets it.
            const fireSample = isFireSample({ diff, sharpness: m.sharpness });
            goodStreakRef.current = goodStreakStep(goodStreakRef.current, fireSample);
            // Framing gate: run the card-box detector on this sample
            // (160px wide is plenty for the chroma profiles) and
            // check the box against the OUTLINE the user sees — the
            // outline div's real on-screen rect, mapped through the
            // object-fit: cover transform into video fractions.
            // Judging the box against the full frame edge was the
            // bug: a card filling the outline is small in
            // full-frame fractions, and a missing box was
            // misreported as 'corners'. When the outline rect is
            // unavailable, assessFraming falls back to the legacy
            // frame-relative path.
            const box = analyzeCardPixels(sample.data, sample.width, sample.height, v.videoWidth, v.videoHeight);
            // Zonal live quality, measured inside the detected box:
            // which zones look readable right now (never a lock —
            // locks come only from the server, via `locked`).
            setZoneQuality(assessZoneQuality(sample.data, sample.width, sample.height, box));
            const lum = box ? luminanceContrast(sample.data, sample.width, sample.height, box) : null;
            let outline = null;
            let anchor = null;
            try {
              const vRect = v.getBoundingClientRect();
              const oEl = outlineRef.current;
              let guideDisplay = null;
              if (oEl && v.videoWidth && v.videoHeight) {
                const oRect = oEl.getBoundingClientRect();
                outline = coverOutlineRect({
                  videoRect: vRect,
                  outlineRect: oRect,
                  videoW: v.videoWidth, videoH: v.videoHeight,
                });
                guideDisplay = { left: oRect.left - vRect.left, top: oRect.top - vRect.top, width: oRect.width, height: oRect.height };
              }
              // Zone anchor: the detected box mapped to display
              // pixels (rows-mode boxes keep their mode so the
              // zone helper can fall back to the guide for their
              // unknown horizontal span). No box -> null -> zones
              // hidden, never drawn in the wrong place.
              if (box) {
                anchor = {
                  box: { ...coverBoxDisplayRect({ videoRect: vRect, videoW: v.videoWidth, videoH: v.videoHeight, box }), mode: box.mode },
                  guide: guideDisplay,
                };
              }
            } catch { /* outline stays null -> legacy framing; anchor stays null -> zones hidden */ }
            setZoneAnchor(anchor);
            const framing = assessFraming(box, lum, outline);
            const elapsedMs = Date.now() - startRef.current;
            setGuidance(guidanceFor({ framing, glareFrac: m.glareFrac, lastGood: fireSample, elapsedMs, minMs: FIRE_MIN_MS }));
            // Keep the sharpest recent full-res frame for auto-capture.
            if (m.sharpness >= SHARP_MIN) {
              const full = bestRef.current || (bestRef.current = document.createElement('canvas'));
              full.width = v.videoWidth;
              full.height = v.videoHeight;
              full.getContext('2d').drawImage(v, 0, 0);
            }
            if (shouldFire({ goodStreak: goodStreakRef.current, elapsedMs, framed: framing.framed })
              || shouldFireFallback({ goodStreak: goodStreakRef.current, elapsedMs })) {
              doneRef.current = true;
              captureFromBest();
            }
          } catch { /* a bad sample never breaks the preview */ }
        }, SAMPLE_MS);
      } catch (err) {
        // No camera / denied / no API: never strand the kid — the
        // parent retries via the native plugin in the shell, else
        // opens the file picker. The failure reason rides along so
        // the parent can name a denial (Settings path back) instead
        // of failing silently.
        if (!cancelled) (onAutoFail || onFallback)(err && err.name ? err.name : 'error');
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      const v = videoRef.current;
      if (v) v.srcObject = null;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function canvasToFile(canvas) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) { resolve(null); return; }
        resolve(new File([blob], 'card-crop.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.95);
    });
  }

  async function captureFromBest() {
    const v = videoRef.current;
    const best = bestRef.current;
    // Grab the frame synchronously first: once the stream stops the
    // live video is gone, so the canvas must already hold the shot.
    let canvas = null;
    if (best && best.width) canvas = best;
    else if (v && v.videoWidth) {
      canvas = document.createElement('canvas');
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      canvas.getContext('2d').drawImage(v, 0, 0);
    }
    // Swap the video for the uploading state NOW, before the async
    // blob conversion — a stream-less <video> left mounted is what
    // flashes Android WebView's grey play glyph.
    setCaptured(true);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (v) v.srcObject = null;
    if (!canvas) { onFallback(); return; }
    const file = await canvasToFile(canvas);
    if (file) onCapture(file);
    else onFallback();
  }

  async function snapNow() {
    if (doneRef.current) return;
    doneRef.current = true;
    await captureFromBest();
  }

  // Tap-to-focus: show a native-style reticle at the tap point and
  // attempt a refocus cycle on the video track. Webviews expose no
  // true focus-point API, so this is honest about its limits: the
  // toggle (continuous -> manual -> continuous) is attempted where
  // the platform honors focusMode, and where it doesn't, the tap
  // reaffirms continuous AF at best. The reticle always confirms
  // the tap, and the attempt never touches the gate, chips, zones,
  // or firing rule — it only nudges the camera's focus state.
  async function focusAt(e) {
    const v = videoRef.current;
    if (!v) return;
    const rect = v.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    setFocusRing({ x, y, id: Date.now() });
    focusTimerRef.current = setTimeout(() => setFocusRing(null), 1600);
    try {
      const track = streamRef.current ? streamRef.current.getVideoTracks()[0] : null;
      if (!track || typeof track.applyConstraints !== 'function') return;
      try {
        await track.applyConstraints({ advanced: [{ focusMode: 'manual' }] });
        await new Promise((r) => setTimeout(r, 300));
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      } catch {
        try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* platform honors no focus API */ }
      }
    } catch { /* a focus attempt never breaks the preview */ }
  }

  if (captured) {
    return (
      <div className="camPreview">
        <div className="camUploading">Sending…</div>
      </div>
    );
  }

  // Zonal display: server locks (gold) + live quality (bright =
  // looks readable, sparkling = still needs work) + percent of
  // zones locked. Computed every render from the latest sample.
  const zoneDisplay = deriveZoneDisplay({ progress: locked || null, quality: zoneQuality });
  // Zone geometry: pixel rects anchored to the DETECTED card box,
  // not the fixed guide — null when no box exists, in which case
  // no zones render at all (a zone in the wrong place is worse
  // than no zone). The corner dots stay on the guide: they are the
  // target the kid frames into, not annotations on the card.
  const zoneRects = zoneAnchor ? zoneDisplayRects(zoneAnchor) : null;

  return (
    <div className="camPreview">
      <video ref={videoRef} playsInline muted autoPlay className="camVideo" onClick={focusAt} />
      <div className="camPercent" aria-hidden="true">{zoneDisplay.percent}%</div>
      <div ref={outlineRef} className={`camOutline${stage === 'number' ? ' numberStage' : ''}`}>
        <span className="camCornerDot camDotBL" />
        <span className="camCornerDot camDotBR" />
      </div>
      {zoneRects ? (
        <div className="camZoneLayer" aria-hidden="true">
          {ZONES.map((z) => {
            const dz = zoneDisplay.zones[z.key];
            const r = zoneRects[z.key];
            return (
              <span
                key={z.key}
                className={`camZone camZone${z.key} ${dz.state}${dz.pulse ? ' camZonePulse' : ''}`}
                style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
              />
            );
          })}
        </div>
      ) : null}
      {focusRing ? (
        <span key={focusRing.id} className="camFocusRing" aria-hidden="true" style={{ left: focusRing.x, top: focusRing.y }} />
      ) : null}
      {guidance ? <div className="camChip">{guidance}</div> : null}
      <div className="camBar">
        <button className="camShutter" onClick={snapNow} aria-label="Take a picture">
          <IconCamera size={30} /> SNAP
        </button>
        <button className="camClose" onClick={onClose} aria-label="Close camera">
          <IconX size={22} />
        </button>
      </div>
      <button className="camPicker" onClick={onFallback}>Use photo picker instead</button>
      <div className="camSteady" aria-hidden="true">
        {[0, 1, 2].map((i) => {
          const fill = steadyDotFill(steadyProgress, i);
          return (
            <span
              key={i}
              style={fill > 0 ? { background: `linear-gradient(to top, #ffcb05 ${fill * 100}%, rgba(255, 255, 255, 0.35) ${fill * 100}%)` } : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
