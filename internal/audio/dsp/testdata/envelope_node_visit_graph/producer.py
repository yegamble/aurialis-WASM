"""SOURCE ONLY fullgraph producer; building requires a later Chair release."""
# cspell:ignore GOMAXPROCS GOFLAGS GOWORK CGO GOEXPERIMENT GOWASM GOARM
import importlib.util
import json
import os
import pathlib
import subprocess
import sys

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
ROOT = SOURCE.parents[4]
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-graph'
SPEC = importlib.util.spec_from_file_location('reviewed_node_visit_source', SOURCE.with_name('envelope_node_visit') / 'producer.py')
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)
LEGACY = PREPARE.LEGACY
SHARED = LEGACY.SHARED
NODE = LEGACY.NODE
FILES = {'producer.py', 'run-pair.py', 'wasm-child.mjs', 'source-contract.test.py', 'README.md'}
RATES = (8000, 44100, 48000, 96000, 192000)
LABELS = ('baseline', 'candidate')
BACKENDS = ('native', 'wasm')
digest = PREPARE.digest
write_json = PREPARE.write_json
identifier = PREPARE.identifier


def source_snapshot():
    prepared = PREPARE.source_snapshot()
    # Preserve the original frozen inventory: all new Go payloads stay .source.
    if {p.name for p in SOURCE.iterdir() if p.is_file()} != FILES or any(p.is_symlink() for p in SOURCE.iterdir()):
        raise ValueError('closed fullgraph runner inventory changed')
    runner = dict(prepared['runnerFiles'])
    runner.update({str(p.relative_to(ROOT)): digest(p) for p in sorted(SOURCE.iterdir()) if p.is_file()})
    return {**prepared, 'runnerFiles': runner}


def archived(backend, rate):
    if backend not in BACKENDS or rate not in RATES:
        raise ValueError('closed archive backend/rate refused')
    if backend == 'native':
        return LEGACY.NATIVE / 'candidate-native-final' / ('rate' + str(rate) + '.bin')
    return LEGACY.OLD / 'runs/post-exit-first' / ('candidate-rate' + str(rate)) / ('rate' + str(rate) + '.bin')


def expected_env(backend, overlay):
    if backend not in BACKENDS:
        raise ValueError('closed compiler backend refused')
    return {'GOOS': 'js' if backend == 'wasm' else 'darwin', 'GOARCH': 'wasm' if backend == 'wasm' else 'arm64',
            'CGO_ENABLED': '0', 'GOMAXPROCS': '1', 'GOWORK': 'off', 'GOEXPERIMENT': '',
            'GOWASM': '', 'GOARM64': 'v8.0', 'GOFLAGS': '-overlay=' + str(overlay)}


def validate_env(actual, expected):
    for key in ('GOOS', 'GOARCH', 'CGO_ENABLED', 'GOWORK', 'GOEXPERIMENT', 'GOWASM', 'GOARM64', 'GOFLAGS'):
        if actual.get(key) != expected[key]:
            raise ValueError('effective compiler flag differs: ' + key)


def expected_mapping(snapshot, label):
    if label not in LABELS:
        raise ValueError('closed source label refused')
    mapping = snapshot[label]
    if len(mapping) != (6 if label == 'baseline' else 7):
        raise ValueError('exact6/7 overlay admission changed')
    return mapping


def validate_source_files(directory, snapshot):
    for label in LABELS:
        mapping = expected_mapping(snapshot, label)
        if json.loads((directory / (label + '-overlay.json')).read_text()) != {'Replace': mapping}:
            raise ValueError('actual exact6/7 source mapping differs')
        expected = PREPARE.effective_source_set(snapshot['qualifiedFiles'], mapping)
        if json.loads((directory / (label + '-source-set.json')).read_text()) != expected:
            raise ValueError('actual effective source set differs')


def build(build_id):
    snapshot = source_snapshot()
    if subprocess.check_output(['go', 'version'], text=True).strip() != 'go version go1.26.10 darwin/arm64' or os.environ.get('GOEXPERIMENT', '') or subprocess.check_output(['go', 'env', 'GOEXPERIMENT'], text=True).strip():
        raise ValueError('pinned Go1.26.10 toolchain required')
    if subprocess.check_output([str(NODE), '--version'], text=True).strip() != 'v26.12.0':
        raise ValueError('pinned Node26.12.0 required')
    runtime = pathlib.Path(subprocess.check_output(['go', 'env', 'GOROOT'], text=True).strip()) / 'lib/wasm/wasm_exec.js'
    old = json.loads((LEGACY.OLD / 'BUILD-PROVENANCE-post-exit-v2.json').read_text())
    if digest(runtime) != old['runtime']['sha256']:
        raise ValueError('qualified GoJS runtime differs')
    PROOF.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = PROOF / identifier(build_id)
    directory.mkdir(mode=0o700)
    modules = directory / 'modules'
    modules.mkdir(mode=0o700)
    frozen = directory / 'source-frozen'
    frozen.mkdir(mode=0o700)
    for name, sha in snapshot['runnerFiles'].items():
        if digest(ROOT / name) != sha:
            raise ValueError('runner changed during source freeze')
        target = frozen / (name + '.source' if name.endswith('.go') else name)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    for label in LABELS:
        mapping = expected_mapping(snapshot, label)
        write_json(directory / (label + '-overlay.json'), {'Replace': mapping})
        write_json(directory / (label + '-source-set.json'), PREPARE.effective_source_set(snapshot['qualifiedFiles'], mapping))
    manifest = {'scope': 'private native/actual GoJS fullgraph semantics; no timing/public selection',
                'qualifiedGoSource': LEGACY.QUALIFIED, 'goVersion': 'go version go1.26.10 darwin/arm64', 'nodeVersion': 'v26.12.0',
                'runnerGitCheckpoint': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'snapshot': snapshot, 'runtime': {'path': str(runtime), 'sha256': digest(runtime)},
                'recorderSHA256': digest(ROOT / 'internal/audio/dsp/studio_extrema_graph_fixture_test.go'),
                'nativeCounterReceipts': {str(rate): json.loads((LEGACY.NATIVE / ('rate' + str(rate) + '-comparison.json')).read_text())['runs'][0]['receipt'] for rate in RATES},
                'archives': {backend: {str(rate): {'file': str(archived(backend, rate)), 'bytes': archived(backend, rate).stat().st_size, 'sha256': digest(archived(backend, rate))} for rate in RATES} for backend in BACKENDS},
                'modules': {backend: {} for backend in BACKENDS}}
    try:
        for backend in BACKENDS:
            for label in LABELS:
                overlay = directory / (label + '-overlay.json')
                expected = expected_env(backend, overlay)
                env = {**os.environ, **expected}
                effective = json.loads(subprocess.check_output(['go', 'env', '-json', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOWORK', 'GOEXPERIMENT', 'GOWASM', 'GOARM64', 'GOFLAGS'], cwd=ROOT, env=env, text=True))
                validate_env(effective, expected)
                file = modules / (backend + '-' + label + ('.wasm' if backend == 'wasm' else '.test'))
                output = directory / (backend + '-' + label + '-compile')
                output.mkdir(mode=0o700)
                argv = ['go', 'test', '-c', '-o', str(file), './internal/audio/dsp']
                result = LEGACY.load_supervisor().bounded_child(argv, output, seconds=25, env=env)
                write_json(output / 'RESULT.json', {'argv': argv, 'compilerProcessEnv': expected, 'effectiveGoEnv': effective, 'supervised': result})
                if result['exit'] != 0 or result['failure'] is not None or result['cleanupFailure'] is not None:
                    raise RuntimeError('bounded module compilation failed; receipt retained')
                if file.is_symlink() or not 1 <= file.stat().st_size <= 16 * 1024 * 1024:
                    raise ValueError('module16MiB cap exceeded')
                if source_snapshot() != snapshot:
                    raise ValueError('source changed during compilation')
                validate_source_files(directory, snapshot)
                manifest['modules'][backend][label] = {'file': str(file), 'bytes': file.stat().st_size, 'sha256': digest(file),
                    'overlaySHA256': digest(overlay), 'sourceSetSHA256': digest(directory / (label + '-source-set.json')), 'compilerProcessEnv': expected, 'effectiveGoEnv': effective}
        write_json(directory / 'BUILD.json', manifest)
    except Exception as error:
        write_json(directory / 'BUILD-ERROR.json', {'error': str(error)[:512], 'partialManifest': manifest})
        raise
    print('Fresh native pair and two WASM modules built; no graph/audio/timing execution')


def read_manifest(build_id):
    directory = PROOF / identifier(build_id)
    file = directory / 'BUILD.json'
    if file.is_symlink() or file.stat().st_size > 256 * 1024:
        raise ValueError('fullgraph manifest admission refused')
    manifest = json.loads(file.read_text())
    snapshot = source_snapshot()
    if manifest['snapshot'] != snapshot or manifest['qualifiedGoSource'] != LEGACY.QUALIFIED:
        raise ValueError('frozen source/runner snapshot differs')
    validate_source_files(directory, snapshot)
    old = json.loads((LEGACY.OLD / 'BUILD-PROVENANCE-post-exit-v2.json').read_text())
    counters = {str(rate): json.loads((LEGACY.NATIVE / ('rate' + str(rate) + '-comparison.json')).read_text())['runs'][0]['receipt'] for rate in RATES}
    if manifest['goVersion'] != 'go version go1.26.10 darwin/arm64' or manifest['nodeVersion'] != 'v26.12.0' or manifest['runtime'] != old['runtime'] or manifest['recorderSHA256'] != digest(ROOT / 'internal/audio/dsp/studio_extrema_graph_fixture_test.go') or manifest['nativeCounterReceipts'] != counters:
        raise ValueError('qualified toolchain/runtime/recorder/counter provenance differs')
    if digest(pathlib.Path(manifest['runtime']['path'])) != manifest['runtime']['sha256']:
        raise ValueError('frozen runtime differs')
    if set(manifest['modules']) != set(BACKENDS):
        raise ValueError('closed module backend set differs')
    for backend in BACKENDS:
        if set(manifest['modules'][backend]) != set(LABELS):
            raise ValueError('closed module pair differs')
        for label in LABELS:
            entry = manifest['modules'][backend][label]
            module = directory / 'modules' / (backend + '-' + label + ('.wasm' if backend == 'wasm' else '.test'))
            if entry['file'] != str(module) or module.is_symlink() or module.stat().st_size != entry['bytes'] or not 1 <= entry['bytes'] <= 16 * 1024 * 1024 or digest(module) != entry['sha256']:
                raise ValueError('frozen module differs')
            expected = expected_env(backend, directory / (label + '-overlay.json'))
            validate_env(entry['effectiveGoEnv'], expected)
            if entry['compilerProcessEnv'] != expected:
                raise ValueError('frozen compiler process environment differs')
            if digest(directory / (label + '-overlay.json')) != entry['overlaySHA256'] or digest(directory / (label + '-source-set.json')) != entry['sourceSetSHA256']:
                raise ValueError('frozen overlay/source set differs')
    for backend in BACKENDS:
        for rate in RATES:
            entry = manifest['archives'][backend][str(rate)]
            archive = archived(backend, rate)
            if entry != {'file': str(archive), 'bytes': archive.stat().st_size, 'sha256': digest(archive)}:
                raise ValueError('accepted e492 archived candidate bytes differ')
    for name, sha in snapshot['runnerFiles'].items():
        target = directory / 'source-frozen' / (name + '.source' if name.endswith('.go') else name)
        if digest(target) != sha:
            raise ValueError('frozen runner/source payload differs')
    return directory, manifest


if __name__ == '__main__':
    if sys.argv[1:] == ['admit']:
        source_snapshot()
        print('Fullgraph source admission passed; no build/execution')
    elif len(sys.argv) == 3 and sys.argv[1] == 'build':
        build(identifier(sys.argv[2]))
    else:
        raise SystemExit('usage: producer.py admit | build NEW_ID; build needs separate Chair release')
