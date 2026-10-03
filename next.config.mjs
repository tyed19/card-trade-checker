/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['tesseract.js', 'tesseract.js-core', 'sharp'],
  outputFileTracingIncludes: {
    '/api/identify': [
      './node_modules/tesseract.js/**/*',
      './node_modules/tesseract.js-core/**/*',
      './node_modules/@tesseract.js-data/**/*',
    ],
  },
};

export default nextConfig;
