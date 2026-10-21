import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const outDir = path.join(rootDir, "out");
const targetDir = path.join(rootDir, "internal", "webui", "embedded");

if (!fs.existsSync(outDir)) {
  console.error("out/ directory does not exist; run next build first.");
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.cpSync(outDir, targetDir, { recursive: true });

console.log("Synced Next.js static export out/ -> internal/webui/embedded/");
