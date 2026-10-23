// cspell:ignore GOMAXPROCS
// Private trusted-module semantics harness; no throughput or sandbox claim.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createFixtureFS, rates, virtualDirectory } from './closed-fs.mjs';
import { createCounterCollector, finishChild } from './child-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const proof = path.join(root, 'artifacts/private-dsp/recovery-20261023/exact-extrema-wasm-graph-runner');
const [label, rateText, runId, revision] = process.argv.slice(2);
const rate = Number(rateText);
if (!['baseline', 'candidate'].includes(label) || !rates.includes(rate) || String(rate) !== rateText || !/^[a-z][a-z0-9-]{0,31}$/.test(runId ?? '') || process.argv.length !== 6 || revision !== 'post-exit-v2' || process.version !== 'v26.12.0') {
  throw new Error('closed private child admission refused');
}
function boundedRead(file, cap) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > cap || info.size < 1) throw new Error('private input size refused');
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const n = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (n < 1) throw new Error('private input truncated');
      offset += n;
    }
    return data;
  } finally { fs.closeSync(fd); }
}
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const n = fs.writeSync(fd, data, offset, data.length - offset);
    if (n < 1) throw new Error('private sink short write');
    offset += n;
  }
  return data.length;
}
const manifestBytes = boundedRead(path.join(proof, `BUILD-PROVENANCE-${revision}.json`), 64 * 1024);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const moduleFile = path.join(proof, 'modules', `${label}.wasm`);
const entry = manifest.modules?.[label];
const runtimeFile = manifest.runtime?.path;
if (entry?.file !== moduleFile || !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? '') || typeof runtimeFile !== 'string' || path.basename(runtimeFile) !== 'wasm_exec.js') {
  throw new Error('private build provenance refused');
}
for (const name of ['closed-fs.mjs', 'wasm-child.mjs', 'child-lifecycle.mjs']) {
  if (hash(boundedRead(path.join(path.dirname(fileURLToPath(import.meta.url)), name), 64 * 1024)) !== manifest.runnerFiles?.[name]) throw new Error('private runner source changed');
}
for (const value of [entry.sourceSetSHA256, entry.overlaySHA256, manifest.recorderSHA256]) {
  if (!/^[0-9a-f]{64}$/.test(value ?? '')) throw new Error('private source provenance absent');
}
const moduleBytes = boundedRead(moduleFile, 16 * 1024 * 1024);
const runtimeBytes = boundedRead(runtimeFile, 256 * 1024);
if (hash(moduleBytes) !== entry.sha256 || hash(runtimeBytes) !== manifest.runtime.sha256 || !moduleBytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
  throw new Error('private module/runtime hash refused');
}
const directory = path.join(proof, 'runs', runId, `${label}-rate${rate}`);
if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('private output directory refused');
const outputFile = path.join(directory, `rate${rate}.bin`);
const sink = fs.openSync(outputFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
const outputHash = createHash('sha256');
const counters = createCounterCollector();
let counterReceipt = null;
const io = createFixtureFS({ rate, constants: fs.constants,
  onData(buffer) { const n = writeAll(sink, buffer); outputHash.update(buffer); return n; },
  onLog(fd, buffer) { counters.add(buffer); return writeAll(fd, buffer); },
});
let go;
let goExit = null;
let failure = null;
let initialMemoryBytes = null;
let finalMemoryBytes = null;
try {
  globalThis.fs = io.fs;
  globalThis.path = Object.freeze({ resolve: (...segments) => path.posix.resolve(...segments) });
  globalThis.fetch = () => { throw new Error('network disabled in private fixture'); };
  globalThis.WebSocket = undefined;
  vm.runInThisContext(runtimeBytes.toString('utf8'), { filename: runtimeFile });
  go = new globalThis.Go();
  go.argv = [moduleFile, '-test.run=^TestWriteStudioExtremaGraphFixtures$', '-test.count=1', '-test.v', '-test.timeout=25s'];
  go.env = { GOMAXPROCS: '1', AURIALIS_STUDIO_EXTREMA_RATE: rateText, AURIALIS_STUDIO_EXTREMA_FIXTURES: virtualDirectory, TMPDIR: virtualDirectory };
  go.exit = (code) => { if (goExit !== null) throw new Error('duplicate Go exit'); goExit = code; };
  const instance = (await WebAssembly.instantiate(moduleBytes, go.importObject)).instance;
  initialMemoryBytes = instance.exports.mem.buffer.byteLength;
  await go.run(instance);
  finalMemoryBytes = instance.exports.mem.buffer.byteLength;
  const state = io.receipt();
  counterReceipt = counters.verify(manifest.nativeCounterReceipts?.[rateText], rate, state.bytes);
  if (!go.exited || goExit !== 0 || state.failure !== null || !state.everOpened || !state.closed || state.bytes < 1) throw new Error('private Go/closed sink did not complete successfully');
} catch (cause) {
  failure = String(cause?.message ?? cause).slice(0, 256);
} finally {
  fs.closeSync(sink);
}
const receipt = {
  scope: 'actual GoJS/WASM graph semantics only; no runtime RSS/performance claim', label, rate, runId, revision, counterReceipt,
  sourceSetSHA256: entry.sourceSetSHA256, overlaySHA256: entry.overlaySHA256, recorderSHA256: manifest.recorderSHA256,
  moduleSHA256: hash(moduleBytes), runtimeSHA256: hash(runtimeBytes), manifestSHA256: hash(manifestBytes),
  goExit, goExited: go?.exited === true, failure, io: io.receipt(), outputSHA256: outputHash.digest('hex'),
  initialMemoryBytes, finalMemoryBytes,
};
const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
if (receiptBytes.length > 128 * 1024) throw new Error('private final receipt admission exceeded');
finishChild({ code: failure === null ? 0 : 1, receipt,
  writeReceipt() {
    const fd = fs.openSync(path.join(directory, 'receipt.json'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { writeAll(fd, receiptBytes); } finally { fs.closeSync(fd); }
  },
  writeError: (text) => writeAll(2, Buffer.from(text)),
  exit: (code) => process.exit(code),
});
