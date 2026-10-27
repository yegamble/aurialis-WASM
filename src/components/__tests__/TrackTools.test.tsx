import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "@/lib/store";
import { stemSplitAvailability } from "@/lib/stem-split-copy";
import { testStore } from "@/lib/__tests__/fixtures";
import type { WorkstationRoute } from "@/lib/workspace-navigation";
import { AurialisWorkstation } from "../AurialisWorkstation";

vi.mock("@/lib/db", () => ({ getAudio: vi.fn(() => Promise.resolve(undefined)), saveAudio: vi.fn(), deleteAudio: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => null }));

const [base] = testStore.tracks;
if (!base) throw new Error("Missing fixture track");
// The store keeps the newest import first: A was imported, then B.
const trackA = { ...base, id: "track-a", title: "Alpha mix" };
const trackB = { ...base, id: "track-b", title: "Bravo mix" };

function seed(tracks: readonly (typeof base)[]) {
  const storage = new Map([["aurialis-state-v1", JSON.stringify({ ...testStore, tracks })]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
}

function mount(route: WorkstationRoute, path: string, paramId?: string) {
  window.history.replaceState(null, "", path);
  return render(<StoreProvider><AurialisWorkstation route={route} {...(paramId ? { paramId } : {})} /></StoreProvider>);
}

function hrefs(scope: HTMLElement) {
  return within(scope).queryAllByRole("link").map((link) => link.getAttribute("href"));
}

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network unavailable")));
  seed([trackB, trackA]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("per-track tools from Master", () => {
  it("opens Release check, Reference match and Smart split for the open track, not the newest import", async () => {
    mount("master", "/master/track-a", "track-a");
    const tools = await screen.findByRole("navigation", { name: "Tools for Alpha mix" });
    expect(hrefs(tools)).toEqual(["/release-check/track-a", "/reference/track-a", "/split/track-a"]);
    expect(within(tools).getByRole("link", { name: "Release check" })).toBeTruthy();
    expect(within(tools).getByRole("link", { name: "Reference match" })).toBeTruthy();
    expect(within(tools).getByRole("link", { name: "Smart split" })).toBeTruthy();
  });

  it("states Smart Split availability instead of linking to it in the browser build", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser");
    mount("master", "/master/track-a", "track-a");
    const tools = await screen.findByRole("navigation", { name: "Tools for Alpha mix" });
    expect(hrefs(tools)).toEqual(["/release-check/track-a", "/reference/track-a"]);
    expect(tools.textContent).toContain(stemSplitAvailability(true));
  });
});

describe("Tools track chooser", () => {
  it("defaults to the newest import and repoints every tool to the chosen track", async () => {
    mount("tools", "/tools");
    const chooser = await screen.findByRole<HTMLSelectElement>("combobox", { name: "Track" });
    expect(within(chooser).getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining("Bravo mix"), expect.stringContaining("Alpha mix")]);
    expect(hrefs(screen.getByRole("list", { name: "Tools for Bravo mix" }))).toEqual(["/split/track-b", "/reference/track-b", "/release-check/track-b"]);
    fireEvent.change(chooser, { target: { value: "track-a" } });
    expect(chooser.value).toBe("track-a");
    expect(hrefs(screen.getByRole("list", { name: "Tools for Alpha mix" }))).toEqual(["/split/track-a", "/reference/track-a", "/release-check/track-a"]);
  });

  it("keeps the Smart Split card as availability copy, not a link, in the browser build", async () => {
    vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser");
    mount("tools", "/tools");
    await screen.findByRole("combobox", { name: "Track" });
    const grid = screen.getByRole("list", { name: "Tools for Bravo mix" });
    expect(hrefs(grid)).toEqual(["/reference/track-b", "/release-check/track-b"]);
    expect(grid.textContent).toContain(stemSplitAvailability(true));
  });

  it("asks for an import instead of linking tools to a missing track", async () => {
    seed([]);
    mount("tools", "/tools");
    expect(await screen.findByRole("link", { name: "Import a track" })).toHaveProperty("pathname", "/");
    expect(screen.queryByRole("combobox", { name: "Track" })).toBeNull();
    expect(hrefs(screen.getByRole("list", { name: "Tools" }))).toEqual([]);
  });
});
