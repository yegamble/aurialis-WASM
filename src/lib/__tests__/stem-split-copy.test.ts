import { describe, expect, it } from "vitest";
import { STEM_MODEL_PLAIN_GO, stemModelNote, stemSplitEstimate, stemWindows } from "../stem-split-copy";
import { canSplit, STEM_MODEL_DISABLED, type StemModelState, type StemModelStatus, type StemSpeed } from "../stem-split";

const speed: StemSpeed = { windowSeconds: 20, hopSeconds: 10, idleSecondsPerWindow: 32, busySecondsPerWindow: 173 };
const total = 176_487_688;
function status(state: StemModelState, extra: Partial<StemModelStatus> = {}): StemModelStatus {
  return {
    reachable: true, available: true, ready: state === "loaded", downloading: state === "downloading", downloadedBytes: 0, totalBytes: total,
    state, accelerated: true, backend: "apple-accelerate", arch: "arm64", speed, ...extra,
  };
}

describe("Smart Split model note", () => {
  it.each<[string, StemModelStatus | null, string]>([
    ["checking", null, "Checking the separation model…"],
    ["unreachable", { ...status("absent"), reachable: false, available: false }, "Aurialis can't reach its local server to check the separation model. Checking again every few seconds; Split comes back when the server answers."],
    ["disabled", { ...status("disabled"), available: false, accelerated: false, backend: "", speed: null }, STEM_MODEL_DISABLED],
    ["plain Go", { ...status("cached"), available: false, accelerated: false, backend: "portable-go", speed: null }, STEM_MODEL_PLAIN_GO],
    ["absent", status("absent"), "The first split downloads the 176 MB separation model once."],
    ["downloading", status("downloading", { downloadedBytes: 40_000_000 }), "Downloading the separation model: 40 MB of 176 MB."],
    ["loading", status("loading"), "Loading the separation model from this computer…"],
    ["cached", status("cached"), "The separation model is saved on this computer and verified. The first split loads it; nothing to download."],
    ["invalid", status("invalid"), "The saved separation model failed its check. The first split replaces it with a fresh 176 MB download."],
    ["loaded", status("loaded"), "The separation model is ready."],
  ])("%s", (_name, value, note) => {
    expect(stemModelNote(value, null)).toBe(note);
  });

  it("never tells a cached model it must download again", () => {
    expect(stemModelNote(status("cached"), null)).not.toMatch(/downloads? the/iu);
  });

  it("keeps the last failure's copy until the model loads", () => {
    expect(stemModelNote(status("absent"), "model")).toBe("The 176 MB separation model could not be downloaded or verified. The next split retries the download.");
    expect(stemModelNote(status("invalid"), "model_cache")).toBe("The 176 MB separation model could not be saved to or loaded from its cache folder. The next split tries again.");
    expect(stemModelNote(status("loaded"), "model")).toBe("The separation model is ready.");
  });
});

describe("Smart Split estimate", () => {
  it.each([[1, 1], [10, 1], [19.5, 2], [20, 2], [21, 5], [60, 8], [225, 25], [240, 26], [348, 37]])("a %s s song needs %s windows (the Go chunk assembler's count)", (seconds, windows) => {
    expect(stemWindows(speed, seconds)).toBe(windows);
  });

  it("estimates this song from the recorded idle and busy window times", () => {
    expect(stemSplitEstimate(speed, 225, "arm64")).toBe("Estimated split time for this 3:45 song: about 13 minutes (25 model windows at about 32 s each, measured on an idle 8-core M2 Mac). A busy computer measured up to 173 s per window, which would make it about 72 minutes.");
  });

  it("warns when a busy computer would pass the 90-minute job limit", () => {
    expect(stemSplitEstimate(speed, 348, "arm64")).toBe("Estimated split time for this 5:48 song: about 20 minutes (37 model windows at about 32 s each, measured on an idle 8-core M2 Mac). A busy computer measured up to 173 s per window, which would make it about 107 minutes and pass the 90-minute job limit, stopping the split.");
  });

  it("uses the measured hosted Intel window without claiming a full-song timing", () => {
    expect(stemSplitEstimate(speed, 225, "amd64")).toBe("Estimated split time for this 3:45 song: roughly 75–100 minutes (25 model windows at roughly 3–4 minutes each in hosted Intel Mac tests, including a profiled run). A full song has not been timed there; your computer and its load may differ. This can exceed the 90-minute job limit, which stops the split.");
    expect(stemSplitEstimate(speed, 348, "amd64")).toContain("roughly 111–148 minutes (37 model windows");
    expect(stemSplitEstimate(speed, 348, "amd64")).toContain("can exceed the 90-minute job limit");
    expect(stemSplitEstimate(speed, 225, "")).toContain("has not been timed");
  });

  it("keeps packed native measurements separate from Apple speed metadata", () => {
    expect(stemSplitEstimate(null, 225, "amd64", "packed-avx2-fma")).toContain("25 model windows");
    expect(stemSplitEstimate(null, 225, "amd64", "packed-avx2-fma")).toContain("127–175 s per window");
    expect(stemSplitEstimate(null, 225, "amd64", "packed-avx2-fma")).not.toContain("Intel");
  });

  it("offers no estimate without a recorded speed or a known length", () => {
    expect(stemSplitEstimate(null, 225, "arm64")).toBeNull();
    expect(stemSplitEstimate(speed, 0, "arm64")).toBeNull();
    expect(stemSplitEstimate(speed, Number.NaN, "arm64")).toBeNull();
  });
});

describe("Smart Split enable logic", () => {
  it.each<[string, boolean, StemModelStatus | null, string | null, boolean]>([
    ["ready native server with a track", false, status("loaded"), "a", true],
    ["cached model", false, status("cached"), "a", true],
    ["absent model (downloads on first split)", false, status("absent"), "a", true],
    ["no track", false, status("loaded"), null, false],
    ["browser build", true, status("loaded"), "a", false],
    ["status not checked yet", false, null, "a", false],
    ["plain-Go build", false, { ...status("cached"), available: false, accelerated: false, backend: "portable-go", speed: null }, "a", false],
    ["server unreachable", false, { ...status("loaded"), reachable: false, available: false }, "a", false],
  ])("%s", (_name, browser, value, audioId, enabled) => {
    expect(canSplit(browser, value, audioId)).toBe(enabled);
  });
});
