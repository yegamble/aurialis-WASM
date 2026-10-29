import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import * as engine from "@/lib/browser-engine";
import * as jobs from "@/lib/browser-jobs";
import { DEFAULT_DELIVERY, deliveryRequest } from "@/lib/delivery-format";
import { exportRender } from "@/lib/engine-params";
import { testStore } from "@/lib/__tests__/fixtures";
import type { Track } from "@/lib/types";
import { AuditionExport, auditionKey, type AuditionHandle } from "../AuditionExport";

function base(): Track {
  const track = testStore.tracks[0];
  if (!track) throw new Error("Missing fixture");
  return { ...track, sampleRate: 96000, sourceIdentity: { pcmHash: "a".repeat(64), sampleRate: 96000, frames: 96000 } };
}
const wav = new Blob([new Uint8Array(64)], { type: "audio/wav" });
const source = new Blob([new Uint8Array(44 + 96000 * 8)]);
const urls = { create: vi.fn(() => "blob:audition"), revoke: vi.fn() };
let pause: MockInstance<() => void>;
let playSpy: MockInstance<() => Promise<void>>;

function mount(track = base(), livePlaying = false, onStart = vi.fn(), onHandle?: (handle: AuditionHandle | null) => void) {
  const view = render(<AuditionExport track={track} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={livePlaying} onStart={onStart} {...(onHandle ? { onHandle } : {})} />);
  const element = () => { const audio = document.querySelector<HTMLAudioElement>("audio.audition-export"); if (!audio) throw new Error("Missing audition element"); return audio; };
  return { ...view, element, onStart };
}

beforeEach(() => {
  urls.create.mockClear(); urls.revoke.mockClear();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: urls.create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: urls.revoke });
  playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("pause")); });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Audition export (V1-10 owner ruling)", () => {
  it("seeks the held export by slider and media handle, but rejects stale seeks", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    let handle: AuditionHandle | null = null;
    const view = mount(base(), false, vi.fn(), (next) => { handle = next; });
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    await screen.findByRole("button", { name: "Pause audition" });
    Object.defineProperty(view.element(), "duration", { configurable: true, value: 1 });
    fireEvent.loadedMetadata(view.element());
    fireEvent.change(screen.getByRole("slider", { name: "Audition position" }), { target: { value: "0.4" } });
    expect(view.element().currentTime).toBe(0.4);
    act(() => { (handle as AuditionHandle | null)?.seek(0.8); });
    expect(view.element().currentTime).toBe(0.8);
    const edited = { ...base(), advanced: { ...base().advanced, input: 3 } };
    view.rerender(<AuditionExport track={edited} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    act(() => { (handle as AuditionHandle | null)?.seek(0.1); });
    expect(view.element().currentTime).toBe(0.8);
    expect(screen.queryByRole("slider", { name: "Audition position" })).toBeNull();
  });
  it("renders the exact Export request and plays that Blob through one media element, holding no decoded buffer", async () => {
    const decoded = vi.fn();
    vi.stubGlobal("AudioContext", vi.fn(() => ({ decodeAudioData: decoded })));
    const delivery = vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: -1.1 });
    const { element, onStart } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    expect(await screen.findByText("Playing the exact export file (96 kHz (source) · 24-bit PCM · TPDF dither).")).toBeTruthy();
    // The same arguments Export sends: export render, bit depth and delivery request.
    expect(delivery).toHaveBeenCalledWith(source, exportRender(base()), 24, deliveryRequest(DEFAULT_DELIVERY), expect.any(AbortSignal), expect.any(Function));
    expect(urls.create).toHaveBeenCalledExactlyOnceWith(wav);
    expect(element().getAttribute("src")).toBe("blob:audition");
    expect(onStart).toHaveBeenCalledOnce();
    // Memory: the media element streams the Blob; nothing decodes it into an AudioBuffer.
    expect(AudioContext).not.toHaveBeenCalled();
    expect(decoded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pause audition" }));
    expect(screen.getByRole("button", { name: "Play audition" })).toBeTruthy();
  });

  it("marks the audition stale after an edit, stops it and offers a re-render", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    await screen.findByRole("button", { name: "Pause audition" });
    pause.mockClear();
    const edited = { ...base(), advanced: { ...base().advanced, input: 3 } };
    view.rerender(<AuditionExport track={edited} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    expect(screen.getByText("Settings changed after this audition was rendered, so it no longer matches the export. Re-render to hear the current export.")).toBeTruthy();
    expect(pause).toHaveBeenCalledOnce();
    expect(view.element().getAttribute("src")).toBe("blob:audition");
    expect(screen.queryByRole("button", { name: /Play audition|Pause audition/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Re-render audition" })).toBeTruthy();
  });

  it("cancels a pending render, keeps no audio and releases its memory", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(engine, "renderDelivery").mockImplementation((_file, _render, _bits, _delivery, abort) => new Promise((_resolve, reject) => {
      signal = abort; abort?.addEventListener("abort", () => { reject(new DOMException("Canceled", "AbortError")); });
    }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    expect(screen.getByRole("progressbar", { name: "Audition export render progress" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel audition render" })); await Promise.resolve(); });
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText("Audition render canceled.")).toBeTruthy();
    expect(urls.create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Audition export" })).toBeTruthy();
  });

  /** A render the test completes by hand, after it has changed things. */
  function heldRender() {
    let finish: (() => void) | undefined;
    vi.spyOn(engine, "renderDelivery").mockImplementation(() => new Promise((resolve) => { finish = () => { resolve({ blob: wav, truePeakDbtp: -1.2 }); }; }));
    return async () => { await act(async () => { finish?.(); await Promise.resolve(); await Promise.resolve(); }); };
  }
  it("charges memory for the file once it exists and hands it to Export", async () => {
    const reserve = vi.spyOn(jobs, "reserveBrowserAudioMemory");
    const complete = heldRender();
    const onHeld = vi.fn();
    render(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={vi.fn()} onHeld={onHeld} />);
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    expect(reserve).not.toHaveBeenCalled();
    await complete();
    expect(reserve).toHaveBeenCalledExactlyOnceWith(wav.size);
    expect(onHeld).toHaveBeenLastCalledWith({ key: auditionKey(base(), DEFAULT_DELIVERY), blob: wav, truePeakDbtp: -1.2 });
  });
  it("an edit during the render leaves the result stale: it neither plays nor pauses live (R-1)", async () => {
    const complete = heldRender();
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    const edited = { ...base(), advanced: { ...base().advanced, input: 3 } };
    view.rerender(<AuditionExport track={edited} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    await complete();
    expect(screen.getByText("Settings changed after this audition was rendered, so it no longer matches the export. Re-render to hear the current export.")).toBeTruthy();
    expect(playSpy).not.toHaveBeenCalled();
    expect(view.onStart).not.toHaveBeenCalled();
  });
  it("live Play during the render keeps the transport: the audition waits, ready (R-1)", async () => {
    const complete = heldRender();
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying onStart={view.onStart} />);
    await complete();
    expect(screen.getByText("Ready: the exact export file (96 kHz (source) · 24-bit PCM · TPDF dither).")).toBeTruthy();
    expect(playSpy).not.toHaveBeenCalled();
    expect(view.onStart).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play audition" })).toBeTruthy();
  });

  it("follows the Playback volume on start and on every move (Round 6 REQUIRED-1)", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const onStart = vi.fn();
    const view = render(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={0.1} livePlaying={false} onStart={onStart} />);
    const element = () => { const audio = document.querySelector<HTMLAudioElement>("audio.audition-export"); if (!audio) throw new Error("Missing audition element"); return audio; };
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    await screen.findByRole("button", { name: "Pause audition" });
    expect(element().volume).toBeCloseTo(0.1, 6);
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={0.55} livePlaying={false} onStart={onStart} />);
    expect(element().volume).toBeCloseTo(0.55, 6);
  });
  it("builds the iOS GainNode route only in a Play click, once under StrictMode, and resumes it (Round 7 R-2)", async () => {
    const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
    const assigned: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, "volume", { configurable: true, get: () => 1, set: (value: number) => { assigned.push(value); } });
    onTestFinished(() => { if (volume) Object.defineProperty(HTMLMediaElement.prototype, "volume", volume); });
    const gain = { gain: { value: 1 }, connect: vi.fn(() => ({})) };
    const sources = vi.fn(() => ({ connect: vi.fn(() => gain) }));
    const created = vi.fn(), resume = vi.fn();
    vi.stubGlobal("AudioContext", class {
      destination = {}; state = "suspended";
      constructor() { created(); }
      createGain() { return gain; }
      createMediaElementSource() { return sources(); }
      resume() { resume(); this.state = "running"; return Promise.resolve(); }
      close() { return Promise.resolve(); }
    });
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const onStart = vi.fn();
    const view = render(<StrictMode><AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={0.2} livePlaying={false} onStart={onStart} /></StrictMode>);
    view.rerender(<StrictMode><AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={0.3} livePlaying={false} onStart={onStart} /></StrictMode>);
    expect(created).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    // Auto-play after the render is not a gesture: no context, it waits, Ready.
    expect(await screen.findByText(/^Ready: the exact export file/u)).toBeTruthy();
    expect(created).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Play audition" })); await Promise.resolve(); await Promise.resolve(); });
    expect(created).toHaveBeenCalledOnce();
    expect(sources).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(gain.gain.value).toBeCloseTo(0.3, 6);
    expect(assigned.at(-1)).toBe(1);
    expect(playSpy).toHaveBeenCalledOnce();
    view.rerender(<StrictMode><AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={0.6} livePlaying={false} onStart={onStart} /></StrictMode>);
    expect(gain.gain.value).toBeCloseTo(0.6, 6);
    expect(created).toHaveBeenCalledOnce();
    expect(sources).toHaveBeenCalledOnce();
  });
  /** An iOS-like element whose .volume never sticks, and a recording AudioContext. */
  function iosMock() {
    const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
    Object.defineProperty(HTMLMediaElement.prototype, "volume", { configurable: true, get: () => 1, set: () => undefined });
    onTestFinished(() => { if (volume) Object.defineProperty(HTMLMediaElement.prototype, "volume", volume); });
    const gain = { gain: { value: 1 }, connect: vi.fn(() => ({})) };
    const calls: string[] = [];
    const contexts: { state: string }[] = [];
    vi.stubGlobal("AudioContext", class {
      destination = {}; state = "suspended";
      constructor() { contexts.push(this); }
      createGain() { return gain; }
      createMediaElementSource() { return { connect: vi.fn(() => gain) }; }
      resume() { calls.push("resume"); this.state = "running"; return Promise.resolve(); }
      close() { return Promise.resolve(); }
    });
    playSpy.mockImplementation(function (this: HTMLMediaElement) { calls.push("play"); this.dispatchEvent(new Event("play")); return Promise.resolve(); });
    return { gain, calls, contexts };
  }
  it("starts resume and play() synchronously in the click, before any await (Round 8 S-1)", async () => {
    const { calls } = iosMock();
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    await screen.findByText(/^Ready: the exact export file/u);
    fireEvent.click(screen.getByRole("button", { name: "Play audition" }));
    // No await between the click and these: both ran in the click's own turn.
    expect(calls).toEqual(["resume", "play"]);
    expect(await screen.findByRole("button", { name: "Pause audition" })).toBeTruthy();
  });
  it("builds the iOS route even with the slider at 1, and later moves change the gain (S-2)", async () => {
    const { gain, contexts } = iosMock();
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const onStart = vi.fn();
    const view = render(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    await screen.findByText(/^Ready: the exact export file/u);
    fireEvent.click(screen.getByRole("button", { name: "Play audition" }));
    await screen.findByRole("button", { name: "Pause audition" });
    expect(contexts).toHaveLength(1);
    expect(gain.gain.value).toBe(1);
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={0.4} livePlaying={false} onStart={onStart} />);
    expect(gain.gain.value).toBeCloseTo(0.4, 6);
  });
  it("auto-play with an existing but suspended route stays Ready and never resumes outside a click (M4)", async () => {
    const { calls, contexts } = iosMock();
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    await screen.findByText(/^Ready: the exact export file/u);
    fireEvent.click(screen.getByRole("button", { name: "Play audition" }));
    await screen.findByRole("button", { name: "Pause audition" });
    const context = contexts[0]; if (!context) throw new Error("Missing route");
    context.state = "suspended";
    calls.length = 0;
    const edited = { ...base(), advanced: { ...base().advanced, input: 3 } };
    view.rerender(<AuditionExport track={edited} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Re-render audition" }));
    expect(await screen.findByText(/^Ready: the exact export file/u)).toBeTruthy();
    expect(calls).toEqual([]);
  });
  it("the live-during-render latch resets: the next render after a latched one auto-plays (M8)", async () => {
    let complete = heldRender();
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying onStart={view.onStart} />);
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    await complete();
    expect(playSpy).not.toHaveBeenCalled();
    complete = heldRender();
    const edited = { ...base(), advanced: { ...base().advanced, input: 3 } };
    view.rerender(<AuditionExport track={edited} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Re-render audition" }));
    await complete();
    expect(playSpy).toHaveBeenCalledOnce();
  });
  it.each(["NotAllowedError", "AbortError"])("keeps a held audition Ready when play() rejects with %s, and the next click plays (S-3)", async (name) => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    playSpy.mockImplementationOnce(() => Promise.reject(new DOMException("refused", name)));
    let handle: AuditionHandle | null = null;
    mount(base(), false, vi.fn(), (next) => { handle = next; });
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    expect(await screen.findByText(/^Ready: the exact export file .*Press Play audition to try again\.$/u)).toBeTruthy();
    // Counted as playing from play() on, and cleared again by the rejection (QA E9).
    expect((handle as AuditionHandle | null)?.playing()).toBe(false);
    expect(screen.getByRole("button", { name: "Play audition" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play audition" }));
    expect(await screen.findByRole("button", { name: "Pause audition" })).toBeTruthy();
    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it("a start interrupted by our own pause (A/B, Space) is not reported as a failure (Round 8f P2-1)", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    let handle: AuditionHandle | null = null;
    mount(base(), false, vi.fn(), (next) => { handle = next; });
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause audition" }));
    let rejectPlay: ((reason: unknown) => void) | undefined;
    playSpy.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "Play audition" }));
    expect((handle as AuditionHandle | null)?.playing()).toBe(true);
    (handle as AuditionHandle | null)?.pause();
    await act(async () => { rejectPlay?.(new DOMException("interrupted by pause()", "AbortError")); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByText(/did not start/u)).toBeNull();
    expect((handle as AuditionHandle | null)?.playing()).toBe(false);
    expect(screen.getByRole("button", { name: "Play audition" })).toBeTruthy();
  });

  /** A held, paused audition whose next play() stays pending until `reject` (optionally firing "play" at once). */
  async function pendingStart(view: ReturnType<typeof mount>, firePlay = false) {
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause audition" }));
    let rejectPlay: ((reason: unknown) => void) | undefined;
    playSpy.mockImplementationOnce(function (this: HTMLMediaElement) {
      if (firePlay) this.dispatchEvent(new Event("play"));
      return new Promise<void>((_resolve, reject) => { rejectPlay = reject; });
    });
    fireEvent.click(screen.getByRole("button", { name: "Play audition" }));
    return {
      view,
      reject: () => act(async () => { rejectPlay?.(new DOMException("interrupted by pause()", "AbortError")); await Promise.resolve(); await Promise.resolve(); }),
    };
  }
  it("a start interrupted by the Pause audition button is not reported as a failure (Round 8g)", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const start = await pendingStart(mount(), true);
    fireEvent.click(screen.getByRole("button", { name: "Pause audition" }));
    await start.reject();
    expect(screen.queryByText(/did not start/u)).toBeNull();
    expect(screen.getByRole("button", { name: "Play audition" })).toBeTruthy();
  });
  it("a start interrupted by an edit (then undone) is not reported as a failure (Round 8g)", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const { view, reject } = await pendingStart(mount());
    const edited = { ...base(), advanced: { ...base().advanced, input: 3 } };
    view.rerender(<AuditionExport track={edited} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    await reject();
    expect(screen.getByText(/^Ready: the exact export file/u)).toBeTruthy();
    expect(screen.queryByText(/did not start/u)).toBeNull();
  });
  it("a start interrupted by live playing is not reported as a failure (Round 8g)", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const { view, reject } = await pendingStart(mount());
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying onStart={view.onStart} />);
    await reject();
    expect(screen.getByText(/^Ready: the exact export file/u)).toBeTruthy();
    expect(screen.queryByText(/did not start/u)).toBeNull();
  });

  it("live played and paused again during the render: the audition still waits, Ready (Q-S1)", async () => {
    const complete = heldRender();
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying onStart={view.onStart} />);
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    await complete();
    expect(screen.getByText(/^Ready: the exact export file/u)).toBeTruthy();
    expect(playSpy).not.toHaveBeenCalled();
    expect(view.onStart).not.toHaveBeenCalled();
  });
  it("keeps one focusable button through render, cancel, play and re-render (Q-S2)", async () => {
    const complete = heldRender();
    const view = mount();
    const button = screen.getByRole("button", { name: "Audition export" });
    button.focus();
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Cancel audition render" })).toBe(button);
    await complete();
    expect(screen.getByRole("button", { name: "Pause audition" })).toBe(button);
    expect(document.activeElement).toBe(button);
    const edited = { ...base(), advanced: { ...base().advanced, input: 3 } };
    view.rerender(<AuditionExport track={edited} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying={false} onStart={view.onStart} />);
    expect(screen.getByRole("button", { name: "Re-render audition" })).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("pauses when live playback starts and revokes its Blob URL on unmount", async () => {
    vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: wav, truePeakDbtp: null });
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Audition export" }));
    await screen.findByRole("button", { name: "Pause audition" });
    view.rerender(<AuditionExport track={base()} sourceBlob={source} delivery={DEFAULT_DELIVERY} volume={1} livePlaying onStart={view.onStart} />);
    expect(screen.getByRole("button", { name: "Play audition" })).toBeTruthy();
    view.unmount();
    expect(urls.revoke).toHaveBeenCalledWith("blob:audition");
  });
});
