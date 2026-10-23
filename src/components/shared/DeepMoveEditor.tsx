"use client";

import { useEffect, useState } from "react";
import { automationTargets, type AutomationMove, type ScriptParams, type ScriptV2, type TargetMetadata } from "@/lib/deep-mastering";
import { automationLabel } from "./DeepTimeline";
import { Button, ControlGroup } from "./Primitives";

function NumberField({ label, value, minimum, maximum, integer = false, disabled = false, onChange }: { label: string; value: number; minimum: number; maximum: number; integer?: boolean; disabled?: boolean; onChange: (next: number) => void }) {
  const [text, setText] = useState(String(value)); const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(String(value)); setInvalid(false); }, [value]);
  return <ControlGroup label={label}>
    <input className="min-h-[44px] min-w-[44px] w-full rounded-xl border border-line-dark bg-paper px-3 tabular-nums" type="number" disabled={disabled} aria-label={label} aria-invalid={invalid} min={minimum} max={maximum} step={integer ? 1 : "any"} value={text} onChange={(event) => { setText(event.target.value); setInvalid(false); }} onBlur={() => { const next = Number(text); if (text.trim() === "" || !Number.isFinite(next) || next < minimum || next > maximum || (integer && !Number.isSafeInteger(next))) { setInvalid(true); return; } onChange(next); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <small className="text-ink-soft">{minimum.toFixed(integer ? 0 : 2)} to {maximum.toFixed(integer ? 0 : 2)}{invalid ? " · Enter a value within these bounds." : ""}</small>
  </ControlGroup>;
}
function baselineValue(params: ScriptParams, target: AutomationMove["target"]): number {
  const index = automationTargets.indexOf(target);
  const values = [params.inputGainDb, ...params.bands.map((band) => band.gainDb), params.compressor.thresholdDb, params.compressor.ratio, params.saturation.amount, params.stereo.widthPct];
  return values.at(index) ?? 0;
}
export function DeepMoveEditor({ script, move, targets, solo, onChange, onSolo, onDelete }: { script: ScriptV2; move: AutomationMove; targets: TargetMetadata[]; solo: boolean; onChange: (move: AutomationMove) => void; onSolo: () => void; onDelete: () => void }) {
  const metadata = targets.find((target) => target.name === move.target); const section = script.sections.find((item) => item.id === move.sectionId);
  if (!metadata || !section) return null;
  const bandIndex = ["eq.0.gainDb", "eq.1.gainDb", "eq.2.gainDb", "eq.3.gainDb", "eq.4.gainDb"].indexOf(move.target);
  const highPass = bandIndex >= 0 && script.chainParams.bands.at(bandIndex)?.type === "high_pass";
  const moduleEnabled = bandIndex >= 0 ? script.chainParams.eqEnabled && script.chainParams.bands.at(bandIndex)?.enabled : move.target.startsWith("compressor.") ? script.chainParams.compressor.enabled : move.target === "saturation.amount" ? script.chainParams.saturation.enabled : move.target === "stereo.widthPct" ? script.chainParams.stereo.enabled : true;
  const baseline = baselineValue(script.chainParams, move.target);
  const minimum = metadata.minimum - (move.operation === "add" ? baseline : 0); const maximum = metadata.maximum - (move.operation === "add" ? baseline : 0);
  return <div className="min-w-0 space-y-3">
    <p className="disclosure">{move.reason} These are draft edits. Apply publishes the baseline and all moves together.</p>
    <label className="grid gap-2 text-xs">Target<select aria-label="Move target" value={move.target} className="min-h-[44px] min-w-[44px] max-w-full rounded-xl border border-line-dark bg-paper px-3" onChange={(event) => { const target = automationTargets.find((item) => item === event.target.value); if (target) onChange({ ...move, target }); }}>{targets.map((target) => <option key={target.name} value={target.name}>{automationLabel(target.name)}</option>)}</select></label>
    <label className="grid gap-2 text-xs">Operation<select aria-label="Move operation" value={move.operation} className="min-h-[44px] min-w-[44px] rounded-xl border border-line-dark bg-paper px-3" onChange={(event) => { if (event.target.value === "add" || event.target.value === "absolute") onChange({ ...move, operation: event.target.value }); }}><option value="add">Add to the static baseline once</option><option value="absolute">Absolute value</option></select></label>
    <p className="disclosure">Static baseline: {baseline.toFixed(2)}. The Go compiler validates the complete envelope and rejects overlapping intervals. A move never enables its module.</p>
    {!moduleEnabled && <p className="disclosure">This target’s module is disabled in the static baseline. The move remains inaudible until you explicitly enable that module and apply the complete revision.</p>}
    {highPass && <p className="disclosure">High-pass filters have no gain control. Choose a shelf or peaking band in the static baseline before authoring gain automation.</p>}
    {move.points.map((point, index) => <div className="rounded-xl border border-line p-3" key={String(index)}>
      <NumberField label={"Point " + String(index + 1) + " source frame"} value={point.frame} minimum={index === 0 ? section.startFrame : (move.points.at(index - 1)?.frame ?? 0) + 1} maximum={index === move.points.length - 1 ? section.endFrame : (move.points.at(index + 1)?.frame ?? section.endFrame) - 1} integer onChange={(frame) => { onChange({ ...move, points: move.points.map((value, at) => at === index ? { ...value, frame } : value) }); }} />
      <NumberField label={"Point " + String(index + 1) + " value"} value={point.value} disabled={highPass} minimum={minimum} maximum={maximum} onChange={(value) => { onChange({ ...move, points: move.points.map((item, at) => at === index ? { ...item, value } : item) }); }} />
      {move.points.length > 2 && <Button variant="ghost" onClick={() => { onChange({ ...move, points: move.points.filter((_, at) => at !== index) }); }}>Delete point {index + 1}</Button>}
      <p className="disclosure">{(point.frame / script.source.sampleRate).toFixed(3)} seconds in the original source.</p>
      <Button variant="ghost" disabled={highPass} onClick={() => { onChange({ ...move, points: move.points.map((item, at) => at === index ? { ...item, value: move.operation === "add" ? 0 : baseline } : item) }); }}>Reset point {index + 1} to baseline</Button>
    </div>)}
    <Button variant="secondary" disabled={highPass || move.points.length >= 256 || !move.points.some((point, index) => (move.points.at(index + 1)?.frame ?? point.frame) - point.frame > 1)} onClick={() => {
      let largest = 1, at = -1;
      for (let index = 0; index < move.points.length - 1; index++) { const span = (move.points.at(index + 1)?.frame ?? 0) - (move.points.at(index)?.frame ?? 0); if (span > largest) { largest = span; at = index; } }
      if (at < 0) return;
      const points = [...move.points]; points.splice(at + 1, 0, { frame: (move.points.at(at)?.frame ?? 0) + Math.floor(largest / 2), value: move.operation === "add" ? 0 : baseline }); onChange({ ...move, points });
    }}>Add baseline point</Button>
    <p className="disclosure">New points use zero offset or the static baseline at the middle of the widest available interval. You can edit the exact frame and value.</p>
    <NumberField label="Move fade frames" value={move.fadeFrames} minimum={0} maximum={Math.min(Math.floor(script.source.sampleRate / 10), Math.floor(((move.points.at(-1)?.frame ?? 0) - (move.points[0]?.frame ?? 0)) / 2))} integer onChange={(fadeFrames) => { onChange({ ...move, fadeFrames }); }} />
    <div className="flex flex-wrap gap-2"><Button variant="secondary" aria-pressed={move.muted} onClick={() => { onChange({ ...move, muted: !move.muted }); }}>{move.muted ? "Unmute draft move" : "Mute draft move"}</Button><Button variant="secondary" aria-pressed={solo} onClick={onSolo}>{solo ? "Clear solo proposal" : "Solo in proposal"}</Button></div>
    <Button variant="ghost" onClick={onDelete}>Delete draft move</Button>
    {solo && <p className="disclosure">Apply solo proposal will mute the other moves in both live playback and export. Playback has not changed yet.</p>}
  </div>;
}
