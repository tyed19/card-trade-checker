// The ONE WebView capture component. It replaces app/camera-preview.js
// wholesale (deleted in the 2026-10-31 rewrite): same screen the kid
// sees — video, one card outline, SNAP, X, a picker escape, one
// guidance line only when blocked — but a single firing rule shared
// with the native screen (lib/capture-fire.js) instead of the layered
// accumulation it supersedes.
//
// Differences from the deleted preview, all deliberate:
//   - Samples at 320px wide, the scale SHARP_MIN = 400 was calibrated
//     at (lib/shotquality.js). The old preview sampled at 160px.
//   - NO frame-difference term anywhere. Measured 2026-10-31: a mere
//     1px shift between consecutive 160px frames scores a mean diff
//     of 8.2–8.4, above the old FIRE bar of 7 — a handheld phone
//     could never hold the streak, which is why Android never
//     auto-captured. Motion blur already shows up as lost sharpness,
//     so the sharp-frame streak is the stillness proxy.
//   - NO outline-coverage gate: the outline is a framing target for
//     the user, not a gate. Box presence feeds the backstop; a
//     missing box never produces an instruction (it reports 'no-box'
//     to the grown-ups diagnostic instead of a guessed chip).
//   - NO failure path to another camera: getUserMedia failure calls
//     onError(reason) and the PARENT shows an error screen with
//     Retry + a real photo picker. This component never opens the
//     system camera, directly or via a capture-attribute input.
//   - Block reasons are reported via onBlockReason (parent throttles
//     them into the grown-ups diagnostic line, in-memory only) so
//     the next "never fires" report arrives with a reason.
//   - Tap-to-focus reticle + continuous-AF request are kept: they are
//     isolated, they never touch the firing rule, and they help
//     Android focus. Honest limit (unchanged): webviews expose no
//     true focus-point API, so on iOS WKWebView the platform may
//     ignore focusMode — the tap then only reaffirms continuous AF.
//
// Props: stage, locked (reset outline language, lib/outline.js),
// onCapture(file), onClose(), onPickPhoto() (REAL photo picker — the
// parent's file input no longer carries capture="environment"),
// onError(reasonName), onBlockReason(blockedOrNull).

'use client';

import { useEffect, useRef, useState } from 'react';
import { measureShot } from '../lib/shotquality.js';
import { decideFire, initialFireState, guidanceLineFor, SHARP_MIN } from '../lib/capture-fire.js';
import { analyzeCardPixels } from '../lib/capture.js';
import { outlineSegments, outlineClasses } from '../lib/outline.js';
import { IconCamera, IconX } from './icons';

const SAMPLE_MS = 200;
const SAMPLE_W = 320;

function sampleFrame(video, canvas) {
  const scale = SAMPLE_W / video.videoWidth;
  canvas.width = SAMPLE_W;
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height, channels: 4 };
}

export default function CaptureScreen({ stage, locked, onCapture, onClose, onPickPhoto, onError, onBlockReason }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const sampleRef = useRef(null);
  const fireRef = useRef(null);
  const bestRef = useRef(null); // sharpest recent full-res canvas
  const doneRef = useRef(false);
  const lastBlockedRef = useRef(undefined);
  const [guidance, setGuidance] = useState(null);
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
    fireRef.current = initialFireState(Date.now());
    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('no-camera-api');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
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
        // The fire state's startedMs is the preview start (set above
        // at effect time, before the async camera grant) so the 1s
        // autofocus settle is measured from when the kid opened the
        // screen, not from when permission resolved.
        timer = setInterval(() => {
          const v = videoRef.current;
          if (!v || v.videoWidth === 0 || doneRef.current) return;
          try {
            const canvas = sampleRef.current || (sampleRef.current = document.createElement('canvas'));
            const sample = sampleFrame(v, canvas);
            const m = measureShot(sample);
            // Box presence only — no coverage math, no outline
            // mapping: the outline is a target, not a gate. A null
            // box (holo fragmentation, glare) reports 'no-box' to
            // diagnostics and shows NO chip; the sharp-streak hold
            // below is what fires instead.
            const box = analyzeCardPixels(sample.data, sample.width, sample.height, v.videoWidth, v.videoHeight);
            const boxSmall = !!(box && box.h < 0.35);
            const { state, fire, blocked } = decideFire(
              fireRef.current,
              { sharpness: m.sharpness, hasBox: !!box, stableName: null, stableNumber: null, expectsText: false },
              Date.now(),
            );
            fireRef.current = state;
            if (blocked !== lastBlockedRef.current) {
              lastBlockedRef.current = blocked;
              try { onBlockReason && onBlockReason(blocked); } catch { /* diagnostics never break capture */ }
            }
            setGuidance(guidanceLineFor({ blocked, boxSmall }));
            // Keep the sharpest recent full-res frame for auto-capture.
            if (m.sharpness >= SHARP_MIN) {
              const full = bestRef.current || (bestRef.current = document.createElement('canvas'));
              full.width = v.videoWidth;
              full.height = v.videoHeight;
              full.getContext('2d').drawImage(v, 0, 0);
            }
            if (fire) {
              doneRef.current = true;
              captureFromBest();
            }
          } catch { /* a bad sample never breaks the preview */ }
        }, SAMPLE_MS);
      } catch (err) {
        // No camera / denied / no API: report UP, never sideways to
        // another camera. The parent renders the error screen
        // (Retry + real photo picker) — this component opens nothing.
        if (!cancelled && onError) onError(err && err.name ? err.name : 'error');
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
    if (!canvas) { if (onError) onError('no-frame'); return; }
    const file = await canvasToFile(canvas);
    if (file) onCapture(file);
    else if (onError) onError('encode-failed');
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
  // the tap, and the attempt never touches the firing rule.
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

  // The outline IS the progress language (lib/outline.js): border
  // segments fill gold as the SERVER confirms each piece, and
  // only the missing piece's segment pulses. Live framing quality
  // never fills. When the number is the missing piece and nothing
  // blocks, the line names the close-up instead.
  const segments = outlineSegments({ locked: locked || null, stage: stage || null });
  const line = guidance || (stage === 'number' ? 'Close-up: bottom number corner' : null);

  return (
    <div className="camPreview">
      <video ref={videoRef} playsInline muted autoPlay className="camVideo" onClick={focusAt} />
      <div className={`camOutline${outlineClasses(segments) ? ' ' + outlineClasses(segments) : ''}`}>
        <span className="camCornerDot camDotBL" />
        <span className="camCornerDot camDotBR" />
      </div>
      {focusRing ? (
        <span key={focusRing.id} className="camFocusRing" aria-hidden="true" style={{ left: focusRing.x, top: focusRing.y }} />
      ) : null}
      {line ? <div className="camChip">{line}</div> : null}
      <div className="camBar">
        <button className="camShutter" onClick={snapNow} aria-label="Take a picture">
          <IconCamera size={30} /> SNAP
        </button>
        <button className="camClose" onClick={onClose} aria-label="Close camera">
          <IconX size={22} />
        </button>
      </div>
      <button className="camPicker" onClick={onPickPhoto}>Use photo picker instead</button>
    </div>
  );
}
