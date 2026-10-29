// FairSwap live-frame on-device OCR — plugin JS wrapper (ES module).
//
// HAND-MAINTAINED — there is no build step for this local plugin.
// Keep this file in sync with plugins/live-ocr/src/index.ts by hand
// (see plugins/live-ocr/README.md). The web fallback below is inert:
// in a plain browser (or a shell without the native implementation)
// every call resolves without throwing, isAvailable() reports
// { supported: false, reason: 'no-camera' }, and no listener ever
// fires — so the web app always takes the WebView preview path.
// The native iOS / Android implementations behind the same plugin
// name ('LiveOcr') are built by the native agents.

import { registerPlugin, WebPlugin } from '@capacitor/core';

export class LiveOcrWeb extends WebPlugin {
  async isAvailable() {
    return { supported: false, reason: 'no-camera' };
  }

  async startCamera(_options) {
    // No native screen on web: inert. Callers only reach here when
    // isAvailable() said supported, which this fallback never does.
    return;
  }

  async capture() {
    return null;
  }

  async stopCamera() {
    return;
  }
}

export const LiveOcr = registerPlugin('LiveOcr', {
  web: () => new LiveOcrWeb(),
});

export default LiveOcr;
