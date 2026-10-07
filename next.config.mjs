/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['tesseract.js', 'tesseract.js-core', 'sharp', '@xenova/transformers', 'onnxruntime-node'],
  outputFileTracingIncludes: {
    '/api/identify': [
      './node_modules/tesseract.js/**/*',
      './node_modules/tesseract.js-core/**/*',
      './node_modules/@tesseract.js-data/**/*',
      // The worker script's own require graph: these are loaded by the
      // worker thread at RUNTIME (invisible to static tracing). Missing
      // regenerator-runtime killed the worker instantly on Vercel —
      // and createWorker swallowed the death as an infinite hang.
      './node_modules/regenerator-runtime/**/*',
      './node_modules/is-url/**/*',
      './node_modules/bmp-js/**/*',
      './node_modules/wasm-feature-detect/**/*',
      './node_modules/zlibjs/**/*',
      './node_modules/node-fetch/**/*',
      './node_modules/idb-keyval/**/*',
      // Phase 2 picture-matching: our own catalog + CLIP index (data/),
      // the committed CLIP model (models/), and the transformers.js /
      // onnxruntime files the matcher loads at runtime. Only the
      // linux/x64 onnxruntime binary ships (Vercel's arch) — the full
      // packages carry every platform and would blow the bundle limit.
      './data/catalog-en.json',
      './data/catalog-ja.json',
      './data/index-full.bin',
      './data/index-full.json',
      './data/index-full.scales.json',
      './data/manifest.json',
      './models/**/*',
      './node_modules/@xenova/transformers/src/**/*',
      './node_modules/@xenova/transformers/package.json',
      './node_modules/@huggingface/jinja/**/*',
      './node_modules/onnxruntime-common/**/*',
      './node_modules/onnxruntime-node/package.json',
      './node_modules/onnxruntime-node/dist/**/*',
      './node_modules/onnxruntime-node/bin/napi-v3/linux/x64/**/*',
    ],
  },
};

export default nextConfig;
