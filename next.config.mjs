/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['tesseract.js', 'tesseract.js-core', 'sharp'],
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
    ],
  },
};

export default nextConfig;
