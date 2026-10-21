import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAdvancedParams } from "@/lib/audio-dsp";
import { SliderField, SpectrumChart, Waveform } from "../Primitives";

afterEach(cleanup);

describe("canonical value resets", () => {
  it("resets a slider to its actual default with pointer and keyboard without changing another field", () => {
    const threshold = vi.fn(), ratio = vi.fn();
    render(<>
      <SliderField label="Threshold" value={-24} defaultValue={0} min={-42} max={0} onChange={threshold} />
      <SliderField label="Ratio" value={4} defaultValue={1} min={1} max={10} onChange={ratio} />
    </>);
    const slider = screen.getByRole("slider", { name: "Threshold" });
    fireEvent.doubleClick(slider);
    expect(threshold).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: "Backspace" });
    expect(threshold).toHaveBeenCalledTimes(2);
    expect(ratio).not.toHaveBeenCalled();
  });

  it("displays precise Q defaults and bounds a frequency reset to the source bandwidth", () => {
    const change = vi.fn();
    render(<>
      <SliderField label="Q" value={0.707} defaultValue={0.707} min={0.1} max={5} step={0.001} onChange={vi.fn()} />
      <SliderField label="Air frequency" value={2000} defaultValue={12000} min={20} max={3760} onChange={change} />
    </>);
    expect(screen.getByText("0.707")).toBeDefined();
    fireEvent.doubleClick(screen.getByRole("slider", { name: "Air frequency" }));
    expect(change).toHaveBeenCalledExactlyOnceWith(3760);
  });

  it("resets only the frequency and gain changed by dragging an EQ node", () => {
    const change = vi.fn();
    const bands = createDefaultAdvancedParams().eqBands;
    bands[2] = { ...bands[2], freqHz: 2000, gainDb: 5, q: 2 };
    render(<SpectrumChart eqBands={bands} onBandChange={change} />);
    const node = screen.getByRole("button", { name: /Mid EQ:/ });
    fireEvent.doubleClick(node);
    expect(change).toHaveBeenLastCalledWith("mid", { freqHz: 1000, gainDb: 0 });
    fireEvent.keyDown(node, { key: "Backspace" });
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("uses precise time nudges and resets the waveform position", () => {
    const seek = vi.fn();
    render(<Waveform seed={0} duration={10} peaks={[0.2, 0.4]} playheadRatio={0.5} onSeekRatio={seek} />);
    const waveform = screen.getByRole("slider", { name: "Track playback position" });
    fireEvent.keyDown(waveform, { key: "ArrowRight", altKey: true });
    expect(seek).toHaveBeenLastCalledWith(0.51);
    fireEvent.keyDown(waveform, { key: "ArrowLeft" });
    expect(seek).toHaveBeenLastCalledWith(0.4);
    fireEvent.doubleClick(waveform);
    expect(seek).toHaveBeenLastCalledWith(0);
  });

  it("keeps the waveform elapsed label behind the next whole second", () => {
    render(<Waveform seed={0} duration={10} peaks={[0.2]} playheadRatio={0.099} />);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("0:00 of 0:10");
  });
});
