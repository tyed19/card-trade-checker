// Share-link encoding for Phase 3 (binders + Gift Radar).
//
// A payload is { v:1, t:'binder'|'gift', kid:'Name', c:'<packed>' }.
// The packed card list keeps URLs sane: each entry is a card CODE in
// base36 — code = rowIndex*2 + langBit (0 = EN row, 1 = JA row) into
// the committed catalog arrays — with an optional "X<qty base36>"
// suffix (qty omitted when 1; capital X because base36 output is
// lowercase, so the separator can never be misread as part of a code).
// Entries are joined with '.'.
// The envelope JSON is UTF-8 → base64url, safe in a URL path segment.
//
// Decoding validates shape and drops malformed entries; refs that no
// longer exist in the catalog are filtered later by the resolver.

const B64URL_ENC = (bytes) => {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const B64URL_DEC = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export function refToCode(ref) {
  const m = /^([ej])(\d+)$/.exec(ref || '');
  if (!m) return null;
  return parseInt(m[2], 10) * 2 + (m[1] === 'j' ? 1 : 0);
}
export function codeToRef(code) {
  if (!Number.isInteger(code) || code < 0) return null;
  const idx = Math.floor(code / 2);
  return (code % 2 === 1 ? 'j' : 'e') + idx;
}

export function packCards(entries) {
  // entries: [{ref, qty}] → "code[.code...]" with x<qty> suffixes
  return (entries || [])
    .map((e) => {
      const code = refToCode(e.ref);
      if (code === null) return null;
      const q = Math.max(1, Math.floor(e.qty || 1));
      return code.toString(36) + (q > 1 ? 'X' + q.toString(36) : '');
    })
    .filter(Boolean)
    .join('.');
}

export function unpackCards(packed) {
  if (!packed || typeof packed !== 'string') return [];
  const out = [];
  for (const part of packed.split('.')) {
    if (!part) continue;
    const m = /^([0-9a-z]+)(?:X([0-9a-z]+))?$/.exec(part);
    if (!m) continue;
    const ref = codeToRef(parseInt(m[1], 36));
    if (!ref) continue;
    const qty = m[2] ? parseInt(m[2], 36) : 1;
    out.push({ ref, qty: Math.min(999, Math.max(1, qty || 1)) });
  }
  return out;
}

export function encodePayload({ t, kid, entries }) {
  const payload = { v: 1, t: t || 'binder', kid: String(kid || ''), c: packCards(entries) };
  const json = JSON.stringify(payload);
  return B64URL_ENC(new TextEncoder().encode(json));
}

export function decodePayload(code) {
  try {
    const json = new TextDecoder().decode(B64URL_DEC(String(code || '')));
    const p = JSON.parse(json);
    if (!p || p.v !== 1 || typeof p.c !== 'string') return null;
    return {
      t: p.t === 'gift' ? 'gift' : 'binder',
      kid: String(p.kid || ''),
      entries: unpackCards(p.c),
    };
  } catch {
    return null;
  }
}

export function giftPath({ kid, entries }) {
  return '/gift/' + encodePayload({ t: 'gift', kid, entries });
}

export function binderImportPath({ kid, entries }) {
  return '/?import=' + encodePayload({ t: 'binder', kid, entries });
}
