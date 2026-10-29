import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Compile an intentionally incompatible real Go module without external assets. */
export default async function prepareBrowserTests() {
  if (process.env.AURIALIS_BROWSER_QA !== "1") throw new Error("Browser QA requires explicit AURIALIS_BROWSER_QA=1 opt-in.");
  const directory = path.resolve("artifacts/browser-local");
  await mkdir(directory, { recursive: true });
  const source = "wasm/dsp/testdata/stale-browser/main.go";
  const destination = path.join(directory, "stale-fixture.wasm");
  execFileSync("go", ["build", "-trimpath", "-o", destination, "./wasm/dsp/testdata/stale-browser"], { env: { ...process.env, GOOS: "js", GOARCH: "wasm" }, stdio: "pipe" });
  const sha256 = (data) => createHash("sha256").update(data).digest("hex");
  await writeFile(path.join(directory, "stale-fixture-provenance.json"), JSON.stringify({ source, sourceSha256: sha256(await readFile(source)), moduleSha256: sha256(await readFile(destination)), contract: "Go runtime initializes but deliberately exports no offline job ABI or dispatcher." }, null, 2) + "\n");
}
