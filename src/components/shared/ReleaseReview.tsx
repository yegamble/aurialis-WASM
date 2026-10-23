"use client";

import { useEffect, useRef, useState } from "react";
import { getAudio } from "@/lib/db";
import { audioKey } from "@/lib/library";
import { collectReleaseReview, releaseBindingHash, type ReleaseReport } from "@/lib/release-review";
import { releaseChecks, releaseProfiles, type OutputBits, type ReleasePlatform } from "@/lib/release-policy";
import { useStore } from "@/lib/store";
import type { Track } from "@/lib/types";
import { Button, PageTitle, buttonClassName } from "./Primitives";
import { Icon } from "./Icon";
import { WorkspaceLink as Link } from "./WorkspaceLink";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
}

export function ReleaseReview({ trackId }: { trackId: string }) {
  const { state } = useStore();
  const track = state.tracks.find((item) => item.id === trackId);
  return track ? <TrackReleaseReview key={track.id} track={track} /> : <div className="page"><PageTitle eyebrow="Release check" title="Choose your audio first" copy="Import a track to review an encoded master." /><Link className={buttonClassName("primary")} href="/">Import audio</Link></div>;
}

function TrackReleaseReview({ track }: { track: Track }) {
  const { dispatch } = useStore();
  const [platform, setPlatform] = useState<ReleasePlatform>(track.releaseReview?.platform ?? "Spotify");
  const [bits, setBits] = useState<OutputBits>(track.releaseReview?.output.bitDepth ?? 24);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [basis, setBasis] = useState<{ owner: Track; bits: OutputBits; hash: string } | null>(null);
  const [artifact, setArtifact] = useState<{ report: ReleaseReport; wav: Blob } | null>(null);
  const pending = useRef<{ controller: AbortController; owner: Track; bits: OutputBits } | null>(null);
  const latest = useRef(track); latest.current = track;
  function owns(controller: AbortController) { return pending.current?.controller === controller; }
  function cancel(message = "") { pending.current?.controller.abort(); pending.current = null; setBusy(false); setError(message); }
  useEffect(() => () => { pending.current?.controller.abort(); pending.current = null; }, []);
  useEffect(() => {
    if (pending.current && (pending.current.owner !== track || pending.current.bits !== bits)) cancel("The source, settings or encoding changed. Run the release check again.");
    const controller = new AbortController();
    void releaseBindingHash(track, bits, controller.signal).then((hash) => {
      if (!controller.signal.aborted) setBasis({ owner: track, bits, hash });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The current settings could not be identified.");
    });
    return () => { controller.abort(); };
  }, [track, bits]);
  const key = basis?.owner === track && basis.bits === bits ? basis.hash : null;
  const measured = artifact?.report.bindingHash === key ? artifact : null;
  const saved = track.releaseReview?.bindingHash === key ? track.releaseReview : null;
  const report = measured?.report ?? saved;
  const checks = report ? releaseChecks(platform, report.metrics, report.output) : [];
  const assessed = checks.filter((item) => item.status !== "info"), passed = assessed.filter((item) => item.status === "pass").length;
  const profile = releaseProfiles.find((item) => item.name === platform);

  async function run() {
    cancel();
    const controller = new AbortController(); pending.current = { controller, owner: track, bits }; setBusy(true);
    try {
      const source = await getAudio(audioKey(track)); controller.signal.throwIfAborted();
      if (!source) throw new Error("The source audio is missing. Restore the matching source in Library.");
      const result = await collectReleaseReview(source, track, bits, platform, controller.signal);
      if (controller.signal.aborted || !owns(controller) || latest.current !== track) return;
      pending.current = null; setBusy(false); setArtifact(result);
    } catch (cause) {
      if (!controller.signal.aborted && owns(controller)) {
        pending.current = null; setBusy(false); setError(cause instanceof Error ? cause.message : "The release check failed. Try again.");
      }
    }
  }
  function downloadReport() {
    if (!report || !profile) return;
    const payload = { ...report, platform, measurementBasis: "decoded final encoded WAV", policy: { checkedAt: "2026-10-23", source: profile.source, scope: profile.scope }, checks,
      limitations: "Finite reconstructed-peak estimates and working diagnostics; no platform, codec, hardware or mastering certification. No automatic gain, resampling or repair." };
    download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "aurialis-audio-review.json");
  }
  return <div className="page">
    <PageTitle eyebrow="Release check" title="Ready for the handoff?" copy="Review the exact WAV you will download, with guidance for your destination."
      action={<Link className={buttonClassName("secondary")} href={`/master/${track.id}`}>Back to master</Link>} />
    <div className="release-top paper-panel">
      <div className="score-ring" aria-label="Measured checks within guidance"><strong>{report ? `${String(passed)}/${String(assessed.length)}` : "—"}</strong><span>within guidance</span></div>
      <div><span className="eyebrow">Selected release</span><h2>{track.title}</h2>
        <p>{report ? "Measurements describe the final encoded samples. Settings, source and encoding changes invalidate this check." : "Run a check to render and measure one master. Nothing is normalized or trimmed by the review."}</p>
        <div className="platforms" role="group" aria-label="Delivery profile">
          {releaseProfiles.map((item) => <button type="button" key={item.name} className={`chip min-h-[44px]${platform === item.name ? " is-active" : ""}`} aria-pressed={platform === item.name} onClick={() => { setPlatform(item.name); }}>{item.name}</button>)}
        </div>
        <label className="control-label">Review encoding <select className="min-h-[44px] max-w-full" aria-label="Review encoding" value={bits} onChange={(event) => {
          const value = Number(event.target.value); if (value === 16 || value === 24 || value === 32) { cancel(); setBits(value); }
        }}><option value={16}>16-bit PCM WAV</option><option value={24}>24-bit PCM WAV</option><option value={32}>32-bit Float WAV</option></select></label>
      </div>
      <Button onClick={() => void run()} disabled={busy || !track.sourceIdentity} icon={<Icon name={busy ? "refresh-cw" : "gauge"} />}>{busy ? "Measuring encoded audio…" : "Run release check"}</Button>
    </div>
    {busy && <Button variant="secondary" onClick={() => { cancel("Release check canceled. Current mastering settings were preserved."); }}>Cancel release check</Button>}
    <p className="disclosure" role={error ? "alert" : "status"}>{error || (!track.sourceIdentity ? "Restore the matching source in Library to establish its identity." : "Guidance and diagnostics help you review a master; the count is not a readiness percentage or delivery certification.")}</p>
    {profile && <p className="disclosure">{profile.scope} <a href={profile.source} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center underline">Read source guidance</a></p>}
    {report && <section className="check-list" aria-label="Encoded audio review">
      <div className="check-list-head"><span>Check</span><span>Reading</span><span>Guidance</span></div>
      {checks.map((item) => <div className="check-item" key={item.name}>
        <span className={`check-icon check-icon--${item.status === "pass" ? "pass" : "warn"}`}><Icon name={item.status === "pass" ? "check" : "circle-alert"} /></span>
        <strong>{item.name} ({item.status === "pass" ? "Within guidance" : item.status === "review" ? "Review" : "Information"})</strong><span>{item.reading}</span><p>{item.guidance}</p>
      </div>)}
      <p className="disclosure break-all">Encoded WAV SHA-256: {report.output.sha256}</p>
      <p className="disclosure">{measured ? "Download uses this retained measured WAV; it does not render another file." : "Saved measurements restored. Run again to restore the measured WAV download."}</p>
      <div className="report-actions flex-wrap">
        <Button variant="secondary" icon={<Icon name="arrow-down-to-line" />} onClick={downloadReport}>Download JSON report</Button>
        <Button variant="secondary" disabled={!measured} onClick={() => { if (measured) download(measured.wav, "aurialis-reviewed-master.wav"); }}>Download measured WAV</Button>
        <Button variant="secondary" disabled={busy} onClick={() => { dispatch({ type: "SAVE_RELEASE_REVIEW", expected: track, report: { ...report, platform } }); }}>Save report to project</Button>
      </div>
    </section>}
  </div>;
}
