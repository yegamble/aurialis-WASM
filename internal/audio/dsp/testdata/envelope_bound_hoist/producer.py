"""Inactive exact-bound native producer; one build/unit needs Chair release."""
# cspell:ignore GOMAXPROCS GOFLAGS GOWORK CGO GOEXPERIMENT GOWASM GOARM ESRCH
import hashlib
import errno
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
ROOT = SOURCE.parents[4]
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-bound-hoist'
PRODUCTION = 'internal/audio/dsp/studio_gain_envelope.go'
VIRTUAL_TEST = 'internal/audio/dsp/studio_bound_hoist_control_test.go'
ORIGINAL_SHA = '9ceee3af867bc992d89dfdd8a778c35648fd140a0a5a84bdfecf2d0ed3d19c5d'
CANDIDATE_SHA = 'a5ff75b66b649116857effe11fde78749edad3201ed964741cdc137d7967018a'
BASE_BUILD = 'node-visit-build-v1'
BASE_BUILD_SHA = '16aacd5935e4bee8c9e253d926f9fe2d5dfbc2179f68b62b5b7e3d1195fde6f8'
TEST = 'TestStudioEnvelopeBoundCoordinateOracleAndNoAlloc'
FILES = {'producer.py', 'native-guard.py', 'source-contract.test.py', 'README.md', 'PLAN.json', 'studio_gain_envelope.go.source', 'bound_query_test.go.source'}


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GRAPH = load('bound_native_graph', SOURCE.with_name('envelope_node_visit_graph') / 'producer.py')
UNIT = load('bound_original_unit', SOURCE.with_name('envelope_node_visit_units') / 'run-unit.py')
GUARD = load('bound_native_guard', SOURCE / 'native-guard.py')
digest = GRAPH.digest
write_json = GRAPH.write_json
identifier = GRAPH.identifier


def candidate_from_original(data):
    declaration = b'\tx := int(frame % studioEnvelopeChunk)\n'
    expression = b'n.slope*float64(x)+n.offset'
    if data.count(declaration) != 1 or data.count(expression) != 1 or b'xFloat' in data:
        raise ValueError('closed original bound expression refused')
    return data.replace(declaration, declaration + b'\txFloat := float64(x)\n').replace(expression, b'n.slope*xFloat+n.offset')


def check_oracle(original, test):
    prefix = b'// BEGIN FROZEN ORIGINAL\n'
    suffix = b'\n// END FROZEN ORIGINAL\n'
    if test.count(prefix) != 1 or test.count(suffix) != 1:
        raise ValueError('closed independent control markers refused')
    actual = test.split(prefix)[1].split(suffix)[0]
    expected = original.removeprefix(b'package dsp\n\n').replace(b'studioEnvelopeChunk', b'boundHoistFrozenChunk').replace(b'studioEnvelopeLine', b'boundHoistFrozenLine').replace(b'studioGainEnvelope', b'boundHoistFrozenEnvelope')
    if actual != expected:
        raise ValueError('independent original full control changed')


def source_snapshot():
    if {p.name for p in SOURCE.iterdir()} != FILES or any(p.is_symlink() for p in SOURCE.iterdir()):
        raise ValueError('closed bound candidate source inventory differs')
    original = (ROOT / PRODUCTION).read_bytes()
    candidate = (SOURCE / 'studio_gain_envelope.go.source').read_bytes()
    if hashlib.sha256(original).hexdigest() != ORIGINAL_SHA or hashlib.sha256(candidate).hexdigest() != CANDIDATE_SHA or candidate_from_original(original) != candidate:
        raise ValueError('exact two-line bound candidate differs')
    check_oracle(original, (SOURCE / 'bound_query_test.go.source').read_bytes())
    base_dir, base = GRAPH.read_manifest(BASE_BUILD)
    if digest(base_dir / 'BUILD.json') != BASE_BUILD_SHA:
        raise ValueError('sealed baseline BUILD differs')
    mapping = dict(base['snapshot']['baseline'])
    if len(mapping) != 6 or any(value != '' for value in mapping.values()) or (ROOT / VIRTUAL_TEST).exists():
        raise ValueError('exact six AR exclusions or virtual source admission differs')
    mapping.update({str(ROOT / PRODUCTION): str(SOURCE / 'studio_gain_envelope.go.source'), str(ROOT / VIRTUAL_TEST): str(SOURCE / 'bound_query_test.go.source')})
    names = [*base['snapshot']['qualifiedFiles'], VIRTUAL_TEST]
    runners = dict(base['snapshot']['runnerFiles'])
    runners[str(UNIT.SOURCE.relative_to(ROOT) / 'run-unit.py')] = digest(UNIT.SOURCE / 'run-unit.py')
    for folder in (SOURCE, SOURCE.with_name('envelope_bound_hoist_proposal')):
        runners.update({str(p.relative_to(ROOT)): digest(p) for p in sorted(folder.iterdir()) if p.is_file()})
    return {'originalSHA256': ORIGINAL_SHA, 'candidateSHA256': CANDIDATE_SHA, 'baseBUILD': {'file': str(base_dir / 'BUILD.json'), 'sha256': BASE_BUILD_SHA},
            'baselineModules': {key: base['modules'][key]['baseline'] for key in GRAPH.BACKENDS}, 'runtime': base['runtime'],
            'mapping': mapping, 'effectiveSourceSet': GRAPH.PREPARE.effective_source_set(names, mapping), 'runnerFiles': runners,
            'test': TEST, 'work': json.loads((SOURCE / 'PLAN.json').read_text())['work']}


def validate_parent(receipt, seconds, require_log):
    resident = receipt.get('resident', {})
    observation = receipt.get('exitObservation')
    if observation is not None and (observation.get('errno') != errno.ESRCH or observation.get('priorRSSSamples', 0) < 1 or not 0 < observation.get('waitLimitSeconds', 0) <= GUARD.POLL or observation.get('confirmedExit') != receipt.get('exit') or observation.get('confirmationFailure') is not None or observation.get('pipeEOF') is not True):
        raise ValueError('unconfirmed resident exit observation refused')
    if (receipt.get('stdoutEOF') is not True or receipt.get('spawned') is not True or receipt.get('exit') != 0 or any(receipt.get(key) is not None for key in ('failure', 'primaryFailure', 'cleanupFailure', 'processGroupSignal')) or receipt.get('wallLimitSeconds') != seconds or receipt.get('logCapBytes') != GUARD.LOG_CAP or not int(require_log) <= receipt.get('logBytes', -1) <= GUARD.LOG_CAP or resident.get('samples', 0) < 1 or resident.get('capBytes') != GUARD.RSS_CAP or resident.get('pollSeconds') != GUARD.POLL or resident.get('instantaneousHardCeilingClaim') is not False or not 1 <= resident.get('maxObservedBytes', 0) <= GUARD.RSS_CAP):
        raise ValueError('bounded native parent refused')


def validate_log(text):
    if not text.endswith('\nPASS\n') or re.search(r'--- (?:FAIL|SKIP):|^FAIL|panic:|fatal error:|WARNING:|no tests to run', text, re.M):
        raise ValueError('unit failure/skip/incomplete log refused')
    if re.findall(r'^=== RUN   (\S+)$', text, re.M) != [TEST] or re.findall(r'^--- PASS: (\S+) \([0-9.]+s\)$', text, re.M) != [TEST]:
        raise ValueError('exact direct oracle test admission refused')
    counter = 'batches562 stateScans1686 pairedQueries4911 allocationCalls576 nodesPerScan8192 fieldComparisons41435136 boundCalls10398 nodeVisitUpper124776'
    if text.count(counter) != 1:
        raise ValueError('exact bounded query/state counters refused')
    return {'test': TEST, 'counters': counter, 'skips': 0}


def build(build_id):
    snapshot = source_snapshot()
    if subprocess.check_output(['go', 'version'], text=True).strip() != 'go version go1.26.10 darwin/arm64' or os.environ.get('GOEXPERIMENT', '') or subprocess.check_output(['go', 'env', 'GOEXPERIMENT'], text=True).strip():
        raise ValueError('pinned Go1.26.10 with empty experiments required')
    if subprocess.check_output([str(GRAPH.NODE), '--version'], text=True).strip() != 'v26.12.0':
        raise ValueError('pinned Node26 required')
    PROOF.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = PROOF / identifier(build_id)
    directory.mkdir(mode=0o700)
    for name, sha in snapshot['runnerFiles'].items():
        target = directory / 'source-frozen' / (name + '.source' if name.endswith('.go') else name)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
        if digest(target) != sha:
            raise ValueError('frozen runner/source differs')
    write_json(directory / 'SOURCE.json', snapshot)
    overlay = directory / 'candidate-overlay.json'
    write_json(overlay, {'Replace': snapshot['mapping']})
    write_json(directory / 'candidate-source-set.json', snapshot['effectiveSourceSet'])
    env_flags = GRAPH.expected_env('native', overlay)
    env = {**os.environ, **env_flags}
    effective = json.loads(subprocess.check_output(['go', 'env', '-json', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOWORK', 'GOEXPERIMENT', 'GOWASM', 'GOARM64', 'GOFLAGS'], cwd=ROOT, env=env, text=True))
    GRAPH.validate_env(effective, env_flags)
    file = directory / 'native-candidate.test'
    output = directory / 'compile'
    output.mkdir(mode=0o700)
    argv = ['go', 'test', '-c', '-o', str(file), './internal/audio/dsp']
    manifest = {'scope': 'one inactive native candidate build; no baseline rebuild/WASM/graph/profile/timing', 'sourceSHA256': digest(directory / 'SOURCE.json'), 'gitCheckpoint': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(), 'goVersion': 'go version go1.26.10 darwin/arm64', 'goExecutable': str(pathlib.Path(shutil.which('go')).resolve()), 'goExecutableSHA256': digest(pathlib.Path(shutil.which('go')).resolve()), 'nodeVersion': 'v26.12.0', 'compilerProcessEnv': env_flags, 'effectiveGoEnv': effective, 'runtime': snapshot['runtime'], 'argv': argv}
    try:
        result = GUARD.bounded_unit(argv, output, env, GUARD.rss_reader(), seconds=25)
        manifest['parent'] = result
        write_json(output / 'RESULT.json', manifest)
        validate_parent(result, 25, False)
        if file.is_symlink() or not 1 <= file.stat().st_size <= 16 * 1024 * 1024:
            raise ValueError('native module16MiB cap refused')
        if source_snapshot() != snapshot:
            raise ValueError('source changed during build')
        manifest['module'] = {'file': str(file), 'bytes': file.stat().st_size, 'sha256': digest(file), 'overlaySHA256': digest(overlay), 'sourceSetSHA256': digest(directory / 'candidate-source-set.json')}
        write_json(directory / 'BUILD.json', manifest)
    except BaseException as cause:
        write_json(directory / 'BUILD-ERROR.json', {'type': type(cause).__name__, 'message': str(cause)[:512], 'partial': manifest})
        raise
    print('One native candidate module retained; no unit/WASM/graph/timing execution')


def read_build(build_id):
    directory = PROOF / identifier(build_id)
    source = UNIT.read_json(directory / 'SOURCE.json')
    manifest = UNIT.read_json(directory / 'BUILD.json')
    if source != source_snapshot() or manifest['sourceSHA256'] != digest(directory / 'SOURCE.json'):
        raise ValueError('frozen native source differs')
    for name, sha in source['runnerFiles'].items():
        frozen = directory / 'source-frozen' / (name + '.source' if name.endswith('.go') else name)
        if frozen.is_symlink() or digest(frozen) != sha:
            raise ValueError('frozen runtime host source differs')
    GRAPH.validate_env(manifest['effectiveGoEnv'], GRAPH.expected_env('native', directory / 'candidate-overlay.json'))
    if manifest['compilerProcessEnv'] != GRAPH.expected_env('native', directory / 'candidate-overlay.json') or manifest['runtime'] != source['runtime'] or json.loads((directory / 'candidate-overlay.json').read_text()) != {'Replace': source['mapping']} or json.loads((directory / 'candidate-source-set.json').read_text()) != source['effectiveSourceSet']:
        raise ValueError('actual compiler/environment/source mappings differ')
    module = manifest['module']
    file = directory / 'native-candidate.test'
    if module['file'] != str(file) or file.is_symlink() or not 1 <= file.stat().st_size <= 16 * 1024 * 1024 or file.stat().st_size != module['bytes'] or digest(file) != module['sha256'] or digest(directory / 'candidate-overlay.json') != module['overlaySHA256'] or digest(directory / 'candidate-source-set.json') != module['sourceSetSHA256']:
        raise ValueError('frozen candidate module/source binding differs')
    return directory, manifest


def unit(build_id):
    directory, manifest = read_build(build_id)
    output = directory / 'direct-unit'
    output.mkdir(mode=0o700)
    env = {'PATH': str(GRAPH.NODE.parent), 'GOMAXPROCS': '1', 'TMPDIR': '/aurialis-private-fixture'}
    argv = [manifest['module']['file'], '-test.run=^' + TEST + '$', '-test.count=1', '-test.v', '-test.timeout=25s']
    partial = {'scope': 'one native direct oracle/noalloc unit only', 'argv': argv, 'module': manifest['module'], 'sourceSHA256': manifest['sourceSHA256'], 'buildSHA256': digest(directory / 'BUILD.json'), 'runtimeProcessEnv': env}
    try:
        result = GUARD.bounded_unit(argv, output, env, GUARD.rss_reader(), seconds=28)
        partial['parent'] = result
        validate_parent(result, 28, True)
        partial['logAdmission'] = validate_log((output / 'child.log').read_text())
        partial['logSHA256'] = digest(output / 'child.log')
        read_build(build_id)
        write_json(output / 'ACCEPTED.json', partial)
    except BaseException as cause:
        write_json(output / 'REJECTED.json', {**partial, 'error': {'type': type(cause).__name__, 'message': str(cause)[:512]}})
        raise
    print('Native direct oracle/noalloc unit admitted; WASM/fullgraph/original candidate gates pending')


if __name__ == '__main__':
    if sys.argv[1:] == ['admit']:
        source_snapshot()
        print('Inactive bound source contract admitted; no compilation/execution')
    elif len(sys.argv) == 3 and sys.argv[1] in ('build', 'unit'):
        (build if sys.argv[1] == 'build' else unit)(identifier(sys.argv[2]))
    else:
        raise SystemExit('usage: producer.py admit | build NEW_ID | unit BUILT_ID; separate Chair release required')
