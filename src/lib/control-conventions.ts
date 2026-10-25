// Translate engine control values into the conventions pro EQ, stereo-imaging and
// compressor plugins print. These mirror the algorithm-1 constants in
// internal/audio/dsp/engine.go and change no processing.

/** Half-gain (midpoint) frequency of a shelf, where RBJ / Pro-Q place the label.
 * The engine's internal shelf corner is that midpoint: 1.85× the low-shelf
 * label and 1/1.54 of the high-shelf label, clamped to 48.5% of the sample rate. */
export function shelfMidpointHz(type: "lowshelf" | "highshelf", freqHz: number, sampleRate: number): number {
  const corner = type === "lowshelf" ? freqHz * 1.85 : freqHz / 1.54;
  return Math.min(corner, sampleRate * 0.485);
}

/** Bell Q measured between half-gain points; the engine narrows Q as gain rises. */
export function effectiveBellQ(q: number, gainDb: number): number {
  return q * (1 + 0.25 * Math.abs(gainDb));
}

/** Frequency where the mono-bass side filter reaches −3 dB (four Butterworth stages at 1.45×). */
export function monoBassMinus3dBHz(crossoverHz: number): number {
  return crossoverHz * 1.45 * Math.pow(Math.pow(0.5, -0.25) - 1, -0.25);
}

/** 63% time constant of a compressor attack/release label, which the engine defines as 91.8% settling. */
export function timeConstantMs(labelMs: number): number {
  return labelMs / 2.5;
}
