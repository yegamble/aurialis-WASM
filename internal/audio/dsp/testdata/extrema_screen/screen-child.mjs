// cspell:ignore GOMAXPROCS testdata untimed
// Private trusted-module worker; no public graph selection or sandbox claim.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createFixtureFS, virtualDirectory } from '../extrema_graph/closed-fs.mjs';
import { finishChild } from '../extrema_graph/child-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const [buildId, label, phase, workload, leg] = process.argv.slice(2);
if (process.argv.length !== 7 || !/^[a-z][a-z0-9-]{0,31}$/.test(buildId ?? '') || !['baseline', 'candidate'].includes(label) || !['fixture', 'verify', 'measure'].includes(phase) || !['steady', 'peaky'].includes(workload) || !['gate', 'before', 'candidate', 'after'].includes(leg) || process.version !== 'v26.12.0') {
  throw new Error('closed private screening child refused');
}
if ((phase === 'measure' && !(label === 'baseline' ? ['before', 'after'].includes(leg) : leg === 'candidate')) || (phase !== 'measure' && leg !== 'gate')) throw new Error('closed phase/leg refused');
const proof = path.join(root, 'artifacts/private-dsp/recovery-20261023/extrema-paired-screen', buildId);
function read(file, cap) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > cap) throw new Error('bounded source input refused');
    const data = Buffer.alloc(info.size);
    for (let offset = 0; offset < data.length;) {
      const n = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (n < 1) throw new Error('private input truncated');
      offset += n;
    }
    return data;
  } finally { fs.closeSync(fd); }
}
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function write(fd, data) {
  for (let offset = 0; offset < data.length;) {
    const n = fs.writeSync(fd, data, offset, data.length - offset);
    if (n < 1) throw new Error('private sink truncated');
    offset += n;
  }
  return data.length;
}
const manifestBytes = read(path.join(proof, 'BUILD.json'), 128 * 1024);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const requiredRunner = ['producer.py', 'run-screen.py', 'screen-child.mjs', 'screen-contract.test.py', 'README.md'].map((name) => `internal/audio/dsp/testdata/extrema_screen/${name}`).concat(['closed-fs.mjs', 'child-lifecycle.mjs', 'run-wasm-pair.py'].map((name) => `internal/audio/dsp/testdata/extrema_graph/${name}`), ['internal/audio/dsp/studio_extrema_screen_test.go']);
if (JSON.stringify(Object.keys(manifest.runnerFiles ?? {}).sort()) !== JSON.stringify(requiredRunner.sort())) throw new Error('closed runner inventory refused');
if (phase === 'measure') {
  const gate = JSON.parse(read(path.join(proof, `QUALIFIED-${workload}.json`), 64 * 1024).toString('utf8'));
  if (gate.manifestSHA256 !== hash(manifestBytes) || gate.workload !== workload || !/^[0-9a-f]{64}$/.test(gate.verificationSHA256 ?? '')) throw new Error('untimed qualification missing');
}
for (const [name, sha] of Object.entries(manifest.runnerFiles ?? {})) {
  if (!name.startsWith('internal/audio/dsp/') || name.split('/').includes('..') || hash(read(path.join(root, name), 64 * 1024)) !== sha) throw new Error('private runner hash refused');
}
const entry = manifest.modules?.[label];
const moduleFile = path.join(proof, 'modules', `${label}.wasm`);
const runtimeFile = manifest.runtime?.path;
if (entry?.file !== moduleFile || typeof runtimeFile !== 'string' || path.basename(runtimeFile) !== 'wasm_exec.js') throw new Error('module/runtime admission refused');
const moduleBytes = read(moduleFile, 16 * 1024 * 1024);
const runtimeBytes = read(runtimeFile, 256 * 1024);
if (hash(moduleBytes) !== entry.sha256 || hash(runtimeBytes) !== manifest.runtime.sha256 || !moduleBytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('frozen module/runtime changed');
const directory = path.join(proof, 'runs', `${phase}-${workload}-${leg}-${label}`);
if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('fresh output directory refused');
const sink = fs.openSync(path.join(directory, 'rate192000.bin'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
const outputHash = createHash('sha256');
const io = createFixtureFS({ rate: 192000, constants: fs.constants,
  onData(buffer) { const n = write(sink, buffer); outputHash.update(buffer); return n; },
  onLog(fd, buffer) { return write(fd, buffer); },
});
let go;
let goExit = null;
let failure = null;
try {
  globalThis.fs = io.fs;
  globalThis.path = Object.freeze({ resolve: (...parts) => path.posix.resolve(...parts) });
  globalThis.fetch = () => { throw new Error('network disabled in private screen'); };
  globalThis.WebSocket = undefined;
  vm.runInThisContext(runtimeBytes.toString('utf8'), { filename: runtimeFile });
  go = new globalThis.Go();
  const test = phase === 'fixture' ? 'TestWriteStudioExtremaGraphFixtures' : 'TestWriteStudioExtremaScreen';
  go.argv = [moduleFile, `-test.run=^${test}$`, '-test.count=1', '-test.v', '-test.timeout=25s'];
  go.env = { GOMAXPROCS: '1', TMPDIR: virtualDirectory,
    ...(phase === 'fixture' ? { AURIALIS_STUDIO_EXTREMA_RATE: '192000', AURIALIS_STUDIO_EXTREMA_FIXTURES: virtualDirectory } : { AURIALIS_STUDIO_SCREEN_OUTPUT: virtualDirectory, AURIALIS_STUDIO_SCREEN_RATE: '192000', AURIALIS_STUDIO_SCREEN_PHASE: phase, AURIALIS_STUDIO_SCREEN_WORKLOAD: workload }),
  };
  go.exit = (code) => { if (goExit !== null) throw new Error('duplicate Go exit'); goExit = code; };
  const instance = (await WebAssembly.instantiate(moduleBytes, go.importObject)).instance;
  await go.run(instance);
  const state = io.receipt();
  if (!go.exited || goExit !== 0 || state.failure !== null || !state.everOpened || !state.closed || state.bytes < 1) throw new Error('private Go/closed output incomplete');
} catch (cause) {
  failure = String(cause?.message ?? cause).slice(0, 256);
} finally { fs.closeSync(sink); }
const receipt = { scope: 'private fixed-count screening child; no realtime/RSS guarantee', buildId, label, phase, workload, leg,
  manifestSHA256: hash(manifestBytes), moduleSHA256: hash(moduleBytes), runtimeSHA256: hash(runtimeBytes),
  sourceSetSHA256: entry.sourceSetSHA256, overlaySHA256: entry.overlaySHA256,
  goExit, goExited: go?.exited === true, failure, io: io.receipt(), outputSHA256: outputHash.digest('hex'),
};
const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
if (bytes.length > 128 * 1024) throw new Error('private child receipt cap exceeded');
finishChild({ code: failure === null ? 0 : 1, receipt,
  writeReceipt() {
    const fd = fs.openSync(path.join(directory, 'receipt.json'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { write(fd, bytes); } finally { fs.closeSync(fd); }
  },
  writeError: (text) => write(2, Buffer.from(text)), exit: (code) => process.exit(code),
});
