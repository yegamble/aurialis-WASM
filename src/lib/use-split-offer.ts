"use client";
import { useEffect, useState } from "react";
import { stemModelStatus } from "./stem-split";
import { stemModelNote, stemSplitAvailability } from "./stem-split-copy";

/**
 * Why Smart Split can't be offered from this page, or null when a link to it
 * is fine. The browser build never splits. A native server that answers with
 * available: false (a plain-Go build, or one started without the model) gets
 * the same note the Split page shows. Until the server answers, or when it
 * can't be reached, the link stays and the Split page explains.
 */
export function useSplitUnavailable(browser: boolean): string | null {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (browser) return undefined;
    const controller = new AbortController();
    void stemModelStatus(controller.signal)
      .then((status) => { setNote(status.reachable && !status.available ? stemModelNote(status, null) : null); })
      .catch(() => undefined);
    return () => { controller.abort(); };
  }, [browser]);
  return browser ? stemSplitAvailability(true) : note;
}
