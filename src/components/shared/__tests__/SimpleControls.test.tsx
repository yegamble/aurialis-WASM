import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { SimpleControls } from "../SimpleControls";
import { StoreProvider, useStore } from "@/lib/store";
import { verifyElevatedChange } from "@/lib/simple-verification";
import { testStore } from "@/lib/__tests__/fixtures";
vi.mock("@/lib/simple-verification", () => ({ verifyElevatedChange: vi.fn() }));
let current: ReturnType<typeof useStore> | undefined;
const blob = new Blob(["source"]);
function Host() {
  current = useStore(); const track = current.state.tracks[0];
  return track ? <SimpleControls track={track} sourceBlob={blob} sourceReady processing={false} onApply={() => undefined} /> : null;
}
function source() { const track = current?.state.tracks[0]; if (!track) throw new Error("Missing source"); return track; }
async function open() { render(<StoreProvider><Host /></StoreProvider>); await screen.findByRole("button", { name: "Elevated" }); }
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, clear: () => { data.clear(); } });
  localStorage.setItem("aurialis-state-v1", JSON.stringify(testStore));
  vi.mocked(verifyElevatedChange).mockResolvedValue({ lufs: -20, peak: -6 });
});
afterEach(() => { cleanup(); current = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe("Simple style controls", () => {
  it("uses one canonical chain for new genres, styles and independently combinable modifiers", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Metal" }));
    fireEvent.click(screen.getByRole("button", { name: "Organic" }));
    fireEvent.click(screen.getByRole("button", { name: "Depth off" }));
    fireEvent.click(screen.getByRole("button", { name: "Presence off" }));
    expect(source().simpleDirection).toMatchObject({ genre: "Metal", style: "organic", depth: true, presence: true });
    const settings = source().advanced;
    fireEvent.click(screen.getByRole("button", { name: "Organic" }));
    expect(source().advanced).toEqual(settings);
    expect(verifyElevatedChange).not.toHaveBeenCalled();
  });
  it("keeps settings audible during a check, discards cancellation and accepts only the current checked candidate", async () => {
    let finish: ((result: { lufs: number; peak: number }) => void) | undefined;
    vi.mocked(verifyElevatedChange).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await open(); const original = source().advanced;
    fireEvent.click(screen.getByRole("button", { name: "Elevated" }));
    await screen.findByRole("button", { name: "Cancel Elevated check" });
    expect(source().advanced).toBe(original);
    const signal = vi.mocked(verifyElevatedChange).mock.calls[0]?.[3];
    fireEvent.click(screen.getByRole("button", { name: "Cancel Elevated check" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish?.({ lufs: -20, peak: -6 }); await Promise.resolve(); });
    expect(source().advanced).toBe(original);
    fireEvent.click(screen.getByRole("button", { name: "Elevated" }));
    await act(async () => { finish?.({ lufs: -20, peak: -6 }); await Promise.resolve(); });
    await screen.findByText(/Rendered check: −?[-]?20.0/u);
    expect(source().simpleDirection?.style).toBe("elevated");
    expect(source().advanced.input).toBe(original.input);
  });
  it("preserves a manual edit or newer direction across a late measured result and retains rejected settings", async () => {
    let finish: ((result: { lufs: number; peak: number }) => void) | undefined;
    vi.mocked(verifyElevatedChange).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await open(); fireEvent.click(screen.getByRole("button", { name: "Elevated" }));
    act(() => { current?.dispatch({ type: "UPDATE_INPUT_GAIN", trackId: source().id, input: -3 }); });
    await act(async () => { finish?.({ lufs: -20, peak: -6 }); await Promise.resolve(); });
    expect(source().advanced.input).toBe(-3);
    expect(source().simpleDirection).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Elevated" }));
    fireEvent.click(screen.getByRole("button", { name: "Organic" }));
    const selected = source().advanced;
    await act(async () => { finish?.({ lufs: -20, peak: -6 }); await Promise.resolve(); });
    expect(source().advanced).toBe(selected);
    vi.mocked(verifyElevatedChange).mockRejectedValueOnce(new Error("Elevated exceeds the measured peak ceiling."));
    fireEvent.click(screen.getByRole("button", { name: "Elevated" }));
    await waitFor(() => { expect(screen.getByRole("alert")).toHaveTextContent("exceeds"); });
    expect(source().advanced).toBe(selected);
  });
});
