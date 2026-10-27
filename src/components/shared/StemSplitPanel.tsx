"use client";

import { useEffect, useRef, useState } from "react";
import { useBrowserBuild } from "@/lib/build-mode";
import { getAudio } from "@/lib/db";
import { downloadLocalBlob } from "@/lib/download";
import {
  canSplit, fetchStemAudio, runStemSplit, stemDownloadName, StemSplitError, stemSplitFailureKind, stemSplitFailureMessage, stemModelStatus,
  type SplitStem, type StemModelStatus, type StemSplit, type StemSplitFailure,
} from "@/lib/stem-split";
import { stemModelNote, stemSplitAvailability, stemSplitEstimate } from "@/lib/stem-split-copy";
import { Button } from "./Primitives";

const stemLayouts = new Map<number, string[]>([
  [2, ["Vocals", "Instrumental"]],
  [3, ["Vocals", "Drums", "Everything else"]],
  [4, ["Vocals", "Drums", "Bass", "Other"]],
  [5, ["Vocals", "Drums", "Bass", "Guitar & piano", "Other"]],
  [6, ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"]],
]);

/** The browser build's availability sentence already explains why nothing can run, so it has no model note. */
/** How often the panel re-checks a local server that stopped answering. */
const RECHECK_MS = 3000;

function StemRow({ stem, title }: { stem: SplitStem; title: string }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    setSaving(true);
    setError("");
    try {
      const blob = await fetchStemAudio(stem);
      try {
        downloadLocalBlob(blob, stemDownloadName(title, stem.name));
      } catch (failure) {
        // A memory-budget refusal already explains itself in plain language.
        setError(failure instanceof Error ? failure.message : "This stem could not be saved.");
      }
    } catch (failure) {
      setError(stemSplitFailureMessage(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: stem.color }} />
      <span className="min-w-0 flex-1 font-medium md:min-w-24 md:flex-none">{stem.name}</span>
      {/* Below md the player takes its own full-width line so its play control never collapses. */}
      <audio className="order-last w-full md:order-none md:w-auto md:min-w-0 md:flex-1" controls preload="none" src={stem.url} aria-label={`Play ${stem.name}`} />
      <Button variant="secondary" disabled={saving} aria-label={`Download ${stem.name}`} onClick={() => { void download(); }}>
        {saving ? "Preparing…" : "Download"}
      </Button>
      {error && <p className="order-last w-full text-xs text-danger" role="alert">{error}</p>}
    </li>
  );
}

/** duration is the track length in seconds, used for the split-time estimate; 0 when unknown. */
export function StemSplitPanel({ audioId, title, duration = 0 }: { audioId: string | null; title: string; duration?: number }) {
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
  // A server that stopped answering is not a disabled model: keep checking until it is back.
  const unreachable = status?.reachable === false;
  useEffect(() => {
    if (!unreachable || busy) return;
    const timer = setInterval(() => { void stemModelStatus().then(setStatus); }, RECHECK_MS);
    return () => { clearInterval(timer); };
  }, [unreachable, busy]);
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
        setLastFailure(stemSplitFailureKind(failure));
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

  const enabled = canSplit(browser, status, audioId);
  const estimate = !browser && status?.available === true ? stemSplitEstimate(status.speed, duration, status.arch) : null;
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
      {!browser && <p className="disclosure" role="status">{stemModelNote(status, lastFailure)}</p>}
      {estimate && <p className="disclosure">{estimate}</p>}
      <div className="flex flex-wrap gap-2">
        {busy
          ? <Button variant="secondary" onClick={cancel}>Cancel split</Button>
          : <Button disabled={!enabled} onClick={() => { void start(); }}>{split ? "Split again" : `Split ${title} into ${String(count)} stems`}</Button>}
      </div>
      {!audioId && <p className="disclosure">Import a track to split it.</p>}
      {busy && <div className="space-y-1"><progress className="w-full" max={100} value={progress} aria-label="Smart Split progress" /><p className="text-xs text-[var(--ink-soft)]">{stage}</p></div>}
      {error && <p className="disclosure text-danger" role="alert">{error}</p>}
      {split && (
        <ul className="col-span-full space-y-3" aria-label="Separated stems">
          {split.stems.map((stem) => <StemRow key={stem.id} stem={stem} title={title} />)}
        </ul>
      )}
      {split && <p className="col-span-full text-xs text-[var(--ink-soft)]">Stems are 24-bit WAV at the source sample rate. They stay available for 15 minutes or until you leave this page.</p>}
    </section>
  );
}
