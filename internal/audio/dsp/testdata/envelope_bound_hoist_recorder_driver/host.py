"""Fixed eight recorders only; source review precedes actual execution release."""
# cspell:ignore GOMAXPROCS CLOEXEC RDONLY fstat lstat WRONLY CREAT
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import sys

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
FILES = {'host.py', 'source-contract.test.py', 'README.md'}
SPEC = importlib.util.spec_from_file_location('admitted_recorder_policy', SOURCE.with_name('envelope_bound_hoist_recorder_admission') / 'admission.py')
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)
OLD = POLICY.HOST
ROOT, GUARD, DISK = OLD.ROOT, OLD.GUARD, OLD.DISK
NATIVE, UNIT, PAIR, PLAN = OLD.NATIVE, OLD.UNIT, OLD.PAIR, OLD.PLAN
read_json, digest, read = OLD.read_json, OLD.digest, OLD.read
child_argv, runtime_env, recorder_log = OLD.child_argv, OLD.runtime_env, OLD.recorder_log
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-bound-hoist-recorder-continuation'
DRIVER = PROOF / 'source-v1'
LEGACY_ID = 'recorder-cont-v1'
LEGACY = OLD.PROOF / LEGACY_ID
SOURCE_SHA = '66b73fb4c12f909e5395ec4c516964c7a54ae60248b1de1b9716eaf8d139ee73'
POLICY_PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-bound-hoist-recorder-admission/source-v1'
POLICY_SOURCE_SHA = '575df387e5b01a948b06d3eab7164c35d404d82f25ee60ff99aaf75e3d0e6781'
ANALYSIS_SHA = 'f1e9b52054611df26fe15e1c903cca9b159930cca2b886ff8648cd6fdc5531cd'
RED_INDEX = OLD.PROOF / 'RED-V2-SHA256.json'
RED_SHA = 'a973b6f5fef9c14afd0c64eb4f2d49a22522789453206e1dc43df1ae8ea01eb3'
JOBS = tuple('recorder-' + backend + '-' + str(rate) for rate in (44100, 48000, 96000, 192000) for backend in ('native', 'wasm'))
META_CHARGE = 4 * DISK.MIB  # Part of existing64MiB concurrent source allowance.


def source_snapshot():
    if {file.name for file in SOURCE.iterdir()} != FILES or any(file.is_symlink() for file in SOURCE.iterdir()):
        raise ValueError('closed three-file driver inventory differs')
    _, legacy_source = OLD.read_source('source-v2')
    if digest(OLD.PROOF / 'source-v2/SOURCE.json') != SOURCE_SHA or len(legacy_source['runnerFiles']) != 56:
        raise ValueError('immutable56-input legacy source differs')
    if digest(POLICY_PROOF / 'SOURCE.json') != POLICY_SOURCE_SHA or digest(POLICY_PROOF / 'CORRECTED-WASM8000-ANALYSIS.json') != ANALYSIS_SHA or digest(RED_INDEX) != RED_SHA:
        raise ValueError('admitted policy/old evidence pins differ')
    accepted = read_json(POLICY_PROOF / 'SOURCE.json')
    policy_files = accepted['files']
    if len(policy_files) != 4 or any(file.is_symlink() for file in POLICY.SOURCE.iterdir()) or {file.name for file in POLICY.SOURCE.iterdir()} != {pathlib.Path(name).name for name in policy_files}:
        raise ValueError('immutable four-file policy inventory differs')
    if any(digest(ROOT / name) != sha for name, sha in policy_files.items()):
        raise ValueError('admitted policy bytes differ')
    plan = read_json(POLICY.SOURCE / 'PLAN.json')
    if plan['remainingJobs'] != list(JOBS):
        raise ValueError('exact eight-job plan differs')
    own = {str(file.relative_to(ROOT)): digest(file) for file in sorted(SOURCE.iterdir())}
    frozen = {'source-frozen/host/' + pathlib.Path(name).name: name for name in own}
    frozen.update({'source-frozen/policy/' + pathlib.Path(name).name: name for name in policy_files})
    return {'schema': 'fixed8-recorder-driver-v1', 'scope': 'eight remaining recorder children only; original36 and both8000 processes reused',
            'files': {**own, **policy_files}, 'frozen': frozen, 'legacyId': LEGACY_ID, 'legacySourceSHA256': SOURCE_SHA,
            'legacy56Inputs': legacy_source['runnerFiles'], 'modules': legacy_source['modules'], 'runtime': legacy_source['runtime'],
            'jobs': [job for name in JOBS for job in legacy_source['jobs'] if job['id'] == name],
            'oldREDIndexSHA256': RED_SHA, 'existingWASM8000AnalysisSHA256': ANALYSIS_SHA,
            'metadataChargeBytes': META_CHARGE, 'python': {'executable': sys.executable, 'version': sys.version, 'flagsObservation': str(sys.flags)}}


def metadata_slots():
    slots = {'SOURCE.json': 256 * DISK.KIB, 'PREPARED.json': 64 * DISK.KIB, 'PREPARE-ERROR.json': 64 * DISK.KIB,
             'COMBINED.json': 128 * DISK.KIB, 'META-SHA256.json': 128 * DISK.KIB}
    slots.update({'source-frozen/host/' + name: 128 * DISK.KIB for name in FILES})
    slots.update({'source-frozen/policy/' + name: 128 * DISK.KIB for name in ('admission.py', 'PLAN.json', 'README.md', 'source-contract.test.py')})
    for name in JOBS:
        slots['invocations/' + name + '-START.json'] = 8 * DISK.KIB
        slots['invocations/' + name + '-SETTLED.json'] = 16 * DISK.KIB
    return slots


def audit_metadata():
    slots = metadata_slots()
    directories = {'.'} | {str(parent) for name in slots for parent in pathlib.PurePosixPath(name).parents if str(parent) != '.'}
    reserve = sum(cap + (-cap) % (64 * DISK.KIB) + 4 * DISK.KIB for cap in slots.values()) + len(directories) * 64 * DISK.KIB
    if reserve > META_CHARGE:
        raise ValueError('metadata allocation reserve exceeds source allowance charge')
    if DRIVER.exists():
        if DRIVER.is_symlink() or not DRIVER.is_dir():
            raise ValueError('metadata root must be a regular directory')
        for file in DRIVER.rglob('*'):
            name = file.relative_to(DRIVER).as_posix()
            info = file.lstat()
            if stat.S_ISDIR(info.st_mode) and name in directories:
                continue
            if not stat.S_ISREG(info.st_mode) or name not in slots or info.st_size > slots[name]:
                raise ValueError('closed finite metadata inventory/cap refused')
    return reserve


def publish(name, value, gate, raw=False):
    data = value if raw else (json.dumps(value, indent=2) + '\n').encode()
    if name not in metadata_slots() or not isinstance(data, bytes) or len(data) > metadata_slots()[name]:
        raise ValueError('finite metadata publication cap refused')
    audit_metadata()
    gate.check('new-driver-publication:' + name)
    file = DRIVER / name
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)


def prepare(coordination):
    snapshot = source_snapshot()
    if DRIVER.exists() or LEGACY.exists():
        raise ValueError('one fixed fresh preparation only; partials cannot be retried')
    # Existing unchanged freezer owns its source-only transaction and preserves failures.
    OLD.freeze(LEGACY_ID, coordination)
    directory, legacy_source = OLD.read_source(LEGACY_ID)
    if digest(directory / 'SOURCE.json') != SOURCE_SHA:
        raise ValueError('fresh unchanged56 child binding differs')
    gate = OLD.budget(directory, coordination, legacy_source)
    DRIVER.mkdir(mode=0o700, parents=True)
    try:
        for name, original in snapshot['frozen'].items():
            publish(name, read(ROOT / original, 128 * DISK.KIB), gate, raw=True)
        publish('SOURCE.json', snapshot, gate)
        if source_snapshot() != snapshot:
            raise ValueError('new host/policy/dependencies changed during preparation')
        publish('PREPARED.json', {'sourceSHA256': digest(DRIVER / 'SOURCE.json'), 'legacySourceSHA256': SOURCE_SHA,
                'legacyId': LEGACY_ID, 'jobs': list(JOBS), 'scope': 'source preparation only; no actual child'}, gate)
    except BaseException as cause:
        try:
            publish('PREPARE-ERROR.json', {'primaryFailure': {'type': type(cause).__name__, 'message': str(cause)[:512]}}, gate)
        except BaseException as publication:
            OLD.report_secondary(cause, 'prepare-failure-publication', publication)
        raise


def read_prepared():
    audit_metadata()
    snapshot = read_json(DRIVER / 'SOURCE.json')
    if snapshot != source_snapshot():
        raise ValueError('executed new host/policy/dependency binding differs')
    for name, original in snapshot['frozen'].items():
        if digest(DRIVER / name) != snapshot['files'][original]:
            raise ValueError('frozen new host/policy bytes differ')
    prepared = read_json(DRIVER / 'PREPARED.json')
    if prepared.get('sourceSHA256') != digest(DRIVER / 'SOURCE.json') or prepared.get('legacySourceSHA256') != SOURCE_SHA or prepared.get('jobs') != list(JOBS):
        raise ValueError('fixed prepared identity differs')
    directory, legacy_source = OLD.read_source(LEGACY_ID)
    if digest(directory / 'SOURCE.json') != SOURCE_SHA:
        raise ValueError('actual child source binding differs')
    return snapshot, directory, legacy_source


def admit_completed(directory, source, legacy_source, job):
    output = directory / 'runs' / job['id']
    claim = directory / 'claims' / (job['id'] + '.json')
    start_file = DRIVER / ('invocations/' + job['id'] + '-START.json')
    settled_file = DRIVER / ('invocations/' + job['id'] + '-SETTLED.json')
    if not all(file.is_file() for file in (claim, output / 'ACCEPTED.json', start_file, settled_file)):
        raise ValueError('prior raw/host settlement incomplete; no advancement')
    if (output / 'REJECTED.json').exists() or read_json(claim) != {'job': job, 'driverSourceSHA256': digest(DRIVER / 'SOURCE.json')}:
        raise ValueError('prior RED/claim identity differs')
    result = validate_recording(directory, LEGACY_ID, legacy_source, job)
    accepted = read_json(output / 'ACCEPTED.json')
    provenance = accepted.get('executedNewHost', {})
    validate_provenance(source, job, provenance)
    if (accepted != {**result, 'executedNewHost': provenance}
            or read_json(start_file) != {'job': job, 'executedNewHost': provenance}
            or read_json(settled_file) != {'job': job, 'disposition': 'accepted', 'executedNewHost': provenance,
                'primaryFailure': None, 'cleanupFailure': None, 'parentReceiptPresent': True, 'rawAcceptedPresent': True}):
        raise ValueError('prior raw result or exact accepted host settlement differs')
    return result


def fixed_scope(directory, complete=False):
    for folder, expected, is_directory in (
            (directory / 'claims', {name + '.json' for name in JOBS}, False),
            (directory / 'runs', set(JOBS), True)):
        names = set()
        if folder.exists():
            if folder.is_symlink() or not folder.is_dir():
                raise ValueError('fixed8 evidence root refused')
            for file in folder.iterdir():
                if file.is_symlink() or (not file.is_dir() if is_directory else not file.is_file()):
                    raise ValueError('fixed8 evidence type refused')
                names.add(file.name)
        if not names <= expected or (complete and names != expected):
            raise ValueError('only exact fixed eight claims/output directories permitted')


def next_job(directory, source, legacy_source, wanted):
    fixed_scope(directory)
    claims = directory / 'claims'
    for job in source['jobs']:
        claim = claims / (job['id'] + '.json')
        output = directory / 'runs' / job['id']
        if (output / 'REJECTED.json').exists():
            raise ValueError('prior RED retained; no retry/continuation')
        if claim.exists():
            admit_completed(directory, source, legacy_source, job)
            continue
        if job['id'] != wanted:
            raise ValueError('exact next one of eight jobs required')
        return job
    raise ValueError('all fixed eight already claimed; no extra job')


def host_provenance(source):
    return {'hostFile': str(SOURCE / 'host.py'), 'hostSHA256': source['files'][str((SOURCE / 'host.py').relative_to(ROOT))],
            'policyFile': str(POLICY.SOURCE / 'admission.py'), 'policySHA256': source['files'][str((POLICY.SOURCE / 'admission.py').relative_to(ROOT))],
            'driverSourceSHA256': digest(DRIVER / 'SOURCE.json'), 'legacySourceSHA256': SOURCE_SHA,
            'actualPythonExecutable': sys.executable, 'actualPythonVersion': sys.version, 'interpreterFlagsObservation': str(sys.flags),
            'observedPythonScriptArgv': list(sys.argv), 'argvScope': 'script argv only; interpreter options are observed separately, complete command retained by external launch receipt'}


def validate_provenance(source, job, provenance):
    expected = host_provenance(source)
    for key in expected.keys() - {'observedPythonScriptArgv'}:
        if provenance.get(key) != expected[key]:
            raise ValueError('executed new host/policy/interpreter identity differs')
    argv = provenance.get('observedPythonScriptArgv')
    if (not isinstance(argv, list) or len(argv) != 4 or pathlib.Path(argv[0]).resolve() != SOURCE / 'host.py'
            or argv[1:3] != ['run', job['id']] or not isinstance(argv[3], str)):
        raise ValueError('actual recorded new host argv differs')


def validate_recording(directory, source_id, source, job):
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
        POLICY.validate_recorder(child, source_id, job, source, source_sha, argv, len(log), counter, output_sha)
        result['childSHA256'] = digest(output / 'receipt.json')
    return result


def run(wanted, coordination):
    source, directory, legacy_source = read_prepared()
    job = next_job(directory, source, legacy_source, wanted)
    gate = OLD.budget(directory, coordination, legacy_source)
    provenance = host_provenance(source)
    output = directory / 'runs' / job['id']
    argv = child_argv(LEGACY_ID, job, SOURCE_SHA, source['modules'][job['backend']]['module'])
    env = runtime_env(job, output)
    gate.publish('ACTIVE.lock', (job['id'] + '\n').encode())
    primary = cleanup = None

    def summary(cause):
        return None if cause is None else {'type': type(cause).__name__, 'message': str(cause)[:512]}

    def retain_rejection(cause):
        if (output / 'REJECTED.json').exists():
            return
        try:
            gate.json('runs/' + wanted + '/REJECTED.json', {'job': job, 'executedNewHost': provenance, 'primaryFailure': summary(cause)})
        except BaseException as publication:
            OLD.report_secondary(cause, 'raw-rejection-publication', publication)

    try:
        gate.json('claims/' + job['id'] + '.json', {'job': job, 'driverSourceSHA256': provenance['driverSourceSHA256']})
        publish('invocations/' + wanted + '-START.json', {'job': job, 'executedNewHost': provenance}, gate)
        output.mkdir(mode=0o700, parents=True)
        resident = GUARD.rss_reader()  # Frozen guard owns every post-Popen operation.
        gate.check('fixed8-child-transaction:' + wanted)
        GUARD.bounded_unit(argv, output, env, resident, seconds=28)
        result = validate_recording(directory, LEGACY_ID, legacy_source, job)
        if read_prepared()[0] != source:
            raise ValueError('new host/policy/old child inputs changed after actual admission')
        gate.json('runs/' + wanted + '/ACCEPTED.json', {**result, 'executedNewHost': provenance})
    except BaseException as cause:
        primary = cause
        retain_rejection(cause)
    finally:
        try:
            (directory / 'ACTIVE.lock').unlink()
        except BaseException as cause:
            cleanup = cause
            primary = primary or cause
            retain_rejection(primary)
        # Publish one final host disposition after lock cleanup. Raw parent and
        # GoJS receipts stay untouched; a separate cleanup failure remains RED.
        try:
            publish('invocations/' + wanted + '-SETTLED.json', {'job': job, 'disposition': 'accepted' if primary is None else 'RED',
                    'executedNewHost': provenance, 'primaryFailure': summary(primary), 'cleanupFailure': summary(cleanup),
                    'parentReceiptPresent': (output / 'parent-exit.json').exists(), 'rawAcceptedPresent': (output / 'ACCEPTED.json').exists()}, gate)
        except BaseException as publication:
            if primary is None:
                primary = publication
                retain_rejection(publication)
            else:
                OLD.report_secondary(primary, 'host-settlement-publication', publication)
    if primary is not None:
        raise primary
    print(wanted, 'accepted; owned child settled; distinct new host/policy provenance')


def verify_old_index():
    if digest(RED_INDEX) != RED_SHA:
        raise ValueError('old RED index changed')
    index = read_json(RED_INDEX)
    for name, expected in index['files'].items():
        relative = pathlib.PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('old evidence path refused')
        file = ROOT / name
        before = file.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size != expected['bytes'] or not 0 <= before.st_size <= 16 * DISK.MIB:
            raise ValueError('old bounded regular evidence refused')
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(descriptor, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            data = stream.read(expected['bytes'] + 1)
            after = os.fstat(stream.fileno())
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mode, value.st_mtime_ns, value.st_ctime_ns)
        if identity(before) != identity(opened) or identity(opened) != identity(after) or len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
            raise ValueError('old raw evidence bytes/identity changed')
    return index


def seal(coordination):
    source, directory, legacy_source = read_prepared()
    if (directory / 'ACTIVE.lock').exists():
        raise ValueError('owned child lock remains')
    gate = OLD.budget(directory, coordination, legacy_source)
    fixed_scope(directory, complete=True)
    reports = []
    for job in source['jobs']:
        admit_completed(directory, source, legacy_source, job)
        reports.append({'job': job, 'acceptedSHA256': digest(directory / 'runs' / job['id'] / 'ACCEPTED.json')})
    verify_old_index()  # Read-only integrity check, not a rerun of36units or8000 recorders.
    if digest(POLICY_PROOF / 'CORRECTED-WASM8000-ANALYSIS.json') != ANALYSIS_SHA:
        raise ValueError('separate originalWASM8000 admission changed')
    publish('COMBINED.json', {'scope': 'combined scoped qualification; NOT a uniform46-child single pass',
            'priorActual': {'sourceId': 'source-v2', 'sourceSHA256': SOURCE_SHA, 'originalUnits': 36, 'native8000': 'old gate admitted',
                            'WASM8000': 'old gate RED; separately admitted read-only policy analysis', 'rawREDIndexSHA256': RED_SHA, 'newPolicyAnalysisSHA256': ANALYSIS_SHA},
            'newEight': {'legacySourceId': LEGACY_ID, 'legacySourceSHA256': SOURCE_SHA, 'driverSourceSHA256': digest(DRIVER / 'SOURCE.json'), 'reports': reports},
            'casesPerBackend': 135, 'sameBackendArchiveRule': 'all ten complete finite streams compare to both own-backend sealed references',
            'existing192kSteady': 'RED', 'crossTargetFullState': 'UNPROVEN', 'candidate': 'unselected', 'historicalBaselineCompilerHashes': 'UNRECORDED'}, gate)
    files = [file for file in DRIVER.rglob('*') if file.is_file()]
    publish('META-SHA256.json', {'files': {str(file.relative_to(DRIVER)): {'bytes': file.stat().st_size, 'sha256': digest(file)} for file in sorted(files)},
            'externalSealRequired': 'include all legacy raw files and FINAL appended disk journal after this last publication'}, gate)


if __name__ == '__main__':
    if sys.argv[1:] == ['admit']:
        snapshot = source_snapshot()
        print('Source only:', len(snapshot['files']), 'separate new host/policy inputs; old56 unchanged; metadata reserve', audit_metadata(), 'of4MiB; no runtime')
    elif len(sys.argv) == 3 and sys.argv[1] in ('prepare', 'seal'):
        {'prepare': prepare, 'seal': seal}[sys.argv[1]](sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == 'run' and sys.argv[2] in JOBS:
        run(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit('usage: host.py admit | prepare COORDINATION | run EXACT_NEXT_JOB COORDINATION | seal COORDINATION; fixed8 only; actual execution requires separate release')
