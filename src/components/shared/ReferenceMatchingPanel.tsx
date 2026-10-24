"use client";

import { useEffect, useRef, useState } from "react";
import { getAudio } from "@/lib/db";
import { audioKey, sameSource } from "@/lib/library";
import { hasAppliedDeep, matchReference, type ReferenceProposal } from "@/lib/reference-matching";
import { useStore } from "@/lib/store";
import type { AdvancedParams, Track } from "@/lib/types";
import { Button, PageTitle, SliderField, SpectrumChart, buttonClassName } from "./Primitives";
import { WorkspaceLink } from "./WorkspaceLink";

const DEFAULT_AMOUNT = 62;
function sameLoadedSource(left: Track, right: Track | undefined): boolean {
  return !!right && audioKey(left) === audioKey(right) && (left.sourceRevision ?? 0) === (right.sourceRevision ?? 0) && sameSource(left.sourceIdentity, right.sourceIdentity);
}
interface Review { proposal: ReferenceProposal; source: Track; reference: Track; owner: AdvancedParams }
interface Pending { expected: Track; reference?: Track; next: AdvancedParams; restoring: boolean }

export function ReferenceMatchingPanel({ trackId }: { trackId: string }) {
  const { state, dispatch } = useStore();
  const track = state.tracks.find((item) => item.id === trackId);
  const [referenceId, setReferenceId] = useState(state.tracks.find((item) => item.id !== trackId)?.id ?? "");
  const reference = state.tracks.find((item) => item.id === referenceId);
  const [amount, setAmount] = useState(DEFAULT_AMOUNT), [protect, setProtect] = useState(true), [includeWidth, setIncludeWidth] = useState(false);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [review, setReview] = useState<Review | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const operation = useRef<AbortController | null>(null);
  const before = useRef<Track | null>(null), owner = useRef<AdvancedParams | null>(null);
  const latest = useRef({ track, reference }); latest.current = { track, reference };
  function cancel(note = "Reference analysis canceled.") { const current = operation.current; operation.current = null; current?.abort(); setBusy(false); setReview(null); setError(""); setMessage(note); }
  useEffect(() => () => { const current = operation.current; operation.current = null; current?.abort(); }, []);
  useEffect(() => {
    // Acknowledge the reducer before validating session ownership. A prior
    // render's passive effect may still run after Apply has been requested.
    let rejected = false;
    if (pending && track) {
      if (track !== pending.expected && track.advanced === pending.next && sameLoadedSource(pending.expected, track) && !hasAppliedDeep(track)) {
        owner.current = pending.next;
        setMessage(pending.restoring ? "The complete settings from before this Reference session were restored." : "Measured proposal applied. Return to master to audition or export the current settings.");
        setPending(null);
        if (pending.restoring) { setReview(null); before.current = null; owner.current = null; }
        else setReview((current) => current ? { ...current, owner: pending.next } : null);
      } else if (track !== pending.expected || (pending.reference && reference !== pending.reference)) { setPending(null); setReview(null); rejected = true; }
    }
    if (before.current && (!sameLoadedSource(before.current, track) || track?.advanced !== owner.current || hasAppliedDeep(track))) {
      before.current = null; owner.current = null; cancel("Source or processing changed. Analyze a fresh proposal before applying.");
    } else if (review && (!sameLoadedSource(review.reference, reference) || !sameLoadedSource(review.source, track))) cancel("Source or reference changed. Analyze again.");
    if (rejected) setError("The project changed before Apply. Your newer settings were preserved; analyze again.");
  }, [track, reference, review, pending]);

  async function analyze() {
    if (!track || !reference || !track.sourceIdentity || !reference.sourceIdentity || hasAppliedDeep(track)) return;
    cancel(""); const controller = new AbortController(); operation.current = controller;
    if (!before.current || !sameLoadedSource(before.current, track) || track.advanced !== owner.current) before.current = track;
    owner.current = track.advanced;
    const snapshot = { source: track, reference, baseline: before.current.advanced, owner: track.advanced };
    setBusy(true); setProgress(0); setMessage("Loading the two original audio sources…");
    try {
      const source = await getAudio(audioKey(snapshot.source)); controller.signal.throwIfAborted();
      const referenceBlob = await getAudio(audioKey(snapshot.reference)); controller.signal.throwIfAborted();
      if (!source || !referenceBlob) throw new Error("Original source or reference audio is missing. Restore it from Library before matching.");
      const proposal = await matchReference(source, referenceBlob, snapshot.baseline, { amount: amount / 100, protectBelowHz: protect ? 120 : 0, includeWidth }, { source: track.sourceIdentity, reference: reference.sourceIdentity }, controller.signal, (value, stage) => { if (operation.current === controller && !controller.signal.aborted) { setProgress(value); setMessage(stage); } });
      if (operation.current !== controller || controller.signal.aborted) return;
      if (!sameLoadedSource(snapshot.source, latest.current.track) || !sameLoadedSource(snapshot.reference, latest.current.reference) || latest.current.track?.advanced !== snapshot.owner || hasAppliedDeep(latest.current.track)) throw new Error("The source, reference or processing changed during analysis. Analyze again.");
      setReview({ proposal, source: snapshot.source, reference: snapshot.reference, owner: snapshot.owner });
      setMessage("Measured proposal ready. Review the changes before Apply; your audio settings are unchanged.");
    } catch (reason) {
      if (operation.current === controller) { if (controller.signal.aborted) setMessage("Reference analysis canceled."); else { setError(reason instanceof Error ? reason.message : "Reference analysis failed."); setMessage(""); } }
    } finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  function apply() {
    if (!track || !reference || !review || pending || hasAppliedDeep(track) || !sameLoadedSource(review.source, track) || !sameLoadedSource(review.reference, reference) || track.advanced !== review.owner) { setError("This proposal is stale. Analyze again before applying."); return; }
    const next = review.proposal.advanced;
    setPending({ expected: track, reference, next, restoring: false });
    dispatch({ type: "APPLY_REFERENCE", expected: track, reference, advanced: next });
  }
  function revert() {
    if (!track || !before.current || track.advanced !== owner.current || hasAppliedDeep(track) || !sameLoadedSource(before.current, track)) return;
    const original = before.current;
    setPending({ expected: track, next: original.advanced, restoring: true });
    dispatch({ type: "APPLY_REFERENCE", expected: track, advanced: original.advanced, restore: { mode: original.mode, ...(original.simpleCustom !== undefined ? { simpleCustom: original.simpleCustom } : {}), ...(original.shortcutUndo ? { shortcutUndo: original.shortcutUndo } : {}) } });
  }
  if (!track) return <div className="page"><PageTitle eyebrow="Measured Reference" title="Choose your audio first" copy="Import a source and a reference track to compare their measured tonal balance." /><WorkspaceLink className={buttonClassName()} href="/">Import audio</WorkspaceLink></div>;
  const blocked = hasAppliedDeep(track);
  const unavailable = !track.sourceIdentity || !reference?.sourceIdentity;
  const result = review?.proposal;
  const canRevert = !!before.current && owner.current === track.advanced && track.advanced !== before.current.advanced && !blocked;
  return <div className="page">
    <PageTitle eyebrow="Measured Reference" title="Compare without copying" copy="Compare your source through its starting settings with the original reference audio. Review a conservative proposal; saved reference knob positions are ignored." action={<WorkspaceLink className={buttonClassName("secondary")} href={`/master/${track.id}`}>Back to master</WorkspaceLink>} />
    <div className="reference-layout">
      <section className="paper-panel min-w-0">
        <div className="compare-head"><div><span className="eyebrow">Source audio</span><h2 className="break-words">{track.title}</h2><p>{track.sampleRate.toLocaleString()} Hz · {track.duration.toFixed(2)} s</p></div><div><label className="eyebrow" htmlFor="reference-track">Reference audio</label><div className="select-wrap"><select id="reference-track" aria-label="Reference track" value={referenceId} onChange={(event) => { cancel("Reference changed. Analyze a new proposal."); setReferenceId(event.target.value); }}><option value="">Choose a reference project</option>{state.tracks.filter((item) => item.id !== track.id).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></div>{reference && <p>{reference.sampleRate.toLocaleString()} Hz · {reference.duration.toFixed(2)} s</p>}</div></div>
        {result ? <>
          <MeasuredReferenceBands proposal={result} />
          <div className="overlay-chart"><SpectrumChart eqBands={audibleBands(before.current?.advanced ?? track.advanced)} sampleRate={track.sampleRate} referenceBands={audibleBands(result.advanced)} referenceLabel="Proposed EQ response" /></div>
          <p className="disclosure">Rendered spectral mismatch: {result.beforeOutputResidualDb.toFixed(2)} → {result.afterOutputResidualDb.toFixed(2)} dB across the included common bands, after overall level normalization. These broad-band measurements do not establish perceptual similarity.</p>
          <p className="disclosure">EQ contour fit residual: {result.beforeResidualDb.toFixed(2)} → {result.fitResidualDb.toFixed(2)} dB. This measures the bounded five-band fit, not final perceptual similarity.</p>
          <p className="disclosure">Estimated added EQ peak: {result.maxPredictedBoostDb.toFixed(2)} dB.{result.options.protectBelowHz ? ` Protected 20–120 Hz: predicted ${result.maxProtectedDeltaDb.toFixed(3)} dB, rendered band energy ${result.remeasuredProtectedDeltaDb.toFixed(3)} dB${result.protectionVerified ? " (verified on this source)" : " (unchanged baseline)"}.` : " Low-end protection is off."}</p>
          <ul className="mt-3 space-y-2 text-xs" aria-label="Proposed EQ changes">{result.advanced.eqBands.map((band, i) => <li key={band.id}>{band.label}: {(before.current?.advanced.eqBands.at(i)?.gainDb ?? 0).toFixed(2)} → {band.gainDb.toFixed(2)} dB{!band.enabled || !result.advanced.eqEnabled ? " · processing disabled" : ""}</li>)}</ul>
          {result.width && <p className="disclosure">Width {result.width.beforeWidthPct.toFixed(1)} → {result.width.afterWidthPct.toFixed(1)}%. Rendered correlation {result.width.beforeCorrelation.toFixed(3)} → {result.width.afterCorrelation.toFixed(3)}; sample peak {result.width.afterSamplePeakDbfs.toFixed(2)} dBFS. {result.width.reason}</p>}
          {result.warnings.map((warning, index) => <p className="disclosure" key={`${String(index)}-${warning}`}>{warning}</p>)}
        </> : <p className="mt-8 text-sm text-ink-soft">Analyze to see measured common-band spectra, unavailable bands, proposed deltas and residual mismatch.</p>}
      </section>
      <aside className="paper-panel reference-controls min-w-0"><span className="eyebrow">Match direction</span><h2>Keep what matters</h2><p>Analysis leaves your settings unchanged. Amount changes use this session’s original baseline, so repeated Apply cannot accumulate corrections.</p>
        <SliderField label="Match amount" value={amount} defaultValue={DEFAULT_AMOUNT} min={0} max={100} step={1} unit="%" onChange={(value) => { cancel("Amount changed. Analyze a new proposal."); setAmount(value); }} />
        <label className="check-row"><input type="checkbox" checked={protect} onChange={(event) => { cancel("Protection changed. Analyze a new proposal."); setProtect(event.target.checked); }} />Protect low end</label>
        <label className="check-row"><input type="checkbox" checked={includeWidth} onChange={(event) => { cancel("Width option changed. Analyze a new proposal."); setIncludeWidth(event.target.checked); }} />Include width</label>
        <p className="disclosure">Protect low end limits predicted response and rendered 20–120 Hz band-energy change to 0.25 dB. Optional width stays within 20 percentage points × amount and is checked for mono compatibility.</p>
        {blocked && <p role="status" className="disclosure">Deep automation is attached. Detach it in Master before applying a static Reference proposal.</p>}
        {unavailable && <p className="disclosure">Choose two imported sources with verified identity. Restore or reimport older sources in Library if identity is unavailable.</p>}
        <div className="mt-5 flex flex-wrap gap-2"><Button disabled={busy || pending !== null || unavailable || blocked} onClick={() => { void analyze(); }}>Analyze reference audio</Button>{busy && <Button variant="ghost" onClick={() => { cancel(); }}>Cancel analysis</Button>}<Button variant="secondary" disabled={!review || busy || pending !== null || blocked} onClick={apply}>Apply measured proposal</Button><Button variant="ghost" disabled={!canRevert || busy || pending !== null} onClick={revert}>Revert Reference</Button></div>
        {busy && <progress className="mt-3 w-full" aria-label="Reference analysis progress" max={100} value={progress} />}
        <div className="min-h-[44px]" aria-live="polite">{message && <p role="status" className="disclosure">{message}</p>}{error && <p role="alert" className="disclosure text-danger">{error}</p>}</div>
        <p className="disclosure">Final LUFS and reconstructed peak headroom remain separate output checks. No hidden gain or automatic loudness matching is added. Revert is available during this Reference session while its applied settings remain current.</p>
      </aside>
    </div>
  </div>;
}

function audibleBands(advanced: AdvancedParams) { return advanced.eqEnabled ? advanced.eqBands : advanced.eqBands.map((band) => ({ ...band, enabled: false })); }

function MeasuredReferenceBands({ proposal }: { proposal: ReferenceProposal }) {
  const included = proposal.bands.filter((band) => band.included);
  const density = (band: ReferenceProposal["bands"][number], key: "sourceDensityDb" | "referenceDensityDb") => key === "sourceDensityDb" ? band.sourceDensityDb : band.referenceDensityDb;
  const level = (key: "sourceDensityDb" | "referenceDensityDb") => 10 * Math.log10(Math.max(1e-30, included.reduce((sum, band) => sum + Math.pow(10, density(band, key) / 10) * (band.highHz - band.lowHz), 0)));
  const sourceLevel = level("sourceDensityDb"), referenceLevel = level("referenceDensityDb");
  const high = Math.max(20.001, ...proposal.bands.map((band) => band.highHz));
  const x = (frequency: number) => 100 * Math.log(frequency / 20) / Math.log(high / 20);
  const y = (density: number) => 60 * (1 - (Math.max(-90, Math.min(-20, density)) + 90) / 70);
  const points = (key: "sourceDensityDb" | "referenceDensityDb", normalizer: number) => included.map((band) => `${x(Math.sqrt(band.lowHz * band.highHz)).toFixed(2)},${y(density(band, key) - normalizer).toFixed(2)}`).join(" ");
  return <div className="mt-6 min-w-0"><p className="disclosure">Measured five-band average spectral density, normalized to common-band energy. Solid: source through this session’s starting settings. Dashed: original reference. Lines join band averages and do not show narrow resonances.</p>
    <svg className="mt-3 block h-[160px] w-full" viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label="Measured source and reference band averages; exact values and unavailable bands are listed below. Horizontal axis logarithmic 20 Hz to common Nyquist or 20 kHz; vertical axis normalized density minus 90 to minus 20 dB per Hz."><title>Measured common-band spectral density</title><polyline points={points("sourceDensityDb", sourceLevel)} fill="none" stroke="var(--clay)" strokeWidth="2" vectorEffect="non-scaling-stroke" /><polyline points={points("referenceDensityDb", referenceLevel)} fill="none" stroke="var(--moss)" strokeWidth="2" strokeDasharray="5 3" vectorEffect="non-scaling-stroke" /></svg>
    <ol className="mt-3 space-y-2 text-xs" aria-label="Measured reference frequency bands">{proposal.bands.map((band, index) => <li key={index}>{band.lowHz.toLocaleString()}–{band.highHz.toLocaleString()} Hz: {band.included ? `source ${band.sourceDensityDb.toFixed(2)}, reference ${band.referenceDensityDb.toFixed(2)} dBFS/Hz; target delta ${band.targetDeltaDb.toFixed(2)}, predicted EQ delta ${band.predictedDeltaDb.toFixed(2)} dB` : "Excluded: insufficient audible energy or unavailable common bandwidth"}.</li>)}</ol>
  </div>;
}
