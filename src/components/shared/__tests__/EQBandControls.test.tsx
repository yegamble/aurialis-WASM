import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { testStore } from "@/lib/__tests__/fixtures";
import { EQBandControls, LimiterReleaseControl } from "../EQBandControls";
import { SpectrumChart } from "../Primitives";

const dispatch = vi.fn();
vi.mock("@/lib/store", () => ({ useStore: () => ({ dispatch }) }));
afterEach(() => { cleanup(); dispatch.mockClear(); });
const track = testStore.tracks[0];
if (!track) throw new Error("Missing fixture");

describe("supported EQ controls", () => {
  it("edits only the selected band's type and enable state while retaining its values", () => {
    const band = { ...track.advanced.eqBands[2], gainDb: 6, freqHz: 1200, q: 2 };
    const { rerender } = render(<EQBandControls track={track} band={band} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Mid filter type" }), { target: { value: "highpass" } });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_EQ_BAND", trackId: track.id, bandId: "mid", patch: { type: "highpass" } });
    rerender(<EQBandControls track={track} band={{ ...band, type: "highpass" }} />);
    expect(screen.getByRole("slider", { name: "Mid gain" }).closest("fieldset")?.disabled).toBe(true);
    expect(screen.getByRole("slider", { name: "Mid gain" }).getAttribute("value")).toBe("6");
    expect(screen.getByRole("slider", { name: "Mid frequency" }).closest("fieldset")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Mid band" }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_EQ_BAND", trackId: track.id, bandId: "mid", patch: { enabled: false } });
    rerender(<EQBandControls track={track} band={{ ...band, type: "highshelf" }} />);
    expect(screen.getByRole("slider", { name: "Mid gain" }).closest("fieldset")?.disabled).toBe(false);
    expect(screen.getByRole("slider", { name: "Mid gain" }).getAttribute("value")).toBe("6");
  });

  it("uses source-rate frequency defaults and resets only limiter release", () => {
    render(<><EQBandControls track={{ ...track, sampleRate: 8000 }} band={track.advanced.eqBands[4]} /><LimiterReleaseControl track={track} /></>);
    const frequency = screen.getByRole("slider", { name: "Air frequency" });
    expect(frequency.getAttribute("max")).toBe("3760");
    fireEvent.doubleClick(frequency);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_EQ_BAND", trackId: track.id, bandId: "air", patch: { freqHz: 3760 } });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Limiter release" }), { key: "Backspace" });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_LIMITER", trackId: track.id, patch: { release: 85 } });
  });

  it("keeps high-pass node gain unavailable across keys, pointer movement and reset", () => {
    const bands = structuredClone(track.advanced.eqBands);
    bands[2] = { ...bands[2], type: "highpass", freqHz: 2000, gainDb: 6, q: 2 };
    const change = vi.fn();
    const { container } = render(<SpectrumChart eqBands={bands} activeBandId="mid" onBandChange={change} />);
    const handle = screen.getByRole("button", { name: /Mid EQ:/ });
    expect(handle.getAttribute("aria-label")).toContain("high-pass, Q 2, gain unavailable");
    expect(handle.style.top).toBe("50%");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(change).toHaveBeenLastCalledWith("mid", { freqHz: 2119 });
    const bounds = container.querySelector(".eq-plot-bounds");
    if (!bounds) throw new Error("Missing plot bounds");
    vi.spyOn(bounds, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 60 } as DOMRect);
    Object.defineProperty(handle, "hasPointerCapture", { value: () => true });
    const pointer = new Event("pointermove", { bubbles: true });
    Object.defineProperties(pointer, { clientX: { value: 50 }, clientY: { value: 1 }, pointerId: { value: 1 } });
    fireEvent(handle, pointer);
    expect(change).toHaveBeenLastCalledWith("mid", { freqHz: 632 });
    fireEvent.doubleClick(handle);
    expect(change).toHaveBeenLastCalledWith("mid", { freqHz: 1000 });
  });
});
