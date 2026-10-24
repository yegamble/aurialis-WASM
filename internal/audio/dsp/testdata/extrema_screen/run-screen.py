"""SOURCE-ONLY private screen. Execution requires a separate parent/quiet release."""
# cspell:ignore GOMAXPROCS AUEXPS PCMSHA untimed
import hashlib
import importlib.util
import json
import math
import pathlib
import re
import struct
import sys

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('private_screen_producer', pathlib.Path(__file__).with_name('producer.py'))
PRODUCER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PRODUCER)
CAP = 8 * 1024 * 1024
VERIFY_FRAMES = 2 * (64 + 32) * 128
MEASURE_FRAMES = 2 * (64 + 32 + 64 + 32) * 128


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Decoder:
    def __init__(self, data):
        if not 1 <= len(data) <= CAP:
            raise ValueError('screen stream byte admission refused')
        self.data = data
        self.cursor = 0

    def take(self, count):
        if count < 0 or count > len(self.data) - self.cursor:
            raise ValueError('bounded screen parse refused')
        start = self.cursor
        self.cursor += count
        return self.data[start:self.cursor]

    def number(self):
        return struct.unpack('<Q', self.take(8))[0]

    def blob(self, cap):
        count = self.number()
        if count > cap:
            raise ValueError('screen blob admission refused')
        return self.take(count)

    def pcm(self, frames):
        if self.number() != frames:
            raise ValueError('screen PCM frame count changed')
        data = self.take(frames * 8)
        if any(not math.isfinite(value[0]) for value in struct.iter_unpack('<f', data)):
            raise ValueError('nonfinite screen PCM refused')
        return data


def parse_screen(data, phase, workload):
    if phase not in ('verify', 'measure') or workload not in ('steady', 'peaky'):
        raise ValueError('closed screen phase/workload refused')
    d = Decoder(data)
    parts, timed_parts = [], []
    if d.take(8) != b'AUEXPS01' or d.number() != 192000:
        raise ValueError('screen identity changed')
    parts.append(data[:d.cursor])
    if d.blob(16).decode() != phase:
        raise ValueError('screen phase mismatch')
    start = d.cursor
    if d.blob(16).decode() != workload:
        raise ValueError('screen workload mismatch')
    metadata = d.blob(8192)
    json.loads(metadata)
    source = d.pcm(128)
    parts.append(data[start:d.cursor])
    timings = []
    for mode in (0, 1):
        start = d.cursor
        if d.number() != mode:
            raise ValueError('screen finite/repeat order changed')
        latency, source_frames = d.number(), d.number()
        if not 1 <= latency < 4096 or source_frames != 16 * 1024 * 1024:
            raise ValueError('screen graph layout changed')
        verify_pcm = d.pcm(32 * 128)
        verify_state = d.blob(32)
        if len(verify_state) != 32 or d.number() != (64 + 32) * 128:
            raise ValueError('screen verification state/clock changed')
        parts.append(data[start:d.cursor])
        if phase == 'measure':
            start = d.cursor
            first, final = d.number(), d.number()
            if first != 64 * 128 or final != (64 + 32) * 128:
                raise ValueError('timed source clock changed')
            pcm = d.pcm(32 * 128)
            state = d.blob(32)
            if len(state) != 32 or pcm != verify_pcm or state != verify_state:
                raise ValueError('same-child reset verification PCM/state differs')
            timed_parts.append(data[start:d.cursor])
            nanoseconds, allocations, allocated_bytes = d.number(), d.number(), d.number()
            if not 1 <= nanoseconds <= 25_000_000_000:
                raise ValueError('bounded screen duration refused')
            timings.append({'repeat': bool(mode), 'latencyFrames': latency,
                            'declaredSourceFrames': source_frames, 'startFrame': first, 'finalFrame': final,
                            'batchBlocks': 32, 'batchNanoseconds': nanoseconds,
                            'meanMsPer128': nanoseconds / 32 / 1e6,
                            'mallocDelta': allocations, 'totalAllocDelta': allocated_bytes,
                            'timedPCMSHA256': sha(pcm), 'numericStateDigest': state.hex()})
    frames, words, output_bytes = d.number(), d.number(), d.number()
    expected = VERIFY_FRAMES if phase == 'verify' else MEASURE_FRAMES
    if frames != expected or frames > 200000 or frames * 4 > 800000 or words > 16 * 1024 * 1024 or output_bytes != len(data) or d.cursor != len(data):
        raise ValueError('screen work/output receipt differs')
    verification = b''.join(parts)
    timed = b''.join(timed_parts)
    return {'verificationBytes': verification, 'verificationSHA256': sha(verification),
            'timedBytes': timed, 'timedSHA256': sha(timed), 'timings': timings,
            'frames': frames, 'highFrameUpper': frames * 4, 'numericWords': words,
            'outputBytes': output_bytes, 'metadataJSON': metadata.decode(), 'sourcePCMSHA256': sha(source),
            'scope': '32-block batch means; no EOF/drain/seam/steady-state/realtime certification'}


def execute(build_id, manifest, label, phase, workload, leg):
    directory = PRODUCER.PROOF / build_id / 'runs' / f'{phase}-{workload}-{leg}-{label}'
    directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.mkdir(mode=0o700)
    argv = [str(PRODUCER.NODE), str(PRODUCER.SOURCE / 'screen-child.mjs'), build_id, label, phase, workload, leg]
    supervised = PRODUCER.load_supervisor().bounded_child(argv, directory)
    if supervised['exit'] != 0 or supervised['failure'] is not None or supervised['cleanupFailure'] is not None:
        raise RuntimeError('screen child failed; all partial outputs/receipts retained')
    receipt_file = directory / 'receipt.json'
    if receipt_file.stat().st_size > 128 * 1024 or receipt_file.is_symlink():
        raise ValueError('screen child receipt admission refused')
    receipt = json.loads(receipt_file.read_text())
    output_file = directory / 'rate192000.bin'
    if output_file.is_symlink() or output_file.stat().st_size > CAP or output_file.stat().st_mode & 0o777 != 0o600:
        raise ValueError('screen output admission refused')
    data = output_file.read_bytes()
    entry = manifest['modules'][label]
    if receipt['goExit'] != 0 or not receipt['goExited'] or receipt['failure'] is not None or receipt['io']['failure'] is not None or not receipt['io']['closed'] or receipt['io']['bytes'] != len(data) or receipt['outputSHA256'] != sha(data):
        raise ValueError('screen Go/closedIO/hash receipt incomplete')
    expected = {'buildId': build_id, 'label': label, 'phase': phase, 'workload': workload, 'leg': leg,
                'moduleSHA256': entry['sha256'], 'sourceSetSHA256': entry['sourceSetSHA256'],
                'overlaySHA256': entry['overlaySHA256'], 'runtimeSHA256': manifest['runtime']['sha256'],
                'manifestSHA256': PRODUCER.digest(PRODUCER.PROOF / build_id / 'BUILD.json')}
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise ValueError('screen provenance receipt differs')
    log = (directory / 'child.log').read_text()
    if phase == 'fixture':
        PRODUCER.load_supervisor().parse_counter_receipt(log, 192000)
        archived = PRODUCER.OLD / 'runs/post-exit-first' / f'{label}-rate192000' / 'rate192000.bin'
        comparison = PRODUCER.load_supervisor().compare_streams(archived, output_file)
        PRODUCER.write_json(directory / 'ARCHIVED-FIXTURE-COMPARISON.json', comparison)
        if not comparison['byteEqual']:
            raise ValueError('new module differs from corresponding archived original recorder')
        return {'path': str(directory.relative_to(PRODUCER.PROOF / build_id)), 'outputSHA256': sha(data),
                'childReceiptSHA256': PRODUCER.digest(directory / 'receipt.json'),
                'parentReceiptSHA256': PRODUCER.digest(directory / 'parent-exit.json')}
    parsed = parse_screen(data, phase, workload)
    counters = re.findall(r'cases(\d+) rate(\d+) baseFrames(\d+) numericWords(\d+) outputBytes(\d+) fixedGraphBytes(\d+) inputSHA256([0-9a-f]{64})', log)
    if len(counters) != 1:
        raise ValueError('missing/duplicate Go screen receipt')
    cases, rate, frames, words, size, graph, input_sha = counters[0]
    if int(cases) != 2 or int(rate) != 192000 or int(frames) != parsed['frames'] or int(words) != parsed['numericWords'] or int(size) != len(data) or int(graph) + 320 * 1024 > 2 * 1024 * 1024:
        raise ValueError('independent Go work receipt differs')
    parsed.update({'inputSHA256': input_sha, 'outputSHA256': sha(data), 'path': str(directory.relative_to(PRODUCER.PROOF / build_id)),
                   'childReceiptSHA256': PRODUCER.digest(directory / 'receipt.json'),
                   'parentReceiptSHA256': PRODUCER.digest(directory / 'parent-exit.json')})
    PRODUCER.write_json(directory / 'ANALYSIS.json', {key: value for key, value in parsed.items() if key not in ('verificationBytes', 'timedBytes')})
    return parsed


def fixture_gate(build_id, manifest):
    directory = PRODUCER.PROOF / build_id
    file = directory / 'FIXTURE-GATE.json'
    if not file.exists():
        fixtures = {label: execute(build_id, manifest, label, 'fixture', 'steady', 'gate') for label in ('baseline', 'candidate')}
        PRODUCER.write_json(file, {'manifestSHA256': PRODUCER.digest(directory / 'BUILD.json'), 'fixtures': fixtures})
        return fixtures
    if file.is_symlink() or file.stat().st_size > 64 * 1024:
        raise ValueError('archived fixture gate admission refused')
    gate = json.loads(file.read_text())
    if gate['manifestSHA256'] != PRODUCER.digest(directory / 'BUILD.json'):
        raise ValueError('archived fixture gate provenance changed')
    for label in ('baseline', 'candidate'):
        entry = gate['fixtures'][label]
        expected = f'runs/fixture-steady-gate-{label}'
        if entry['path'] != expected:
            raise ValueError('closed archived fixture path changed')
        child = directory / expected
        archived = PRODUCER.OLD / 'runs/post-exit-first' / f'{label}-rate192000' / 'rate192000.bin'
        if PRODUCER.digest(child / 'receipt.json') != entry['childReceiptSHA256'] or PRODUCER.digest(child / 'parent-exit.json') != entry['parentReceiptSHA256'] or not PRODUCER.load_supervisor().compare_streams(child / 'rate192000.bin', archived)['byteEqual']:
            raise ValueError('archived fixture actual bytes/receipts changed')
    return gate['fixtures']


def qualify(build_id, workload):
    directory, manifest = PRODUCER.read_manifest(build_id)
    # The frozen27-case recorder needs running only ONCE per new module.
    # The second workload rechecks the retained bytes and bound receipts.
    fixtures = fixture_gate(build_id, manifest)
    verified = {label: execute(build_id, manifest, label, 'verify', workload, 'gate') for label in ('baseline', 'candidate')}
    if verified['baseline']['verificationBytes'] != verified['candidate']['verificationBytes'] or verified['baseline']['inputSHA256'] != verified['candidate']['inputSHA256']:
        raise ValueError('untimed32-block paired verification differs')
    PRODUCER.write_json(directory / f'QUALIFIED-{workload}.json', {'manifestSHA256': PRODUCER.digest(directory / 'BUILD.json'),
                         'workload': workload, 'fixtures': fixtures,
                         'verificationSHA256': verified['baseline']['verificationSHA256'],
                         'inputSHA256': verified['baseline']['inputSHA256'],
                         'verifyOutputs': {label: {key: item[key] for key in ('path', 'outputSHA256', 'childReceiptSHA256', 'parentReceiptSHA256')} for label, item in verified.items()},
                         'status': 'untimed qualification only; no performance interpretation'})
    print('New module archived recorder and untimed32-block PCM/state verification passed; no timing')


def admit_observation(item, gate, before=None):
    if item['verificationSHA256'] != gate['verificationSHA256'] or item['inputSHA256'] != gate['inputSHA256']:
        raise ValueError('timed child verification differs; no interpretation')
    if any(timing['mallocDelta'] != 0 or timing['totalAllocDelta'] != 0 for timing in item['timings']):
        raise ValueError('timed allocation observation nonzero; retained RED')
    if before is not None and item['timedBytes'] != before:
        raise ValueError('actual timed PCM/state/clock differs; no interpretation')
    return item['timedBytes']


def measure(build_id, workload):
    directory, manifest = PRODUCER.read_manifest(build_id)
    gate_file = directory / f'QUALIFIED-{workload}.json'
    if gate_file.is_symlink() or gate_file.stat().st_size > 64 * 1024:
        raise ValueError('qualification receipt admission refused')
    gate = json.loads(gate_file.read_text())
    if gate['manifestSHA256'] != PRODUCER.digest(directory / 'BUILD.json') or gate['workload'] != workload:
        raise ValueError('untimed qualification provenance differs')
    fixture_gate(build_id, manifest)
    # Re-read actual gate bytes, not only a mutable status string or hash claim.
    for label in ('baseline', 'candidate'):
        expected_fixture = f'runs/fixture-steady-gate-{label}'
        expected_verify = f'runs/verify-{workload}-gate-{label}'
        if gate['fixtures'][label]['path'] != expected_fixture or gate['verifyOutputs'][label]['path'] != expected_verify:
            raise ValueError('closed qualification output paths changed')
        fixture = directory / expected_fixture / 'rate192000.bin'
        archived = PRODUCER.OLD / 'runs/post-exit-first' / f'{label}-rate192000' / 'rate192000.bin'
        if not PRODUCER.load_supervisor().compare_streams(fixture, archived)['byteEqual']:
            raise ValueError('qualified archived fixture changed')
        verified_directory = directory / expected_verify
        entry = gate['verifyOutputs'][label]
        if PRODUCER.digest(verified_directory / 'receipt.json') != entry['childReceiptSHA256'] or PRODUCER.digest(verified_directory / 'parent-exit.json') != entry['parentReceiptSHA256']:
            raise ValueError('untimed qualification child/parent receipts changed')
        output = verified_directory / 'rate192000.bin'
        if output.is_symlink() or output.stat().st_size > CAP:
            raise ValueError('qualified verification output admission refused')
        verified_data = output.read_bytes()
        parsed = parse_screen(verified_data, 'verify', workload)
        if sha(verified_data) != gate['verifyOutputs'][label]['outputSHA256'] or parsed['verificationSHA256'] != gate['verificationSHA256']:
            raise ValueError('untimed verification bytes changed')
    results = []
    before = None
    for label, leg in (('baseline', 'before'), ('candidate', 'candidate'), ('baseline', 'after')):
        # Validate manifests/source again before EACH fresh process.
        PRODUCER.read_manifest(build_id)
        item = execute(build_id, manifest, label, 'measure', workload, leg)
        admitted = admit_observation(item, gate, before)
        if before is None:
            before = admitted
        results.append({'label': label, 'leg': leg, **{key: value for key, value in item.items() if key not in ('verificationBytes', 'timedBytes')}})
    PRODUCER.write_json(directory / f'PAIRED-{workload}.json', {'manifestSHA256': PRODUCER.digest(directory / 'BUILD.json'),
                         'scope': 'paired separate-process screening only; no elimination of host/JIT drift',
                         'perChildFrames': MEASURE_FRAMES, 'tripletFrames': 3 * MEASURE_FRAMES,
                         'tripletHighFrameUpper': 3 * MEASURE_FRAMES * 4,
                         'deadlineMsPer128': 128000 / 192000, 'results': results})
    print('All raw paired results preserved; no public selection/headroom certification')


if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) not in (3, 4) or args[0] not in ('qualify', 'measure') or args[2] not in ('steady', 'peaky'):
        raise SystemExit('usage: run-screen.py qualify BUILD WORKLOAD | measure BUILD WORKLOAD quiet-approved')
    if args[0] == 'measure':
        if len(args) != 4 or args[3] != 'quiet-approved':
            raise SystemExit('measurement requires an explicit coordinated quiet release')
        measure(PRODUCER.identifier(args[1]), args[2])
    else:
        if len(args) != 3:
            raise SystemExit('invalid qualification arguments')
        qualify(PRODUCER.identifier(args[1]), args[2])
