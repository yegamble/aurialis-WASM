import type { engineParams } from "./browser-engine";

type EngineParams = ReturnType<typeof engineParams>;

const CONTROL_COUNT = 56;
const CONTROL_OFFSET = Int32Array.BYTES_PER_ELEMENT * 4;
const filterTypes = ["high_pass", "low_shelf", "peaking", "high_shelf"];
const compressorTypes = ["optical", "vari_mu", "fet", "vca"];
const saturationTypes = ["Warm", "Thick", "Crisp"];

function enumCode(values: string[], value: string): number {
  const code = values.indexOf(value);
  if (code < 0) throw new Error("The live audio controls contain an unsupported setting.");
  return code;
}

// This fixed vector is the shared Go WASI control ABI, not a second DSP model.
export function packLiveControls(params: EngineParams): Float64Array<ArrayBuffer> {
  if (params.bands.length !== 5) throw new Error("Live audio requires five EQ bands.");
  const values = new Float64Array([
    Number(params.bypass), Number(params.abOriginal), Number(params.loudnessMatchAb), params.inputGainDb, Number(params.eqEnabled),
    ...params.bands.flatMap((band) => [band.freqHz, band.gainDb, band.q, enumCode(filterTypes, band.type), Number(band.enabled)]),
    Number(params.compressor.enabled), params.compressor.thresholdDb, params.compressor.ratio,
    params.compressor.attackMs, params.compressor.releaseMs, params.compressor.kneeDb,
    params.compressor.makeupDb, params.compressor.sidechainHpfHz, enumCode(compressorTypes, params.compressor.topology),
    Number(params.saturation.enabled), params.saturation.amount, enumCode(saturationTypes, params.saturation.character),
    Number(params.stereo.enabled), params.stereo.widthPct, Number(params.stereo.monoBass), params.stereo.crossoverHz,
    Number(params.limiter.enabled), params.limiter.ceilingDbtp, params.limiter.targetLufs,
    params.limiter.releaseMs, Number(params.limiter.truePeak),
    Number(params.repair.enabled), params.repair.deEssDb, params.repair.transientDb, Number(params.repair.deClip), params.ditherBits,
  ]);
  if (!values.every(Number.isFinite)) throw new Error("Live audio controls must be finite.");
  return values;
}

export function createLiveControls(params: EngineParams, version: number) {
  const buffer = new SharedArrayBuffer(CONTROL_OFFSET + CONTROL_COUNT * Float64Array.BYTES_PER_ELEMENT);
  const header = new Int32Array(buffer, 0, 4);
  const values = new Float64Array(buffer, CONTROL_OFFSET, CONTROL_COUNT);
  function publish(next: EngineParams, nextVersion: number): void {
    // Validate/allocate on the UI thread before beginning the atomic publication.
    const packed = packLiveControls(next);
    const sequence = Atomics.load(header, 0);
    Atomics.store(header, 0, sequence + 1);
    values.set(packed);
    Atomics.store(header, 1, nextVersion);
    Atomics.store(header, 0, sequence + 2);
  }
  publish(params, version);
  return { buffer, publish };
}
