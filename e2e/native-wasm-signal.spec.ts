import { expect, test } from "@playwright/test"
import { decode, fixture, dbRatio } from "./audio-fixture"

const neutral = {
  inputGainDb: 0, eqEnabled: false,
  compressor: { enabled: false }, saturation: { enabled: false },
  stereo: { enabled: false }, limiter: { enabled: false }, repair: { enabled: false },
  ditherBits: 0,
}

test("native render preserves uploaded PCM, applies gain and honors bypass", async ({ request }) => {
  const source = fixture()
  const decoded = decode(source)
  const render = async (params: Record<string, unknown>) => {
    const response = await request.post("/api/master/render", { multipart: {
      file: { name: "independent-tone.wav", mimeType: "audio/wav", buffer: source },
      bitDepth: "32", params: JSON.stringify(params),
    } })
    expect(response.status()).toBe(200)
    expect(response.headers()["content-type"]).toContain("audio/wav")
    return decode(await response.body())
  }
  const dry = await render(neutral)
  expect(dry.rate).toBe(48000)
  expect(dry.left).toHaveLength(48000)
  expect(Math.max(...dry.left.map((x, i) => Math.abs(x - (decoded.left[i] ?? 0))))).toBeLessThan(1 / 32768)
  const gain = await render({ ...neutral, inputGainDb: 6 })
  expect(dbRatio(gain.left, dry.left)).toBeCloseTo(6, 2)
  expect(dbRatio(gain.right, dry.right)).toBeCloseTo(6, 2)
  const bypass = await render({ ...neutral, inputGainDb: 6, bypass: true })
  expect(bypass.left).toEqual(dry.left)
  expect(bypass.right).toEqual(dry.right)
})

test("actual Go WASM bridge matches native PCM for independent parameter changes", async ({ page, request }) => {
  await page.goto("/")
  await page.addScriptTag({ url: "/wasm/wasm_exec.js" })
  await page.evaluate(async () => {
    const scope = globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run: (instance: WebAssembly.Instance) => Promise<void> }; aurialisDSPInit?: (rate: number) => boolean }
    const go = new scope.Go()
    const response = await fetch("/wasm/aurialis-dsp.wasm")
    if (!response.ok) throw new Error(`WASM HTTP ${response.status}`)
    const result = await WebAssembly.instantiateStreaming(response, go.importObject)
    void go.run(result.instance)
  })
  const source = fixture()
  const decoded = decode(source)
  for (const params of [neutral, { ...neutral, inputGainDb: 6 }, { ...neutral, inputGainDb: 6, bypass: true }, { ...neutral, stereo: { enabled: true, widthPct: 0, monoBass: false } }, { ...neutral, eqEnabled: true, bands: Array.from({ length: 5 }, (_, index) => ({ freqHz: 1000, gainDb: index === 2 ? 6 : 0, q: 1, type: "peaking", enabled: index === 2 })) }]) {
    const nativeResponse = await request.post("/api/master/render", { multipart: { file: { name: "tone.wav", mimeType: "audio/wav", buffer: source }, bitDepth: "32", params: JSON.stringify(params) } })
    expect(nativeResponse.status()).toBe(200)
    const native = decode(await nativeResponse.body())
    const wasm = await page.evaluate(({ left, right, params }) => {
      const dsp = globalThis as unknown as { aurialisDSPInit: (rate: number) => boolean; aurialisDSPSetParams: (params: string) => boolean; aurialisDSPProcessBlock: (left: Float32Array, right: Float32Array) => number }
      if (!dsp.aurialisDSPInit(48000) || !dsp.aurialisDSPSetParams(JSON.stringify(params))) throw new Error("WASM initialization failed")
      const l = Float32Array.from(left); const r = Float32Array.from(right)
      if (dsp.aurialisDSPProcessBlock(l, r) !== l.length) throw new Error("WASM frame loss")
      return { left: Array.from(l), right: Array.from(r) }
    }, { left: decoded.left, right: decoded.right, params })
    expect(wasm.left).toHaveLength(native.left.length)
    for (const channel of ["left", "right"] as const) {
      const error = Math.max(...native[channel].map((sample, i) => Math.abs(sample - (wasm[channel][i] ?? Infinity))))
      expect(error, `native/WASM ${channel}: ${JSON.stringify(params)}`).toBeLessThan(1e-6)
    }
  }
})
