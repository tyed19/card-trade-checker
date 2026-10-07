#!/usr/bin/env node
// Write data/manifest.json describing the committed Phase 2 data artifacts.
//   node scripts/make-manifest.mjs
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve('data');
const size = (f) => { try { return fs.statSync(path.join(DATA, f)).size; } catch { return null; } };
const en = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog-en.json'), 'utf8'));
const ja = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog-ja.json'), 'utf8'));
const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index-full.json'), 'utf8'));
const perLang = (cat) => ({
  cards: cat.length,
  withImage: cat.filter((c) => c.image).length,
  withUsd: cat.filter((c) => c.usd !== null && c.usd !== undefined).length,
  withEur: cat.filter((c) => c.eur !== null && c.eur !== undefined).length,
});
const manifest = {
  builtAt: new Date().toISOString(),
  model: idx.model,
  dims: idx.dims,
  indexVectors: idx.count,
  catalogs: { en: perLang(en), ja: perLang(ja) },
  files: {
    'catalog-en.json': size('catalog-en.json'),
    'catalog-ja.json': size('catalog-ja.json'),
    'index-full.bin': size('index-full.bin'),
    'index-full.json': size('index-full.json'),
    'index-full.scales.json': size('index-full.scales.json'),
  },
};
fs.writeFileSync(path.join(DATA, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
