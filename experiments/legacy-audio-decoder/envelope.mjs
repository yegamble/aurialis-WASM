/* Private bounded envelope preflight. It does not replace decoder qualification. */
const MAX_INPUT = 200 * 1024 * 1024, MAX_READ = 65536, MAX_METADATA = 1024 * 1024;
const MAX_CALLS = 1048576, MAX_SEEKS = 65536;
const CRC = new Uint32Array(256);
for (let i = 0; i < CRC.length; i++) {
  let value = i << 24;
  for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0);
  CRC[i] = value >>> 0;
}
function text(bytes, offset = 0) { return String.fromCharCode(...bytes.subarray(offset, offset + 4)); }
export function selectedInput(file) {
  if (!(file instanceof File) || !Number.isSafeInteger(file.size) || file.size < 12 || file.size > MAX_INPUT)
    throw new Error("Unsupported selected original size.");
  const reader = new FileReaderSync();
  let calls = 0, bytesRead = 0, seeks = 0, previousEnd = 0;
  function read(offset, bytes) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0 ||
        bytes > MAX_READ || offset > file.size || bytes > file.size - offset)
      throw new Error("Invalid bounded source read.");
    if (offset !== previousEnd && ++seeks > MAX_SEEKS) throw new Error("Source seek quota exceeded.");
    if (++calls > MAX_CALLS || (bytesRead += bytes) > file.size * 8 + MAX_METADATA)
      throw new Error("Source read quota exceeded.");
    previousEnd = offset + bytes;
    const buffer = reader.readAsArrayBuffer(file.slice(offset, offset + bytes));
    if (buffer.byteLength !== bytes) throw new Error("The selected original changed or could not be read.");
    return new Uint8Array(buffer);
  }
  return Object.freeze({ read, size: file.size });
}
function ogg(input) {
  let offset = 0, serial, sequence = 0, pages = 0, ended = false;
  while (offset < input.size) {
    if (ended || ++pages > MAX_CALLS || input.size - offset < 27) throw new Error("Chained or incomplete Ogg is unsupported.");
    const header = input.read(offset, 27), view = new DataView(header.buffer);
    if (text(header) !== "OggS" || header[4] !== 0 || (header[5] & ~7)) throw new Error("Invalid Ogg page.");
    const flags = header[5], currentSerial = view.getUint32(14, true), currentSequence = view.getUint32(18, true);
    if (serial === undefined) {
      if (!(flags & 2) || (flags & 1)) throw new Error("Missing initial Ogg stream page.");
      serial = currentSerial;
    } else if ((flags & 2) || currentSerial !== serial) throw new Error("Chained or multiplexed Ogg is unsupported.");
    if (currentSequence !== sequence++) throw new Error("Discontinuous Ogg page sequence.");
    const segments = input.read(offset + 27, header[26]);
    let body = 0; for (const length of segments) body += length;
    const length = 27 + segments.length + body;
    if (length > input.size - offset) throw new Error("Truncated Ogg page.");
    const page = input.read(offset, length);
    let checksum = 0;
    for (let index = 0; index < page.length; index++) {
      const value = index >= 22 && index < 26 ? 0 : page[index];
      checksum = ((checksum << 8) ^ CRC[((checksum >>> 24) ^ value) & 255]) >>> 0;
    }
    if (checksum !== view.getUint32(22, true)) throw new Error("Invalid Ogg page checksum.");
    ended = !!(flags & 4); offset += length;
  }
  if (!ended) throw new Error("Ogg stream has no terminal page.");
}
function mp4(input) {
  let boxes = 0, tracks = 0, moov = 0, ftyp = 0;
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);
  function walk(start, end, depth) {
    if (depth > 8) throw new Error("MP4 nesting quota exceeded.");
    for (let offset = start; offset < end;) {
      if (++boxes > MAX_SEEKS || end - offset < 8) throw new Error("MP4 box quota or bounds exceeded.");
      let header = input.read(offset, 8), view = new DataView(header.buffer), size = view.getUint32(0, false);
      const name = text(header, 4); let prefix = 8;
      if (size === 1) {
        if (end - offset < 16) throw new Error("Truncated MP4 extended box.");
        header = input.read(offset, 16); view = new DataView(header.buffer);
        const large = view.getBigUint64(8, false);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe MP4 box size.");
        size = Number(large); prefix = 16;
      } else if (size === 0) size = end - offset;
      if (size < prefix || size > end - offset) throw new Error("Invalid MP4 box bounds.");
      if (["moof", "mvex", "cmov"].includes(name)) throw new Error("Fragmented or compressed MP4 headers are unsupported.");
      if (name === "ftyp" && depth === 0) ftyp++;
      if (name === "moov") { if (depth !== 0 || ++moov !== 1 || size > 8 * MAX_METADATA) throw new Error("Unsupported MP4 movie headers."); }
      if (name === "trak" && (depth !== 1 || ++tracks !== 1)) throw new Error("Multiple MP4 tracks are unsupported.");
      if (containers.has(name)) walk(offset + prefix, offset + size, depth + 1);
      offset += size;
    }
  }
  walk(0, input.size, 0);
  if (ftyp !== 1 || moov !== 1 || tracks !== 1) throw new Error("Missing unique MP4 audio structure.");
}
export function inspectEnvelope(input) {
  let offset = 0, header = input.read(0, 12);
  if (text(header, 0).slice(0, 3) === "ID3") {
    const sizeBytes = header.subarray(6, 10);
    if (header[3] < 2 || header[3] > 4 || sizeBytes.some((value) => value & 128)) throw new Error("Unsupported ID3 header.");
    offset = 10 + sizeBytes.reduce((total, value) => total * 128 + value, 0) + (header[3] === 4 && (header[5] & 16) ? 10 : 0);
    if (offset > MAX_METADATA || input.size - offset < 12) throw new Error("ID3 metadata quota exceeded.");
    header = input.read(offset, 12);
  }
  if (text(header) === "fLaC") return 2;
  if (offset === 0 && text(header) === "OggS") { ogg(input); return 3; }
  if (offset === 0 && text(header, 4) === "ftyp") { mp4(input); return 5; }
  if (header[0] === 255 && (header[1] & 246) === 240) return 4;
  if (header[0] === 255 && (header[1] & 224) === 224 && (header[1] & 6) === 2 && (header[1] & 24) !== 8) return 1;
  throw new Error("This compressed container is outside the private recovery profile.");
}
