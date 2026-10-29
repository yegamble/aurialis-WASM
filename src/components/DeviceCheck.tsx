"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createLivePlayback, type LivePlaybackController, type LivePlaybackDiagnostics, type LivePlaybackState } from "@/lib/live-playback";
import { deviceCheckSettings, deviceCheckWAV } from "@/lib/device-check";
import { prepareProjectFile, importedTrack } from "@/lib/project-import";
import { readCanonicalWAV, type StereoPCM } from "@/lib/browser-engine";
import { reserveBrowserAudioMemory } from "@/lib/browser-jobs";
import { useTransportScrub } from "@/lib/use-transport-scrub";
import { useBrowserBuild } from "@/lib/build-mode";
import { downloadLocalBlob } from "@/lib/download";
import type { RenderQuality, Track } from "@/lib/types";
import { Button, ChoiceGroup, PageTitle, SliderField } from "./shared/Primitives";
import { RealTransport } from "./shared/RealTransport";
import { AuditionExport } from "./shared/AuditionExport";
import { DEFAULT_DELIVERY } from "@/lib/delivery-format";

type Prepared = { track: Track; pcm: StereoPCM; blob: Blob; rate: 48000 | 96000; quality: RenderQuality };
type Sample = { elapsedWallSeconds: number; state: LivePlaybackState; diagnostics: LivePlaybackDiagnostics };
type Hardware = { device: string; operatingSystem: string; browserVersion: string; outputRoute: string; changedRoute: string; observations: string };
const EMPTY_HARDWARE: Hardware = { device: "", operatingSystem: "", browserVersion: "", outputRoute: "", changedRoute: "", observations: "" };
function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="grid min-w-0 gap-1 text-sm">{label}<input className="min-h-[44px] min-w-0 rounded-xl border border-line-dark bg-paper px-3" value={value} maxLength={512} onChange={(event) => { onChange(event.target.value); }} /></label>;
}
/** Hidden from normal navigation; every audio path is the production controller and Go DSP. */
export function DeviceCheck() {
  const browserBuild = useBrowserBuild();
  const [rate, setRate] = useState<48000 | 96000>(48000), [quality, setQuality] = useState<RenderQuality>("classic");
  const [hardware, setHardware] = useState<Hardware>(EMPTY_HARDWARE), [confirmed, setConfirmed] = useState(false), [volumeResult, setVolumeResult] = useState("not_checked");
  const [prepared, setPrepared] = useState<Prepared | null>(null), [state, setState] = useState<LivePlaybackState | null>(null);
  const [busy, setBusy] = useState(false), [running, setRunning] = useState(false), [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("Prepare a generated source, then start a ten-minute run on the physical device."), [volume, setVolume] = useState(.5);
  const [snapshot, setSnapshot] = useState<LivePlaybackDiagnostics | null>(null), [secure, setSecure] = useState(false);
  const controller = useRef<LivePlaybackController | null>(null), pending = useRef<AbortController | null>(null);
  const memory = useRef<ReturnType<typeof reserveBrowserAudioMemory> | null>(null);
  const samples = useRef<Sample[]>([]), events = useRef<{ at: string; kind: string; detail: string }[]>([]);
  const { onScrub } = useTransportScrub(controller, { available: () => controller.current !== null, resume: () => { void controller.current?.play().catch((cause: unknown) => { setMessage(cause instanceof Error ? cause.message : "Playback could not resume."); }); } });
  const started = useRef<{ wall: number; audioMs: number | null } | null>(null);
  function record(kind: string, detail = "") { if (events.current.length < 128) events.current.push({ at: new Date().toISOString(), kind, detail }); }
  useEffect(() => {
    setSecure(window.isSecureContext && crossOriginIsolated);
    const changed = () => { record("browser_devicechange", "An event is not proof of a physical output route. Confirm the hardware manually."); };
    const devices = (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
    devices?.addEventListener("devicechange", changed);
    return () => { devices?.removeEventListener("devicechange", changed); pending.current?.abort(); controller.current?.dispose(); memory.current?.dispose(); };
  }, []);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      const player = controller.current, anchor = started.current; if (!player || !anchor) return;
      const diagnostics = player.getDiagnostics(), current = player.getState();
      setSnapshot(diagnostics);
      if (anchor.audioMs === null) {
        if (diagnostics.kernel) {
          anchor.audioMs = diagnostics.kernel.audioMs; anchor.wall = performance.now();
          samples.current.push({ elapsedWallSeconds: 0, state: current, diagnostics }); record("warmup_complete");
        } else if (performance.now() - anchor.wall > 15_000) { player.pause(); setRunning(false); setMessage("No actual audio-thread diagnostics arrived. This build cannot qualify a device; retain the failure record."); record("missing_diagnostics"); }
        return;
      }
      const elapsed = Math.max(0, ((diagnostics.kernel?.audioMs ?? anchor.audioMs) - anchor.audioMs) / 1000);
      setProgress(Math.min(600, elapsed));
      if (samples.current.length < 960) samples.current.push({ elapsedWallSeconds: (performance.now() - anchor.wall) / 1000, state: current, diagnostics });
      if (current.error || !current.playing || elapsed >= 600 || performance.now() - anchor.wall > 900_000) {
        player.pause(); setRunning(false); record("run_stopped", current.error ?? (elapsed >= 600 ? "Requested audio duration reached; owner review is still required." : "Playback stopped before the requested audio duration."));
        setMessage(current.error ?? (elapsed >= 600 ? "Ten minutes of rendered audio recorded. Download the diagnostics for review; this does not certify the hardware." : "The run ended early. Keep the diagnostics and describe what happened."));
      }
    }, 1000);
    return () => { clearInterval(timer); };
  }, [running]);
  async function prepare() {
    pending.current?.abort(); controller.current?.dispose(); controller.current = null; memory.current?.dispose(); memory.current = null;
    setPrepared(null); setState(null); setRunning(false); setBusy(true); setProgress(0);
    const abort = new AbortController(); pending.current = abort;
    let owner: ReturnType<typeof reserveBrowserAudioMemory> | null = null;
    try {
      owner = reserveBrowserAudioMemory(rate * 20 * 32 + 1048576);
      const file = new File([deviceCheckWAV(rate)], `device-check-${String(rate)}.wav`, { type: "audio/wav" });
      const imported = await prepareProjectFile(file, abort.signal, setMessage); abort.signal.throwIfAborted();
      const pcm = await readCanonicalWAV(imported.canonical); abort.signal.throwIfAborted();
      const track = { ...importedTrack(file, imported, `track-device-check-${String(rate)}`), advanced: deviceCheckSettings(quality) };
      owner.update(imported.canonical.size * 2); memory.current = owner; owner = null;
      setPrepared({ track, pcm, blob: imported.canonical, rate, quality }); setMessage("Source ready. Start is a separate user gesture, as Safari requires."); record("prepared", `${String(rate)} Hz / ${quality}`);
    } catch (cause) { setMessage(abort.signal.aborted ? "Preparation canceled." : cause instanceof Error ? cause.message : "Preparation failed."); }
    finally { owner?.dispose(); if (pending.current === abort) { pending.current = null; setBusy(false); } }
  }
  async function start() {
    if (!prepared || prepared.rate !== rate || prepared.quality !== quality || !secure) return;
    controller.current?.dispose(); samples.current = []; started.current = null; setProgress(0);
    try {
      const player = createLivePlayback(prepared.pcm, prepared.track.advanced, { onState: setState, onError: (error) => { setMessage(error.message); record("engine_error", error.message); } }, undefined, { diagnostics: true });
      controller.current = player; player.setRepeat(true); player.setVolume(volume);
      await player.play();
      started.current = { wall: performance.now(), audioMs: null };
      setRunning(true); setMessage("Running the production heavy chain. Keep this tab active and the output connected."); record("run_started");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Playback did not start."); record("start_failed"); }
  }
  function stop() { controller.current?.pause(); setRunning(false); record("owner_stopped"); }
  function download() {
    try {
      const record = { version: 1, classification: "pending_owner_and_peer_review", createdAt: new Date().toISOString(), url: location.href,
        build: process.env.NEXT_PUBLIC_AURIALIS_LIVE_ASSET_VERSION ?? "development", executionTarget: browserBuild ? "browser" : "native",
        environment: { userAgent: navigator.userAgent, webdriver: navigator.webdriver, secureContext: isSecureContext, isolated: crossOriginIsolated },
        operator: { ...hardware, physicalRouteConfirmedByOwner: confirmed, auditionVolumeObservation: volumeResult },
        source: prepared ? { identity: prepared.track.sourceIdentity, sampleRate: prepared.rate, durationSeconds: 20, quality: prepared.quality } : null,
        requestedAudioSeconds: 600, recordedAudioSeconds: progress, samples: samples.current, events: events.current,
        limitations: ["Owner declarations are not independently verified.", "Absent device playbackStats remains null, never zero underruns.", "Kernel timing uses the reported clock resolution; review its uncertainty.", "Headless or simulated hardware is not physical-device qualification."] };
      downloadLocalBlob(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }), `aurialis-device-check-${String(Date.now())}.json`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Diagnostics could not be saved."); }
  }
  const ready = !!prepared && prepared.rate === rate && prepared.quality === quality;
  return <main className="mx-auto grid max-w-[1100px] gap-6 p-4 md:p-8">
    <PageTitle eyebrow="Owner qualification bundle" title="Check a physical audio device" copy="Pending owner evidence. This page uses Aurialis’s production Go engine and playback controller; it cannot certify physical hardware by itself." />
    <Link className="inline-flex min-h-[44px] items-center text-clay-dark underline" href="/">Return to Aurialis</Link>
    {!secure && <p role="alert">Use the verified HTTPS branch preview or published site with cross-origin isolation. An HTTP address on your local network cannot run this check safely.</p>}
    <section className="paper-panel grid gap-4 p-4 md:p-6" aria-label="Physical device and output route">
      <h2>Record the actual hardware</h2><p className="disclosure">For Windows, name the Bluetooth device; for an audio interface, set its hardware rate to 96 kHz and record that rate. For Android, record its model. For iOS, also complete the audition volume check below.</p>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <TextField label="Physical device model" value={hardware.device} onChange={(device) => { setHardware({ ...hardware, device }); }} />
        <TextField label="Operating system and version" value={hardware.operatingSystem} onChange={(operatingSystem) => { setHardware({ ...hardware, operatingSystem }); }} />
        <TextField label="Browser and version" value={hardware.browserVersion} onChange={(browserVersion) => { setHardware({ ...hardware, browserVersion }); }} />
        <TextField label="Physical output route and hardware rate" value={hardware.outputRoute} onChange={(outputRoute) => { setHardware({ ...hardware, outputRoute }); }} />
      </div>
      <label className="check-row"><input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); }} />I confirm these are the physical device and output I used.</label>
      <p className="disclosure">{browserBuild ? "Generated audio is processed on this device; nothing is uploaded." : "Generated audio uses the native Aurialis build (built from source) and this browser."}</p>
    </section>
    <section className="paper-panel grid gap-4 p-4 md:p-6" aria-label="Ten-minute real-device run">
      <ChoiceGroup label="Generated source rate" value={rate} options={[{ value: 48000, label: "48 kHz", disabled: busy || running }, { value: 96000, label: "96 kHz", disabled: busy || running }]} onChange={setRate} />
      <ChoiceGroup label="Render quality" value={quality} options={[{ value: "classic", label: "Classic", disabled: busy || running }, { value: "oversampled", label: "Oversampled", disabled: busy || running }]} onChange={setQuality} />
      <p className="disclosure">The 96 kHz source still uses Aurialis’s declared live-rate cap. The requested interface rate does not override it. Oversampled must be supported by this exact build; errors are recorded rather than falling back.</p>
      <div className="flex flex-wrap gap-3"><Button disabled={busy || running || !secure} onClick={() => { void prepare(); }}>Prepare 20-second source</Button>{busy && <Button variant="secondary" onClick={() => { pending.current?.abort(); }}>Cancel preparation</Button>}<Button disabled={!ready || busy || running || !secure} onClick={() => { void start(); }}>Start ten-minute run</Button><Button variant="secondary" disabled={!running} onClick={stop}>Stop run</Button></div>
      <progress className="w-full" max={600} value={progress} aria-label="Rendered audio seconds in ten-minute run" /><p role="status">{message}</p>
      <p className="disclosure">Rendered audio: {progress.toFixed(1)} / 600 seconds. Device underruns: {snapshot?.deviceStats ? String(snapshot.deviceStats.underrunEvents) : "unavailable; no zero-underrun claim"}. Kernel timing: {snapshot?.kernel ? `${(snapshot.kernel.kernelMs / Math.max(1, snapshot.kernel.audioMs) * 100).toFixed(1)}% of audio time` : "waiting for actual audio-thread evidence"}.</p>
      <RealTransport inline state={state} sourceReady={ready && controller.current !== null} onPlay={async () => { await controller.current?.play(); }} onPause={stop} onOriginal={(original) => { controller.current?.setBypass(original); record("ab_original", String(original)); }} onVolume={(value) => { setVolume(value); controller.current?.setVolume(value); }} onRestart={() => { controller.current?.seek(0); record("seek_restart"); }} onForward={() => { const player = controller.current; if (player) player.seek((player.getState().position + 10) % 20); record("seek_forward"); }} onRepeat={(enabled) => { controller.current?.setRepeat(enabled); record("repeat", String(enabled)); }} onScrub={onScrub} />
    </section>
    <section className="paper-panel grid gap-4 p-4 md:p-6" aria-label="Output switch and iOS audition check">
      <h2>Change the output, then check audition volume</h2><p className="disclosure">During playback, switch the actual output in the operating system. Mark the change and name the new route. A browser devicechange event alone does not verify a hardware switch.</p>
      <Button variant="secondary" onClick={() => { record("owner_output_switch", hardware.changedRoute); }}>Mark physical output switch</Button>
      <TextField label="Changed physical output route" value={hardware.changedRoute} onChange={(changedRoute) => { setHardware({ ...hardware, changedRoute }); }} />
      {prepared && ready && <AuditionExport track={prepared.track} sourceBlob={prepared.blob} delivery={DEFAULT_DELIVERY} volume={volume} livePlaying={state?.playing ?? false} onStart={() => { controller.current?.pause(); setRunning(false); record("audition_started"); }} />}
      <SliderField label="Audition playback volume" value={volume} defaultValue={.5} min={0} max={1} step={.01} onChange={(value) => { setVolume(value); controller.current?.setVolume(value); }} />
      <p className="disclosure">On the actual iPhone or iPad, play Audition export, then move Audition playback volume from 25% to 100%. Record what you hear; desktop WebKit is not iOS evidence. Complete this separately from the uninterrupted ten-minute run.</p>
      <ChoiceGroup label="Audition volume observation" value={volumeResult} options={[{ value: "not_checked", label: "Not checked" }, { value: "changed", label: "Volume changed" }, { value: "failed", label: "Did not change" }]} onChange={setVolumeResult} />
      <TextField label="Glitches, interruptions and other observations" value={hardware.observations} onChange={(observations) => { setHardware({ ...hardware, observations }); }} />
      <Button onClick={download}>Download diagnostic JSON</Button>
    </section>
  </main>;
}
