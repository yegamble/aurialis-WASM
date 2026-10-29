"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { assembleAlbumSequence, type AlbumTransition } from "@/lib/album-transitions";
import { reserveBrowserAudioMemory } from "@/lib/browser-jobs";
import { downloadLocalBlob } from "@/lib/download";
import { safeFileBaseName } from "@/lib/zip";
import { Button, ChoiceGroup, SliderField } from "./Primitives";

type SequenceMasterFile = { id: string; title: string; blob: () => Promise<Blob | undefined>; durable: boolean };
type Held = { blob: Blob; url: string; memory: ReturnType<typeof reserveBrowserAudioMemory>; identity: string };

/** A separate, explicit continuous export leaves every individual master intact. */
export function AlbumSequence({ files, identity, title, transition, onChange, disabled = false }: {
  files: readonly SequenceMasterFile[]; identity: string; title: string; transition: AlbumTransition;
  onChange: (next: AlbumTransition) => void; disabled?: boolean;
}) {
  const heading = useId();
  const key = JSON.stringify([identity, transition.mode, transition.seconds, files.map((file) => file.id), disabled]);
  const currentKey = useRef(key); currentKey.current = key;
  const operation = useRef<AbortController | null>(null);
  const retained = useRef<Held | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const attachAudio = useCallback((element: HTMLAudioElement | null) => {
    const previous = audio.current;
    if (previous && previous !== element) { previous.pause(); previous.removeAttribute("src"); previous.load(); }
    audio.current = element;
  }, []);
  const [held, setHeld] = useState<Held | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

  const discard = () => {
    const old = retained.current;
    if (!old) return;
    audio.current?.pause();
    audio.current?.removeAttribute("src");
    audio.current?.load();
    URL.revokeObjectURL(old.url); old.memory.dispose(); retained.current = null;
  };
  useEffect(() => {
    setHeld(null); setWorking(false); setMessage("");
    return () => { operation.current?.abort(); operation.current = null; discard(); };
  }, [key]);

  const build = async () => {
    const controller = new AbortController();
    operation.current?.abort(); operation.current = controller;
    discard(); setHeld(null); setWorking(true); setMessage("Assembling the continuous album…");
    let memory: ReturnType<typeof reserveBrowserAudioMemory> | undefined;
    let owned = false;
    try {
      memory = reserveBrowserAudioMemory();
      const blobs: Blob[] = [];
      let inputBytes = 0;
      for (const file of files) {
        controller.signal.throwIfAborted();
        const blob = await file.blob();
        controller.signal.throwIfAborted();
        if (!blob) throw new Error(`The saved master for “${file.title}” is missing. Render the album again.`);
        inputBytes += blob.size; memory.update(inputBytes); blobs.push(blob);
      }
      const reservation = memory;
      const blob = await assembleAlbumSequence(blobs, transition, controller.signal, (bytes) => { reservation.update(bytes); });
      controller.signal.throwIfAborted();
      if (currentKey.current !== key || operation.current !== controller) return;
      const result: Held = { blob, url: URL.createObjectURL(blob), memory, identity: key };
      retained.current = result; owned = true; setHeld(result);
      setMessage("Continuous album ready. Press play to preview, or download this same WAV.");
    } catch (error) {
      if (!controller.signal.aborted && currentKey.current === key) setMessage(error instanceof Error ? error.message : "The continuous album could not be assembled. Try again.");
    } finally {
      if (!owned) memory?.dispose();
      if (operation.current === controller) { operation.current = null; setWorking(false); }
    }
  };
  const ready = held?.identity === key ? held : null;
  return <section className="paper-panel grid gap-4" aria-labelledby={heading}>
    <div><span className="eyebrow">Optional continuous export</span><h2 id={heading}>Album transitions</h2></div>
    <p className="disclosure">Individual masters keep their exact boundaries. Build a separate continuous stereo WAV to hear this running order. All masters need the same sample rate and bit depth.</p>
    <ChoiceGroup label="Transition" value={transition.mode} options={[{ value: "gapless", label: "Gapless" }, { value: "gap", label: "Silence between tracks" }, { value: "crossfade", label: "Linear crossfade" }]} onChange={(mode) => { onChange({ mode, seconds: mode === "gapless" ? 0 : transition.seconds || 1 }); }} />
    {transition.mode !== "gapless" && <SliderField label={transition.mode === "gap" ? "Gap duration" : "Crossfade duration"} value={transition.seconds} defaultValue={1} min={transition.mode === "crossfade" ? 0.1 : 0} max={5} step={0.1} unit="s" onChange={(seconds) => { onChange({ ...transition, seconds }); }} note={transition.mode === "crossfade" ? "Crossfades must span at least eight frames and at most half the shortest master." : "Silence is inserted between masters, never at the album ends."} />}
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={disabled || working || files.length === 0} onClick={() => { void build(); }}>Build continuous WAV</Button>
      {working && <Button variant="secondary" onClick={() => { operation.current?.abort(); setMessage("Continuous album assembly cancelled."); }}>Cancel continuous album</Button>}
      {ready && <>
        <Button variant="secondary" onClick={() => { try { downloadLocalBlob(ready.blob, `${safeFileBaseName(title, "Aurialis album")} - continuous.wav`); } catch (error) { setMessage(error instanceof Error ? error.message : "The continuous WAV could not be downloaded."); } }}>Download continuous WAV</Button>
        <Button variant="secondary" onClick={() => { discard(); setHeld(null); setMessage("Continuous album discarded."); }}>Discard continuous WAV</Button>
      </>}
    </div>
    {files.length === 0 && <p className="disclosure">Render current album masters before building a continuous WAV.</p>}
    {ready && <audio ref={attachAudio} controls preload="none" src={ready.url} aria-label="Continuous album preview" className="min-h-[44px] min-w-0 w-full" onError={() => { setMessage("This browser could not play the continuous WAV. Download it to listen in a compatible audio player."); }} />}
    <p role="status" className="disclosure">{message}</p>
  </section>;
}
