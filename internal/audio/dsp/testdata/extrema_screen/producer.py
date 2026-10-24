"""Private paired-module producer; SOURCE ONLY until the parent's build ruling."""
# cspell:ignore GOMAXPROCS GOFLAGS GOWORK CGO GOEXPERIMENT GOWASM NONPACKAGE
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[5]
SOURCE = pathlib.Path(__file__).resolve().parent
SHARED = SOURCE.with_name('extrema_graph')
OLD = ROOT / 'artifacts/private-dsp/recovery-20261023/exact-extrema-wasm-graph-runner'
NATIVE = ROOT / 'artifacts/private-dsp/recovery-20261023/exact-extrema-graph-candidate'
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/extrema-paired-screen'
QUALIFIED = 'e4921560a63666ac230bb578d5381886b266d968'
EXTRA = 'internal/audio/dsp/studio_extrema_screen_test.go'
OLD_INDEX = '6a6e7a4bf9f7d8d042674ab58b97778d98f3adc5568c4c16b40d98ac0dd4e717'
NATIVE_INDEX = '20af02a3b482e5ed68e5e11aa209d38517afb71a4e17af777beec9446ac953c8'
NODE = pathlib.Path.home() / '.nvm/versions/node/v26.12.0/bin/node'
RATE = 192000


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def identifier(value):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', value):
        raise ValueError('closed private build identifier refused')
    return value


def load_supervisor():
    spec = importlib.util.spec_from_file_location('private_extrema_supervisor', SHARED / 'run-wasm-pair.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(file, value):
    with file.open('x') as out:
        json.dump(value, out, indent=2)
        out.write('\n')


def verify_index(directory, expected_sha):
    file = directory / 'SHA256.json'
    if file.is_symlink() or file.stat().st_size > 64 * 1024 or digest(file) != expected_sha:
        raise ValueError('immutable accepted evidence index changed')
    items = json.loads(file.read_text())['files']
    if len(items) > 128 or sum(item['bytes'] for item in items) > 128 * 1024 * 1024:
        raise ValueError('historical evidence inventory admission refused')
    for item in items:
        name = pathlib.PurePosixPath(item['file'])
        target = directory / name
        if name.is_absolute() or '..' in name.parts or item['bytes'] > 16 * 1024 * 1024 or target.is_symlink() or target.stat().st_size != item['bytes'] or digest(target) != item['sha256']:
            raise ValueError('indexed historical bytes changed')


def source_snapshot():
    verify_index(OLD, OLD_INDEX)
    verify_index(NATIVE, NATIVE_INDEX)
    expected_runner = {'producer.py', 'run-screen.py', 'screen-child.mjs', 'screen-contract.test.py', 'README.md'}
    if {p.name for p in SOURCE.iterdir() if p.is_file()} != expected_runner:
        raise ValueError('closed screening runner source inventory changed')
    old_manifest = json.loads((OLD / 'BUILD-PROVENANCE-post-exit-v2.json').read_text())
    for name in ('closed-fs.mjs', 'child-lifecycle.mjs', 'run-wasm-pair.py'):
        if digest(SHARED / name) != old_manifest['runnerFiles'][name]:
            raise ValueError('shared qualified harness changed')
    provenance = json.loads((NATIVE / 'SOURCE-PROVENANCE.json').read_text())
    nonpackage = json.loads((OLD / 'NONPACKAGE-GO-INVENTORY.json').read_text())['files']
    qualified_files = [name for name in subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', QUALIFIED], cwd=ROOT, text=True).splitlines() if name.endswith('.go') or name == 'go.mod']
    if EXTRA in qualified_files or not (ROOT / EXTRA).is_file():
        raise ValueError('new opt-in test admission changed')
    for name in qualified_files:
        qualified_bytes = subprocess.check_output(['git', 'show', QUALIFIED + ':' + name], cwd=ROOT)
        if (ROOT / name).read_bytes() != qualified_bytes:
            raise ValueError('qualified Go source differs: ' + name)
    tracked = set(subprocess.check_output(['git', 'ls-files', '*.go'], cwd=ROOT, text=True).splitlines())
    expected_go = {name for name in qualified_files if name.endswith('.go')}
    if tracked - {EXTRA} != expected_go:
        raise ValueError('unexpected tracked Go addition/removal')
    all_untracked = set(subprocess.check_output(['git', 'ls-files', '--others', '*.go'], cwd=ROOT, text=True).splitlines())
    expected_untracked = {item['file'] for item in nonpackage + provenance['excludedARFiles']}
    if EXTRA not in tracked:
        expected_untracked.add(EXTRA)
    if all_untracked != expected_untracked:
        raise ValueError('unexpected untracked Go source, including ignored/testdata')
    for item in nonpackage + provenance['excludedARFiles']:
        if digest(ROOT / item['file']) != item['sha256']:
            raise ValueError('frozen excluded/nonpackage source changed')
    candidate = {str(ROOT / item['file']): '' for item in provenance['excludedARFiles']}
    baseline = dict(candidate)
    for item in provenance['productionFiles']:
        if digest(ROOT / item['file']) != item['candidateSHA256']:
            raise ValueError('candidate production hash changed')
        frozen = NATIVE / 'baseline-source' / pathlib.Path(item['file']).name
        if digest(frozen) != item['baselineSHA256']:
            raise ValueError('frozen original production hash changed')
        baseline[str(ROOT / item['file'])] = str(frozen)
    overlays = {'baseline': NATIVE / 'baseline-overlay.json', 'candidate': ROOT / 'artifacts/private-dsp/recovery-20261023/partitioned-detector-lint-overlay.json'}
    for label, expected in (('baseline', baseline), ('candidate', candidate)):
        if json.loads(overlays[label].read_text()) != {'Replace': expected}:
            raise ValueError('exact14/6 original overlay changed')
    runner_files = [p for p in SOURCE.iterdir() if p.is_file()] + [SHARED / name for name in ('closed-fs.mjs', 'child-lifecycle.mjs', 'run-wasm-pair.py')] + [ROOT / EXTRA]
    return {'qualifiedFiles': qualified_files + [EXTRA], 'overlays': overlays,
            'runnerFiles': {str(p.relative_to(ROOT)): digest(p) for p in sorted(runner_files)}}


def build(build_id):
    snapshot = source_snapshot()
    version = subprocess.check_output(['go', 'version'], text=True).strip()
    if 'go1.26.10 ' not in version or os.environ.get('GOEXPERIMENT', '') or subprocess.check_output(['go', 'env', 'GOEXPERIMENT'], text=True).strip():
        raise ValueError('pinned pure-Go toolchain required')
    goroot = pathlib.Path(subprocess.check_output(['go', 'env', 'GOROOT'], text=True).strip())
    runtime = goroot / 'lib/wasm/wasm_exec.js'
    old_manifest = json.loads((OLD / 'BUILD-PROVENANCE-post-exit-v2.json').read_text())
    if digest(runtime) != old_manifest['runtime']['sha256']:
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
        # Preserve Go bytes with a non-Go suffix: never widen the ignored-Go
        # source inventory while freezing this source-only experiment.
        target = frozen / (name + '.source' if name.endswith('.go') else name)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    manifest = {'scope': 'PRIVATE paired-module screen, not public selection or realtime proof',
                'qualifiedGoSource': QUALIFIED, 'extraTest': EXTRA, 'extraTestSHA256': digest(ROOT / EXTRA),
                'runnerGitCheckpoint': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'runtime': {'path': str(runtime), 'sha256': digest(runtime)}, 'goVersion': version,
                'oldEvidenceIndexSHA256': OLD_INDEX, 'runnerFiles': snapshot['runnerFiles'], 'modules': {}}
    supervisor = load_supervisor()
    try:
        for label, overlay in snapshot['overlays'].items():
            replacement = json.loads(overlay.read_text())['Replace']
            effective = []
            for name in snapshot['qualifiedFiles']:
                actual = replacement.get(str(ROOT / name), str(ROOT / name))
                if actual:
                    effective.append({'file': name, 'sha256': digest(pathlib.Path(actual))})
            source_set = directory / (label + '-source-set.json')
            write_json(source_set, {'scope': 'tracked-Go conservative superset plus exactly one new opt-in test; not dependency listing', 'files': effective})
            module = modules / (label + '.wasm')
            env = os.environ.copy()
            env.update({'GOOS': 'js', 'GOARCH': 'wasm', 'GOMAXPROCS': '1', 'CGO_ENABLED': '0', 'GOWORK': 'off', 'GOEXPERIMENT': '', 'GOFLAGS': '-overlay=' + str(overlay)})
            compiler_env = json.loads(subprocess.check_output(['go', 'env', '-json', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOWORK', 'GOEXPERIMENT', 'GOFLAGS', 'GOWASM'], cwd=ROOT, env=env, text=True))
            if compiler_env.get('GOEXPERIMENT') or compiler_env.get('CGO_ENABLED') != '0' or compiler_env.get('GOWORK') != 'off':
                raise ValueError('effective compiler flags differ')
            compile_dir = directory / (label + '-compile')
            compile_dir.mkdir(mode=0o700)
            argv = ['go', 'test', '-c', '-o', str(module), './internal/audio/dsp']
            result = supervisor.bounded_child(argv, compile_dir, seconds=25, env=env)
            write_json(directory / (label + '-compile-exit.json'), {'argv': argv, 'effectiveGoEnv': compiler_env, 'supervised': result})
            if result['exit'] != 0 or result['failure'] is not None or result['cleanupFailure'] is not None:
                raise RuntimeError('bounded compilation failed; failure receipt retained')
            if source_snapshot()['runnerFiles'] != snapshot['runnerFiles']:
                raise ValueError('qualified producer source changed during compilation')
            if module.stat().st_size > 16 * 1024 * 1024:
                raise ValueError('module16MiB cap exceeded')
            manifest['modules'][label] = {'file': str(module), 'sha256': digest(module), 'bytes': module.stat().st_size,
                                           'overlaySHA256': digest(overlay), 'sourceSetSHA256': digest(source_set), 'effectiveGoEnv': compiler_env}
        write_json(directory / 'BUILD.json', manifest)
    except Exception as error:
        write_json(directory / 'BUILD-ERROR.json', {'error': str(error)[:512], 'partialManifest': manifest})
        raise
    print('Two frozen-source modules prepared; no graph execution or measurement')


def read_manifest(build_id):
    directory = PROOF / identifier(build_id)
    file = directory / 'BUILD.json'
    if file.is_symlink() or file.stat().st_size > 128 * 1024:
        raise ValueError('build manifest admission refused')
    manifest = json.loads(file.read_text())
    current = source_snapshot()
    if manifest['qualifiedGoSource'] != QUALIFIED or manifest['runnerFiles'] != current['runnerFiles']:
        raise ValueError('frozen source set/runner differs')
    if manifest['extraTestSHA256'] != digest(ROOT / EXTRA) or digest(pathlib.Path(manifest['runtime']['path'])) != manifest['runtime']['sha256']:
        raise ValueError('extra test/runtime hash changed')
    for label, entry in manifest['modules'].items():
        module = directory / 'modules' / (label + '.wasm')
        if label not in ('baseline', 'candidate') or str(module) != entry['file'] or module.is_symlink() or module.stat().st_size > 16 * 1024 * 1024 or digest(module) != entry['sha256']:
            raise ValueError('frozen module changed')
        if digest(current['overlays'][label]) != entry['overlaySHA256'] or digest(directory / (label + '-source-set.json')) != entry['sourceSetSHA256']:
            raise ValueError('overlay/source-set provenance changed')
    if set(manifest['modules']) != {'baseline', 'candidate'}:
        raise ValueError('closed module pair changed')
    return directory, manifest


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != 'build':
        raise SystemExit('usage: producer.py build NEW_BUILD_ID (requires explicit parent build release)')
    build(sys.argv[2])
