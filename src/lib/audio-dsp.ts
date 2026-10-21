import type {
  AdvancedParams,
  EQBandParams,
} from "./types"

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
      type: "lowshelf",
      freqHz: 60,
      gainDb: 0,
      q: 0.707,
      enabled: true,
    },
    {
      id: "low",
      label: "Low",
      type: "lowshelf",
      freqHz: 250,
      gainDb: 0,
      q: 0.707,
      enabled: true,
    },
    {
      id: "mid",
      label: "Mid",
      type: "peaking",
      freqHz: 1000,
      gainDb: 0,
      q: 1.0,
      enabled: true,
    },
    {
      id: "presence",
      label: "Presence",
      type: "peaking",
      freqHz: 4000,
      gainDb: 0,
      q: 1.0,
      enabled: true,
    },
    {
      id: "air",
      label: "Air",
      type: "highshelf",
      freqHz: 12000,
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
  const ratio = seed.ratio ?? 1
  const attack = seed.attack ?? 25
  const release = seed.release ?? 220
  const width = seed.width ?? 100
  const saturation = seed.saturation ?? 0
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
      threshold: seed.threshold ?? 0,
      ratio,
      attack,
      release,
      knee: 6,
      makeup: 0,
    },
    saturationModule: {
      enabled: true,
      drive: saturation,
      character: "Warm",
    },
    stereo: {
      enabled: true,
      width,
      monoBass: false,
    },
    limiter: {
      enabled: false,
      ceiling: -1.0,
      targetLufs: -14.0,
      release: 85,
      truePeak: false,
    },
    repair: {
      enabled: false,
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

