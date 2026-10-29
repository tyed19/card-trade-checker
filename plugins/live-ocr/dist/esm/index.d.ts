// FairSwap live-frame on-device OCR — plugin JS wrapper (types).
//
// HAND-MAINTAINED — there is no build step for this local plugin.
// Keep this file in sync with plugins/live-ocr/src/index.ts by hand
// (see plugins/live-ocr/README.md).

import type { PluginListenerHandle } from '@capacitor/core';

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

export interface LiveOcrPlugin {
  isAvailable(): Promise<LiveOcrAvailability>;
  startCamera(options: LiveOcrStartOptions): Promise<void>;
  capture(): Promise<LiveOcrCapture | null>;
  stopCamera(): Promise<void>;
  addListener(eventName: 'ocrFrame', listenerFunc: (frame: LiveOcrFrame) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'snapRequest', listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'closed', listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: string, listenerFunc: (...args: unknown[]) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export declare class LiveOcrWeb {
  isAvailable(): Promise<LiveOcrAvailability>;
  startCamera(options: LiveOcrStartOptions): Promise<void>;
  capture(): Promise<LiveOcrCapture | null>;
  stopCamera(): Promise<void>;
}

export declare const LiveOcr: LiveOcrPlugin;
export default LiveOcr;
