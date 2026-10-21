import type {
  AdvancedParams,
  EQBandParams,
  ExportBitDepth,
  Metrics,
  Track,
} from "./types"

const LN10_OVER_20 = Math.LN10 / 20

function dbToLin(db: number): number {
  return Math.exp(db * LN10_OVER_20)
}

function linToDb(lin: number): number {
  if (lin <= 1e-12) return -120
  return 20 * Math.log10(lin)
}

function defaultEqBands(): [
  EQBandParams,
  EQBandParams,
  EQBandParams,
  EQBandParams,
  EQBandParams,
] {
  return [
    {
      id: "sub",
      label: "Sub",
      type: "highpass",
      freqHz: 35,
      gainDb: 0,
      q: 0.707,
      enabled: true,
    },
    {
      id: "low",
      label: "Low",
      type: "lowshelf",
      freqHz: 110,
      gainDb: 0,
      q: 0.707,
      enabled: true,
    },
    {
      id: "mid",
      label: "Mid",
      type: "peaking",
      freqHz: 850,
      gainDb: 0,
      q: 1.0,
      enabled: true,
    },
    {
      id: "presence",
      label: "Presence",
      type: "peaking",
      freqHz: 3200,
      gainDb: 0,
      q: 1.0,
      enabled: true,
    },
    {
      id: "air",
      label: "Air",
      type: "highshelf",
      freqHz: 11000,
      gainDb: 0,
      q: 0.707,
      enabled: true,
    },
  ]
}

type LegacyAdvancedSeed = {
  input?: number
  threshold?: number
  ratio?: number
  attack?: number
  release?: number
  width?: number
  saturation?: number
}

export function createDefaultAdvancedParams(
  seed: LegacyAdvancedSeed = {},
): AdvancedParams {
  const input = seed.input ?? 0
  const threshold = seed.threshold ?? -18
  const ratio = seed.ratio ?? 2.5
  const attack = seed.attack ?? 25
  const release = seed.release ?? 220
  const width = seed.width ?? 100
  const saturation = seed.saturation ?? 8
  return {
    input,
    threshold,
    ratio,
    attack,
    release,
    width,
    saturation,
    eqEnabled: true,
    eqBands: defaultEqBands(),
    compressor: {
      enabled: true,
      threshold,
      ratio,
      attack,
      release,
      knee: 6,
      makeup: 1.5,
    },
    saturationModule: {
      enabled: true,
      drive: saturation,
      character: "Warm",
    },
    stereo: {
      enabled: true,
      width,
      monoBass: true,
    },
    limiter: {
      enabled: true,
      ceiling: -1.0,
      targetLufs: -14.0,
      release: 85,
      truePeak: true,
    },
    repair: {
      enabled: true,
      declick: false,
      declip: false,
      phaseAlign: true,
    },
  }
}

type BiquadCoeffs = {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

function calcBiquadCoeffs(band: EQBandParams, sampleRate: number): BiquadCoeffs {
  if (!band.enabled) {
    return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
  }
  const fc = Math.max(20, Math.min(0.47 * sampleRate, band.freqHz))
  const q = Math.max(0.1, Math.min(18, band.q))
  const w0 = (2 * Math.PI * fc) / sampleRate
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const alpha = sinW0 / (2 * q)
  const A = Math.pow(10, band.gainDb / 40)

  let b0 = 1
  let b1 = 0
  let b2 = 0
  let a0 = 1
  let a1 = 0
  let a2 = 0

  switch (band.type) {
    case "highpass":
      b0 = (1 + cosW0) / 2
      b1 = -(1 + cosW0)
      b2 = (1 + cosW0) / 2
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
    case "lowshelf": {
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
      b0 = A * (A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha)
      b1 = 2 * A * (A - 1 - (A + 1) * cosW0)
      b2 = A * (A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha)
      a0 = A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha
      a1 = -2 * (A - 1 + (A + 1) * cosW0)
      a2 = A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha
      break
    }
    case "peaking":
      b0 = 1 + alpha * A
      b1 = -2 * cosW0
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cosW0
      a2 = 1 - alpha / A
      break
    case "highshelf": {
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
      b0 = A * (A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha)
      b1 = -2 * A * (A - 1 + (A + 1) * cosW0)
      b2 = A * (A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha)
      a0 = A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha
      a1 = 2 * (A - 1 - (A + 1) * cosW0)
      a2 = A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha
      break
    }
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  }
}

export function computeEqMagnitudeDb(
  freqHz: number,
  bands: readonly EQBandParams[],
  sampleRate = 48000,
): number {
  const w = (2 * Math.PI * freqHz) / sampleRate
  const cos1 = Math.cos(w)
  const sin1 = Math.sin(w)
  const cos2 = Math.cos(2 * w)
  const sin2 = Math.sin(2 * w)

  let totalGainDb = 0
  for (const band of bands) {
    if (!band.enabled) continue
    if (band.type !== "highpass" && Math.abs(band.gainDb) < 1e-4) continue
    const c = calcBiquadCoeffs(band, sampleRate)
    const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2
    const numIm = -(c.b1 * sin1 + c.b2 * sin2)
    const denRe = 1 + c.a1 * cos1 + c.a2 * cos2
    const denIm = -(c.a1 * sin1 + c.a2 * sin2)
    const numMagSq = numRe * numRe + numIm * numIm
    const denMagSq = Math.max(1e-18, denRe * denRe + denIm * denIm)
    totalGainDb += 10 * Math.log10(numMagSq / denMagSq)
  }
  return totalGainDb
}

export function computeEffectiveMetrics(
  track: Track,
  processed: boolean,
): Metrics {
  const base = track.metrics
  if (!processed) {
    return {
      lufs: Number((base.lufs - 1.6).toFixed(2)),
      peak: Number((base.peak - 0.7).toFixed(2)),
      range: base.range,
      dynamics: base.dynamics,
      correlation: base.correlation,
    }
  }

  const adv = track.advanced
  let eqEnergyDelta = 0
  if (adv.eqEnabled) {
    for (const band of adv.eqBands) {
      if (band.enabled && band.type !== "highpass") {
        eqEnergyDelta += band.gainDb * 0.22
      }
    }
  }

  const compGainReduction = adv.compressor.enabled
    ? Math.max(0, (-12 - adv.compressor.threshold) * (1 - 1 / adv.compressor.ratio) * 0.18)
    : 0
  const satBoost = adv.saturationModule.enabled
    ? adv.saturationModule.drive * 0.045
    : 0
  const intensityDelta = (track.intensity - 50) * 0.032

  let moveLufsDelta = 0
  if (track.mode === "deep" && track.script) {
    for (const move of track.script.moves) {
      if (!move.muted && move.lane === "Volume") {
        moveLufsDelta += move.value * 0.05
      }
    }
  }

  const lufs = Math.min(
    adv.limiter.ceiling - 0.2,
    base.lufs +
      adv.input * 0.65 +
      eqEnergyDelta +
      satBoost +
      intensityDelta +
      moveLufsDelta,
  )
  const peak = adv.limiter.enabled
    ? Math.min(adv.limiter.ceiling, Math.max(-6, base.peak + adv.input * 0.3))
    : Math.min(0, base.peak + adv.input * 0.5)
  const dynamics = Math.max(
    4.5,
    base.dynamics - compGainReduction - satBoost * 0.5,
  )
  const widthFactor = adv.stereo.enabled ? (adv.stereo.width - 100) / 100 : 0
  const monoBassBoost = adv.stereo.enabled && adv.stereo.monoBass ? 0.03 : 0
  const correlation = Math.max(
    -1,
    Math.min(1, base.correlation - widthFactor * 0.18 + monoBassBoost),
  )

  return {
    lufs: Number(lufs.toFixed(2)),
    peak: Number(peak.toFixed(2)),
    range: Number(Math.max(3.0, base.range - compGainReduction * 0.4).toFixed(2)),
    dynamics: Number(dynamics.toFixed(2)),
    correlation: Number(correlation.toFixed(2)),
  }
}

export function synthesizeDemoStereoPcm(
  seed: number,
  sampleRate = 48000,
  durationSeconds = 2.0,
): { left: Float32Array; right: Float32Array } {
  const numFrames = Math.max(1024, Math.floor(sampleRate * durationSeconds))
  const left = new Float32Array(numFrames)
  const right = new Float32Array(numFrames)
  const baseFreq = 110 + (seed % 5) * 22
  for (let i = 0; i < numFrames; i++) {
    const t = i / sampleRate
    const env = 0.65 + 0.3 * Math.sin(2 * Math.PI * 1.5 * t)
    const sub = 0.26 * Math.sin(2 * Math.PI * 55 * t)
    const bass = 0.22 * Math.sin(2 * Math.PI * baseFreq * t)
    const mid = 0.18 * Math.sin(2 * Math.PI * (baseFreq * 4) * t)
    const presence = 0.12 * Math.sin(2 * Math.PI * 3200 * t)
    const air = 0.08 * Math.sin(2 * Math.PI * 11000 * t)
    const side = 0.11 * Math.sin(2 * Math.PI * 620 * t + 0.7)
    const mono = (sub + bass + mid + presence + air) * env
    left[i] = mono + side
    right[i] = mono - side
  }
  return { left, right }
}

export function processStereoBuffer(
  inLeft: Float32Array,
  inRight: Float32Array,
  sampleRate: number,
  adv: AdvancedParams,
): { left: Float32Array; right: Float32Array } {
  const n = Math.min(inLeft.length, inRight.length)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const inputGain = dbToLin(adv.input)
  const coeffs = adv.eqBands.map((b) => calcBiquadCoeffs(b, sampleRate))
  const z1L = new Float64Array(5)
  const z2L = new Float64Array(5)
  const z1R = new Float64Array(5)
  const z2R = new Float64Array(5)

  let compEnv = 0
  const attCoeff = Math.exp(-1 / (Math.max(0.5, adv.compressor.attack) * 0.001 * sampleRate))
  const relCoeff = Math.exp(-1 / (Math.max(10, adv.compressor.release) * 0.001 * sampleRate))
  const makeupLin = dbToLin(adv.compressor.makeup)

  const driveNorm = Math.max(0, Math.min(1, adv.saturationModule.drive / 100))
  const driveGain = 1 + driveNorm * 4.5
  const widthFactor = adv.stereo.width / 100
  const ceilingLin = dbToLin(Math.min(-0.05, adv.limiter.ceiling))

  // 1-pole LP state for 110 Hz mono-bass crossover
  const monoBassG = Math.tan((Math.PI * 110) / sampleRate)
  const monoBassAlpha = monoBassG / (1 + monoBassG)
  let sideLpState = 0

  for (let i = 0; i < n; i++) {
    let l = (inLeft[i] ?? 0) * inputGain
    let r = (inRight[i] ?? 0) * inputGain

    // Stage 2: 5-Band Parametric EQ
    if (adv.eqEnabled) {
      for (let b = 0; b < 5; b++) {
        const band = adv.eqBands[b]
        const c = coeffs[b]
        if (!band || !c || !band.enabled) continue
        if (band.type !== "highpass" && Math.abs(band.gainDb) < 1e-4) continue

        const outL = c.b0 * l + (z1L[b] ?? 0)
        z1L[b] = c.b1 * l - c.a1 * outL + (z2L[b] ?? 0)
        z2L[b] = c.b2 * l - c.a2 * outL
        l = outL

        const outR = c.b0 * r + (z1R[b] ?? 0)
        z1R[b] = c.b1 * r - c.a1 * outR + (z2R[b] ?? 0)
        z2R[b] = c.b2 * r - c.a2 * outR
        r = outR
      }
    }

    // Stage 3: Compressor
    if (adv.compressor.enabled && adv.compressor.ratio > 1.01) {
      const det = Math.max(Math.abs(l), Math.abs(r))
      if (det > compEnv) {
        compEnv = attCoeff * compEnv + (1 - attCoeff) * det
      } else {
        compEnv = relCoeff * compEnv + (1 - relCoeff) * det
      }
      const envDb = linToDb(compEnv)
      const overDb = envDb - adv.compressor.threshold
      let grDb = 0
      if (overDb > 0) {
        grDb = overDb * (1 - 1 / adv.compressor.ratio)
      }
      const grLin = dbToLin(-grDb) * makeupLin
      l *= grLin
      r *= grLin
    }

    // Stage 4: Harmonic Saturation
    if (adv.saturationModule.enabled && driveNorm > 1e-4) {
      const shape = (x: number): number => {
        const d = x * driveGain
        if (adv.saturationModule.character === "Warm") {
          const asym = 0.16 * driveNorm
          return (Math.tanh(d + asym) - Math.tanh(asym)) / Math.tanh(driveGain)
        }
        if (adv.saturationModule.character === "Thick") {
          return Math.tanh(d) / Math.tanh(driveGain)
        }
        return (Math.atan(d * 1.2) / Math.atan(driveGain * 1.2)) * 0.96
      }
      l = shape(l)
      r = shape(r)
    }

    // Stage 5: Stereo M/S Width & Mono-Bass (< 110 Hz)
    if (adv.stereo.enabled) {
      const mid = 0.5 * (l + r)
      let side = 0.5 * (l - r)
      if (adv.stereo.monoBass) {
        sideLpState += monoBassAlpha * (side - sideLpState)
        const sideHigh = side - sideLpState
        side = sideHigh * widthFactor
      } else {
        side *= widthFactor
      }
      l = mid + side
      r = mid - side
    }

    // Stage 6: Brickwall True-Peak Limiter
    if (adv.limiter.enabled) {
      const peak = Math.max(Math.abs(l), Math.abs(r))
      if (peak > ceilingLin) {
        const scale = ceilingLin / peak
        l *= scale
        r *= scale
      }
    }

    left[i] = l
    right[i] = r
  }

  return { left, right }
}

export function measureStereoBufferMetrics(
  left: Float32Array,
  right: Float32Array,
): Metrics {
  const n = Math.min(left.length, right.length)
  if (n === 0) {
    return { lufs: -70, peak: -96, range: 0, dynamics: 0, correlation: 1 }
  }
  let sumSq = 0
  let peakLin = 0
  let sumLR = 0
  let sumL2 = 0
  let sumR2 = 0

  for (let i = 0; i < n; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    sumSq += l * l + r * r
    const absL = Math.abs(l)
    const absR = Math.abs(r)
    if (absL > peakLin) peakLin = absL
    if (absR > peakLin) peakLin = absR
    sumLR += l * r
    sumL2 += l * l
    sumR2 += r * r
  }

  const meanSq = sumSq / (2 * n)
  const rmsLin = Math.sqrt(meanSq)
  const lufs = meanSq <= 1e-14 ? -70 : -0.691 + 10 * Math.log10(meanSq)
  const peak = linToDb(peakLin)
  const rmsDb = linToDb(rmsLin)
  const dynamics = Math.max(0, peak - rmsDb)
  const denom = Math.sqrt(sumL2 * sumR2)
  const correlation = denom > 1e-12 ? Math.max(-1, Math.min(1, sumLR / denom)) : 1

  return {
    lufs: Number(lufs.toFixed(2)),
    peak: Number(peak.toFixed(2)),
    range: Number(Math.max(2.5, dynamics * 0.72).toFixed(2)),
    dynamics: Number(dynamics.toFixed(2)),
    correlation: Number(correlation.toFixed(2)),
  }
}

export function encodeWavFile(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  bitDepth: ExportBitDepth = 24,
  dither = true,
): Uint8Array {
  const numFrames = Math.min(left.length, right.length)
  const numChannels = 2
  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  const dataSize = numFrames * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }

  writeAscii(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeAscii(36, "data")
  view.setUint32(40, dataSize, true)

  // Deterministic LCG for TPDF dither
  let rng = 0x6d2b79f5
  const nextRand = (): number => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
    return rng / 0xffffffff
  }

  let offset = 44
  for (let i = 0; i < numFrames; i++) {
    const samples = [left[i] ?? 0, right[i] ?? 0]
    for (const raw of samples) {
      const clamped = Math.max(-1, Math.min(1, raw))
      if (bitDepth === 16) {
        const tpdf = dither ? nextRand() - nextRand() : 0
        const q = Math.max(
          -32768,
          Math.min(32767, Math.round(clamped * 32767 + tpdf)),
        )
        view.setInt16(offset, q, true)
        offset += 2
      } else if (bitDepth === 24) {
        const tpdf = dither ? nextRand() - nextRand() : 0
        const q = Math.max(
          -8388608,
          Math.min(8388607, Math.round(clamped * 8388607 + tpdf)),
        )
        const u = q < 0 ? q + 0x1000000 : q
        view.setUint8(offset, u & 0xff)
        view.setUint8(offset + 1, (u >> 8) & 0xff)
        view.setUint8(offset + 2, (u >> 16) & 0xff)
        offset += 3
      } else {
        view.setFloat32(offset, clamped, true)
        offset += 4
      }
    }
  }

  return new Uint8Array(buffer)
}

export function renderMasteredWav(
  track: Track,
  bitDepth: ExportBitDepth = 24,
  sampleRate: 44100 | 48000 = 48000,
  dither = true,
): {
  wavBytes: Uint8Array
  beforeMetrics: Metrics
  afterMetrics: Metrics
} {
  const source = synthesizeDemoStereoPcm(track.seed, sampleRate, 2.0)
  const beforeMetrics = measureStereoBufferMetrics(source.left, source.right)
  const processed = processStereoBuffer(
    source.left,
    source.right,
    sampleRate,
    track.advanced,
  )
  const afterMetrics = measureStereoBufferMetrics(processed.left, processed.right)
  const wavBytes = encodeWavFile(
    processed.left,
    processed.right,
    sampleRate,
    bitDepth,
    dither,
  )
  return { wavBytes, beforeMetrics, afterMetrics }
}
