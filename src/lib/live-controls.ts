import type { engineParams } from "./browser-engine";

type CurrentEngineParams = ReturnType<typeof engineParams>;
// Frozen/native legacy fixtures predate the additive controls. Their missing
// fields intentionally encode the old zero/disabled ABI extension.
type EngineParams = Omit<CurrentEngineParams, "compressor" | "stereo" | "deHarsh" | "multiband"> & {
 compressor: Omit<CurrentEngineParams["compressor"], "autoRelease"> & {autoRelease?: boolean};
 stereo: Omit<CurrentEngineParams["stereo"], "midGainDb" | "sideGainDb"> & {midGainDb?: number; sideGainDb?: number};
 deHarsh?: CurrentEngineParams["deHarsh"];
 multiband?: CurrentEngineParams["multiband"];
};

const CONTROL_COUNT = 81;
const CONTROL_OFFSET = Int32Array.BYTES_PER_ELEMENT * 4;
const filterTypes = ["high_pass", "low_shelf", "peaking", "high_shelf"];
const compressorTypes = ["optical", "vari_mu", "fet", "vca"];
const saturationTypes = ["Warm", "Thick", "Crisp", "Clean", "Tube", "Tape", "Transformer"];

function enumCode(values: string[], value: string): number {
  const code = values.indexOf(value);
  if (code < 0) throw new Error("The live audio controls contain an unsupported setting.");
  return code;
}

// This fixed vector is the shared Go WASI control ABI, not a second DSP model.
export function packLiveControls(params: EngineParams): Float64Array<ArrayBuffer> {
  if (params.bands.length !== 5) throw new Error("Live audio requires five EQ bands.");
  // Runtime callers can violate the statically declared three-band tuple.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (params.multiband && params.multiband.bands.length !== 3)
    throw new Error("Live audio requires three multiband bands.");
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
    Number(params.compressor.autoRelease ?? false), params.stereo.midGainDb ?? 0, params.stereo.sideGainDb ?? 0,
    Number(params.deHarsh?.enabled ?? false), params.deHarsh?.frequencyHz ?? 0, params.deHarsh?.thresholdDb ?? 0, params.deHarsh?.rangeDb ?? 0,
    Number(params.multiband?.enabled ?? false), params.multiband?.lowMidHz ?? 0, params.multiband?.midHighHz ?? 0,
    ...(params.multiband?.bands.flatMap((band) => [band.thresholdDb, band.ratio, band.attackMs, band.releaseMs, band.makeupDb]) ?? new Array<number>(15).fill(0)),
  ]);
  if (values.length !== CONTROL_COUNT) throw new Error("The live audio control packet must contain 81 values.");
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
