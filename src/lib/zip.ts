/* Minimal stored (uncompressed) ZIP writer. WAV audio barely deflates, so
 * storing keeps the archive a composed Blob of the original parts: entry data
 * is streamed once for its CRC and never copied into one large buffer. */

const MAX_ZIP_BYTES = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

let crcTable: Uint32Array | undefined;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** IEEE CRC-32 (ZIP), continuing from a previous value. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  const lookup = table();
  let c = ~previous >>> 0;
  for (const byte of bytes) c = (lookup[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return ~c >>> 0;
}

async function blobCrc32(blob: Blob, signal?: AbortSignal): Promise<number> {
  const reader = blob.stream().getReader();
  let crc = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return crc;
      crc = crc32(value, crc);
    }
  } finally { reader.releaseLock(); }
}

function dosTimestamp(date: Date): { time: number; day: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export type ZipEntry = { name: string; blob: Blob };

/** Build a stored ZIP of the entries. Names must be unique, relative and at most 255 UTF-8 bytes. */
export async function createStoredZip(entries: readonly ZipEntry[], signal?: AbortSignal, now = new Date()): Promise<Blob> {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) throw new Error("A ZIP needs between 1 and 65,535 files.");
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const { time, day } = dosTimestamp(now);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    if (name.length === 0 || name.length > 255 || seen.has(entry.name) || entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").includes("..")) throw new Error("ZIP file names must be unique, relative and short.");
    seen.add(entry.name);
    const crc = await blobCrc32(entry.blob, signal);
    const size = entry.blob.size;
    if (offset + 30 + name.length + size > MAX_ZIP_BYTES) throw new Error("The album ZIP would exceed 4 GiB. Download the masters individually.");
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x0403_4b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x0201_4b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, time, true);
    header.setUint16(14, day, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, size, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    parts.push(local.buffer, name, entry.blob);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + size;
  }
  const centralBytes = central.reduce((total, part) => total + part.length, 0);
  if (offset + centralBytes + 22 > MAX_ZIP_BYTES) throw new Error("The album ZIP would exceed 4 GiB. Download the masters individually.");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x0605_4b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralBytes, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

/** Numbered, filesystem-safe WAV names in running order, unique within one archive. */
export function albumEntryNames(titles: readonly string[]): string[] {
  const width = Math.max(2, String(titles.length).length);
  return titles.map((title, index) => {
    const safe = title.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/gu, "-").replace(/\s+/gu, " ").trim().slice(0, 120).replace(/^[.\s-]+|[.\s]+$/gu, "");
    return `${String(index + 1).padStart(width, "0")} ${safe || "Track"}.wav`;
  });
}
