import { STEM_MODEL_DISABLED, type StemModelStatus, type StemSpeed, type StemSplitFailure } from "./stem-split";

/**
 * The one statement of Smart Split availability and speed, shared by Home,
 * Tools and the Split page so the three never disagree. Only the 32 s idle
 * window, the busy-machine window, the hosted Intel window and the plain-Go 30-minute result are
 * measurements (docs/tasks.md, "Smart Split with a trained model"); the
 * 14-minute figure is 26 windows at the idle window time. Keep this in step
 * with the "Smart Split status" sentence in README.md and the guides.
 */
export const STEM_SPLIT_PITCH = "Split a song into 2 to 6 stems with a trained separation model.";

const BROWSER_AVAILABILITY = "Smart Split runs only in the native Aurialis build (built from source); it isn't available in the browser.";

const NATIVE_AVAILABILITY =
  "Smart Split runs on this computer, and it is slow. It needs the macOS build, which uses Apple Accelerate: on an idle Apple-silicon Mac (8-core M2) one 20-second window took about 32 seconds, so a four-minute song would take roughly 14 minutes, but no idle full-song timing has been recorded, and a busy machine took up to about three minutes per window. " +
  "A hosted Intel Mac took about 178 seconds for one window; this is slower, and a full song has not been timed there. On Linux and Windows Smart Split is turned off: plain Go did not finish one 20-second window in 30 minutes, so a song could not finish within the 90-minute job limit.";

export function stemSplitAvailability(browser: boolean): string {
  return browser ? BROWSER_AVAILABILITY : NATIVE_AVAILABILITY;
}

/** The note for a native server built without Apple Accelerate, where Split is off. */
export const STEM_MODEL_PLAIN_GO = "Smart Split is off in this build: it runs the model in plain Go, which did not finish one 20-second window in 30 minutes. Splitting needs the macOS build, which uses Apple Accelerate.";

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / 1_000_000))} MB`;
}

/** The model note under the stem layout, one sentence per server state. */
export function stemModelNote(status: StemModelStatus | null, lastFailure: StemSplitFailure | null): string {
  if (!status) return "Checking the separation model…";
  if (!status.reachable) return "Aurialis can't reach its local server to check the separation model. Checking again every few seconds; Split comes back when the server answers.";
  if (!status.available) return status.backend !== "" && !status.accelerated ? STEM_MODEL_PLAIN_GO : STEM_MODEL_DISABLED;
  const size = megabytes(status.totalBytes);
  if (status.state === "downloading") return `Downloading the separation model: ${megabytes(status.downloadedBytes)} of ${size}.`;
  if (status.state === "loading") return "Loading the separation model from this computer…";
  if (status.state === "loaded") return "The separation model is ready.";
  if (lastFailure === "model") return `The ${size} separation model could not be downloaded or verified. The next split retries the download.`;
  if (lastFailure === "model_cache") return `The ${size} separation model could not be saved to or loaded from its cache folder. The next split tries again.`;
  if (status.state === "cached") return "The separation model is saved on this computer and verified. The first split loads it; nothing to download.";
  if (status.state === "invalid") return `The saved separation model failed its check. The first split replaces it with a fresh ${size} download.`;
  return `The first split downloads the ${size} separation model once.`;
}

/** Model windows for a song, matching the server's chunk assembler (steminfer.Windows). */
export function stemWindows(speed: StemSpeed, seconds: number): number {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return 0;
  // Songs longer than one window are padded by half a window at each end.
  const total = seconds > speed.windowSeconds ? seconds + speed.windowSeconds : seconds;
  return Math.ceil(total / speed.hopSeconds - 1e-9);
}

const JOB_LIMIT_SECONDS = 90 * 60;

function minutes(seconds: number): string {
  const value = Math.max(1, Math.round(seconds / 60));
  return `${String(value)} minute${value === 1 ? "" : "s"}`;
}

function clock(seconds: number): string {
  const whole = Math.round(seconds);
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * A realistic split time for this song from the recorded per-window speed, or
 * null when the server reports no speed (plain Go) or the length is unknown.
 * These are recorded figures from an M2 Mac and one hosted Intel runner,
 * not a measurement of this computer or a full-song timing.
 */
export function stemSplitEstimate(speed: StemSpeed | null, seconds: number, arch: string): string | null {
  if (!speed) return null;
  const windows = stemWindows(speed, seconds);
  if (windows === 0) return null;
  const idle = windows * speed.idleSecondsPerWindow, busy = windows * speed.busySecondsPerWindow;
  const limit = busy > JOB_LIMIT_SECONDS ? " and pass the 90-minute job limit, stopping the split" : "";
  const count = `${String(windows)} model window${windows === 1 ? "" : "s"}`;
  if (arch === "amd64") {
    const measured = windows * 178;
    const cutoff = measured > JOB_LIMIT_SECONDS ? " This exceeds the 90-minute job limit, which stops the split." : "";
    return `Estimated split time for this ${clock(seconds)} song: about ${minutes(measured)} (${count} at about 178 s each, measured on one hosted Intel Mac). A full song has not been timed there; your computer and its load may differ.${cutoff}`;
  }
  if (arch !== "arm64") {
    return `Estimated split time for this ${clock(seconds)} song: this architecture has not been timed, so plan for the slow case. ` +
      `At the ${String(speed.busySecondsPerWindow)} s per window a busy 8-core M2 Mac measured, it would take about ${minutes(busy)} (${count})${limit}. ` +
      `The same Mac took about ${String(speed.idleSecondsPerWindow)} s per window when idle, about ${minutes(idle)}.`;
  }
  return `Estimated split time for this ${clock(seconds)} song: about ${minutes(idle)} (${count} at about ${String(speed.idleSecondsPerWindow)} s each, measured on an idle 8-core M2 Mac). ` +
    `A busy computer measured up to ${String(speed.busySecondsPerWindow)} s per window, which would make it about ${minutes(busy)}${limit}.`;
}
