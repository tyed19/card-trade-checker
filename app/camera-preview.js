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
//   - Auto-capture when the shot is steady and sharp: samples the
//     video every ~200ms, and after 3 steady+sharp samples in a row
//     it snaps the sharpest recent frame on its own. Kid-hand shake
//     stops producing blurry submissions.
//   - A manual shutter for kids who don't want to wait, and a
//     "photo picker instead" escape that always works.
//   - A soft shine chip when the frame looks very washed out
//     (advisory only — single-frame glare detection is weakly
//     separable, so it never blocks anything).
//
// Any failure (no camera, denied permission, getUserMedia missing)
// calls onAutoFail() when provided (the parent retries via the
// native plugin in the shell, else the picker) or onFallback() —
// the preview can never strand a kid without a way to take a photo.
// The "Use photo picker instead" button always calls onFallback().

'use client';

import { useEffect, useRef, useState } from 'react';
import { measureShot } from '../lib/shotquality.js';
import { IconCamera, IconX } from './icons';

const STEADY_NEEDED = 3;
const SAMPLE_MS = 200;
const DIFF_MAX = 7; // mean abs frame difference below this = steady

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

export default function CameraPreview({ onCapture, onClose, onFallback, onAutoFail }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const sampleRef = useRef(null);
  const prevRef = useRef(null);
  const steadyRef = useRef(0);
  const bestRef = useRef(null); // sharpest recent full-res canvas
  const doneRef = useRef(false);
  const [shiny, setShiny] = useState(false);
  const [steadyCount, setSteadyCount] = useState(0);

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
        timer = setInterval(() => {
          const v = videoRef.current;
          if (!v || v.videoWidth === 0 || doneRef.current) return;
          try {
            const canvas = sampleRef.current || (sampleRef.current = document.createElement('canvas'));
            const sample = sampleFrame(v, canvas);
            const m = measureShot(sample);
            setShiny(m.glareFrac >= 0.25);
            const diff = frameDiff(prevRef.current, sample);
            prevRef.current = sample;
            const good = diff < DIFF_MAX && m.sharpness >= 400;
            steadyRef.current = good ? steadyRef.current + 1 : 0;
            setSteadyCount(steadyRef.current);
            // Keep the sharpest recent full-res frame for auto-capture.
            if (m.sharpness >= 400) {
              const full = bestRef.current || (bestRef.current = document.createElement('canvas'));
              full.width = v.videoWidth;
              full.height = v.videoHeight;
              full.getContext('2d').drawImage(v, 0, 0);
            }
            if (steadyRef.current >= STEADY_NEEDED) {
              doneRef.current = true;
              captureFromBest();
            }
          } catch { /* a bad sample never breaks the preview */ }
        }, SAMPLE_MS);
      } catch {
        // No camera / denied / no API: never strand the kid — the
        // parent retries via the native plugin in the shell, else
        // opens the file picker.
        if (!cancelled) (onAutoFail || onFallback)();
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
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
    let file = null;
    if (best && best.width) file = await canvasToFile(best);
    if (!file && v && v.videoWidth) {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      file = await canvasToFile(c);
    }
    if (file) onCapture(file);
    else onFallback();
  }

  async function snapNow() {
    if (doneRef.current) return;
    doneRef.current = true;
    await captureFromBest();
  }

  return (
    <div className="camPreview">
      <video ref={videoRef} playsInline muted autoPlay className="camVideo" />
      <div className="camOutline">
        <span className="camCornerDot camDotBL" />
        <span className="camCornerDot camDotBR" />
      </div>
      {shiny ? <div className="camChip">Shiny? Tilt a little!</div> : null}
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
        {[0, 1, 2].map((i) => (
          <span key={i} className={steadyCount > i ? 'on' : ''} />
        ))}
      </div>
    </div>
  );
}
