"""Reviewed v6 native guard; only explicit25/28-second deadline parameterization."""
# cspell:ignore GOMAXPROCS killpg pidinfo taskinfo ctypes libproc argtypes restype PIDTASKINFO fstat ESRCH waitpid
import ctypes
import errno
import importlib.util
import os
import pathlib
import selectors
import subprocess
import sys
import time

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[5]
SPEC = importlib.util.spec_from_file_location('bound_guard_graph', pathlib.Path(__file__).resolve().parent.with_name('envelope_node_visit_graph') / 'producer.py')
GRAPH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPH)
SUPERVISOR = GRAPH.LEGACY.load_supervisor()
LOG_CAP = 256 * 1024
RSS_CAP = 1024 * 1024 * 1024
POLL = .025

class TaskInfo(ctypes.Structure):
    # Exact Darwin SDK proc_taskinfo order: six uint64_t then twelve int32_t.
    _fields_ = [(name, ctypes.c_uint64) for name in ('virtual', 'resident', 'user', 'system', 'threadsUser', 'threadsSystem')] + [(name, ctypes.c_int32) for name in ('policy', 'faults', 'pageIns', 'cowFaults', 'messagesSent', 'messagesReceived', 'systemCallsMach', 'systemCallsUnix', 'switches', 'threadCount', 'running', 'priority')]


def rss_reader():
    if sys.platform != 'darwin' or ctypes.sizeof(TaskInfo) != 96:
        raise ValueError('reviewed Darwin resident monitor required')
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    call = library.proc_pidinfo
    call.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    call.restype = ctypes.c_int

    def read(pid):
        value = TaskInfo()
        count = call(pid, 4, 0, ctypes.byref(value), ctypes.sizeof(value))
        if count != 96 or value.resident <= 0:
            raise OSError(ctypes.get_errno(), 'resident query incomplete')
        return int(value.resident)
    return read


def check_rss(value):
    if type(value) is not int or value <= 0:
        raise ValueError('resident sample refused')
    if value > RSS_CAP:
        raise MemoryError('observed resident1GiB-cap')
    return value


def bounded_unit(argv, directory, env, read_rss, seconds=28):
    # Every operation after Popen is inside this owned lifecycle, including
    # selector construction/registration. Setup failures also kill and reap.
    deadline = time.monotonic() + seconds
    reason = primary = None
    exit_observation = None
    pipe_eof = False
    total = samples = maximum = 0
    group_signal = None
    process = watcher = out = None
    result = None
    cleanup = []

    def stop_owned():
        nonlocal group_signal
        try:
            group_signal = SUPERVISOR.signal_group(process)
            if group_signal == 'group-denied-direct-child-killed':
                cleanup.append('process-group-signal-denied; descendants-not-certified-stopped')
        except BaseException as cause:
            cleanup.append('process-group-signal-error-' + type(cause).__name__)
            try:
                process.kill()
            except ProcessLookupError:
                pass
            except BaseException as direct:
                cleanup.append('direct-child-kill-error-' + type(direct).__name__)

    try:
        # Exclusive log admission precedes spawn. Popen failure owns no process.
        out = (directory / 'child.log').open('xb')
        process = subprocess.Popen(argv, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env=env)
        watcher = selectors.DefaultSelector()
        if process.stdout is None:
            raise RuntimeError('owned stdout pipe missing')
        watcher.register(process.stdout, selectors.EVENT_READ)
        while watcher.get_map() or process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                reason = f'external{seconds:g}s-wall-watchdog'
                break
            if process.poll() is None:
                try:
                    value = read_rss(process.pid)
                    if type(value) is int and value > 0:
                        maximum = max(maximum, value)
                        samples += 1
                    check_rss(value)
                except BaseException as cause:
                    # ESRCH can precede waitpid visibility during actual exit.
                    # Only a prior RSS sample plus one bounded direct wait may
                    # confirm this race. All other query failures remain RED.
                    if isinstance(cause, OSError) and cause.errno == errno.ESRCH and samples > 0 and exit_observation is None:
                        wait_limit = min(POLL, max(0, deadline - time.monotonic()))
                        exit_observation = {'errno': errno.ESRCH, 'priorRSSSamples': samples,
                                            'waitLimitSeconds': wait_limit, 'confirmedExit': None,
                                            'confirmationFailure': None, 'pipeEOF': False}
                        if wait_limit > 0:
                            try:
                                exit_observation['confirmedExit'] = process.wait(timeout=wait_limit)
                            except BaseException as confirmation:
                                exit_observation['confirmationFailure'] = type(confirmation).__name__
                            else:
                                # The owned process was reaped. Continue normal
                                # bounded pipe draining; do not signal its group.
                                continue
                        else:
                            exit_observation['confirmationFailure'] = 'deadline-exhausted'
                    reason = 'resident-monitor-' + type(cause).__name__
                    primary = {'phase': 'resident-query', 'type': type(cause).__name__, 'message': str(cause)[:256]}
                    break
            for key, _ in watcher.select(min(remaining, POLL)):
                data = os.read(key.fileobj.fileno(), 16384)
                if not data:
                    watcher.unregister(key.fileobj)
                    pipe_eof = True
                    continue
                if len(data) > LOG_CAP - total:
                    out.write(data[:LOG_CAP - total])
                    total = LOG_CAP
                    reason = 'combined-log256KiB-cap'
                    break
                out.write(data)
                total += len(data)
            if reason:
                break
    except BaseException as cause:
        reason = 'supervisor-error-' + type(cause).__name__
        primary = {'phase': 'spawn-setup-or-read', 'type': type(cause).__name__, 'message': str(cause)[:256]}
    finally:
        if process is not None:
            if reason is not None:
                stop_owned()
            try:
                if exit_observation is not None and exit_observation['confirmedExit'] is not None:
                    result = exit_observation['confirmedExit']
                else:
                    result = process.wait(timeout=1 if reason is not None else max(.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                reason = reason or f'external{seconds:g}s-wall-watchdog'
                stop_owned()
                try:
                    result = process.wait(timeout=1)
                except BaseException as cause:
                    cleanup.append('direct-child-reap-error-' + type(cause).__name__)
            except BaseException as cause:
                cleanup.append('direct-child-wait-error-' + type(cause).__name__)
                stop_owned()
                try:
                    result = process.wait(timeout=1)
                except BaseException as reaped:
                    cleanup.append('direct-child-reap-error-' + type(reaped).__name__)
        # Cleanup failures must not hide the primary failure or lose a receipt.
        for resource in (watcher, getattr(process, 'stdout', None), out):
            if resource is not None:
                try:
                    resource.close()
                except BaseException as cause:
                    cleanup.append('resource-close-error-' + type(cause).__name__)
    if samples == 0 and reason is None:
        reason = 'resident-monitor-no-observation'
    if cleanup and reason is None:
        reason = 'supervisor-cleanup-failure'
    if exit_observation is not None:
        exit_observation['pipeEOF'] = pipe_eof
    receipt = {'argv': argv, 'spawned': process is not None, 'exit': result, 'failure': reason,
               'stdoutEOF': pipe_eof, 'exitObservation': exit_observation,
               'primaryFailure': primary, 'logBytes': total, 'wallLimitSeconds': seconds, 'logCapBytes': LOG_CAP,
               'processGroupSignal': group_signal, 'cleanupFailure': '; '.join(cleanup) if cleanup else None,
               'resident': {'scope': 'observed workload leader RSS; native process or Node GoJS parent including WASM', 'method': 'Darwin proc_pidinfo PROC_PIDTASKINFO pti_resident_size bytes', 'capBytes': RSS_CAP, 'pollSeconds': POLL, 'samples': samples, 'maxObservedBytes': maximum, 'instantaneousHardCeilingClaim': False}}
    GRAPH.write_json(directory / 'parent-exit.json', receipt)
    return receipt
