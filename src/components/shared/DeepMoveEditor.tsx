"use client";

import { useEffect, useState } from "react";
import { automationTargets, type AutomationMove, type ScriptParams, type ScriptV2, type TargetMetadata } from "@/lib/deep-mastering";
import { automationLabel } from "./DeepTimeline";
import { Button, ControlGroup } from "./Primitives";

function NumberField({ label, value, minimum, maximum, integer = false, onChange }: { label: string; value: number; minimum: number; maximum: number; integer?: boolean; onChange: (next: number) => void }) {
  const [text, setText] = useState(String(value)); const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(String(value)); setInvalid(false); }, [value]);
  return <ControlGroup label={label}>
    <input className="min-h-11 min-w-11 w-full rounded-xl border border-line-dark bg-paper px-3 tabular-nums" type="number" aria-label={label} aria-invalid={invalid} min={minimum} max={maximum} step={integer ? 1 : 0.1} value={text} onChange={(event) => { setText(event.target.value); setInvalid(false); }} onBlur={() => { const next = Number(text); if (text.trim() === "" || !Number.isFinite(next) || next < minimum || next > maximum || (integer && !Number.isSafeInteger(next))) { setInvalid(true); return; } onChange(next); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <small className="text-ink-soft">{minimum.toFixed(integer ? 0 : 2)} to {maximum.toFixed(integer ? 0 : 2)}{invalid ? " · Enter a value within these bounds." : ""}</small>
  </ControlGroup>;
}
function baselineValue(params: ScriptParams, target: AutomationMove["target"]): number {
  const index = automationTargets.indexOf(target);
  const values = [params.inputGainDb, ...params.bands.map((band) => band.gainDb), params.compressor.thresholdDb, params.compressor.ratio, params.saturation.amount, params.stereo.widthPct];
  return values.at(index) ?? 0;
}
export function DeepMoveEditor({ script, move, targets, solo, onChange, onSolo }: { script: ScriptV2; move: AutomationMove; targets: TargetMetadata[]; solo: boolean; onChange: (move: AutomationMove) => void; onSolo: () => void }) {
  const metadata = targets.find((target) => target.name === move.target); const section = script.sections.find((item) => item.id === move.sectionId);
  if (!metadata || !section) return null;
  const baseline = baselineValue(script.chainParams, move.target);
  const minimum = metadata.minimum - (move.operation === "add" ? baseline : 0); const maximum = metadata.maximum - (move.operation === "add" ? baseline : 0);
  return <div className="min-w-0 space-y-3">
    <p className="disclosure">{move.reason} These are draft edits. Apply publishes the baseline and all moves together.</p>
    <label className="grid gap-2 text-xs">Target<select aria-label="Move target" value={move.target} className="min-h-11 min-w-11 max-w-full rounded-xl border border-line-dark bg-paper px-3" onChange={(event) => { const target = automationTargets.find((item) => item === event.target.value); if (target) onChange({ ...move, target }); }}>{targets.map((target) => <option key={target.name} value={target.name}>{automationLabel(target.name)}</option>)}</select></label>
    <label className="grid gap-2 text-xs">Operation<select aria-label="Move operation" value={move.operation} className="min-h-11 min-w-11 rounded-xl border border-line-dark bg-paper px-3" onChange={(event) => { if (event.target.value === "add" || event.target.value === "absolute") onChange({ ...move, operation: event.target.value }); }}><option value="add">Add to the static baseline once</option><option value="absolute">Absolute value</option></select></label>
    <p className="disclosure">Static baseline: {baseline.toFixed(2)}. The Go compiler validates the complete envelope and rejects overlapping intervals. A move never enables its module.</p>
    {move.points.map((point, index) => <div className="rounded-xl border border-line p-3" key={String(index)}>
      <NumberField label={"Point " + String(index + 1) + " source frame"} value={point.frame} minimum={index === 0 ? section.startFrame : (move.points.at(index - 1)?.frame ?? 0) + 1} maximum={index === move.points.length - 1 ? section.endFrame : (move.points.at(index + 1)?.frame ?? section.endFrame) - 1} integer onChange={(frame) => { onChange({ ...move, points: move.points.map((value, at) => at === index ? { ...value, frame } : value) }); }} />
      <NumberField label={"Point " + String(index + 1) + " value"} value={point.value} minimum={minimum} maximum={maximum} onChange={(value) => { onChange({ ...move, points: move.points.map((item, at) => at === index ? { ...item, value } : item) }); }} />
      <p className="disclosure">{(point.frame / script.source.sampleRate).toFixed(3)} seconds in the original source.</p>
      <Button variant="ghost" onClick={() => { onChange({ ...move, points: move.points.map((item, at) => at === index ? { ...item, value: move.operation === "add" ? 0 : baseline } : item) }); }}>Reset point {index + 1} to baseline</Button>
    </div>)}
    <NumberField label="Move fade frames" value={move.fadeFrames} minimum={0} maximum={Math.min(Math.floor(script.source.sampleRate / 10), Math.floor(((move.points.at(-1)?.frame ?? 0) - (move.points[0]?.frame ?? 0)) / 2))} integer onChange={(fadeFrames) => { onChange({ ...move, fadeFrames }); }} />
    <div className="flex flex-wrap gap-2"><Button variant="secondary" aria-pressed={move.muted} onClick={() => { onChange({ ...move, muted: !move.muted }); }}>{move.muted ? "Unmute draft move" : "Mute draft move"}</Button><Button variant="secondary" aria-pressed={solo} onClick={onSolo}>{solo ? "Clear solo proposal" : "Solo in proposal"}</Button></div>
    {solo && <p className="disclosure">Apply solo proposal will mute the other moves in both live playback and export. Playback has not changed yet.</p>}
  </div>;
}
