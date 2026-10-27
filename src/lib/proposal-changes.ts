import { engineParams } from "./engine-params";
import type { ScriptV2 } from "./deep-mastering";
import type { AdvancedParams } from "./types";

type ProposalChange = { field: string; label: string; from: string; to: string };

const eqBands = ["Sub", "Low", "Mid", "Presence", "Air"];
const multibandBands = ["low", "mid", "high"];
// Engine flags that are not static settings a proposal can change.
const ignored = new Set(["algorithmVersion", "bypass", "abOriginal", "loudnessMatchAb", "ditherBits", "limiter.truePeak"]);
const fields: Record<string, [string, string]> = {
  inputGainDb: ["Input gain", "dB"], eqEnabled: ["EQ", ""],
  gainDb: ["gain", "dB"], freqHz: ["frequency", "Hz"], q: ["Q", ""], type: ["shape", ""], enabled: ["", ""],
  "compressor.enabled": ["Compressor", ""], "compressor.thresholdDb": ["Compressor threshold", "dB"], "compressor.ratio": ["Compressor ratio", ":1"],
  "compressor.attackMs": ["Compressor attack", "ms"], "compressor.releaseMs": ["Compressor release", "ms"], "compressor.kneeDb": ["Compressor knee", "dB"],
  "compressor.makeupDb": ["Compressor makeup", "dB"], "compressor.sidechainHpfHz": ["Compressor detector high-pass", "Hz"],
  "compressor.autoRelease": ["Compressor auto release", ""], "compressor.topology": ["Compressor type", ""],
  "saturation.enabled": ["Saturation", ""], "saturation.amount": ["Saturation drive", "%"], "saturation.character": ["Saturation character", ""],
  "stereo.enabled": ["Stereo", ""], "stereo.widthPct": ["Stereo width", "%"], "stereo.monoBass": ["Mono bass", ""], "stereo.crossoverHz": ["Mono-bass crossover", "Hz"],
  "stereo.midGainDb": ["Mid gain", "dB"], "stereo.sideGainDb": ["Side gain", "dB"],
  "limiter.enabled": ["Limiter", ""], "limiter.ceilingDbtp": ["Limiter ceiling", "dBTP"], "limiter.targetLufs": ["Loudness target", "LUFS"], "limiter.releaseMs": ["Limiter release", "ms"],
  "repair.enabled": ["Repair", ""], "repair.deEssDb": ["Repair de-ess", "dB"], "repair.transientDb": ["Repair transient", "dB"], "repair.deClip": ["Repair de-clip", ""],
  "deHarsh.enabled": ["De-harsh", ""], "deHarsh.frequencyHz": ["De-harsh frequency", "Hz"], "deHarsh.thresholdDb": ["De-harsh threshold", "dB"], "deHarsh.rangeDb": ["De-harsh range", "dB"],
  "multiband.enabled": ["Multiband", ""], "multiband.lowMidHz": ["Multiband low/mid crossover", "Hz"], "multiband.midHighHz": ["Multiband mid/high crossover", "Hz"],
  thresholdDb: ["threshold", "dB"], ratio: ["ratio", ":1"], attackMs: ["attack", "ms"], releaseMs: ["release", "ms"], makeupDb: ["makeup", "dB"],
};

function describe(path: string): [string, string] {
  const parts = path.split(".");
  const leaf = parts.at(-1) ?? path;
  const field = (key: string): [string, string] => Object.entries(fields).find(([name]) => name === key)?.[1] ?? [key, ""];
  if (parts[0] === "bands") {
    const [name, unit] = field(leaf);
    return [`EQ ${eqBands.at(Number(parts[1])) ?? parts[1] ?? ""}${name ? " " + name : ""}`, unit];
  }
  if (parts[0] === "multiband" && parts[1] === "bands") {
    const [name, unit] = field(leaf);
    return [`Multiband ${multibandBands.at(Number(parts[2])) ?? parts[2] ?? ""} ${name}`, unit];
  }
  return field(path);
}

function format(value: unknown, unit: string): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value !== "number") return String(value);
  const text = String(Math.round(value * 100) / 100 + 0).replace("-", "−");
  if (unit === ":1") return text + ":1";
  return unit ? `${text} ${unit}` : text;
}

function flatten(value: unknown, prefix: string, into: Map<string, unknown>): void {
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, into);
  } else into.set(prefix, value);
}

/** Every static setting Apply would change, from the current settings to the proposal baseline. */
export function proposalChanges(current: AdvancedParams, proposal: Pick<ScriptV2, "chainParams">): ProposalChange[] {
  // The proposal baseline never selects the unavailable live true-peak limiter or repair.
  const comparable = engineParams({ ...current, limiter: { ...current.limiter, truePeak: false }, repair: { ...current.repair, enabled: false } });
  const before = new Map<string, unknown>(), after = new Map<string, unknown>();
  flatten(comparable, "", before);
  flatten(proposal.chainParams, "", after);
  const changes: ProposalChange[] = [];
  for (const [field, next] of after) {
    const previous = before.get(field);
    if (ignored.has(field) || previous === next) continue;
    const [label, unit] = describe(field);
    changes.push({ field, label, from: format(previous, unit), to: format(next, unit) });
  }
  return changes;
}
