import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoiceGroup } from "../Primitives";

afterEach(cleanup);

describe("ChoiceGroup", () => {
  it("names its group from the visible label and reports the pressed choice", () => {
    const change = vi.fn();
    render(<ChoiceGroup label="Dither" value={false} options={[{ value: true, label: "TPDF" }, { value: false, label: "Off" }]} onChange={change} />);
    const group = screen.getByRole("group", { name: "Dither" });
    expect(within(group).getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "TPDF" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(within(group).getByRole("button", { name: "TPDF" }));
    expect(change).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("presses nothing without a value and explains a disabled choice", () => {
    const change = vi.fn();
    render(<>
      <p id="why">Too long at this rate.</p>
      <ChoiceGroup label="Sample rate" value={undefined} options={[{ value: 44100, label: "44.1 kHz" }, { value: 96000, label: "96 kHz", disabled: true, describedBy: "why" }]} onChange={change} />
    </>);
    const group = screen.getByRole("group", { name: "Sample rate" });
    for (const button of within(group).getAllByRole("button")) expect(button.getAttribute("aria-pressed")).toBe("false");
    const unavailable = within(group).getByRole<HTMLButtonElement>("button", { name: "96 kHz" });
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.getAttribute("aria-describedby")).toBe("why");
    fireEvent.click(unavailable);
    expect(change).not.toHaveBeenCalled();
  });

  it("keeps two groups' labels distinct", () => {
    render(<>
      <ChoiceGroup label="Genre" value="Pop" options={[{ value: "Pop", label: "Pop" }]} onChange={vi.fn()} />
      <ChoiceGroup label="Tone intention" value={undefined} options={[{ value: "Warm", label: "Warm" }]} onChange={vi.fn()} />
    </>);
    expect(within(screen.getByRole("group", { name: "Genre" })).getByRole("button", { name: "Pop" })).toBeDefined();
    expect(within(screen.getByRole("group", { name: "Tone intention" })).getByRole("button", { name: "Warm" })).toBeDefined();
  });
});
