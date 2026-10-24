import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const destination = path.resolve("public/licenses");
await mkdir(destination, { recursive: true });
const goroot = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
const goVersion = execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8" }).trim();
const sources = [
  { name: "Instrument Sans", package: "@fontsource/instrument-sans", file: "LICENSE", output: "instrument-sans-OFL.txt", upstream: "https://github.com/Instrument/instrument-sans" },
  { name: "Newsreader", package: "@fontsource/newsreader", file: "LICENSE", output: "newsreader-OFL.txt", upstream: "https://github.com/productiontype/Newsreader" },
  { name: "React", package: "react", file: "LICENSE", output: "react-MIT.txt", upstream: "https://github.com/facebook/react" },
  { name: "React DOM", package: "react-dom", file: "LICENSE", output: "react-dom-MIT.txt", upstream: "https://github.com/facebook/react" },
  { name: "Next.js", package: "next", file: "license.md", output: "next-MIT.txt", upstream: "https://github.com/vercel/next.js" },
  { name: "Tailwind CSS", package: "tailwindcss", file: "LICENSE", output: "tailwindcss-MIT.txt", upstream: "https://github.com/tailwindlabs/tailwindcss" },
];
const records = [];
for (const source of sources) {
  const directory = path.resolve("node_modules", source.package);
  const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const notice = await readFile(path.join(directory, source.file));
  await writeFile(path.join(destination, source.output), notice);
  records.push({ name: source.name, package: source.package, version: metadata.version, license: metadata.license, upstream: source.upstream, installedSource: `${source.package}/${source.file}`, notice: source.output, sha256: createHash("sha256").update(notice).digest("hex") });
}
const goNotice = await readFile(path.join(goroot, "LICENSE"));
await writeFile(path.join(destination, "go-BSD.txt"), goNotice);
const mp3Notice = await readFile(path.resolve("internal/third_party/gomp3/LICENSE"));
await writeFile(path.join(destination, "go-mp3-Apache-2.0.txt"), mp3Notice);
records.push({ name: "go-mp3 (modified copy in internal/third_party/gomp3)", version: "v0.3.4", license: "Apache-2.0", upstream: "https://github.com/hajimehoshi/go-mp3", installedSource: "internal/third_party/gomp3/LICENSE", notice: "go-mp3-Apache-2.0.txt", sha256: createHash("sha256").update(mp3Notice).digest("hex") });
records.push({ name: "Go standard library and JavaScript runtime", version: goVersion, license: "BSD-3-Clause", upstream: "https://go.dev/LICENSE", installedSource: "GOROOT/LICENSE", notice: "go-BSD.txt", sha256: createHash("sha256").update(goNotice).digest("hex") });
await writeFile(path.join(destination, "provenance.json"), JSON.stringify({ scope: "Third-party notices copied unchanged from the installed sources used to build the distributed app. This does not select or grant a license for Aurialis-WASM itself. No trained model or third-party GPU kernels are distributed by this checkpoint.", components: records }, null, 2) + "\n");
await writeFile(path.join(destination, "README.txt"), "Aurialis-WASM third-party notices\n\nThese notices accompany the bundled fonts, browser runtime and generated app assets. The copyright statements and licenses are copied unchanged from installed source packages. See provenance.json for exact versions, original source locations and notice SHA-256 digests. These notices do not assign a license to Aurialis-WASM itself.\n\n" + records.map((record) => `${record.name} (${record.version}): ${record.notice}`).join("\n") + "\n");
console.log(`Synchronized ${records.length} exact third-party notices for bundled app assets.`);
