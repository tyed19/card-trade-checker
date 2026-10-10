import { warmPict } from '../../../lib/pictmatch';
import { warmOcr } from '../../../lib/ocr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Best-effort cold-start mitigation: the client pings this once on page
// load so the CLIP model and the tesseract worker are already loading
// when the first photo arrives. The first scan of a session is
// virtually always the blue MY CARD side — paying cold-start inside
// its 50s deadline made first scans fail while second scans (warm
// instance) succeeded, which looked like a my-side bug. Serverless
// instances are reused opportunistically, so this is a head start,
// not a guarantee.
export async function GET() {
  try { warmPict(); } catch { /* best-effort */ }
  try { warmOcr(); } catch { /* best-effort */ }
  return Response.json({ ok: true });
}
