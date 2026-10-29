/** A stable published packet whose version the audio thread acknowledged in rendered output. */
export function acceptedControlPacket(header: Int32Array<SharedArrayBuffer> | undefined, buffer: SharedArrayBuffer | undefined): { version: number; values: number[] } | null {
  if (!header || !buffer) return null;
  const controls = new Int32Array(buffer, 0, 4), sequence = Atomics.load(controls, 0), version = Atomics.load(controls, 1);
  if (sequence % 2 || version < 1 || version !== Atomics.load(header, 4)) return null;
  const values = Array.from(new Float64Array(buffer, 16));
  return sequence === Atomics.load(controls, 0) && version === Atomics.load(header, 4) ? { version, values } : null;
}
export type KernelDiagnostics = { frames: number; kernelMs: number; wallMs: number; audioMs: number; clockStepMs: number | null };
export function readKernelDiagnostics(value: Record<string, unknown>): KernelDiagnostics | null {
  const { frames, kernelMs, wallMs, audioMs, clockStepMs } = value;
  if (![frames, kernelMs, wallMs, audioMs].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    || !(clockStepMs === null || typeof clockStepMs === "number" && Number.isFinite(clockStepMs) && clockStepMs >= 0)) return null;
  return { frames, kernelMs, wallMs, audioMs, clockStepMs } as KernelDiagnostics;
}
