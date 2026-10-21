"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from "react"
import { createDefaultAdvancedParams } from "./audio-dsp"
import type {
  Album,
  CompressorParams,
  EQBandId,
  EQBandParams,
  LimiterParams,
  MasteringScript,
  Move,
  MoveLane,
  ProfileId,
  RepairParams,
  SaturationParams,
  SectionType,
  Stem,
  StemProject,
  StereoParams,
  Track,
} from "./types"

const INITIAL_TIMESTAMP = "2026-10-20T00:00:00.000Z"

export const profiles: { id: ProfileId; name: string; note: string }[] = [
  {
    id: "modern_pop_polish",
    name: "Modern Pop Polish",
    note: "Tight lows, open top, controlled chorus lift.",
  },
  {
    id: "hip_hop_low_end",
    name: "Hip-Hop Low-End",
    note: "Sub-forward weight with articulate transients.",
  },
  {
    id: "indie_warmth",
    name: "Indie Warmth",
    note: "Soft compression and an organic midrange.",
  },
  {
    id: "metal_wall",
    name: "Metal Wall",
    note: "Dense impact, precise bass and assertive mids.",
  },
  {
    id: "pop_punk_air",
    name: "Pop Punk Air",
    note: "Bright presence and energetic drum movement.",
  },
]

const demoTracks: Track[] = [
  {
    id: "demo-1",
    title: "Velvet Static",
    filename: "velvet-static.wav",
    duration: 218,
    size: 58_400_000,
    format: "WAV",
    sampleRate: 48000,
    status: "ready",
    createdAt: INITIAL_TIMESTAMP,
    updatedAt: INITIAL_TIMESTAMP,
    seed: 17,
    source: "demo",
    mode: "simple",
    genre: "Indie",
    tone: "Warm",
    intensity: 58,
    target: "Streaming",
    metrics: {
      lufs: -16.8,
      peak: -2.4,
      range: 8.9,
      dynamics: 10.4,
      correlation: 0.86,
    },
    advanced: createDefaultAdvancedParams({
      input: 0,
      threshold: -18,
      ratio: 2.5,
      attack: 28,
      release: 220,
      width: 106,
      saturation: 12,
    }),
    profile: "indie_warmth",
  },
  {
    id: "demo-2",
    title: "Borrowed Light",
    filename: "borrowed-light.aif",
    duration: 194,
    size: 47_200_000,
    format: "AIFF",
    sampleRate: 44100,
    status: "mastered",
    createdAt: INITIAL_TIMESTAMP,
    updatedAt: INITIAL_TIMESTAMP,
    seed: 31,
    source: "demo",
    mode: "advanced",
    genre: "Alternative",
    tone: "Open",
    intensity: 67,
    target: "Streaming",
    metrics: {
      lufs: -14.1,
      peak: -1.1,
      range: 7.2,
      dynamics: 8.8,
      correlation: 0.91,
    },
    advanced: createDefaultAdvancedParams({
      input: 1.2,
      threshold: -20,
      ratio: 3,
      attack: 20,
      release: 180,
      width: 112,
      saturation: 9,
    }),
    profile: "modern_pop_polish",
  },
  {
    id: "demo-3",
    title: "After the Rain",
    filename: "after-the-rain.mp3",
    duration: 246,
    size: 9_800_000,
    format: "MP3",
    sampleRate: 44100,
    status: "needs-review",
    createdAt: INITIAL_TIMESTAMP,
    updatedAt: INITIAL_TIMESTAMP,
    seed: 52,
    source: "demo",
    mode: "deep",
    genre: "Electronic",
    tone: "Wide",
    intensity: 72,
    target: "Loud",
    metrics: {
      lufs: -12.7,
      peak: -0.4,
      range: 5.8,
      dynamics: 7.1,
      correlation: 0.72,
    },
    advanced: createDefaultAdvancedParams({
      input: 1.8,
      threshold: -21,
      ratio: 3.5,
      attack: 15,
      release: 160,
      width: 118,
      saturation: 17,
    }),
    profile: "modern_pop_polish",
  },
]

type StoreState = {
  tracks: Track[]
  albums: Album[]
  stems: StemProject[]
}

type StoreAction =
  | { type: "ADD_TRACK"; track: Track }
  | { type: "UPDATE_TRACK"; id: string; patch: Partial<Track> }
  | {
      type: "UPDATE_SIMPLE"
      id: string
      patch: Partial<Pick<Track, "genre" | "tone" | "intensity" | "target">>
    }
  | {
      type: "UPDATE_EQ_BAND"
      trackId: string
      bandId: EQBandId
      patch: Partial<Omit<EQBandParams, "id" | "label" | "type">>
    }
  | { type: "TOGGLE_EQ_ENABLED"; trackId: string; enabled: boolean }
  | {
      type: "UPDATE_COMPRESSOR"
      trackId: string
      patch: Partial<CompressorParams>
    }
  | {
      type: "UPDATE_SATURATION"
      trackId: string
      patch: Partial<SaturationParams>
    }
  | { type: "UPDATE_STEREO"; trackId: string; patch: Partial<StereoParams> }
  | { type: "UPDATE_LIMITER"; trackId: string; patch: Partial<LimiterParams> }
  | { type: "UPDATE_REPAIR"; trackId: string; patch: Partial<RepairParams> }
  | { type: "UPDATE_INPUT_GAIN"; trackId: string; input: number }
  | { type: "RESET_ADVANCED"; trackId: string }
  | { type: "DELETE_TRACK"; id: string }
  | { type: "SAVE_SCRIPT"; id: string; script: MasteringScript }
  | { type: "UPDATE_MOVE"; trackId: string; move: Move }
  | { type: "SAVE_STEMS"; project: StemProject }
  | {
      type: "UPDATE_STEM"
      trackId: string
      stemId: string
      patch: Partial<Omit<Stem, "id">>
    }
  | { type: "ADD_ALBUM"; album: Album }
  | { type: "UPDATE_ALBUM"; id: string; patch: Partial<Album> }
  | { type: "DELETE_ALBUM"; id: string }
  | { type: "HYDRATE_STATE"; state: StoreState }
  | { type: "RESET_WORKSPACE" }

export const initialStoreState: StoreState = {
  tracks: demoTracks,
  albums: [],
  stems: [],
}

function updateTrackInList(
  tracks: Track[],
  id: string,
  updater: (track: Track) => Track,
): Track[] {
  return tracks.map((track) => (track.id === id ? updater(track) : track))
}

export function reduceStoreState(
  state: StoreState,
  action: StoreAction,
): StoreState {
  switch (action.type) {
    case "ADD_TRACK":
      return { ...state, tracks: [action.track, ...state.tracks] }

    case "UPDATE_TRACK":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.id, (track) => ({
          ...track,
          ...action.patch,
          updatedAt: new Date().toISOString(),
        })),
      }

    case "UPDATE_SIMPLE":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.id, (track) => ({
          ...track,
          ...action.patch,
          updatedAt: new Date().toISOString(),
        })),
      }

    case "UPDATE_INPUT_GAIN":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          advanced: {
            ...track.advanced,
            input: action.input,
          },
          updatedAt: new Date().toISOString(),
        })),
      }

    case "TOGGLE_EQ_ENABLED":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          advanced: {
            ...track.advanced,
            eqEnabled: action.enabled,
          },
          updatedAt: new Date().toISOString(),
        })),
      }

    case "UPDATE_EQ_BAND":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => {
          const nextBands = track.advanced.eqBands.map((band) =>
            band.id === action.bandId ? { ...band, ...action.patch } : band,
          ) as Track["advanced"]["eqBands"]
          return {
            ...track,
            advanced: {
              ...track.advanced,
              eqBands: nextBands,
            },
            updatedAt: new Date().toISOString(),
          }
        }),
      }

    case "UPDATE_COMPRESSOR":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => {
          const nextComp: CompressorParams = {
            ...track.advanced.compressor,
            ...action.patch,
          }
          return {
            ...track,
            advanced: {
              ...track.advanced,
              threshold: nextComp.threshold,
              ratio: nextComp.ratio,
              attack: nextComp.attack,
              release: nextComp.release,
              compressor: nextComp,
            },
            updatedAt: new Date().toISOString(),
          }
        }),
      }

    case "UPDATE_SATURATION":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => {
          const nextSat: SaturationParams = {
            ...track.advanced.saturationModule,
            ...action.patch,
          }
          return {
            ...track,
            advanced: {
              ...track.advanced,
              saturation: nextSat.drive,
              saturationModule: nextSat,
            },
            updatedAt: new Date().toISOString(),
          }
        }),
      }

    case "UPDATE_STEREO":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => {
          const nextStereo: StereoParams = {
            ...track.advanced.stereo,
            ...action.patch,
          }
          return {
            ...track,
            advanced: {
              ...track.advanced,
              width: nextStereo.width,
              stereo: nextStereo,
            },
            updatedAt: new Date().toISOString(),
          }
        }),
      }

    case "UPDATE_LIMITER":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          advanced: {
            ...track.advanced,
            limiter: {
              ...track.advanced.limiter,
              ...action.patch,
            },
          },
          updatedAt: new Date().toISOString(),
        })),
      }

    case "UPDATE_REPAIR":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          advanced: {
            ...track.advanced,
            repair: {
              ...track.advanced.repair,
              ...action.patch,
            },
          },
          updatedAt: new Date().toISOString(),
        })),
      }

    case "RESET_ADVANCED":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          advanced: createDefaultAdvancedParams(),
          updatedAt: new Date().toISOString(),
        })),
      }

    case "DELETE_TRACK":
      return {
        ...state,
        tracks: state.tracks.filter((track) => track.id !== action.id),
        albums: state.albums.map((album) => ({
          ...album,
          trackIds: album.trackIds.filter((id) => id !== action.id),
        })),
        stems: state.stems.filter((project) => project.trackId !== action.id),
      }

    case "SAVE_SCRIPT":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.id, (track) => ({
          ...track,
          script: action.script,
          updatedAt: new Date().toISOString(),
        })),
      }

    case "UPDATE_MOVE":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) =>
          track.script
            ? {
                ...track,
                script: {
                  ...track.script,
                  moves: track.script.moves.map((m) =>
                    m.id === action.move.id ? action.move : m,
                  ),
                },
                updatedAt: new Date().toISOString(),
              }
            : track,
        ),
      }

    case "SAVE_STEMS":
      return {
        ...state,
        stems: [
          ...state.stems.filter((p) => p.trackId !== action.project.trackId),
          action.project,
        ],
      }

    case "UPDATE_STEM":
      return {
        ...state,
        stems: state.stems.map((project) =>
          project.trackId === action.trackId
            ? {
                ...project,
                stems: project.stems.map((stem) =>
                  stem.id === action.stemId
                    ? { ...stem, ...action.patch }
                    : stem,
                ),
              }
            : project,
        ),
      }

    case "ADD_ALBUM":
      return { ...state, albums: [action.album, ...state.albums] }

    case "UPDATE_ALBUM":
      return {
        ...state,
        albums: state.albums.map((a) =>
          a.id === action.id ? { ...a, ...action.patch } : a,
        ),
      }

    case "DELETE_ALBUM":
      return {
        ...state,
        albums: state.albums.filter((a) => a.id !== action.id),
      }

    case "HYDRATE_STATE":
      return action.state

    case "RESET_WORKSPACE":
      return initialStoreState
  }
}

function normalizeHydratedState(raw: unknown): StoreState | null {
  if (typeof raw !== "object" || raw === null) return null
  const candidate = raw as Partial<StoreState>
  if (!Array.isArray(candidate.tracks)) return null
  const tracks: Track[] = candidate.tracks.map((track) => {
    const baseAdv = createDefaultAdvancedParams(track.advanced)
    return {
      ...track,
      advanced: {
        ...baseAdv,
        ...track.advanced,
        eqBands:
          Array.isArray(track.advanced?.eqBands) &&
          track.advanced.eqBands.length === 5
            ? track.advanced.eqBands
            : baseAdv.eqBands,
        compressor: {
          ...baseAdv.compressor,
          ...(track.advanced?.compressor ?? {}),
        },
        saturationModule: {
          ...baseAdv.saturationModule,
          ...(track.advanced?.saturationModule ?? {}),
        },
        stereo: {
          ...baseAdv.stereo,
          ...(track.advanced?.stereo ?? {}),
        },
        limiter: {
          ...baseAdv.limiter,
          ...(track.advanced?.limiter ?? {}),
        },
        repair: {
          ...baseAdv.repair,
          ...(track.advanced?.repair ?? {}),
        },
      },
    }
  })
  return {
    tracks,
    albums: Array.isArray(candidate.albums) ? candidate.albums : [],
    stems: Array.isArray(candidate.stems) ? candidate.stems : [],
  }
}

const StoreContext = createContext<{
  state: StoreState
  dispatch: Dispatch<StoreAction>
} | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceStoreState, initialStoreState)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    try {
      const saved = globalThis.localStorage.getItem("aurialis-state-v1")
      if (saved) {
        const parsed: unknown = JSON.parse(saved)
        const hydrated = normalizeHydratedState(parsed)
        if (hydrated) {
          dispatch({ type: "HYDRATE_STATE", state: hydrated })
        }
      }
    } catch {
      // Invalid or blocked persistence falls back to the current session.
    }
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      globalThis.localStorage.setItem("aurialis-state-v1", JSON.stringify(state))
    } catch {
      // Ignore storage quota errors
    }
  }, [state, hydrated])

  const value = useMemo(() => ({ state, dispatch }), [state])
  return <StoreContext.Provider value={value}>{hydrated ? children : <p className="page" role="status">Loading your local workspace…</p>}</StoreContext.Provider>
}

export function useStore() {
  const value = useContext(StoreContext)
  if (!value) throw new Error("StoreProvider is missing")
  return value
}

export function generateScript(
  track: Track,
  profile: ProfileId,
): MasteringScript {
  const sectionTypes: SectionType[] = [
    "intro",
    "verse",
    "chorus",
    "verse",
    "chorus",
    "bridge",
    "chorus",
    "outro",
  ]
  const length = track.duration / sectionTypes.length
  const sections = sectionTypes.map((type, i) => ({
    id: `section-${i}`,
    type,
    start: Number((i * length).toFixed(2)),
    end: Number(((i + 1) * length).toFixed(2)),
    loudness: -18 + ((track.seed + i * 7) % 8),
    centroid: 900 + ((track.seed * (i + 2) * 97) % 2400),
  }))

  const lanes: MoveLane[] = [
    "Volume",
    "EQ",
    "Comp/Sat",
    "Width",
    "AI Repair",
  ]

  const profileName =
    profiles.find((p) => p.id === profile)?.name ?? "Modern Pop Polish"

  const moves: Move[] = sections.flatMap((section, sectionIndex) =>
    lanes
      .filter(
        (lane) => lane !== "AI Repair" || (track.seed + sectionIndex) % 4 === 0,
      )
      .map((lane, laneIndex) => {
        const value =
          Math.round(
            (((track.seed + sectionIndex * 13 + laneIndex * 7) % 25) - 12) * 10,
          ) / 10
        const start = Number((section.start + length * 0.08).toFixed(2))
        const end = Number((section.end - length * 0.08).toFixed(2))
        return {
          id: `${section.id}-${laneIndex}`,
          lane,
          parameter:
            lane === "Volume"
              ? "input_gain_db"
              : lane === "EQ"
                ? "eq_high_shelf_db"
                : lane === "Comp/Sat"
                  ? "compressor_threshold_db"
                  : lane === "Width"
                    ? "stereo_width_percent"
                    : "ai_repair_amount",
          start,
          end,
          value,
          originalValue: value,
          points: [
            [start, value],
            [end, value],
          ],
          reason: `${profileName} adjustment for the ${section.type}.`,
          edited: false,
          muted: false,
        }
      }),
  )

  return {
    version: 1,
    trackId: track.id,
    sampleRate: track.sampleRate,
    duration: track.duration,
    profile,
    sections,
    moves,
    findings:
      track.seed % 2 !== 0
        ? [
            {
              stem: "Upper harmony",
              classification: "possible synthetic texture",
              confidence: 0.68,
              narrowness: 0.42,
              spectralCollapse: 0.31,
              correlations: [0.82, 0.54, 0.29],
            },
          ]
        : [],
  }
}
