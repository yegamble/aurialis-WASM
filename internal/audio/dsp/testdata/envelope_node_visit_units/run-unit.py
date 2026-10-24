"""SOURCE ONLY original invariant host; execution needs separate Chair release."""
# cspell:ignore GOMAXPROCS killpg pidinfo taskinfo ctypes libproc argtypes restype PIDTASKINFO fstat
import ctypes
import importlib.util
import json
import math
import os
import pathlib
import re
import selectors
import subprocess
import sys
import time

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
ROOT = SOURCE.parents[4]
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-units'
SPEC = importlib.util.spec_from_file_location('bound_graph_producer', SOURCE.with_name('envelope_node_visit_graph') / 'producer.py')
GRAPH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPH)
SUPERVISOR = GRAPH.LEGACY.load_supervisor()
BUILD = 'node-visit-build-v1'
BUILD_SHA = '16aacd5935e4bee8c9e253d926f9fe2d5dfbc2179f68b62b5b7e3d1195fde6f8'
PLAN = SOURCE.with_name('envelope_node_visit_gates')
PLAN_SHA = '8f0ffd7726eb727ae0d6d5372a63f4a9f1de567ddfd3f2f6be23e1cb336f3790'
FILES = {'run-unit.py', 'wasm-unit.mjs', 'unit-io.mjs', 'source-contract.test.py', 'ARRAY-BOUNDS.json', 'README.md'}
LOG_CAP = 256 * 1024
RSS_CAP = 1024 * 1024 * 1024
POLL = .025


def read_json(file, cap=256 * 1024):
    if file.is_symlink() or not file.is_file() or not 1 <= file.stat().st_size <= cap:
        raise ValueError('bounded source/receipt refused')
    return json.loads(file.read_text())


def selected_test(name):
    plan = read_json(PLAN / 'PLAN.json')
    if GRAPH.digest(PLAN / 'PLAN.json') != PLAN_SHA or plan['testCount'] != 18:
        raise ValueError('reviewed immutable test plan changed')
    tests = [entry for entry in plan['tests'] if entry['name'] == name]
    if len(tests) != 1 or not re.fullmatch(r'TestStudio[A-Za-z0-9]+', name):
        raise ValueError('closed original unit name refused')
    test = tests[0]
    if GRAPH.digest(ROOT / test['file']) != test['sourceSHA256']:
        raise ValueError('original whole unit source changed')
    return test


def validate_log(text, name):
    selected_test(name)
    if not text.endswith('\nPASS\n') or re.search(r'--- (?:FAIL|SKIP):|^FAIL|panic:|fatal error:|WARNING:|no tests to run', text, re.M):
        raise ValueError('unit failure/skip/incomplete log refused')
    expected = [name]
    if name == 'TestStudioPartitionedPostDetectorDirectConvolutionAndFiniteEdges':
        expected += [name + '/frames' + str(n) for n in (1, 127, 128, 129, 257, 513, 4097)]
    started = re.findall(r'^=== RUN   (\S+)$', text, re.M)
    passed = re.findall(r'^\s*--- PASS: (\S+) \([0-9.]+s\)$', text, re.M)
    if started != expected or len(passed) != len(expected) or set(passed) != set(expected):
        raise ValueError('exact original top/nested unit admission refused')
    return {'started': started, 'passed': passed, 'skipped': 0}


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


def bounded_unit(argv, directory, env, read_rss):
    # Every operation after Popen is inside this owned lifecycle, including
    # selector construction/registration. Setup failures also kill and reap.
    deadline = time.monotonic() + 28
    reason = primary = None
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
                reason = 'external28s-wall-watchdog'
                break
            if process.poll() is None:
                try:
                    value = read_rss(process.pid)
                    if type(value) is int and value > 0:
                        maximum = max(maximum, value)
                        samples += 1
                    check_rss(value)
                except BaseException as cause:
                    # Exit racing a query needs an earlier valid observation.
                    if process.poll() is None or samples == 0 or isinstance(cause, MemoryError):
                        reason = 'resident-monitor-' + type(cause).__name__
                        primary = {'phase': 'resident-query', 'type': type(cause).__name__, 'message': str(cause)[:256]}
                        break
            for key, _ in watcher.select(min(remaining, POLL)):
                data = os.read(key.fileobj.fileno(), 16384)
                if not data:
                    watcher.unregister(key.fileobj)
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
                result = process.wait(timeout=1 if reason is not None else max(.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                reason = reason or 'external28s-wall-watchdog'
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
    receipt = {'argv': argv, 'spawned': process is not None, 'exit': result, 'failure': reason,
               'primaryFailure': primary, 'logBytes': total, 'wallLimitSeconds': 28, 'logCapBytes': LOG_CAP,
               'processGroupSignal': group_signal, 'cleanupFailure': '; '.join(cleanup) if cleanup else None,
               'resident': {'scope': 'observed workload leader RSS; native process or Node GoJS parent including WASM', 'method': 'Darwin proc_pidinfo PROC_PIDTASKINFO pti_resident_size bytes', 'capBytes': RSS_CAP, 'pollSeconds': POLL, 'samples': samples, 'maxObservedBytes': maximum, 'instantaneousHardCeilingClaim': False}}
    GRAPH.write_json(directory / 'parent-exit.json', receipt)
    return receipt


def sources():
    if {p.name for p in SOURCE.iterdir() if p.is_file()} != FILES or any(p.is_symlink() for p in SOURCE.iterdir()):
        raise ValueError('closed unit host inventory differs')
    GRAPH.read_manifest(BUILD)
    directory = GRAPH.PROOF / BUILD
    if GRAPH.digest(directory / 'BUILD.json') != BUILD_SHA:
        raise ValueError('reviewed four-module BUILD changed')
    for entry in read_json(PLAN / 'PLAN.json')['tests']:
        selected_test(entry['name'])
    bounds = read_json(SOURCE / 'ARRAY-BOUNDS.json')
    if any(math.prod(entry['factors']) != entry['bytes'] for entry in bounds['arrays']):
        raise ValueError('array byte arithmetic differs')
    for entry in bounds['existingGraphObjectEvidence']:
        file = ROOT / entry['file']
        if GRAPH.digest(file) != entry['sha256'] or read_json(file)['counter']['fixedGraphBytes'] != entry['fixedGraphBytes'] or entry['fixedGraphBytes'] != 1073080:
            raise ValueError('accepted original graph object evidence differs')
    for entry in bounds['references']:
        file = pathlib.Path(entry['file']) if entry['absolute'] else ROOT / entry['file']
        if GRAPH.digest(file) != entry['sha256'] or file.read_text().splitlines()[entry['line'] - 1].strip() != entry['text']:
            raise ValueError('array/SDK source reference changed')
    if {p.name for p in PLAN.iterdir()} != {'PLAN.json', 'MODULE-PRESENCE.json', 'COMMANDS.source', 'README.md'} or any(p.is_symlink() for p in PLAN.iterdir()):
        raise ValueError('frozen four-file gate plan inventory changed')
    paths = list(SOURCE.iterdir()) + list(PLAN.iterdir())
    return {str(file.relative_to(ROOT)): GRAPH.digest(file) for file in sorted(paths) if file.is_file()}


def freeze(source_id):
    snapshot = sources()
    PROOF.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = PROOF / GRAPH.identifier(source_id)
    directory.mkdir(mode=0o700)
    frozen = directory / 'source-frozen'
    frozen.mkdir(mode=0o700)
    for name, sha in snapshot.items():
        target = frozen / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
        if GRAPH.digest(target) != sha:
            raise ValueError('unit source freeze changed')
    GRAPH.write_json(directory / 'SOURCE.json', {'scope': 'SOURCE ONLY original unit host; no execution release', 'baseBuild': BUILD, 'baseBuildSHA256': BUILD_SHA, 'files': snapshot})
    print('Unit host sources frozen; no Go/GoJS child, build or timing executed')


def admit_source(source_id):
    directory = PROOF / GRAPH.identifier(source_id)
    receipt = read_json(directory / 'SOURCE.json')
    snapshot = sources()
    if receipt['baseBuild'] != BUILD or receipt['baseBuildSHA256'] != BUILD_SHA or receipt['files'] != snapshot:
        raise ValueError('frozen host source differs')
    for name, sha in snapshot.items():
        if GRAPH.digest(directory / 'source-frozen' / name) != sha:
            raise ValueError('retained host source differs')
    return directory, receipt


def validate_parent(receipt):
    resident = receipt.get('resident', {})
    if (receipt.get('spawned') is not True or receipt.get('exit') != 0 or receipt.get('failure') is not None
            or receipt.get('primaryFailure') is not None
            or receipt.get('cleanupFailure') is not None or receipt.get('processGroupSignal') is not None
            or receipt.get('wallLimitSeconds') != 28 or receipt.get('logCapBytes') != LOG_CAP
            or not 1 <= receipt.get('logBytes', 0) <= LOG_CAP or resident.get('samples', 0) < 1
            or resident.get('capBytes') != RSS_CAP or resident.get('pollSeconds') != POLL
            or resident.get('instantaneousHardCeilingClaim') is not False
            or not 1 <= resident.get('maxObservedBytes', 0) <= RSS_CAP):
        raise ValueError('bounded unit parent refused')


def validate_wasm(receipt, test, source_sha, module, source_id, run_id, label, log_bytes):
    io = receipt.get('io', {})
    runtime = GRAPH.read_manifest(BUILD)[1]['runtime']['sha256']
    if (receipt.get('sourceId') != source_id or receipt.get('runId') != run_id or receipt.get('label') != label
            or receipt.get('name') != test or receipt.get('sourceSHA256') != source_sha
            or receipt.get('manifestSHA256') != BUILD_SHA or receipt.get('moduleSHA256') != module['sha256']
            or receipt.get('runtimeSHA256') != runtime or receipt.get('sourceSetSHA256') != module['sourceSetSHA256']
            or receipt.get('overlaySHA256') != module['overlaySHA256'] or receipt.get('goExit') != 0
            or receipt.get('goExited') is not True or receipt.get('failure') is not None
            or io.get('failure') is not None or io.get('openAttempts') != 0
            or io.get('everOpened') is not False or io.get('opened') is not False or io.get('closed') is not False
            or io.get('bytes') != 0 or io.get('logBytes') != log_bytes or not 1 <= io.get('logBytes', 0) <= LOG_CAP
            or any(item.get('operation') not in ('write', 'writeSync', 'fstat')
                   or item.get('fd') not in (0, 1, 2) or item.get('result') != 'ok' for item in io.get('requests', []))):
        raise ValueError('closed log-only GoJS unit receipt refused')


def run_one(source_id, run_id, backend, label, name):
    test = selected_test(name)
    directory, source = admit_source(source_id)
    if backend not in GRAPH.BACKENDS or label not in GRAPH.LABELS:
        raise ValueError('closed existing module selection refused')
    if subprocess.check_output([str(GRAPH.NODE), '--version'], text=True).strip() != 'v26.12.0':
        raise ValueError('pinned Node26 required')
    build_dir, manifest = GRAPH.read_manifest(BUILD)
    module = manifest['modules'][backend][label]
    claims = directory / 'claims'
    claims.mkdir(mode=0o700, exist_ok=True)
    # Claim survives every failure. A different ID cannot retry this unit/module.
    claim = claims / (backend + '-' + label + '-' + name + '.json')
    GRAPH.write_json(claim, {'sourceId': source_id, 'runId': GRAPH.identifier(run_id), 'backend': backend, 'label': label, 'name': name})
    output = directory / 'runs' / GRAPH.identifier(run_id)
    output.parent.mkdir(mode=0o700, exist_ok=True)
    output.mkdir(mode=0o700)
    env = {'PATH': str(GRAPH.NODE.parent), 'GOMAXPROCS': '1', 'TMPDIR': '/aurialis-private-fixture'}
    argv = [module['file'], '-test.run=^' + name + '$', '-test.count=1', '-test.v', '-test.timeout=25s']
    if backend == 'wasm':
        argv = [str(GRAPH.NODE), '--stack-size=8192', '--max-old-space-size=192', str(SOURCE / 'wasm-unit.mjs'), source_id, run_id, label, name]
    partial = {'scope': 'original immutable unit only; no timing/recorder/cross-target fullstate claim', 'sourceId': source_id, 'runId': run_id, 'backend': backend, 'label': label, 'name': name, 'test': test, 'sourceSHA256': GRAPH.digest(directory / 'SOURCE.json'), 'manifestSHA256': BUILD_SHA, 'module': module, 'runtimeProcessEnv': env}
    lock = directory / 'ACTIVE.lock'
    with lock.open('x') as active:
        active.write(run_id + '\n')
    try:
        result = bounded_unit(argv, output, env, rss_reader())
        partial['parent'] = result
        validate_parent(result)
        if (output / 'child.log').stat().st_size != result['logBytes']:
            raise ValueError('actual retained unit log size differs')
        partial['logAdmission'] = validate_log((output / 'child.log').read_text(), name)
        partial['logSHA256'] = GRAPH.digest(output / 'child.log')
        partial['parentReceiptSHA256'] = GRAPH.digest(output / 'parent-exit.json')
        if backend == 'wasm':
            receipt = read_json(output / 'receipt.json', 128 * 1024)
            validate_wasm(receipt, name, partial['sourceSHA256'], module, source_id, run_id, label, result['logBytes'])
            partial['childReceiptSHA256'] = GRAPH.digest(output / 'receipt.json')
        admit_source(source_id)
        GRAPH.write_json(output / 'ACCEPTED.json', partial)
        print(backend, label, name, 'original unit accepted; no timing')
    except Exception as error:
        GRAPH.write_json(output / 'ERROR.json', {'error': str(error)[:512], 'partial': partial})
        raise
    finally:
        lock.unlink()


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'freeze':
        freeze(sys.argv[2])
    elif len(sys.argv) == 7 and sys.argv[1] == 'run':
        run_one(*sys.argv[2:])
    else:
        raise SystemExit('usage: run-unit.py freeze NEW_SOURCE_ID | run SOURCE_ID NEW_RUN_ID native|wasm baseline|candidate EXACT_TEST; execution requires separate Chair release')
