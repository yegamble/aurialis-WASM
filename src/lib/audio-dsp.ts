import type {
  AdvancedParams,
  CompressorTopology,
  EQBandParams,
  ProfileId,
  SaturationCharacter,
} from "./types";

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
  ];
}

type LegacyAdvancedSeed = {
  input?: number;
  threshold?: number;
  ratio?: number;
  attack?: number;
  release?: number;
  width?: number;
  saturation?: number;
};

export function createDefaultAdvancedParams(
  seed: LegacyAdvancedSeed = {},
): AdvancedParams {
  const input = seed.input ?? 0;
  const threshold = seed.threshold ?? -18;
  const ratio = seed.ratio ?? 1;
  const attack = seed.attack ?? 25;
  const release = seed.release ?? 220;
  const width = seed.width ?? 100;
  const saturation = seed.saturation ?? 0;
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
      sidechainHpfHz: 90,
      autoRelease: false,
      topology: "optical",
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
      crossoverHz: 110,
      midGainDb: 0,
      sideGainDb: 0,
    },
    deHarsh: { enabled: false, frequencyHz: 4500, thresholdDb: -24, rangeDb: 3 },
    multiband: {
      enabled: false, lowMidHz: 200, midHighHz: 4000,
      bands: [0, 1, 2].map(() => ({ thresholdDb: -24, ratio: 1.5, attackMs: 30, releaseMs: 150, makeupDb: 0 })) as AdvancedParams["multiband"]["bands"],
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
  };
}

type EqResponseCoefficients = {
  g: number;
  k: number;
  m0: number;
  m1: number;
  m2: number;
};

// Match the existing Go TPT EQ, including its legacy shelf corners and
// gain-dependent bell Q. This predicts that engine; it does not process audio.
function eqResponseCoefficients(
  band: EQBandParams,
  sampleRate: number,
): EqResponseCoefficients {
  const clampFrequency = (frequency: number) => Math.min(sampleRate * 0.485, Math.max(10, frequency));
  const q = band.q < 0.1 ? 0.707 : band.q;
  const amplitude = Math.pow(10, band.gainDb / 40);
  switch (band.type) {
    case "highpass":
      return { g: Math.tan(Math.PI * clampFrequency(band.freqHz) / sampleRate), k: 1 / q, m0: 1, m1: -1 / q, m2: -1 };
    case "lowshelf": {
      const k = 1.22 * 0.707 / q;
      return { g: Math.tan(Math.PI * clampFrequency(band.freqHz * 1.85) / sampleRate) / Math.sqrt(amplitude), k, m0: 1, m1: k * (amplitude - 1), m2: amplitude * amplitude - 1 };
    }
    case "highshelf": {
      const k = 1.23 * 0.707 / q;
      return { g: Math.tan(Math.PI * clampFrequency(band.freqHz / 1.54) / sampleRate) * Math.sqrt(amplitude), k, m0: amplitude * amplitude, m1: k * (1 - amplitude) * amplitude, m2: 1 - amplitude * amplitude };
    }
    case "peaking": {
      const k = 1 / (q * (1 + 0.25 * Math.abs(band.gainDb)) * amplitude);
      return { g: Math.tan(Math.PI * clampFrequency(band.freqHz) / sampleRate), k, m0: 1, m1: k * (amplitude * amplitude - 1), m2: 0 };
    }
  }
}

export function computeEqMagnitudeDb(
  freqHz: number,
  bands: readonly EQBandParams[],
  sampleRate = 48000,
): number {
  if (!Number.isFinite(freqHz) || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return 0;
  const probe = Math.max(0, Math.min(sampleRate / 2, freqHz));
  const t = Math.tan(Math.PI * probe / sampleRate);
  let totalGainDb = 0;
  for (const band of bands) {
    if (!band.enabled || (band.type !== "highpass" && Math.abs(band.gainDb) < 1e-7)) continue;
    const { g, k, m0, m1, m2 } = eqResponseCoefficients(band, sampleRate);
    // The TPT integrator has s = j*t/g: V1 = j*g*t/D, V2 = g*g/D.
    // Evaluate m0 + m1*V1 + m2*V2 without allocating complex numbers.
    const denominatorReal = g * g - t * t;
    const denominatorImaginary = k * g * t;
    const numeratorReal = m0 * denominatorReal + m2 * g * g;
    const numeratorImaginary = (m0 * k + m1) * g * t;
    const numerator = Math.hypot(numeratorReal, numeratorImaginary);
    const denominator = Math.hypot(denominatorReal, denominatorImaginary);
    if (numerator === 0) return -240;
    totalGainDb += 20 * Math.log10(numerator / denominator);
  }
  return Math.max(-240, totalGainDb);
}

type SimpleGenre = {
  eq: [number, number, number, number, number];
  threshold: number; ratio: number; attack: number; release: number;
  sidechain: number; drive: number; width: number; monoBass: boolean;
};

// Independent starting points, informed by conservative mastering practice.
// These are not Waves presets or source-adaptive analysis. See docs/mastering-controls-research.md.
const simpleGenres = {
  Pop: { eq: [0.2, -0.3, 0, 0.2, 0.5], threshold: -16, ratio: 1.8, attack: 30, release: 200, sidechain: 90, drive: 2, width: 104, monoBass: false },
  "Hip-hop": { eq: [0.6, -0.4, 0, 0.3, 0.1], threshold: -16, ratio: 1.8, attack: 30, release: 200, sidechain: 120, drive: 3, width: 102, monoBass: true },
  Rock: { eq: [0.2, -0.5, 0, 0.4, 0.2], threshold: -16, ratio: 2, attack: 30, release: 150, sidechain: 90, drive: 4, width: 104, monoBass: false },
  Electronic: { eq: [0.5, -0.4, 0, 0.1, 0.6], threshold: -15, ratio: 2, attack: 25, release: 150, sidechain: 120, drive: 3, width: 106, monoBass: true },
  Acoustic: { eq: [0, -0.2, 0.2, 0, 0.3], threshold: -14, ratio: 1.5, attack: 40, release: 300, sidechain: 60, drive: 0, width: 100, monoBass: false },
  "R&B": { eq: [0.4, 0.2, 0.1, -0.2, 0.3], threshold: -17, ratio: 1.7, attack: 30, release: 250, sidechain: 100, drive: 3, width: 102, monoBass: true },
} satisfies Record<string, SimpleGenre>;
type SimpleTone = {
  eq: [number, number, number, number, number];
  ratio: number; drive: number; width: number; character: SaturationCharacter;
};
const simpleTones = {
  Warm: { eq: [0.3, 0.5, 0, -0.4, 0], ratio: 0, drive: 5, width: 0, character: "Tube" },
  Open: { eq: [0, -0.4, 0, 0.3, 0.9], ratio: -0.2, drive: 0, width: 4, character: "Tube" },
  Punchy: { eq: [0.4, -0.3, 0, 0.4, 0.1], ratio: 0.2, drive: 2, width: 0, character: "Transformer" },
  Intimate: { eq: [0, 0.3, 0.5, 0, -0.3], ratio: -0.1, drive: 3, width: -6, character: "Tube" },
  Wide: { eq: [0, 0, 0, 0, 0.2], ratio: -0.1, drive: 0, width: 12, character: "Tape" },
  Clean: { eq: [0, 0, 0, 0, 0], ratio: -0.3, drive: 0, width: 0, character: "Clean" },
} satisfies Record<string, SimpleTone>;

export function mapSimpleToDSP(
  genre: string,
  tone: string,
  intensity: number,
  target: string,
): AdvancedParams {
  // Rebuild from defaults: repeated selections never compound an earlier curve.
  const base = createDefaultAdvancedParams();
  const k = Number.isFinite(intensity) ? Math.max(0, Math.min(100, intensity)) / 100 : 0;
  const direction = Object.entries(simpleGenres).find(([name]) => name === genre)?.[1] ?? simpleGenres.Pop;
  const intention = Object.entries(simpleTones).find(([name]) => name === tone)?.[1] ?? simpleTones.Clean;
  const round = (value: number) => Math.round(value * 100) / 100 + 0;
  const bands = base.eqBands.map((band, index) => ({
    ...band,
    // A broad bell avoids using two overlapping low shelves for mud control.
    type: index === 1 ? "peaking" as const : band.type,
    q: index === 1 ? 0.7 : band.q,
    gainDb: round(((direction.eq.at(index) ?? 0) + (intention.eq.at(index) ?? 0)) * k),
  })) as AdvancedParams["eqBands"];
  const threshold = round(-6 + (direction.threshold + 6) * k);
  const ratio = round(1 + (direction.ratio + intention.ratio - 1) * k);
  const drive = intention.character === "Clean" ? 0 : round((direction.drive + intention.drive) * k);
  const width = round(100 + (direction.width + intention.width - 100) * k);
  const monoBass = k > 0 && (direction.monoBass || tone === "Wide");
  const attack = tone === "Punchy" ? 30 : direction.attack;
  const release = tone === "Punchy" ? 150 : direction.release;
  return {
    ...base,
    threshold, ratio, attack, release, width, saturation: drive,
    eqBands: bands,
    compressor: {
      ...base.compressor, enabled: k > 0, threshold, ratio, attack, release,
      sidechainHpfHz: direction.sidechain,
      autoRelease: true,
    },
    saturationModule: { enabled: drive > 0, drive, character: intention.character },
    stereo: { ...base.stereo, enabled: k > 0, width, monoBass, crossoverHz: 110 },
    limiter: {
      ...base.limiter, enabled: true,
      targetLufs: target === "Loud" ? -9 : target === "Dynamic" || target === "Podcast" ? -16 : -14,
      ceiling: target === "Loud" ? -0.2 : -1,
    },
  };
}

export function mapProfileToDSP(
  profile: ProfileId,
  baseParams?: AdvancedParams,
): AdvancedParams {
  const defaults = createDefaultAdvancedParams();
  const base = {
    ...defaults, ...baseParams,
    compressor: { ...defaults.compressor, ...baseParams?.compressor },
    stereo: { ...defaults.stereo, ...baseParams?.stereo },
    deHarsh: { ...defaults.deHarsh, ...baseParams?.deHarsh },
    multiband: { ...defaults.multiband, ...baseParams?.multiband },
  };
  const bands: [
    EQBandParams,
    EQBandParams,
    EQBandParams,
    EQBandParams,
    EQBandParams,
  ] = [
    { ...base.eqBands[0] },
    { ...base.eqBands[1] },
    { ...base.eqBands[2] },
    { ...base.eqBands[3] },
    { ...base.eqBands[4] },
  ];

  let satDrive = 12;
  let satChar: "Warm" | "Thick" | "Crisp" = "Crisp";
  let compThresh = -18;
  let compRatio = 2.8;
  let compAttack = 25;
  let compRelease = 120;
  let compTopology: CompressorTopology = "vca";
  let width = 115;
  let monoBass = true;
  let targetLufs = -14.0;
  let ceiling = -1.0;

  switch (profile) {
    case "modern_pop_polish":
      bands[0].gainDb = 1.2;
      bands[1].gainDb = 0.5;
      bands[2].gainDb = -0.5;
      bands[3].gainDb = 1.2;
      bands[4].gainDb = 2.5;
      satDrive = 12;
      satChar = "Crisp";
      compThresh = -18;
      compRatio = 2.8;
      compAttack = 25;
      compRelease = 120;
      width = 115;
      monoBass = true;
      targetLufs = -14.0;
      ceiling = -1.0;
      break;

    case "hip_hop_low_end":
      bands[0].gainDb = 3.5;
      bands[1].gainDb = 1.8;
      bands[2].gainDb = 0.0;
      bands[3].gainDb = 0.8;
      bands[4].gainDb = 1.2;
      satDrive = 18;
      satChar = "Thick";
      compThresh = -20;
      compRatio = 3.2;
      compAttack = 30;
      compRelease = 80;
      width = 105;
      monoBass = true;
      targetLufs = -12.0;
      ceiling = -0.5;
      break;

    case "indie_warmth":
      bands[0].gainDb = 1.0;
      bands[1].gainDb = 2.0;
      bands[2].gainDb = 1.5;
      bands[3].gainDb = 0.5;
      bands[4].gainDb = 0.0;
      satDrive = 22;
      satChar = "Warm";
      compThresh = -16;
      compRatio = 2.0;
      compAttack = 35;
      compRelease = 300;
      compTopology = "optical";
      width = 100;
      monoBass = false;
      targetLufs = -14.0;
      ceiling = -1.0;
      break;

    case "metal_wall":
      bands[0].gainDb = 2.0;
      bands[1].gainDb = 1.0;
      bands[2].gainDb = -1.8;
      bands[3].gainDb = 2.2;
      bands[4].gainDb = 1.5;
      satDrive = 25;
      satChar = "Crisp";
      compThresh = -22;
      compRatio = 4.0;
      compAttack = 10;
      compRelease = 60;
      compTopology = "fet";
      width = 120;
      monoBass = true;
      targetLufs = -10.0;
      ceiling = -0.3;
      break;

    case "pop_punk_air":
      bands[0].gainDb = 1.0;
      bands[1].gainDb = 2.2;
      bands[2].gainDb = 0.0;
      bands[3].gainDb = 1.8;
      bands[4].gainDb = 3.2;
      satDrive = 16;
      satChar = "Thick";
      compThresh = -19;
      compRatio = 3.0;
      compAttack = 20;
      compRelease = 140;
      width = 110;
      monoBass = true;
      targetLufs = -12.0;
      ceiling = -0.5;
      break;
  }

  const profileDSP: AdvancedParams = {
    ...base,
    repair: { ...base.repair, enabled: false },
    input: 0,
    threshold: compThresh,
    ratio: compRatio,
    attack: compAttack,
    release: compRelease,
    width,
    saturation: satDrive,
    eqEnabled: true,
    eqBands: bands,
    compressor: {
      ...base.compressor,
      enabled: true,
      threshold: compThresh,
      ratio: compRatio,
      attack: compAttack,
      release: compRelease,
      topology: compTopology,
    },
    saturationModule: {
      ...base.saturationModule,
      enabled: satDrive > 0,
      drive: satDrive,
      character: satChar,
    },
    stereo: {
      ...base.stereo,
      enabled: true,
      width,
      monoBass,
    },
    limiter: {
      ...base.limiter,
      enabled: true,
      targetLufs,
      ceiling,
      truePeak: false,
    },
  };

  return profileDSP;
}

// Keep the displayed and processed EQ frequencies inside the source bandwidth.
// Keep frequency-selective modules below Nyquist while retaining enable states.
export function clampAdvancedToSampleRate(settings: AdvancedParams, sampleRate: number): AdvancedParams {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
    throw new Error("Unsupported source sample rate.");
  const maximum = Math.min(18000, Math.floor(sampleRate * 0.47));
  const band = (value: EQBandParams): EQBandParams => ({ ...value, freqHz: Math.max(20, Math.min(maximum, value.freqHz)) });
  return {
    ...settings,
    eqBands: [band(settings.eqBands[0]), band(settings.eqBands[1]), band(settings.eqBands[2]), band(settings.eqBands[3]), band(settings.eqBands[4])],
    deHarsh: { ...settings.deHarsh, frequencyHz: !settings.deHarsh.enabled && settings.deHarsh.frequencyHz === 0 ? 0 : Math.max(1000, Math.min(maximum, settings.deHarsh.frequencyHz)) },
    multiband: { ...settings.multiband, midHighHz: !settings.multiband.enabled && settings.multiband.midHighHz === 0 ? 0 : Math.max(1500, Math.min(maximum, settings.multiband.midHighHz)) },
  };
}
