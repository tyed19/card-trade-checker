// The RESET's single progress language: the card outline itself.
// After 2026-10-25 layered too many indicators (zone boxes, steadiness
// dots, a percent mixing live framing with server locks, a separate
// ring screen), the preview shows ONE outline and nothing else: the
// guide, SNAP, the picker escape, X, and one guidance line that
// appears only when the app is genuinely blocked.
//
// The outline border fills in segments as the SERVER confirms each
// piece — fingerprint-style fill. Fill counts server-confirmed locks
// ONLY (the lib/progress.js summary: picture / name / number), never
// live framing quality, so it can never stall mid-way like the old
// percent did. Segment mapping (the progress contract's channels):
//   top edge    <- name   (title text)
//   side edges  <- picture (art)
//   bottom edge <- number (collector-number corner)
// After a capture, if a piece is missing, ONLY that piece's segment
// pulses to guide the next shot. 'tilt' has no single piece (the
// angle itself is the problem), so nothing pulses — the guidance
// line carries it. A locked segment never pulses: it stays filled.
//
// Pure functions, no DOM — tested by scripts/test-outline.mjs.

export function outlineSegments({ locked = null, stage = null } = {}) {
  const name = !!(locked && locked.name === true);
  const art = !!(locked && locked.picture === true);
  const number = !!(locked && locked.number === true);
  const pulseName = stage === 'straight' && !name;
  const pulseNumber = stage === 'number' && !number;
  return {
    // 'locked' | 'pulse' | 'plain', per edge group.
    top: name ? 'locked' : pulseName ? 'pulse' : 'plain',
    sides: art ? 'locked' : 'plain',
    bottom: number ? 'locked' : pulseNumber ? 'pulse' : 'plain',
  };
}

// CSS class names for the outline div from the segment states above.
// Kept separate so the preview stays a dumb renderer of this map.
export function outlineClasses(segments) {
  const classes = [];
  if (segments.top === 'locked') classes.push('lockName');
  else if (segments.top === 'pulse') classes.push('pulseName');
  if (segments.sides === 'locked') classes.push('lockArt');
  if (segments.bottom === 'locked') classes.push('lockNumber');
  else if (segments.bottom === 'pulse') classes.push('pulseNumber');
  return classes.join(' ');
}
