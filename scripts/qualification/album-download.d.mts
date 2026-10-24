import type { Download } from "@playwright/test";
/** Successful transfer is unverified until the caller's exact encoded inspection/hash checks pass. */
export function streamAlbumDownload(download: Pick<Download, "createReadStream" | "failure" | "cancel">, path: string, expectedBytes: number): Promise<Readonly<{ path: string; bytes: number; verified: false }>>;

export class AlbumDownloadTransferError extends Error {
  readonly receipt: Readonly<{ path: string; bytes: number; received: number; expectedBytes: number; owned: boolean; verified: false; cleanup: readonly string[] }>;
}
