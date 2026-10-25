import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultAdvancedParams } from "@/lib/audio-dsp";
import { testStore } from "@/lib/__tests__/fixtures";
import { ExtendedCompressorControls, ExtendedStereoControls, FrequencyDynamicsControls } from "../AdvancedDynamics";

const dispatch = vi.fn();
vi.mock("@/lib/store", () => ({ useStore: () => ({ dispatch }) }));
afterEach(() => { cleanup(); dispatch.mockClear(); });
const track = testStore.tracks[0];
if (!track) throw new Error("Missing fixture");

describe("Advanced module controls", () => {
  it("resets newly exposed compressor and stereo sliders using the shared default behavior", () => {
    render(<><ExtendedCompressorControls track={track} /><ExtendedStereoControls track={track} /></>);
    fireEvent.doubleClick(screen.getByRole("slider", { name: "Sidechain HPF" }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_COMPRESSOR", trackId: track.id, patch: { sidechainHpfHz: 90 } });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Side channel gain" }), { key: "Backspace" });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_STEREO", trackId: track.id, patch: { sideGainDb: 0 } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto release" }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_COMPRESSOR", trackId: track.id, patch: { autoRelease: true } });
  });

  it("selects a compressor type and describes the selected one", () => {
    render(<ExtendedCompressorControls track={track} />);
    expect(screen.getByRole("button", { name: "Optical" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/sustained reduction releases slowly/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "FET" }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_COMPRESSOR", trackId: track.id, patch: { topology: "fet" } });
  });

  it("dispatches multiband edits to exactly the named band and caps frequency UI at the source rate", () => {
    const lowRate = { ...track, sampleRate: 8000 };
    render(<FrequencyDynamicsControls track={lowRate} />);
    fireEvent.change(screen.getByRole("slider", { name: "Mid band threshold" }), { target: { value: "-30" } });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_MULTIBAND_BAND", trackId: track.id, index: 1, patch: { thresholdDb: -30 } });
    fireEvent.doubleClick(screen.getByRole("slider", { name: "High band release" }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "UPDATE_MULTIBAND_BAND", trackId: track.id, index: 2, patch: { releaseMs: createDefaultAdvancedParams().multiband.bands[2].releaseMs } });
    expect(screen.getByRole("slider", { name: "De-Harsh frequency" }).getAttribute("max")).toBe("3760");
    expect(screen.getByRole("slider", { name: "Mid / High crossover" }).getAttribute("max")).toBe("3760");
  });
});
