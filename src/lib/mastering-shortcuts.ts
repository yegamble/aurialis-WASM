import { clampAdvancedToSampleRate, createDefaultAdvancedParams } from "./audio-dsp";
import type { AdvancedParams, ShortcutUndo, Track, EQBandParams, CompressorParams, SaturationParams } from "./types";

export type MasteringShortcut = "air" | "mud" | "tape" | "glue";

/** Explicit, idempotent starting points. Only the named module parameters change. */
export function applyMasteringShortcut(advanced: AdvancedParams, shortcut: MasteringShortcut, sampleRate: number): AdvancedParams {
  const next = { ...advanced };
  if (shortcut === "air" || shortcut === "mud") {
    next.eqEnabled = true;
    next.eqBands = advanced.eqBands.map((band) => {
      if (shortcut === "air" && band.id === "air") return { ...band, enabled: true, type: "highshelf" as const, freqHz: 12000, gainDb: 1, q: 0.707 };
      if (shortcut === "mud" && band.id === "low") return { ...band, enabled: true, type: "peaking" as const, freqHz: 250, gainDb: -1.5, q: 0.8 };
      return band;
    }) as AdvancedParams["eqBands"];
  } else if (shortcut === "tape") {
    next.saturation = 15;
    next.saturationModule = { enabled: true, character: "Tape", drive: 15 };
  } else {
    next.compressor = { ...advanced.compressor, enabled: true, threshold: -18, ratio: 2, attack: 30, release: 200, autoRelease: true, sidechainHpfHz: 90, knee: 6, makeup: 0 };
    next.threshold = next.compressor.threshold;
    next.ratio = next.compressor.ratio;
    next.attack = next.compressor.attack;
    next.release = next.compressor.release;
  }
  return clampAdvancedToSampleRate(next, sampleRate);
}

/** Selection follows the audible settings, including sample-rate-limited EQ. */
export function isMasteringShortcutActive(advanced: AdvancedParams, shortcut: MasteringShortcut, sampleRate: number): boolean {
  const expected = applyMasteringShortcut(advanced, shortcut, sampleRate);
  if (shortcut === "air" || shortcut === "mud") {
    const id = shortcut === "air" ? "air" : "low";
    const actualBand = advanced.eqBands.find((band) => band.id === id);
    const expectedBand = expected.eqBands.find((band) => band.id === id);
    return advanced.eqEnabled && !!actualBand && !!expectedBand &&
      actualBand.enabled === expectedBand.enabled && actualBand.type === expectedBand.type &&
      actualBand.freqHz === expectedBand.freqHz && actualBand.gainDb === expectedBand.gainDb && actualBand.q === expectedBand.q;
  }
  if (shortcut === "tape") {
    const actual = advanced.saturationModule;
    return actual.enabled && actual.character === expected.saturationModule.character && actual.drive === expected.saturationModule.drive;
  }
  // Manual release is retained but inaudible while automatic release is enabled.
  const actual = advanced.compressor;
  const target = expected.compressor;
  return actual.enabled && actual.autoRelease && actual.threshold === target.threshold &&
    actual.ratio === target.ratio && actual.attack === target.attack &&
    actual.sidechainHpfHz === target.sidechainHpfHz && actual.knee === target.knee && actual.makeup === target.makeup;
}


/** Drop undo records once their affected settings have been changed manually. */
export function pruneShortcutUndo(track: Track): Track {
  if (!track.shortcutUndo) return track;
  const undo = { ...track.shortcutUndo };
  if (!isMasteringShortcutActive(track.advanced, "air", track.sampleRate)) delete undo.air;
  if (!isMasteringShortcutActive(track.advanced, "mud", track.sampleRate)) delete undo.mud;
  if (!isMasteringShortcutActive(track.advanced, "tape", track.sampleRate)) { delete undo.tape; delete undo.tapeLegacy; }
  if (!isMasteringShortcutActive(track.advanced, "glue", track.sampleRate)) { delete undo.glue; delete undo.glueLegacy; }
  if (!undo.air && !undo.mud) delete undo.eqBaseline;
  if (undo.air === track.shortcutUndo.air && undo.mud === track.shortcutUndo.mud &&
    undo.tape === track.shortcutUndo.tape && undo.tapeLegacy === track.shortcutUndo.tapeLegacy &&
    undo.glue === track.shortcutUndo.glue && undo.glueLegacy === track.shortcutUndo.glueLegacy &&
    undo.eqBaseline === track.shortcutUndo.eqBaseline) return track;
  return { ...track, shortcutUndo: undo };
}

/** Toggle only the named module/band, retaining unrelated edits and other shortcuts. */
export function toggleMasteringShortcut(track: Track, shortcut: MasteringShortcut): Pick<Track, "advanced" | "shortcutUndo"> {
  const current = track.advanced;
  const undo: ShortcutUndo = { ...track.shortcutUndo };
  if (!isMasteringShortcutActive(current, shortcut, track.sampleRate)) {
    if (shortcut === "air" || shortcut === "mud") {
      undo.eqBaseline ??= { enabled: current.eqEnabled, bands: structuredClone(current.eqBands) };
      if (shortcut === "air") undo.air = { ...current.eqBands[4] };
      else undo.mud = { ...current.eqBands[1] };
    } else if (shortcut === "tape") { undo.tape = { ...current.saturationModule }; undo.tapeLegacy = current.saturation; }
    else {
      undo.glue = { ...current.compressor };
      undo.glueLegacy = { threshold: current.threshold, ratio: current.ratio, attack: current.attack, release: current.release };
    }
    return { advanced: applyMasteringShortcut(current, shortcut, track.sampleRate), shortcutUndo: undo };
  }
  const defaults = createDefaultAdvancedParams();
  const next = { ...current };
  if (shortcut === "air" || shortcut === "mud") {
    const fallbackBands = undo.eqBaseline?.enabled === false ? undo.eqBaseline.bands : defaults.eqBands;
    const band = shortcut === "air" ? (undo.air ?? fallbackBands[4]) : (undo.mud ?? fallbackBands[1]);
    next.eqBands = current.eqBands.map((item) => item.id === band.id ? { ...band } : item) as AdvancedParams["eqBands"];
    if (shortcut === "air") delete undo.air;
    else delete undo.mud;
    // A matching band may have been inaudible under the original global bypass.
    // Keep it bypassed while the other shortcut still needs the shared EQ stage.
    if (undo.eqBaseline?.enabled === false && (undo.air || undo.mud) && isMasteringShortcutActive(next, shortcut, track.sampleRate)) {
      next.eqBands = next.eqBands.map((item) => item.id === band.id ? { ...item, enabled: false } : item) as AdvancedParams["eqBands"];
    }
    // Restore the shared bypass only when both bands and all other EQ edits permit it.
    if (!undo.air && !undo.mud && undo.eqBaseline) {
      const baseline = undo.eqBaseline;
      const comparable = next.eqBands.map((item) => {
        const prior = baseline.bands.find((candidate) => candidate.id === item.id);
        return !baseline.enabled && !item.enabled && (item.id === "air" || item.id === "low") && prior ? { ...item, enabled: prior.enabled } : item;
      });
      if (JSON.stringify(comparable) === JSON.stringify(baseline.bands)) {
        next.eqEnabled = baseline.enabled;
        next.eqBands = structuredClone(baseline.bands);
      }
      delete undo.eqBaseline;
    }
    // Unrelated edits may keep global EQ enabled; off must still silence this band.
    if (isMasteringShortcutActive(next, shortcut, track.sampleRate)) {
      next.eqBands = next.eqBands.map((item) => item.id === band.id ? { ...item, enabled: false } : item) as AdvancedParams["eqBands"];
    }
  } else if (shortcut === "tape") {
    next.saturationModule = { ...(undo.tape ?? defaults.saturationModule) };
    next.saturation = undo.tapeLegacy ?? defaults.saturation;
    delete undo.tape;
    delete undo.tapeLegacy;
  } else {
    next.compressor = { ...(undo.glue ?? defaults.compressor) };
    // Release remains editable while Auto is on through saved/API settings.
    if (current.compressor.release !== 200) next.compressor.release = current.compressor.release;
    const legacy = undo.glueLegacy ?? defaults;
    next.threshold = legacy.threshold;
    next.ratio = legacy.ratio;
    next.attack = legacy.attack;
    next.release = current.compressor.release === 200 ? legacy.release : current.release;
    delete undo.glue;
    delete undo.glueLegacy;
  }
  return { advanced: clampAdvancedToSampleRate(next, track.sampleRate), shortcutUndo: undo };
}


function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function numbers(value: Record<string, unknown>, limits: [string, number, number][]): boolean {
  return limits.every(([key, min, max]) => {
    const item: unknown = Reflect.get(value, key);
    return typeof item === "number" && Number.isFinite(item) && item >= min && item <= max;
  });
}
function validBand(value: unknown): value is EQBandParams {
  const item = record(value);
  return !!item && typeof item.label === "string" && typeof item.enabled === "boolean" &&
    ["sub", "low", "mid", "presence", "air"].includes(String(item.id)) &&
    ["highpass", "lowshelf", "peaking", "highshelf"].includes(String(item.type)) &&
    numbers(item, [["freqHz", 20, 18000], ["gainDb", -15, 15], ["q", 0.1, 18]]);
}
function validCompressor(value: unknown): value is CompressorParams {
  const item = record(value);
  return !!item && typeof item.enabled === "boolean" && typeof item.autoRelease === "boolean" &&
    numbers(item, [["threshold", -60, 0], ["ratio", 1, 20], ["attack", 0.1, 200], ["release", 10, 2000], ["knee", 0, 24], ["makeup", -24, 36], ["sidechainHpfHz", 0, 1000]]);
}
function validSaturation(value: unknown): value is SaturationParams {
  const item = record(value);
  return !!item && typeof item.enabled === "boolean" &&
    ["Warm", "Thick", "Crisp", "Clean", "Tube", "Tape", "Transformer"].includes(String(item.character)) && numbers(item, [["drive", 0, 100]]);
}
/** Persist only bounded, structurally valid undo records from saved projects. */
export function normalizeShortcutUndo(value: unknown): ShortcutUndo {
  const item = record(value);
  const result: ShortcutUndo = {};
  if (!item) return result;
  if (validBand(item.air) && item.air.id === "air") result.air = { ...item.air };
  if (validBand(item.mud) && item.mud.id === "low") result.mud = { ...item.mud };
  if (validCompressor(item.glue)) result.glue = { ...item.glue };
  if (validSaturation(item.tape)) result.tape = { ...item.tape };
  if (typeof item.tapeLegacy === "number" && Number.isFinite(item.tapeLegacy) && item.tapeLegacy >= 0 && item.tapeLegacy <= 100) result.tapeLegacy = item.tapeLegacy;
  const legacy = record(item.glueLegacy);
  if (legacy && numbers(legacy, [["threshold", -60, 0], ["ratio", 1, 20], ["attack", 0.1, 200], ["release", 10, 2000]])) result.glueLegacy = { threshold: Number(legacy.threshold), ratio: Number(legacy.ratio), attack: Number(legacy.attack), release: Number(legacy.release) };
  const baseline = record(item.eqBaseline);
  if (baseline && typeof baseline.enabled === "boolean" && Array.isArray(baseline.bands) && baseline.bands.length === 5 && baseline.bands.every(validBand) &&
    baseline.bands.map((band: EQBandParams) => band.id).join(",") === "sub,low,mid,presence,air") {
    result.eqBaseline = { enabled: baseline.enabled, bands: baseline.bands.map((band: EQBandParams) => ({ ...band })) as AdvancedParams["eqBands"] };
  }
  return result;
}
