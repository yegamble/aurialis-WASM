/** Qualified build-input identity. This is not a native executable checksum. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePaths = { offline: 'wasm/aurialis-dsp.wasm', realtime: 'wasm/aurialis-realtime.wasm', runtime: 'wasm/wasm_exec.js' };
const configurationPaths = ['go.mod', 'go.sum', 'package.json', 'pnpm-lock.yaml', '.nvmrc', '.mise.toml', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs', 'scripts/build.sh', 'scripts/build-browser.sh', 'scripts/build-e2e.sh', 'scripts/sync-webui.mjs', 'scripts/prepare-browser-assets.mjs', 'scripts/processing-build.mjs'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function regularBytes(path, limit = 64 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error('Processing inputs must be bounded regular files.');
  return readFileSync(path);
}
function sourcePaths(root, folder, found) {
  const path = join(root, folder);
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const name = join(folder, entry.name);
    if (['__tests__', 'embedded', 'testdata', 'fixtures'].includes(entry.name) || /(?:_test\.go|\.(?:test|spec)\.[^.]+)$/u.test(entry.name)) continue;
    if (entry.isDirectory()) sourcePaths(root, name, found);
    else if (folder.startsWith('public') ? /\.js$/u.test(entry.name) : /\.(?:go|ts|tsx|css|json)$/u.test(entry.name)) found.add(name);
    if (found.size > 4096) throw new Error('Processing contracts exceed their file bound.');
  }
}
export function processingDescriptor(root, target, tools) {
  if (!['native', 'browser'].includes(target)) throw new Error('Choose a closed processing execution target.');
  if (tools.node !== '26.12.0' || tools.pnpm !== '10.33.0' || tools.go.GOVERSION !== 'go1.26.10') throw new Error('Qualified processing requires the pinned toolchains.');
  if ((tools.go.GOFLAGS ?? '') !== '' || (tools.go.GOEXPERIMENT ?? '') !== '') throw new Error('Qualified processing requires the fixed compiler flags.');
  for (const name of ['go.mod', 'package.json', 'pnpm-lock.yaml']) if (!existsSync(join(root, name))) throw new Error('Processing dependency contracts are missing.');
  const modules = {};
  for (const [name, path] of Object.entries(modulePaths)) {
    const bytes = regularBytes(join(root, 'public', path), name === 'runtime' ? 1024 * 1024 : 25 * 1024 * 1024);
    if (name !== 'runtime' && (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '0061736d01000000')) throw new Error('A built processing module is missing or invalid.');
    modules[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  const paths = new Set(configurationPaths.filter((name) => existsSync(join(root, name))));
  for (const directory of ['src', 'cmd', 'internal', 'wasm', 'public']) sourcePaths(root, directory, paths);
  const contracts = {};
  let total = 0;
  for (const name of [...paths].sort()) {
    const bytes = regularBytes(join(root, name)); total += bytes.length;
    if (total > 64 * 1024 * 1024) throw new Error('Processing contracts exceed their byte bound.');
    contracts[name.replaceAll('\\', '/')] = sha256(bytes);
  }
  return canonical({ version: 1, executionTarget: target, modules, contracts, tools,
    compile: ['Go -trimpath', 'js/wasm', 'wasip1/wasm -buildmode=c-shared', 'native -X build.Fingerprint=<identity>', 'Next production static export'] });
}
export function publicProcessingIdentity(descriptor) {
  return { version: 1, target: descriptor.executionTarget, fingerprint: sha256(JSON.stringify(canonical(descriptor))),
    offlineSha256: descriptor.modules.offline.sha256, offlineBytes: descriptor.modules.offline.bytes, realtimeSha256: descriptor.modules.realtime.sha256, runtimeSha256: descriptor.modules.runtime.sha256 };
}
export function verifyEmbeddedProcessing(root, descriptor) {
  if (descriptor.executionTarget !== 'native') throw new Error('Only native processing is linked into an executable.');
  const expected = publicProcessingIdentity(descriptor), embedded = join(root, 'internal/webui/embedded');
  const stored = JSON.parse(regularBytes(join(embedded, 'processing-build.json'), 4096));
  if (JSON.stringify(canonical(stored)) !== JSON.stringify(canonical(expected))) throw new Error('The embedded UI processing identity is stale. Rebuild the complete application.');
  for (const [name, path] of Object.entries(modulePaths)) if (sha256(regularBytes(join(embedded, path))) !== descriptor.modules[name].sha256) throw new Error('An embedded processing module differs from the qualified build.');
  return expected.fingerprint;
}
function actualTools() {
  const go = JSON.parse(execFileSync('go', ['env', '-json', 'GOVERSION', 'GOOS', 'GOARCH', 'GOAMD64', 'GOARM64', 'CGO_ENABLED', 'GOEXPERIMENT', 'GOFLAGS', 'GOTOOLCHAIN'], { encoding: 'utf8' }));
  return { node: process.versions.node, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(), go };
}
function main() {
  const [mode, target] = process.argv.slice(2), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!['prepare', 'verify-native'].includes(mode)) throw new Error('Choose processing prepare or verify-native.');
  const descriptor = processingDescriptor(root, target, actualTools()), identity = publicProcessingIdentity(descriptor);
  if (mode === 'verify-native') { process.stdout.write(verifyEmbeddedProcessing(root, descriptor)); return; }
  mkdirSync(join(root, 'artifacts/processing-build'), { recursive: true });
  writeFileSync(join(root, `artifacts/processing-build/${target}.json`), JSON.stringify({ descriptor, identity }, null, 2));
  writeFileSync(join(root, 'public/processing-build.json'), JSON.stringify(identity));
  process.stdout.write(JSON.stringify(identity));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (cause) { process.stderr.write(`${cause instanceof Error ? cause.message : 'Processing identity failed.'}\n`); process.exitCode = 1; }
}
