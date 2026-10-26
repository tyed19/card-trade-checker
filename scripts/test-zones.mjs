// Fixtures for the live zonal scan (lib/zones.js): zone geometry,
// per-zone live quality classification, and the server-locked
// display derivation (gold only for server-confirmed signals).
import { ZONES, assessZoneQuality, deriveZoneDisplay } from '../lib/zones.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

// --- geometry: three zones, in card order, inside the guide ---
{
  check('three zones in order', ZONES.map((z) => z.key).join(',') === 'name,art,number');
  check('zones inside the guide', ZONES.every((z) => z.top >= 0 && z.top + z.height <= 1));
  check('name zone at top, number zone at bottom', ZONES[0].top === 0 && ZONES[2].top + ZONES[2].height === 1);
}

// Synthetic frame builder: 160x120 RGBA, card box at (0.1, 0.1,
// 0.8, 0.8); each zone filled by its own pattern function.
function buildFrame(patterns) {
  const w = 160, h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  const box = { l: 0.1, t: 0.1, w: 0.8, h: 0.8 };
  const bx0 = Math.round(box.l * w), by0 = Math.round(box.t * h);
  const bx1 = Math.round((box.l + box.w) * w), by1 = Math.round((box.t + box.h) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v = 128; // flat mid-gray background
      if (x >= bx0 && x < bx1 && y >= by0 && y < by1) {
        const frac = (y - by0) / (by1 - by0);
        const zone = frac < 0.14 ? 'name' : frac < 0.56 ? 'art' : frac < 0.9 ? 'mid' : 'number';
        v = patterns[zone] ? patterns[zone](x, y) : 128;
      }
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, w, h, box };
}
// Mid-tone checkerboard: sharp edges without tripping the
// bright-desaturated glare detector (pure-white squares would
// count as glare, which is a property of the test pattern, not of
// real card art).
const checker = (x, y) => ((x + y) % 2 === 0 ? 180 : 60);
const flat = () => 128;
const brightChecker = (x, y) => ((x + y) % 2 === 0 ? 255 : 210); // sharp but washed out

// --- live quality: sharp pattern reads ready, flat reads needs ---
{
  const { data, w, h, box } = buildFrame({ name: checker, art: checker, number: checker });
  const q = assessZoneQuality(data, w, h, box);
  check('sharp zones all ready', q.name.ready && q.art.ready && q.number.ready);
}
{
  const { data, w, h, box } = buildFrame({ name: flat, art: checker, number: flat });
  const q = assessZoneQuality(data, w, h, box);
  check('flat zones need work, sharp zone ready', !q.name.ready && q.art.ready && !q.number.ready);
}
{
  const { data, w, h, box } = buildFrame({ name: brightChecker, art: checker, number: checker });
  const q = assessZoneQuality(data, w, h, box);
  check('washed-out zone needs work despite sharpness', !q.name.ready && q.name.glareFrac === 1);
}
{
  const { data, w, h } = buildFrame({ name: checker, art: checker, number: checker });
  check('no box means no quality', assessZoneQuality(data, w, h, null) === null);
  check('tiny box means no quality', assessZoneQuality(data, w, h, { l: 0.5, t: 0.5, w: 0.01, h: 0.01 }) === null);
}

// --- display derivation: gold ONLY for server-confirmed signals ---
{
  const d = deriveZoneDisplay({ progress: null, quality: null });
  check('first pass: all need work, 0%', d.zones.name.state === 'needs' && d.zones.art.state === 'needs' && d.zones.number.state === 'needs' && d.percent === 0);
  check('first pass: nothing pulses', !d.zones.name.pulse && !d.zones.art.pulse && !d.zones.number.pulse);
}
{
  const d = deriveZoneDisplay({ progress: null, quality: { name: { ready: true }, art: { ready: true }, number: { ready: false } } });
  check('live-ready zones are bright, not gold, percent stays 0', d.zones.name.state === 'ready' && d.zones.art.state === 'ready' && d.zones.number.state === 'needs' && d.percent === 0);
}
{
  // Iron Leaves ex shape: name + picture banked, number missing.
  const d = deriveZoneDisplay({
    progress: { picture: true, name: true, number: false, missing: 'number', banked: 2 },
    quality: { name: { ready: true }, art: { ready: true }, number: { ready: false } },
  });
  check('Iron Leaves: art+name gold, number sparkling+pulsing, 67%', d.zones.art.state === 'locked' && d.zones.name.state === 'locked' && d.zones.number.state === 'needs' && d.zones.number.pulse && d.percent === 67);
}
{
  const d = deriveZoneDisplay({
    progress: { picture: true, name: false, number: true, missing: 'straight', banked: 2 },
    quality: null,
  });
  check('straight stage: name zone pulses, art+number gold', d.zones.name.pulse && d.zones.art.state === 'locked' && d.zones.number.state === 'locked' && d.percent === 67);
}
{
  const d = deriveZoneDisplay({
    progress: { picture: true, name: true, number: true, missing: 'tilt', banked: 3 },
    quality: null,
  });
  check('all locked: 100%, nothing pulses', d.percent === 100 && !d.zones.name.pulse && !d.zones.art.pulse && !d.zones.number.pulse);
}
{
  const d = deriveZoneDisplay({
    progress: { picture: false, name: false, number: false, missing: 'tilt', banked: 0 },
    quality: null,
  });
  check('tilt stage: no single zone pulses', !d.zones.name.pulse && !d.zones.art.pulse && !d.zones.number.pulse && d.percent === 0);
}
{
  // A locked zone ignores live quality: gold even when the live
  // frame looks bad — only the server can lock, and only the
  // server's verdict counts for that zone.
  const d = deriveZoneDisplay({
    progress: { picture: true, name: false, number: false, missing: 'number', banked: 1 },
    quality: { name: { ready: false }, art: { ready: false }, number: { ready: false } },
  });
  check('locked zone stays gold despite bad live frame, 33%', d.zones.art.state === 'locked' && d.percent === 33);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
