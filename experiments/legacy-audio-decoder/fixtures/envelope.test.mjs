/* Structural preflight units only; no FFmpeg, audio decode, browser or Go CDR. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectEnvelope } from "../envelope.mjs";
import { oggPage, oggStream, vorbisIdentification, opusIdentification, alternateIdentifications } from "./ogg-fixtures.mjs";

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
  assert.equal(inspectEnvelope(input(oggStream())), 3);
  const corrupt = oggStream(); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => inspectEnvelope(input(corrupt)), /checksum/);
  assert.throws(() => inspectEnvelope(input(oggPage({ flags: 2 }))), /no terminal/);
});
test("refuses chained, multiplexed, discontinuous and truncated Ogg before decoder startup", () => {
  assert.throws(() => inspectEnvelope(input(concat(oggStream(), oggStream()))), /Chained/);
  const initial = oggPage({ flags: 2 });
  assert.throws(() => inspectEnvelope(input(concat(initial, oggPage({ flags: 4, serial: 8, sequence: 1, body: new Uint8Array([0]) })))), /multiplexed/);
  assert.throws(() => inspectEnvelope(input(concat(initial, oggPage({ flags: 4, sequence: 2, body: new Uint8Array([0]) })))), /sequence/);
  const truncated = oggStream().slice(0, -1);
  assert.throws(() => inspectEnvelope(input(truncated)), /Truncated/);
});
test("bounds ID3 extents and rejects unsupported magic without trusting filenames", () => {
  const tagged = new Uint8Array(24); tagged.set(encode("ID3")); tagged[3] = 4;
  tagged.set([0x7f, 0x7f, 0x7f, 0x7f], 6);
  assert.throws(() => inspectEnvelope(input(tagged)), /metadata quota/);
  assert.throws(() => inspectEnvelope(input(new Uint8Array(12))), /outside the private/);
});

test("allows only a complete Vorbis or Opus identification packet on the first BOS page", () => {
  assert.equal(inspectEnvelope(input(oggStream(vorbisIdentification()))), 3);
  assert.equal(inspectEnvelope(input(oggStream(opusIdentification()))), 3);
  for (const body of alternateIdentifications()) {
    assert.throws(() => inspectEnvelope(input(oggStream(body))), /identification|codec/);
  }
});
test("refuses malformed identification geometry and additional BOS packets", () => {
  const cases = [];
  const wrongVersion = vorbisIdentification(); wrongVersion[7] = 1; cases.push(wrongVersion);
  const wrongChannels = vorbisIdentification(); wrongChannels[11] = 3; cases.push(wrongChannels);
  const wrongBlocks = vorbisIdentification(); wrongBlocks[28] = 0x55; cases.push(wrongBlocks);
  const wrongFraming = vorbisIdentification(); wrongFraming[29] = 0; cases.push(wrongFraming);
  const wrongRate = vorbisIdentification(); new DataView(wrongRate.buffer).setUint32(12, 0, true); cases.push(wrongRate);
  const opusVersion = opusIdentification(); opusVersion[8] = 2; cases.push(opusVersion);
  const opusMapping = opusIdentification(); opusMapping[18] = 1; cases.push(opusMapping);
  const opusChannels = opusIdentification(); opusChannels[9] = 3; cases.push(opusChannels);
  cases.push(concat(opusIdentification(), new Uint8Array([0])));
  for (const body of cases) assert.throws(() => inspectEnvelope(input(oggStream(body))), /identification/);
  const extraPacket = oggPage({ body: concat(vorbisIdentification(), new Uint8Array([0])), segments: [30, 1] });
  assert.throws(() => inspectEnvelope(input(concat(extraPacket, oggPage({ flags: 4, sequence: 1, body: new Uint8Array([0]) })))), /identification/);
  assert.throws(() => inspectEnvelope(input(concat(oggPage({ granule: 1n }), oggPage({ flags: 4, sequence: 1, body: new Uint8Array([0]) })))), /identification/);
});
test("checks packet continuation and refuses incomplete EOS packets", () => {
  const first = oggPage();
  assert.throws(() => inspectEnvelope(input(concat(first, oggPage({ flags: 5, sequence: 1, body: new Uint8Array([0]) })))), /continuation/);
  const partial = oggPage({ flags: 0, sequence: 1, body: new Uint8Array(255), segments: [255] });
  assert.throws(() => inspectEnvelope(input(concat(first, partial, oggPage({ flags: 4, sequence: 2, body: new Uint8Array([0]) })))), /continuation/);
  assert.throws(() => inspectEnvelope(input(concat(first, oggPage({ flags: 4, sequence: 1, body: new Uint8Array(255), segments: [255] })))), /unfinished/);
  assert.equal(inspectEnvelope(input(concat(first, partial, oggPage({ flags: 5, sequence: 2, body: new Uint8Array([0]) })))), 3);
});
