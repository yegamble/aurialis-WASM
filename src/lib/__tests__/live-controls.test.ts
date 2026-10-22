import { describe, expect, it } from "vitest";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { engineParams } from "../browser-engine";
import { createLiveControls, packLiveControls } from "../live-controls";

const params = () => engineParams(createDefaultAdvancedParams());

describe("fixed Go live control ABI", () => {
  it("maps all fields to their specified numeric positions", () => {
    const controls: ReturnType<typeof engineParams> = {
      ...params(),
      bypass: true, abOriginal: false, loudnessMatchAb: true, inputGainDb: -6, eqEnabled: false,
      bands: [
        { freqHz: 35, gainDb: -1, q: 0.5, type: "high_pass", enabled: true },
        { freqHz: 150, gainDb: 2, q: 0.6, type: "low_shelf", enabled: false },
        { freqHz: 900, gainDb: -3, q: 0.7, type: "peaking", enabled: true },
        { freqHz: 3000, gainDb: 4, q: 0.8, type: "high_shelf", enabled: false },
        { freqHz: 14000, gainDb: -5, q: 0.9, type: "peaking", enabled: true },
      ],
      compressor: { enabled: false, thresholdDb: -21, ratio: 3, attackMs: 9, releaseMs: 130, kneeDb: 5, makeupDb: 2, sidechainHpfHz: 95, autoRelease: true, topology: "vca" },
      saturation: { enabled: true, amount: 23, character: "Crisp" },
      stereo: { enabled: false, widthPct: 125, monoBass: true, crossoverHz: 120, midGainDb: 2, sideGainDb: -1 },
      limiter: { enabled: true, ceilingDbtp: -0.7, targetLufs: -12, releaseMs: 70, truePeak: true },
      repair: { enabled: true, deEssDb: 3, transientDb: -2, deClip: true }, ditherBits: 24,
      deHarsh: {enabled: true, frequencyHz: 4000, thresholdDb: -20, rangeDb: 4},
      multiband: {enabled: false, lowMidHz: 200, midHighHz: 4000, bands: [{thresholdDb: -24, ratio: 1.5, attackMs: 30, releaseMs: 150, makeupDb: 0}, {thresholdDb: -24, ratio: 1.5, attackMs: 30, releaseMs: 150, makeupDb: 0}, {thresholdDb: -24, ratio: 1.5, attackMs: 30, releaseMs: 150, makeupDb: 0}]},
    };
    expect(Array.from(packLiveControls(controls))).toEqual([
      1, 0, 1, -6, 0,
      35, -1, 0.5, 0, 1, 150, 2, 0.6, 1, 0, 900, -3, 0.7, 2, 1,
      3000, 4, 0.8, 3, 0, 14000, -5, 0.9, 2, 1,
      0, -21, 3, 9, 130, 5, 2, 95, 3,
      1, 23, 2, 0, 125, 1, 120, 1, -0.7, -12, 70, 1, 1, 3, -2, 1, 24,
      1, 2, -1, 1, 4000, -20, 4, 0, 200, 4000,
      -24, 1.5, 30, 150, 0, -24, 1.5, 30, 150, 0, -24, 1.5, 30, 150, 0,
    ]);
  });
  it("encodes each supported compressor and saturation enumeration", () => {
    for (const [code, topology] of ["optical", "vari_mu", "fet", "vca"].entries()) {
      const value = params();
      value.compressor.topology = topology;
      expect(packLiveControls(value)[38]).toBe(code);
    }
    for (const [code, character] of (["Warm", "Thick", "Crisp", "Clean", "Tube", "Tape", "Transformer"] as const).entries()) {
      const value = params();
      value.saturation.character = character;
      expect(packLiveControls(value)[41]).toBe(code);
    }
  });
  it("publishes one bounded data and version snapshot and preserves it after invalid input", () => {
    const value = params();
    const controls = createLiveControls(value, 7);
    expect(controls.buffer.byteLength).toBe(664);
    const header = new Int32Array(controls.buffer, 0, 4);
    const payload = new Float64Array(controls.buffer, 16, 81);
    expect(Array.from(header)).toEqual([2, 7, 0, 0]);
    expect(Array.from(payload)).toEqual(Array.from(packLiveControls(value)));
    controls.publish({ ...value, inputGainDb: 4 }, 8);
    expect(Array.from(header)).toEqual([4, 8, 0, 0]);
    expect(payload[3]).toBe(4);
    const before = Array.from(payload);
    expect(() => { controls.publish({ ...value, inputGainDb: Number.NaN }, 9); }).toThrow("finite");
    expect(Array.from(header)).toEqual([4, 8, 0, 0]);
    expect(Array.from(payload)).toEqual(before);
  });
  it("rejects incomplete bands and unsupported enums before publication", () => {
    const value = params();
    expect(() => packLiveControls({ ...value, bands: value.bands.slice(1) })).toThrow("five EQ");
    expect(() => packLiveControls({ ...value, compressor: { ...value.compressor, topology: "unknown" } })).toThrow("unsupported");
  });
  it.each([2, 4])("rejects %i multiband bands before creating or changing a shared packet", (count) => {
    const value = params();
    const malformed = params();
    if (count === 2) malformed.multiband.bands.pop();
    else malformed.multiband.bands.push({ ...malformed.multiband.bands[0] });
    expect(() => packLiveControls(malformed)).toThrow("three multiband bands");
    expect(() => createLiveControls(malformed, 1)).toThrow("three multiband bands");

    const controls = createLiveControls(value, 7);
    const before = new Uint8Array(controls.buffer).slice();
    expect(() => { controls.publish(malformed, 8); }).toThrow("three multiband bands");
    expect(new Uint8Array(controls.buffer)).toEqual(before);

    controls.publish({ ...value, inputGainDb: 4 }, 9);
    expect(Array.from(new Int32Array(controls.buffer, 0, 4))).toEqual([4, 9, 0, 0]);
    expect(new Float64Array(controls.buffer, 16, 81)[3]).toBe(4);
  });
  it.each(["EQ", "multiband"] as const)("rejects sparse %s bands before changing the packet", (module) => {
    const value = params();
    const malformed = params();
    const bands = module === "EQ" ? malformed.bands : malformed.multiband.bands;
    Reflect.deleteProperty(bands, 1);
    expect(() => packLiveControls(malformed)).toThrow("81 values");
    expect(() => createLiveControls(malformed, 1)).toThrow("81 values");

    const controls = createLiveControls(value, 7);
    const before = new Uint8Array(controls.buffer).slice();
    expect(() => { controls.publish(malformed, 8); }).toThrow("81 values");
    expect(new Uint8Array(controls.buffer)).toEqual(before);
    controls.publish(value, 9);
    expect(Array.from(new Int32Array(controls.buffer, 0, 4))).toEqual([4, 9, 0, 0]);
  });
  it("preserves the 81-value zero extension for legacy settings", () => {
    const legacy = params();
    Reflect.deleteProperty(legacy, "deHarsh");
    Reflect.deleteProperty(legacy, "multiband");
    Reflect.deleteProperty(legacy.compressor, "autoRelease");
    Reflect.deleteProperty(legacy.stereo, "midGainDb");
    Reflect.deleteProperty(legacy.stereo, "sideGainDb");
    const packed = packLiveControls(legacy);
    expect(packed.length).toBe(81);
    expect(Array.from(packed.slice(56))).toEqual(new Array<number>(25).fill(0));
    const controls = createLiveControls(legacy, 7);
    expect(Array.from(new Float64Array(controls.buffer, 16, 81))).toEqual(Array.from(packed));
    expect(Array.from(new Int32Array(controls.buffer, 0, 4))).toEqual([2, 7, 0, 0]);
  });
});


describe("negotiated append-only live controls", () => {
  it("retains 81 legacy values and appends the explicit v1 algorithm in ABI 2", () => {
    const legacy = packLiveControls(params());
    const versioned = packLiveControls(params(), 2);
    expect(legacy.length).toBe(81);
    expect(versioned.length).toBe(82);
    expect(Array.from(versioned.subarray(0, 81))).toEqual(Array.from(legacy));
    expect(versioned[81]).toBe(1);
    expect(packLiveControls({ ...params(), algorithmVersion: 0 }, 2)[81]).toBe(1);
    expect(packLiveControls({ ...params(), algorithmVersion: 1 })).toEqual(legacy);
    const publication = createLiveControls(params(), 1, 2);
    expect(publication.buffer.byteLength).toBe(672);
    expect(new Float64Array(publication.buffer, 16, 82)[81]).toBe(1);
  });
  it("rejects explicit null versions and unsupported packet ABIs", () => {
    const invalid = { ...params(), algorithmVersion: 1 };
    Reflect.set(invalid, "algorithmVersion", null);
    expect(() => packLiveControls(invalid)).toThrow("Unsupported DSP algorithm version");
    expect(() => packLiveControls(params(), 3)).toThrow("Unsupported live control ABI");
  });
  it.each([2, -1, 1.5, NaN, Infinity])("rejects algorithm %s before publishing a transaction", (algorithmVersion) => {
    const publication = createLiveControls(params(), 1, 2);
    const before = new Uint8Array(publication.buffer).slice();
    expect(() => { publication.publish({ ...params(), algorithmVersion }, 2); }).toThrow("Unsupported DSP algorithm version");
    expect(new Uint8Array(publication.buffer)).toEqual(before);
    expect(() => packLiveControls({ ...params(), algorithmVersion })).toThrow("Unsupported DSP algorithm version");
  });
});
