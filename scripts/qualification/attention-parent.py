#!/usr/bin/env python3
"""Private normal/crash guard; shared OwnedGroups is the sole group authority."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import time
import traceback
from owned_groups import OwnedGroups, command_hash, snapshot
from observed_process import ObservedProcess
from attention_identity import RECORD_CAP, static_identity
from attention_contract import ProbeState, check_browser_command, check_resources, final_empty, node_command, parse_actual_command


def read_metadata(path):
    if path.is_symlink() or not path.is_file() or not 1 <= path.stat().st_size <= 4096:
        raise RuntimeError('Invalid bounded ownership metadata')
    with path.open('rb') as file:
        data = file.read(4097)
    if len(data) > 4096:
        raise RuntimeError('Ownership metadata grew beyond cap')
    value = json.loads(data)
    if not isinstance(value, dict):
        raise RuntimeError('Ownership metadata must be an object')
    return value


def write_metadata(path, value):
    data = json.dumps(value).encode()
    if len(data) > 4096:
        raise RuntimeError('Ownership acknowledgment exceeds bound')
    temporary = path.with_name(path.name + '.writing')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as file:
            file.write(data)
        os.link(temporary, path)
    finally:
        temporary.unlink()


def directory_bytes(root):
    total = 0
    for current, directories, names in os.walk(root, followlinks=False):
        for name in directories + names:
            path = Path(current) / name
            if path.is_symlink():
                try:
                    total += path.lstat().st_size
                except FileNotFoundError:
                    pass
        for name in names:
            path = Path(current) / name
            try:
                if not path.is_symlink():
                    total += path.lstat().st_size
            except FileNotFoundError:
                pass
    return total


def actual_command(pid, executable):
    text = subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'command='], text=True, timeout=3).strip()
    return parse_actual_command(text, executable)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['normal', 'crash'], required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    base = Path(__file__).resolve().parents[2]
    output = Path(args.output).absolute()
    output.relative_to(base / 'artifacts')
    # No symlink or existing output path may redirect this fresh run.
    if output.exists() or output.is_symlink() or output.parent.resolve() != output.parent:
        raise RuntimeError('Fresh non-symlink artifact output required')
    pins = json.loads((Path(__file__).parent / 'attention-launch-pins.json').read_text())
    for key in ('node', 'python', 'brave', 'playwrightEntry', 'playwrightPackage', 'playwrightCore'):
        pin = pins[key]
        path = Path(pin['path'])
        if path.is_symlink() or not path.is_file() or path.stat().st_size != pin['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != pin['sha256']:
            raise RuntimeError('Pinned runtime file changed: ' + key)
    for pin in pins['helpers']:
        path = base / pin['path']
        if path.is_symlink() or not path.is_file() or path.stat().st_size != pin['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != pin['sha256']:
            raise RuntimeError('Pinned helper changed before launch')
    if subprocess.check_output([pins['node']['path'], '--version'], text=True, timeout=3).strip() != 'v26.12.0':
        raise RuntimeError('Pinned Node26 required')
    # Observation denial fails before any Popen or detached browser can exist.
    rows = snapshot()
    if os.getpid() not in rows or command_hash(os.getpid()) is None:
        raise RuntimeError('Parent monitoring preflight refused')
    supervisor = ObservedProcess(os.getpid())
    if os.statvfs(base).f_bavail * os.statvfs(base).f_frsize < 6 * 1024 ** 3:
        raise RuntimeError('6 GiB free reserve unavailable before launch')
    output.mkdir(mode=0o700)
    scratch = output / 'scratch'
    scratch.mkdir(mode=0o700)
    control = output / 'ownership'
    control.mkdir(mode=0o700)
    token = secrets.token_hex(32)
    launch = node_command(pins['node']['path'], str(Path(__file__).with_name('attention-launch.mjs')), args.mode, str(control))
    environment = dict(os.environ, TMPDIR=str(scratch) + '/', AURIALIS_OWNERSHIP_DIR=str(control), AURIALIS_OWNERSHIP_TOKEN=token)
    child, owned, state = None, None, None
    primary, cleanup, final, post_crash = None, [], None, None
    browser_ack, server_ack, forced_crash = False, False, False
    browser_command, server_command, profile = None, None, None
    before, survivors, observations, command_observations = [], [], [], []
    def persist_command(record):
        if len(command_observations) >= 2:
            raise RuntimeError('STATIC command observation quota')
        data = (json.dumps(record, indent=2) + '\n').encode()
        if len(data) > RECORD_CAP:
            raise RuntimeError('STATIC command observation serialization cap')
        observed = owned.observe()
        disk = os.statvfs(base)
        check_resources(observed, len(owned.known) + 1, directory_bytes(output) + len(data), disk.f_bavail * disk.f_frsize - len(data), time.monotonic() - started, supervisor.observe(snapshot()))
        name = 'static-command-before-parse-' + str(len(command_observations)) + '.json'
        descriptor = os.open(output / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as file:
            file.write(data)
        command_observations.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'record': record})
    started = time.monotonic()
    try:
        with (output / 'launcher.log').open('xb') as log:
            child = subprocess.Popen(launch, env=environment, start_new_session=True, stdout=log, stderr=subprocess.STDOUT)
            owned = OwnedGroups(child.pid, os.getpid(), token)
            state = ProbeState(token, child.pid)
            write_metadata(control / 'node-ack.json', {'token': token, 'nodePID': child.pid, 'parentPID': os.getpid(), 'phase': 'node-admitted'})
            while True:
                current_rows = snapshot()
                observed = owned.observe(current_rows)
                disk = os.statvfs(base)
                check = check_resources(observed, len(owned.known) + 1, directory_bytes(output), disk.f_bavail * disk.f_frsize, time.monotonic() - started, supervisor.observe(current_rows))
                if len(observations) >= 512:
                    raise RuntimeError('Observation record cap')
                observations.append(check)
                candidate = control / 'candidate.json'
                if not browser_ack and candidate.exists():
                    value = read_metadata(candidate)
                    if set(value) != {'token', 'nodePID', 'browserPID', 'browserExecutable'} or value['browserExecutable'] != pins['brave']['path']:
                        raise RuntimeError('Closed browser executable candidate required')
                    acknowledgement = owned.admit_browser(value)
                    browser_command = actual_command(value['browserPID'], pins['brave']['path'])
                    profile = check_browser_command(browser_command, pins['brave']['path'], scratch)
                    state.browser_admitted(value['browserPID'])
                    write_metadata(control / 'ack.json', {**acknowledgement, 'parentPID': os.getpid()})
                    browser_ack = True
                server = control / 'static-server.json'
                if not server_ack and server.exists():
                    if not browser_ack:
                        raise RuntimeError('Static server appeared before browser ACK')
                    value = read_metadata(server)
                    observed = owned.observe()
                    state.admit_server(value, observed)
                    raw_static_command = static_identity(state.server, pins['python'], persist_command)
                    server_command = parse_actual_command(raw_static_command, pins['python']['path'])
                    expected = [pins['python']['path'], str(base / 'internal/audio/steminfer/testdata/webgpu/attention/serve.py')]
                    if server_command != expected:
                        raise RuntimeError('Actual static server executable/source mismatch')
                    server_ack = True
                requests = sorted(control.glob('before-worker-*.json'))
                if len(requests) > 8:
                    raise RuntimeError('Prework metadata cap')
                for request in requests:
                    if request.name.endswith('-ack.json') or request.with_name(request.stem + '-ack.json').exists():
                        continue
                    value = read_metadata(request)
                    if request.name != 'before-worker-' + value.get('id', '') + '.json':
                        raise RuntimeError('Prework filename identity mismatch')
                    observed = owned.observe()
                    state.admit_work(value, observed)
                    disk = os.statvfs(base)
                    check_resources(observed, len(owned.known) + 1, directory_bytes(output), disk.f_bavail * disk.f_frsize, time.monotonic() - started, supervisor.observe(snapshot()))
                    write_metadata(request.with_name(request.stem + '-ack.json'), value)
                ready = control / 'probe-ready.json'
                if args.mode == 'crash' and not forced_crash and ready.exists():
                    state.ready(read_metadata(ready), args.mode)
                    observed = owned.observe()
                    before = [dict(row) for row in observed['liveMembers'] if row['pgid'] == state.browser]
                    if not any(row['pid'] == child.pid for row in observed['liveMembers']):
                        raise RuntimeError('Node exited before deliberate crash')
                    # Exact direct Popen only; group signaling remains OwnedGroups.
                    child.kill()
                    child.wait(timeout=3)
                    forced_crash = True
                    post_crash = owned.observe()
                    survivors = state.crash_survivors(before, post_crash['liveMembers'])
                if child.poll() is not None:
                    break
                # Leave settlement/cleanup room within the overall60s deadline.
                if time.monotonic() - started > 25:
                    raise RuntimeError('Ownership work phase deadline')
                time.sleep(.05)
            if not browser_ack or not server_ack or not state.work:
                raise RuntimeError('Node exited before all admission barriers')
            state.ready(read_metadata(control / 'probe-ready.json'), args.mode)
            if args.mode == 'crash':
                if not forced_crash or child.returncode != -signal.SIGKILL:
                    raise RuntimeError('Deliberate crash result changed')
            elif child.returncode != 0:
                raise RuntimeError('Normal launcher exited unsuccessfully')
    except BaseException as error:
        primary = {'type': type(error).__name__, 'message': str(error)[:4096], 'traceback': traceback.format_exc()[-8192:]}
    finally:
        # Before browser admission, TERM is flag-only in Node. Do not kill it
        # between launchServer and actual handle settlement/candidate closure.
        if child is not None and owned is not None and 'browser' not in owned.leaders and child.poll() is None:
            try:
                child.terminate()
                child.wait(timeout=max(.01, min(25, 55 - (time.monotonic() - started))))
            except BaseException as error:
                cleanup.append({'phase': 'unadmitted-startup-settlement', 'error': str(error)[:4096]})
        if owned is not None and (child.poll() is not None or 'browser' in owned.leaders):
            try:
                final = owned.cleanup()
            except BaseException as error:
                cleanup.append({'phase': 'owned-groups', 'error': str(error)[:4096], 'details': getattr(error, 'details', None)})
        if child is not None:
            try:
                if child.poll() is None and (owned is None or 'browser' in owned.leaders):
                    child.terminate()
                child.wait(timeout=max(.01, min(3, 59 - (time.monotonic() - started))))
            except BaseException as error:
                cleanup.append({'phase': 'direct-child-reap', 'error': str(error)[:4096]})
        try:
            if owned is None:
                raise RuntimeError('No admitted ownership observation')
            final = owned.observe()
            final_empty(final)
            disk = os.statvfs(base)
            check_resources(final, len(owned.known) + 1, directory_bytes(output), disk.f_bavail * disk.f_frsize, time.monotonic() - started, supervisor.observe(snapshot()))
        except BaseException as error:
            cleanup.append({'phase': 'final-bounds-and-empty-observation', 'error': str(error)[:4096]})
        result = {'version': 1, 'mode': args.mode, 'status': 'candidate-pass' if primary is None and not cleanup else 'fail', 'scope': 'actual normal/crash ownership only if separately released; no audio/GPU request', 'audioProcessing': False, 'gpuRequested': False, 'launch': launch, 'browserCommand': browser_command, 'staticServerCommand': server_command, 'staticCommandObservations': command_observations, 'profile': profile, 'primary': primary, 'cleanup': cleanup, 'exitCode': child.poll() if child else None, 'seconds': time.monotonic() - started, 'observations': observations, 'leaders': owned.leaders if owned else None, 'admissions': owned.admissions if owned else [], 'events': owned.events if owned else [], 'preCrashBrowserMembers': before, 'confirmedCrashSurvivors': survivors, 'postCrashObservation': post_crash, 'finalObservation': final, 'limits': {'wallSeconds': 60, 'workSeconds': 25, 'outputBytesIncludingScratch': 64 * 1024 ** 2, 'minimumFreeBytes': 6 * 1024 ** 3, 'unionRSSBytes': 4 * 1024 ** 3, 'liveProcesses': 256, 'knownIdentities': 4096}}
        terminal_status = 'fail'
        receipt_hash = None
        try:
            encoded = (json.dumps(result, indent=2) + '\n').encode()
            if len(encoded) > 8 * 1024 ** 2:
                raise RuntimeError('Guard receipt bounded serialization cap')
            disk = os.statvfs(base)
            check_resources(final or {'liveMembers': []}, len(owned.known) + 1 if owned else 1, directory_bytes(output) + len(encoded) + 4096, disk.f_bavail * disk.f_frsize - len(encoded) - 4096, time.monotonic() - started, supervisor.observe(snapshot()))
            with (output / 'guard-receipt.json').open('xb') as file:
                file.write(encoded)
            closed_bytes = (output / 'guard-receipt.json').read_bytes()
            receipt_hash = hashlib.sha256(closed_bytes).hexdigest()
            if closed_bytes != encoded:
                raise RuntimeError('Closed guard receipt changed')
            if owned is None:
                raise RuntimeError('Missing final owned observer')
            final_empty(owned.observe())
            disk = os.statvfs(base)
            check_resources(final, len(owned.known) + 1, directory_bytes(output) + 4096, disk.f_bavail * disk.f_frsize - 4096, time.monotonic() - started, supervisor.observe(snapshot()))
            if result['status'] == 'candidate-pass':
                terminal_status = 'pass'
        except BaseException as error:
            cleanup.append({'phase': 'closed-receipt-and-final-admission', 'error': str(error)[:4096]})
        verdict = {'version': 1, 'mode': args.mode, 'status': terminal_status, 'guardReceiptSHA256': receipt_hash, 'seconds': time.monotonic() - started, 'primary': None if primary is None else {'type': primary['type'], 'message': primary['message'][:512]}, 'cleanupCount': len(cleanup), 'cleanupSummary': [{'phase': item['phase'], 'error': item['error'][:256]} for item in cleanup[-2:]], 'authority': 'Final verdict only; guard receipt is provisional until closed/hashed and final no-live-process/admission checks settle'}
        try:
            write_metadata(output / 'final-verdict.json', verdict)
        except BaseException as error:
            verdict['status'] = 'fail'
            verdict['verdictWriteFailure'] = str(error)[:1024]
        print(json.dumps(verdict), flush=True)
        result['status'] = verdict['status']

    return 0 if result['status'] == 'pass' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status': 'fail', 'phase': 'prelaunch', 'error': str(error)[:4096], 'workQualified': False}), flush=True)
        raise SystemExit(1)
