import { usesBrowserAudio } from "./browser-jobs";
import { injectedProcessingIdentity } from "./processing-identity";

/** Public browser execution never probes health or a localhost service. */
export async function qualifyProcessingBuild(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const identity = injectedProcessingIdentity(), browser = usesBrowserAudio();
  if (!identity || identity.target !== (browser ? "browser" : "native")) throw new Error("Stored album masters need a matching release build. Export tracks individually or rebuild the app.");
  if (browser) return identity.fingerprint; // Every browser job checks the actual fetched DSP bytes and echoed identity.
  const response = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), headers: { Accept: "application/json" } });
  if (!response.ok || !response.body || !response.headers.get("Content-Type")?.startsWith("application/json")) { await response.body?.cancel(); throw new Error("The local app could not confirm its processing build. Restart the app and retry."); }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const result = await reader.read(); signal.throwIfAborted();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 16_384) throw new Error("The local processing build response exceeds its limit.");
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  const health: unknown = JSON.parse(text);
  if (typeof health !== "object" || health === null || !("processingBuildFingerprint" in health) || health.processingBuildFingerprint !== identity.fingerprint) throw new Error("The local app and interface use different processing builds. Rebuild and restart before continuing stored masters.");
  signal.throwIfAborted(); return identity.fingerprint;
}
