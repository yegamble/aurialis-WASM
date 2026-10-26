import { afterEach, describe, expect, it, vi } from "vitest";
import { Blob as NativeBlob } from "node:buffer";
import { albumEntryNames, crc32, createStoredZip } from "../zip";

afterEach(() => { vi.unstubAllGlobals(); });

async function bytes(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

describe("stored album ZIP", () => {
  it("matches the IEEE CRC-32 check value, including across chunks", () => {
    const input = new TextEncoder().encode("123456789");
    expect(crc32(input)).toBe(0xcbf4_3926);
    expect(crc32(input.subarray(4), crc32(input.subarray(0, 4)))).toBe(0xcbf4_3926);
  });

  it("writes readable local headers, stored data and a central directory", async () => {
    vi.stubGlobal("Blob", NativeBlob);
    const first = new Blob(["RIFF-first"]), second = new Blob(["RIFF-second-track"]);
    const zip = await createStoredZip([{ name: "01 First.wav", blob: first }, { name: "02 Second.wav", blob: second }], undefined, new Date(2026, 9, 26, 8, 30, 10));
    const view = await bytes(zip);
    expect(view.getUint32(0, true)).toBe(0x0403_4b50);
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint32(14, true)).toBe(crc32(new TextEncoder().encode("RIFF-first")));
    expect(view.getUint32(18, true)).toBe(10);
    const name = new TextDecoder().decode(new Uint8Array(view.buffer, 30, 12));
    expect(name).toBe("01 First.wav");
    expect(new TextDecoder().decode(new Uint8Array(view.buffer, 42, 10))).toBe("RIFF-first");
    const end = view.byteLength - 22;
    expect(view.getUint32(end, true)).toBe(0x0605_4b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const centralOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x0201_4b50);
    expect(view.getUint32(centralOffset + 42, true)).toBe(0);
    const secondCentral = centralOffset + 46 + 12;
    expect(view.getUint32(secondCentral + 42, true)).toBe(30 + 12 + 10);
    expect(view.getUint16(secondCentral + 14, true)).toBe(((2026 - 1980) << 9) | (10 << 5) | 26);
  });

  it("rejects duplicate, absolute or traversing names and empty archives", async () => {
    vi.stubGlobal("Blob", NativeBlob);
    const blob = new Blob(["x"]);
    await expect(createStoredZip([])).rejects.toThrow("between 1");
    await expect(createStoredZip([{ name: "a.wav", blob }, { name: "a.wav", blob }])).rejects.toThrow("unique");
    await expect(createStoredZip([{ name: "../a.wav", blob }])).rejects.toThrow("relative");
    await expect(createStoredZip([{ name: "/a.wav", blob }])).rejects.toThrow("relative");
  });

  it("numbers titles in running order with filesystem-safe names", () => {
    expect(albumEntryNames(["Intro", "Intro", "a/b:c?", "  ", "..hidden."])).toEqual(["01 Intro.wav", "02 Intro.wav", "03 a-b-c-.wav", "04 Track.wav", "05 hidden.wav"]);
  });
});
