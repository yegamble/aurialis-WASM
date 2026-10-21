import type { AdvancedParams } from "./types";

export type LivePlaybackState = {
  position: number;
  duration: number;
  playing: boolean;
  ready: boolean;
  loading: boolean;
  original: boolean;
  volume: number;
  underruns: number;
  parameterVersion: number;
  appliedVersion: number;
  error: string | null;
};

export type LiveMeter = {
  peakDbfs: number;
  rmsDbfs: number;
  crestDb: number;
  correlation: number;
  position: number;
  underruns: number;
};

export type LiveSpectrum = {
  dbBins: Float32Array<ArrayBuffer>;
  sampleRate: number;
  fftSize: number;
};

type LivePlaybackCallbacks = {
  onState?: (state: LivePlaybackState) => void;
  onMeter?: (meter: LiveMeter) => void;
  onSpectrum?: (spectrum: LiveSpectrum) => void;
  onError?: (error: Error) => void;
};

type LivePlaybackController = {
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  setParams: (settings: AdvancedParams) => void;
  setBypass: (original: boolean) => void;
  setVolume: (volume: number) => void;
  dispose: () => void;
  getState: () => LivePlaybackState;
};
