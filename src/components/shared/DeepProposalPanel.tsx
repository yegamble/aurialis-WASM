"use client";

import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAudio } from "@/lib/db";
import { analyzeDeep, compileScript, deepProfiles, deepSourceMatches, readScriptV2, type AutomationMove, type DeepProfile, type ScriptV2 } from "@/lib/deep-mastering";
import { audioKey } from "@/lib/library";
import { useStore } from "@/lib/store";
import type { Track } from "@/lib/types";
import { BottomSheet, Button, ControlGroup } from "./Primitives";
import { automationLabel } from "./DeepTimeline";
import { DeepMoveEditor } from "./DeepMoveEditor";

function downloadScript(track: Track, script: ScriptV2, suffix: string) {
  const validated = readScriptV2(script, track.sourceIdentity);
  const url = URL.createObjectURL(new Blob([JSON.stringify(validated, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = (track.title.replace(/[^a-zA-Z0-9_-]/gu, "-") || "aurialis") + "-" + suffix + ".script-v2.json"; anchor.click();
  setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
}

const desktopQuery = "(min-width: 1024px)";
function subscribeDesktop(listener: () => void) { if (typeof window.matchMedia !== "function") return () => undefined; const query = window.matchMedia(desktopQuery); query.addEventListener("change", listener); return () => { query.removeEventListener("change", listener); }; }
function isDesktop() { return typeof window.matchMedia === "function" && window.matchMedia(desktopQuery).matches; }

export const DeepProposalPanel = memo(function DeepProposalPanel({ track, sourceReady, selectedMoveId, onSelectMove, editorOpen, onCloseEditor, onApply }: { track: Track; sourceReady: boolean; selectedMoveId: string; onSelectMove: (id: string) => void; editorOpen: boolean; onCloseEditor: () => void; onApply?: (script: ScriptV2) => Promise<void> }) {
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop, () => false);
  const { state, dispatch } = useStore(); const latest = useRef(state); latest.current = state;
  const operation = useRef<AbortController | null>(null);
  const [profile, setProfile] = useState<DeepProfile>(track.deepMastering?.proposal.profile ?? "Warm Analog");
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [soloId, setSoloId] = useState("");
  const [target, setTarget] = useState<AutomationMove["target"]>("inputGainDb"); const [sectionId, setSectionId] = useState("");
  const deep = track.deepMastering; const selected = deep?.proposal.moves.find((move) => move.id === selectedMoveId);
  useEffect(() => { setBusy(false); setProgress(0); setError(""); setMessage(""); setSoloId(""); return () => { const current = operation.current; operation.current = null; current?.abort(); }; }, [track.id, track.sourceRevision, track.sourceAudioId]);
  function saveProposal(proposal: ScriptV2, expected = deep?.proposal.revision ?? null, targets = deep?.targets) {
    if (!targets) return;
    dispatch({ type: "SAVE_DEEP_PROPOSAL", id: track.id, expectedSourceRevision: track.sourceRevision ?? 0, expectedAudioKey: audioKey(track), expectedProposalRevision: expected, deep: { sourceRevision: track.sourceRevision ?? 0, proposal, targets } });
  }
  function edit(move: AutomationMove) {
    if (!deep) return;
    if (deep.proposal.revision >= Number.MAX_SAFE_INTEGER) { setError("This proposal has reached its revision limit. Analyze again to start a new proposal."); return; }
    saveProposal({ ...deep.proposal, revision: deep.proposal.revision + 1, moves: deep.proposal.moves.map((item) => item.id === move.id ? move : item) });
  }
  async function analyze() {
    if (!track.sourceIdentity) { setError("Restore this source to record its canonical identity before Deep analysis."); return; }
    operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
    const sourceRevision = track.sourceRevision ?? 0; const expectedProposal = deep?.proposal.revision ?? null; const expectedAdvanced = track.advanced; const expectedKey = audioKey(track);
    setBusy(true); setError(""); setProgress(0); setMessage("Loading original audio…");
    try {
      const blob = await getAudio(expectedKey); controller.signal.throwIfAborted(); if (!blob) throw new Error("The source is missing. Restore it before Deep analysis.");
      const measured = await analyzeDeep(blob, profile, track.sourceIdentity, controller.signal, (value, stage) => { if (operation.current === controller && !controller.signal.aborted) { setProgress(value); setMessage(stage); } });
      controller.signal.throwIfAborted(); if (operation.current !== controller) return;
      const proposal = { ...measured, revision: Math.max(measured.revision, (expectedProposal ?? 0) + 1) };
      setMessage("Validating the proposed schedule…"); const compiled = await compileScript(proposal, proposal.source.sampleRate, controller.signal);
      controller.signal.throwIfAborted(); if (operation.current !== controller) return;
      const current = latest.current.tracks.find((item) => item.id === track.id);
      if (!current || !deepSourceMatches(current, proposal, sourceRevision) || audioKey(current) !== expectedKey || current.advanced !== expectedAdvanced || (current.deepMastering?.proposal.revision ?? null) !== expectedProposal) throw new Error("The source, settings or draft changed. Analyze again when ready.");
      dispatch({ type: "SAVE_DEEP_PROPOSAL", id: track.id, expectedSourceRevision: sourceRevision, expectedAudioKey: expectedKey, expectedProposalRevision: expectedProposal, expectedAdvanced, deep: { sourceRevision, proposal, targets: compiled.targets } });
      setMessage("Measured proposal ready. Your applied processing has not changed."); setSoloId(""); onSelectMove("");
    } catch (cause) { if (operation.current === controller && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Deep analysis failed."); }
    finally { if (operation.current === controller) { setBusy(false); operation.current = null; } }
  }
  function addMove() {
    if (!deep || deep.proposal.moves.length >= 128) return;
    if (deep.proposal.revision >= Number.MAX_SAFE_INTEGER) { setError("This proposal has reached its revision limit. Analyze again to start a new proposal."); return; }
    const section = deep.proposal.sections.find((item) => item.id === sectionId) ?? deep.proposal.sections[0]; if (!section) return;
    const id = "move-" + crypto.randomUUID();
    const move: AutomationMove = { id, sectionId: section.id, reason: "Manually authored move. Review its bounds and listen before applying.", target, operation: "add", points: [{ frame: section.startFrame, value: 0 }, { frame: section.endFrame, value: 0 }], fadeFrames: Math.min(Math.floor(deep.proposal.source.sampleRate / 20), Math.floor((section.endFrame - section.startFrame) / 2)), muted: false };
    saveProposal({ ...deep.proposal, revision: deep.proposal.revision + 1, moves: [...deep.proposal.moves, move] }); onSelectMove(id);
  }
  async function apply() {
    if (!deep || !onApply) return;
    const proposal = soloId ? { ...deep.proposal, moves: deep.proposal.moves.map((move) => ({ ...move, muted: move.muted || move.id !== soloId })) } : deep.proposal;
    setBusy(true); setError(""); setMessage("Preparing a complete processing revision…");
    try { await onApply(proposal); setMessage(soloId ? "Solo proposal applied to live playback and export." : "Proposal applied to live playback and export."); }
    catch (cause) { if (cause instanceof DOMException && cause.name === "AbortError") setMessage("Processing publication canceled. The previous applied revision remains selected."); else setError(cause instanceof Error ? cause.message : "The proposal could not be applied. The previous processing remains active."); }
    finally { setBusy(false); }
  }
  const editor = selected && deep ? <DeepMoveEditor script={deep.proposal} move={selected} targets={deep.targets} solo={soloId === selected.id} onChange={edit} onDelete={() => { if (deep.proposal.revision >= Number.MAX_SAFE_INTEGER) return; saveProposal({ ...deep.proposal, revision: deep.proposal.revision + 1, moves: deep.proposal.moves.filter((move) => move.id !== selected.id) }); if (soloId === selected.id) setSoloId(""); onSelectMove(""); }} onSolo={() => { setSoloId((current) => current === selected.id ? "" : selected.id); }} /> : null;
  return <section className="min-w-0 space-y-4" aria-label="Measured Deep mastering">
    <div><h2>Deep mastering</h2><p className="disclosure">Review a measured, source-bound proposal before applying it. Neutral sections and change strength do not identify musical roles.</p></div>
    <label className="grid gap-2 text-xs">Deep engineer profile<select className="min-h-[44px] min-w-[44px] max-w-full rounded-xl border border-line-dark bg-paper px-3" aria-label="Deep engineer profile" value={profile} onChange={(event) => { const selectedProfile = deepProfiles.find((item) => item === event.target.value); if (selectedProfile) setProfile(selectedProfile); }}>{deepProfiles.map((item) => <option key={item}>{item}</option>)}</select></label>
    <div className="flex flex-wrap gap-2"><Button disabled={busy || !sourceReady || !track.sourceIdentity} onClick={() => { void analyze(); }}>Analyze Deep proposal</Button>{busy && operation.current && <Button variant="secondary" onClick={() => { const current = operation.current; operation.current = null; current?.abort(); setBusy(false); setProgress(0); setMessage("Deep analysis canceled."); }}>Cancel Deep analysis</Button>}</div>
    {busy && <progress className="w-full" max={100} value={progress} aria-label="Deep analysis progress" />}
    <p className="disclosure min-h-10" role="status">{message}</p>{error && <p className="disclosure text-danger" role="alert">{error}</p>}
    {!track.sourceIdentity && <p className="disclosure">This older project needs an explicit source restore before measured Deep analysis.</p>}
    {deep && <>
      <p className="disclosure">{deep.proposal.summary}</p>
      <p className="disclosure">Draft revision {deep.proposal.revision} · {deep.proposal.moves.length} moves. {deep.applied ? "Applied revision " + String(deep.applied.revision) + " remains active until another complete revision is applied." : "Static processing remains active."}</p>
      <dl className="grid grid-cols-2 gap-2 text-xs"><div><dt>Proposed input</dt><dd>{deep.proposal.chainParams.inputGainDb.toFixed(2)} dB</dd></div><div><dt>Proposed ceiling</dt><dd>{deep.proposal.chainParams.limiter.ceilingDbtp.toFixed(2)} dBFS</dd></div></dl>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !sourceReady || !onApply} onClick={() => { void apply(); }}>{soloId ? "Apply solo proposal" : "Apply Deep proposal"}</Button><Button variant="secondary" onClick={() => { downloadScript(track, deep.proposal, "draft"); }}>Download draft Script JSON</Button>{deep.applied && <Button variant="secondary" onClick={() => { if (deep.applied) downloadScript(track, deep.applied, "applied"); }}>Download applied Script JSON</Button>}</div>
      {!onApply && <p className="disclosure">Automation application is awaiting live-engine integration and verification. Drafts can be reviewed, edited and downloaded.</p>}
      {soloId && <p className="disclosure">Solo proposal: Apply will mute the other moves in both live playback and export.</p>}
      {deep.proposal.findings.map((finding) => <div className="rounded-xl border border-line bg-paper-deep p-3" key={finding.id}><strong className="text-sm">{finding.title}</strong><p className="disclosure">{finding.detail}</p><small>{finding.severity === "warning" ? "Review warning" : "Measured observation"} · {finding.lane}</small></div>)}
      <ControlGroup label="Add a manual draft move"><label className="grid gap-2 text-xs">New move target<select className="min-h-[44px] min-w-[44px] max-w-full rounded-xl border border-line-dark bg-paper px-3" aria-label="New move target" value={target} onChange={(event) => { const next = deep.targets.find((item) => item.name === event.target.value); if (next) setTarget(next.name); }}>{deep.targets.map((item) => <option value={item.name} key={item.name}>{automationLabel(item.name)}</option>)}</select></label><label className="grid gap-2 text-xs">New move section<select className="min-h-[44px] min-w-[44px] max-w-full rounded-xl border border-line-dark bg-paper px-3" aria-label="New move section" value={sectionId || deep.proposal.sections[0]?.id || ""} onChange={(event) => { setSectionId(event.target.value); }}>{deep.proposal.sections.map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}</select></label><Button variant="secondary" disabled={deep.proposal.moves.length >= 128} onClick={addMove}>Add baseline move</Button><p className="disclosure">A new move adds zero to the baseline until you edit it. The server rejects overlapping moves on the same target.</p></ControlGroup>
    </>}
    {desktop ? editorOpen && editor && <section className="min-w-0 space-y-3 border-t border-line pt-4" aria-label="Edit selected draft move"><div className="flex flex-wrap items-center justify-between gap-2"><h3>Edit draft move</h3><Button variant="ghost" onClick={onCloseEditor}>Close move editor</Button></div>{editor}</section> : <BottomSheet open={editorOpen && !!selected} title={selected ? "Edit draft " + automationLabel(selected.target) : "Edit automation"} onClose={onCloseEditor}>{editor}</BottomSheet>}
  </section>;
});
