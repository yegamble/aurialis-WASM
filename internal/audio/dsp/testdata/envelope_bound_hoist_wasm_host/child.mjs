// cspell:ignore GOMAXPROCS gojs
// SOURCE ONLY exact new direct unit; separate execution release required.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { finishChild } from '../extrema_graph/child-lifecycle.mjs';
import { virtualDirectory } from '../extrema_graph/closed-fs.mjs';
import { createUnitIO, verifyUnitIO } from '../envelope_node_visit_units/unit-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const [sourceId] = process.argv.slice(2);
const name = 'TestStudioEnvelopeBoundCoordinateOracleAndNoAlloc';
const schema = 'bound-coordinate-gojs-v1';
if (process.argv.length !== 3 || !/^[a-z][a-z0-9-]{0,31}$/.test(sourceId ?? '') || process.version !== 'v26.12.0' || JSON.stringify(process.execArgv) !== JSON.stringify(['--stack-size=8192', '--max-old-space-size=192'])) throw new Error('closed direct unit child refused');
function read(file, cap) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.size < 1 || before.size > cap) throw new Error('pre-read regular input cap refused');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > cap || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || info.mode !== before.mode || info.ctimeMs !== before.ctimeMs) throw new Error('bounded unit input refused');
    const data = Buffer.alloc(info.size);
    for (let offset = 0; offset < data.length;) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (count < 1) throw new Error('unit input truncated');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mode !== info.mode || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('input changed during bounded read');
    return data;
  } finally { fs.closeSync(fd); }
}
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function write(fd, data) {
  for (let offset = 0; offset < data.length;) {
    const count = fs.writeSync(fd, data, offset, data.length - offset);
    if (count < 1) throw new Error('unit output short write');
    offset += count;
  }
  return data.length;
}
const proof = path.join(root, 'artifacts/private-dsp/recovery-20261023/envelope-bound-hoist-wasm', sourceId);
const sourceBytes = read(path.join(proof, 'SOURCE.json'), 256 * 1024);
const source = JSON.parse(sourceBytes.toString('utf8'));
if (source.schema !== schema || source.test !== name || source.nativeBUILD_SHA256 !== 'dd08ea0709c3096cba91d7091839be10f0322c9f56dac517a20324cb05a55d64' || source.runnerCount !== Object.keys(source.runnerFiles ?? {}).length || source.runnerCount !== 44) throw new Error('closed bound source binding refused');
for (const [file, sha] of Object.entries(source.runnerFiles)) {
  if ((!file.startsWith('internal/audio/dsp/') && !file.startsWith('artifacts/private-dsp/recovery-20261023/')) || file.split('/').includes('..') || path.isAbsolute(file)) throw new Error('source path refused');
  const frozenName = file.endsWith('.go') ? `${file}.source` : file;
  if (hash(read(path.join(root, file), 256 * 1024)) !== sha || hash(read(path.join(proof, 'source-frozen', frozenName), 256 * 1024)) !== sha) throw new Error('bound host/source bytes changed');
}
const manifestBytes = read(path.join(proof, 'BUILD.json'), 256 * 1024);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifest.schema !== schema || manifest.sourceSHA256 !== hash(sourceBytes) || JSON.stringify(manifest.runtime) !== JSON.stringify(source.runtime) || JSON.stringify(manifest.toolchainPins) !== JSON.stringify(source.toolchainPins)) throw new Error('candidate BUILD binding refused');
const entry = manifest.module;
const moduleFile = path.join(proof, 'candidate.wasm');
const runtimeFile = source.runtime?.path;
if (entry?.file !== moduleFile || typeof runtimeFile !== 'string' || path.basename(runtimeFile) !== 'wasm_exec.js') throw new Error('module/runtime mapping refused');
const moduleBytes = read(moduleFile, 16 * 1024 * 1024);
const runtimeBytes = read(runtimeFile, 256 * 1024);
if (moduleBytes.length !== entry.bytes || hash(moduleBytes) !== entry.sha256 || hash(runtimeBytes) !== source.runtime.sha256 || !moduleBytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('exact module/runtime bytes refused');
const directory = path.join(proof, 'unit');
if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('exclusive unit directory refused');
const io = createUnitIO(fs.constants, (fd, buffer) => write(fd, buffer));
let go;
let goExit = null;
let failure = null;
try {
  globalThis.fs = io.fs;
  globalThis.path = Object.freeze({ resolve: (...parts) => path.posix.resolve(...parts) });
  globalThis.fetch = () => { throw new Error('network disabled in original unit child'); };
  globalThis.WebSocket = undefined;
  vm.runInThisContext(runtimeBytes.toString('utf8'), { filename: runtimeFile });
  go = new globalThis.Go();
  go.argv = [moduleFile, `-test.run=^${name}$`, '-test.count=1', '-test.v', '-test.timeout=25s'];
  go.env = { GOMAXPROCS: '1', TMPDIR: virtualDirectory };
  go.exit = (code) => { if (goExit !== null) throw new Error('duplicate unit Go exit'); goExit = code; };
  const instance = (await WebAssembly.instantiate(moduleBytes, go.importObject)).instance;
  await go.run(instance);
  verifyUnitIO(io.receipt());
  if (!go.exited || goExit !== 0) throw new Error('unit Go exit incomplete');
} catch (cause) { failure = String(cause?.message ?? cause).slice(0, 256); }
const receipt = { schema, scope: 'one direct oracle/allocation unit; no PCM/timing', sourceId, name, nodeVersion: process.version,
  sourceSHA256: hash(sourceBytes), manifestSHA256: hash(manifestBytes), moduleSHA256: hash(moduleBytes), runtimeSHA256: hash(runtimeBytes),
  sourceSetSHA256: entry.sourceSetSHA256, overlaySHA256: entry.overlaySHA256,
  nodeArgv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], goArgv: go?.argv ?? null,
  goExit, goExited: go?.exited === true, failure, io: io.receipt(),
};
const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
if (bytes.length > 128 * 1024) throw new Error('unit child receipt cap exceeded');
finishChild({ code: failure === null ? 0 : 1, receipt,
  writeReceipt() {
    const fd = fs.openSync(path.join(directory, 'receipt.json'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { write(fd, bytes); } finally { fs.closeSync(fd); }
  },
  writeError: (text) => write(2, Buffer.from(text)), exit: (code) => process.exit(code),
});
