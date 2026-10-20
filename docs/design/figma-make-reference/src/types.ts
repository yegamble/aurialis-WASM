export type MasterMode = "simple" | "advanced" | "deep"
export type ProfileId = "modern_pop_polish" | "hip_hop_low_end" | "indie_warmth" | "metal_wall" | "pop_punk_air"

export type Metrics = {
  lufs: number
  peak: number
  range: number
  dynamics: number
  correlation: number
}

export type Move = {
  id: string
  lane: "Volume" | "EQ" | "Comp/Sat" | "Width" | "AI Repair"
  parameter: string
  start: number
  end: number
  value: number
  originalValue: number
  reason: string
  edited: boolean
  muted: boolean
}

export type Section = {
  id: string
  type: "intro" | "verse" | "chorus" | "bridge" | "drop" | "breakdown" | "outro" | "unknown"
  start: number
  end: number
  loudness: number
  centroid: number
}

export type MasteringScript = {
  version: 1
  trackId: string
  sampleRate: number
  duration: number
  profile: ProfileId
  sections: Section[]
  moves: Move[]
  findings: {
    stem: string
    classification: string
    confidence: number
    narrowness: number
    spectralCollapse: number
    correlations: number[]
  }[]
}

export type Track = {
  id: string
  title: string
  filename: string
  duration: number
  size: number
  format: string
  sampleRate: number
  status: "draft" | "ready" | "mastered" | "needs-review"
  updatedAt: string
  createdAt: string
  seed: number
  source: "demo" | "upload" | "stems"
  mode: MasterMode
  genre: string
  tone: string
  intensity: number
  target: string
  metrics: Metrics
  advanced: {
    input: number
    threshold: number
    ratio: number
    attack: number
    release: number
    width: number
    saturation: number
  }
  profile: ProfileId
  script?: MasteringScript
  releaseScore?: number
}

export type Stem = {
  id: string
  name: string
  level: number
  pan: number
  muted: boolean
  solo: boolean
}

export type StemProject = {
  trackId: string
  count: number
  complete: boolean
  stems: Stem[]
}

export type Album = {
  id: string
  title: string
  artist: string
  target: string
  trackIds: string[]
  mastered: boolean
}
