"""Fixed36 original units+10 recorders; actual children need separate release."""
# cspell:ignore WRONLY CREAT fstat purgeable GOMAXPROCS AURIALIS gojs
import hashlib
import json
import os
import pathlib
import re
import sys

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
ROOT = SOURCE.parents[4]
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-bound-hoist-qualification'
SCHEMA = 'bound-qualification-v1'
# Bootstrap imports are pinned again before any future child.
import importlib.util


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


WASM = load('qualification_wasm', SOURCE.with_name('envelope_bound_hoist_wasm_host') / 'host.py')
DISK = load('qualification_disk', SOURCE / 'disk-budget.py')
NATIVE, GUARD = WASM.NATIVE, WASM.GUARD
UNIT, GRAPH = NATIVE.UNIT, NATIVE.GRAPH
PAIR = load('qualification_pair', SOURCE.with_name('envelope_node_visit_graph') / 'run-pair.py')
PLAN = SOURCE.with_name('envelope_bound_hoist_qualification_plan') / 'PLAN.json'
PLAN_SHA = 'a945d0da5684faa90c1829772c32c0d670811cecc2201705db6dc74e24a1f9f9'
SCHEMA_KEYS = {'schema', 'runnerFiles', 'frozenFiles', 'modules', 'runtime', 'counterBUILD', 'nativeCounterReceipts', 'jobs', 'ledger', 'historicalCompilerHashes'}
read_json = WASM.read_json
read = WASM.INSPECT.PARSER.bounded_bytes
digest, identifier = NATIVE.digest, NATIVE.identifier


def jobs(plan):
    result = [{'id': 'unit-' + backend + '-' + format(index, '02d'), 'kind': 'unit', 'backend': backend, 'name': name}
              for index, name in enumerate(plan['originalUnits']['names']) for backend in ('native', 'wasm')]
    result += [{'id': 'recorder-' + backend + '-' + str(rate), 'kind': 'recorder', 'backend': backend,
                'name': plan['recorder']['name'], 'rate': rate}
               for rate in plan['recorder']['rates'] for backend in ('native', 'wasm')]
    if len(result) != 46 or len({job['id'] for job in result}) != 46:
        raise ValueError('closed46 jobs differ')
    return result


def source_snapshot():
    if {file.name for file in SOURCE.iterdir()} != DISK.SOURCE_FILES or any(file.is_symlink() for file in SOURCE.iterdir()):
        raise ValueError('closed seven-file adapter differs')
    if digest(PLAN) != PLAN_SHA:
        raise ValueError('accepted fixed46 plan changed')
    plan = read_json(PLAN)
    native_dir, native = NATIVE.read_build('bound-hoist-native-v2')
    wasm_dir, wasm_source, wasm = WASM.read_build('source-v1')
    modules = {}
    for backend, directory, build in (('native', native_dir, native), ('wasm', wasm_dir, wasm)):
        expected = plan['existingCandidateModules'][backend]
        if digest(directory / 'BUILD.json') != expected['BUILD_SHA256'] or build['module'] != expected['module']:
            raise ValueError('exact existing candidate module/BUILD differs')
        # Reuse the existing actual modules, never copy or compile them.
        data = read(pathlib.Path(build['module']['file']), 16 * DISK.MIB)
        if len(data) != build['module']['bytes'] or hashlib.sha256(data).hexdigest() != build['module']['sha256']:
            raise ValueError('pre-capped module bytes differ')
        modules[backend] = {**expected, 'module': build['module']}
    runners = dict(wasm_source['runnerFiles'])
    for name, sha in plan['frozenSources'].items():
        if digest(ROOT / name) != sha:
            raise ValueError('unchanged execution/guard source differs')
        runners[name] = sha
    for name in plan['originalUnits']['names']:
        UNIT.selected_test(name)
    counter_pin = plan['recorder']['expectedCountersFrom']
    if digest(ROOT / counter_pin['BUILD']) != counter_pin['sha256'] or digest(ROOT / plan['recorder']['source']) != plan['recorder']['sourceSHA256']:
        raise ValueError('original recorder/counter BUILD differs')
    counter = read_json(ROOT / counter_pin['BUILD'])
    for backend in ('native', 'wasm'):
        for reference in plan['recorder']['sameBackendReferences'][backend].values():
            for name in (reference['qualifiedBaselineStream'], reference['acceptedE492Archive']['file']):
                data = read(ROOT / name, 8 * DISK.MIB)
                if len(data) != reference['bytes'] or hashlib.sha256(data).hexdigest() != reference['sha256']:
                    raise ValueError('same-backend sealed reference changed')
    for folder in (SOURCE, PLAN.parent):
        runners.update({str(file.relative_to(ROOT)): digest(file) for file in folder.iterdir()})
    for name in (plan['originalUnits']['wholePlan'], plan['originalUnits']['arrayBounds']['file']):
        runners[name] = digest(ROOT / name)
    if runners[plan['originalUnits']['wholePlan']] != plan['originalUnits']['wholePlanSHA256'] or runners[plan['originalUnits']['arrayBounds']['file']] != plan['originalUnits']['arrayBounds']['sha256']:
        raise ValueError('immutable whole-unit plan/array bounds differ')
    return {'schema': SCHEMA, 'runnerFiles': runners, 'frozenFiles': sorted(str(file.relative_to(ROOT)) for file in SOURCE.iterdir()),
            'modules': modules, 'runtime': wasm_source['runtime'], 'counterBUILD': counter_pin,
            'nativeCounterReceipts': counter['nativeCounterReceipts'], 'jobs': jobs(plan), 'ledger': DISK.slots(jobs(plan)),
            'historicalCompilerHashes': 'UNRECORDED; no retrospective baseline compiler byte identity'}


def budget(directory, coordination, snapshot):
    return DISK.Budget(directory, pathlib.Path(coordination), snapshot['ledger'], read)


def freeze(source_id, coordination):
    snapshot = source_snapshot()
    PROOF.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = PROOF / identifier(source_id)
    if directory.exists():
        raise ValueError('fresh exclusive source ID required')
    gate = budget(directory, coordination, snapshot)
    for name in snapshot['frozenFiles']:
        gate.publish('source-frozen/' + pathlib.Path(name).name, read(ROOT / name, 256 * DISK.KIB))
    gate.json('SOURCE.json', snapshot)
    if source_snapshot() != snapshot:
        raise ValueError('post-freeze old inventory/source differs')
    index = {'scope': 'SOURCE only; no compiler/module copy/GoJS child', 'files': {str(file.relative_to(directory)): {'bytes': file.stat().st_size, 'sha256': digest(file)} for file in sorted(directory.rglob('*')) if file.is_file() and file.name != 'disk.jsonl'}}
    gate.json('SOURCE-SHA256.json', index)
    print('Fixed46 source frozen; no runtime child or module copy')


def read_source(source_id):
    directory = PROOF / identifier(source_id)
    source = read_json(directory / 'SOURCE.json')
    if set(source) != SCHEMA_KEYS or source != source_snapshot():
        raise ValueError('exact current source binding differs')
    for name in source['frozenFiles']:
        if digest(directory / 'source-frozen' / pathlib.Path(name).name) != source['runnerFiles'][name]:
            raise ValueError('frozen adapter changed')
    return directory, source


def next_job(directory, source, wanted):
    for job in source['jobs']:
        claim = directory / 'claims' / (job['id'] + '.json')
        accepted = directory / 'runs' / job['id'] / 'ACCEPTED.json'
        rejected = accepted.with_name('REJECTED.json')
        if rejected.exists():
            raise ValueError('prior RED retained; no continuation/retry')
        if claim.exists():
            if not accepted.exists() or read_json(claim) != job or read_json(accepted).get('job') != job:
                raise ValueError('prior claim incomplete; no retry')
            continue
        if job['id'] != wanted:
            raise ValueError('exact next sequential job required')
        return job
    raise ValueError('all fixed46 jobs already claimed; no extra child')


def child_argv(source_id, job, source_sha, module):
    if job['backend'] == 'native':
        return [module['file'], '-test.run=^' + job['name'] + '$', '-test.count=1', '-test.v', '-test.timeout=25s']
    return [str(GRAPH.NODE), '--stack-size=8192', '--max-old-space-size=192', str(SOURCE / (job['kind'] + '.mjs')), source_id, job['id'], source_sha]


def validate_child(receipt, source_id, job, source, source_sha, argv, log_bytes, counter=None, output_sha=None):
    module = source['modules']['wasm']['module']
    expected = {'schema': SCHEMA, 'sourceId': source_id, 'jobId': job['id'], 'name': job['name'],
                'nodeVersion': 'v26.12.0', 'sourceSHA256': source_sha,
                'manifestSHA256': source['modules']['wasm']['BUILD_SHA256'], 'moduleSHA256': module['sha256'],
                'runtimeSHA256': source['runtime']['sha256'], 'overlaySHA256': module['overlaySHA256'], 'sourceSetSHA256': module['sourceSetSHA256'],
                'nodeArgv': argv, 'goArgv': [module['file'], '-test.run=^' + job['name'] + '$', '-test.count=1', '-test.v', '-test.timeout=25s'],
                'goExit': 0, 'goExited': True, 'failure': None}
    io = receipt.get('io', {})
    if set(receipt) != set(expected) | {'io', 'counterReceipt', 'outputSHA256', 'counterBUILD_SHA256'} or any(receipt.get(key) != value for key, value in expected.items()):
        raise ValueError('exact actual argv/module/GoJS provenance refused')
    common = {'file', 'flags', 'mode', 'bytes', 'logBytes', 'opened', 'everOpened', 'closed', 'failure', 'requests'}
    if job['kind'] == 'unit':
        common.add('openAttempts')
    if (io.get('file') != '/aurialis-private-fixture/rate' + str(job.get('rate', 8000)) + '.bin' or io.get('mode') != 0o600 or io.get('flags') != os.O_WRONLY | os.O_CREAT | os.O_EXCL):
        raise ValueError('closed exact file flags/mode refused')
    if set(io) != common or io.get('failure') is not None or io.get('opened') is not False or io.get('logBytes') != log_bytes or not isinstance(io.get('requests'), list) or len(io['requests']) > 256:
        raise ValueError('closed GoJS IO schema/completion refused')
    if job['kind'] == 'unit':
        if (io.get('openAttempts') != 0 or io.get('bytes') != 0 or io.get('everOpened') is not False or io.get('closed') is not False
                or any(item.get('operation') not in ('write', 'writeSync', 'fstat') or item.get('fd') not in (0, 1, 2) or item.get('result') != 'ok' for item in io['requests'])
                or any(receipt.get(key) is not None for key in ('counterReceipt', 'outputSHA256', 'counterBUILD_SHA256'))):
            raise ValueError('log-only unit IO refused')
    elif (receipt.get('counterReceipt') != counter or receipt.get('outputSHA256') != output_sha or receipt.get('counterBUILD_SHA256') != source['counterBUILD']['sha256']
          or io.get('everOpened') is not True or io.get('closed') is not True or io.get('bytes') != counter['outputBytes']
          or any(item.get('result') != 'ok' for item in io['requests'])):
        raise ValueError('closed recorder IO/counter completion refused')


def validate_result(directory, source_id, source, job):
    output = directory / 'runs' / job['id']
    module = source['modules'][job['backend']]['module']
    source_sha = digest(directory / 'SOURCE.json')
    argv = child_argv(source_id, job, source_sha, module)
    parent = read_json(output / 'parent-exit.json', 16 * DISK.KIB)
    NATIVE.validate_parent(parent, 28, True)
    if parent['argv'] != argv:
        raise ValueError('actual parent argv differs')
    log = read(output / 'child.log', GUARD.LOG_CAP)
    if len(log) != parent['logBytes']:
        raise ValueError('whole raw log differs')
    result = {'scope': 'original whole unit or finite same-backend recorder only; no timing/selection', 'job': job,
              'sourceSHA256': source_sha, 'module': module, 'parent': parent, 'logSHA256': digest(output / 'child.log'),
              'parentSHA256': digest(output / 'parent-exit.json'), 'runtimeProcessEnv': runtime_env(job, output)}
    counter = output_sha = None
    if job['kind'] == 'unit':
        result['logAdmission'] = UNIT.validate_log(log.decode(), job['name'])
    else:
        result['logAdmission'] = recorder_log(log.decode())
        counter = PAIR.validate_counter(log.decode(), job['rate'], source['nativeCounterReceipts'][str(job['rate'])])
        stream = output / ('rate' + str(job['rate']) + '.bin')
        PAIR.validate_output(stream, counter)
        output_sha = digest(stream)
        reference = read_json(PLAN)['recorder']['sameBackendReferences'][job['backend']][str(job['rate'])]
        comparisons = [PAIR.SUPERVISOR.compare_streams(stream, ROOT / file) for file in (reference['qualifiedBaselineStream'], reference['acceptedE492Archive']['file'])]
        if not all(item['byteEqual'] for item in comparisons):
            raise ValueError('candidate differs from same-backend baseline/archive')
        result.update({'counter': counter, 'outputSHA256': output_sha, 'sameBackendComparisons': comparisons})
    if job['backend'] == 'wasm':
        child = read_json(output / 'receipt.json', 128 * DISK.KIB)
        validate_child(child, source_id, job, source, source_sha, argv, len(log), counter, output_sha)
        result['childSHA256'] = digest(output / 'receipt.json')
    return result


def recorder_log(text):
    name = 'TestWriteStudioExtremaGraphFixtures'
    if (not text.endswith('\nPASS\n') or re.search(r'--- (?:FAIL|SKIP):|^FAIL|panic:|fatal error:|WARNING:|no tests to run', text, re.M)
            or re.findall(r'^=== RUN   (\S+)$', text, re.M) != [name] or re.findall(r'^--- PASS: (\S+) \([0-9.]+s\)$', text, re.M) != [name]):
        raise ValueError('exact27-case recorder log refused')
    return {'started': [name], 'passed': [name], 'skipped': 0}


def runtime_env(job, output):
    if job['backend'] == 'native' and job['kind'] == 'recorder':
        return {'GOMAXPROCS': '1', 'AURIALIS_STUDIO_EXTREMA_RATE': str(job['rate']), 'AURIALIS_STUDIO_EXTREMA_FIXTURES': str(output), 'TMPDIR': str(output)}
    return {'PATH': str(GRAPH.NODE.parent), 'GOMAXPROCS': '1', 'TMPDIR': '/aurialis-private-fixture'}


def report_secondary(primary, phase, secondary):
    # Python3.9 compatible; never mask the original exception if stderr fails.
    try:
        sys.stderr.write(json.dumps({'primaryFailure': {'type': type(primary).__name__, 'message': str(primary)[:256]},
                         'secondaryFailure': {'phase': phase, 'type': type(secondary).__name__, 'message': str(secondary)[:256]}}) + '\n')
    except BaseException:
        pass


def run(source_id, coordination, job_id):
    directory, source = read_source(source_id)
    gate = budget(directory, coordination, source)
    job = next_job(directory, source, job_id)
    module = source['modules'][job['backend']]['module']
    argv = child_argv(source_id, job, digest(directory / 'SOURCE.json'), module)
    output = directory / 'runs' / job['id']
    env = runtime_env(job, output)
    gate.publish('ACTIVE.lock', (job['id'] + '\n').encode())
    primary = None
    try:
        gate.json('claims/' + job['id'] + '.json', job)
        output.mkdir(mode=0o700, parents=True)
        reader = GUARD.rss_reader()  # Setup before spawn; frozen guard owns all post-Popen operations.
        gate.check('child-transaction:' + job['id'])
        GUARD.bounded_unit(argv, output, env, reader, seconds=28)
        result = validate_result(directory, source_id, source, job)
        read_source(source_id)
        gate.json('runs/' + job['id'] + '/ACCEPTED.json', result)
    except BaseException as cause:
        primary = cause
        try:
            gate.json('runs/' + job['id'] + '/REJECTED.json', {'job': job, 'primaryFailure': {'type': type(cause).__name__, 'message': str(cause)[:512]}})
        except BaseException as publication:
            report_secondary(cause, 'failure-publication', publication)
        raise
    finally:
        try:
            (directory / 'ACTIVE.lock').unlink()
        except BaseException as cleanup:
            if primary is None:
                raise
            report_secondary(primary, 'lock-cleanup', cleanup)
    print(job_id, 'accepted; owned child settled; no timing')


def seal(source_id, coordination):
    directory, source = read_source(source_id)
    gate = budget(directory, coordination, source)
    if (directory / 'ACTIVE.lock').exists():
        raise ValueError('owned child lock still present')
    proofs = []
    for job in source['jobs']:
        if read_json(directory / 'claims' / (job['id'] + '.json')) != job:
            raise ValueError('fixed claim set differs')
        result = validate_result(directory, source_id, source, job)
        accepted = read_json(directory / 'runs' / job['id'] / 'ACCEPTED.json')
        if any(accepted.get(key) != value for key, value in result.items()):
            raise ValueError('retained actual admission differs')
        proofs.append({'job': job, 'acceptedSHA256': digest(directory / 'runs' / job['id'] / 'ACCEPTED.json')})
    gate.json('QUALIFICATION.json', {'scope': '36 original whole units +10 same-backend27-case recorders only', 'proofs': proofs,
              'existing192kSteady': 'RED', 'crossTargetFullState': 'UNPROVEN', 'candidate': 'unselected', 'historicalCompilerHashes': source['historicalCompilerHashes']})
    index = {'files': {str(file.relative_to(directory)): {'bytes': file.stat().st_size, 'sha256': digest(file)} for file in sorted(directory.rglob('*')) if file.is_file() and file.name != 'disk.jsonl'}, 'journal': 'excluded from self-changing index; hash externally after final publication'}
    gate.json('ALL-SHA256.json', index)


if __name__ == '__main__':
    if sys.argv[1:] == ['admit']:
        snapshot = source_snapshot()
        print('Source only:', len(snapshot['runnerFiles']), 'inputs;', len(snapshot['ledger']), 'fixed file slots;', DISK.remaining(PROOF / 'absent-ledger-only', snapshot['ledger']), 'complete new-write demand bytes')
    elif len(sys.argv) == 4 and sys.argv[1] in ('freeze', 'seal'):
        {'freeze': freeze, 'seal': seal}[sys.argv[1]](identifier(sys.argv[2]), sys.argv[3])
    elif len(sys.argv) == 5 and sys.argv[1] == 'run':
        run(identifier(sys.argv[2]), sys.argv[3], identifier(sys.argv[4]))
    else:
        raise SystemExit('usage: host.py admit | freeze NEW_SOURCE_ID COORDINATION | run SOURCE_ID COORDINATION EXACT_JOB_ID | seal SOURCE_ID COORDINATION; actual children need separate release')
