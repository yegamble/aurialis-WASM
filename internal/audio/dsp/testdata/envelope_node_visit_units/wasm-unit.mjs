// cspell:ignore GOMAXPROCS
// SOURCE ONLY host for one original test; separate execution release required.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { finishChild } from '../extrema_graph/child-lifecycle.mjs';
import { virtualDirectory } from '../extrema_graph/closed-fs.mjs';
import { createUnitIO, verifyUnitIO } from './unit-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const [sourceId, runId, label, name] = process.argv.slice(2);
const identifier = /^[a-z][a-z0-9-]{0,31}$/;
if (process.argv.length !== 6 || !identifier.test(sourceId ?? '') || !identifier.test(runId ?? '') || !['baseline', 'candidate'].includes(label) || !/^TestStudio[A-Za-z0-9]+$/.test(name ?? '') || process.version !== 'v26.12.0') throw new Error('closed original unit child refused');
function read(file, cap) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > cap) throw new Error('bounded unit input refused');
    const data = Buffer.alloc(info.size);
    for (let offset = 0; offset < data.length;) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (count < 1) throw new Error('unit input truncated');
      offset += count;
    }
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
const proof = path.join(root, 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-units', sourceId);
const sourceBytes = read(path.join(proof, 'SOURCE.json'), 256 * 1024);
const source = JSON.parse(sourceBytes.toString('utf8'));
const buildSHA = '16aacd5935e4bee8c9e253d926f9fe2d5dfbc2179f68b62b5b7e3d1195fde6f8';
if (source.baseBuild !== 'node-visit-build-v1' || source.baseBuildSHA256 !== buildSHA || Object.keys(source.files ?? {}).length !== 10) throw new Error('closed unit source inventory refused');
for (const [file, sha] of Object.entries(source.files)) {
  if (!file.startsWith('internal/audio/dsp/testdata/envelope_node_visit_') || file.split('/').includes('..') || hash(read(path.join(root, file), 256 * 1024)) !== sha || hash(read(path.join(proof, 'source-frozen', file), 256 * 1024)) !== sha) throw new Error('unit source snapshot changed');
}
const planBytes = read(path.join(root, 'internal/audio/dsp/testdata/envelope_node_visit_gates/PLAN.json'), 256 * 1024);
if (hash(planBytes) !== '8f0ffd7726eb727ae0d6d5372a63f4a9f1de567ddfd3f2f6be23e1cb336f3790') throw new Error('immutable whole-unit plan changed');
const plan = JSON.parse(planBytes.toString('utf8'));
const tests = plan.tests.filter((test) => test.name === name);
if (plan.testCount !== 18 || tests.length !== 1 || hash(read(path.join(root, tests[0].file), 256 * 1024)) !== tests[0].sourceSHA256) throw new Error('original test whitelist/source refused');
const build = path.join(root, 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-graph/node-visit-build-v1');
const manifestBytes = read(path.join(build, 'BUILD.json'), 256 * 1024);
if (hash(manifestBytes) !== buildSHA) throw new Error('bound original BUILD changed');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (Object.keys(manifest.snapshot?.runnerFiles ?? {}).length !== 20) throw new Error('original runner inventory changed');
for (const [file, sha] of Object.entries(manifest.snapshot.runnerFiles)) {
  if (!file.startsWith('internal/audio/dsp/') || file.split('/').includes('..') || hash(read(path.join(root, file), 256 * 1024)) !== sha) throw new Error('original runner/source changed');
}
const entry = manifest.modules?.wasm?.[label];
const moduleFile = path.join(build, 'modules', `wasm-${label}.wasm`);
const runtimeFile = manifest.runtime?.path;
if (entry?.file !== moduleFile || typeof runtimeFile !== 'string' || path.basename(runtimeFile) !== 'wasm_exec.js') throw new Error('unit module/runtime mapping refused');
const moduleBytes = read(moduleFile, 16 * 1024 * 1024);
const runtimeBytes = read(runtimeFile, 256 * 1024);
if (hash(moduleBytes) !== entry.sha256 || hash(runtimeBytes) !== manifest.runtime.sha256 || !moduleBytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('unit module/runtime hash refused');
const directory = path.join(proof, 'runs', runId);
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
const receipt = { scope: 'one original unit; no recorder, PCM, timing or selection', sourceId, runId, label, name,
  sourceSHA256: hash(sourceBytes), manifestSHA256: hash(manifestBytes), moduleSHA256: hash(moduleBytes), runtimeSHA256: hash(runtimeBytes),
  sourceSetSHA256: entry.sourceSetSHA256, overlaySHA256: entry.overlaySHA256,
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
