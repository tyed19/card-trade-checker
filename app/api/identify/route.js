import { NextResponse } from 'next/server';
import { readCardPhoto, getStageStats } from '../../../lib/ocr';
import { findCandidates } from '../../../lib/identify';

export const runtime = 'nodejs';
export const maxDuration = 60;

function parseNumberParam(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,3})\s*(?:\/\s*(\d{1,3}))?/);
  if (!m) return null;
  return {
    num: String(parseInt(m[1], 10)),
    padded: String(parseInt(m[1], 10)).padStart(3, '0'),
    total: m[2] ? String(parseInt(m[2], 10)) : null,
  };
}

export async function POST(req) {
  const t0 = Date.now();
  try {
    const form = await req.formData();
    const file = form.get('photo');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ ok: false, error: 'No photo received' }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    // Hard deadline comfortably inside the platform cap (maxDuration 60):
    // if the pipeline is having a slow day, answer with structured JSON
    // the client can act on instead of dying as a platform 504 page
    // (which is what "Something went wrong" on the phone actually was).
    const DEADLINE_MS = parseInt(process.env.IDENTIFY_DEADLINE_MS || '50000', 10) || 50000;
    let timer = null;
    const work = (async () => {
      const reading = await readCardPhoto(buffer);
      const ocrMs = Date.now() - t0;
      const candidates = await findCandidates({ ...reading, photoBuffer: buffer });
      return { reading, candidates, ocrMs };
    })();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(1000, DEADLINE_MS - (Date.now() - t0)));
    });
    const done = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (!done) {
      return NextResponse.json({
        ok: false, error: 'slow', retry: true,
        detail: `Identification exceeded ${DEADLINE_MS}ms budget`,
        timing: { totalMs: Date.now() - t0 },
        ocrStages: getStageStats(),
      });
    }
    const { reading, candidates, ocrMs } = done;
    const { nameGuess, nameGuesses, numberGuess, numberGuesses, attackGuesses, debug } = reading;
    return NextResponse.json({
      ok: true,
      ocr: {
        name: nameGuess || '',
        nameGuesses: nameGuesses || [],
        number: numberGuess ? `${numberGuess.padded}${numberGuess.total ? '/' + numberGuess.total : ''}` : '',
        numberGuesses: numberGuesses || [],
        attackGuesses: attackGuesses || [],
      },
      candidates,
      timing: { ocrMs, totalMs: Date.now() - t0, ocrStages: reading.ocrTiming || null },
      ...(process.env.DEBUG_OCR ? { debug } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'identify-failed', debugError: String(err && err.message || err), timing: { totalMs: Date.now() - t0 } },
      { status: 500 }
    );
  }
}

// Grown-ups manual fallback: /api/identify?name=Meowth&number=106/094
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    if (searchParams.get('diag') === 'worker') {
      // Can a bare worker_thread even run in this runtime?
      const { Worker } = await import('node:worker_threads');
      const os = await import('node:os');
      const result = await new Promise((resolve) => {
        let w;
        try {
          w = new Worker(
            "const { parentPort } = require('worker_threads'); parentPort.postMessage('alive');",
            { eval: true }
          );
        } catch (err) { resolve('spawn-threw: ' + String(err && err.message || err)); return; }
        const timer = setTimeout(() => { try { w.terminate(); } catch {} resolve('timeout-6s'); }, 6000);
        w.once('message', (m) => { clearTimeout(timer); w.terminate(); resolve('ok: ' + m); });
        w.once('error', (err) => { clearTimeout(timer); resolve('error: ' + String(err && err.message || err)); });
      });
      return NextResponse.json({
        ok: true, diag: {
          workerEval: result,
          node: process.version, platform: process.platform,
          cpus: os.cpus().length, cwd: process.cwd(),
          arch: process.arch,
        },
      });
    }
    if (searchParams.get('diag') === 'tessworker') {
      // Spawn tesseract's actual worker script and listen for its death:
      // createWorker never surfaces worker 'error' events, so a worker
      // that dies at require-time looks exactly like an init hang.
      const { Worker } = await import('node:worker_threads');
      const path = await import('node:path');
      const fs = await import('node:fs');
      const script = path.join(process.cwd(), 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js');
      const events = await new Promise((resolve) => {
        const seen = [];
        let w;
        try {
          w = new Worker(script);
        } catch (err) { resolve(['spawn-threw: ' + String(err && err.message || err)]); return; }
        const timer = setTimeout(() => { seen.push('still-alive-after-6s'); try { w.terminate(); } catch {} resolve(seen); }, 6000);
        w.once('error', (err) => { seen.push('error: ' + String(err && err.message || err)); });
        w.once('exit', (code) => { seen.push('exit: ' + code); clearTimeout(timer); resolve(seen); });
        w.once('online', () => seen.push('online'));
      });
      // Also verify the worker graph's external deps resolve from here.
      const req = (await import('node:module')).createRequire(import.meta.url);
      const deps = {};
      for (const dep of ['wasm-feature-detect', 'zlibjs', 'bmp-js', 'node-fetch', 'tesseract.js-core/tesseract-core-simd-lstm.js', 'tesseract.js/src/worker-script/index.js']) {
        try { deps[dep] = req.resolve(dep); } catch (err) { deps[dep] = 'FAIL: ' + String(err && err.message || err).slice(0, 120); }
      }
      return NextResponse.json({ ok: true, diag: { script, scriptExists: fs.existsSync(script), workerEvents: events, deps } });
    }
    const nameGuess = searchParams.get('name') || '';
    const numberGuess = parseNumberParam(searchParams.get('number'));
    if (!nameGuess && !numberGuess) {
      return NextResponse.json({ ok: false, error: 'Give a name or a number' }, { status: 400 });
    }
    const candidates = await findCandidates({ nameGuess, numberGuess });
    return NextResponse.json({ ok: true, candidates });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'identify-failed', debugError: String(err && err.message || err) },
      { status: 500 }
    );
  }
}
