import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

/** A content hash of the live engine and worklet, appended to their URLs so a
 * browser can never pair a cached older engine with a newer worklet (or skip
 * the source-end drain, V1-13). A checkout without the built engine gets a
 * hash of the file names. */
function liveAssetVersion(): string {
  const hash = createHash("sha256");
  for (const file of ["public/wasm/aurialis-realtime.wasm", "public/worklets/aurialis-live-worklet.js"]) {
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update(file);
    }
  }
  return hash.digest("hex").slice(0, 16);
}

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_AURIALIS_LIVE_ASSET_VERSION: liveAssetVersion(),
  },
};

export default nextConfig;
