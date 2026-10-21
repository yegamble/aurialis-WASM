import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LivePlaybackState } from "@/lib/live-playback";
import { RealTransport } from "../RealTransport";

const initial: LivePlaybackState = { position: 1.25, duration: 5, playing: false, ready: false, loading: false, original: false, volume: 0.8, underruns: 0, parameterVersion: 1, appliedVersion: 1, error: null };
function handlers() { return { onPlay: vi.fn().mockResolvedValue(undefined), onPause: vi.fn(), onOriginal: vi.fn(), onVolume: vi.fn() }; }
afterEach(cleanup);

describe("live A/B transport", () => {
  it("defaults to A processed, offers B original immediately and has no hidden level matching", () => {
    const callbacks = handlers();
    render(<RealTransport {...callbacks} state={initial} sourceReady />);
    expect(screen.getByRole("button", { name: "A Processed" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "B Original" }).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Match level" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "B Original" }));
    expect(callbacks.onOriginal).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "A Processed" }));
    expect(callbacks.onOriginal).toHaveBeenLastCalledWith(false);
    expect(callbacks.onPlay).not.toHaveBeenCalled();
    expect(callbacks.onPause).not.toHaveBeenCalled();
    expect(callbacks.onVolume).not.toHaveBeenCalled();
  });

  it("keeps the controller clock and play state when comparison routing changes", () => {
    const callbacks = handlers();
    const { container, rerender } = render(<RealTransport {...callbacks} state={{ ...initial, ready: true, playing: true }} sourceReady />);
    rerender(<RealTransport {...callbacks} state={{ ...initial, ready: true, playing: true, original: true }} sourceReady />);
    expect(container.querySelector(".transport")?.getAttribute("data-position")).toBe("1.25");
    expect(container.querySelector(".transport")?.getAttribute("data-playing")).toBe("true");
    expect(screen.getByRole("button", { name: "B Original" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(callbacks.onPause).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("slider", { name: "Playback volume" }), { target: { value: "0.5" } });
    expect(callbacks.onVolume).toHaveBeenCalledWith(0.5);
  });

  it("does not offer dead comparison controls or claim a selected source before audio loads", () => {
    const callbacks = handlers();
    render(<RealTransport {...callbacks} state={null} sourceReady={false} />);
    for (const name of ["A Processed", "B Original", "Play"]) expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "A Processed" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "B Original" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("shows loading and unapplied parameter versions from the real controller state", () => {
    const callbacks = handlers();
    const { container, rerender } = render(<RealTransport {...callbacks} state={{ ...initial, loading: true }} sourceReady />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Starting playback" }).disabled).toBe(true);
    rerender(<RealTransport {...callbacks} state={{ ...initial, ready: true, playing: true, parameterVersion: 4, appliedVersion: 3 }} sourceReady />);
    expect(screen.getByRole("status").textContent).toBe("Updating audio…");
    expect(container.querySelector(".transport")?.getAttribute("data-parameter-version")).toBe("4");
    expect(container.querySelector(".transport")?.getAttribute("data-applied-version")).toBe("3");
  });
});
