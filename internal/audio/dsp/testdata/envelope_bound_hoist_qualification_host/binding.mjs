// cspell:ignore gojs
// Metadata binding only. The old unit/recorder execution blocks stay literal.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function read(file, cap) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.size < 1 || before.size > cap) throw new Error('pre-read regular input cap refused');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size !== before.size || info.dev !== before.dev || info.ino !== before.ino || info.mode !== before.mode || info.ctimeMs !== before.ctimeMs) throw new Error('bounded binding input refused');
    const data = Buffer.alloc(info.size);
    for (let offset = 0; offset < data.length;) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (count < 1) throw new Error('binding input truncated');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('input changed during bounded read');
    return data;
  } finally { fs.closeSync(fd); }
}
export function hash(data) { return createHash('sha256').update(data).digest('hex'); }
export function write(fd, data) {
  for (let offset = 0; offset < data.length;) {
    const count = fs.writeSync(fd, data, offset, data.length - offset);
    if (count < 1) throw new Error('output short write');
    offset += count;
  }
  return data.length;
}
// One already-frozen source inspector lives outside the internal DSP prefix.
const artifact = Object.freeze({ file: 'artifacts/private-dsp/recovery-20261023/envelope-bound-hoist-proposal/source-v3/inspect-bound.py.source',
  sha256: 'd08bb53eaa21e60ede7afd953df277597bb20897d06c2acc0d8b4e14937011fb', bytes: 7143 });
export function admitInput(root, file, sha) {
  const exactArtifact = file === artifact.file;
  if (typeof file !== 'string' || typeof sha !== 'string' || file.split('/').includes('..') || path.isAbsolute(file) || (!file.startsWith('internal/audio/dsp/') && !exactArtifact) || (exactArtifact && sha !== artifact.sha256)) throw new Error('closed source path/hash refused');
  const data = read(path.join(root, file), exactArtifact ? artifact.bytes : 256 * 1024);
  if ((exactArtifact && data.length !== artifact.bytes) || hash(data) !== sha) throw new Error('current source input differs');
  return data;
}
export function bind(kind) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const [sourceId, jobId, sourceSHA] = process.argv.slice(2);
  if (process.argv.length !== 5 || !/^[a-z][a-z0-9-]{0,31}$/.test(sourceId ?? '') || !/^[a-z][a-z0-9-]{0,31}$/.test(jobId ?? '') || !/^[a-f0-9]{64}$/.test(sourceSHA ?? '') || process.version !== 'v26.12.0' || JSON.stringify(process.execArgv) !== JSON.stringify(['--stack-size=8192', '--max-old-space-size=192'])) throw new Error('closed candidate child argv refused');
  const proof = path.join(root, 'artifacts/private-dsp/recovery-20261023/envelope-bound-hoist-qualification', sourceId);
  const sourceBytes = read(path.join(proof, 'SOURCE.json'), 256 * 1024);
  const source = JSON.parse(sourceBytes.toString('utf8'));
  if (hash(sourceBytes) !== sourceSHA || source.schema !== 'bound-qualification-v1' || source.jobs?.length !== 46 || source.frozenFiles?.length !== 7 || Object.keys(source.modules ?? {}).sort().join(',') !== 'native,wasm') throw new Error('closed qualification source binding refused');
  for (const [file, sha] of Object.entries(source.runnerFiles)) {
    admitInput(root, file, sha);
    if (source.frozenFiles.includes(file) && hash(read(path.join(proof, 'source-frozen', path.basename(file)), 256 * 1024)) !== sha) throw new Error('frozen adapter input differs');
  }
  const matches = source.jobs.filter((job) => job.id === jobId && job.backend === 'wasm' && job.kind === kind);
  if (matches.length !== 1) throw new Error('exact existing WASM job refused');
  const job = matches[0];
  const name = job.name;
  const rate = job.rate;
  const rateText = String(rate);
  if (kind === 'unit') {
    const planBytes = read(path.join(root, 'internal/audio/dsp/testdata/envelope_node_visit_gates/PLAN.json'), 256 * 1024);
    if (hash(planBytes) !== '8f0ffd7726eb727ae0d6d5372a63f4a9f1de567ddfd3f2f6be23e1cb336f3790') throw new Error('immutable whole-unit plan changed');
    const plan = JSON.parse(planBytes.toString('utf8'));
    const tests = plan.tests.filter((test) => test.name === name);
    if (plan.testCount !== 18 || tests.length !== 1 || hash(read(path.join(root, tests[0].file), 256 * 1024)) !== tests[0].sourceSHA256) throw new Error('original test whitelist/source refused');
  } else if (kind !== 'recorder' || name !== 'TestWriteStudioExtremaGraphFixtures' || ![8000, 44100, 48000, 96000, 192000].includes(rate)) throw new Error('closed recorder job refused');
  const buildPin = source.modules.wasm;
  if (buildPin.BUILD_SHA256 !== '7283ac10b4bd323776e19d783ceb651407ed3ce49581e4e0c5ddb846f90ef3db') throw new Error('actual candidate BUILD identity refused');
  const manifestBytes = read(path.join(root, buildPin.BUILD), 256 * 1024);
  const candidate = JSON.parse(manifestBytes.toString('utf8'));
  const entry = candidate.module;
  if (hash(manifestBytes) !== buildPin.BUILD_SHA256 || JSON.stringify(entry) !== JSON.stringify(buildPin.module) || entry.sha256 !== 'e9b1ebc5dd66ee0ce6c8179549286691792b7f97b6f21cc71d9362835732096e') throw new Error('candidate module BUILD differs');
  const moduleFile = entry.file;
  const runtimeFile = source.runtime?.path;
  const moduleBytes = read(moduleFile, 16 * 1024 * 1024);
  const runtimeBytes = read(runtimeFile, 256 * 1024);
  if (moduleBytes.length !== entry.bytes || hash(moduleBytes) !== entry.sha256 || hash(runtimeBytes) !== source.runtime.sha256 || source.runtime.sha256 !== '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14' || !moduleBytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('exact module/runtime bytes refused');
  const counterBytes = read(path.join(root, source.counterBUILD.BUILD), 256 * 1024);
  // This is the actual unchanged original BUILD used only for its frozen counters.
  if (hash(counterBytes) !== '16aacd5935e4bee8c9e253d926f9fe2d5dfbc2179f68b62b5b7e3d1195fde6f8' || hash(counterBytes) !== source.counterBUILD.sha256) throw new Error('original counter BUILD differs');
  const manifest = JSON.parse(counterBytes.toString('utf8'));
  if (JSON.stringify(manifest.nativeCounterReceipts) !== JSON.stringify(source.nativeCounterReceipts)) throw new Error('frozen recorder counters differ');
  const directory = path.join(proof, 'runs', jobId);
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('exclusive child directory refused');
  return { sourceId, jobId, name, rate, rateText, sourceBytes, source, manifestBytes, manifest, entry, moduleFile, moduleBytes, runtimeFile, runtimeBytes, directory };
}
