"""Private held Python command evidence. No browser, client, socket or GPU work."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
from owned_groups import OwnedGroups, command_hash, snapshot
from observed_process import ObservedProcess
from attention_contract import check_resources, final_empty, parse_actual_command
from attention_identity import RECORD_CAP, static_identity

# Reuse the existing private runner's bounded file/disk helpers, never its main.
_spec = importlib.util.spec_from_file_location('attention_parent_utilities', Path(__file__).with_name('attention-parent.py'))
_parent = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_parent)
read_metadata = _parent.read_metadata
write_metadata = _parent.write_metadata
directory_bytes = _parent.directory_bytes


def error_record(error):
    return {'type': type(error).__name__, 'message': str(error)[:2048]}


def ready_marker(value, pid, token):
    if not isinstance(value, dict) or set(value) != {'phase', 'pid', 'token'} or value != {'phase': 'identity-held-before-bind', 'pid': pid, 'token': token}:
        raise RuntimeError('Exact held Python ready marker required')


def wait_ready(child, path, token, precheck, *, clock=time.monotonic, sleep=time.sleep):
    until = clock() + 5
    while clock() < until:
        precheck(child)
        if path.stat().st_size:
            ready_marker(read_metadata(path), child.pid, token)
            return
        if child.poll() is not None:
            raise RuntimeError('Python exited before held ready marker')
        sleep(.025)
    raise RuntimeError('Held Python ready deadline')


def run_child(launch, environment, output, token, pin, check, precheck, persist, *, spawn=subprocess.Popen, groups=OwnedGroups, ready=wait_ready, capture=static_identity):
    """Injected source controls never invoke real process APIs. Main owns I/O."""
    child, owned, primary, final = None, None, None, None
    cleanup, strict = [], None
    # All post-Popen setup is inside this try/finally. Until the child publishes
    # ready (after launcher->framework exec), only the exact Popen handle owns it.
    try:
        with (output / 'child-ready.json').open('xb') as ready_file, (output / 'child-stderr.log').open('xb') as log:
            child = spawn(launch, env=environment, start_new_session=True, stdin=subprocess.PIPE, stdout=ready_file, stderr=log, bufsize=0)
            ready(child, output / 'child-ready.json', token, precheck)
            owned = groups(child.pid, os.getpid(), token)
            check(owned)
            expected = dict(owned.leaders['node'])
            text = capture(expected, pin, persist)
            try:
                parts = parse_actual_command(text, pin['path'])
                strict = {'status': 'matches' if parts == launch else 'rejected', 'parsed': parts, 'expected': launch}
            except Exception as error:
                strict = {'status': 'rejected', 'error': error_record(error), 'expected': launch}
            # A rejected prefix remains diagnostic evidence, never qualification.
            check(owned)
    except BaseException as error:
        primary = error_record(error)
    finally:
        if child is not None:
            try:
                if child.stdin is None:
                    raise RuntimeError('Exact held child stdin handle missing')
                child.stdin.close()  # EOF exits hold without any socket bind.
            except BaseException as error:
                cleanup.append({'phase': 'hold-stdin-close', **error_record(error)})
        if owned is not None:
            try:
                owned.cleanup()
            except BaseException as error:
                cleanup.append({'phase': 'owned-groups', **error_record(error)})
        if child is not None:
            try:
                # Before group admission this exact direct child cannot release
                # the source barrier or spawn work. Only its Popen is signaled.
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=3)
            except BaseException as error:
                cleanup.append({'phase': 'direct-child-reap', **error_record(error)})
                try:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=1)
                except BaseException as fallback:
                    cleanup.append({'phase': 'direct-child-kill-reap', **error_record(fallback)})
        try:
            if owned is None:
                raise RuntimeError('No held Python group admitted')
            final = owned.observe()
            final_empty(final)
            check(owned)
        except BaseException as error:
            cleanup.append({'phase': 'final-owned-empty-bounds', **error_record(error)})
    return {'status': 'observed' if primary is None and not cleanup else 'fail', 'scope': 'held Python identity evidence only; not normal/crash/adapter qualification', 'primary': primary, 'cleanup': cleanup, 'strictCommand': strict, 'launch': launch, 'exitCode': None if child is None else child.poll(), 'leaders': None if owned is None else owned.leaders, 'events': [] if owned is None else owned.events, 'finalObservation': final, 'socketBound': False, 'stdinWorkReleaseSent': False, 'browserLaunched': False, 'gpuRequested': False, 'audioProcessing': False}


def checked_file(path, pin):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != pin['bytes']:
        raise RuntimeError('Pinned identity runtime/source geometry changed')
    with path.open('rb') as source:
        digest, count = hashlib.sha256(), 0
        while True:
            data = source.read(65536)
            if not data:
                break
            count += len(data)
            if count > pin['bytes']:
                raise RuntimeError('Pinned identity runtime/source grew')
            digest.update(data)
    if count != pin['bytes'] or digest.hexdigest() != pin['sha256']:
        raise RuntimeError('Pinned identity runtime/source checksum changed')


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    base = Path(__file__).resolve().parents[2]
    output = Path(args.output).absolute()
    output.relative_to(base / 'artifacts')
    if output.exists() or output.is_symlink() or output.parent.resolve() != output.parent:
        raise RuntimeError('Fresh non-symlink identity output required')
    pins = json.loads(Path(__file__).with_name('attention-python-identity-pins.json').read_text())
    checked_file(Path(pins['python']['path']), pins['python'])
    for pin in pins['sources']:
        checked_file(base / pin['path'], pin)
    # No subprocess capable of work exists before snapshot/parent/free admission.
    if os.getpid() not in snapshot() or command_hash(os.getpid()) is None:
        raise RuntimeError('Identity parent observation preflight refused')
    supervisor = ObservedProcess(os.getpid())
    started, observations, records = time.monotonic(), [], []
    def resource(observed, known):
        disk = os.statvfs(base)
        value = check_resources(observed, known, directory_bytes(output) if output.exists() else 0, disk.f_bavail * disk.f_frsize, time.monotonic() - started, supervisor.observe(snapshot()))
        if len(observations) >= 256:
            raise RuntimeError('Identity observation record quota')
        observations.append(value)
    resource({'liveMembers': []}, 1)
    output.mkdir(mode=0o700)
    scratch = output / 'scratch'
    scratch.mkdir(mode=0o700)
    token = secrets.token_hex(32)
    def precheck(child):
        rows = snapshot()
        row = rows.get(child.pid)
        if row is None or row['ppid'] != os.getpid() or row['pgid'] != child.pid or 'Z' in row['state']:
            raise RuntimeError('Exact pre-ready direct child unavailable')
        members = [value for value in rows.values() if value['pgid'] == child.pid and 'Z' not in value['state']]
        if len(members) != 1 or members[0]['pid'] != child.pid:
            raise RuntimeError('Unadmitted child group grew before held ready')
        resource({'liveMembers': members}, 2)
    def check(owned):
        resource(owned.observe(), len(owned.known) + 1)
    def persist(record):
        if records:
            raise RuntimeError('Only one identity record permitted')
        encoded = (json.dumps(record, indent=2) + '\n').encode()
        if len(encoded) > RECORD_CAP:
            raise RuntimeError('Identity serialization cap')
        disk = os.statvfs(base)
        if directory_bytes(output) + len(encoded) + 1048576 > 64 * 1024 ** 2 or disk.f_bavail * disk.f_frsize - len(encoded) - 1048576 < 6 * 1024 ** 3:
            raise RuntimeError('Identity evidence write admission refused')
        path = output / 'static-command-before-parse.json'
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as file:
            file.write(encoded)
        closed = path.read_bytes()
        if closed != encoded:
            raise RuntimeError('Closed identity evidence changed')
        records.append({'path': path.name, 'bytes': len(closed), 'sha256': hashlib.sha256(closed).hexdigest()})
    launch = [pins['python']['path'], str(base / pins['servePath'])]
    environment = {**os.environ, 'AURIALIS_ATTENTION_IDENTITY_HOLD': token, 'PYTHONDONTWRITEBYTECODE': '1', 'TMPDIR': str(scratch) + '/'}
    result = run_child(launch, environment, output, token, pins['python'], check, precheck, persist)
    result.update({'version': 1, 'seconds': time.monotonic() - started, 'observations': observations, 'records': records, 'limits': {'wallSecondsLastResourceCheck': 60, 'unionSampledRSSBytes': 4 * 1024 ** 3, 'outputBytes': 64 * 1024 ** 2, 'minimumFreeBytes': 6 * 1024 ** 3, 'liveProcesses': 256, 'knownIdentities': 4096}, 'sharedLeaderLabel': 'node is the unchanged OwnedGroups key for this direct Python leader; no Node launched'})
    encoded = (json.dumps(result, indent=2) + '\n').encode()
    if len(encoded) > 1048576:
        raise RuntimeError('Identity result serialization cap')
    # Last resource admission precedes writes; no hard post-write deadline claim.
    resource({'liveMembers': [] if result['finalObservation'] is None else result['finalObservation']['liveMembers']}, 2)
    disk = os.statvfs(base)
    if directory_bytes(output) + len(encoded) + 4096 > 64 * 1024 ** 2 or disk.f_bavail * disk.f_frsize - len(encoded) - 4096 < 6 * 1024 ** 3:
        raise RuntimeError('Identity final write admission refused')
    receipt = output / 'identity-receipt.json'
    with receipt.open('xb') as file:
        file.write(encoded)
    closed = receipt.read_bytes()
    if closed != encoded:
        raise RuntimeError('Identity closed receipt mismatch')
    verdict = {'version': 1, 'status': result['status'], 'qualification': False, 'receiptSHA256': hashlib.sha256(closed).hexdigest(), 'seconds': time.monotonic() - started, 'primary': result['primary'], 'cleanupCount': len(result['cleanup']), 'authority': 'observed/fail evidence only, never normal/crash/adapter qualification; last resource check before final writes'}
    write_metadata(output / 'final-verdict.json', verdict)
    print(json.dumps(verdict), flush=True)
    return 0 if result['status'] == 'observed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
