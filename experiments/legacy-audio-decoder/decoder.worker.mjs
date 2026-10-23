/* Build replaces only the four fixed asset tokens below; never a user URL. */
import createDecoder from "./__AURIALIS_CORE_FILE__";
import { inspectEnvelope, selectedInput } from "./__AURIALIS_ENVELOPE_FILE__";
const ABI = 1, HEAP = 64 * 1024 * 1024, MAX_FRAMES = 16777216, CHUNK = 4096;
const WASM = "__AURIALIS_WASM_FILE__", SHA256 = "__AURIALIS_WASM_SHA256__";
let core, identity, awaiting = null, sequence = 0, emitted = 0, geometry, started = false, terminal = false;
function send(value, transfer = []) { postMessage({ ...value, abi: ABI, id: identity }, transfer); }
function stop() {
  terminal = true;
  try { core?._aurialis_decoder_close(); } catch { /* The parent also terminates every terminal worker. */ }
}
function fail() { if (!terminal) { send({ kind: "error", error: "Private compressed decoding rejected this source; its old copy is retained." }); stop(); } }
async function boundedWasm() {
  const response = await fetch(new URL(WASM, import.meta.url), { cache: "no-store", credentials: "same-origin" });
  if (!response.ok || !response.body) throw new Error("Decoder module unavailable.");
  const reader = response.body.getReader(); let size = 0; const pieces = [];
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error("Decoder asset exceeds its bound."); }
    pieces.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  if (hash !== SHA256) throw new Error("Decoder module integrity failed.");
  return bytes;
}
function pump() {
  if (terminal || awaiting !== null || !core) return;
  const frames = core._aurialis_decoder_next();
  if (frames < 0 || !Number.isInteger(frames) || frames > CHUNK) { fail(); return; }
  if (frames === 0) {
    if (!emitted || core._aurialis_decoder_frames() !== emitted) { fail(); return; }
    send({ kind: "end", frames: emitted, rate: geometry.rate, channels: geometry.channels, sequence });
    stop(); return;
  }
  const rate = core._aurialis_decoder_rate(), channels = core._aurialis_decoder_channels();
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || ![1, 2].includes(channels) ||
      (geometry && (rate !== geometry.rate || channels !== geometry.channels))) { fail(); return; }
  geometry = { rate, channels };
  const pointer = core._aurialis_decoder_output(), bytes = frames * 8;
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > HEAP - bytes || core.HEAPU8.buffer.byteLength !== HEAP) { fail(); return; }
  const audio = core.HEAPU8.slice(pointer, pointer + bytes).buffer;
  const view = new DataView(audio);
  for (let offset = 0; offset < bytes; offset += 4) if (!Number.isFinite(view.getFloat32(offset, true))) { fail(); return; }
  emitted += frames;
  awaiting = ++sequence;
  send({ kind: "chunk", sequence, frames, rate, channels, audio }, [audio]);
}
onmessage = async (event) => {
  const data = event.data;
  try {
    if (terminal || !data || typeof data !== "object" || data.abi !== ABI) { fail(); return; }
    if (data.kind === "ack") {
      if (!started || awaiting === null || data.id !== identity || data.sequence !== awaiting) { fail(); return; }
      awaiting = null; pump(); return;
    }
    if (started || data.kind !== "start" || typeof data.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(data.id) ||
        !Number.isInteger(data.maxFrames) || data.maxFrames < 1 || data.maxFrames > MAX_FRAMES) { fail(); return; }
    started = true; identity = data.id;
    const input = selectedInput(data.file), format = inspectEnvelope(input), wasmBinary = await boundedWasm();
    const wasmMemory = new WebAssembly.Memory({ initial: HEAP / 65536, maximum: HEAP / 65536 });
    core = await createDecoder({ wasmBinary, wasmMemory, print: () => {}, printErr: () => {},
      readInput: (offset, destination, bytes, heap) => {
        if (heap.buffer.byteLength !== HEAP || destination > HEAP - bytes) return -1;
        const chunk = input.read(offset, bytes); heap.set(chunk, destination); return chunk.byteLength;
      },
    });
    if (core.HEAPU8.buffer.byteLength !== HEAP || core._aurialis_decoder_abi() !== ABI ||
        core._aurialis_decoder_open(format, input.size, data.maxFrames) !== 0) { fail(); return; }
    pump();
  } catch { fail(); }
};
