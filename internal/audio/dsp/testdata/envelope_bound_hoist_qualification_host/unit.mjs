// cspell:ignore GOMAXPROCS AURIALIS
// SOURCE ONLY candidate binding; unchanged original execution/post-exit blocks.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { hash, write, bind } from './binding.mjs';
import { finishChild } from '../extrema_graph/child-lifecycle.mjs';
import { virtualDirectory } from '../extrema_graph/closed-fs.mjs';
import { createUnitIO, verifyUnitIO } from '../envelope_node_visit_units/unit-io.mjs';
const { sourceId, jobId, name, rate, rateText, sourceBytes, source, manifestBytes, manifest, entry, moduleFile, moduleBytes, runtimeFile, runtimeBytes, directory } = bind('unit');
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
const receipt = { schema: 'bound-qualification-v1', sourceId, jobId, name, nodeVersion: process.version,
  sourceSHA256: hash(sourceBytes), manifestSHA256: hash(manifestBytes), moduleSHA256: hash(moduleBytes), runtimeSHA256: hash(runtimeBytes),
  sourceSetSHA256: entry.sourceSetSHA256, overlaySHA256: entry.overlaySHA256,
  nodeArgv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], goArgv: go?.argv ?? null,
  goExit, goExited: go?.exited === true, failure, io: io.receipt(),
  counterReceipt: null, outputSHA256: null, counterBUILD_SHA256: null,
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
