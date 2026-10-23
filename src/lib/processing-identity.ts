export interface ProcessingIdentity {
  readonly version: 1; readonly target: "native" | "browser"; readonly fingerprint: string;
  readonly offlineSha256: string; readonly offlineBytes: number; readonly realtimeSha256: string; readonly runtimeSha256: string;
}
/** Missing development metadata never qualifies persisted processing continuation. */
export function readProcessingIdentity(encoded: unknown): Readonly<ProcessingIdentity> | null {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 7 || row.version !== 1 || row.target !== "native" && row.target !== "browser"
    || typeof row.offlineBytes !== "number" || !Number.isSafeInteger(row.offlineBytes) || row.offlineBytes < 8 || row.offlineBytes > 25 * 1024 * 1024
    || ![row.fingerprint, row.offlineSha256, row.realtimeSha256, row.runtimeSha256].every((entry) => typeof entry === "string" && /^[a-f0-9]{64}$/u.test(entry))) return null;
  return Object.freeze(row as unknown as ProcessingIdentity);
}
export function injectedProcessingIdentity(): Readonly<ProcessingIdentity> | null {
  return readProcessingIdentity(process.env.NEXT_PUBLIC_AURIALIS_PROCESSING_BUILD);
}

/** A producer identity is public consistency metadata, never an authentication secret. */
export class ProcessingBuildMismatchError extends Error {
  constructor(cause?: unknown) { super("The actual audio response could not confirm this processing build. Plan the complete album again.", { cause }); this.name = "ProcessingBuildMismatchError"; }
}
export function assertExpectedProcessingBuild(expected: string | undefined): void {
  if (expected !== undefined && !/^[a-f0-9]{64}$/u.test(expected)) throw new ProcessingBuildMismatchError();
}
/** Reject before parsing; keep caller ownership until actual response-body cancellation settles. */
export async function assertNativeProcessingResponse(response: Response, expected: string | undefined): Promise<void> {
  assertExpectedProcessingBuild(expected);
  if (expected === undefined || response.headers.get("X-Aurialis-Processing-Build") === expected) return;
  let failure: unknown;
  try { await response.body?.cancel(); } catch (cause) { failure = cause; }
  throw new ProcessingBuildMismatchError(failure);
}
