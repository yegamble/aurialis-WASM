import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "deploy/cloudflare/assets");
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await cp(path.join(root, "out"), directory, { recursive: true });
const hashes = new Set();
const paths = [];
let files = 0;
async function inspect(current) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) { await inspect(file); continue; }
    if (!entry.isFile()) throw new Error("The static app must contain only regular files.");
    const info = await stat(file);
    if (info.size > 25 * 1024 * 1024) throw new Error(`Static file exceeds Cloudflare's 25 MiB limit: ${path.relative(directory, file)}`);
    files++;
    paths.push(path.relative(directory, file).split(path.sep).join("/"));
    if (!file.endsWith(".html")) continue;
    const html = await readFile(file, "utf8");
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)) {
      if (!match[1]) continue;
      hashes.add(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
    }
  }
}
await inspect(directory);
// Match internal/server/csp.go exactly: same generated inline script bytes,
// directives and sorted SHA-256 values. No unsafe-inline script permission.
const csp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${[...hashes].sort().join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self'; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
await writeFile(path.join(root, "deploy/cloudflare/asset-policy.json"), JSON.stringify({ csp, execution: "browser", files, paths: paths.sort() }, null, 2) + "\n");
console.log(`Prepared ${files} static app files with ${hashes.size} exact inline script hashes; audio stays on this device.`);
