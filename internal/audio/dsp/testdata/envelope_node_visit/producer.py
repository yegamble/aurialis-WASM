"""Private preparation and unit controls only; no module/audio/timing entry point."""
# cspell:ignore GOMAXPROCS GOFLAGS GOWORK CGO GOEXPERIMENT
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
ROOT = SOURCE.parents[4]
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-node-visit'
PRODUCTION = 'internal/audio/dsp/studio_gain_envelope.go'
EXTRA = 'internal/audio/dsp/studio_extrema_screen_test.go'
ORIGINAL_SHA = '9ceee3af867bc992d89dfdd8a778c35648fd140a0a5a84bdfecf2d0ed3d19c5d'
CANDIDATE_SHA = 'eb8f5058d09d7d9d8c8b19b2946bc6ff5bbb1bc02d939b526a35434f46a61494'
TESTS = ('TestStudioEnvelopeNodeVisitIEEEAndFullState', 'TestStudioEnvelopeNodeVisitDirtyEpochs', 'TestStudioEnvelopeNodeVisitWrapAndClippedRebuild', 'TestStudioEnvelopeNodeVisitZeroAllocations')
FILES = {'producer.py', 'source-contract.test.py', 'README.md', 'PLAN.json', 'studio_gain_envelope.go.source', 'node_visit_test.go.source'}


def load_legacy():
    spec = importlib.util.spec_from_file_location('unchanged_private_screen_producer', SOURCE.with_name('extrema_screen') / 'producer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LEGACY = load_legacy()
digest = LEGACY.digest
write_json = LEGACY.write_json
identifier = LEGACY.identifier


def candidate_from_original(data):
    old = b'func (e *studioGainEnvelope) insertRange(tree, index, low, high, from, to int, epoch int64, slope, offset float64) {\n\te.node(tree, index, epoch)\n\tif from <= low && high <= to {\n\t\te.insertLine(tree, index, low, high, epoch, slope, offset)\n\t\treturn\n\t}\n'
    new = old.replace(b'\te.node(tree, index, epoch)\n', b'') + b'\te.node(tree, index, epoch)\n'
    if data.count(old) != 1:
        raise ValueError('single original covered-node initialization refused')
    return data.replace(old, new)


def check_oracle(original, control):
    marker = '// A fixed interval line envelope'
    expected = original.decode()[original.decode().index(marker):].replace('studioGainEnvelope', 'nodeVisitFrozenEnvelope')
    actual = control.decode()[control.decode().index(marker):control.decode().index('\nfunc nodeVisitCheck')]
    if actual != expected:
        raise ValueError('independent frozen original control body changed')


def source_snapshot():
    # Do not relax or edit the existing producer or its inventory assumptions.
    legacy = LEGACY.source_snapshot()
    if {p.name for p in SOURCE.iterdir() if p.is_file()} != FILES or any(p.is_symlink() for p in SOURCE.iterdir()):
        raise ValueError('closed node-visit runner inventory changed')
    original = (ROOT / PRODUCTION).read_bytes()
    candidate = (SOURCE / 'studio_gain_envelope.go.source').read_bytes()
    if hashlib.sha256(original).hexdigest() != ORIGINAL_SHA or hashlib.sha256(candidate).hexdigest() != CANDIDATE_SHA or candidate_from_original(original) != candidate:
        raise ValueError('exact one-line source-only candidate changed')
    check_oracle(original, (SOURCE / 'node_visit_test.go.source').read_bytes())
    plan = json.loads((SOURCE / 'PLAN.json').read_text())
    if plan['qualifiedGoSource'] != LEGACY.QUALIFIED or plan['originalProductionSHA256'] != ORIGINAL_SHA or plan['candidateProductionSHA256'] != CANDIDATE_SHA:
        raise ValueError('closed source plan changed')
    initial = pathlib.Path(plan['initialChairEvidence']['directory'])
    for item in plan['initialChairEvidence']['files']:
        target = initial / item['file']
        if target.is_symlink() or target.stat().st_size != item['bytes'] or digest(target) != item['sha256']:
            raise ValueError('initial Chair evidence changed')
    base = json.loads(legacy['overlays']['candidate'].read_text())['Replace']
    if len(base) != 6 or any(value != '' for value in base.values()):
        raise ValueError('existing six-file exclusion overlay changed')
    candidate_overlay = {**base, str(ROOT / PRODUCTION): str(SOURCE / 'studio_gain_envelope.go.source')}
    runner = dict(legacy['runnerFiles'])
    runner.update({str(p.relative_to(ROOT)): digest(p) for p in sorted(SOURCE.iterdir()) if p.is_file()})
    return {'qualifiedGoSource': LEGACY.QUALIFIED, 'qualifiedFiles': legacy['qualifiedFiles'],
            'runnerFiles': runner, 'baseline': base, 'candidate': candidate_overlay,
            'originalProductionSHA256': ORIGINAL_SHA, 'candidateProductionSHA256': CANDIDATE_SHA,
            'initialChairEvidence': plan['initialChairEvidence'],
            'historicalOverlays': {label: {'path': str(file), 'sha256': digest(file), 'replace': json.loads(file.read_text())['Replace']} for label, file in legacy['overlays'].items()},
            'historicalNativeIndexSHA256': LEGACY.NATIVE_INDEX, 'historicalWASMIndexSHA256': LEGACY.OLD_INDEX}


def effective_source_set(names, overlay):
    files = []
    for name in names:
        actual = overlay.get(str(ROOT / name), str(ROOT / name))
        if actual:
            files.append({'file': name, 'effectiveSHA256': digest(pathlib.Path(actual))})
    return {'scope': 'conservative qualified tracked-Go/go.mod superset plus existing opt-in test; not compiler dependency listing', 'files': files}


def prepare(run_id):
    snapshot = source_snapshot()
    PROOF.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = PROOF / identifier(run_id)
    directory.mkdir(mode=0o700)
    frozen = directory / 'source-frozen'
    frozen.mkdir(mode=0o700)
    for name in FILES:
        (frozen / name).write_bytes((SOURCE / name).read_bytes())
    for label in ('baseline', 'candidate'):
        overlay = snapshot[label]
        write_json(directory / (label + '-overlay.json'), {'Replace': overlay})
        write_json(directory / (label + '-source-set.json'), effective_source_set(snapshot['qualifiedFiles'], overlay))
        unit_overlay = {**overlay, str(ROOT / EXTRA): str(SOURCE / 'node_visit_test.go.source')}
        write_json(directory / (label + '-unit-overlay.json'), {'Replace': unit_overlay})
        write_json(directory / (label + '-unit-source-set.json'), effective_source_set(snapshot['qualifiedFiles'], unit_overlay))
    manifest = {'scope': 'SOURCE ONLY; baseline e492, one-line overlay candidate; no module/fullgraph/audio/timing/selection',
                'gitCheckpoint': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                **snapshot,
                'preparedFiles': {p.name: digest(p) for p in sorted(directory.iterdir()) if p.is_file()}}
    write_json(directory / 'SOURCE-PROVENANCE.json', manifest)
    if source_snapshot() != snapshot:
        raise ValueError('source changed during source-only preparation')
    print('Source-only overlays and independent original control frozen; no compilation/audio/timing')
    return directory, manifest


def validate_prepared_files(directory, snapshot):
    expected_names = set()
    for label in ('baseline', 'candidate'):
        for unit_mode in (False, True):
            stem = label + ('-unit' if unit_mode else '')
            overlay = dict(snapshot[label])
            if unit_mode:
                overlay[str(ROOT / EXTRA)] = str(SOURCE / 'node_visit_test.go.source')
            expected = {stem + '-overlay.json': {'Replace': overlay},
                        stem + '-source-set.json': effective_source_set(snapshot['qualifiedFiles'], overlay)}
            for name, value in expected.items():
                file = directory / name
                if file.is_symlink() or file.stat().st_size > 256 * 1024 or json.loads(file.read_text()) != value:
                    raise ValueError('actual prepared mapping/effective source set changed')
            expected_names.update(expected)
    return expected_names


def validate_unit_log(log):
    started = re.findall(r'^=== RUN   (Test\w+)$', log, re.MULTILINE)
    passed = re.findall(r'^--- PASS: (Test\w+) \([0-9.]+s\)$', log, re.MULTILINE)
    if tuple(started) != TESTS or tuple(passed) != TESTS or '\nPASS\n' not in log or '--- SKIP:' in log or '--- FAIL:' in log:
        raise ValueError('exact four unit tests must start and pass without skip/failure')
    return list(TESTS)


def read_prepared(run_id):
    directory = PROOF / identifier(run_id)
    file = directory / 'SOURCE-PROVENANCE.json'
    if file.is_symlink() or file.stat().st_size > 256 * 1024:
        raise ValueError('prepared source provenance admission refused')
    manifest = json.loads(file.read_text())
    snapshot = source_snapshot()
    if any(manifest[key] != value for key, value in snapshot.items()):
        raise ValueError('prepared source snapshot differs')
    if set(manifest['preparedFiles']) != validate_prepared_files(directory, snapshot):
        raise ValueError('closed prepared file inventory changed')
    for name, sha in manifest['preparedFiles'].items():
        if digest(directory / name) != sha:
            raise ValueError('prepared overlay/source-set bytes changed')
    for name in FILES:
        if digest(directory / 'source-frozen' / name) != digest(SOURCE / name):
            raise ValueError('frozen runner/source payload changed')
    return directory, manifest


def unit(run_id):
    directory, manifest = read_prepared(run_id)
    version = subprocess.check_output(['go', 'version'], text=True).strip()
    if version != 'go version go1.26.10 darwin/arm64' or os.environ.get('GOEXPERIMENT', '') or subprocess.check_output(['go', 'env', 'GOEXPERIMENT'], text=True).strip():
        raise ValueError('pinned pure-Go native unit toolchain required')
    for label in ('baseline', 'candidate'):
        read_prepared(run_id)
        output = directory / (label + '-unit')
        output.mkdir(mode=0o700)
        overlay = directory / (label + '-unit-overlay.json')
        env = os.environ.copy()
        env.update({'GOOS': 'darwin', 'GOARCH': 'arm64', 'CGO_ENABLED': '1', 'GOMAXPROCS': '1', 'GOWORK': 'off', 'GOEXPERIMENT': '', 'GOFLAGS': '-overlay=' + str(overlay)})
        # Unit-only bounded test: opt-in graph/screen recorders are not selected.
        argv = ['go', 'test', '-race', '-count=1', '-v', '-run=^TestStudioEnvelopeNodeVisit', '-timeout=20s', './internal/audio/dsp']
        effective = json.loads(subprocess.check_output(['go', 'env', '-json', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOWORK', 'GOEXPERIMENT', 'GOFLAGS'], cwd=ROOT, env=env, text=True))
        result = LEGACY.load_supervisor().bounded_child(argv, output, seconds=25, env=env)
        admission_error = None
        passed_tests = []
        try:
            passed_tests = validate_unit_log((output / 'child.log').read_text())
        except ValueError as error:
            admission_error = str(error)
        write_json(output / 'RESULT.json', {'scope': 'unit with race only; no fullgraph/audio/WASM/timing', 'argv': argv,
                   'goVersion': version, 'effectiveGoEnv': effective, 'sourceProvenanceSHA256': digest(directory / 'SOURCE-PROVENANCE.json'),
                   'overlaySHA256': digest(overlay), 'sourceSetSHA256': digest(directory / (label + '-unit-source-set.json')),
                   'supervised': result, 'passedTests': passed_tests, 'unitAdmissionError': admission_error, 'logSHA256': digest(output / 'child.log'), 'existing192kDeadline': 'RED'})
        if result['exit'] != 0 or result['failure'] is not None or result['cleanupFailure'] is not None:
            raise RuntimeError('bounded native unit failed; original failure retained')
        if admission_error is not None:
            raise ValueError(admission_error)
        read_prepared(run_id)
    print('Baseline/candidate independent fullstate and noalloc native unit controls passed; no fullgraph/WASM/timing')


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('prepare', 'unit'):
        raise SystemExit('usage: producer.py prepare NEW_ID | unit PREPARED_ID; no module/audio/timing entry point')
    if sys.argv[1] == 'prepare':
        prepare(identifier(sys.argv[2]))
    else:
        unit(identifier(sys.argv[2]))
