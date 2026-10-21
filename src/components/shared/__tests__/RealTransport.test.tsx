import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LivePlaybackState } from "@/lib/live-playback";
import { RealTransport } from "../RealTransport";

const initial: LivePlaybackState = { position: 1.25, duration: 5, playing: false, ready: false, loading: false, original: false, volume: 0.8, underruns: 0, parameterVersion: 1, appliedVersion: 1, error: null, repeat: false };
function handlers() { return { onPlay: vi.fn().mockResolvedValue(undefined), onPause: vi.fn(), onOriginal: vi.fn(), onVolume: vi.fn(), onRestart: vi.fn(), onForward: vi.fn(), onRepeat: vi.fn(), onScrub: vi.fn() }; }
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


it("restarts the current track, forwards to the queued track, and toggles the actual repeat setting", () => {
  const callbacks = handlers();
  const { rerender } = render(<RealTransport {...callbacks} state={initial} sourceReady nextTrackTitle="Second song" />);
  expect(screen.getByRole("status").textContent).toBe("Next: Second song");
  fireEvent.click(screen.getByRole("button", { name: "Restart track" }));
  expect(callbacks.onRestart).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Next track: Second song" }));
  expect(callbacks.onForward).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Repeat track" }));
  expect(callbacks.onRepeat).toHaveBeenLastCalledWith(true);
  rerender(<RealTransport {...callbacks} state={{ ...initial, repeat: true }} sourceReady />);
  expect(screen.getByRole("button", { name: "Repeat track" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Repeat track" }));
  expect(callbacks.onRepeat).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("button", { name: "Skip forward 10 seconds" })).toBeDefined();
});

it("keeps a fixed status slot and disables every action during queue handover", () => {
  const callbacks = handlers();
  const { rerender } = render(<RealTransport {...callbacks} state={initial} sourceReady />);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("");
  rerender(<RealTransport {...callbacks} state={{ ...initial, playing: true, parameterVersion: 2 }} sourceReady />);
  expect(screen.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Updating audio…");
  rerender(<RealTransport {...callbacks} state={initial} sourceReady handover />);
  expect(screen.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Loading next track…");
  for (const button of screen.getAllByRole<HTMLButtonElement>("button")) expect(button.disabled).toBe(true);
  expect(screen.getByRole<HTMLInputElement>("slider", { name: "Playback volume" }).disabled).toBe(true);
});

it("resets playback volume to its canonical default with double-click or Backspace", () => {
  const callbacks = handlers();
  render(<RealTransport {...callbacks} state={initial} sourceReady />);
  const volume = screen.getByRole("slider", { name: "Playback volume" });
  fireEvent.doubleClick(volume);
  expect(callbacks.onVolume).toHaveBeenLastCalledWith(1);
  fireEvent.keyDown(volume, { key: "Backspace" });
  expect(callbacks.onVolume).toHaveBeenCalledTimes(2);
  expect(volume.getAttribute("aria-description")).toContain("100%");
});

it("treats a short keyboard press as one action and a held press as scrubbing without a next-track click", () => {
  vi.useFakeTimers();
  try {
    const callbacks = handlers();
    render(<RealTransport {...callbacks} state={initial} sourceReady nextTrackTitle="Second song" />);
    const forward = screen.getByRole("button", { name: "Next track: Second song" });
    fireEvent.keyDown(forward, { key: "Enter" });
    vi.advanceTimersByTime(200);
    fireEvent.keyUp(forward, { key: "Enter" });
    expect(callbacks.onForward).toHaveBeenCalledOnce();
    fireEvent.keyDown(forward, { key: " " });
    vi.advanceTimersByTime(300);
    expect(callbacks.onScrub).toHaveBeenLastCalledWith(1, "start");
    fireEvent.keyDown(forward, { key: " ", repeat: true });
    fireEvent.keyUp(forward, { key: " " });
    expect(callbacks.onScrub).toHaveBeenLastCalledWith(1, "end");
    fireEvent.click(forward);
    expect(callbacks.onForward).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("cancels holds on Escape, window blur, lost capture, disabled handover and unmount", () => {
  vi.useFakeTimers();
  try {
    const callbacks = handlers();
    const { rerender, unmount } = render(<RealTransport {...callbacks} state={initial} sourceReady />);
    const back = screen.getByRole("button", { name: "Restart track" });
    function hold() { fireEvent.keyDown(back, { key: " " }); vi.advanceTimersByTime(300); }
    hold(); fireEvent.keyDown(window, { key: "Escape" });
    expect(callbacks.onScrub).toHaveBeenLastCalledWith(-1, "cancel");
    hold(); fireEvent.blur(window);
    expect(callbacks.onScrub).toHaveBeenLastCalledWith(-1, "cancel");
    hold(); fireEvent.lostPointerCapture(back);
    expect(callbacks.onScrub).toHaveBeenLastCalledWith(-1, "cancel");
    hold(); rerender(<RealTransport {...callbacks} state={initial} sourceReady handover />);
    expect(callbacks.onScrub).toHaveBeenLastCalledWith(-1, "cancel");
    rerender(<RealTransport {...callbacks} state={initial} sourceReady />);
    hold(); unmount();
    expect(callbacks.onScrub).toHaveBeenLastCalledWith(-1, "cancel");
    expect(callbacks.onScrub).toHaveBeenCalledTimes(10);
    expect(callbacks.onRestart).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});


it("captures a primary pointer hold, suppresses its click, and cancels a touch interruption", () => {
  vi.useFakeTimers();
  try {
    const callbacks = handlers();
    render(<RealTransport {...callbacks} state={initial} sourceReady nextTrackTitle="Second song" />);
    const forward = screen.getByRole("button", { name: "Next track: Second song" });
    const capture = vi.fn();
    forward.setPointerCapture = capture;
    function down() {
      const event = createEvent.pointerDown(forward);
      Object.defineProperties(event, { button: { value: 0 }, isPrimary: { value: true }, pointerId: { value: 7 } });
      fireEvent(forward, event);
    }
    down(); vi.advanceTimersByTime(200); fireEvent.pointerUp(forward); fireEvent.click(forward);
    expect(callbacks.onForward).toHaveBeenCalledOnce();
    down(); vi.advanceTimersByTime(300); fireEvent.pointerUp(forward); fireEvent.click(forward);
    expect(callbacks.onScrub.mock.calls).toEqual([[1, "start"], [1, "end"]]);
    expect(callbacks.onForward).toHaveBeenCalledOnce();
    down(); vi.advanceTimersByTime(300); fireEvent.pointerCancel(forward); fireEvent.click(forward);
    expect(callbacks.onScrub).toHaveBeenLastCalledWith(1, "cancel");
    expect(callbacks.onForward).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(7);
  } finally { vi.useRealTimers(); }
});
