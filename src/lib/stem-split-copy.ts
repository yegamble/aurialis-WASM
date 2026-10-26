/**
 * The one statement of Smart Split availability and speed, shared by Home,
 * Tools and the Split page so the three never disagree. Only the 32 s idle
 * window, the busy-machine window and the plain-Go 30-minute result are
 * measurements (docs/tasks.md, "Smart Split with a trained model"); the
 * four-minute figure is an estimate from the window time. Keep this in step
 * with the "Smart Split status" sentence in README.md and the guides.
 */
export const STEM_SPLIT_PITCH = "Split a song into 2 to 6 stems with a trained separation model.";

const BROWSER_AVAILABILITY = "Smart Split runs only in the native Aurialis build (built from source); it isn't available in the browser.";

const NATIVE_AVAILABILITY =
  "Smart Split runs on this computer, and it is slow. On an idle Apple-silicon Mac (8-core M2) one 20-second window took about 32 seconds; at that rate a four-minute song would take roughly 15 minutes, but no idle full-song timing has been recorded, and a busy machine took up to about three minutes per window. " +
  "On Linux and Windows, plain Go did not finish one 20-second window in 30 minutes, so songs will generally not finish within the 90-minute job limit.";

export function stemSplitAvailability(browser: boolean): string {
  return browser ? BROWSER_AVAILABILITY : NATIVE_AVAILABILITY;
}
