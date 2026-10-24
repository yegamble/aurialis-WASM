"""SOURCE ONLY same-module screen binding; verification/timing need later releases."""
# cspell:ignore GOMAXPROCS killpg AUEXPS PCMSHA untimed WRONLY CREAT fstat ENOENT
import importlib.util
import json
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
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-screen-host'
PLAN = SOURCE.with_name('envelope_node_visit_screen')
FILES = {'run-screen.py', 'screen-child.mjs', 'source-contract.test.py', 'README.md'}
BUILD = 'node-visit-build-v1'
BUILD_SHA = '16aacd5935e4bee8c9e253d926f9fe2d5dfbc2179f68b62b5b7e3d1195fde6f8'
UNIT_INDEX_SHA = '9d6e75edbc100155ff3e7d9f037054a7ee60bb7b199db6a4888cb83b06497c51'
SEMANTIC_INDEX_SHA = '07ccfacdf5247933321e823044660461ea2fb7667a545018851e7a0642a1b2f4'
V5_RED_SHA = '94440d692e5e1740d4637e83b4f29d53416ee3f6dc58af80c60fb9c982de1c46'
SCHEMA = 'same-module-screen-binding-v1'
LOG_CAP = 256 * 1024


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GRAPH = load('same_module_graph', SOURCE.with_name('envelope_node_visit_graph') / 'producer.py')
METHOD = load('frozen_screen_method', SOURCE.with_name('extrema_screen') / 'run-screen.py')
SEMANTICS = load('frozen_graph_receipts', SOURCE.with_name('envelope_node_visit_graph') / 'run-pair.py')
SUPERVISOR = GRAPH.LEGACY.load_supervisor()
NODE = GRAPH.NODE
digest, write_json, identifier = GRAPH.digest, GRAPH.write_json, GRAPH.identifier


def read_json(file, cap=256 * 1024):
    if file.is_symlink() or not file.is_file() or not 1 <= file.stat().st_size <= cap:
        raise ValueError('bounded binding/receipt refused')
    return json.loads(file.read_text())


def verify_index(file, expected):
    if digest(file) != expected:
        raise ValueError('immutable evidence index differs')
    index = read_json(file)
    if expected == SEMANTIC_INDEX_SHA:
        if not isinstance(index['files'], list) or len(index['files']) != 145:
            raise ValueError('frozen semantic list-index shape differs')
        entries = {entry['file']: entry for entry in index['files']}
        if len(entries) != 145:
            raise ValueError('duplicate semantic evidence path')
    elif expected in (UNIT_INDEX_SHA, V5_RED_SHA):
        count = 556 if expected == UNIT_INDEX_SHA else 8
        if not isinstance(index['files'], dict) or len(index['files']) != count:
            raise ValueError('frozen unit/RED map-index shape differs')
        entries = index['files']
    else:
        raise ValueError('closed evidence index identity refused')
    for name, entry in entries.items():
        if pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts:
            raise ValueError('closed evidence path refused')
        target = file.parent / name
        if target.is_symlink() or not target.is_file() or target.stat().st_size != entry['bytes'] or digest(target) != entry['sha256']:
            raise ValueError('immutable actual evidence differs')
    return {'file': str(file), 'sha256': expected}


def fixture_gate(build, manifest):
    # Read only: both actual192k module streams already ran and were sealed.
    entries = {}
    archive = GRAPH.archived('wasm', 192000)
    for label in GRAPH.LABELS:
        directory = build / 'runs' / ('wasm-' + label + '-rate192000')
        accepted = read_json(directory / 'ACCEPTED.json')
        parent = read_json(directory / 'parent-exit.json')
        child = read_json(directory / 'receipt.json', 128 * 1024)
        module = manifest['modules']['wasm'][label]
        counter = SEMANTICS.validate_counter((directory / 'child.log').read_text(), 192000, manifest['nativeCounterReceipts']['192000'])
        output = directory / 'rate192000.bin'
        SEMANTICS.validate_output(output, counter)
        if (accepted['moduleSHA256'] != module['sha256'] or accepted['manifestSHA256'] != BUILD_SHA
                or accepted['counter'] != counter or accepted['parent'] != parent
                or parent['exit'] != 0 or parent['failure'] is not None or parent['cleanupFailure'] is not None
                or child['goExit'] != 0 or not child['goExited'] or child['failure'] is not None
                or child['io']['failure'] is not None or not child['io']['closed']
                or child['io']['bytes'] != counter['outputBytes'] or child['counterReceipt'] != counter
                or digest(output) != accepted['outputSHA256'] or digest(directory / 'child.log') != accepted['logSHA256']
                or digest(directory / 'parent-exit.json') != accepted['parentReceiptSHA256']
                or digest(directory / 'receipt.json') != accepted['childReceiptSHA256']):
            raise ValueError('existing actual recorder receipt differs')
        if not SUPERVISOR.compare_streams(output, archive)['byteEqual']:
            raise ValueError('existing actual recorder differs from accepted same-backend e492 archive')
        files = {str(file): digest(file) for file in (output, directory / 'ACCEPTED.json', directory / 'child.log', directory / 'parent-exit.json', directory / 'receipt.json', archive)}
        entries[label] = {'moduleSHA256': module['sha256'], 'archiveRole': 'accepted e492 candidate in same WASM backend', 'files': files, 'counter': counter}
    return entries


def source_snapshot():
    if {p.name for p in SOURCE.iterdir() if p.is_file()} != FILES or any(p.is_symlink() for p in SOURCE.iterdir()):
        raise ValueError('closed four-file screen host inventory differs')
    plan = read_json(PLAN / 'PLAN.json')
    expected_plan = read_json(ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-screen/plan-v2/SOURCE-SHA256.json')
    if digest(ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-screen/plan-v2/SOURCE-SHA256.json') != '57734e7ad584a7bc3026f62e49f86612051ac27103ed527f433db638d61e7c0e':
        raise ValueError('admitted screen plan index changed')
    for name, entry in expected_plan['files'].items():
        if digest(ROOT / name) != entry['sha256']:
            raise ValueError('admitted screen plan source changed')
    build, manifest = GRAPH.read_manifest(BUILD)
    if digest(build / 'BUILD.json') != BUILD_SHA:
        raise ValueError('exact existing four-module BUILD changed')
    for label, entry in plan['modules'].items():
        current = manifest['modules']['wasm'][label]
        for key in ('bytes', 'sha256', 'overlaySHA256', 'sourceSetSHA256'):
            if entry[key] != current[key]:
                raise ValueError('exact same-module/source pair differs')
        if str(ROOT / entry['file']) != current['file']:
            raise ValueError('existing module path differs')
    for name, sha in plan['frozenMethodSources'].items():
        if digest(ROOT / name) != sha:
            raise ValueError('frozen original screen method/helper changed')
    if plan['runtime'] != manifest['runtime']:
        raise ValueError('pinned GoJS runtime differs')
    unit = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-units/source-v6'
    evidence = {'originalUnits': verify_index(unit / 'UNITS-SHA256.json', UNIT_INDEX_SHA),
                'semantic': verify_index(build / 'SEMANTIC-SHA256.json', SEMANTIC_INDEX_SHA),
                'historicalV5RED': verify_index(unit.with_name('source-v5') / 'UNIT-ATTEMPT-RED-SHA256.json', V5_RED_SHA)}
    runners = dict(manifest['snapshot']['runnerFiles'])
    runners.update(read_json(unit / 'SOURCE.json')['files'])
    runners.update({str(file.relative_to(ROOT)): digest(file) for file in sorted(PLAN.iterdir()) if file.is_file()})
    runners.update({str(file.relative_to(ROOT)): digest(file) for file in sorted(SOURCE.iterdir()) if file.is_file()})
    if len(runners) != 37:
        raise ValueError('closed current37-source inventory differs')
    for name, sha in runners.items():
        if digest(ROOT / name) != sha:
            raise ValueError('bound current/frozen runner source differs')
    if (SOURCE / 'screen-child.mjs').read_text() != child_from_old():
        raise ValueError('only reviewed child metadata bindings may differ')
    return {'schema': SCHEMA, 'baseBUILD': {'file': str(build / 'BUILD.json'), 'sha256': BUILD_SHA},
            'modules': manifest['modules']['wasm'], 'runtime': manifest['runtime'], 'runnerFiles': runners,
            'evidence': evidence, 'fixtures': fixture_gate(build, manifest)}


def prepare(screen_id):
    snapshot = source_snapshot()
    if subprocess.check_output([str(NODE), '--version'], text=True).strip() != 'v26.12.0':
        raise ValueError('pinned Node26 required')
    PROOF.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = PROOF / identifier(screen_id)
    directory.mkdir(mode=0o700)
    for name, sha in snapshot['runnerFiles'].items():
        target = directory / 'source-frozen' / (name + '.source' if name.endswith('.go') else name)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
        if digest(target) != sha:
            raise ValueError('source binding freeze changed')
    write_json(directory / 'BINDING.json', snapshot)
    print('Same existing module binding prepared; no build, screen, GoJS instance or timing')


def read_binding(screen_id):
    directory = PROOF / identifier(screen_id)
    binding = read_json(directory / 'BINDING.json', 128 * 1024)
    if binding != source_snapshot():
        raise ValueError('retained source/module/evidence binding differs')
    for name, sha in binding['runnerFiles'].items():
        target = directory / 'source-frozen' / (name + '.source' if name.endswith('.go') else name)
        if target.is_symlink() or digest(target) != sha:
            raise ValueError('frozen indexed host source differs')
    return directory, binding


def bounded_child(argv, directory):
    # Same old28s/256KiB/50ms pipe loop; only ownership/error cleanup is repaired.
    deadline = time.monotonic() + 28
    process = watcher = out = None
    reason = primary = group_signal = None
    result = None
    total = 0
    pipe_eof = False
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
        out = (directory / 'child.log').open('xb')
        process = subprocess.Popen(argv, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env={'PATH': str(NODE.parent), 'GOMAXPROCS': '1'})
        watcher = selectors.DefaultSelector()
        if process.stdout is None:
            raise RuntimeError('owned stdout pipe missing')
        watcher.register(process.stdout, selectors.EVENT_READ)
        while watcher.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                reason = 'external28s-wall-watchdog'
                break
            for key, _ in watcher.select(min(remaining, .05)):
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
        primary = {'type': type(cause).__name__, 'message': str(cause)[:256]}
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
        for resource in (watcher, getattr(process, 'stdout', None), out):
            if resource is not None:
                try:
                    resource.close()
                except BaseException as cause:
                    cleanup.append('resource-close-error-' + type(cause).__name__)
    if cleanup and reason is None:
        reason = 'supervisor-cleanup-failure'
    receipt = {'argv': argv, 'spawned': process is not None, 'exit': result, 'failure': reason, 'primaryFailure': primary,
               'logBytes': total, 'stdoutEOF': pipe_eof, 'wallLimitSeconds': 28, 'logCapBytes': LOG_CAP,
               'processGroupSignal': group_signal, 'cleanupFailure': '; '.join(cleanup) if cleanup else None}
    write_json(directory / 'parent-exit.json', receipt)
    return receipt


def validate_parent(parent):
    if (parent.get('stdoutEOF') is not True or parent.get('spawned') is not True or parent.get('exit') != 0 or parent.get('failure') is not None
            or parent.get('primaryFailure') is not None or parent.get('cleanupFailure') is not None
            or parent.get('processGroupSignal') is not None or parent.get('wallLimitSeconds') != 28
            or parent.get('logCapBytes') != LOG_CAP or not 1 <= parent.get('logBytes', 0) <= LOG_CAP):
        raise ValueError('owned screen parent refused')


def screen_selection(label, phase, workload, leg):
    allowed = ('gate',) if phase == 'verify' else (('candidate',) if label == 'candidate' else ('before', 'after'))
    if label not in GRAPH.LABELS or phase not in ('verify', 'measure') or workload not in ('steady', 'peaky') or leg not in allowed:
        raise ValueError('closed same-module screen selection refused')


def validate_io(state, size, log_bytes):
    requests = state.get('requests', [])
    if (state.get('file') != '/aurialis-private-fixture/rate192000.bin'
            or state.get('flags') != os.O_WRONLY | os.O_CREAT | os.O_EXCL or state.get('mode') != 0o600
            or state.get('failure') is not None or state.get('everOpened') is not True
            or state.get('opened') is not False or state.get('closed') is not True
            or state.get('bytes') != size or state.get('logBytes') != log_bytes
            or not 1 <= len(requests) <= 256
            or sum(item.get('operation') == 'open' for item in requests) != 1
            or sum(item.get('operation') == 'close' for item in requests) != 1):
        raise ValueError('closed screen I/O completion/caps refused')
    for item in requests:
        operation = item.get('operation')
        if operation not in ('stat', 'lstat', 'fstat', 'open', 'close', 'write', 'writeSync') or item.get('result') not in ('ok', 'ENOENT'):
            raise ValueError('closed screen I/O operation refused')
        if operation in ('write', 'writeSync') and (item.get('fd') not in (1, 2, 3) or not 0 <= item.get('length', -1) <= 65536):
            raise ValueError('closed screen write cap/descriptor refused')


def read_result(directory, binding, label, phase, workload, leg):
    screen_selection(label, phase, workload, leg)
    child = directory / 'runs' / (phase + '-' + workload + '-' + leg + '-' + label)
    parent = read_json(child / 'parent-exit.json')
    validate_parent(parent)
    if parent['argv'] != [str(NODE), str(SOURCE / 'screen-child.mjs'), directory.name, label, phase, workload, leg]:
        raise ValueError('original Node argv or closed selection changed')
    receipt = read_json(child / 'receipt.json', 128 * 1024)
    output = child / 'rate192000.bin'
    if output.is_symlink() or not 1 <= output.stat().st_size <= METHOD.CAP or output.stat().st_mode & 0o777 != 0o600:
        raise ValueError('bounded exclusive screen output refused')
    data = output.read_bytes()
    entry = binding['modules'][label]
    expected = {'buildId': directory.name, 'label': label, 'phase': phase, 'workload': workload, 'leg': leg,
                'moduleSHA256': entry['sha256'], 'sourceSetSHA256': entry['sourceSetSHA256'], 'overlaySHA256': entry['overlaySHA256'],
                'runtimeSHA256': binding['runtime']['sha256'], 'bindingSHA256': digest(directory / 'BINDING.json'), 'baseBUILD_SHA256': BUILD_SHA,
                'goExit': 0, 'goExited': True, 'failure': None, 'outputSHA256': METHOD.sha(data)}
    if receipt.get('goExited') is not True or type(receipt.get('goExit')) is not int or any(receipt.get(key) != value for key, value in expected.items()) or receipt['io']['failure'] is not None or receipt['io'].get('everOpened') is not True or receipt['io'].get('opened') is not False or not receipt['io']['closed'] or receipt['io']['bytes'] != len(data):
        raise ValueError('same-module Go/closedIO/provenance refused')
    log = (child / 'child.log').read_bytes()
    if len(log) != parent['logBytes'] or receipt['io']['logBytes'] != len(log) or not log.endswith(b'\nPASS\n') or len(re.findall(rb'^=== RUN   TestWriteStudioExtremaScreen$', log, re.M)) != 1 or len(re.findall(rb'^--- PASS: TestWriteStudioExtremaScreen ', log, re.M)) != 1 or re.search(rb'--- (?:FAIL|SKIP):|^FAIL|panic:|fatal error:', log, re.M):
        raise ValueError('actual screen test/log admission refused')
    validate_io(receipt['io'], len(data), len(log))
    parsed = METHOD.parse_screen(data, phase, workload)
    matches = re.findall(rb'cases(\d+) rate(\d+) baseFrames(\d+) numericWords(\d+) outputBytes(\d+) fixedGraphBytes(\d+) inputSHA256([0-9a-f]{64})', log)
    if len(matches) != 1:
        raise ValueError('screen independent Go receipt missing/duplicate')
    cases, rate, frames, words, size, graph, input_sha = matches[0]
    if (int(cases) != 2 or int(rate) != 192000 or int(frames) != parsed['frames'] or int(words) != parsed['numericWords']
            or int(size) != len(data) or int(graph) + 320 * 1024 > 2 * 1024 * 1024):
        raise ValueError('screen Go work/resource receipt differs')
    parsed.update({'inputSHA256': input_sha.decode(), 'outputSHA256': METHOD.sha(data), 'path': str(child.relative_to(directory)),
                   'parentReceiptSHA256': digest(child / 'parent-exit.json'), 'childReceiptSHA256': digest(child / 'receipt.json')})
    return parsed


def execute(screen_id, binding, label, phase, workload, leg):
    screen_selection(label, phase, workload, leg)
    directory, actual = read_binding(screen_id)
    if actual != binding:
        raise ValueError('screen source changed before child')
    output = directory / 'runs' / (phase + '-' + workload + '-' + leg + '-' + label)
    output.parent.mkdir(mode=0o700, exist_ok=True)
    output.mkdir(mode=0o700)
    lock = directory / 'ACTIVE.lock'
    with lock.open('x') as out:
        out.write(output.name + '\n')
    try:
        argv = [str(NODE), str(SOURCE / 'screen-child.mjs'), screen_id, label, phase, workload, leg]
        bounded_child(argv, output)
        parsed = read_result(directory, binding, label, phase, workload, leg)
        write_json(output / 'ANALYSIS.json', {key: value for key, value in parsed.items() if key not in ('verificationBytes', 'timedBytes')})
        return parsed
    except BaseException as cause:
        write_json(output / 'ERROR.json', {'type': type(cause).__name__, 'error': str(cause)[:512]})
        raise
    finally:
        lock.unlink()


def qualify(screen_id, workload):
    directory, binding = read_binding(screen_id)
    if workload not in ('steady', 'peaky'):
        raise ValueError('closed screen workload refused')
    verified = {label: execute(screen_id, binding, label, 'verify', workload, 'gate') for label in GRAPH.LABELS}
    if verified['baseline']['verificationBytes'] != verified['candidate']['verificationBytes'] or verified['baseline']['inputSHA256'] != verified['candidate']['inputSHA256']:
        raise ValueError('same-module32-block verification differs')
    write_json(directory / ('QUALIFIED-' + workload + '.json'), {'bindingSHA256': digest(directory / 'BINDING.json'), 'workload': workload,
               'verificationSHA256': verified['baseline']['verificationSHA256'], 'inputSHA256': verified['baseline']['inputSHA256'],
               'verifyOutputs': {label: {key: item[key] for key in ('path', 'outputSHA256', 'parentReceiptSHA256', 'childReceiptSHA256')} for label, item in verified.items()}})
    print('Two existing-module verification children admitted; no timing interpretation')


def measure(screen_id, workload):
    if workload not in ('steady', 'peaky'):
        raise ValueError('closed screen workload refused')
    directory, binding = read_binding(screen_id)
    gate = read_json(directory / ('QUALIFIED-' + workload + '.json'), 64 * 1024)
    if gate['bindingSHA256'] != digest(directory / 'BINDING.json') or gate['workload'] != workload:
        raise ValueError('same-module verification binding differs')
    for label in GRAPH.LABELS:
        item = read_result(directory, binding, label, 'verify', workload, 'gate')
        expected = {key: item[key] for key in ('path', 'outputSHA256', 'parentReceiptSHA256', 'childReceiptSHA256')}
        if gate['verifyOutputs'][label] != expected or item['verificationSHA256'] != gate['verificationSHA256'] or item['inputSHA256'] != gate['inputSHA256']:
            raise ValueError('actual bound verification bytes/receipts changed')
    results, before = [], None
    for label, leg in (('baseline', 'before'), ('candidate', 'candidate'), ('baseline', 'after')):
        item = execute(screen_id, binding, label, 'measure', workload, leg)
        admitted = METHOD.admit_observation(item, gate, before)
        if before is None:
            before = admitted
        results.append({'label': label, 'leg': leg, **{key: value for key, value in item.items() if key not in ('verificationBytes', 'timedBytes')}})
    write_json(directory / ('PAIRED-' + workload + '.json'), {'bindingSHA256': digest(directory / 'BINDING.json'),
               'scope': '32-block means only; no callback maximum, physical deadline, headroom or steady-state claim',
               'perChildFrames': METHOD.MEASURE_FRAMES, 'tripletFrames': 3 * METHOD.MEASURE_FRAMES,
               'tripletHighFrameUpper': 3 * METHOD.MEASURE_FRAMES * 4, 'deadlineMsPer128': 128000 / 192000, 'results': results})
    print('First raw same-module bracket retained; no public selection/headroom certification')


CHILD_BINDING_BLOCK = '''if (manifest.schema !== 'same-module-screen-binding-v1' || Object.keys(manifest.runnerFiles ?? {}).length !== 37) throw new Error('closed same-module binding inventory refused');
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
'''


def child_from_old():
    text = (SOURCE.with_name('extrema_screen') / 'screen-child.mjs').read_text()
    replacements = [
        ("!['fixture', 'verify', 'measure'].includes(phase)", "!['verify', 'measure'].includes(phase)"),
        ("recovery-20261023/extrema-paired-screen", "recovery-20261023/envelope-node-visit-screen-host"),
        ("path.join(proof, 'BUILD.json')", "path.join(proof, 'BINDING.json')"),
        ("manifestSHA256", "bindingSHA256"),
        ("const moduleFile = path.join(proof, 'modules', `${label}.wasm`);", "const moduleFile = path.join(root, 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-graph/node-visit-build-v1/modules', `wasm-${label}.wasm`);"),
        ("const test = phase === 'fixture' ? 'TestWriteStudioExtremaGraphFixtures' : 'TestWriteStudioExtremaScreen';", "const test = 'TestWriteStudioExtremaScreen';"),
        ("    ...(phase === 'fixture' ? { AURIALIS_STUDIO_EXTREMA_RATE: '192000', AURIALIS_STUDIO_EXTREMA_FIXTURES: virtualDirectory } : { AURIALIS_STUDIO_SCREEN_OUTPUT: virtualDirectory, AURIALIS_STUDIO_SCREEN_RATE: '192000', AURIALIS_STUDIO_SCREEN_PHASE: phase, AURIALIS_STUDIO_SCREEN_WORKLOAD: workload }),", "    AURIALIS_STUDIO_SCREEN_OUTPUT: virtualDirectory, AURIALIS_STUDIO_SCREEN_RATE: '192000', AURIALIS_STUDIO_SCREEN_PHASE: phase, AURIALIS_STUDIO_SCREEN_WORKLOAD: workload,"),
        ("bindingSHA256: hash(manifestBytes), moduleSHA256:", "bindingSHA256: hash(manifestBytes), baseBUILD_SHA256: manifest.baseBUILD.sha256, moduleSHA256:"),
    ]
    for old, new in replacements:
        if old not in text:
            raise ValueError('frozen child transformation anchor changed')
        text = text.replace(old, new)
    start = text.index('const requiredRunner = ')
    end = text.index("if (phase === 'measure')", start)
    text = text[:start] + CHILD_BINDING_BLOCK + text[end:]
    old = "hash(read(path.join(root, name), 64 * 1024)) !== sha"
    text = text.replace(old, old + " || hash(read(path.join(proof, 'source-frozen', name.endsWith('.go') ? `${name}.source` : name), 64 * 1024)) !== sha")
    return text


if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == 'prepare':
        prepare(args[1])
    elif len(args) == 3 and args[0] == 'qualify':
        qualify(identifier(args[1]), args[2])
    elif len(args) == 4 and args[0] == 'measure' and args[3] == 'quiet-approved':
        measure(identifier(args[1]), args[2])
    else:
        raise SystemExit('usage: run-screen.py prepare NEW_ID | qualify ID steady|peaky | measure ID steady|peaky quiet-approved; actual execution needs separate Chair release')
