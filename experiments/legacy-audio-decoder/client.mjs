/* Private harness client. There is no public route, import UI or raw WAV return. */
import { readBoundedResponse } from "./bounded-read.mjs";
const ABI = 1, MIB = 1024 * 1024, MAX_FRAMES = 16777216, DEADLINE = 130000;
let active = false;
const frozen = (value) => Object.freeze(value);
function integer(value, low, high) { return Number.isSafeInteger(value) && value >= low && value <= high; }
/** Conservative peak includes the later current Go import/render estimate and
 * raw-input owner, not only decoder linear memory. It is an admission probe;
 * lower the owner to actual retained data before entering Go's own admission.
 * No caller should bypass a later Go admission failure.
 */
export function recoveryPeakBytes(sourceBytes, frames, assetBytes) {
  if (!integer(sourceBytes, 12, 200 * MIB) || !integer(frames, 1, MAX_FRAMES) || !integer(assetBytes, 1, 32 * MIB))
    throw new Error("Invalid private recovery memory geometry.");
  const wav = 44 + frames * 8;
  const decoder = sourceBytes + 64 * MIB + assetBytes * 3 + wav * 2 + MIB;
  // Existing browser render preflight: 64 MiB + raw*4 + decoded*7;
  // plus queue raw owner, original source and retained decoded WAV.
  const cdr = sourceBytes + wav * 2 + 64 * MIB + wav * 4 + frames * 8 * 7;
  return Math.max(decoder, cdr);
}
function wavHeader(rate, frames) {
  const data = new ArrayBuffer(44), view = new DataView(data);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]])
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  view.setUint32(4, 36 + frames * 8, true); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, 2, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 8, true);
  view.setUint16(32, 8, true); view.setUint16(34, 32, true); view.setUint32(40, frames * 8, true);
  return data;
}
/** reserve(bytes) must be the actual shared resident owner helper whose failed
 * update leaves its previous reservation unchanged.
 * validate(file, signal) MUST invoke existing Go CDR and return its canonical
 * source/measurement. No raw decoded candidate escapes this function.
 * Returned dispose() holds the clean artifact until save/rollback settlement.
 */
export async function recoverCompressedFixture(file, { signal, reserve, validate, maxFrames = MAX_FRAMES }) {
  signal.throwIfAborted();
  if (active) throw new Error("A private recovery is already active.");
  if (!(file instanceof File) || !integer(maxFrames, 1, MAX_FRAMES) || typeof reserve !== "function" || typeof validate !== "function")
    throw new Error("Invalid private recovery invocation.");
  active = true;
  let owner, worker, timer, retained = false, output = null, total = 0, sequence = 0, geometry;
  const controller = new AbortController(), id = crypto.randomUUID();
  const abort = () => { controller.abort(signal.reason); worker?.terminate(); };
  const deadline = () => { controller.abort(new Error("Private recovery exceeded its overall time limit.")); worker?.terminate(); };
  try {
    owner = reserve(file.size + MIB);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(deadline, DEADLINE);
    const localSignal = controller.signal;
    if (signal.aborted) abort();
    localSignal.throwIfAborted();
    const response = await fetch(new URL("./assets.json", import.meta.url), { cache: "no-store", signal: localSignal });
    const manifestBytes = await readBoundedResponse(response, {
      maxBytes: 16384, maxReads: 1024, check: () => { localSignal.throwIfAborted(); },
    });
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    if (manifest.abi !== ABI || manifest.status !== "private-unqualified" || manifest.distributionApproved !== false ||
        !integer(manifest.assetBytes, 1, 32 * MIB) || typeof manifest.worker !== "string" ||
        !/^decoder\.worker\.[a-f0-9]{64}\.mjs$/.test(manifest.worker)) throw new Error("Invalid private decoder manifest.");
    // Admission uses the fixed maximum asset allowance, never a size claimed
    // by fetched metadata. One quota is chosen before decoding; never trim.
    // The shared resident owner rejects before mutation. A failed probe leaves
    // the last successful reservation intact; the peak is monotonic in frames.
    let low = 1, high = maxFrames, admitted = 0, refusal;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      try {
        owner.update(recoveryPeakBytes(file.size, middle, 32 * MIB));
        admitted = middle; low = middle + 1;
      } catch (cause) { refusal = cause; high = middle - 1; }
    }
    if (!admitted) throw refusal;
    maxFrames = admitted;
    localSignal.throwIfAborted();
    output = new Uint8Array(maxFrames * 8);
    const candidate = await new Promise((resolve, reject) => {
      let ended = false;
      const fail = (cause) => {
        if (ended) return;
        ended = true; worker?.terminate(); output = null;
        localSignal.removeEventListener("abort", canceled);
        reject(cause);
      };
      const canceled = () => { fail(localSignal.reason instanceof Error ? localSignal.reason : new DOMException("Private recovery canceled.", "AbortError")); };
      localSignal.addEventListener("abort", canceled, { once: true });
      worker = new Worker(new URL(manifest.worker, import.meta.url), { type: "module" });
      worker.onerror = worker.onmessageerror = () => { fail(new Error("Private decoder worker stopped.")); };
      worker.onmessage = ({ data }) => {
        if (ended) return;
        try {
          localSignal.throwIfAborted();
          if (!data || data.id !== id || data.abi !== ABI) throw new Error("Invalid private decoder identity.");
          if (data.kind === "error") throw new Error("This original is outside this private recovery profile. Its old copy is retained.");
          if (data.kind === "end") {
            if (!total || !geometry || data.frames !== total || data.sequence !== sequence ||
                data.rate !== geometry.rate || data.channels !== geometry.channels) throw new Error("Incomplete private PCM result.");
            worker.terminate();
            const result = new Blob([wavHeader(geometry.rate, total), output.subarray(0, total * 8)], { type: "audio/wav" });
            output = null;
            ended = true; localSignal.removeEventListener("abort", canceled);
            resolve(result); return;
          }
          if (data.kind !== "chunk" || data.sequence !== sequence + 1 || !integer(data.frames, 1, 4096) ||
              !integer(data.rate, 8000, 192000) || ![1, 2].includes(data.channels) ||
              !(data.audio instanceof ArrayBuffer) || data.audio.byteLength !== data.frames * 8 ||
              data.frames > maxFrames - total || (geometry && (data.rate !== geometry.rate || data.channels !== geometry.channels)))
            throw new Error("Invalid bounded private PCM chunk.");
          const view = new DataView(data.audio);
          for (let offset = 0; offset < view.byteLength; offset += 4) if (!Number.isFinite(view.getFloat32(offset, true))) throw new Error("Nonfinite decoded PCM.");
          output.set(new Uint8Array(data.audio), total * 8);
          geometry = { rate: data.rate, channels: data.channels }; sequence++; total += data.frames;
          worker.postMessage({ kind: "ack", abi: ABI, id, sequence });
        } catch (cause) { fail(cause); }
      };
      worker.postMessage({ kind: "start", abi: ABI, id, file, maxFrames });
    });
    localSignal.throwIfAborted();
    // Decoder worker and chunk references are gone before Go CDR admission.
    owner.update(file.size + candidate.size);
    const clean = await validate(new File([candidate], "recovered-source.wav", { type: "audio/wav" }), localSignal);
    localSignal.throwIfAborted();
    if (!clean || !(clean.canonical instanceof Blob) || clean.measurement?.frames !== total ||
        clean.measurement?.sampleRate !== geometry.rate || clean.canonical.size !== 44 + total * 8 ||
        clean.measurement?.sourceIdentity?.frames !== total || clean.measurement?.sourceIdentity?.sampleRate !== geometry.rate ||
        typeof clean.measurement?.sourceIdentity?.pcmHash !== "string" || !/^[a-f0-9]{64}$/.test(clean.measurement.sourceIdentity.pcmHash))
      throw new Error("Go CDR returned a mismatched private recovery source.");
    owner.update(file.size + clean.canonical.size * 2);
    retained = true;
    return frozen({ ...clean, dispose: owner.dispose });
  } finally {
    worker?.terminate(); output = null;
    clearTimeout(timer); signal.removeEventListener("abort", abort);
    if (!retained) owner?.dispose();
    active = false;
  }
}
