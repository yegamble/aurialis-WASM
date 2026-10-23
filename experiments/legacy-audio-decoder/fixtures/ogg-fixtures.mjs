/* Synthetic Ogg pages only; these opaque payloads are not encoded audio. */
export const concat = (...parts) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
};
export function vorbisIdentification() {
  const body = new Uint8Array(30), view = new DataView(body.buffer);
  body.set(new TextEncoder().encode("\u0001vorbis")); body[11] = 2;
  view.setUint32(12, 48000, true); body[28] = 0xb8; body[29] = 1;
  return body;
}
export function opusIdentification() {
  const body = new Uint8Array(19), view = new DataView(body.buffer);
  body.set(new TextEncoder().encode("OpusHead")); body[8] = 1; body[9] = 2;
  view.setUint32(12, 44100, true); // Metadata only; decoder-native Opus is 48 kHz.
  return body;
}
export function oggPage({ flags = 2, serial = 7, sequence = 0, body = vorbisIdentification(),
  segments = [body.byteLength], granule = 0n } = {}) {
  if (segments.length > 255 || segments.some((size) => size < 0 || size > 255) ||
      segments.reduce((total, size) => total + size, 0) !== body.byteLength)
    throw new Error("Invalid synthetic Ogg lacing.");
  const output = new Uint8Array(27 + segments.length + body.byteLength), view = new DataView(output.buffer);
  output.set(new TextEncoder().encode("OggS")); output[5] = flags; output[26] = segments.length;
  view.setBigUint64(6, granule, true); view.setUint32(14, serial, true); view.setUint32(18, sequence, true);
  output.set(segments, 27); output.set(body, 27 + segments.length);
  let crc = 0;
  for (const value of output) {
    crc ^= value << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
    crc >>>= 0;
  }
  view.setUint32(22, crc, true);
  return output;
}
export const oggStream = (body = vorbisIdentification()) => concat(
  oggPage({ body }), oggPage({ flags: 4, sequence: 1, body: new Uint8Array([0]) }),
);
export const byteInput = (bytes) => ({ size: bytes.byteLength, read: (offset, size) => bytes.slice(offset, offset + size) });

export const alternateIdentifications = () => [
  new TextEncoder().encode("BBCD\0"), new TextEncoder().encode("KW-DIRAC"),
  concat(new Uint8Array([0x80]), new TextEncoder().encode("theora")),
  new TextEncoder().encode("OVP80"), concat(new Uint8Array([0x7f]), new TextEncoder().encode("FLAC")),
  new TextEncoder().encode("Speex   "), new TextEncoder().encode("fishead\0"),
];
