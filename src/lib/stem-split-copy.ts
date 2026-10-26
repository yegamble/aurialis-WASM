/**
 * The one statement of Smart Split availability and speed, shared by Home,
 * Tools and the Split page so the three never disagree. Timings are the
 * measured figures recorded in docs/tasks.md (Smart Split with a trained model);
 * keep them in step with the status sentence in README.md.
 */
export const STEM_SPLIT_PITCH = "Split a song into 2 to 6 stems with a trained separation model.";

const BROWSER_AVAILABILITY = "Smart Split runs only in the native Aurialis build (built from source); it isn't available in the browser.";

const NATIVE_AVAILABILITY =
  "Smart Split runs on this computer, and it is slow: on an idle Apple-silicon Mac (8-core M2) each 20-second window takes about 32 seconds, about 15 minutes for a four-minute song, and much longer while the computer is busy. " +
  "Linux and Windows run plain Go, at least 18 times slower, and a song may not finish within the 90-minute job limit.";

export function stemSplitAvailability(browser: boolean): string {
  return browser ? BROWSER_AVAILABILITY : NATIVE_AVAILABILITY;
}
