"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { downloadLocalBlob } from "@/lib/download";
import { getAudio } from "@/lib/db";
import { audioKey } from "@/lib/library";
import { availableDelivery, CD_DELIVERY, DEFAULT_DELIVERY, deliveredRate, deliverySummary, type DeliveryFormat } from "@/lib/delivery-format";
import { exportRateChoices, unavailableRateNote } from "@/lib/export-rates";
import { collectReleaseReview, releaseBindingHash, reserveReleaseReviewMemory, type ReleaseArtifact } from "@/lib/release-review";
import { releaseChecks, releaseProfiles, type ReleasePlatform } from "@/lib/release-policy";
import { useStore } from "@/lib/store";
import { EXPORT_SAMPLE_RATES, type Track } from "@/lib/types";
import { DeliveryFormatControls } from "./DeliveryFormatControls";
import { Button, PageTitle, buttonClassName } from "./Primitives";
import { Icon } from "./Icon";
import { WorkspaceLink as Link } from "./WorkspaceLink";

export function ReleaseReview({ trackId }: { trackId: string }) {
  const { state } = useStore();
  const track = state.tracks.find((item) => item.id === trackId);
  return track ? <TrackReleaseReview key={track.id} track={track} /> : <div className="page"><PageTitle eyebrow="Release check" title="Choose your audio first" copy="Import a track to review an encoded master." /><Link className={buttonClassName("primary")} href="/">Import audio</Link></div>;
}

/** The format a saved check measured, so reopening shows that check. */
function savedFormat(track: Track): DeliveryFormat {
  const review = track.releaseReview;
  if (!review) return DEFAULT_DELIVERY;
  const rate = EXPORT_SAMPLE_RATES.find((item) => item === review.output.sampleRate && item !== track.sampleRate);
  return { bitDepth: review.output.bitDepth, sampleRate: rate ?? "source", dither: review.output.bitDepth === 32 || review.dither === "tpdf" };
}

function TrackReleaseReview({ track }: { track: Track }) {
  const { dispatch } = useStore();
  const [platform, setPlatform] = useState<ReleasePlatform>(track.releaseReview?.platform ?? "Spotify");
  const [chosen, setChosen] = useState<DeliveryFormat>(() => savedFormat(track));
  const frames = track.sourceIdentity?.frames ?? Math.round(track.duration * track.sampleRate);
  const rateChoices = useMemo(() => exportRateChoices(track.sampleRate, frames), [track.sampleRate, frames]);
  // The same fallback as Export: a rate this source cannot reach renders at the source rate.
  const format = useMemo(() => availableDelivery(chosen, rateChoices), [chosen, rateChoices]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [basis, setBasis] = useState<{ owner: Track; format: DeliveryFormat; hash: string } | null>(null);
  const [artifact, setArtifact] = useState<ReleaseArtifact | null>(null);
  const pending = useRef<{ controller: AbortController; owner: Track; format: DeliveryFormat } | null>(null);
  const latest = useRef(track); latest.current = track;
  const retainedArtifact = useRef<ReleaseArtifact | null>(null);
  function owns(controller: AbortController) { return pending.current?.controller === controller; }
  function cancel(message = "") { pending.current?.controller.abort(); pending.current = null; setBusy(false); setError(message); }
  useEffect(() => () => {
    pending.current?.controller.abort(); pending.current = null;
    retainedArtifact.current?.dispose(); retainedArtifact.current = null;
  }, []);
  useEffect(() => () => {
    artifact?.dispose();
    if (retainedArtifact.current === artifact) retainedArtifact.current = null;
  }, [artifact]);
  useEffect(() => {
    if (pending.current && (pending.current.owner !== track || pending.current.format !== format)) cancel("The source, settings or delivery format changed. Run the release check again.");
    const controller = new AbortController();
    void releaseBindingHash(track, format, controller.signal).then((hash) => {
      if (!controller.signal.aborted) {
        setBasis({ owner: track, format, hash });
        setArtifact((current) => current?.report.bindingHash === hash ? current : null);
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setArtifact(null);
        setError(cause instanceof Error ? cause.message : "The current settings could not be identified.");
      }
    });
    return () => { controller.abort(); };
  }, [track, format]);
  const key = basis?.owner === track && basis.format === format ? basis.hash : null;
  const measured = artifact?.report.bindingHash === key ? artifact : null;
  const saved = track.releaseReview?.bindingHash === key ? track.releaseReview : null;
  const report = measured?.report ?? saved;
  const checks = report ? releaseChecks(platform, report.metrics, report.output) : [];
  const assessed = checks.filter((item) => item.status !== "info"), passed = assessed.filter((item) => item.status === "pass").length;
  const profile = releaseProfiles.find((item) => item.name === platform);

  async function run() {
    cancel();
    const controller = new AbortController(); pending.current = { controller, owner: track, format }; setBusy(true);
    let memory: ReturnType<typeof reserveReleaseReviewMemory> | undefined;
    let published = false;
    try {
      memory = reserveReleaseReviewMemory(track, format);
      const source = await getAudio(audioKey(track)); controller.signal.throwIfAborted();
      if (!source) throw new Error("The source audio is missing. Restore the matching source in Library.");
      const result = await collectReleaseReview(source, track, format, platform, controller.signal, memory);
      if (controller.signal.aborted || !owns(controller) || latest.current !== track) { result.dispose(); return; }
      pending.current = null; setBusy(false); retainedArtifact.current = result; setArtifact(result); published = true;
    } catch (cause) {
      if (!controller.signal.aborted && owns(controller)) {
        pending.current = null; setBusy(false); setError(cause instanceof Error ? cause.message : "The release check failed. Try again.");
      }
    } finally { if (!published) memory?.dispose(); }
  }
  function downloadReport() {
    if (!report || !profile) return;
    const payload = { ...report, platform, measurementBasis: "decoded final encoded WAV", policy: { checkedAt: "2026-10-23", source: profile.source, scope: profile.scope }, checks,
      limitations: "Finite reconstructed-peak estimates and working diagnostics; no platform, codec, hardware or mastering certification. No automatic gain or repair; the source is resampled only to the chosen delivery rate." };
    try { downloadLocalBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "aurialis-audio-review.json"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The report could not be downloaded. Try again."); }
  }
  const cdFormat = deliveredRate(format, track.sampleRate) === 44100 && format.bitDepth === 16;
  const chooseFormat = (next: DeliveryFormat) => { cancel(); setArtifact(null); setChosen(next); };
  return <div className="page">
    <PageTitle eyebrow="Release check" title="Ready for the handoff?" copy="Review the exact WAV you will download, with guidance for your destination."
      action={<Link className={buttonClassName("secondary")} href={`/master/${track.id}`}>Back to master</Link>} />
    <div className="release-top paper-panel">
      <div className="score-ring" aria-label="Measured checks within guidance"><strong>{report ? `${String(passed)}/${String(assessed.length)}` : "—"}</strong><span>within guidance</span></div>
      <div><span className="eyebrow">Selected release</span><h2>{track.title}</h2>
        <p>{report ? "Measurements describe the final encoded samples. Settings, source and delivery format changes invalidate this check." : "Run a check to render and measure the master Export delivers at the format below. Nothing is normalized or trimmed by the review."}</p>
        <div className="platforms" role="group" aria-label="Delivery profile">
          {releaseProfiles.map((item) => <button type="button" key={item.name} className={`chip min-h-[44px]${platform === item.name ? " is-active" : ""}`} aria-pressed={platform === item.name} onClick={() => { setPlatform(item.name); }}>{item.name}</button>)}
        </div>
        <fieldset className="m-0 mt-4 min-w-0 border-0 p-0">
          <legend className="eyebrow">Delivery format</legend>
          <DeliveryFormatControls value={format} rateChoices={rateChoices} rateNote={unavailableRateNote(rateChoices, track.sampleRate)} onChange={chooseFormat} />
          <p className="disclosure" role="status">Checks {deliverySummary(format, track.sampleRate)}, the same file Export renders at this format.</p>
          {platform === "CD" && !cdFormat && <Button variant="secondary" onClick={() => { chooseFormat(CD_DELIVERY); }}>Use CD format: 44.1 kHz, 16-bit</Button>}
        </fieldset>
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
        <Button variant="secondary" disabled={!measured} onClick={() => {
          if (!measured) return;
          try { downloadLocalBlob(measured.wav, "aurialis-reviewed-master.wav"); }
          catch (cause) { setError(cause instanceof Error ? cause.message : "The measured WAV could not be downloaded. Try again."); }
        }}>Download measured WAV</Button>
        <Button variant="secondary" disabled={busy} onClick={() => { dispatch({ type: "SAVE_RELEASE_REVIEW", expected: track, report: { ...report, platform } }); }}>Save report to project</Button>
      </div>
    </section>}
  </div>;
}
