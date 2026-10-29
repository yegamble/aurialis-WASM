import { MAX_SOURCE_FRAMES } from "./audio-limits";

type AudioShape = { bytes: number; rate: number | undefined };
const UNKNOWN: AudioShape = { bytes: MAX_SOURCE_FRAMES * 8, rate: undefined };
const HEADER_BYTES = 65_536;
const MP3_RATES = [44100, 48000, 32000];
const MP3_BITRATES_1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function text(data: DataView, offset: number, length: number): string {
  return String.fromCharCode(...Array.from({ length }, (_, i) => data.getUint8(offset + i)));
}

/** A sparse, bounded reader: metadata and frame payloads are skipped, never decoded. */
function headerReader(blob: Blob, signal: AbortSignal, prefix: ArrayBuffer) {
  let start = 0, data = prefix;
  return async (offset: number, length: number): Promise<DataView | undefined> => {
    signal.throwIfAborted();
    if (offset < 0 || offset + length > blob.size) return undefined;
    if (offset < start || offset + length > start + data.byteLength) {
      data = await blob.slice(offset, offset + HEADER_BYTES).arrayBuffer();
      start = offset;
      signal.throwIfAborted();
    }
    if (offset + length > start + data.byteLength) return undefined;
    return new DataView(data, offset - start, length);
  };
}
type HeaderReader = ReturnType<typeof headerReader>;

function wavShape(data: DataView): AudioShape {
  let align = 0, rate: number | undefined;
  for (let offset = 12; offset + 8 <= data.byteLength;) {
    const size = data.getUint32(offset + 4, true);
    if (text(data, offset, 4) === "data") {
      const frames = align > 0 ? Math.floor(size / align) : MAX_SOURCE_FRAMES;
      return frames >= 1 && frames <= MAX_SOURCE_FRAMES ? { bytes: frames * 8, rate } : UNKNOWN;
    }
    if (offset + 8 + size > data.byteLength) break;
    if (text(data, offset, 4) === "fmt " && size >= 16) {
      const declared = data.getUint32(offset + 12, true);
      rate = declared >= 8000 && declared <= 192000 ? declared : undefined;
      align = data.getUint16(offset + 20, true);
    }
    offset += 8 + size + size % 2;
  }
  return UNKNOWN;
}

/** Go strips these same 7-bit tag sizes (including optional footers) before format detection. */
async function streamOffset(read: HeaderReader): Promise<number | undefined> {
  let offset = 0;
  for (let tags = 0; tags < 64; tags++) {
    const data = await read(offset, 10);
    if (!data || text(data, 0, 3) !== "ID3") return offset;
    let size = 0;
    for (let i = 6; i < 10; i++) {
      const octet = data.getUint8(i);
      if (octet & 0x80) return undefined;
      size = size * 128 + octet;
    }
    offset += 10 + size + (data.getUint8(5) & 0x10 ? 10 : 0);
  }
  return undefined;
}

async function flacShape(read: HeaderReader, offset: number): Promise<AudioShape> {
  const data = await read(offset, 42);
  if (!data || (data.getUint8(4) & 0x7f) !== 0 || data.getUint32(4, false) % 0x1000000 !== 34) return UNKNOWN;
  const frames = (data.getUint8(21) & 15) * 0x100000000 + data.getUint32(22, false);
  const rate = data.getUint32(18, false) >>> 12;
  // Go rejects frames beyond a positive STREAMINFO total before appending PCM.
  if (frames === 0 || frames > MAX_SOURCE_FRAMES || rate < 8000 || rate > 192000) return UNKNOWN;
  return { bytes: frames * 8, rate };
}

function mp3Header(data: DataView) {
  const first = data.getUint8(1), second = data.getUint8(2);
  const version = (first >> 3) & 3, bitrate = second >> 4, index = (second >> 2) & 3;
  if (data.getUint8(0) !== 0xff || (first & 0xe0) !== 0xe0 || (version !== 2 && version !== 3) || ((first >> 1) & 3) !== 1 || bitrate === 0 || bitrate === 15 || index === 3) return undefined;
  const mpeg1 = version === 3;
  const rate = (MP3_RATES.at(index) ?? 0) / (mpeg1 ? 1 : 2);
  const bitrateValue = (mpeg1 ? MP3_BITRATES_1 : MP3_BITRATES_2).at(bitrate) ?? 0;
  return { rate, version, samples: mpeg1 ? 1152 : 576, size: Math.floor((mpeg1 ? 144 : 72) * bitrateValue * 1000 / rate) + ((second >> 1) & 1) };
}

async function mp3Shape(blob: Blob, read: HeaderReader, start: number): Promise<AudioShape> {
  const data = await read(start, 4), first = data && mp3Header(data);
  if (!first) return UNKNOWN;
  let offset = start, frames = 0;
  while (offset < blob.size) {
    const header = await read(offset, 4), current = header && mp3Header(header);
    if (!current) {
      // Go accepts these trailers; everything else uses the conservative bound.
      const remaining = blob.size - offset;
      if (remaining <= 64 || (remaining === 128 && header && text(header, 0, 3) === "TAG")) break;
      return UNKNOWN;
    }
    if (current.version !== first.version || current.rate !== first.rate || offset + current.size > blob.size) return UNKNOWN;
    frames += current.samples;
    if (frames > MAX_SOURCE_FRAMES + 2 * first.samples) return UNKNOWN;
    offset += current.size;
  }
  // Include the first Xing/Info/VBRI frame and all gapless padding. Ignore their
  // declared counts: Go walks this exact fixed-version/rate chain before decode.
  return frames >= 2 * first.samples ? { bytes: frames * 8, rate: first.rate } : UNKNOWN;
}

/** Capacity only: Go CDR remains the authoritative container and audio validator. */
export async function audioInputShape(blob: Blob, signal: AbortSignal): Promise<AudioShape> {
  signal.throwIfAborted();
  if (blob.size === 0) return { bytes: 0, rate: undefined };
  const data = await blob.slice(0, HEADER_BYTES).arrayBuffer();
  signal.throwIfAborted();
  const prefix = new DataView(data), read = headerReader(blob, signal, data);
  if (prefix.byteLength >= 12 && text(prefix, 0, 4) === "RIFF" && text(prefix, 8, 4) === "WAVE") return wavShape(prefix);
  // Every supported AIFF/AIFC encoding stores at least one byte per frame.
  // Go checks COMM's count against actual SSND bytes before allocating PCM.
  if (prefix.byteLength >= 12 && text(prefix, 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(text(prefix, 8, 4))) return { bytes: Math.min(MAX_SOURCE_FRAMES * 8, blob.size * 8), rate: undefined };
  const offset = await streamOffset(read);
  if (offset === undefined) return UNKNOWN;
  const marker = await read(offset, 4);
  return marker && text(marker, 0, 4) === "fLaC" ? flacShape(read, offset) : mp3Shape(blob, read, offset);
}
