// cspell:ignore GOMAXPROCS
// Private semantic child only; existing closed filesystem/lifecycle stay unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createFixtureFS, rates, virtualDirectory } from '../extrema_graph/closed-fs.mjs';
import { createCounterCollector, finishChild } from '../extrema_graph/child-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const [buildId, label, rateText] = process.argv.slice(2);
const rate = Number(rateText);
if (process.argv.length !== 5 || !/^[a-z][a-z0-9-]{0,31}$/.test(buildId ?? '') || !['baseline', 'candidate'].includes(label) || !rates.includes(rate) || String(rate) !== rateText || process.version !== 'v26.12.0') throw new Error('closed semantic child refused');
const proof = path.join(root, 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-graph', buildId);
function read(file, cap) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > cap) throw new Error('bounded semantic input refused');
    const data = Buffer.alloc(info.size);
    for (let offset = 0; offset < data.length;) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (count < 1) throw new Error('semantic input truncated');
      offset += count;
    }
    return data;
  } finally { fs.closeSync(fd); }
}
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function write(fd, data) {
  for (let offset = 0; offset < data.length;) {
    const count = fs.writeSync(fd, data, offset, data.length - offset);
    if (count < 1) throw new Error('semantic output short write');
    offset += count;
  }
  return data.length;
}
const manifestBytes = read(path.join(proof, 'BUILD.json'), 256 * 1024);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const runners = manifest.snapshot?.runnerFiles;
if (Object.keys(runners ?? {}).length !== 20 || typeof runners?.['internal/audio/dsp/testdata/envelope_node_visit_graph/wasm-child.mjs'] !== 'string') throw new Error('closed runner inventory refused');
for (const [name, sha] of Object.entries(runners)) {
  if (!name.startsWith('internal/audio/dsp/') || name.split('/').includes('..') || hash(read(path.join(root, name), 64 * 1024)) !== sha) throw new Error('semantic runner/source changed');
}
const entry = manifest.modules?.wasm?.[label];
const moduleFile = path.join(proof, 'modules', `wasm-${label}.wasm`);
const runtimeFile = manifest.runtime?.path;
if (entry?.file !== moduleFile || typeof runtimeFile !== 'string' || path.basename(runtimeFile) !== 'wasm_exec.js') throw new Error('semantic module/runtime admission refused');
const moduleBytes = read(moduleFile, 16 * 1024 * 1024);
const runtimeBytes = read(runtimeFile, 256 * 1024);
if (hash(moduleBytes) !== entry.sha256 || hash(runtimeBytes) !== manifest.runtime.sha256 || !moduleBytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('semantic module/runtime hash refused');
const directory = path.join(proof, 'runs', `wasm-${label}-rate${rate}`);
if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('fresh semantic output directory refused');
const sink = fs.openSync(path.join(directory, `rate${rate}.bin`), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
const outputHash = createHash('sha256');
const counters = createCounterCollector();
let counterReceipt = null;
const io = createFixtureFS({ rate, constants: fs.constants,
  onData(buffer) { const count = write(sink, buffer); outputHash.update(buffer); return count; },
  onLog(fd, buffer) { counters.add(buffer); return write(fd, buffer); },
});
let go;
let goExit = null;
let failure = null;
try {
  globalThis.fs = io.fs;
  globalThis.path = Object.freeze({ resolve: (...parts) => path.posix.resolve(...parts) });
  globalThis.fetch = () => { throw new Error('network disabled in private semantic child'); };
  globalThis.WebSocket = undefined;
  vm.runInThisContext(runtimeBytes.toString('utf8'), { filename: runtimeFile });
  go = new globalThis.Go();
  go.argv = [moduleFile, '-test.run=^TestWriteStudioExtremaGraphFixtures$', '-test.count=1', '-test.v', '-test.timeout=25s'];
  go.env = { GOMAXPROCS: '1', AURIALIS_STUDIO_EXTREMA_RATE: rateText, AURIALIS_STUDIO_EXTREMA_FIXTURES: virtualDirectory, TMPDIR: virtualDirectory };
  go.exit = (code) => { if (goExit !== null) throw new Error('duplicate Go exit'); goExit = code; };
  const instance = (await WebAssembly.instantiate(moduleBytes, go.importObject)).instance;
  await go.run(instance);
  const state = io.receipt();
  counterReceipt = counters.verify(manifest.nativeCounterReceipts?.[rateText], rate, state.bytes);
  if (!go.exited || goExit !== 0 || state.failure !== null || !state.everOpened || !state.closed || state.bytes < 1) throw new Error('semantic Go/closed output incomplete');
} catch (cause) {
  failure = String(cause?.message ?? cause).slice(0, 256);
} finally { fs.closeSync(sink); }
const receipt = { scope: 'actual GoJS fullgraph semantics only; no performance/RSS/public selection', buildId, label, rate, counterReceipt,
  manifestSHA256: hash(manifestBytes), moduleSHA256: hash(moduleBytes), runtimeSHA256: hash(runtimeBytes),
  sourceSetSHA256: entry.sourceSetSHA256, overlaySHA256: entry.overlaySHA256, recorderSHA256: manifest.recorderSHA256,
  goExit, goExited: go?.exited === true, failure, io: io.receipt(), outputSHA256: outputHash.digest('hex'),
};
const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
if (bytes.length > 128 * 1024) throw new Error('semantic child receipt cap exceeded');
finishChild({ code: failure === null ? 0 : 1, receipt,
  writeReceipt() {
    const fd = fs.openSync(path.join(directory, 'receipt.json'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { write(fd, bytes); } finally { fs.closeSync(fd); }
  },
  writeError: (text) => write(2, Buffer.from(text)), exit: (code) => process.exit(code),
});
