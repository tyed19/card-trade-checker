import { warmPict } from '../../../lib/pictmatch';
import { warmOcr } from '../../../lib/ocr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Cold-start mitigation, now AWAITED: the client pings this on page
// load and again when the capture preview opens, so the CLIP model
// and the tesseract worker are already loading when the first photo
// arrives. The old fire-and-forget version was a no-op in practice —
// serverless instances freeze after the response, so an unawaited
// load often never finished. The await is capped (15s) so a slow
// model load can't hang the ping; the client ignores the response
// either way. Warming is still a head start, not a guarantee:
// instances are reused opportunistically, and routing is not sticky,
// so a later scan can still land cold — which is why the identify
// route degrades a slow lane to a guided retake instead of an error.
export async function GET() {
  const jobs = [];
  try { const p = warmPict(); if (p && typeof p.then === 'function') jobs.push(p); } catch { /* best-effort */ }
  try { const p = warmOcr(); if (p && typeof p.then === 'function') jobs.push(p); } catch { /* best-effort */ }
  try {
    await Promise.race([
      Promise.allSettled(jobs),
      new Promise((r) => setTimeout(r, 15000)),
    ]);
  } catch { /* best-effort */ }
  return Response.json({ ok: true });
}
