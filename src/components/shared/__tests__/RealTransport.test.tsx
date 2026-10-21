import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StereoPCM } from "@/lib/browser-engine";
import { RealTransport } from "../RealTransport";

const source: StereoPCM = { sampleRate: 8000, left: new Float32Array(24000).fill(0.2), right: new Float32Array(24000).fill(0.1) };
const processed: StereoPCM = { sampleRate: 8000, left: new Float32Array(24000).fill(0.4), right: new Float32Array(24000).fill(0.2) };
const callbacks = { onAB: vi.fn(), onSeekRatio: vi.fn() };

beforeEach(() => {
  let next = 0;
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => `blob:test-${String(next++)}`), revokeObjectURL: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("A/B monitor regression checks", () => {
  it("retains matched monitor volume after each source metadata event", () => {
    const { container, rerender } = render(<RealTransport {...callbacks} pcm={processed} sourcePcm={source} processedPcm={processed} ab="B" processedReady playheadRatio={0} />);
    const audio = container.querySelector("audio");
    if (!audio) throw new Error("Missing audio element");
    fireEvent.loadedMetadata(audio);
    fireEvent.click(screen.getByRole("button", { name: "Match level" }));
    expect(audio.volume).toBeCloseTo(0.4, 5);
    rerender(<RealTransport {...callbacks} pcm={source} sourcePcm={source} processedPcm={processed} ab="A" processedReady playheadRatio={0} />);
    fireEvent.loadedMetadata(audio);
    expect(audio.volume).toBeCloseTo(0.8, 5);
    rerender(<RealTransport {...callbacks} pcm={processed} sourcePcm={source} processedPcm={processed} ab="B" processedReady playheadRatio={0} />);
    fireEvent.loadedMetadata(audio);
    expect(audio.volume).toBeCloseTo(0.4, 5);
    fireEvent.change(screen.getByRole("slider", { name: "Playback volume" }), { target: { value: "0.5" } });
    expect(audio.volume).toBeCloseTo(0.25, 5);
  });

  it("preserves playhead and resumes a playing comparison after an A/B swap", () => {
    const { container, rerender } = render(<RealTransport {...callbacks} pcm={source} sourcePcm={source} processedPcm={processed} ab="A" processedReady playheadRatio={0} />);
    const audio = container.querySelector("audio");
    if (!audio) throw new Error("Missing audio element");
    fireEvent.loadedMetadata(audio);
    audio.currentTime = 1.25;
    Object.defineProperty(audio, "paused", { configurable: true, value: false });
    const play = vi.spyOn(audio, "play").mockResolvedValue();
    rerender(<RealTransport {...callbacks} pcm={processed} sourcePcm={source} processedPcm={processed} ab="B" processedReady playheadRatio={0} />);
    audio.currentTime = 0;
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBeCloseTo(1.25, 4);
    expect(play).toHaveBeenCalledOnce();
  });
});
