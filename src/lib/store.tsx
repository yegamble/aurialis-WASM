"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import { clampAdvancedToSampleRate, createDefaultAdvancedParams, mapSimpleToDSP } from "./audio-dsp";
import { normalizeShortcutUndo, pruneShortcutUndo, toggleMasteringShortcut, type MasteringShortcut } from "./mastering-shortcuts";
import { masteringTargets } from "./mastering-targets";
import { restoredSimpleDirection, type SimpleChange } from "./simple-directions";
import { hasAppliedDeep } from "./reference-matching";
import { deepSourceMatches, readDeepMasteringState, type DeepMasteringState } from "./deep-mastering";
import type {
  Album,
  AdvancedParams,
  CompressorParams,
  DeHarshParams,
  MultibandParams,
  MultibandBandParams,
  EQBandId,
  EQBandParams,
  LimiterParams,
  ProfileId,
  RepairParams,
  SaturationParams,
  StereoParams,
  Track,
} from "./types";

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
];

type StoreState = {
  tracks: Track[];
  albums: Album[];
  stems: never[];
};

type StoreAction =
  | { type: "ADD_TRACK"; track: Track }
  | { type: "APPLY_SIMPLE_DIRECTION"; expected: Track; change: SimpleChange }
  | { type: "APPLY_REFERENCE"; expected: Track; reference?: Track; advanced: AdvancedParams; restore?: Pick<Track, "mode" | "simpleCustom" | "shortcutUndo"> }
  | { type: "TOGGLE_MASTERING_SHORTCUT"; trackId: string; shortcut: MasteringShortcut }
  | { type: "UPDATE_TRACK"; id: string; patch: Partial<Track> }
  | { type: "COMMIT_TRACK_SOURCE"; id: string; expectedRevision: number; expectedAudioKey: string; track: Track }
  | { type: "APPLY_NORMALIZED_GAIN"; id: string; expected: AdvancedParams; input: number }
  | {
      type: "UPDATE_SIMPLE";
      id: string;
      patch: Partial<Pick<Track, "genre" | "tone" | "intensity" | "target">>;
    }
  | {
      type: "UPDATE_EQ_BAND";
      trackId: string;
      bandId: EQBandId;
      patch: Partial<Omit<EQBandParams, "id" | "label">>;
    }
  | { type: "TOGGLE_EQ_ENABLED"; trackId: string; enabled: boolean }
  | {
      type: "UPDATE_COMPRESSOR";
      trackId: string;
      patch: Partial<CompressorParams>;
    }
  | {
      type: "UPDATE_SATURATION";
      trackId: string;
      patch: Partial<SaturationParams>;
    }
  | { type: "UPDATE_STEREO"; trackId: string; patch: Partial<StereoParams> }
  | { type: "UPDATE_LIMITER"; trackId: string; patch: Partial<LimiterParams> }
  | { type: "UPDATE_REPAIR"; trackId: string; patch: Partial<RepairParams> }
  | { type: "UPDATE_DE_HARSH"; trackId: string; patch: Partial<DeHarshParams> }
  | { type: "UPDATE_MULTIBAND"; trackId: string; patch: Partial<Omit<MultibandParams, "bands">> }
  | { type: "UPDATE_MULTIBAND_BAND"; trackId: string; index: 0 | 1 | 2; patch: Partial<MultibandBandParams> }
  | { type: "UPDATE_INPUT_GAIN"; trackId: string; input: number }
  | { type: "RESET_ADVANCED"; trackId: string }
  | { type: "DELETE_TRACK"; id: string }
  | { type: "ADD_ALBUM"; album: Album }
  | { type: "UPDATE_ALBUM"; id: string; patch: Partial<Album> }
  | { type: "DELETE_ALBUM"; id: string }
  | { type: "SAVE_DEEP_PROPOSAL"; id: string; expectedSourceRevision: number; expectedAudioKey: string; expectedProposalRevision: number | null; expectedAdvanced?: AdvancedParams; deep: Pick<DeepMasteringState, "sourceRevision" | "proposal" | "targets"> }
  | { type: "HYDRATE_STATE"; state: StoreState }
  | { type: "RESET_WORKSPACE" };

export const initialStoreState: StoreState = {
  tracks: [],
  albums: [],
  stems: [],
};

function updateTrackInList(
  tracks: Track[],
  id: string,
  updater: (track: Track) => Track,
): Track[] {
  return tracks.map((track) => (track.id === id ? pruneShortcutUndo(updater(track)) : track));
}

export function reduceStoreState(
  state: StoreState,
  action: StoreAction,
): StoreState {
  switch (action.type) {
    case "APPLY_SIMPLE_DIRECTION":
      return { ...state, tracks: updateTrackInList(state.tracks, action.expected.id, (track) => {
        if (track !== action.expected || hasAppliedDeep(track)) return track;
        return { ...track, ...action.change, shortcutUndo: action.change.simpleCustom ? track.shortcutUndo ?? {} : {}, updatedAt: new Date().toISOString() };
      }) };
    case "APPLY_REFERENCE":
      if (action.reference && !state.tracks.includes(action.reference)) return state;
      return { ...state, tracks: updateTrackInList(state.tracks, action.expected.id, (track) => {
        if (track !== action.expected || hasAppliedDeep(track)) return track;
        const next: Track = { ...track, advanced: action.advanced, mode: "advanced", simpleCustom: true, ...action.restore, updatedAt: new Date().toISOString() };
        if (action.restore) {
          if (action.restore.simpleCustom === undefined) delete next.simpleCustom;
          if (action.restore.shortcutUndo === undefined) delete next.shortcutUndo;
        }
        return next;
      }) };
    case "TOGGLE_MASTERING_SHORTCUT":
      return { ...state, tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({ ...track, ...toggleMasteringShortcut(track, action.shortcut), simpleCustom: true, updatedAt: new Date().toISOString() })) };
    case "ADD_TRACK":
      return { ...state, tracks: [{ ...action.track, simpleCustom: action.track.simpleCustom ?? true }, ...state.tracks] };

    case "SAVE_DEEP_PROPOSAL":
      return { ...state, tracks: updateTrackInList(state.tracks, action.id, (track) => {
        if (action.deep.sourceRevision !== action.expectedSourceRevision || !deepSourceMatches(track, action.deep.proposal, action.expectedSourceRevision) || (track.sourceAudioId ?? track.id) !== action.expectedAudioKey || (track.deepMastering?.proposal.revision ?? null) !== action.expectedProposalRevision || (action.expectedAdvanced && track.advanced !== action.expectedAdvanced)) return track;
        return { ...track, deepMastering: { ...track.deepMastering, sourceRevision: action.deep.sourceRevision, proposal: action.deep.proposal, targets: action.deep.targets }, updatedAt: new Date().toISOString() };
      }) };

    case "COMMIT_TRACK_SOURCE":
      return { ...state, tracks: updateTrackInList(state.tracks, action.id, (track) => (track.sourceRevision ?? 0) === action.expectedRevision && (track.sourceAudioId ?? track.id) === action.expectedAudioKey ? { ...action.track, updatedAt: new Date().toISOString() } : track) };

    case "UPDATE_TRACK":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.id, (track) => ({
          ...track,
          ...action.patch,
          ...(action.patch.advanced ? { simpleCustom: action.patch.simpleCustom ?? true } : {}),
          updatedAt: new Date().toISOString(),
        })),
      };

    case "APPLY_NORMALIZED_GAIN":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.id, (track) => track.advanced === action.expected ? {
          ...track, advanced: { ...track.advanced, input: action.input }, updatedAt: new Date().toISOString(),
        } : track),
      };

    case "UPDATE_SIMPLE":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.id, (track) => {
          const next = { ...track, ...action.patch };
          const mapped = clampAdvancedToSampleRate(mapSimpleToDSP(next.genre, next.tone, next.intensity, next.target), next.sampleRate);
          const directionChanged = action.patch.genre !== undefined || action.patch.tone !== undefined || action.patch.intensity !== undefined;
          const target = action.patch.target === undefined ? track.advanced.limiter : masteringTargets.find((item) => item.name === action.patch.target) ?? track.advanced.limiter;
          const limiterTarget = { targetLufs: target.targetLufs, ceiling: target.ceiling };
          return {
            ...next,
            shortcutUndo: directionChanged ? {} : track.shortcutUndo ?? {},
            simpleCustom: directionChanged ? false : track.simpleCustom ?? true,
            advanced: directionChanged ? { ...mapped, limiter: { ...mapped.limiter, ...limiterTarget } } : { ...track.advanced, limiter: { ...track.advanced.limiter, ...limiterTarget } },
            updatedAt: new Date().toISOString(),
          };
        }),
      };

    case "UPDATE_INPUT_GAIN":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          simpleCustom: true,
          advanced: {
            ...track.advanced,
            input: action.input,
          },
          updatedAt: new Date().toISOString(),
        })),
      };

    case "TOGGLE_EQ_ENABLED":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          simpleCustom: true,
          advanced: {
            ...track.advanced,
            eqEnabled: action.enabled,
          },
          updatedAt: new Date().toISOString(),
        })),
      };

    case "UPDATE_EQ_BAND":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => {
          const nextBands = track.advanced.eqBands.map((band) =>
            band.id === action.bandId ? { ...band, ...action.patch } : band,
          ) as Track["advanced"]["eqBands"];
          return {
            ...track,
            simpleCustom: true,
            advanced: {
              ...track.advanced,
              eqBands: nextBands,
            },
            updatedAt: new Date().toISOString(),
          };
        }),
      };

    case "UPDATE_COMPRESSOR":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => {
          const nextComp: CompressorParams = {
            ...track.advanced.compressor,
            ...action.patch,
          };
          return {
            ...track,
            simpleCustom: true,
            advanced: {
              ...track.advanced,
              threshold: nextComp.threshold,
              ratio: nextComp.ratio,
              attack: nextComp.attack,
              release: nextComp.release,
              compressor: nextComp,
            },
            updatedAt: new Date().toISOString(),
          };
        }),
      };

    case "UPDATE_SATURATION":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => {
          const nextSat: SaturationParams = {
            ...track.advanced.saturationModule,
            ...action.patch,
          };
          return {
            ...track,
            simpleCustom: true,
            advanced: {
              ...track.advanced,
              saturation: nextSat.drive,
              saturationModule: nextSat,
            },
            updatedAt: new Date().toISOString(),
          };
        }),
      };

    case "UPDATE_STEREO":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => {
          const nextStereo: StereoParams = {
            ...track.advanced.stereo,
            ...action.patch,
          };
          return {
            ...track,
            simpleCustom: true,
            advanced: {
              ...track.advanced,
              width: nextStereo.width,
              stereo: nextStereo,
            },
            updatedAt: new Date().toISOString(),
          };
        }),
      };

    case "UPDATE_LIMITER":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          simpleCustom: true,
          advanced: {
            ...track.advanced,
            limiter: {
              ...track.advanced.limiter,
              ...action.patch,
            },
          },
          updatedAt: new Date().toISOString(),
        })),
      };

    case "UPDATE_REPAIR":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          simpleCustom: true,
          advanced: {
            ...track.advanced,
            repair: {
              ...track.advanced.repair,
              ...action.patch,
            },
          },
          updatedAt: new Date().toISOString(),
        })),
      };

    case "UPDATE_DE_HARSH":
    case "UPDATE_MULTIBAND":
    case "UPDATE_MULTIBAND_BAND":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => {
          const advanced = { ...track.advanced };
          if (action.type === "UPDATE_DE_HARSH") advanced.deHarsh = { ...advanced.deHarsh, ...action.patch };
          else if (action.type === "UPDATE_MULTIBAND") advanced.multiband = { ...advanced.multiband, ...action.patch };
          else {
            const bands: MultibandParams["bands"] = [...advanced.multiband.bands];
            bands[action.index] = { ...bands[action.index], ...action.patch };
            advanced.multiband = { ...advanced.multiband, bands };
          }
          return { ...track, advanced: clampAdvancedToSampleRate(advanced, track.sampleRate), simpleCustom: true, updatedAt: new Date().toISOString() };
        }),
      };

    case "RESET_ADVANCED":
      return {
        ...state,
        tracks: updateTrackInList(state.tracks, action.trackId, (track) => ({
          ...track,
          simpleCustom: true,
          shortcutUndo: {},
          advanced: clampAdvancedToSampleRate(createDefaultAdvancedParams(), track.sampleRate),
          updatedAt: new Date().toISOString(),
        })),
      };

    case "DELETE_TRACK":
      return {
        ...state,
        tracks: state.tracks.filter((track) => track.id !== action.id),
        albums: state.albums.map((album) => ({
          ...album,
          trackIds: album.trackIds.filter((id) => id !== action.id),
        })),
        stems: [],
      };

    case "ADD_ALBUM":
      return { ...state, albums: [action.album, ...state.albums] };

    case "UPDATE_ALBUM":
      return {
        ...state,
        albums: state.albums.map((a) =>
          a.id === action.id ? { ...a, ...action.patch } : a,
        ),
      };

    case "DELETE_ALBUM":
      return {
        ...state,
        albums: state.albums.filter((a) => a.id !== action.id),
      };

    case "HYDRATE_STATE":
      return action.state;

    case "RESET_WORKSPACE":
      return initialStoreState;
  }
}

function normalizeSourceMetadata<T extends Omit<Track, "advanced">>(track: T): T {
  const restored = { ...track };
  let invalid = false;
  const asset = (value: unknown): value is string => typeof value === "string" && /^(?:track|source)-[a-zA-Z0-9-]{1,96}$/u.test(value);
  if (restored.sourceAudioId !== undefined && !asset(restored.sourceAudioId)) { delete restored.sourceAudioId; invalid = true; }
  if (restored.sourceRevision !== undefined && (!Number.isSafeInteger(restored.sourceRevision) || restored.sourceRevision < 0)) { delete restored.sourceRevision; invalid = true; }
  if (restored.retiredSourceAudioIds !== undefined && (!Array.isArray(restored.retiredSourceAudioIds) || restored.retiredSourceAudioIds.length > 64 || !restored.retiredSourceAudioIds.every(asset))) { delete restored.retiredSourceAudioIds; invalid = true; }
  const identity: unknown = restored.sourceIdentity;
  if (identity !== undefined && (typeof identity !== "object" || identity === null || !("pcmHash" in identity) || !("sampleRate" in identity) || !("frames" in identity) || typeof identity.pcmHash !== "string" || !/^[a-f0-9]{64}$/u.test(identity.pcmHash) || typeof identity.sampleRate !== "number" || !Number.isSafeInteger(identity.sampleRate) || identity.sampleRate < 8000 || identity.sampleRate > 192000 || identity.sampleRate !== track.sampleRate || typeof identity.frames !== "number" || !Number.isSafeInteger(identity.frames) || identity.frames < 1 || identity.frames > 16_777_216 || Math.abs(identity.frames / track.sampleRate - track.duration) > 0.001)) { delete restored.sourceIdentity; invalid = true; }
  if (restored.deepMastering !== undefined) {
    try { restored.deepMastering = readDeepMasteringState(restored.deepMastering, restored.sourceIdentity, restored.sourceRevision ?? 0); }
    catch { delete restored.deepMastering; invalid = true; }
  }
  if (invalid) restored.persistenceWarning = "Some source recovery metadata was invalid and was ignored. Restore the source if playback is unavailable; your mastering settings were preserved.";
  return restored;
}

export function normalizeHydratedState(raw: unknown): StoreState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as {
    tracks?: (Omit<Track, "advanced"> & {
      advanced?: Omit<Partial<AdvancedParams>, "compressor" | "stereo" | "saturationModule" | "limiter" | "repair" | "deHarsh" | "multiband"> & {
        compressor?: Partial<CompressorParams>;
        stereo?: Partial<StereoParams>;
        saturationModule?: Partial<SaturationParams>;
        limiter?: Partial<LimiterParams>;
        repair?: Partial<RepairParams>;
        deHarsh?: Partial<DeHarshParams>;
        multiband?: Omit<Partial<MultibandParams>, "bands"> & { bands?: Partial<MultibandBandParams>[] };
      };
    })[];
    albums?: Album[];
    stems?: unknown;
  };
  if (!Array.isArray(candidate.tracks)) return null;
  const tracks: Track[] = candidate.tracks.filter((track) => track.source !== "demo").map((track) => {
    const baseAdv = createDefaultAdvancedParams(track.advanced);
    const storedBands: unknown = track.advanced?.eqBands;
    const restored: Track & { script?: unknown } = { ...normalizeSourceMetadata(track), advanced: createDefaultAdvancedParams() };
    delete restored.script;
    delete restored.releaseScore;
    const simple = restoredSimpleDirection(track.simpleDirection);
    if (simple && simple.genre === track.genre && simple.tone === track.tone && simple.intensity === track.intensity) restored.simpleDirection = simple;
    else if (track.simpleDirection !== undefined) { delete restored.simpleDirection; restored.simpleCustom = true; }
    return pruneShortcutUndo({
      ...restored,
      shortcutUndo: normalizeShortcutUndo(track.shortcutUndo),
      simpleCustom: restored.simpleCustom !== false,
      mode: track.mode,
      advanced: clampAdvancedToSampleRate({
        ...baseAdv,
        ...track.advanced,
        eqBands:
          Array.isArray(storedBands) && storedBands.length === 5
            ? (storedBands as Track["advanced"]["eqBands"])
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
        deHarsh: { ...baseAdv.deHarsh, ...track.advanced?.deHarsh },
        multiband: {
          ...baseAdv.multiband,
          ...track.advanced?.multiband,
          // Index originates from the fixed three-band default tuple, never an external key.
          // eslint-disable-next-line security/detect-object-injection
          bands: baseAdv.multiband.bands.map((band, index) => ({ ...band, ...track.advanced?.multiband?.bands?.[index] })) as MultibandParams["bands"],
        },
        repair: {
          ...baseAdv.repair,
          ...(track.advanced?.repair ?? {}),
        },
      }, track.sampleRate),
    });
  });
  return {
    tracks,
    albums: Array.isArray(candidate.albums) ? candidate.albums.map((album) => ({ ...album, mastered: false, trackIds: album.trackIds.filter((id) => tracks.some((track) => track.id === id)) })) : [],
    stems: [],
  };
}

const StoreContext = createContext<{
  state: StoreState;
  dispatch: Dispatch<StoreAction>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceStoreState, initialStoreState);
  const [hydrated, setHydrated] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");

  useEffect(() => {
    try {
      const saved = globalThis.localStorage.getItem("aurialis-state-v1");
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        const hydrated = normalizeHydratedState(parsed);
        if (hydrated) {
          dispatch({ type: "HYDRATE_STATE", state: hydrated });
        }
      }
    } catch {
      setStorageWarning(
        "Saved settings could not be restored. This tab is using session settings.",
      );
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      globalThis.localStorage.setItem(
        "aurialis-state-v1",
        JSON.stringify(state),
      );
    } catch {
      setStorageWarning(
        "Settings could not be saved by your browser. Keep this tab open and export before leaving.",
      );
    }
  }, [state, hydrated]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return (
    <StoreContext.Provider value={value}>
      {storageWarning && (
        <p className="storage-warning" role="status">
          {storageWarning}
        </p>
      )}
      {hydrated ? (
        children
      ) : (
        <p className="page" role="status">
          Loading your local workspace…
        </p>
      )}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const value = useContext(StoreContext);
  if (!value) throw new Error("StoreProvider is missing");
  return value;
}

