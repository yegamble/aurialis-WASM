"use client";

import { useEffect, useRef, useState } from "react";
import { getAudio } from "@/lib/db";
import { analyzeSourceFeatures, type FeatureMeasurements } from "@/lib/feature-analysis";
import { Button, ControlGroup } from "./Primitives";

export function FeatureAnalysisPanel({ trackId, sourceReady, audioId = trackId }: { trackId: string; sourceReady: boolean; audioId?: string }) {
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<FeatureMeasurements | null>(null);
  useEffect(() => {
    setResult(null);
    setMessage("");
    setError("");
    setBusy(false);
    return () => { const current = operation.current; operation.current = null; current?.abort(); };
  }, [trackId, sourceReady, audioId]);

  async function analyze() {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    setResult(null);
    setProgress(0);
    setMessage("Loading original audio…");
    try {
      const blob = await getAudio(audioId);
      controller.signal.throwIfAborted();
      if (!blob) throw new Error("Original audio is missing. Restore the source before analysis.");
      const measured = await analyzeSourceFeatures(blob, controller.signal, (value, stage) => {
        if (operation.current === controller && !controller.signal.aborted) { setProgress(value); setMessage(stage); }
      });
      if (operation.current === controller && !controller.signal.aborted) { setResult(measured); setMessage("Original audio measured. Your processing settings are unchanged."); }
    } catch (reason) {
      if (operation.current === controller) {
        if (controller.signal.aborted) setMessage("Analysis canceled.");
        else { setError(reason instanceof Error ? reason.message : "Audio analysis failed."); setMessage(""); }
      }
    } finally {
      if (operation.current === controller) setBusy(false);
    }
  }

  return <ControlGroup label="Measured source analysis">
    <p className="disclosure">Measure the original audio’s frequency balance and changes in energy, tone and stereo width. These diagnostics do not identify verses or choruses, generate mastering moves, or apply processing.</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={busy || !sourceReady} onClick={() => { void analyze(); }}>Analyze original audio</Button>
      {busy && <Button variant="ghost" onClick={() => { const current = operation.current; operation.current = null; current?.abort(); setBusy(false); setProgress(0); setMessage("Analysis canceled."); }}>Cancel analysis</Button>}
    </div>
    {busy && <progress className="mt-2 w-full" aria-label="Source analysis progress" max={100} value={progress} />}
    {message && <p role="status" className="disclosure">{message}</p>}
    {error && <p role="alert" className="disclosure text-danger">{error}</p>}
    {result && <div className="min-w-0 space-y-3">
      <p className="disclosure">Original · {result.source.sampleRate.toLocaleString()} Hz · {(result.source.frames / result.source.sampleRate).toFixed(2)} seconds</p>
      <p className="disclosure">Band energy (dBFS, mean-square power). Band widths differ; compare measured energy with that context.</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        {result.bands.map((band) => <div className="min-w-0" key={band.lowHz}>
          <dt>{band.lowHz.toLocaleString()}–{band.highHz.toLocaleString()} Hz</dt>
          <dd>{band.valid ? `${band.powerDb.toFixed(1)} dBFS${band.usableHighHz < band.highHz ? " (limited bandwidth)" : ""}` : "Unavailable at this sample rate"}</dd>
        </div>)}
      </dl>
      <p className="disclosure">Detected intervals use neutral labels. Change strength is a heuristic, not a probability of a musical role.</p>
      <ol className="space-y-2 text-xs" aria-label="Measured source sections">
        {result.sections.map((section) => <li key={section.id}>
          <strong>{section.name}</strong>: {(section.startFrame / result.source.sampleRate).toFixed(2)}–{(section.endFrame / result.source.sampleRate).toFixed(2)} s{section.startFrame > 0 ? ` · change strength ${Math.round(section.confidence * 100).toString()}%` : ""}
        </li>)}
      </ol>
      {result.warnings.map((warning) => <p className="disclosure" key={warning}>{warning}</p>)}
    </div>}
  </ControlGroup>;
}
