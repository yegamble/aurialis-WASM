export interface EncodedLayout { sampleRate: number; frames: number; bitDepth: 16 | 24 | 32 }
/** Capacity and exact encoder layout only; sample inspection remains separate. */
export function encodedWAVBytes(layout: EncodedLayout): number {
  if (![16, 24, 32].includes(layout.bitDepth) || !Number.isSafeInteger(layout.frames) || layout.frames < 1 || layout.frames > 16_777_216
    || !Number.isSafeInteger(layout.sampleRate) || layout.sampleRate < 8000 || layout.sampleRate > 192000) throw new Error("The encoded master has an unexpected source layout or length.");
  return 44 + layout.frames * layout.bitDepth / 8 * 2;
}
export function assertEncodedWAVLayout(buffer: ArrayBuffer, layout: EncodedLayout): void {
  const expected = encodedWAVBytes(layout), align = layout.bitDepth / 8 * 2;
  if (buffer.byteLength !== expected) throw new Error("The encoded master has an unexpected source layout or length.");
  const header = new DataView(buffer, 0, 44);
  const label = (offset: number) => String.fromCharCode(header.getUint8(offset), header.getUint8(offset + 1), header.getUint8(offset + 2), header.getUint8(offset + 3));
  if (label(0) !== "RIFF" || label(8) !== "WAVE" || label(12) !== "fmt " || header.getUint32(16, true) !== 16
    || header.getUint16(20, true) !== (layout.bitDepth === 32 ? 3 : 1) || header.getUint16(22, true) !== 2
    || header.getUint32(24, true) !== layout.sampleRate || header.getUint32(28, true) !== layout.sampleRate * align
    || header.getUint16(32, true) !== align || header.getUint16(34, true) !== layout.bitDepth || label(36) !== "data"
    || header.getUint32(40, true) !== expected - 44 || header.getUint32(4, true) !== expected - 8)
    throw new Error("The encoded master is not the expected clean WAV layout.");
}
