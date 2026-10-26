import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "@/lib/store";
import { stemSplitAvailability } from "@/lib/stem-split-copy";
import { AurialisWorkstation } from "../AurialisWorkstation";

vi.mock("@/lib/db", () => ({ getAudio: vi.fn(), saveAudio: vi.fn(), deleteAudio: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => null }));

const modelStatus = { available: true, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 176_487_688 };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(modelStatus), { headers: { "Content-Type": "application/json" } }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const paths = new Map([["home", "/"], ["tools", "/tools"], ["split", "/split/none"]] as const);

function textOf(route: "home" | "tools" | "split"): string {
  window.history.replaceState(null, "", paths.get(route) ?? "/");
  const { container, unmount } = render(<StoreProvider><AurialisWorkstation route={route} paramId="none" /></StoreProvider>);
  const text = container.textContent;
  unmount();
  return text;
}

describe.each([
  { mode: "browser", browser: true, setup: () => { vi.stubEnv("NEXT_PUBLIC_AURIALIS_EXECUTION", "browser"); } },
  { mode: "native loopback", browser: false, setup: () => undefined },
])("$mode build copy", ({ browser, setup }) => {
  beforeEach(setup);

  it("states the same Smart Split availability on Home, Tools and Split", () => {
    const availability = stemSplitAvailability(browser);
    for (const route of ["home", "tools", "split"] as const) {
      expect(textOf(route), route).toContain(availability);
    }
  });

  it("never promises a downloadable app or a mode it is not running in", () => {
    const text = (["home", "tools", "split"] as const).map(textOf).join("\n");
    expect(text).not.toMatch(/desktop\s+app/iu);
    expect(text).not.toMatch(/planned/iu);
    if (browser) {
      expect(text).not.toMatch(/local Go server|Aurialis server/iu);
      expect(text).toContain("processed on this device with WebAssembly");
      expect(text).toContain("isn't available in the browser");
    } else {
      expect(text).toContain("by the Aurialis server you started");
      expect(text).toContain("no idle full-song timing has been recorded");
      expect(text).toContain("90-minute job limit");
    }
  });
});

it("keeps the two availability statements distinct and honest about speed", () => {
  expect(stemSplitAvailability(true)).toBe("Smart Split runs only in the native Aurialis build (built from source); it isn't available in the browser.");
  expect(stemSplitAvailability(false)).toMatch(/took about 32 seconds.*did not finish one 20-second window in 30 minutes/su);
});
