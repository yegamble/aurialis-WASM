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
if (process.argv.length !== 7 || !/^[a-z][a-z0-9-]{0,31}$/.test(buildId ?? '') || !['baseline', 'candidate'].includes(label) || !['verify', 'measure'].includes(phase) || !['steady', 'peaky'].includes(workload) || !['gate', 'before', 'candidate', 'after'].includes(leg) || process.version !== 'v26.12.0') {
  throw new Error('closed private screening child refused');
}
if ((phase === 'measure' && !(label === 'baseline' ? ['before', 'after'].includes(leg) : leg === 'candidate')) || (phase !== 'measure' && leg !== 'gate')) throw new Error('closed phase/leg refused');
const proof = path.join(root, 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-screen-host', buildId);
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
const manifestBytes = read(path.join(proof, 'BINDING.json'), 128 * 1024);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifest.schema !== 'same-module-screen-binding-v1' || Object.keys(manifest.runnerFiles ?? {}).length !== 37) throw new Error('closed same-module binding inventory refused');
const baseFile = path.join(root, 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-graph/node-visit-build-v1/BUILD.json');
const baseBytes = read(baseFile, 256 * 1024);
if (manifest.baseBUILD?.file !== baseFile || manifest.baseBUILD?.sha256 !== '16aacd5935e4bee8c9e253d926f9fe2d5dfbc2179f68b62b5b7e3d1195fde6f8' || hash(baseBytes) !== manifest.baseBUILD.sha256) throw new Error('existing module BUILD binding changed');
const base = JSON.parse(baseBytes.toString('utf8'));
if (JSON.stringify(manifest.modules) !== JSON.stringify(base.modules?.wasm) || JSON.stringify(manifest.runtime) !== JSON.stringify(base.runtime)) throw new Error('existing module/runtime entries changed');
for (const [key, relative, sha] of [
  ['originalUnits', 'envelope-node-visit-units/source-v6/UNITS-SHA256.json', '9d6e75edbc100155ff3e7d9f037054a7ee60bb7b199db6a4888cb83b06497c51'],
  ['semantic', 'envelope-node-visit-graph/node-visit-build-v1/SEMANTIC-SHA256.json', '07ccfacdf5247933321e823044660461ea2fb7667a545018851e7a0642a1b2f4'],
  ['historicalV5RED', 'envelope-node-visit-units/source-v5/UNIT-ATTEMPT-RED-SHA256.json', '94440d692e5e1740d4637e83b4f29d53416ee3f6dc58af80c60fb9c982de1c46'],
]) {
  const file = path.join(root, 'artifacts/private-dsp/recovery-20261023', relative);
  if (manifest.evidence?.[key]?.file !== file || manifest.evidence[key].sha256 !== sha || hash(read(file, 256 * 1024)) !== sha) throw new Error('sealed prerequisite binding changed');
}
if (phase === 'measure') {
  const gate = JSON.parse(read(path.join(proof, `QUALIFIED-${workload}.json`), 64 * 1024).toString('utf8'));
  if (gate.bindingSHA256 !== hash(manifestBytes) || gate.workload !== workload || !/^[0-9a-f]{64}$/.test(gate.verificationSHA256 ?? '')) throw new Error('untimed qualification missing');
}
for (const [name, sha] of Object.entries(manifest.runnerFiles ?? {})) {
  if (!name.startsWith('internal/audio/dsp/') || name.split('/').includes('..') || hash(read(path.join(root, name), 64 * 1024)) !== sha || hash(read(path.join(proof, 'source-frozen', name.endsWith('.go') ? `${name}.source` : name), 64 * 1024)) !== sha) throw new Error('private runner hash refused');
}
const entry = manifest.modules?.[label];
const moduleFile = path.join(root, 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-graph/node-visit-build-v1/modules', `wasm-${label}.wasm`);
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
  const test = 'TestWriteStudioExtremaScreen';
  go.argv = [moduleFile, `-test.run=^${test}$`, '-test.count=1', '-test.v', '-test.timeout=25s'];
  go.env = { GOMAXPROCS: '1', TMPDIR: virtualDirectory,
    AURIALIS_STUDIO_SCREEN_OUTPUT: virtualDirectory, AURIALIS_STUDIO_SCREEN_RATE: '192000', AURIALIS_STUDIO_SCREEN_PHASE: phase, AURIALIS_STUDIO_SCREEN_WORKLOAD: workload,
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
  bindingSHA256: hash(manifestBytes), baseBUILD_SHA256: manifest.baseBUILD.sha256, moduleSHA256: hash(moduleBytes), runtimeSHA256: hash(runtimeBytes),
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
