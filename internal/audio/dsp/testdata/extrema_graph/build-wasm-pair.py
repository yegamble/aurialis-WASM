"""Explicit private module build step; execute only after the parent's build ruling."""
# cspell:ignore NONPACKAGE GOMAXPROCS GOFLAGS GOWORK CGO GOEXPERIMENT GOWASM
import hashlib
import importlib.util
import sys
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[5]
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/exact-extrema-wasm-graph-runner'
NATIVE = ROOT / 'artifacts/private-dsp/recovery-20261023/exact-extrema-graph-candidate'
SOURCE = pathlib.Path(__file__).resolve().parent
NATIVE_INDEX_SHA256 = '20af02a3b482e5ed68e5e11aa209d38517afb71a4e17af777beec9446ac953c8'
NONPACKAGE_INDEX_SHA256 = '69a29af7ec5fb5c79e289b8048c72c884bdac8a23826d420b547af8cfaeb10ee'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build():
    if os.environ.get('GOEXPERIMENT', '') or subprocess.check_output(['go', 'env', 'GOEXPERIMENT'], text=True).strip():
        raise ValueError('nonempty effective GOEXPERIMENT not qualified')
    if digest(NATIVE / 'SHA256.json') != NATIVE_INDEX_SHA256:
        raise ValueError('accepted native index changed')
    provenance = json.loads((NATIVE / 'SOURCE-PROVENANCE.json').read_text())
    for item in provenance['productionFiles']:
        if digest(ROOT / item['file']) != item['candidateSHA256']:
            raise ValueError('qualified candidate source changed')
    for item in provenance['excludedARFiles']:
        if digest(ROOT / item['file']) != item['sha256']:
            raise ValueError('frozen excluded AR source changed')
    inventory_file = PROOF / 'NONPACKAGE-GO-INVENTORY.json'
    if digest(inventory_file) != NONPACKAGE_INDEX_SHA256:
        raise ValueError('frozen nonpackage Go evidence inventory changed')
    nonpackage = json.loads(inventory_file.read_text())['files']
    all_untracked = set(subprocess.check_output(['git', 'ls-files', '--others', '*.go'], cwd=ROOT, text=True).splitlines())
    expected_untracked = set(item['file'] for item in nonpackage + provenance['excludedARFiles'])
    if all_untracked != expected_untracked:
        raise ValueError('unexpected untracked Go source, including ignored/testdata paths')
    for item in nonpackage:
        if digest(ROOT / item['file']) != item['sha256']:
            raise ValueError('historical nonpackage Go evidence changed')
    expected_candidate = {str(ROOT / item['file']): '' for item in provenance['excludedARFiles']}
    expected_baseline = dict(expected_candidate)
    for item in provenance['productionFiles']:
        frozen = NATIVE / 'baseline-source' / pathlib.Path(item['file']).name
        if digest(frozen) != item['baselineSHA256']:
            raise ValueError('qualified frozen baseline source differs')
        expected_baseline[str(ROOT / item['file'])] = str(frozen)
    overlay_files = {'baseline': NATIVE / 'baseline-overlay.json', 'candidate': ROOT / 'artifacts/private-dsp/recovery-20261023/partitioned-detector-lint-overlay.json'}
    for label, expected in [('baseline', expected_baseline), ('candidate', expected_candidate)]:
        overlay = json.loads(overlay_files[label].read_text())
        if set(overlay) != {'Replace'} or overlay['Replace'] != expected:
            raise ValueError('private overlay exact14/6 mapping differs')
    current = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    qualified = 'e4921560a63666ac230bb578d5381886b266d968'
    if subprocess.check_output(['git', 'diff', qualified, '--', '*.go', 'go.mod'], cwd=ROOT):
        raise ValueError('qualified private Go source content differs')
    untracked = set(subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '*.go'], cwd=ROOT, text=True).splitlines())
    if untracked != set(item['file'] for item in provenance['excludedARFiles']):
        raise ValueError('unexpected untracked Go inputs')
    version = subprocess.check_output(['go', 'version'], text=True).strip()
    if 'go1.26.10 ' not in version:
        raise ValueError('pinned Go1.26.10 required')
    goroot = pathlib.Path(subprocess.check_output(['go', 'env', 'GOROOT'], text=True).strip())
    runtime = goroot / 'lib/wasm/wasm_exec.js'
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('private_supervisor', SOURCE / 'run-wasm-pair.py')
    supervisor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)
    PROOF.mkdir(mode=0o700, parents=True, exist_ok=True)
    modules = PROOF / 'modules'
    modules.mkdir(mode=0o700)  # Fresh build only; preserve earlier module evidence.
    tracked = subprocess.check_output(['git', 'ls-files', '*.go'], cwd=ROOT, text=True).splitlines()
    manifest = {'scope': 'private exact-extrema actual GoJS/WASM graph semantics only',
                'goVersion': version, 'goSourceCheckpoint': qualified, 'runnerGitCheckpoint': current,
                'nativeIndexSHA256': NATIVE_INDEX_SHA256, 'nonpackageGoIndexSHA256': NONPACKAGE_INDEX_SHA256,
                'recorderSHA256': digest(ROOT / 'internal/audio/dsp/studio_extrema_graph_fixture_test.go'),
                'runtime': {'path': str(runtime), 'sha256': digest(runtime)}, 'modules': {},
                'runnerFiles': {p.name: digest(p) for p in sorted(SOURCE.iterdir()) if p.is_file()}}
    overlays = overlay_files
    for label, overlay in overlays.items():
        replacements = json.loads(overlay.read_text())['Replace']
        inputs = []
        for file in tracked:
            actual = replacements.get(str(ROOT / file), str(ROOT / file))
            if actual:
                inputs.append({'file': file, 'effectiveSHA256': digest(pathlib.Path(actual))})
        inputs_bytes = (json.dumps({'scope': 'conservative tracked-Go-source superset, not a compiler dependency listing', 'files': inputs}, indent=2) + '\n').encode()
        (PROOF / (label + '-source-set.json')).write_bytes(inputs_bytes)
        module = modules / (label + '.wasm')
        argv = ['go', 'test', '-c', '-o', str(module), './internal/audio/dsp']
        env = os.environ.copy()
        env.update({'GOOS': 'js', 'GOARCH': 'wasm', 'GOMAXPROCS': '1', 'CGO_ENABLED': '0', 'GOWORK': 'off', 'GOEXPERIMENT': '', 'GOFLAGS': '-overlay=' + str(overlay)})
        effective = json.loads(subprocess.check_output(['go', 'env', '-json', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOWORK', 'GOEXPERIMENT', 'GOFLAGS', 'GOWASM'], cwd=ROOT, env=env, text=True))
        if effective.get('GOEXPERIMENT') or effective.get('CGO_ENABLED') != '0' or effective.get('GOWORK') != 'off':
            raise ValueError('effective compiler environment differs from qualified flags')
        compile_directory = PROOF / (label + '-compile')
        compile_directory.mkdir(mode=0o700)
        supervised = supervisor.bounded_child(argv, compile_directory, seconds=25, env=env)
        receipt = {'argv': argv, 'env': {key: env[key] for key in ('GOOS', 'GOARCH', 'GOMAXPROCS', 'CGO_ENABLED', 'GOWORK', 'GOEXPERIMENT', 'GOFLAGS')}, 'effectiveGoEnv': effective, 'supervised': supervised, 'exit': supervised['exit']}
        with (PROOF / (label + '-compile-exit.json')).open('x') as out:
            json.dump(receipt, out, indent=2)
            out.write('\n')
        if supervised['exit'] != 0 or supervised['failure'] is not None or supervised['cleanupFailure'] is not None:
            raise RuntimeError('private GoJS module compile failed; process-group receipt retained')
        for item in inputs:
            actual = replacements.get(str(ROOT / item['file']), str(ROOT / item['file']))
            if digest(pathlib.Path(actual)) != item['effectiveSHA256']:
                raise ValueError('qualified source changed during compile')
        if module.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('private module16MiB cap exceeded')
        manifest['modules'][label] = {'file': str(module), 'sha256': digest(module), 'bytes': module.stat().st_size,
                                      'overlaySHA256': digest(overlay), 'sourceSetSHA256': hashlib.sha256(inputs_bytes).hexdigest()}
    with (PROOF / 'BUILD-PROVENANCE.json').open('x') as out:
        json.dump(manifest, out, indent=2)
        out.write('\n')
    print('private baseline/candidate GoJS modules built and source/runtime hash-bound; no graph execution')


if __name__ == '__main__':
    build()
