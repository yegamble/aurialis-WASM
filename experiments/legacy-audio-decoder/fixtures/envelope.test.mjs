/* Structural preflight units only; no FFmpeg, audio decode, browser or Go CDR. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectEnvelope } from "../envelope.mjs";

const encode = (text) => new TextEncoder().encode(text);
function concat(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}
function input(bytes) {
  return { size: bytes.byteLength, read(offset, length) {
    assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(length));
    assert.ok(offset >= 0 && length >= 0 && length <= 65536 && offset + length <= bytes.byteLength);
    return bytes.slice(offset, offset + length);
  } };
}
function box(name, ...parts) {
  const body = concat(...parts), output = new Uint8Array(8 + body.byteLength), view = new DataView(output.buffer);
  view.setUint32(0, output.byteLength, false); output.set(encode(name), 4); output.set(body, 8);
  return output;
}
const ftyp = () => box("ftyp", encode("M4A "), new Uint8Array(4));
const track = () => box("trak", box("mdia", box("minf", box("stbl"))));
const mp4 = (...tracks) => concat(ftyp(), box("moov", ...tracks), box("mdat", new Uint8Array(16)));
function oggPage({ flags = 6, serial = 7, sequence = 0, body = new Uint8Array([1, 2, 3]) } = {}) {
  const output = new Uint8Array(28 + body.byteLength), view = new DataView(output.buffer);
  output.set(encode("OggS")); output[5] = flags; output[26] = 1; output[27] = body.byteLength;
  view.setUint32(14, serial, true); view.setUint32(18, sequence, true); output.set(body, 28);
  let crc = 0;
  for (const value of output) {
    crc ^= value << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
    crc >>>= 0;
  }
  view.setUint32(22, crc, true);
  return output;
}

test("recognizes normal big-endian MP4 box lengths without decoding its opaque payload", () => {
  assert.equal(inspectEnvelope(input(mp4(track()))), 5);
});
test("rejects swapped, truncated and oversized MP4 box geometry", () => {
  const swapped = mp4(track()), view = new DataView(swapped.buffer);
  view.setUint32(0, 16, true);
  assert.throws(() => inspectEnvelope(input(swapped)), /box bounds/);
  const truncated = concat(ftyp(), encode("bad"));
  assert.throws(() => inspectEnvelope(input(truncated)), /bounds/);
  const extended = concat(ftyp(), box("moov", track()));
  new DataView(extended.buffer).setUint32(16, 1, false);
  new DataView(extended.buffer).setBigUint64(24, BigInt(Number.MAX_SAFE_INTEGER) + 1n, false);
  assert.throws(() => inspectEnvelope(input(extended)), /Unsafe MP4 box size/);
});
test("refuses multiple MP4 tracks, fragmentation, compressed metadata and absent movie structure", () => {
  assert.throws(() => inspectEnvelope(input(mp4(track(), track()))), /Multiple MP4 tracks/);
  assert.throws(() => inspectEnvelope(input(concat(mp4(track()), box("moof")))), /Fragmented/);
  assert.throws(() => inspectEnvelope(input(concat(ftyp(), box("moov", box("cmov"))))), /compressed/);
  assert.throws(() => inspectEnvelope(input(concat(ftyp(), box("mdat")))), /Missing unique/);
});
test("checks one complete Ogg logical stream and the terminal page CRC", () => {
  assert.equal(inspectEnvelope(input(oggPage())), 3);
  const corrupt = oggPage(); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => inspectEnvelope(input(corrupt)), /checksum/);
  assert.throws(() => inspectEnvelope(input(oggPage({ flags: 2 }))), /no terminal/);
});
test("refuses chained, multiplexed, discontinuous and truncated Ogg before decoder startup", () => {
  assert.throws(() => inspectEnvelope(input(concat(oggPage(), oggPage({ serial: 8 })))), /Chained/);
  const initial = oggPage({ flags: 2 });
  assert.throws(() => inspectEnvelope(input(concat(initial, oggPage({ flags: 4, serial: 8, sequence: 1 })))), /multiplexed/);
  assert.throws(() => inspectEnvelope(input(concat(initial, oggPage({ flags: 4, sequence: 2 })))), /sequence/);
  const truncated = oggPage().slice(0, -1);
  assert.throws(() => inspectEnvelope(input(truncated)), /Truncated/);
});
test("bounds ID3 extents and rejects unsupported magic without trusting filenames", () => {
  const tagged = new Uint8Array(24); tagged.set(encode("ID3")); tagged[3] = 4;
  tagged.set([0x7f, 0x7f, 0x7f, 0x7f], 6);
  assert.throws(() => inspectEnvelope(input(tagged)), /metadata quota/);
  assert.throws(() => inspectEnvelope(input(new Uint8Array(12))), /outside the private/);
});
