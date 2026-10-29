import { useCallback, useEffect, useState } from "react";
import { isMonitorMode, type MonitorMode } from "./monitor-mode";
const KEY = "aurialis-monitor-mode-v1", EVENT = "aurialis-monitor-mode";
function read(): MonitorMode { try { const value = localStorage.getItem(KEY); return isMonitorMode(value) ? value : "stereo"; } catch { return "stereo"; } }
/** A listening preference shared by Master and Library; never persisted in a project. */
export function useMonitorMode() {
  const [mode, setMode] = useState<MonitorMode>("stereo");
  useEffect(() => {
    setMode(read());
    const change = (event: Event) => { const value: unknown = event instanceof CustomEvent ? event.detail : read(); if (isMonitorMode(value)) setMode(value); };
    window.addEventListener(EVENT, change); window.addEventListener("storage", change);
    return () => { window.removeEventListener(EVENT, change); window.removeEventListener("storage", change); };
  }, []);
  const select = useCallback((next: MonitorMode) => {
    if (!isMonitorMode(next)) return;
    setMode(next); try { localStorage.setItem(KEY, next); } catch { /* Listening still works without persistent storage. */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }, []);
  return { mode, select };
}
