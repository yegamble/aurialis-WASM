"use client";

import { useId } from "react";
import { Button } from "./Primitives";
import type { AutomationTarget, ScriptV2 } from "@/lib/deep-mastering";

function automationLane(target: AutomationTarget): string {
  if (target === "inputGainDb") return "Volume";
  if (target.startsWith("eq.")) return "EQ";
  return target === "stereo.widthPct" ? "Width" : "Comp/Sat";
}
export function automationLabel(target: AutomationTarget): string {
  const names: Record<AutomationTarget, string> = { inputGainDb: "Input gain", "eq.0.gainDb": "Sub gain", "eq.1.gainDb": "Low gain", "eq.2.gainDb": "Mid gain", "eq.3.gainDb": "Presence gain", "eq.4.gainDb": "Air gain", "compressor.thresholdDb": "Compressor threshold", "compressor.ratio": "Compressor ratio", "saturation.amount": "Saturation amount", "stereo.widthPct": "Stereo width" };
  // Closed target union; no target paths are evaluated.
  // eslint-disable-next-line security/detect-object-injection
  return names[target];
}
const lanes = ["Volume", "EQ", "Comp/Sat", "Width", "AI Repair"];
const colors = ["var(--lane-volume)", "var(--lane-eq)", "var(--lane-compsat)", "var(--lane-width)", "var(--lane-repair)"];

export function DeepTimeline({ script, selectedId, onSelect, playheadRatio = 0 }: { script: ScriptV2; selectedId: string; onSelect: (id: string) => void; playheadRatio?: number }) {
  const summary = useId();
  return <section className="min-w-0 space-y-3" aria-label="Deep automation proposal">
    <div className="section-heading"><div><span className="eyebrow">Source-frame automation</span><h2>Review the proposal</h2></div></div>
    <p id={summary} className="disclosure">{script.sections.length} measured sections · {script.moves.length} authored moves · {script.moves.filter((move) => move.muted).length} muted. Select a move below to edit its exact source frames and values. Draft edits do not change playback.</p>
    <div className="min-w-0 overflow-x-auto rounded-2xl border border-line bg-paper p-2" role="region" tabIndex={0} aria-label="Scrollable automation timeline" aria-describedby={summary}>
      <div className="min-w-[640px] space-y-3">
        <div className="ml-[100px] flex min-h-[44px] border-b border-line text-[11px]">
          {script.sections.map((section) => <span key={section.id} className="min-w-0 border-l border-line px-2 py-2" style={{ flex: section.endFrame - section.startFrame }} title={section.name}>{section.name}</span>)}
        </div>
        {lanes.map((lane, index) => <div className="lane" key={lane}>
          <strong>{lane}</strong>
          <div className="relative h-[44px] min-w-0 rounded-lg bg-paper-deep" >
            {lane === "AI Repair" ? <span className="px-3 text-xs leading-[44px]">Not available yet</span> : script.moves.filter((move) => automationLane(move.target) === lane).map((move) => {
              const first = move.points[0]; const last = move.points.at(-1); if (!first || !last) return null;
              return <span key={move.id} aria-hidden="true" className="absolute top-3 h-5 min-w-px rounded-full border border-ink/30" style={{ left: String(first.frame / script.source.frames * 100) + "%", width: String((last.frame - first.frame) / script.source.frames * 100) + "%", backgroundColor: colors.at(index), opacity: move.muted ? 0.3 : 0.8 }} />;
            })}
            {script.moves.filter((move) => move.id === selectedId && automationLane(move.target) === lane).map((move) => <button key={move.id} type="button" className="absolute top-0 flex items-center justify-center !w-[44px] !min-w-[44px] !h-[44px] focus-visible:outline-2 focus-visible:outline-clay-dark" style={{ left: "clamp(0px, calc(" + String(((move.points[0]?.frame ?? 0) + (move.points.at(-1)?.frame ?? 0)) / 2 / script.source.frames * 100) + "% - 22px), calc(100% - 44px))" }} aria-label={"Edit selected " + automationLabel(move.target) + " move"} onClick={() => { onSelect(move.id); }}><span className="h-3 w-3 rounded-full border-2 border-paper bg-ink" /></button>)}
            {lane !== "AI Repair" && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-ink/60" style={{ left: String(Math.max(0, Math.min(1, playheadRatio)) * 100) + "%" }} />}
          </div>
        </div>)}
      </div>
    </div>
    <label className="grid gap-2 text-xs">Automation move<select className="min-h-[44px] min-w-[44px] max-w-full rounded-xl border border-line-dark bg-paper px-3" aria-label="Automation move" value={selectedId} onChange={(event) => { onSelect(event.target.value); }}>
      <option value="">Choose a move to edit</option>
      {script.moves.map((move, index) => <option key={move.id} value={move.id}>{index + 1}. {automationLabel(move.target)} · {script.sections.find((section) => section.id === move.sectionId)?.name} · {((move.points[0]?.frame ?? 0) / script.source.sampleRate).toFixed(2)}–{((move.points.at(-1)?.frame ?? 0) / script.source.sampleRate).toFixed(2)} s{move.muted ? " · muted" : ""}</option>)}
    </select></label>
    {selectedId && <Button variant="secondary" onClick={() => { onSelect(selectedId); }}>Edit selected move</Button>}
    <ol className="space-y-2 text-xs" aria-label="Measured proposal sections">{script.sections.map((section) => <li key={section.id}><strong>{section.name}</strong> · {(section.startFrame / script.source.sampleRate).toFixed(3)}–{(section.endFrame / script.source.sampleRate).toFixed(3)} s · {Math.round(section.confidence * 100)}% change strength · musical role unknown</li>)}</ol>
  </section>;
}
