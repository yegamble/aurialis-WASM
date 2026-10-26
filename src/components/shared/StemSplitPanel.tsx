"use client";

import { useEffect, useRef, useState } from "react";
import { useBrowserBuild } from "@/lib/build-mode";
import { getAudio } from "@/lib/db";
import { runStemSplit, StemSplitError, stemSplitFailureMessage, stemModelStatus, type StemModelStatus, type StemSplit, type StemSplitFailure } from "@/lib/stem-split";
import { stemSplitAvailability } from "@/lib/stem-split-copy";
import { Button, buttonClassName } from "./Primitives";

const stemLayouts = new Map<number, string[]>([
  [2, ["Vocals", "Instrumental"]],
  [3, ["Vocals", "Drums", "Everything else"]],
  [4, ["Vocals", "Drums", "Bass", "Other"]],
  [5, ["Vocals", "Drums", "Bass", "Guitar & piano", "Other"]],
  [6, ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"]],
]);

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / 1_000_000))} MB`;
}

/** The browser build's availability sentence already explains why nothing can run, so it has no model note. */
function modelNote(status: StemModelStatus | null, lastFailure: StemSplitFailure | null): string {
  if (!status) return "Checking the separation model…";
  if (!status.available) return "Smart Split is turned off in this Aurialis server: it was started with the separation model disabled.";
  if (status.downloading) return `Downloading the separation model: ${megabytes(status.downloadedBytes)} of ${megabytes(status.totalBytes)}.`;
  if (status.ready) return "The separation model is ready.";
  if (lastFailure === "model") return `The ${megabytes(status.totalBytes)} separation model could not be downloaded or verified. The next split retries the download.`;
  return `The first split downloads the ${megabytes(status.totalBytes)} separation model once.`;
}

export function StemSplitPanel({ audioId, title }: { audioId: string | null; title: string }) {
  const browser = useBrowserBuild();
  const operation = useRef<AbortController | null>(null);
  const [count, setCount] = useState(4);
  const [status, setStatus] = useState<StemModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [lastFailure, setLastFailure] = useState<StemSplitFailure | null>(null);
  const [split, setSplit] = useState<StemSplit | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void stemModelStatus(controller.signal).then(setStatus).catch(() => undefined);
    return () => { controller.abort(); };
  }, []);
  // While a split waits on the first model download, show its byte count.
  useEffect(() => {
    if (!busy || !status?.available || status.ready) return;
    const timer = setInterval(() => { void stemModelStatus().then(setStatus); }, 1000);
    return () => { clearInterval(timer); };
  }, [busy, status?.available, status?.ready]);
  useEffect(() => () => { operation.current?.abort(); }, []);
  useEffect(() => () => { split?.release(); }, [split]);

  async function start() {
    if (!audioId) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setSplit(null);
    setError("");
    setLastFailure(null);
    setProgress(0);
    setStage("Reading the original audio…");
    setBusy(true);
    try {
      const blob = await getAudio(audioId);
      if (!blob) throw new StemSplitError("missing_source");
      const result = await runStemSplit(blob, count, controller.signal, (value, label) => { setProgress(value); setStage(label); });
      if (operation.current === controller) {
        setSplit(result);
        setStatus(await stemModelStatus());
      } else {
        result.release();
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(stemSplitFailureMessage(failure));
        setLastFailure(failure instanceof StemSplitError ? failure.kind : "internal");
        // A failed first download leaves the "downloading" note stale; re-read the model state.
        void stemModelStatus().then(setStatus);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
      }
    }
  }

  function cancel() {
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    setStage("");
  }

  const available = !browser && status?.available === true;
  return (
    <section className="split-intro paper-panel" aria-label="Smart Split">
      <div>
        <span className="eyebrow">Trained stem separation</span>
        <h2>Choose a stem layout</h2>
        <p>{stemSplitAvailability(browser)}</p>
        <p>Your audio stays on this device. Vocals, drums, bass and guitar separate cleanly; piano and Other are less reliable. The stems add up to the original mix.</p>
      </div>
      <div className="stem-count" role="group" aria-label="Stem count">
        {[2, 3, 4, 5, 6].map((number) => (
          <button type="button" key={number} aria-pressed={count === number} disabled={busy}
            className={count === number ? "is-active" : ""}
            onClick={() => { setCount(number); setSplit(null); }}>{number}</button>
        ))}
      </div>
      <div className="stem-preview">{(stemLayouts.get(count) ?? []).map((name) => <span key={name}>{name}</span>)}</div>
      {!browser && <p className="disclosure" role="status">{modelNote(status, lastFailure)}</p>}
      <div className="flex flex-wrap gap-2">
        {busy
          ? <Button variant="secondary" onClick={cancel}>Cancel split</Button>
          : <Button disabled={!available || !audioId} onClick={() => { void start(); }}>{split ? "Split again" : `Split ${title} into ${String(count)} stems`}</Button>}
      </div>
      {!audioId && <p className="disclosure">Import a track to split it.</p>}
      {busy && <div className="space-y-1"><progress className="w-full" max={100} value={progress} aria-label="Smart Split progress" /><p className="text-xs text-[var(--ink-soft)]">{stage}</p></div>}
      {error && <p className="disclosure text-danger" role="alert">{error}</p>}
      {split && (
        <ul className="space-y-3" aria-label="Separated stems">
          {split.stems.map((stem) => (
            <li key={stem.id} className="flex min-w-0 flex-wrap items-center gap-3">
              <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: stem.color }} />
              <span className="min-w-24 font-medium">{stem.name}</span>
              <audio className="min-w-0 max-w-full flex-1" controls preload="none" src={stem.url} aria-label={`Play ${stem.name}`} />
              <a className={buttonClassName("secondary")} href={stem.url} download={`${title} - ${stem.name}.wav`}>Download</a>
            </li>
          ))}
        </ul>
      )}
      {split && <p className="text-xs text-[var(--ink-soft)]">Stems are 24-bit WAV at the source sample rate. They stay available for 15 minutes or until you leave this page.</p>}
    </section>
  );
}
