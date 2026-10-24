"""SOURCE ONLY native/GoJS semantic pairs; execution needs a later Chair release."""
# cspell:ignore GOMAXPROCS
import importlib.util
import json
import pathlib
import re
import sys

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('private_node_visit_graph_producer', pathlib.Path(__file__).with_name('producer.py'))
PRODUCER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PRODUCER)
SUPERVISOR = PRODUCER.LEGACY.load_supervisor()


def validate_counter(log, rate, expected):
    matches = re.findall(r'cases(\d+) rate(\d+) baseFrames(\d+) numericWords(\d+) outputBytes(\d+) fixedGraphBytes(\d+) inputSHA256([0-9a-f]{64})', log)
    if len(matches) != 1:
        raise ValueError('exactly one original27case counter receipt required')
    counter = SUPERVISOR.parse_counter_receipt(log, rate)
    for name in ('cases', 'rate', 'baseFrames', 'numericWords', 'outputBytes', 'inputSHA256'):
        if counter[name] != expected[name]:
            raise ValueError('accepted e492 fixed corpus counter differs: ' + name)
    return counter


def validate_output(file, counter):
    if file.is_symlink() or file.stat().st_size != counter['outputBytes'] or not 1 <= file.stat().st_size <= SUPERVISOR.OUTPUT_CAP or file.stat().st_mode & 0o777 != 0o600:
        raise ValueError('bounded exclusive PCM/state output admission refused')


def execute(build_id, backend, label, rate):
    directory, manifest = PRODUCER.read_manifest(build_id)
    output = directory / 'runs' / (backend + '-' + label + '-rate' + str(rate))
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.mkdir(mode=0o700)
    entry = manifest['modules'][backend][label]
    if backend == 'native':
        argv = [entry['file'], '-test.run=^TestWriteStudioExtremaGraphFixtures$', '-test.count=1', '-test.v', '-test.timeout=25s']
        env = {'GOMAXPROCS': '1', 'AURIALIS_STUDIO_EXTREMA_RATE': str(rate), 'AURIALIS_STUDIO_EXTREMA_FIXTURES': str(output), 'TMPDIR': str(output)}
    else:
        argv = [str(PRODUCER.NODE), '--stack-size=8192', '--max-old-space-size=192', str(PRODUCER.SOURCE / 'wasm-child.mjs'), build_id, label, str(rate)]
        env = {'PATH': str(PRODUCER.NODE.parent), 'GOMAXPROCS': '1'}
    result = SUPERVISOR.bounded_child(argv, output, seconds=28, env=env)
    if result['exit'] != 0 or result['failure'] is not None or result['cleanupFailure'] is not None:
        raise RuntimeError('bounded fullgraph child failed; raw partial output/receipts retained')
    counter = validate_counter((output / 'child.log').read_text(), rate, manifest['nativeCounterReceipts'][str(rate)])
    file = output / ('rate' + str(rate) + '.bin')
    validate_output(file, counter)
    receipt = {'scope': 'fullgraph semantics only; no performance/RSS/public selection', 'backend': backend, 'label': label, 'rate': rate,
               'moduleSHA256': entry['sha256'], 'overlaySHA256': entry['overlaySHA256'], 'sourceSetSHA256': entry['sourceSetSHA256'],
               'manifestSHA256': PRODUCER.digest(directory / 'BUILD.json'), 'recorderSHA256': manifest['recorderSHA256'],
               'runtimeProcessEnv': env, 'counter': counter, 'parent': result, 'outputSHA256': PRODUCER.digest(file),
               'logSHA256': PRODUCER.digest(output / 'child.log'), 'parentReceiptSHA256': PRODUCER.digest(output / 'parent-exit.json')}
    if backend == 'wasm':
        child_file = output / 'receipt.json'
        if child_file.is_symlink() or child_file.stat().st_size > 128 * 1024:
            raise ValueError('GoJS child receipt admission refused')
        child = json.loads(child_file.read_text())
        expected = {key: receipt[key] for key in ('label', 'rate', 'moduleSHA256', 'overlaySHA256', 'sourceSetSHA256', 'manifestSHA256', 'recorderSHA256', 'outputSHA256')}
        expected.update({'buildId': build_id, 'runtimeSHA256': manifest['runtime']['sha256'], 'goExit': 0, 'goExited': True, 'failure': None})
        if any(child.get(key) != value for key, value in expected.items()) or child['counterReceipt'] != counter or child['io']['failure'] is not None or not child['io']['closed'] or child['io']['bytes'] != counter['outputBytes']:
            raise ValueError('GoJS child completion/provenance receipt differs')
        receipt['childReceiptSHA256'] = PRODUCER.digest(child_file)
    PRODUCER.read_manifest(build_id)
    PRODUCER.write_json(output / 'ACCEPTED.json', receipt)
    return file, receipt


def compare_outputs(streams, backend, rate):
    pair = SUPERVISOR.compare_streams(*streams)
    archive = PRODUCER.archived(backend, rate)
    previous = [SUPERVISOR.compare_streams(stream, archive) for stream in streams]
    return {'baselineCandidate': pair, 'bothVsAcceptedE492Candidate': previous,
            'accepted': pair['byteEqual'] and all(item['byteEqual'] for item in previous)}


def run_pair(build_id, backend, rate):
    if backend not in PRODUCER.BACKENDS or rate not in PRODUCER.RATES:
        raise ValueError('closed fullgraph backend/rate refused')
    directory, manifest = PRODUCER.read_manifest(build_id)
    results, streams = [], []
    try:
        for label in PRODUCER.LABELS:
            file, receipt = execute(build_id, backend, label, rate)
            results.append(receipt)
            streams.append(file)
        comparison = compare_outputs(streams, backend, rate)
        report = {'scope': 'native or actual GoJS semantics only; no cross-target numeric-state equivalence or timing claim',
                  'backend': backend, 'rate': rate, 'casesPerSide': 27, 'manifestSHA256': PRODUCER.digest(directory / 'BUILD.json'),
                  'results': results, **comparison}
        PRODUCER.write_json(directory / (backend + '-rate' + str(rate) + '-comparison.json'), report)
        if not comparison['accepted']:
            raise ValueError('actual fullgraph bytes differ; RED retained')
    except Exception as error:
        PRODUCER.write_json(directory / (backend + '-rate' + str(rate) + '-ERROR.json'), {'error': str(error)[:512], 'partialResults': results})
        raise
    print(backend, rate, '27cases per side exactly match each other and accepted e492 archive; no timing')


def seal(build_id):
    directory, manifest = PRODUCER.read_manifest(build_id)
    evidence = []
    for backend in PRODUCER.BACKENDS:
        for rate in PRODUCER.RATES:
            report_file = directory / (backend + '-rate' + str(rate) + '-comparison.json')
            if report_file.is_symlink() or report_file.stat().st_size > 128 * 1024:
                raise ValueError('bounded semantic report admission refused')
            report = json.loads(report_file.read_text())
            if report.get('backend') != backend or report.get('rate') != rate or report.get('casesPerSide') != 27 or report.get('manifestSHA256') != PRODUCER.digest(directory / 'BUILD.json'):
                raise ValueError('closed retained comparison identity differs')
            streams = []
            for label in PRODUCER.LABELS:
                output = directory / 'runs' / (backend + '-' + label + '-rate' + str(rate))
                accepted = json.loads((output / 'ACCEPTED.json').read_text())
                file = output / ('rate' + str(rate) + '.bin')
                validate_output(file, accepted['counter'])
                if accepted != report['results'][len(streams)] or PRODUCER.digest(file) != accepted['outputSHA256'] or accepted['manifestSHA256'] != PRODUCER.digest(directory / 'BUILD.json'):
                    raise ValueError('retained semantic bytes/receipts differ')
                if PRODUCER.digest(output / 'child.log') != accepted['logSHA256'] or PRODUCER.digest(output / 'parent-exit.json') != accepted['parentReceiptSHA256'] or validate_counter((output / 'child.log').read_text(), rate, manifest['nativeCounterReceipts'][str(rate)]) != accepted['counter']:
                    raise ValueError('retained raw Go counter/parent receipt changed')
                if backend == 'wasm' and PRODUCER.digest(output / 'receipt.json') != accepted['childReceiptSHA256']:
                    raise ValueError('retained GoJS receipt changed')
                streams.append(file)
            comparison = compare_outputs(streams, backend, rate)
            if not comparison['accepted'] or any(report[key] != value for key, value in comparison.items()):
                raise ValueError('retained actual pair/archive bytes differ')
            evidence.append({'backend': backend, 'rate': rate, 'reportSHA256': PRODUCER.digest(report_file)})
    PRODUCER.write_json(directory / 'SEMANTIC-QUALIFICATION.json', {'scope': '135 finite fixture cases per side per backend; no timing/selection/cross-target numeric-state claim',
                        'manifestSHA256': PRODUCER.digest(directory / 'BUILD.json'), 'reports': evidence,
                        'existing192kDeadline': 'RED', 'crossTargetNumericState': 'UNPROVEN', 'originalContractGates': 'separate required alias/partition/tail/wrap/noalloc gates remain pending'})
    print('Native and actual GoJS paired/archive semantics sealed; original contract gates and timing remain separate')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'seal':
        seal(PRODUCER.identifier(sys.argv[2]))
    elif len(sys.argv) == 4 and sys.argv[1] in PRODUCER.BACKENDS and sys.argv[3] in tuple(str(rate) for rate in PRODUCER.RATES):
        run_pair(PRODUCER.identifier(sys.argv[2]), sys.argv[1], int(sys.argv[3]))
    else:
        raise SystemExit('usage: run-pair.py native|wasm BUILD CLOSED_RATE | seal BUILD; execution needs separate Chair release')
