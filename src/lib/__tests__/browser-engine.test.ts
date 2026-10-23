import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScriptV2 } from "../deep-mastering";
import { clampAdvancedToSampleRate, createDefaultAdvancedParams } from "../audio-dsp";
import {
  engineParams,
  importAudio,
  measureAudio,
  measureScriptAudio,
  normalizeSimpleAudio,
  trackMetrics,
  previewWAV,
  processPreview,
  readCanonicalWAV,
  serverRender,
  sourcePeaks,
} from "../browser-engine";

afterEach(() => vi.unstubAllGlobals());
describe("shared engine browser boundary", () => {
  it("retains narrow transients across the full source in a bounded detailed waveform envelope", () => {
    const left = new Float32Array(8192), right = new Float32Array(8192);
    left[0] = 0.25; right[4097] = -0.75; left[8191] = 0.5;
    const peaks = sourcePeaks({ left, right, sampleRate: 48000 });
    expect(peaks).toHaveLength(2048);
    expect(peaks[0]).toBe(0.25);
    expect(peaks[1024]).toBe(0.75);
    expect(peaks[2047]).toBe(0.5);
    expect(peaks.filter((peak) => peak !== 0)).toHaveLength(3);
  });
  it("explains unreachable local requests and preserves cancellation", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(serverRender(new Blob(["source"]), {}, 32)).rejects.toThrow("Could not reach the local audio server");
    await expect(measureAudio(new Blob(["source"]))).rejects.toThrow("local-network permission");
    const controller = new AbortController();
    controller.abort();
    fetch.mockClear();
    await expect(measureAudio(new Blob(["source"]), {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves server rejection details and handles non-JSON errors", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ detail: "An audio job is already running. Try again shortly." }),
    });
    vi.stubGlobal("fetch", fetch);
    await expect(serverRender(new Blob(["source"]), {}, 32)).rejects.toThrow("already running");
    fetch.mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError("HTML error")) });
    await expect(measureAudio(new Blob(["source"]))).rejects.toThrow("HTTP 502");
  });
  it("explains transfers interrupted after the server has sent response headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.reject(new TypeError("Failed to fetch")),
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON")),
    }));
    await expect(serverRender(new Blob(["source"]), {}, 32)).rejects.toThrow("response was interrupted or unreadable");
    await expect(measureAudio(new Blob(["source"]))).rejects.toThrow("response was interrupted or unreadable");
  });
  it("cancels native renders before dispatch and while consuming their response", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => { controller.abort(); return Promise.resolve(new Blob(["rendered"])); },
    });
    vi.stubGlobal("fetch", fetch);
    await expect(serverRender(new Blob(["source"]), {}, 32, controller.signal)).rejects.toThrow();
    expect((fetch.mock.calls[0]?.[1] as { signal: AbortSignal }).signal).toBe(controller.signal);
    fetch.mockClear();
    await expect(serverRender(new Blob(["source"]), {}, 32, controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves every uploaded frame and both channels in a float WAV roundtrip", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const source = {
      left: Float32Array.from([0, 0.125, -0.75, 1.5]),
      right: Float32Array.from([0.25, -0.375, 0.5, -1.25]),
      sampleRate: 44100,
    };
    const restored = await readCanonicalWAV(previewWAV(source));
    expect(restored).toEqual(source);
  });
  it("maps independent persisted modules into the native API schema without mutating settings", () => {
    const advanced = createDefaultAdvancedParams();
    advanced.input = 6;
    advanced.eqBands[2].gainDb = -3;
    advanced.compressor.attack = 47;
    advanced.stereo.width = 132;
    const before = structuredClone(advanced);
    const params = engineParams(advanced);
    expect(params.inputGainDb).toBe(6);
    expect(params.bands[2]?.gainDb).toBe(-3);
    expect(params.compressor.attackMs).toBe(47);
    expect(params.stereo.widthPct).toBe(132);
    expect(params.limiter.truePeak).toBe(false);
    expect(advanced).toEqual(before);
  });
  it("uses actual shared-engine output for every block and leaves the source unchanged", async () => {
    const left = Float32Array.from({ length: 5000 }, (_, i) => i / 10000);
    const right = Float32Array.from(left, (n) => -n);
    const process = vi.fn(
      (
        l: Float32Array,
        r: Float32Array,
        outL: Float32Array,
        outR: Float32Array,
      ) => {
        outL.set(l.map((n) => n * 2));
        outR.set(r.map((n) => n * 2));
        return l.length;
      },
    );
    vi.stubGlobal("window", {
      aurialisDSPReady: true,
      aurialisDSPInit: () => true,
      aurialisDSPSetParams: () => true,
      aurialisDSPReset: () => true,
      aurialisDSPProcessBlock: process,
    });
    const rendered = await processPreview(
      { left, right, sampleRate: 48000 },
      createDefaultAdvancedParams(),
    );
    expect(process).toHaveBeenCalledTimes(2);
    expect(rendered.left).toEqual(left.map((n) => n * 2));
    expect(rendered.right).toEqual(right.map((n) => n * 2));
    expect(left[4999]).toBeCloseTo(0.4999);
  });
  it("surfaces bridge rejection instead of silently returning original audio", async () => {
    vi.stubGlobal("window", {
      aurialisDSPReady: true,
      aurialisDSPInit: () => true,
      aurialisDSPSetParams: () => false,
    });
    await expect(
      processPreview(
        {
          left: new Float32Array(2),
          right: new Float32Array(2),
          sampleRate: 48000,
        },
        createDefaultAdvancedParams(),
      ),
    ).rejects.toThrow("rejected");
  });
  it("serializes yielding previews so concurrent projects cannot share engine parameters", async () => {
    let gain = 1;
    vi.stubGlobal("window", {
      aurialisDSPReady: true,
      aurialisDSPInit: () => true,
      aurialisDSPSetParams: (json: string) => {
        const params = JSON.parse(json) as { inputGainDb: number };
        gain = params.inputGainDb;
        return true;
      },
      aurialisDSPReset: () => true,
      aurialisDSPProcessBlock: (
        left: Float32Array,
        right: Float32Array,
        outLeft: Float32Array,
        outRight: Float32Array,
      ) => {
        outLeft.set(left.map((value) => value * gain));
        outRight.set(right.map((value) => value * gain));
        return left.length;
      },
    });
    const source = {
      left: new Float32Array(20000).fill(0.25),
      right: new Float32Array(20000).fill(-0.125),
      sampleRate: 48000,
    };
    const first = createDefaultAdvancedParams();
    first.input = 2;
    const second = createDefaultAdvancedParams();
    second.input = 3;
    const [a, b] = await Promise.all([
      processPreview(source, first),
      processPreview(source, second),
    ]);
    expect(a.left.every((value) => value === 0.5)).toBe(true);
    expect(a.right.every((value) => value === -0.25)).toBe(true);
    expect(b.left.every((value) => value === 0.75)).toBe(true);
    expect(b.right.every((value) => value === -0.375)).toBe(true);
  });
  it("rejects a cancelled project before initializing the shared engine", async () => {
    const init = vi.fn(() => true);
    vi.stubGlobal("window", { aurialisDSPReady: true, aurialisDSPInit: init });
    const controller = new AbortController();
    controller.abort();
    await expect(
      processPreview(
        {
          left: new Float32Array(2),
          right: new Float32Array(2),
          sampleRate: 48000,
        },
        createDefaultAdvancedParams(),
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(init).not.toHaveBeenCalled();
  });
});

// Mapping assertions complement compiled native/WASM signal tests: changing one
// persisted control must change only its explicit engine field.
describe("complete supported control mapping", () => {
  it("preserves every EQ band's frequency, gain, Q, type and bypass independently", () => {
    const settings = createDefaultAdvancedParams();
    settings.eqBands[0].type = "highpass";
    for (const [index, band] of settings.eqBands.entries()) {
      band.freqHz = 100 + index * 400;
      band.gainDb = index - 3;
      band.q = 0.5 + index;
      band.enabled = index % 2 === 0;
    }
    const params = engineParams(settings);
    expect(params.bands.map((band) => band.type)).toEqual([
      "high_pass", "low_shelf", "peaking", "peaking", "high_shelf",
    ]);
    for (const [index, band] of settings.eqBands.entries()) {
      expect(params.bands.at(index)).toMatchObject({
        freqHz: band.freqHz, gainDb: band.gainDb, q: band.q, enabled: band.enabled,
      });
    }
    settings.eqEnabled = false;
    expect(engineParams(settings).eqEnabled).toBe(false);
    expect(engineParams(settings).bands).toEqual(params.bands);
  });
  it("maps individual compressor, saturation, stereo and supported limiter fields", () => {
    const settings = createDefaultAdvancedParams();
    settings.compressor = { ...settings.compressor, enabled: false, threshold: -22, ratio: 4.1, attack: 17, release: 340, knee: 8, makeup: 2 };
    settings.saturationModule = { enabled: false, drive: 42, character: "Thick" };
    settings.stereo = { ...settings.stereo, enabled: false, width: 127, monoBass: true };
    settings.limiter = { enabled: true, ceiling: -2, release: 137, truePeak: false, targetLufs: -15 };
    const snapshot = structuredClone(settings);
    expect(engineParams(settings)).toMatchObject({
      compressor: { enabled: false, thresholdDb: -22, ratio: 4.1, attackMs: 17, releaseMs: 340, kneeDb: 8, makeupDb: 2 },
      saturation: { enabled: false, amount: 42, character: "Thick" },
      stereo: { enabled: false, widthPct: 127, monoBass: true },
      limiter: { enabled: true, ceilingDbtp: -2, releaseMs: 137, truePeak: false, targetLufs: -15 },
    });
    expect(settings).toEqual(snapshot);
  });
  it("rejects unavailable repair and true-peak limiting instead of silently dropping enabled settings", () => {
    const settings = createDefaultAdvancedParams();
    settings.repair.enabled = true;
    expect(() => engineParams(settings)).toThrow("repair is unavailable");
    settings.repair.enabled = false;
    settings.limiter.enabled = true;
    settings.limiter.truePeak = true;
    expect(() => engineParams(settings)).toThrow("True-peak limiting is unavailable");
  });
});

const measured = {
  integratedLufs: -20, shortTermLufs: -20, truePeakDbtp: -12,
  samplePeakDbfs: -12.2, dynamicRangeDb: 4, correlation: 0.8,
  lowBassCorrelation: 0.9, dcLeftDbfs: -100, dcRightDbfs: -100,
  clippingSamples: 0, gainReductionDb: 1,
};
function measurementResponse(metrics = measured) {
  return { sampleRate: 48000, frames: 48000, duration: 1,
    beforeMetrics: measured, afterMetrics: metrics };
}
describe("actual audio measurement and explicit Simple normalization", () => {
  it("imports canonical audio and source measurements with one native request", async () => {
    const canonical = new Blob([new Uint8Array(384044)]);
    const fetch = vi.fn().mockResolvedValue({ ok: true,
      headers: new Headers({ "X-Aurialis-Source-Metrics": JSON.stringify(measurementResponse()) }),
      blob: () => Promise.resolve(canonical),
    });
    vi.stubGlobal("fetch", fetch);
    const result = await importAudio(new Blob(["source"]));
    expect(result).toEqual({ canonical, measurement: measurementResponse() });
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]?.[1] as { body: FormData };
    expect(request.body.get("params")).toBe('{"bypass":true}');
    expect(request.body.get("bitDepth")).toBe("32");
    expect(request.body.get("format")).toBeNull();
  });
  it("binds import identities to the measured sample layout and rejects malformed hashes", async () => {
    const base = measurementResponse();
    const sourceIdentity = { pcmHash: "a".repeat(64), sampleRate: base.sampleRate, frames: base.frames };
    const response = (identity: unknown) => ({ ok: true, headers: new Headers({ "X-Aurialis-Source-Metrics": JSON.stringify({ ...base, sourceIdentity: identity }) }), blob: () => Promise.resolve(new NodeBlob([new Uint8Array(44 + base.frames * 8)])) });
    const fetch = vi.fn().mockResolvedValue(response(sourceIdentity)); vi.stubGlobal("fetch", fetch);
    expect((await importAudio(new Blob(["source"]))).measurement.sourceIdentity).toEqual(sourceIdentity);
    for (const invalid of [{ ...sourceIdentity, frames: sourceIdentity.frames + 1 }, { ...sourceIdentity, pcmHash: "wrong" }]) {
      fetch.mockResolvedValue(response(invalid)); await expect(importAudio(new Blob(["source"]))).rejects.toThrow("source identity");
    }
  });
  it("rejects absent, malformed and incomplete source responses without another upload", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const cancel = vi.fn(() => Promise.resolve());
    for (const value of [null, "invalid", JSON.stringify({ ...measurementResponse(), duration: 5 })]) {
      fetch.mockResolvedValue({ ok: true, body: { cancel }, headers: new Headers(value ? { "X-Aurialis-Source-Metrics": value } : {}), blob: () => Promise.resolve(new Blob([])) });
      await expect(importAudio(new Blob(["source"]))).rejects.toThrow("measurements");
    }
    expect(cancel).toHaveBeenCalledTimes(3);
    fetch.mockResolvedValue({ ok: true, headers: new Headers({ "X-Aurialis-Source-Metrics": JSON.stringify(measurementResponse()) }), blob: () => Promise.resolve(new Blob(["truncated"])) });
    await expect(importAudio(new Blob(["source"]))).rejects.toThrow("transfer was incomplete");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("retains cancellation while receiving an imported source", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true,
      headers: new Headers({ "X-Aurialis-Source-Metrics": JSON.stringify(measurementResponse()) }),
      blob: () => { controller.abort(); return Promise.resolve(new Blob([])); },
    }));
    await expect(importAudio(new Blob(["source"]), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("requests JSON measurements for the supplied source/settings and maps actual readings", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(measurementResponse()) });
    vi.stubGlobal("fetch", fetch);
    const result = await measureAudio(new Blob(["fixture"]), { inputGainDb: 2 });
    expect(result.afterMetrics).toEqual(measured);
    expect(trackMetrics(result.afterMetrics)).toEqual({ lufs: -20, peak: -12, range: 4, dynamics: 4, correlation: 0.8 });
    const request = fetch.mock.calls[0]?.[1] as { body: FormData; headers: object };
    expect(request.headers).toEqual({ Accept: "application/json" });
    expect(request.body.get("format")).toBe("json");
    expect(request.body.get("params")).toBe('{"inputGainDb":2}');
  });
  it("measures the complete accepted script through the shared JSON adapter without requesting a float artifact", async () => {
    const binary = vi.fn(), fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(measurementResponse()), blob: binary });
    vi.stubGlobal("fetch", fetch);
    const script: ScriptV2 = { version: "2.0", source: { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 }, revision: 1,
      profile: "Warm Analog", summary: "Accepted plan", chainParams: engineParams(createDefaultAdvancedParams()),
      sections: [{ id: "all", name: "All", roleHint: "unknown", startFrame: 0, endFrame: 48000, confidence: 0 }], moves: [], findings: [], beforeMetrics: measured };
    const controller = new AbortController();
    expect((await measureScriptAudio(new Blob(["source"]), script, controller.signal)).afterMetrics).toEqual(measured);
    const request = fetch.mock.calls[0]?.[1] as { body: FormData; headers: object; signal: AbortSignal };
    expect(request.headers).toEqual({ Accept: "application/json" }); expect(request.signal).toBe(controller.signal);
    expect(request.body.get("script")).toBe(JSON.stringify(script)); expect(request.body.get("format")).toBe("json");
    expect(request.body.get("params")).toBeNull(); expect(request.body.get("bitDepth")).toBeNull(); expect(binary).not.toHaveBeenCalled();
    controller.abort(); fetch.mockClear();
    await expect(measureScriptAudio(new Blob(["source"]), script, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects incomplete, non-finite and inconsistent measurements instead of creating zero metrics", async () => {
    const bodies = [
      { ...measurementResponse(), frames: 2 },
      { ...measurementResponse(), afterMetrics: { ...measured, integratedLufs: Number.NaN } },
      { ...measurementResponse(), beforeMetrics: {} },
    ];
    for (const body of bodies) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) }));
      await expect(measureAudio(new Blob(["fixture"]))).rejects.toThrow("measurements");
    }
  });
  it("preserves server validation errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ detail: "Corrupt source WAV" }) }));
    await expect(measureAudio(new Blob(["fixture"]))).rejects.toThrow("Corrupt source WAV");
  });
  it("normalizes only through an explicit returned settings snapshot and checks measured output", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(measurementResponse()) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(measurementResponse({ ...measured, integratedLufs: -14.1, truePeakDbtp: -2 })) });
    vi.stubGlobal("fetch", fetch);
    const settings = createDefaultAdvancedParams();
    const original = structuredClone(settings);
    const next = await normalizeSimpleAudio(new Blob(["fixture"]), settings, -14);
    expect(next.input).toBe(6);
    expect(settings).toEqual(original);
    expect(next.compressor).toEqual(original.compressor);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects unreachable targets, silence and peak violations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(measurementResponse()) }));
    await expect(normalizeSimpleAudio(new Blob(["fixture"]), createDefaultAdvancedParams(), -14)).rejects.toThrow("could not be reached");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(measurementResponse({ ...measured, integratedLufs: -70 })) }));
    await expect(normalizeSimpleAudio(new Blob(["fixture"]), createDefaultAdvancedParams(), -14)).rejects.toThrow("too quiet");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(measurementResponse({ ...measured, integratedLufs: -14, truePeakDbtp: 0 })) }));
    await expect(normalizeSimpleAudio(new Blob(["fixture"]), createDefaultAdvancedParams(), -14)).rejects.toThrow("peak ceiling");
  });
  it("converges using measured compressor response instead of assuming one LU per input dB", async () => {
    const inputs: number[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, request: { body: FormData }) => {
      const raw = request.body.get("params");
      if (typeof raw !== "string") throw new Error("Missing render parameters");
      const params = JSON.parse(raw) as { inputGainDb: number };
      inputs.push(params.inputGainDb);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(measurementResponse({
        ...measured, integratedLufs: -20 + params.inputGainDb / 4, truePeakDbtp: -2,
      })) });
    }));
    const settings = createDefaultAdvancedParams();
    const before = structuredClone(settings);
    const next = await normalizeSimpleAudio(new Blob(["fixture"]), settings, -14);
    expect(next.input).toBeCloseTo(24);
    expect(inputs).toEqual([0, 6, 24]);
    expect(settings).toEqual(before);
    expect({ ...next, input: before.input }).toEqual(before);
  });
  it("bounds plateau attempts and never returns an unmeasured candidate", async () => {
    const inputs: number[] = [];
    const fetch = vi.fn((_url: string, request: { body: FormData }) => {
      const raw = request.body.get("params");
      if (typeof raw !== "string") throw new Error("Missing render parameters");
      const params = JSON.parse(raw) as { inputGainDb: number };
      inputs.push(params.inputGainDb);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(measurementResponse()) });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(normalizeSimpleAudio(new Blob(["fixture"]), createDefaultAdvancedParams(), -14)).rejects.toThrow("could not be reached");
    expect(inputs.length).toBeLessThanOrEqual(8);
    expect(inputs.every((input) => Number.isFinite(input) && input >= -36 && input <= 36)).toBe(true);
  });
  it("does not dispatch another normalization request after cancellation during a response", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ ok: true, json: () => Promise.resolve(measurementResponse()) });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(normalizeSimpleAudio(new Blob(["fixture"]), createDefaultAdvancedParams(), -14, controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("source bandwidth constraints", () => {
  it("retains valid disabled zero-valued modules from accepted script baselines", () => {
    const settings = createDefaultAdvancedParams();
    settings.deHarsh = { enabled: false, frequencyHz: 0, thresholdDb: 0, rangeDb: 0 };
    settings.multiband = { enabled: false, lowMidHz: 0, midHighHz: 0, bands: [0, 1, 2].map(() => ({ thresholdDb: 0, ratio: 0, attackMs: 0, releaseMs: 0, makeupDb: 0 })) as typeof settings.multiband.bands };
    const next = clampAdvancedToSampleRate(settings, 48000);
    expect(engineParams(next)).toEqual(engineParams(settings));
    expect(settings.deHarsh.frequencyHz).toBe(0);
  });
  for (const rate of [8000, 16000, 44100, 48000, 96000, 192000]) {
    it(`keeps ${String(rate)} Hz controls within the visible source bandwidth without altering other settings`, () => {
      const settings = createDefaultAdvancedParams();
      settings.compressor.threshold = -23;
      settings.stereo.width = 137;
      const before = structuredClone(settings);
      const next = clampAdvancedToSampleRate(settings, rate);
      expect(next.eqBands.every((band) => band.freqHz <= Math.min(18000, Math.floor(rate * 0.47)))).toBe(true);
      expect({ ...next, eqBands: before.eqBands, deHarsh: before.deHarsh, multiband: before.multiband }).toEqual(before);
      expect(next.deHarsh.frequencyHz).toBeLessThanOrEqual(rate * 0.47);
      expect(next.multiband.midHighHz).toBeLessThanOrEqual(rate * 0.47);
      expect(settings).toEqual(before);
      expect(engineParams(next).bands.map((band) => band.freqHz)).toEqual(next.eqBands.map((band) => band.freqHz));
    });
  }
});
