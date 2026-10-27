import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CD_DELIVERY, DEFAULT_DELIVERY } from "@/lib/delivery-format";
import { albumRateChoices, exportRateChoices } from "@/lib/export-rates";
import { DeliveryFormatControls } from "../DeliveryFormatControls";

afterEach(cleanup);

describe("DeliveryFormatControls", () => {
  it("offers bit depth, sample rate and dither, and reports one changed field at a time", () => {
    const change = vi.fn();
    render(<DeliveryFormatControls value={DEFAULT_DELIVERY} rateChoices={exportRateChoices(48000, 48000)} onChange={change} />);
    const depth = screen.getByRole("group", { name: "Bit depth" });
    expect(within(depth).getByRole("button", { name: "24-bit PCM" }).getAttribute("aria-pressed")).toBe("true");
    const rates = screen.getByRole("group", { name: "Sample rate" });
    expect(within(rates).getAllByRole("button").map((button) => button.textContent)).toEqual(["44.1 kHz", "48 kHz (source)", "88.2 kHz", "96 kHz"]);
    fireEvent.click(within(rates).getByRole("button", { name: "44.1 kHz" }));
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_DELIVERY, sampleRate: 44100 });
    fireEvent.click(within(depth).getByRole("button", { name: "16-bit PCM" }));
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_DELIVERY, bitDepth: 16 });
    fireEvent.click(within(screen.getByRole("group", { name: "Dither" })).getByRole("button", { name: "Off" }));
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_DELIVERY, dither: false });
  });

  it("hides dither for 32-bit float and names an album's mixed source rates", () => {
    render(<DeliveryFormatControls value={{ ...CD_DELIVERY, bitDepth: 32 }} sourceLabel="Each source rate" rateChoices={albumRateChoices([{ sampleRate: 48000, frames: 1 }, { sampleRate: 44100, frames: 1 }])} onChange={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Dither" })).toBeNull();
    const rates = screen.getByRole("group", { name: "Sample rate" });
    expect(within(rates).getByRole("button", { name: "Each source rate" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(rates).getByRole("button", { name: "44.1 kHz" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("explains every unavailable rate in visible text tied to the disabled choice", () => {
    render(<DeliveryFormatControls value={DEFAULT_DELIVERY} rateChoices={exportRateChoices(44101, 44101)} rateNote="Rates unavailable." onChange={vi.fn()} />);
    const unavailable = within(screen.getByRole("group", { name: "Sample rate" })).getByRole<HTMLButtonElement>("button", { name: "96 kHz" });
    expect(unavailable.disabled).toBe(true);
    const note = document.getElementById(unavailable.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("Rates unavailable.");
  });
});
