import { reserveBrowserAudioMemory } from "./browser-jobs";

const downloads = new WeakMap<Blob, { memory: ReturnType<typeof reserveBrowserAudioMemory>; references: number }>();

/** Keep downloadable audio charged until every object URL for this Blob is revoked. */
export function downloadLocalBlobAndWait(blob: Blob, filename: string): Promise<void> {
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
  let url: string | undefined;
  try {
    url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    const retainedURL = url;
    let complete = () => { /* Assigned synchronously before the revocation timer. */ };
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    setTimeout(() => { try { URL.revokeObjectURL(retainedURL); } finally { release(); complete(); } }, 1000);
    return completed;
  } catch (cause) {
    try { if (url !== undefined) URL.revokeObjectURL(url); } finally { release(); }
    throw cause;
  }
}

/** Existing handlers start synchronously and surface allocation/click failures. */
export function downloadLocalBlob(blob: Blob, filename: string): void {
  void downloadLocalBlobAndWait(blob, filename);
}
