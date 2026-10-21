import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveSpectrum } from "@/lib/live-playback";
import { LiveSpectrumChart, Waveform } from "../Primitives";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function frame(level = -80): LiveSpectrum {
  return { dbBins: new Float32Array(2048).fill(level), sampleRate: 48000, fftSize: 4096 };
}

function points(container: HTMLElement): number[][] {
  return (container.querySelector("polyline")?.getAttribute("points") ?? "")
    .split(" ").filter(Boolean).map((point) => point.split(",").map(Number));
}

describe("measured output spectrum", () => {
  it("shows an honest empty state without drawing frequency data before playback", () => {
    const { container } = render(<LiveSpectrumChart frame={null} playing={false} />);
    expect(container.querySelector("polyline")).toBeNull();
    expect(screen.getByText("Waiting for playback")).toBeDefined();
    expect(screen.getByText("Play audio to see the live output spectrum.")).toBeDefined();
  });

  it("renders a real narrow FFT-bin peak on the logarithmic frequency axis", () => {
    const data = frame();
    data.dbBins[85] = -20;
    const { container } = render(<LiveSpectrumChart frame={data} playing />);
    const peak = points(container).reduce<number[]>((strongest, point) =>
      (point[1] ?? Infinity) < (strongest[1] ?? Infinity) ? point : strongest, []);
    expect(peak[0]).toBeGreaterThan(50);
    expect(peak[0]).toBeLessThan(65);
    expect(peak[1]).toBe(12);
    expect(screen.getByText(/-20.0 dB max bin/, { selector: "p" })).toBeDefined();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Actual audible output FFT");
  });

  it("represents actual silent bins as the noise floor without invalid SVG coordinates", () => {
    const { container } = render(<LiveSpectrumChart frame={frame(Number.NEGATIVE_INFINITY)} playing />);
    const plotted = points(container);
    expect(plotted.length).toBeGreaterThan(0);
    expect(plotted.every(([x, y]) => Number.isFinite(x) && y === 60)).toBe(true);
    expect(screen.getByText(/Below −100 dB/, { selector: "p" })).toBeDefined();
  });

  it("retains and labels a paused real frame instead of pretending it is live", () => {
    const data = frame(-40);
    const { container, rerender } = render(<LiveSpectrumChart frame={data} playing />);
    const playingPoints = points(container);
    rerender(<LiveSpectrumChart frame={data} playing={false} />);
    expect(points(container)).toEqual(playingPoints);
    expect(screen.getByText("Paused · last frame")).toBeDefined();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Paused · last frame");
  });

  it("rejects invalid analyser data instead of displaying a fabricated measurement", () => {
    const data = frame(Number.NaN);
    const { container } = render(<LiveSpectrumChart frame={data} playing />);
    expect(container.querySelector("polyline")).toBeNull();
    expect(screen.getByText("Waiting for analyser data")).toBeDefined();
  });

  it("interpolates measured frames on animation frames and stops when paused or removed", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++sequence, callback); return sequence;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    const tick = (time: number) => { act(() => {
      const queued = Array.from(callbacks.values()); callbacks.clear();
      for (const callback of queued) callback(time);
    }); };
    const { container, rerender, unmount } = render(<LiveSpectrumChart frame={frame(-80)} playing />);
    tick(1);
    rerender(<LiveSpectrumChart frame={frame(-20)} playing />);
    expect(points(container)[0]?.[1]).toBe(48);
    tick(17);
    const first = points(container)[0]?.[1] ?? 0;
    expect(first).toBeGreaterThan(12); expect(first).toBeLessThan(48);
    tick(33);
    expect(points(container)[0]?.[1]).toBeLessThan(first);
    expect(callbacks.size).toBe(1);
    rerender(<LiveSpectrumChart frame={frame(-20)} playing={false} />);
    expect(points(container)[0]?.[1]).toBe(12);
    expect(callbacks.size).toBe(0);
    rerender(<LiveSpectrumChart frame={frame(-40)} playing />);
    expect(callbacks.size).toBe(1);
    unmount();
    expect(callbacks.size).toBe(0);
  });

  it("honors reduced motion and changes the preference without stale animation callbacks", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    let changed: (() => void) | undefined;
    const preference = { matches: true, addEventListener: (_: string, listener: () => void) => { changed = listener; }, removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", () => preference);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++sequence, callback); return sequence; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    const { container, rerender, unmount } = render(<LiveSpectrumChart frame={frame(-80)} playing />);
    rerender(<LiveSpectrumChart frame={frame(-20)} playing />);
    expect(points(container)[0]?.[1]).toBe(12);
    expect(callbacks.size).toBe(0);
    act(() => { preference.matches = false; changed?.(); });
    expect(callbacks.size).toBe(1);
    rerender(<LiveSpectrumChart frame={frame(-40)} playing />);
    expect(points(container)[0]?.[1]).toBe(12);
    act(() => { preference.matches = true; changed?.(); });
    expect(points(container)[0]?.[1]).toBe(24);
    expect(callbacks.size).toBe(0);
    unmount();
    expect(preference.removeEventListener).toHaveBeenCalled();
  });
});

describe("audible waveform progress", () => {
  it("paints only the played source segment and follows seeks in either direction", () => {
    const { container, rerender } = render(<Waveform seed={0} duration={4} peaks={[0.2, 0.3, 0.5, 0.4]} playheadRatio={0} />);
    const colors = () => Array.from(container.querySelectorAll<HTMLElement>(".wave-bars > i"), (bar) => bar.style.backgroundColor);
    expect(colors()).toEqual(Array<string>(4).fill("var(--line-dark)"));
    rerender(<Waveform seed={0} duration={4} peaks={[0.2, 0.3, 0.5, 0.4]} playheadRatio={0.5} />);
    expect(colors()).toEqual(["var(--clay)", "var(--clay)", "var(--line-dark)", "var(--line-dark)"]);
    rerender(<Waveform seed={0} duration={4} peaks={[0.2, 0.3, 0.5, 0.4]} playheadRatio={0.25} />);
    expect(colors()).toEqual(["var(--clay)", "var(--line-dark)", "var(--line-dark)", "var(--line-dark)"]);
  });
});
