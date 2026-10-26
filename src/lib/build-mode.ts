import { useSyncExternalStore } from "react";
import { usesBrowserAudio } from "./browser-jobs";

const subscribe = () => () => undefined;

/**
 * Static pages are rendered at build time without a location, so the server snapshot
 * follows the build flag alone; the client then settles on the real origin.
 */
function buildTimeBrowserBuild(): boolean {
  return process.env.NEXT_PUBLIC_AURIALIS_EXECUTION === "browser";
}

/** True in the browser build (all processing in WebAssembly), false on the native app's loopback studio. */
export function useBrowserBuild(): boolean {
  return useSyncExternalStore(subscribe, usesBrowserAudio, buildTimeBrowserBuild);
}

/** Where audio is processed, for the Home trust line. */
export function processingCopy(browser: boolean): string {
  return browser
    ? "Local by default. Audio is processed on this device with WebAssembly in your browser; nothing is uploaded."
    : "Local by default. Audio is processed on this computer by the Aurialis server you started and your browser.";
}
