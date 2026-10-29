// FairSwap live-frame on-device OCR — plugin JS wrapper (SOURCE).
//
// This is the hand-maintained source for the @fairswap/live-ocr web
// fallback. There is NO build toolchain for this local plugin: the
// files under dist/ are checked in by hand and must be kept in sync
// with this file (see plugins/live-ocr/README.md). The native iOS /
// Android implementations live under ios/ and android/ and are built
// by the native agents; this file only defines the JS side of the
// bridge contract, exactly like the official plugins' web fallbacks
// (see @capacitor/camera's WebPlugin).
//
// Contract (native side implements the same names):
//   isAvailable() -> { supported, reason? }
//     reason: 'unsupported-os' | 'no-camera' | 'model-missing'
//   startCamera({ stage, locked }) -> opens the native camera screen
//   addListener('ocrFrame', cb) — OcrFrame events (see README)
//   addListener('snapRequest', cb) — native SNAP button pressed
//   addListener('closed', cb) — native screen closed
//   capture() -> { base64, deviceOcr } | null
//   stopCamera() -> tears the session down
//
// Web fallback (this file, running in a plain browser or in a shell
// without the native implementation): every call resolves inert and
// never throws. isAvailable() reports { supported: false,
// reason: 'no-camera' }, so the web app always takes the WebView
// preview path. No listener ever fires on web: the native screen
// never opens, so there is nothing to listen to.

import { registerPlugin, WebPlugin } from '@capacitor/core';

export interface LiveOcrCardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LiveOcrObservation {
  text: string;
  confidence: number | null;
  boundingBox: LiveOcrCardBox;
  region: 'title' | 'number' | 'attack' | 'other';
  script: 'latin' | 'japanese';
}

export interface LiveOcrStable {
  name: string | null;
  number: string | null;
}

export interface LiveOcrFrame {
  frameId: number;
  cardBox: LiveOcrCardBox | null;
  observations: LiveOcrObservation[];
  stable: LiveOcrStable;
  sharpness: number | null;
}

export interface LiveOcrDeviceOcr {
  name: string | null;
  number: string | null;
  script: 'latin' | 'japanese' | null;
}

export interface LiveOcrAvailability {
  supported: boolean;
  reason?: 'unsupported-os' | 'no-camera' | 'model-missing';
}

export interface LiveOcrStartOptions {
  stage: string | null;
  locked: { picture?: boolean; name?: boolean; number?: boolean } | null;
}

export interface LiveOcrCapture {
  base64: string;
  deviceOcr: LiveOcrDeviceOcr;
}

export class LiveOcrWeb extends WebPlugin {
  async isAvailable(): Promise<LiveOcrAvailability> {
    return { supported: false, reason: 'no-camera' };
  }

  async startCamera(_options: LiveOcrStartOptions): Promise<void> {
    // No native screen on web: inert. The caller only reaches here
    // when isAvailable() said supported, which this fallback never
    // does — this is a safety net, not a path.
    return;
  }

  async capture(): Promise<LiveOcrCapture | null> {
    return null;
  }

  async stopCamera(): Promise<void> {
    return;
  }
}

export const LiveOcr = registerPlugin('LiveOcr', {
  web: () => new LiveOcrWeb(),
});

export default LiveOcr;
