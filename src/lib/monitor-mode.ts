export type MonitorMode = "stereo" | "mono" | "side";
export function isMonitorMode(value: unknown): value is MonitorMode { return value === "stereo" || value === "mono" || value === "side"; }
export function monitorModeCode(mode: MonitorMode): number { return mode === "mono" ? 1 : mode === "side" ? 2 : 0; }
