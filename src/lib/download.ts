import { reserveBrowserAudioMemory } from "./browser-jobs";

const downloads = new WeakMap<Blob, { memory: ReturnType<typeof reserveBrowserAudioMemory>; references: number }>();

/**
 * Keep downloadable audio charged until every object URL for this Blob is revoked.
 * Pass `charge: false` only for Blobs read back from browser storage (or composed
 * from them), which the browser keeps on disk rather than in memory.
 */
export function downloadLocalBlob(blob: Blob, filename: string, { charge = true }: { charge?: boolean } = {}): void {
  if (!charge) { clickDownload(blob, filename, () => undefined); return; }
  let owner = downloads.get(blob);
  if (!owner) {
    // This temporary owner conservatively overlaps an existing UI cache owner.
    owner = { memory: reserveBrowserAudioMemory(blob.size), references: 0 };
    downloads.set(blob, owner);
  }
  owner.references++;
  const retained = owner;
  const release = () => {
    retained.references--;
    if (retained.references === 0) {
      downloads.delete(blob);
      retained.memory.dispose();
    }
  };
  clickDownload(blob, filename, release);
}

function clickDownload(blob: Blob, filename: string, release: () => void): void {
  let url: string | undefined;
  try {
    url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    const retainedURL = url;
    setTimeout(() => { try { URL.revokeObjectURL(retainedURL); } finally { release(); } }, 1000);
  } catch (cause) {
    try { if (url !== undefined) URL.revokeObjectURL(url); } finally { release(); }
    throw cause;
  }
}
