"""SOURCE ONLY diagnostic host; actual profiles require a separate Chair release."""
# cspell:words cpuprofile GOMAXPROCS PCMSHA AUEXPS WRONLY CREAT fstat ENOENT untimed
import inspect
import json
import os
import pathlib
import re
import subprocess
import sys

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
FILES = {'run-profile.py', 'profile-parser.py', 'source-contract.test.py', 'README.md'}
PLAN = SOURCE.with_name('envelope_node_visit_profile_plan')
PLAN_FILES = {'PLAN.json', 'MODULE-NAMES.json', 'COMMANDS.source', 'README.md'}
SPEC_PATH = SOURCE.with_name('envelope_node_visit_screen_host') / 'run-screen.py'
import importlib.util
SPEC = importlib.util.spec_from_file_location('frozen_screen_for_profile', SPEC_PATH)
SCREEN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCREEN)
PARSER = SCREEN.load('bounded_profile_parser', SOURCE / 'profile-parser.py')
ROOT, PROOF, NODE = SCREEN.ROOT, SCREEN.PROOF, SCREEN.NODE
METHOD, BUILD_SHA = SCREEN.METHOD, SCREEN.BUILD_SHA
digest, write_json, identifier, read_json = SCREEN.digest, SCREEN.write_json, SCREEN.identifier, SCREEN.read_json
screen_selection, validate_parent, validate_io = SCREEN.screen_selection, SCREEN.validate_parent, SCREEN.validate_io
BASE_ID = 'source-v1'
BASE = PROOF / BASE_ID
SCHEMA = 'same-module-profile-binding-v1'
PLAN_INDEX = ROOT / 'artifacts/private-dsp/recovery-20261023/envelope-node-visit-profile-plan/source-v2/SOURCE-SHA256.json'
PLAN_INDEX_SHA = '38982465a04b0d4309a6b2b690f10ecd6e4345380d044e2af2ef623e57ae33d9'
VERIFY_SHA = '3c72daf7ccd7c94e4ffaf470aa84899637de34646c3dde9ccad50edcedac1b83'
MEASURE_SHA = '268715bac849025662b7ee0ec1ec16991835cb308ed595d7ec722a92645e11ba'


def check_index(file, expected, count):
    data = PARSER.bounded_bytes(file, 256 * 1024)
    if METHOD.sha(data) != expected:
        raise ValueError('frozen diagnostic prerequisite index differs')
    index = PARSER.decode_json(data)
    if not isinstance(index['files'], dict) or len(index['files']) != count:
        raise ValueError('closed prerequisite inventory differs')
    for name, entry in index['files'].items():
        path = pathlib.PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('prerequisite evidence path refused')
        target = file.parent / name
        data = PARSER.bounded_bytes(target, 16 * 1024 * 1024) if entry['bytes'] else b''
        if target.is_symlink() or not target.is_file() or target.stat().st_size != entry['bytes'] or METHOD.sha(data) != entry['sha256']:
            raise ValueError('frozen diagnostic prerequisite bytes differ')
    return {'file': str(file), 'sha256': expected}


def validator_source():
    text = inspect.getsource(SCREEN.read_result)
    old = "if parent['argv'] != [str(NODE), str(SOURCE / 'screen-child.mjs'), directory.name, label, phase, workload, leg]:"
    if text.count(old) != 1:
        raise ValueError('frozen validator transform anchor differs')
    return text.replace(old, "if parent['argv'] != profile_argv(directory.name, label):")


def snapshot():
    if {p.name for p in SOURCE.iterdir() if p.is_file()} != FILES or any(p.is_symlink() for p in SOURCE.iterdir()):
        raise ValueError('closed four-source diagnostic inventory differs')
    if {p.name for p in PLAN.iterdir() if p.is_file()} != PLAN_FILES or any(p.is_symlink() for p in PLAN.iterdir()):
        raise ValueError('closed accepted proposal inventory differs')
    check_index(PLAN_INDEX, PLAN_INDEX_SHA, 9)
    frozen = read_json(PLAN_INDEX.parent / 'SOURCE.json')
    for name, entry in frozen['sourceFiles'].items():
        if digest(ROOT / name) != entry['sha256']:
            raise ValueError('accepted proposal source differs')
    _base, binding = SCREEN.read_binding(BASE_ID)
    evidence = {'verify': check_index(BASE / 'VERIFY-SHA256.json', VERIFY_SHA, 69),
                'measurement': check_index(BASE / 'MEASUREMENT-SHA256.json', MEASURE_SHA, 106)}
    proposal = read_json(PLAN / 'PLAN.json')
    names = read_json(PLAN / 'MODULE-NAMES.json')
    if digest(PLAN / 'MODULE-NAMES.json') != proposal['existingEvidence']['nameInspectionSHA256']:
        raise ValueError('accepted name inspection differs')
    mappings = {}
    for label, entry in binding['modules'].items():
        mapping = PARSER.parse_module(pathlib.Path(entry['file']), entry['sha256'], entry['bytes'])
        expected = next(item for item in names['reports'] if item['label'] == label)
        if (mapping['nameMapSHA256'] != expected['fullNameMapSHA256'] or mapping['defined'] != expected['definedFunctions']
                or len(mapping['names']) != expected['functionNameCount'] or mapping['imports'] != expected['functionImports']):
            raise ValueError('actual module name/code mapping differs')
        for item in expected['selectedActualFunctionBodies']:
            if mapping['names'].get(item['index']) != item['name'] or mapping['bodies'].get(item['index']) != {key: item[key] for key in ('offset', 'bytes', 'sha256')}:
                raise ValueError('actual selected function body differs')
        mappings[label] = {'moduleSHA256': entry['sha256'], 'nameMapSHA256': mapping['nameMapSHA256'], 'defined': mapping['defined'], 'imports': mapping['imports']}
        SCREEN.read_result(BASE, binding, label, 'verify', 'steady', 'gate')
    runners = dict(binding['runnerFiles'])
    for directory in (PLAN, SOURCE):
        runners.update({str(file.relative_to(ROOT)): digest(file) for file in directory.iterdir() if file.is_file()})
    if len(runners) != 45 or inspect.getsource(read_result) != validator_source():
        raise ValueError('exact45-source inventory/one-line validator transform differs')
    return {'schema': SCHEMA, 'baseScreenID': BASE_ID, 'screenBindingSHA256': digest(BASE / 'BINDING.json'),
            'screenBinding': binding, 'runnerFiles': runners, 'evidence': evidence,
            'proposalIndexSHA256': PLAN_INDEX_SHA, 'moduleMappings': mappings,
            'requestedIntervalMicroseconds': 100, 'profileCaps': {'bytes': PARSER.PROFILE_CAP, 'nodes': PARSER.NODE_CAP, 'samples': PARSER.SAMPLE_CAP, 'steps': PARSER.STEP_CAP},
            'scope': 'diagnostic attribution only; post-exit profile admission, no preemptive write/RSS ceiling or timing comparability'}


def diagnostic_id(value):
    value = identifier(value)
    if not value.startswith('profile-node-visit-'):
        raise ValueError('fresh separate diagnostic ID required')
    return value


def frozen_name(name):
    return name + '.source' if name.endswith('.go') else name


def prepare(identity):
    identity = diagnostic_id(identity)
    outer = snapshot()
    if subprocess.check_output([str(NODE), '--version'], text=True).strip() != 'v26.12.0':
        raise ValueError('pinned Node26 required')
    directory = PROOF / identity
    directory.mkdir(mode=0o700)
    for name, sha in outer['runnerFiles'].items():
        target = directory / 'diagnostic-source-frozen' / frozen_name(name)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
        if digest(target) != sha:
            raise ValueError('diagnostic source freeze changed')
    for name, sha in outer['screenBinding']['runnerFiles'].items():
        target = directory / 'source-frozen' / frozen_name(name)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
        if digest(target) != sha:
            raise ValueError('original37-source freeze changed')
    with (directory / 'BINDING.json').open('xb') as out:
        out.write(PARSER.bounded_bytes(BASE / 'BINDING.json', 128 * 1024))
    write_json(directory / 'DIAGNOSTIC-BINDING.json', outer)
    print('Diagnostic45-source binding prepared; no module/profile/GoJS execution')


def read_diagnostic(identity):
    directory = PROOF / diagnostic_id(identity)
    outer = read_json(directory / 'DIAGNOSTIC-BINDING.json')
    if outer != snapshot():
        raise ValueError('diagnostic source/module/evidence changed')
    _directory, binding = SCREEN.read_binding(identity)
    if binding != outer['screenBinding'] or digest(directory / 'BINDING.json') != outer['screenBindingSHA256']:
        raise ValueError('unchanged frozen37-source child binding differs')
    for name, sha in outer['runnerFiles'].items():
        target = directory / 'diagnostic-source-frozen' / frozen_name(name)
        if target.is_symlink() or digest(target) != sha:
            raise ValueError('indexed diagnostic host source differs')
    return directory, outer


def profile_argv(identity, label):
    diagnostic_id(identity)
    if label not in ('baseline', 'candidate'):
        raise ValueError('closed diagnostic module label refused')
    output = PROOF / identity / 'runs' / ('verify-steady-gate-' + label)
    return [str(NODE), '--cpu-prof', '--cpu-prof-dir=' + str(output), '--cpu-prof-name=diagnostic.cpuprofile', '--cpu-prof-interval=100',
            str(SCREEN.SOURCE / 'screen-child.mjs'), identity, label, 'verify', 'steady', 'gate']


def read_result(directory, binding, label, phase, workload, leg):
    screen_selection(label, phase, workload, leg)
    child = directory / 'runs' / (phase + '-' + workload + '-' + leg + '-' + label)
    parent = read_json(child / 'parent-exit.json')
    validate_parent(parent)
    if parent['argv'] != profile_argv(directory.name, label):
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


def admit_profile_output(data, reference):
    if data != reference:
        raise ValueError('entire diagnostic verification differs from sealed original bytes')


def execute(identity, label, used):
    argv = profile_argv(identity, label)
    directory, outer = read_diagnostic(identity)
    binding = outer['screenBinding']
    output = directory / 'runs' / ('verify-steady-gate-' + label)
    output.parent.mkdir(mode=0o700, exist_ok=True)
    output.mkdir(mode=0o700)
    lock = directory / 'ACTIVE.lock'
    with lock.open('x') as stream:
        stream.write(output.name + '\n')
    try:
        previous = os.umask(0o077)
        try:
            parent = SCREEN.bounded_child(argv, output)
        finally:
            os.umask(previous)
        validate_parent(parent)
        parsed = read_result(directory, binding, label, 'verify', 'steady', 'gate')
        raw = PARSER.bounded_bytes(output / 'rate192000.bin', METHOD.CAP, 0o600)
        reference = PARSER.bounded_bytes(BASE / 'runs' / ('verify-steady-gate-' + label) / 'rate192000.bin', METHOD.CAP, 0o600)
        admit_profile_output(raw, reference)
        if parsed['timings'] or parsed['timedBytes'] or parsed['frames'] != 24576 or parsed['numericWords'] != 231716:
            raise ValueError('unchanged untimed verification work differs')
        module = binding['modules'][label]
        mapping = PARSER.parse_module(pathlib.Path(module['file']), module['sha256'], module['bytes'])
        profile = PARSER.bounded_bytes(output / 'diagnostic.cpuprofile', PARSER.PROFILE_CAP - used.get('bytes', 0), 0o600)
        summary = PARSER.profile_summary(profile, mapping, used)
        expected = {'child.log', 'parent-exit.json', 'receipt.json', 'rate192000.bin', 'diagnostic.cpuprofile'}
        if {file.name for file in output.iterdir()} != expected:
            raise ValueError('exclusive diagnostic child output inventory differs')
        result = {'label': label, 'path': str(output.relative_to(directory)), 'rawVerificationSHA256': METHOD.sha(raw),
                  'unchangedVerificationSHA256': METHOD.sha(reference), 'outputBytes': len(raw),
                  'parentReceiptSHA256': digest(output / 'parent-exit.json'), 'childReceiptSHA256': digest(output / 'receipt.json'),
                  'attribution': summary}
        write_json(output / 'ANALYSIS.json', result)
        return result
    except BaseException as cause:
        write_json(output / 'ERROR.json', {'type': type(cause).__name__, 'error': str(cause)[:512]})
        raise
    finally:
        lock.unlink()


def run(identity):
    identity = diagnostic_id(identity)
    directory, outer = read_diagnostic(identity)
    used, results = {}, []
    for label in ('baseline', 'candidate'):
        results.append(execute(identity, label, used))
    if results[0]['rawVerificationSHA256'] != results[1]['rawVerificationSHA256']:
        raise ValueError('profiled baseline/candidate raw verification differs')
    write_json(directory / 'SAMPLING-DIAGNOSTIC.json', {'schema': SCHEMA, 'diagnosticBindingSHA256': digest(directory / 'DIAGNOSTIC-BINDING.json'),
               'modules': outer['moduleMappings'], 'profiles': results, 'aggregateUsage': used,
               'scope': outer['scope'], 'selection': 'unselected; steady192k RED remains open; no benchmark/speedup/deadline inference'})
    print('Exactly two steady diagnostic children retained; no timing interpretation')


if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == 'prepare':
        prepare(args[1])
    elif len(args) == 3 and args[0] == 'run' and args[2] == 'diagnostic-approved':
        run(args[1])
    else:
        raise SystemExit('usage: run-profile.py prepare NEW_ID | run ID diagnostic-approved; actual profiling requires separate Chair release')
