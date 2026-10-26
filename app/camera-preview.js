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
//     "Needs a darker background", "Tilt a little", "Hold steady")
//     — blocked firing always explains itself, and a missing box
//     never produces a 'corners' chip: the fallback hold below is
//     what fires instead.
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
import { assessFraming, luminanceContrast, guidanceFor, coverOutlineRect } from '../lib/framing.js';
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

export default function CameraPreview({ stage, onCapture, onClose, onFallback, onAutoFail }) {
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
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
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
            const lum = box ? luminanceContrast(sample.data, sample.width, sample.height, box) : null;
            let outline = null;
            try {
              const oEl = outlineRef.current;
              if (oEl && v.videoWidth && v.videoHeight) {
                outline = coverOutlineRect({
                  videoRect: v.getBoundingClientRect(),
                  outlineRect: oEl.getBoundingClientRect(),
                  videoW: v.videoWidth, videoH: v.videoHeight,
                });
              }
            } catch { /* outline stays null -> legacy framing */ }
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

  if (captured) {
    return (
      <div className="camPreview">
        <div className="camUploading">Sending…</div>
      </div>
    );
  }

  return (
    <div className="camPreview">
      <video ref={videoRef} playsInline muted autoPlay className="camVideo" />
      <div ref={outlineRef} className={`camOutline${stage === 'number' ? ' numberStage' : ''}`}>
        <span className="camCornerDot camDotBL" />
        <span className="camCornerDot camDotBR" />
      </div>
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
