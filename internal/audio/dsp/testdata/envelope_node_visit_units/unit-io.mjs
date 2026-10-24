// Host-only log adapter. The frozen closed filesystem helper is unchanged.
import { createFixtureFS } from '../extrema_graph/closed-fs.mjs';

export function createUnitIO(constants, onLog) {
  const io = createFixtureFS({ rate: 8000, constants,
    onData() { throw new Error('unit PCM forbidden'); }, onLog,
  });
  let openAttempts = 0;
  const closed = Object.freeze({ ...io.fs,
    open(_path, _flags, _mode, callback) {
      openAttempts += 1;
      if (typeof callback !== 'function') throw new Error('unit open callback refused');
      queueMicrotask(() => callback(Object.assign(new Error('unit file open forbidden'), { code: 'EACCES' })));
    },
  });
  return Object.freeze({ fs: closed, receipt: () => ({ ...io.receipt(), openAttempts }) });
}

export function verifyUnitIO(state) {
  if (state.failure !== null || state.openAttempts !== 0 || state.everOpened || state.opened || state.closed || state.bytes !== 0 || state.logBytes < 1 || state.logBytes > 256 * 1024 || state.requests.some((item) => !['write', 'writeSync', 'fstat'].includes(item.operation) || ![0, 1, 2].includes(item.fd) || item.result !== 'ok')) throw new Error('unit log-only I/O incomplete');
}
