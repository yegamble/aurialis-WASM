import { Blob as NodeBlob } from "node:buffer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDefaultAdvancedParams } from "../audio-dsp"
import { engineParams, measuredLevels, previewWAV, processPreview, readCanonicalWAV } from "../browser-engine"

afterEach(() => vi.unstubAllGlobals())
describe("shared engine browser boundary", () => {
  it("preserves every uploaded frame and both channels in a float WAV roundtrip", async () => {
    vi.stubGlobal("Blob", NodeBlob)
    const source = { left: Float32Array.from([0, 0.125, -0.75, 1.5]), right: Float32Array.from([0.25, -0.375, 0.5, -1.25]), sampleRate: 44100 }
    const restored = await readCanonicalWAV(previewWAV(source))
    expect(restored).toEqual(source)
    expect(measuredLevels(restored).peak).toBe("3.5")
  })
  it("maps independent persisted modules into the native API schema without mutating settings", () => {
    const advanced = createDefaultAdvancedParams()
    advanced.input = 6; advanced.eqBands[2].gainDb = -3; advanced.compressor.attack = 47; advanced.stereo.width = 132
    const before = structuredClone(advanced)
    const params = engineParams(advanced)
    expect(params.inputGainDb).toBe(6)
    expect(params.bands[2]?.gainDb).toBe(-3)
    expect(params.compressor.attackMs).toBe(47)
    expect(params.stereo.widthPct).toBe(132)
    expect(params.limiter.truePeak).toBe(false)
    expect(advanced).toEqual(before)
  })
  it("uses actual shared-engine output for every block and leaves the source unchanged", async () => {
    const left = Float32Array.from({ length: 5000 }, (_, i) => i / 10000)
    const right = Float32Array.from(left, n => -n)
    const process = vi.fn((l: Float32Array, r: Float32Array, outL: Float32Array, outR: Float32Array) => { outL.set(l.map(n => n * 2)); outR.set(r.map(n => n * 2)); return l.length })
    vi.stubGlobal("window", { aurialisDSPReady: true, aurialisDSPInit: () => true, aurialisDSPSetParams: () => true, aurialisDSPReset: () => true, aurialisDSPProcessBlock: process })
    const rendered = await processPreview({ left, right, sampleRate: 48000 }, createDefaultAdvancedParams())
    expect(process).toHaveBeenCalledTimes(2)
    expect(rendered.left).toEqual(left.map(n => n * 2))
    expect(rendered.right).toEqual(right.map(n => n * 2))
    expect(left[4999]).toBeCloseTo(0.4999)
  })
  it("surfaces bridge rejection instead of silently returning original audio", async () => {
    vi.stubGlobal("window", { aurialisDSPReady: true, aurialisDSPInit: () => true, aurialisDSPSetParams: () => false })
    await expect(processPreview({ left: new Float32Array(2), right: new Float32Array(2), sampleRate: 48000 }, createDefaultAdvancedParams())).rejects.toThrow("rejected")
  })
})
