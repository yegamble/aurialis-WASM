import type { DeepMasteringState } from "./deep-mastering";
import type { ReleaseReport } from "./release-review";

export type SimpleStyle = "precise" | "organic" | "elevated";
export type SimpleDirection = {
  version: 2;
  genre: "Pop" | "Hip-hop" | "Rock" | "Electronic" | "Acoustic" | "R&B" | "Metal" | "Jazz";
  tone: "Warm" | "Open" | "Punchy" | "Intimate" | "Wide" | "Clean";
  style: SimpleStyle;
  depth: boolean;
  presence: boolean;
  intensity: number;
};

export type MasterMode = "simple" | "advanced" | "deep";

export type ProfileId =
  | "modern_pop_polish"
  | "hip_hop_low_end"
  | "indie_warmth"
  | "metal_wall"
  | "pop_punk_air";

export type SaturationCharacter = "Warm" | "Thick" | "Crisp" | "Clean" | "Tube" | "Tape" | "Transformer";

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
  sidechainHpfHz: number;
  autoRelease: boolean;
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
  crossoverHz: number;
  midGainDb: number;
  sideGainDb: number;
};

export type DeHarshParams = {
  enabled: boolean;
  frequencyHz: number;
  thresholdDb: number;
  rangeDb: number;
};

export type MultibandBandParams = {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
};

export type MultibandParams = {
  enabled: boolean;
  lowMidHz: number;
  midHighHz: number;
  bands: [MultibandBandParams, MultibandBandParams, MultibandBandParams];
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
  deHarsh: DeHarshParams;
  multiband: MultibandParams;
};

export type MeasuredAudioMetrics = {
  integratedLufs: number;
  shortTermLufs: number;
  truePeakDbtp: number;
  samplePeakDbfs: number;
  dynamicRangeDb: number;
  correlation: number;
  lowBassCorrelation: number;
  dcLeftDbfs: number;
  dcRightDbfs: number;
  clippingSamples: number;
  gainReductionDb: number;
};

export type Metrics = {
  lufs: number;
  peak: number;
  range: number;
  dynamics: number;
  correlation: number;
};

export type TrackStatus = "draft" | "ready" | "mastered" | "needs-review";

export type ShortcutUndo = {
  air?: EQBandParams;
  mud?: EQBandParams;
  tape?: SaturationParams;
  tapeLegacy?: number;
  glue?: CompressorParams;
  glueLegacy?: Pick<AdvancedParams, "threshold" | "ratio" | "attack" | "release">;
  eqBaseline?: { enabled: boolean; bands: AdvancedParams["eqBands"] };
};

export type SourceIdentity = { pcmHash: string; sampleRate: number; frames: number };

export type Track = {
  releaseReview?: ReleaseReport;
  deepMastering?: DeepMasteringState;
  sourceAudioId?: string;
  retiredSourceAudioIds?: string[];
  importNotice?: string;
  sourceIdentity?: SourceIdentity;
  sourceRevision?: number;
  shortcutUndo?: ShortcutUndo;
  /** Only an explicit Simple selection establishes a preset association. */
  simpleCustom?: boolean;
  simpleDirection?: SimpleDirection;
  persistenceWarning?: string;
  measurements?: MeasuredAudioMetrics;
  measurementKind?: "source" | "album-render";
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
  releaseScore?: number;
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
