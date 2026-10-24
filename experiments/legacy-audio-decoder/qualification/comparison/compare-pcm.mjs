/* Diagnostic only; no alignment, resampling, trimming, normalization or fallback. */
import assert from "node:assert/strict";
export function markers(bytes, channels) {
  const count = bytes.length / (channels * 4), peaks = Array.from({ length: channels }, () => ({ peak: 0, peakAt: 0, leadingPeak: 0, leadingPeakAt: 0, trailingPeak: 0, trailingPeakAt: 0, negativeZero: 0, aboveUnity: 0 }));
  for (let frame = 0; frame < count; frame++) for (let channel = 0; channel < channels; channel++) {
    const value = bytes.readFloatLE((frame * channels + channel) * 4), magnitude = Math.abs(value), item = peaks[channel];
    assert.ok(Number.isFinite(value), "PCM must be finite.");
    if (Object.is(value, -0)) item.negativeZero++;
    if (magnitude > 1) item.aboveUnity++;
    if (magnitude > item.peak) { item.peak = magnitude; item.peakAt = frame; }
    if (frame < 4096 && magnitude > item.leadingPeak) { item.leadingPeak = magnitude; item.leadingPeakAt = frame; }
    if (frame >= Math.max(0, count - 4096) && magnitude > item.trailingPeak) { item.trailingPeak = magnitude; item.trailingPeakAt = frame; }
  }
  return peaks;
}
export function comparePcm(wasm, native, geometry, criteria, lossless) {
  assert.ok(Number.isSafeInteger(geometry.frames) && geometry.frames > 0 && geometry.frames <= 384001);
  assert.ok([1, 2].includes(geometry.channels));
  assert.equal(wasm.length, geometry.frames * 8);
  assert.equal(native.length, geometry.frames * geometry.channels * 4);
  let maximumAbsoluteError = 0, squared = 0, compared = 0, differingBits = 0;
  for (let frame = 0; frame < geometry.frames; frame++) {
    if (geometry.channels === 1) assert.equal(wasm.readUInt32LE(frame * 8), wasm.readUInt32LE(frame * 8 + 4), "Mono duplication must be bit-exact between the two WASM channels.");
    for (let channel = 0; channel < geometry.channels; channel++) {
      const wi = (frame * 2 + channel) * 4, ni = (frame * geometry.channels + channel) * 4;
      const actual = wasm.readFloatLE(wi), expected = native.readFloatLE(ni);
      assert.ok(Number.isFinite(actual) && Number.isFinite(expected));
      const difference = Math.abs(actual - expected);
      maximumAbsoluteError = Math.max(maximumAbsoluteError, difference); squared += difference * difference; compared++;
      if (wasm.readUInt32LE(wi) !== native.readUInt32LE(ni)) differingBits++;
    }
  }
  const rmsError = Math.sqrt(squared / compared);
  const pass = lossless ? differingBits === 0 : maximumAbsoluteError <= criteria.lossyMaximumAbsoluteError && rmsError <= criteria.lossyMaximumRmsError;
  return { pass, maximumAbsoluteError, rmsError, differingBits, comparedSamples: compared, lossless, nativeMarkers: markers(native, geometry.channels), wasmMarkers: markers(wasm, 2) };
}
