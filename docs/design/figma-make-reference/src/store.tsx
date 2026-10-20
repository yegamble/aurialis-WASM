import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react"
import type {
  Album,
  MasteringScript,
  Move,
  ProfileId,
  StemProject,
  Track,
} from "./types"

const now = new Date().toISOString()

export const profiles: { id: ProfileId name: string note: string }[] = [
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
    createdAt: now,
    updatedAt: now,
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
    advanced: {
      input: 0,
      threshold: -18,
      ratio: 2.5,
      attack: 28,
      release: 220,
      width: 106,
      saturation: 12,
    },
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
    createdAt: now,
    updatedAt: now,
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
    advanced: {
      input: 1.2,
      threshold: -20,
      ratio: 3,
      attack: 20,
      release: 180,
      width: 112,
      saturation: 9,
    },
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
    createdAt: now,
    updatedAt: now,
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
    advanced: {
      input: 1.8,
      threshold: -21,
      ratio: 3.5,
      attack: 15,
      release: 160,
      width: 118,
      saturation: 17,
    },
    profile: "modern_pop_polish",
  },
]

type State = { tracks: Track[] albums: Album[] stems: StemProject[] }
type Action = { type: "ADD_TRACK" track: Track } | {
  type: "UPDATE_TRACK"
  id: string
  patch: Partial<Track>
} | { type: "DELETE_TRACK" id: string } | {
  type: "SAVE_SCRIPT"
  id: string
  script: MasteringScript
} | { type: "UPDATE_MOVE" trackId: string move: Move } | {
  type: "SAVE_STEMS"
  project: StemProject
} | { type: "ADD_ALBUM" album: Album } | {
  type: "UPDATE_ALBUM"
  id: string
  patch: Partial<Album>
} | { type: "DELETE_ALBUM" id: string }

const initial: State = { tracks: demoTracks, albums: [], stems: [] }

function reducer(state: State, action: Action): State {
  if (action.type === "ADD_TRACK")
    return { ...state, tracks: [action.track, ...state.tracks] }
  if (action.type === "UPDATE_TRACK")
    return {
      ...state,
      tracks: state.tracks.map((track) =>
        track.id === action.id
          ? { ...track, ...action.patch, updatedAt: new Date().toISOString() }
          : track,
      ),
    }
  if (action.type === "DELETE_TRACK")
    return {
      ...state,
      tracks: state.tracks.filter((track) => track.id !== action.id),
      albums: state.albums.map((album) => ({
        ...album,
        trackIds: album.trackIds.filter((id) => id !== action.id),
      })),
    }
  if (action.type === "SAVE_SCRIPT")
    return {
      ...state,
      tracks: state.tracks.map((track) =>
        track.id === action.id ? { ...track, script: action.script } : track,
      ),
    }
  if (action.type === "UPDATE_MOVE")
    return {
      ...state,
      tracks: state.tracks.map((track) =>
        track.id === action.trackId && track.script
          ? {
              ...track,
              script: {
                ...track.script,
                moves: track.script.moves.map((m) =>
                  m.id === action.move.id ? action.move : m,
                ),
              },
            }
          : track,
      ),
    }
  if (action.type === "SAVE_STEMS")
    return {
      ...state,
      stems: [
        ...state.stems.filter((p) => p.trackId !== action.project.trackId),
        action.project,
      ],
    }
  if (action.type === "ADD_ALBUM")
    return { ...state, albums: [action.album, ...state.albums] }
  if (action.type === "UPDATE_ALBUM")
    return {
      ...state,
      albums: state.albums.map((a) =>
        a.id === action.id ? { ...a, ...action.patch } : a,
      ),
    }
  if (action.type === "DELETE_ALBUM")
    return { ...state, albums: state.albums.filter((a) => a.id !== action.id) }
  return state
}

const StoreContext = createContext<{
  state: State
  dispatch: React.Dispatch<Action>
} | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial, (fallback) => {
    try {
      const saved = localStorage.getItem("aurialis-state-v1")
      return saved ? JSON.parse(saved) : fallback
    } catch {
      return fallback
    }
  })

  useEffect(() => {
    localStorage.setItem("aurialis-state-v1", JSON.stringify(state))
  }, [state])

  const value = useMemo(() => ({ state, dispatch }), [state])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
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
  const sectionTypes: MasteringScript["sections"][number]["type"][] = [
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
    start: i * length,
    end: (i + 1) * length,
    loudness: -18 + ((track.seed + i * 7) % 8),
    centroid: 900 + ((track.seed * (i + 2) * 97) % 2400),
  }))
  const lanes: Move["lane"][] = [
    "Volume",
    "EQ",
    "Comp/Sat",
    "Width",
    "AI Repair",
  ]
  const moves = sections.flatMap((section, sectionIndex) =>
    lanes
      .filter(
        (lane) => lane !== "AI Repair" || (track.seed + sectionIndex) % 4 === 0,
      )
      .map((lane, laneIndex) => {
        const value =
          Math.round(
            (((track.seed + sectionIndex * 13 + laneIndex * 7) % 25) - 12) * 10,
          ) / 10
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
          start: section.start + length * 0.08,
          end: section.end - length * 0.08,
          value,
          originalValue: value,
          reason: `${profiles.find((p) => p.id === profile)?.name} adjustment for the ${section.type}.`,
          edited: false,
          muted: false,
        } satisfies Move
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
      track.seed % 2
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
