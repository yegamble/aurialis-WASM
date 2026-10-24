"""Bounded STATIC-server identity evidence only; never grants group authority."""
import ctypes
import hashlib
import os
import selectors
import stat
import subprocess
import sys
import time
from owned_groups import same, snapshot

COMMAND_CAP = 16384
PATH_CAP = 4096
RECORD_CAP = 196608
FILE_CAP = 64 * 1024 ** 2


class RawCommandFailure(RuntimeError):
    def __init__(self, message, raw, truncated=False, primary=None, cleanup=()):
        super().__init__(message)
        self.raw = bytes(raw[:COMMAND_CAP])
        self.truncated = truncated
        self.primary = None if primary is None else {'type': type(primary).__name__, 'message': str(primary)[:1024]}
        self.cleanup = tuple(cleanup)


class ExecutableFileFailure(RuntimeError):
    def __init__(self, primary, cleanup):
        message = 'Executable cleanup unconfirmed' if primary is None else str(primary)
        super().__init__(message + '; close: ' + str(cleanup))
        self.primary = None if primary is None else {'type': type(primary).__name__, 'message': str(primary)[:1024]}
        self.cleanup = {'phase': 'executable-close', 'type': type(cleanup).__name__, 'message': str(cleanup)[:1024]}


def bounded_ps(pid):
    """Collect at most16KiB from the exact short-lived ps helper, then reap it."""
    if not isinstance(pid, int) or isinstance(pid, bool) or not 1 < pid < 2 ** 31:
        raise RuntimeError('Invalid observed PID')
    child = None
    output = bytearray()
    selector = selectors.DefaultSelector()
    until = time.monotonic() + 3
    primary = None
    cleanup = []
    try:
        child = subprocess.Popen(['/bin/ps', '-p', str(pid), '-o', 'command='], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
        selector.register(child.stdout, selectors.EVENT_READ)
        while True:
            remaining = until - time.monotonic()
            if remaining <= 0:
                raise RawCommandFailure('Raw ps command deadline', output)
            if not selector.select(remaining):
                raise RawCommandFailure('Raw ps command deadline', output)
            chunk = os.read(child.stdout.fileno(), min(4096, COMMAND_CAP + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > COMMAND_CAP:
                raise RawCommandFailure('Raw ps command exceeds16KiB', output, True)
        if child.wait(timeout=max(.01, until - time.monotonic())) != 0:
            raise RawCommandFailure('Raw ps command failed', output)
    except BaseException as error:
        primary = error
    finally:
        try:
            selector.close()
        except BaseException as error:
            cleanup.append({'phase': 'selector-close', 'type': type(error).__name__, 'message': str(error)[:1024]})
        if child is not None:
            try:
                if child.poll() is None:
                    child.kill()
            except BaseException as error:
                cleanup.append({'phase': 'direct-ps-kill', 'type': type(error).__name__, 'message': str(error)[:1024]})
            try:
                child.wait(timeout=1)
            except BaseException as error:
                cleanup.append({'phase': 'direct-ps-reap', 'type': type(error).__name__, 'message': str(error)[:1024]})
            try:
                if child.stdout is not None:
                    child.stdout.close()
            except BaseException as error:
                cleanup.append({'phase': 'ps-pipe-close', 'type': type(error).__name__, 'message': str(error)[:1024]})
    if primary is not None or cleanup:
        raise RawCommandFailure(str(primary) if primary is not None else 'Raw ps cleanup unconfirmed', output, len(output) > COMMAND_CAP, primary, cleanup) from primary
    return bytes(output)


def decode_pidpath(raw, reported):
    if not isinstance(raw, bytes) or len(raw) != PATH_CAP or not isinstance(reported, int) or not 0 < reported < PATH_CAP:
        raise RuntimeError('Darwin executable path unavailable/truncated')
    if raw[reported] != 0 or b'\0' in raw[:reported]:
        raise RuntimeError('Darwin executable path termination changed')
    value = raw[:reported].decode('utf8', errors='strict')
    if not value.startswith('/'):
        raise RuntimeError('Darwin executable path is not absolute')
    return value


def darwin_pidpath(pid):
    # Published ABI only, no Apple implementation body is copied. Calls happen
    # only in a separately released runtime diagnostic, never at module import.
    if sys.platform != 'darwin':
        raise RuntimeError('Darwin identity API unavailable on this platform')
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    function = library.proc_pidpath
    function.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    function.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(PATH_CAP)
    result = function(pid, buffer, PATH_CAP)
    if result <= 0:
        raise OSError(ctypes.get_errno(), 'proc_pidpath failed')
    return decode_pidpath(buffer.raw, result)


def executable_file(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    result, primary, cleanup = None, None, None
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= FILE_CAP:
            raise RuntimeError('Observed executable file bound/type refused')
        digest = hashlib.sha256()
        count = 0
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            count += len(chunk)
            if count > FILE_CAP:
                raise RuntimeError('Observed executable grew beyond bound')
            digest.update(chunk)
        after = os.fstat(descriptor)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if count != before.st_size or identity(before) != identity(after):
            raise RuntimeError('Observed executable changed during hashing')
        result = {'path': path, 'bytes': count, 'sha256': digest.hexdigest(), 'device': before.st_dev, 'inode': before.st_ino}
    except BaseException as error:
        primary = error
    finally:
        try:
            os.close(descriptor)
        except BaseException as error:
            cleanup = error
    if cleanup is not None:
        raise ExecutableFileFailure(primary, cleanup) from primary
    if primary is not None:
        raise primary
    return result


def identity_row(rows, expected):
    current = rows.get(expected['pid'])
    if current is None or not same(current, expected) or current['ppid'] != expected['ppid'] or 'Z' in current['state']:
        raise RuntimeError('STATIC process identity changed during command evidence')
    return dict(current)


def static_identity(expected, pin, persist, *, rows=snapshot, command=bounded_ps, kernel_path=darwin_pidpath, file_record=executable_file):
    """Persist exact bounded evidence BEFORE caller applies unchanged argv rules."""
    record = {'kind': 'static-command-before-parse', 'pid': expected['pid'], 'expectedIdentity': dict(expected), 'expectedExecutable': {key: pin[key] for key in ('path', 'bytes', 'sha256')}, 'before': None, 'after': None, 'rawCommandText': None, 'rawCommandHex': None, 'rawCommandBytes': 0, 'rawCommandSHA256': None, 'rawCommandComplete': None, 'rawCommandTruncated': False, 'commandPrimary': None, 'commandCleanup': [], 'filePrimary': None, 'fileCleanup': [], 'kernelExecutable': None, 'kernelPathMatchesExpected': None, 'kernelHashMatchesExpected': None, 'error': None, 'errors': [], 'authority': 'Diagnostic only; does not replace strict executable-prefix/source-argv or OwnedGroups authority'}
    failure = None
    text = None
    try:
        before_rows = rows()
        record['before'] = None if expected['pid'] not in before_rows else dict(before_rows[expected['pid']])
        identity_row(before_rows, expected)
        raw = command(expected['pid'])
        if not isinstance(raw, bytes) or not 0 < len(raw) <= COMMAND_CAP:
            raise RuntimeError('Raw ps command geometry/cap changed')
        record['rawCommandBytes'] = len(raw)
        record['rawCommandComplete'] = True
        record['rawCommandSHA256'] = hashlib.sha256(raw).hexdigest()
        try:
            text = raw.decode('utf8', errors='strict')
            record['rawCommandText'] = text
        except UnicodeDecodeError:
            record['rawCommandHex'] = raw.hex()
            raise RuntimeError('Raw ps command is not strict UTF8') from None
        path = kernel_path(expected['pid'])
        if not isinstance(path, str) or len(path.encode('utf8')) >= PATH_CAP or not path.startswith('/'):
            raise RuntimeError('Kernel executable path geometry changed')
        record['kernelExecutable'] = file_record(path)
        record['kernelPathMatchesExpected'] = path == pin['path']
        record['kernelHashMatchesExpected'] = record['kernelExecutable']['bytes'] == pin['bytes'] and record['kernelExecutable']['sha256'] == pin['sha256']
    except Exception as error:
        if isinstance(error, RawCommandFailure):
            record['commandPrimary'] = error.primary
            record['commandCleanup'] = list(error.cleanup)
            record['rawCommandBytes'] = len(error.raw)
            record['rawCommandComplete'] = False
            record['rawCommandTruncated'] = error.truncated
            record['rawCommandSHA256'] = hashlib.sha256(error.raw).hexdigest()
            try:
                record['rawCommandText'] = error.raw.decode('utf8', errors='strict')
            except UnicodeDecodeError:
                record['rawCommandHex'] = error.raw.hex()
        if isinstance(error, ExecutableFileFailure):
            record['filePrimary'] = error.primary
            record['fileCleanup'] = [error.cleanup]
        record['error'] = error.primary if isinstance(error, ExecutableFileFailure) and error.primary is not None else {'type': type(error).__name__, 'message': str(error)[:1024]}
        record['errors'].append(record['error'])
        failure = error
    finally:
        try:
            after_rows = rows()
            record['after'] = None if expected['pid'] not in after_rows else dict(after_rows[expected['pid']])
            identity_row(after_rows, expected)
        except Exception as error:
            observed_error = {'type': type(error).__name__, 'message': str(error)[:1024]}
            record['errors'].append(observed_error)
            if failure is None:
                record['error'] = observed_error
                failure = error
        # The caller owns exclusive bounded persistence. Failure to persist
        # refuses parsing/ACK; missing evidence cannot become an identity pass.
        try:
            persist(record)
        except Exception as persistence:
            if failure is not None:
                raise RuntimeError('Identity persistence failed: ' + str(persistence)[:512] + '; original primary ' + type(failure).__name__ + ': ' + str(failure)[:512]) from failure
            raise
    if failure is not None:
        raise failure
    return text.strip()
