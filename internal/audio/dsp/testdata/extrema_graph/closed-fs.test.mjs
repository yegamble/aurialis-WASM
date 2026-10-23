import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import test from 'node:test';
import { createFixtureFS, limits, virtualDirectory } from './closed-fs.mjs';

function fixture() {
  const data = [];
  const logs = [];
  const io = createFixtureFS({ rate: 48000, constants, onData: (b) => { data.push(Buffer.from(b)); return b.length; }, onLog: (fd, b) => { logs.push([fd, Buffer.from(b)]); return b.length; } });
  return { ...io, data, logs };
}
function call(fs, op, ...args) {
  return new Promise((resolve, reject) => fs[op](...args, (cause, value) => cause ? reject(cause) : resolve(value)));
}
const file = `${virtualDirectory}/rate48000.bin`;
const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
const open = (fs) => call(fs, 'open', file, flags, 0o600);
const write = (fs, fd, b) => call(fs, 'write', fd, b, 0, b.length, null);

test('closed virtual root supports the pinned Go shim expected Stat/Lstat/Open/Fstat/Write/Close order', async () => {
  const io = fixture();
  assert.equal((await call(io.fs, 'stat', virtualDirectory)).isDirectory(), true);
  await assert.rejects(call(io.fs, 'lstat', file), { code: 'ENOENT' });
  assert.equal(await open(io.fs), 3);
  assert.equal((await call(io.fs, 'fstat', 3)).isDirectory(), false);
  assert.equal(await write(io.fs, 3, new Uint8Array([0, 128, 255])), 3);
  await call(io.fs, 'close', 3);
  assert.deepEqual([...io.data[0]], [0, 128, 255]);
  assert.equal(io.receipt().bytes, 3);
  assert.equal(io.receipt().failure, null);
  assert.equal(io.receipt().closed, true);
});
test('callbacks are asynchronous before returning control to the caller', async () => {
  const io = fixture();
  let called = false;
  const result = new Promise((resolve) => io.fs.stat(virtualDirectory, (cause) => { assert.equal(cause, null); called = true; resolve(); }));
  assert.equal(called, false);
  await result;
  assert.equal(called, true);
});
test('only exact rate path, flags and0600 mode admit any output', async () => {
  for (const [path, f, mode] of [[file + '/..', flags, 0o600], [file.replace('48000', '8000'), flags, 0o600], [file, flags | constants.O_TRUNC, 0o600], [file, flags, 0o644], ['../rate48000.bin', flags, 0o600]]) {
    const io = fixture();
    await assert.rejects(call(io.fs, 'open', path, f, mode), { code: 'EACCES' });
    assert.equal(io.data.length, 0);
  }
});
test('exclusive single open never reopens even after close', async () => {
  const io = fixture();
  await open(io.fs);
  await assert.rejects(open(io.fs), { code: 'EEXIST' });
  await call(io.fs, 'close', 3);
  await assert.rejects(open(io.fs), { code: 'EEXIST' });
});
test('descriptor and offset/position/length admissions reject before copying', async () => {
  for (const args of [[4, new Uint8Array(1), 0, 1, null], [3, new Uint8Array(1), 1, 0, null], [3, new Uint8Array(1), 0, 1, 0], [3, new Uint8Array(1), 0, -1, null], [3, new Uint8Array(1), 0, 2, null], [3, new Uint8Array(limits.writeBytes + 1), 0, limits.writeBytes + 1, null]]) {
    const io = fixture();
    await open(io.fs);
    await assert.rejects(call(io.fs, 'write', ...args));
    assert.equal(io.data.length, 0);
  }
});
test('8MiB output cap is reserved before host sink; extra byte never reaches sink', async () => {
  let written = 0;
  const io = createFixtureFS({ rate: 48000, constants, onData: (b) => { written += b.length; return b.length; }, onLog: () => 0 });
  await open(io.fs);
  const block = new Uint8Array(limits.writeBytes);
  for (let i = 0; i < limits.outputBytes / block.length; i++) await write(io.fs, 3, block);
  await assert.rejects(write(io.fs, 3, new Uint8Array(1)), { code: 'EFBIG' });
  assert.equal(written, limits.outputBytes);
  assert.equal(io.receipt().bytes, limits.outputBytes);
});
test('stdout/stderr share256KiB cap and support runtime writeSync diagnostics', () => {
  let logged = 0;
  const io = createFixtureFS({ rate: 8000, constants, onData: () => 0, onLog: (_fd, b) => { logged += b.length; return b.length; } });
  const block = new Uint8Array(limits.writeBytes);
  for (let i = 0; i < 4; i++) io.fs.writeSync(i % 2 + 1, block);
  assert.throws(() => io.fs.writeSync(2, new Uint8Array(1)), { code: 'EFBIG' });
  assert.equal(logged, limits.logBytes);
});
test('operation and receipt bounds hold on empty writes; denied methods grant no FS', async () => {
  const io = fixture();
  await open(io.fs);
  for (let i = 1; i < limits.requests; i++) await write(io.fs, 3, new Uint8Array());
  await assert.rejects(write(io.fs, 3, new Uint8Array()), { code: 'E2BIG' });
  assert.equal(io.receipt().requests.length, limits.requests);
  assert.ok(Buffer.byteLength(JSON.stringify(io.receipt())) <= limits.receiptBytes);
  const denied = fixture();
  await assert.rejects(call(denied.fs, 'unlink', file), { code: 'EACCES' });
  await assert.rejects(call(denied.fs, 'stat', '/etc/passwd'), { code: 'EACCES' });
  assert.equal(denied.data.length, 0);
});
test('write after close and short host sink are explicit failures', async () => {
  const io = fixture();
  await open(io.fs);
  await call(io.fs, 'close', 3);
  await assert.rejects(write(io.fs, 3, new Uint8Array(1)), { code: 'EBADF' });
  const short = createFixtureFS({ rate: 48000, constants, onData: () => 0, onLog: () => 0 });
  await open(short.fs);
  await assert.rejects(write(short.fs, 3, new Uint8Array(1)), { code: 'EIO' });
  assert.equal(short.receipt().failure, 'EIO');
});
test('invalid rate and oversized diagnostic paths cannot increase bounded receipt', async () => {
  assert.throws(() => createFixtureFS({ rate: 1, constants, onData: () => 0, onLog: () => 0 }));
  const io = fixture();
  await assert.rejects(call(io.fs, 'stat', 'x'.repeat(65536)), { code: 'EACCES' });
  assert.ok(Buffer.byteLength(JSON.stringify(io.receipt())) < 1024);
});
