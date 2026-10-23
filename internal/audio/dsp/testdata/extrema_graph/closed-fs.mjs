// Private qualification I/O only. This is not a sandbox for untrusted Go code.
export const limits = Object.freeze({
  outputBytes: 8 * 1024 * 1024,
  logBytes: 256 * 1024,
  writeBytes: 64 * 1024,
  requests: 256,
  receiptBytes: 64 * 1024,
});
export const virtualDirectory = '/aurialis-private-fixture';
export const rates = Object.freeze([8000, 44100, 48000, 96000, 192000]);

function error(code) {
  return Object.assign(new Error(`private fixture I/O ${code}`), { code });
}
function safe(value) {
  if (typeof value === 'string') return value.length <= 64 ? value : `${value.slice(0, 61)}...`;
  return Number.isSafeInteger(value) ? value : typeof value;
}
function stat(directory, size = 0) {
  return Object.freeze({
    dev: 1, ino: directory ? 1 : 2, mode: directory ? 0o40700 : 0o100600,
    nlink: 1, uid: 0, gid: 0, rdev: 0, size, blksize: 65536, blocks: 0,
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  });
}

export function createFixtureFS({ rate, constants, onData, onLog }) {
  if (!rates.includes(rate) || typeof onData !== 'function' || typeof onLog !== 'function') {
    throw error('EINVAL');
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const file = `${virtualDirectory}/rate${rate}.bin`;
  let opened = false;
  let everOpened = false;
  let closed = false;
  let bytes = 0;
  let logBytes = 0;
  let firstFailure = null;
  const requests = [];
  function fail(code) {
    firstFailure ??= code;
    throw error(code);
  }
  function request(operation, detail, fn) {
    if (requests.length >= limits.requests) return fail('E2BIG');
    const entry = { operation, ...Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, safe(value)])) };
    requests.push(entry);
    try {
      const result = fn();
      entry.result = 'ok';
      return result;
    } catch (cause) {
      entry.result = cause.code ?? 'EIO';
      if (entry.result !== 'ENOENT') firstFailure ??= entry.result;
      throw cause;
    }
  }
  function callback(operation, detail, cb, fn) {
    if (typeof cb !== 'function') return fail('EINVAL');
    let cause = null;
    let result;
    try { result = request(operation, detail, fn); } catch (caught) { cause = caught; }
    queueMicrotask(() => cb(cause, result));
  }
  function info(path) {
    if (path === virtualDirectory) return stat(true);
    if (path === file) {
      if (!everOpened) throw error('ENOENT');
      return stat(false, bytes);
    }
    return fail('EACCES');
  }
  function write(fd, buffer, offset, length, position) {
    if (!(buffer instanceof Uint8Array) || offset !== 0 || length !== buffer.byteLength || position !== null || !Number.isSafeInteger(length) || length > limits.writeBytes) {
      return fail('EINVAL');
    }
    if (fd === 1 || fd === 2) {
      if (length > limits.logBytes - logBytes) return fail('EFBIG');
      logBytes += length; // Reserve BEFORE invoking the bounded host sink.
      if (onLog(fd, buffer) !== length) return fail('EIO');
    } else if (fd === 3 && opened && !closed) {
      if (length > limits.outputBytes - bytes) return fail('EFBIG');
      bytes += length; // Reserve BEFORE invoking the bounded host sink.
      if (onData(buffer) !== length) return fail('EIO');
    } else {
      return fail('EBADF');
    }
    return length;
  }
  const fs = Object.assign(Object.create(null), {
    constants: Object.freeze({ ...constants }),
    open(path, requestedFlags, mode, cb) {
      callback('open', { path, flags: requestedFlags, mode }, cb, () => {
        if (path !== file || requestedFlags !== flags || mode !== 0o600) return fail('EACCES');
        if (everOpened) return fail('EEXIST');
        opened = true;
        everOpened = true;
        return 3;
      });
    },
    stat(path, cb) { callback('stat', { path }, cb, () => info(path)); },
    lstat(path, cb) { callback('lstat', { path }, cb, () => info(path)); },
    fstat(fd, cb) {
      callback('fstat', { fd }, cb, () => {
        if (fd === 3 && opened && !closed) return stat(false, bytes);
        if (fd === 0 || fd === 1 || fd === 2) return { ...stat(false), mode: 0o20600 };
        return fail('EBADF');
      });
    },
    close(fd, cb) {
      callback('close', { fd }, cb, () => {
        if (fd !== 3 || !opened || closed) return fail('EBADF');
        closed = true;
        opened = false;
      });
    },
    write(fd, buffer, offset, length, position, cb) {
      callback('write', { fd, offset, length, position: position === null ? 'null' : position }, cb, () => write(fd, buffer, offset, length, position));
    },
    writeSync(fd, buffer) {
      return request('writeSync', { fd, length: buffer?.byteLength }, () => write(fd, buffer, 0, buffer?.byteLength, null));
    },
  });
  for (const operation of ['read', 'readdir', 'readlink', 'chmod', 'chown', 'fchmod', 'fchown', 'fsync', 'ftruncate', 'lchown', 'link', 'mkdir', 'rename', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes']) {
    fs[operation] = (...args) => callback(operation, {}, args.at(-1), () => fail('EACCES'));
  }
  return Object.freeze({
    fs: Object.freeze(fs),
    receipt() {
      const value = { file, flags, mode: 0o600, bytes, logBytes, opened, everOpened, closed, failure: firstFailure, requests: requests.map((entry) => ({ ...entry })) };
      if (Buffer.byteLength(JSON.stringify(value)) > limits.receiptBytes) throw error('E2BIG');
      return value;
    },
  });
}
