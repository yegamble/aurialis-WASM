export type MasterMode = "simple" | "advanced" | "deep";

export type ProfileId =
  | "modern_pop_polish"
  | "hip_hop_low_end"
  | "indie_warmth"
  | "metal_wall"
  | "pop_punk_air";

export type SaturationCharacter = "Warm" | "Thick" | "Crisp";

export type EQFilterType = "highpass" | "lowshelf" | "peaking" | "highshelf";

export type EQBandId = "sub" | "low" | "mid" | "presence" | "air";

export type EQBandParams = {
  id: EQBandId;
  label: string;
  type: EQFilterType;
  freqHz: number;
  gainDb: number;
  q: number;
  enabled: boolean;
};

export type CompressorParams = {
  enabled: boolean;
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  knee: number;
  makeup: number;
};

export type SaturationParams = {
  enabled: boolean;
  drive: number;
  character: SaturationCharacter;
};

export type StereoParams = {
  enabled: boolean;
  width: number;
  monoBass: boolean;
};

export type LimiterParams = {
  enabled: boolean;
  ceiling: number;
  targetLufs: number;
  release: number;
  truePeak: boolean;
};

export type RepairParams = {
  enabled: boolean;
  declick: boolean;
  declip: boolean;
  phaseAlign: boolean;
};

export type AdvancedParams = {
  input: number;
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  width: number;
  saturation: number;
  eqEnabled: boolean;
  eqBands: [
    EQBandParams,
    EQBandParams,
    EQBandParams,
    EQBandParams,
    EQBandParams,
  ];
  compressor: CompressorParams;
  saturationModule: SaturationParams;
  stereo: StereoParams;
  limiter: LimiterParams;
  repair: RepairParams;
};

export type Metrics = {
  lufs: number;
  peak: number;
  range: number;
  dynamics: number;
  correlation: number;
};

export type MoveLane = "Volume" | "EQ" | "Comp/Sat" | "Width" | "AI Repair";

export type Move = {
  id: string;
  lane: MoveLane;
  parameter: string;
  start: number;
  end: number;
  value: number;
  originalValue: number;
  points: [number, number][];
  reason: string;
  edited: boolean;
  muted: boolean;
};

export type SectionType =
  | "intro"
  | "verse"
  | "chorus"
  | "bridge"
  | "drop"
  | "breakdown"
  | "outro"
  | "unknown";

export type Section = {
  id: string;
  type: SectionType;
  start: number;
  end: number;
  loudness: number;
  centroid: number;
};

export type ArtifactFinding = {
  stem: string;
  classification: string;
  confidence: number;
  narrowness: number;
  spectralCollapse: number;
  correlations: number[];
};

export type MasteringScript = {
  version: 1;
  trackId: string;
  sampleRate: number;
  duration: number;
  profile: ProfileId;
  sections: Section[];
  moves: Move[];
  findings: ArtifactFinding[];
};

export type TrackStatus = "draft" | "ready" | "mastered" | "needs-review";

export type Track = {
  persistenceWarning?: string;
  id: string;
  title: string;
  filename: string;
  duration: number;
  size: number;
  format: string;
  sampleRate: number;
  status: TrackStatus;
  updatedAt: string;
  createdAt: string;
  seed: number;
  source: "demo" | "upload" | "stems";
  mode: MasterMode;
  genre: string;
  tone: string;
  intensity: number;
  target: string;
  metrics: Metrics;
  advanced: AdvancedParams;
  profile: ProfileId;
  script?: MasteringScript;
  releaseScore?: number;
};

export type Stem = {
  id: string;
  name: string;
  level: number;
  pan: number;
  muted: boolean;
  solo: boolean;
};

export type StemProject = {
  trackId: string;
  count: number;
  complete: boolean;
  stems: Stem[];
};

export type Album = {
  id: string;
  title: string;
  artist: string;
  target: string;
  trackIds: string[];
  mastered: boolean;
};

export type ExportBitDepth = 16 | 24 | 32;
