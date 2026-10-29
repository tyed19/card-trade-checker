// FairSwap live-frame on-device OCR — plugin JS wrapper (CommonJS).
//
// HAND-MAINTAINED — there is no build step for this local plugin.
// Keep this file in sync with plugins/live-ocr/src/index.ts by hand
// (see plugins/live-ocr/README.md). The web fallback below is inert:
// in a plain browser (or a shell without the native implementation)
// every call resolves without throwing, isAvailable() reports
// { supported: false, reason: 'no-camera' }, and no listener ever
// fires — so the web app always takes the WebView preview path.

const { registerPlugin, WebPlugin } = require('@capacitor/core');

class LiveOcrWeb extends WebPlugin {
  async isAvailable() {
    return { supported: false, reason: 'no-camera' };
  }

  async startCamera(_options) {
    return;
  }

  async capture() {
    return null;
  }

  async stopCamera() {
    return;
  }
}

const LiveOcr = registerPlugin('LiveOcr', {
  web: () => new LiveOcrWeb(),
});

module.exports = { LiveOcr, LiveOcrWeb, default: LiveOcr };
