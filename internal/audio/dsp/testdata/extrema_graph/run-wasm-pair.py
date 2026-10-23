"""Bounded private GoJS/WASM child supervision; no throughput measurement."""
# cspell:ignore GOMAXPROCS killpg
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[5]
PROOF = ROOT / 'artifacts/private-dsp/recovery-20261023/exact-extrema-wasm-graph-runner'
NATIVE = ROOT / 'artifacts/private-dsp/recovery-20261023/exact-extrema-graph-candidate'
NODE = pathlib.Path.home() / '.nvm/versions/node/v26.12.0/bin/node'
SOURCE = pathlib.Path(__file__).resolve().parent
LOG_CAP = 256 * 1024
OUTPUT_CAP = 8 * 1024 * 1024
RATES = (8000, 44100, 48000, 96000, 192000)


def signal_group(process):
    """Return the observed cleanup action; denied group signaling is not success."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
        return 'sent'
    except ProcessLookupError:
        return 'already-gone'
    except PermissionError:
        # Darwin may refuse signaling an empty group after leader exit.
        # A refusal on a still-live leader is never group-cleanup certification.
        if process.poll() is not None:
            return 'leader-already-exited'
        process.kill()
        return 'group-denied-direct-child-killed'


def bounded_child(argv, directory, seconds=28, env=None):
    """Hard wall/log caps; record cleanup races instead of losing the receipt."""
    deadline = time.monotonic() + seconds
    log = directory / 'child.log'
    reason = None
    total = 0
    group_signal = None
    process = None
    watcher = selectors.DefaultSelector()


    # Open exclusively BEFORE starting a process: failed log admission starts none.
    with log.open('xb') as out:
        process = subprocess.Popen(argv, cwd=ROOT, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   start_new_session=True,
                                   env=env if env is not None else {'PATH': str(NODE.parent), 'GOMAXPROCS': '1'})
        watcher.register(process.stdout, selectors.EVENT_READ)
        try:
            while watcher.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    reason = f'external{seconds:g}s-wall-watchdog'
                    break
                for key, _ in watcher.select(min(remaining, 0.05)):
                    data = os.read(key.fileobj.fileno(), 16384)
                    if not data:
                        watcher.unregister(key.fileobj)
                        continue
                    if len(data) > LOG_CAP - total:
                        remaining_log = LOG_CAP - total
                        out.write(data[:remaining_log])
                        total += remaining_log
                        reason = 'combined-log256KiB-cap'
                        break
                    out.write(data)
                    total += len(data)
                if reason:
                    break
        except Exception as cause:
            reason = 'supervisor-error-' + type(cause).__name__
        finally:
            if reason is not None:
                group_signal = signal_group(process)
            try:
                result = process.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                reason = f'external{seconds:g}s-wall-watchdog'
                group_signal = signal_group(process)
                result = process.wait(timeout=1)
            watcher.close()
            process.stdout.close()
    cleanup_failure = ('process-group-signal-denied; descendants-not-certified-stopped'
                       if group_signal == 'group-denied-direct-child-killed' else None)
    receipt = {'argv': argv, 'exit': result, 'failure': reason, 'logBytes': total,
               'wallLimitSeconds': seconds, 'logCapBytes': LOG_CAP,
               'processGroupSignal': group_signal, 'cleanupFailure': cleanup_failure}
    with (directory / 'parent-exit.json').open('x') as out:
        json.dump(receipt, out, indent=2)
        out.write('\n')
    return receipt


def compare_streams(first, second, cap=OUTPUT_CAP):
    for file in (first, second):
        if not file.is_file() or file.is_symlink() or file.stat().st_size > cap:
            raise ValueError('comparison input admission refused')
    hashes = [hashlib.sha256(), hashlib.sha256()]
    offset = 0
    first_difference = None
    with first.open('rb') as a, second.open('rb') as b:
        while True:
            left, right = a.read(65536), b.read(65536)
            hashes[0].update(left)
            hashes[1].update(right)
            if first_difference is None and left != right:
                common = min(len(left), len(right))
                first_difference = offset + next((i for i in range(common) if left[i] != right[i]), common)
            if not left and not right:
                break
            offset += max(len(left), len(right))
    return {'byteEqual': first_difference is None, 'firstDifferentByte': first_difference,
            'bytes': [first.stat().st_size, second.stat().st_size],
            'sha256': [h.hexdigest() for h in hashes]}


def parse_counter_receipt(text, rate):
    match = re.search(r'cases(\d+) rate(\d+) baseFrames(\d+) numericWords(\d+) outputBytes(\d+) fixedGraphBytes(\d+) inputSHA256([0-9a-f]{64})', text)
    if not match:
        raise ValueError('missing Go recorder counter receipt')
    keys = ('cases', 'rate', 'baseFrames', 'numericWords', 'outputBytes', 'fixedGraphBytes', 'inputSHA256')
    receipt = dict(zip(keys, [int(x) for x in match.groups()[:-1]] + [match.group(7)]))
    if receipt['rate'] != rate or receipt['cases'] != 27 or receipt['baseFrames'] > 200000 or 4 * receipt['baseFrames'] > 800000 or receipt['numericWords'] > 16 * 1024 * 1024 or receipt['outputBytes'] > OUTPUT_CAP or receipt['fixedGraphBytes'] > 2 * 1024 * 1024:
        raise ValueError('Go recorder admission refused')
    return receipt


def run_pair(rate, run_id, revision):
    if rate not in RATES or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', run_id) or revision != 'post-exit-v2':
        raise ValueError('closed parent admission refused')
    manifest = json.loads((PROOF / f'BUILD-PROVENANCE-{revision}.json').read_text())
    if hashlib.sha256((NATIVE / 'SHA256.json').read_bytes()).hexdigest() != manifest['nativeIndexSHA256']:
        raise ValueError('accepted native index changed')
    run = PROOF / 'runs' / run_id
    run.mkdir(mode=0o700, parents=True, exist_ok=True)
    results = []
    for label in ('baseline', 'candidate'):
        directory = run / f'{label}-rate{rate}'
        directory.mkdir(mode=0o700)  # Exclusive; no evidence overwrite/reuse.
        result = bounded_child([str(NODE), '--stack-size=8192', '--max-old-space-size=192',
                                str(SOURCE / 'wasm-child.mjs'), label, str(rate), run_id, revision], directory)
        results.append({'label': label, 'parent': result})
        print(label, rate, 'exit', result['exit'], 'refusal', result['failure'], flush=True)
        if result['exit'] != 0 or result['failure'] is not None or result['cleanupFailure'] is not None:
            raise RuntimeError('WASM child failed; retained evidence; bounds unchanged')
        receipt_file = directory / 'receipt.json'
        if receipt_file.stat().st_size > 128 * 1024:
            raise ValueError('child receipt admission exceeded')
        receipt = json.loads(receipt_file.read_text())
        counter = parse_counter_receipt((directory / 'child.log').read_text(), rate)
        native = json.loads((NATIVE / f'rate{rate}-comparison.json').read_text())['runs'][0]['receipt']
        for field in ('cases', 'rate', 'baseFrames', 'numericWords', 'outputBytes', 'inputSHA256'):
            if counter[field] != native[field]:
                raise ValueError('WASM/native fixed corpus counters differ: ' + field)
        if receipt['failure'] is not None or receipt['goExit'] != 0 or not receipt['goExited'] or receipt['label'] != label or receipt['rate'] != rate or receipt['runId'] != run_id or receipt['io']['failure'] is not None or not receipt['io']['closed'] or receipt['io']['bytes'] != counter['outputBytes']:
            raise ValueError('child completion/counter receipt refused')
        if receipt['manifestSHA256'] != hashlib.sha256((PROOF / f'BUILD-PROVENANCE-{revision}.json').read_bytes()).hexdigest():
            raise ValueError('child manifest differs from parent')
        module = manifest['modules'][label]
        for field, expected in [('moduleSHA256', module['sha256']), ('sourceSetSHA256', module['sourceSetSHA256']), ('overlaySHA256', module['overlaySHA256']), ('runtimeSHA256', manifest['runtime']['sha256']), ('recorderSHA256', manifest['recorderSHA256'])]:
            if receipt.get(field) != expected:
                raise ValueError('child source/runtime/module provenance mismatch: ' + field)
        output = directory / f'rate{rate}.bin'
        if output.stat().st_size != counter['outputBytes']:
            raise ValueError('actual file length differs from receipt')
        results[-1]['counter'] = counter
        results[-1]['child'] = receipt
    streams = [run / f'{label}-rate{rate}' / f'rate{rate}.bin' for label in ('baseline', 'candidate')]
    comparison = compare_streams(*streams)
    for item, digest in zip(results, comparison['sha256']):
        if item['child']['outputSHA256'] != digest:
            raise ValueError('independent streamed hash differs from child receipt')
    cross_target = [compare_streams(stream, NATIVE / f'{label}-native-final' / f'rate{rate}.bin') for stream, label in zip(streams, ('baseline', 'candidate'))]
    report = {'rate': rate, 'runId': run_id, 'revision': revision, 'results': results,
              'wasmBaselineCandidate': comparison, 'wasmVsNativeDiagnosticOnly': cross_target,
              'performance': 'NOT MEASURED; wall limits are watchdogs only; no RSS claim'}
    with (run / f'rate{rate}-comparison.json').open('x') as out:
        json.dump(report, out, indent=2)
        out.write('\n')
    print('actual GoJS/WASM byteEqual', rate, comparison['byteEqual'], 'bytes', comparison['bytes'], flush=True)
    if not comparison['byteEqual']:
        raise RuntimeError('actual WASM baseline/candidate byte mismatch retained')


def prepare_revision():
    """Freeze reviewed host-only revision; retain the original module manifest."""
    old_bytes = (PROOF / 'BUILD-PROVENANCE.json').read_bytes()
    old_sha = hashlib.sha256(old_bytes).hexdigest()
    if old_sha != 'd7c7dc4a6702e34e166ac8b162d92662cad3a67955a90ddae87eef367ab19e39':
        raise ValueError('original measured build manifest changed')
    manifest = json.loads(old_bytes)
    if subprocess.check_output(['git', 'diff', 'e4921560a63666ac230bb578d5381886b266d968', '--', '*.go', 'go.mod'], cwd=ROOT):
        raise ValueError('qualified Go source changed')
    if hashlib.sha256((NATIVE / 'SHA256.json').read_bytes()).hexdigest() != manifest['nativeIndexSHA256']:
        raise ValueError('accepted native evidence changed')
    for label, item in manifest['modules'].items():
        if hashlib.sha256(pathlib.Path(item['file']).read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('original module changed')
        if hashlib.sha256((PROOF / (label + '-source-set.json')).read_bytes()).hexdigest() != item['sourceSetSHA256']:
            raise ValueError('original effective source set changed')
        overlay = NATIVE / 'baseline-overlay.json' if label == 'baseline' else ROOT / 'artifacts/private-dsp/recovery-20261023/partitioned-detector-lint-overlay.json'
        if hashlib.sha256(overlay.read_bytes()).hexdigest() != item['overlaySHA256']:
            raise ValueError('original overlay changed')
    if hashlib.sha256(pathlib.Path(manifest['runtime']['path']).read_bytes()).hexdigest() != manifest['runtime']['sha256']:
        raise ValueError('original runtime changed')
    original_index = (PROOF / 'RUNNER-SOURCE-SHA256.json').read_bytes()
    for item in json.loads(original_index)['files']:
        if hashlib.sha256((PROOF / 'source-frozen' / pathlib.Path(item['file']).name).read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('original runner source evidence changed')
    manifest['revision'] = 'post-exit-v2'
    manifest['parentBuildSHA256'] = old_sha
    manifest['parentRunnerSourceIndexSHA256'] = hashlib.sha256(original_index).hexdigest()
    manifest['runnerFiles'] = {}
    frozen = PROOF / 'source-frozen-post-exit-v2'
    frozen.mkdir(mode=0o700)
    for path in sorted(SOURCE.iterdir()):
        if path.is_file():
            data = path.read_bytes()
            (frozen / path.name).write_bytes(data)
            manifest['runnerFiles'][path.name] = hashlib.sha256(data).hexdigest()
    manifest['nativeCounterReceipts'] = {str(rate): json.loads((NATIVE / f'rate{rate}-comparison.json').read_text())['runs'][0]['receipt'] for rate in RATES}
    with (PROOF / 'BUILD-PROVENANCE-post-exit-v2.json').open('x') as out:
        json.dump(manifest, out, indent=2)
        out.write('\n')
    print('Host-only post-exit-v2 manifest frozen; SAME2Go modules/source/overlays/runtime; old evidence untouched')


if __name__ == '__main__':
    if sys.argv[1:] == ['--prepare-post-exit-v2']:
        prepare_revision()
    elif len(sys.argv) == 4:
        run_pair(int(sys.argv[1]), sys.argv[2], sys.argv[3])
    else:
        raise SystemExit('usage: run-wasm-pair.py CLOSED_RATE NEW_RUN_ID post-exit-v2')
