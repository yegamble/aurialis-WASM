"""Closed source-only GoJS candidate host; execution needs Chair release."""
# cspell:ignore GOMAXPROCS GOFLAGS GOWORK CGO GOEXPERIMENT GOWASM GOARM GOVERSION GOTOOLDIR GOTOOLCHAIN gojs RDONLY CLOEXEC fstat
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import stat
import sys

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
ROOT = SOURCE.parents[4]
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-bound-hoist-wasm'
SCHEMA = 'bound-coordinate-gojs-v1'
FILES = {'host.py', 'child.mjs', 'inspect-bound.py', 'source-contract.test.py', 'README.md'}
PLAN = SOURCE.with_name('envelope_bound_hoist_wasm_plan')
PLAN_INDEX_SHA = '87e68550eb1c9c8d1a7596a20494affb13a5dae8625921c239dcaaab358c3133'
NATIVE_BUILD = 'bound-hoist-native-v2'
NATIVE_BUILD_SHA = 'dd08ea0709c3096cba91d7091839be10f0322c9f56dac517a20324cb05a55d64'
NATIVE_INDEX_SHA = 'd671be5fbd0161cad6a3b72bb3d0571d4d8b4580c86f3ca22e38c63011f35652'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


NATIVE = load('bound_native_frozen', SOURCE.with_name('envelope_bound_hoist') / 'producer.py')
INSPECT = load('bound_static_inspection', SOURCE / 'inspect-bound.py')
GRAPH, GUARD = NATIVE.GRAPH, NATIVE.GUARD
digest, write_json, identifier = NATIVE.digest, NATIVE.write_json, NATIVE.identifier
TEST, NODE = NATIVE.TEST, GRAPH.NODE
GO = pathlib.Path('/Users/yosefgamble/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.10.darwin-arm64/bin/go')


def read_json(file, cap=256 * 1024):
    return INSPECT.PARSER.decode_json(INSPECT.PARSER.bounded_bytes(file, cap))


def check_index(file, expected):
    raw = INSPECT.PARSER.bounded_bytes(file, 256 * 1024)
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('immutable evidence index differs')
    index = INSPECT.PARSER.decode_json(raw)
    for name, entry in index['files'].items():
        relative = pathlib.PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('evidence index path refused')
        target = file.parent / name
        if entry['bytes'] == 0:
            before = target.lstat()
            descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(before.st_mode) or not stat.S_ISREG(opened.st_mode) or before.st_size != 0 or (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mode, opened.st_ctime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mode, before.st_ctime_ns):
                    raise ValueError('empty evidence file admission refused')
                data = os.read(descriptor, 1)
                after = os.fstat(descriptor)
                if data or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (0, opened.st_mtime_ns, opened.st_ctime_ns):
                    raise ValueError('empty evidence file changed')
            finally:
                os.close(descriptor)
        else:
            data = INSPECT.PARSER.bounded_bytes(target, 16 * 1024 * 1024)
        if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('immutable evidence bytes differ')
    return index


def source_snapshot():
    if {p.name for p in SOURCE.iterdir()} != FILES or any(p.is_symlink() for p in SOURCE.iterdir()):
        raise ValueError('closed five-file GoJS host inventory differs')
    directory, build = NATIVE.read_build(NATIVE_BUILD)
    if digest(directory / 'BUILD.json') != NATIVE_BUILD_SHA:
        raise ValueError('accepted native BUILD differs')
    check_index(directory / 'NATIVE-SHA256.json', NATIVE_INDEX_SHA)
    check_index(NATIVE.PROOF / 'wasm-plan-v1/SOURCE-SHA256.json', PLAN_INDEX_SHA)
    plan = read_json(PLAN / 'PLAN.json')
    frozen_plan = NATIVE.PROOF / 'wasm-plan-v1' / str((PLAN / 'PLAN.json').relative_to(ROOT))
    if digest(PLAN / 'PLAN.json') != digest(frozen_plan):
        raise ValueError('held plan source differs')
    native_source = read_json(directory / 'SOURCE.json')
    toolchain = read_json(directory / 'read-only-code/TOOLCHAIN-OBSERVATION.json')
    selected = toolchain['selectedEnvironment']
    pins = {name: entry for name, entry in toolchain['executables'].items() if name != build['goExecutable']}
    for name, entry in pins.items():
        file = pathlib.Path(name)
        if file.is_symlink() or file.stat().st_size != entry['bytes'] or digest(file) != entry['sha256']:
            raise ValueError('native-selected Go/compiler/link/runtime bytes differ')
    if str(GO) not in pins or selected['GOVERSION'] != 'go1.26.10':
        raise ValueError('direct selected driver binding refused')
    mapping = native_source['mapping']
    if plan['source']['mapping'] != mapping or plan['futureDirectUnit']['name'] != TEST:
        raise ValueError('exact eight-entry final overlay/test differs')
    runners = dict(native_source['runnerFiles'])
    for folder in (SOURCE, PLAN):
        runners.update({str(p.relative_to(ROOT)): digest(p) for p in sorted(folder.iterdir()) if p.is_file()})
    for relative in ('internal/audio/dsp/testdata/envelope_node_visit_units/unit-io.mjs', 'internal/audio/dsp/testdata/envelope_node_visit_units/wasm-unit.mjs', 'internal/audio/dsp/testdata/envelope_node_visit_profile_host/profile-parser.py'):
        runners[relative] = digest(ROOT / relative)
    decoder = plan['inspection']['decoderPins']
    if digest(ROOT / decoder['source']) != decoder['sourceSHA256']:
        raise ValueError('sealed signed-immediate decoder source differs')
    runners[decoder['source']] = decoder['sourceSHA256']
    if len(runners) != 44:
        raise ValueError('closed44-source input inventory differs')
    for name, sha in INSPECT.PINS.items():
        if digest(INSPECT.TOOL / name) != sha:
            raise ValueError('pinned decoder emitter source differs')
    return {'schema': SCHEMA, 'test': TEST, 'nativeBUILD_SHA256': NATIVE_BUILD_SHA, 'nativeSourceSHA256': digest(directory / 'SOURCE.json'),
            'runnerFiles': runners, 'runnerCount': len(runners), 'mapping': mapping, 'effectiveSourceSet': native_source['effectiveSourceSet'],
            'baseline': plan['baseline'], 'work': native_source['work'], 'runtime': native_source['runtime'],
            'selectedToolchain': selected, 'toolchainPins': pins, 'emitterPins': INSPECT.PINS,
            'historicalCompilerHashes': 'UNRECORDED; no retrospective byte identity claim'}


def freeze(source_id):
    snapshot = source_snapshot()
    PROOF.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = PROOF / identifier(source_id)
    directory.mkdir(mode=0o700)
    for name, sha in snapshot['runnerFiles'].items():
        target = directory / 'source-frozen' / (name + '.source' if name.endswith('.go') else name)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
        if digest(target) != sha:
            raise ValueError('source freeze differs')
    write_json(directory / 'SOURCE.json', snapshot)
    # Re-run the unchanged old inventory AFTER writing evidence, too.
    if source_snapshot() != snapshot:
        raise ValueError('post-freeze source/inventory differs')
    print('GoJS source binding frozen; no compiler or WASM instance')


def read_source(source_id):
    directory = PROOF / identifier(source_id)
    snapshot = read_json(directory / 'SOURCE.json')
    if snapshot != source_snapshot():
        raise ValueError('frozen GoJS source binding differs')
    for name, sha in snapshot['runnerFiles'].items():
        file = directory / 'source-frozen' / (name + '.source' if name.endswith('.go') else name)
        if file.is_symlink() or digest(file) != sha:
            raise ValueError('frozen host dependency differs')
    return directory, snapshot


def expected_env(overlay):
    return {**GRAPH.expected_env('wasm', overlay), 'GOTOOLCHAIN': 'local'}


def build(source_id):
    directory, source = read_source(source_id)
    write_json(directory / 'COMPILE-CLAIM.json', {'scope': 'one candidate compiler; no retries', 'sourceSHA256': digest(directory / 'SOURCE.json')})
    manifest = {'schema': SCHEMA, 'scope': 'one candidate WASM build; no baseline rebuild', 'sourceSHA256': digest(directory / 'SOURCE.json')}
    try:
        overlay = directory / 'candidate-overlay.json'
        write_json(overlay, {'Replace': source['mapping']})
        write_json(directory / 'candidate-source-set.json', source['effectiveSourceSet'])
        expected = expected_env(overlay)
        env = {**os.environ, **expected}
        effective = json.loads(subprocess.check_output([str(GO), 'env', '-json', *[key for key in expected if key != 'GOMAXPROCS'], 'GOVERSION', 'GOROOT', 'GOTOOLDIR'], cwd=ROOT, env=env, text=True))
        for key, value in {**{key: value for key, value in expected.items() if key != 'GOMAXPROCS'}, **{key: source['selectedToolchain'][key] for key in ('GOVERSION', 'GOROOT', 'GOTOOLDIR')}}.items():
            if effective.get(key) != value:
                raise ValueError('selected compiler/effective environment differs')
        file = directory / 'candidate.wasm'
        output = directory / 'compile'
        output.mkdir(mode=0o700)
        argv = [str(GO), 'test', '-c', '-o', str(file), './internal/audio/dsp']
        manifest.update({'schema': SCHEMA, 'scope': 'one candidate WASM build; no baseline rebuild', 'sourceSHA256': digest(directory / 'SOURCE.json'),
                    'argv': argv, 'compilerProcessEnv': expected, 'effectiveGoEnv': effective, 'toolchainPins': source['toolchainPins'], 'runtime': source['runtime']})
        result = GUARD.bounded_unit(argv, output, env, GUARD.rss_reader(), seconds=25)
        manifest['parent'] = result
        write_json(output / 'RESULT.json', manifest)
        NATIVE.validate_parent(result, 25, False)
        data = INSPECT.PARSER.bounded_bytes(file, 16 * 1024 * 1024)
        if data[:8] != b'\0asm\x01\0\0\0' or read_source(source_id)[1] != source:
            raise ValueError('actual WASM/source admission refused')
        manifest['module'] = {'file': str(file), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'overlaySHA256': digest(overlay), 'sourceSetSHA256': digest(directory / 'candidate-source-set.json')}
        write_json(directory / 'BUILD.json', manifest)
    except BaseException as cause:
        write_json(directory / 'BUILD-ERROR.json', {'partial': manifest, 'error': {'type': type(cause).__name__, 'message': str(cause)[:512]}})
        raise


def read_build(source_id):
    directory, source = read_source(source_id)
    build = read_json(directory / 'BUILD.json')
    entry = build['module']
    data = INSPECT.PARSER.bounded_bytes(directory / 'candidate.wasm', 16 * 1024 * 1024)
    expected = expected_env(directory / 'candidate-overlay.json')
    if (build['schema'] != SCHEMA or build['sourceSHA256'] != digest(directory / 'SOURCE.json') or build['toolchainPins'] != source['toolchainPins']
            or build['runtime'] != source['runtime'] or build['compilerProcessEnv'] != expected
            or entry['file'] != str(directory / 'candidate.wasm') or entry['bytes'] != len(data) or entry['sha256'] != hashlib.sha256(data).hexdigest()
            or entry['overlaySHA256'] != digest(directory / 'candidate-overlay.json') or entry['sourceSetSHA256'] != digest(directory / 'candidate-source-set.json')
            or read_json(directory / 'candidate-overlay.json') != {'Replace': source['mapping']} or read_json(directory / 'candidate-source-set.json') != source['effectiveSourceSet']):
        raise ValueError('exact candidate WASM build binding differs')
    for key, value in {**{key: value for key, value in expected.items() if key != 'GOMAXPROCS'}, **{key: source['selectedToolchain'][key] for key in ('GOVERSION', 'GOROOT', 'GOTOOLDIR')}}.items():
        if build['effectiveGoEnv'].get(key) != value:
            raise ValueError('retained compiler environment differs')
    NATIVE.validate_parent(build['parent'], 25, False)
    return directory, source, build


def validate_child(receipt, source_id, source_sha, build_sha, module, runtime, argv, log_bytes):
    expected_keys = {'schema', 'scope', 'sourceId', 'name', 'nodeVersion', 'sourceSHA256', 'manifestSHA256', 'moduleSHA256', 'runtimeSHA256', 'sourceSetSHA256', 'overlaySHA256', 'nodeArgv', 'goArgv', 'goExit', 'goExited', 'failure', 'io'}
    io = receipt.get('io', {})
    if set(receipt) != expected_keys or not isinstance(io, dict) or set(io) != {'file', 'flags', 'mode', 'bytes', 'logBytes', 'opened', 'everOpened', 'closed', 'failure', 'requests', 'openAttempts'} or not isinstance(io['requests'], list) or len(io['requests']) > 256:
        raise ValueError('closed child/IO schema refused')
    if (receipt.get('schema') != SCHEMA or receipt.get('sourceId') != source_id or receipt.get('name') != TEST or receipt.get('nodeVersion') != 'v26.12.0'
            or receipt.get('sourceSHA256') != source_sha or receipt.get('manifestSHA256') != build_sha or receipt.get('moduleSHA256') != module['sha256']
            or receipt.get('runtimeSHA256') != runtime['sha256'] or receipt.get('sourceSetSHA256') != module['sourceSetSHA256'] or receipt.get('overlaySHA256') != module['overlaySHA256']
            or receipt.get('nodeArgv') != argv or receipt.get('goArgv') != [module['file'], '-test.run=^' + TEST + '$', '-test.count=1', '-test.v', '-test.timeout=25s']
            or receipt.get('goExit') != 0 or receipt.get('goExited') is not True or receipt.get('failure') is not None
            or io.get('failure') is not None or io.get('openAttempts') != 0 or io.get('everOpened') is not False or io.get('opened') is not False or io.get('closed') is not False or io.get('bytes') != 0
            or io.get('logBytes') != log_bytes or not 1 <= log_bytes <= GUARD.LOG_CAP
            or any(item.get('operation') not in ('write', 'writeSync', 'fstat') or item.get('fd') not in (0, 1, 2) or item.get('result') != 'ok' for item in io.get('requests', []))):
        raise ValueError('exact closed log-only GoJS receipt refused')


def run(source_id):
    directory, source, build = read_build(source_id)
    output = directory / 'unit'
    output.mkdir(mode=0o700)
    argv = [str(NODE), '--stack-size=8192', '--max-old-space-size=192', str(SOURCE / 'child.mjs'), source_id]
    env = {'PATH': str(NODE.parent), 'GOMAXPROCS': '1', 'TMPDIR': '/aurialis-private-fixture'}
    partial = {'scope': 'one exact direct GoJS oracle/allocation unit; no graph/timing', 'argv': argv, 'runtimeProcessEnv': env, 'module': build['module']}
    try:
        result = GUARD.bounded_unit(argv, output, env, GUARD.rss_reader(), seconds=28)
        partial['parent'] = result
        NATIVE.validate_parent(result, 28, True)
        partial['logAdmission'] = NATIVE.validate_log((output / 'child.log').read_text())
        receipt = read_json(output / 'receipt.json', 128 * 1024)
        validate_child(receipt, source_id, digest(directory / 'SOURCE.json'), digest(directory / 'BUILD.json'), build['module'], source['runtime'], argv, result['logBytes'])
        partial['receiptSHA256'] = digest(output / 'receipt.json')
        partial['logSHA256'] = digest(output / 'child.log')
        read_build(source_id)
        write_json(output / 'ACCEPTED.json', partial)
    except BaseException as cause:
        write_json(output / 'REJECTED.json', {**partial, 'error': {'type': type(cause).__name__, 'message': str(cause)[:512]}})
        raise


def inspect(source_id):
    directory, source, build = read_build(source_id)
    read_json(directory / 'unit/ACCEPTED.json')
    output = directory / 'inspection'
    output.mkdir(mode=0o700)
    reports = []
    for label, module in (('baseline', source['baseline']['wasm']), ('candidate', build['module'])):
        raw, report = INSPECT.inspect(pathlib.Path(module['file']), module['sha256'], module['bytes'])
        (output / (label + '-bound.body')).write_bytes(raw)
        reports.append(report)
    report = {'scope': 'read-only exact-name emitted-code review; no additional WASM instance', 'reports': reports, 'comparison': INSPECT.compare(*reports)}
    data = (json.dumps(report, indent=2) + '\n').encode()
    if len(data) > INSPECT.REPORT_CAP:
        raise ValueError('bounded code report refused')
    with (output / 'REPORT.json').open('xb') as stream:
        stream.write(data)
    if not report['comparison']['shapeConsistentWithProposedHoist']:
        raise ValueError('ineffective/unknown emitted shape retained; no full-chain admission')


if __name__ == '__main__':
    if sys.argv[1:] == ['admit']:
        snapshot = source_snapshot()
        print('Source-only GoJS admission:', snapshot['runnerCount'], 'bound inputs; no compiler/instance')
    elif len(sys.argv) == 3 and sys.argv[1] in ('freeze', 'build', 'run', 'inspect'):
        {'freeze': freeze, 'build': build, 'run': run, 'inspect': inspect}[sys.argv[1]](identifier(sys.argv[2]))
    else:
        raise SystemExit('usage: host.py admit | freeze NEW_ID | build ID | run ID | inspect ID; execution requires Chair release')
