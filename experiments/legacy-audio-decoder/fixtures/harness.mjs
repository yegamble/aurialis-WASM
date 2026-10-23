/* Private fixture harness. Never takes an OPFS key, user path or remote URL. */
import { recoverCompressedFixture } from "../client.mjs";
export async function runGeneratedFixture(bytes, name, adapters) {
  if (!(bytes instanceof Uint8Array) || !/^fixture-[a-z0-9-]+\.(mp3|flac|ogg|aac|m4a)$/.test(name))
    throw new Error("Only named generated fixture bytes are accepted.");
  if (typeof adapters?.validate !== "function" || typeof adapters?.reserve !== "function" ||
      !(adapters.signal instanceof AbortSignal)) throw new Error("Actual CDR/memory adapters are required.");
  return recoverCompressedFixture(new File([bytes], name, { type: "application/octet-stream", lastModified: 0 }), adapters);
}
export const pendingCorpus = Object.freeze([
  "MP3 CBR/VBR, MPEG versions, gapless delay/end padding",
  "FLAC mono/stereo, integer widths, exact Float32 conversion",
  "Vorbis short/long blocks, one logical Ogg stream",
  "Opus SILK/CELT/hybrid, pre-skip, end trimming, intrinsic 48 kHz",
  "AAC LC/HE/HEv2, ADTS and MP4, actual first-frame geometry",
  "ALAC MP4, ordinary edit lists and decoded sample geometry",
  "Malformed/encrypted/chained/multitrack/fragmented/rate-change rejection",
  "Busy-C cancellation, deadline, output/memory/read/metadata quota failure",
]);
