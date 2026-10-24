#!/usr/bin/env python3
"""Bounded task-owned Album runner; actual browser admission precedes work."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shlex
import signal
import subprocess
import sys
import time
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parent / 'qualification'))
from owned_groups import OwnedGroups, command_hash, snapshot  # noqa: E402
from observed_process import ObservedProcess, union_rows, known_group_survivors  # noqa: E402

MIB = 1024 ** 2
GIB = 1024 ** 3
MAX_DATA = 11 * GIB // 10
MIN_FREE = 6 * GIB + 128 * MIB


def directory_bytes(path):
    total = 0
    for root, _, files in os.walk(path, followlinks=False):
        for name in files:
            file = Path(root) / name
            try:
                if not file.is_symlink():
                    total += file.stat().st_size
            except FileNotFoundError:
                pass
    return total


def read_metadata(path):
    if path.is_symlink() or not path.is_file() or not 1 <= path.stat().st_size <= 4096:
        raise RuntimeError('Invalid bounded ownership metadata')
    value = json.loads(path.read_text())
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


def command(pid):
    return subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'command='], text=True, timeout=3).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--budget-root', required=True)
    parser.add_argument('--scratch', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--mode', choices=['normal', 'crash', 'scale'], required=True)
    parser.add_argument('--project', choices=['album-native-scale', 'album-browser-scale'], default='album-native-scale')
    parser.add_argument('--native-pid', type=int)
    parser.add_argument('--seconds', type=int, default=1800)
    arguments = parser.parse_args()
    base = Path.cwd().resolve()
    root, scratch = Path(arguments.budget_root).resolve(), Path(arguments.scratch).resolve()
    root.relative_to(base / 'artifacts')
    scratch.relative_to(root)
    node_path = Path(arguments.node).resolve(strict=True)
    if not node_path.is_file() or not 1 <= arguments.seconds <= 1800:
        parser.error('Exact Node binary and a wall limit between 1 and 1800 seconds required')
    if arguments.mode != 'scale' and arguments.seconds > 60:
        parser.error('No-audio controls require a wall limit of at most 60 seconds')
    if arguments.mode == 'scale' and arguments.project == 'album-native-scale' and not arguments.native_pid:
        parser.error('Native scale must include its external host in union accounting')
    if subprocess.check_output([str(node_path), '--version'], text=True, timeout=3).strip() != 'v26.12.0':
        raise RuntimeError('Qualification requires the actual pinned Node 26.12.0 child')
    # Denied observation must fail before Popen, and Node waits for admission ACK
    # before launching BrowserServer. A setup failure cannot escape that barrier.
    preflight = snapshot()
    if os.getpid() not in preflight or command_hash(os.getpid()) is None:
        raise RuntimeError('Parent process monitoring preflight failed')
    native = ObservedProcess(arguments.native_pid) if arguments.native_pid else None
    if native:
        executable = Path(shlex.split(command(arguments.native_pid))[0]).resolve(strict=True)
        executable.relative_to(base)
        if not executable.is_file() or not executable.name.startswith('aurialis'):
            raise RuntimeError('Native host must be this worktree task-owned executable')
    root.mkdir(parents=True, exist_ok=True)
    scratch.mkdir(mode=0o700, parents=False, exist_ok=False)
    control = scratch / 'ownership'
    control.mkdir(mode=0o700)
    receipt = root / ('guard-' + scratch.name + '.json')
    if receipt.exists():
        raise RuntimeError('Refusing to overwrite an earlier guard receipt')
    facts = os.statvfs(base)
    minimum_free = facts.f_bavail * facts.f_frsize
    if minimum_free < MIN_FREE:
        raise RuntimeError('6 GiB reserve plus 128 MiB guard unavailable before launch')
    result_directory = root / ('results-' + scratch.name)
    result_json = root / ('results-' + scratch.name + '.json')
    if result_directory.exists() or result_json.exists():
        raise RuntimeError('Refusing to overwrite prior Playwright results')
    token = secrets.token_hex(32)
    environment = dict(os.environ, TMPDIR=str(scratch) + '/', AURIALIS_OWNERSHIP_DIR=str(control), AURIALIS_OWNERSHIP_TOKEN=token, AURIALIS_ALBUM_SCALE_SOURCES=str(root / 'sources'), AURIALIS_ALBUM_SCALE_OUTPUT=str(result_directory), AURIALIS_ALBUM_SCALE_JSON=str(result_json))
    launch = [str(node_path), 'scripts/qualification/playwright-scale.mjs', arguments.mode, arguments.project, str(control)]
    child, owned = None, None
    primary, cleanup, final_observation, post_crash = None, [], None, None
    pre_crash_browser, crash_survivors = [], []
    browser_ack = False
    before_ack, profiles = [], set()
    samples, forced_crash = 0, False
    peaks = dict.fromkeys(['dataBytes', 'scratchBytes', 'ownedRSS', 'nativeRSS', 'nodeRSS', 'browserProcessRSS', 'processes'], 0)
    started = time.monotonic()
    log = root / ('launcher-' + scratch.name + '.log')
    try:
        with log.open('xb') as output:
            child = subprocess.Popen(launch, env=environment, start_new_session=True, stdout=output, stderr=subprocess.STDOUT)
            owned = OwnedGroups(child.pid, os.getpid(), token)
            write_metadata(control / 'node-ack.json', {'token': token, 'nodePID': child.pid, 'parentPID': os.getpid(), 'phase': 'node-admitted'})
            while True:
                rows = snapshot()
                observed = owned.observe(rows)
                candidate = control / 'candidate.json'
                if not browser_ack and candidate.exists():
                    value = read_metadata(candidate)
                    acknowledgment = owned.admit_browser(value)
                    browser_command = shlex.split(command(value['browserPID']))
                    found = [part.split('=', 1)[1] for part in browser_command if part.startswith('--user-data-dir=')]
                    if len(found) != 1:
                        raise RuntimeError('Actual browser profile directory missing or ambiguous')
                    profile = Path(found[0]).resolve()
                    profile.relative_to(scratch)
                    profiles.add(str(profile))
                    write_metadata(control / 'ack.json', {**acknowledgment, 'parentPID': os.getpid()})
                    browser_ack = True
                    rows = snapshot()
                    observed = owned.observe(rows)
                requests = sorted(control.glob('before-worker-*.json'))
                if len(requests) > 32:
                    raise RuntimeError('Ownership work-acknowledgment metadata quota exceeded')
                for request in requests:
                    if request.name.endswith('-ack.json') or request.stem in before_ack:
                        continue
                    if len(before_ack) >= 16 or not browser_ack:
                        raise RuntimeError('Unexpected work acknowledgment demand')
                    value = read_metadata(request)
                    expected = {'token', 'nodePID', 'browserPID', 'workerPID', 'phase', 'id'}
                    if set(value) != expected or value['token'] != token or value['nodePID'] != child.pid or value['browserPID'] != owned.leaders['browser']['pid'] or value['phase'] != 'before-worker' or request.name != 'before-worker-' + value['id'] + '.json':
                        raise RuntimeError('Work ownership identity mismatch')
                    member = next((row for row in observed['liveMembers'] if row['pid'] == value['workerPID']), None)
                    if member is None or member['pgid'] != child.pid:
                        raise RuntimeError('Work requester is not an admitted live Node-group member')
                    # Fresh actual process observation precedes every work ACK.
                    owned.observe()
                    write_metadata(control / (request.stem + '-ack.json'), value)
                    before_ack.append(request.stem)
                external = native.observe(rows) if native else None
                combined = union_rows(observed['liveMembers'], external)
                node_rss = max([row['rssBytes'] for row in observed['liveMembers'] if row['pgid'] == child.pid] or [0])
                browser_rss = max([row['rssBytes'] for row in observed['liveMembers'] if row['pgid'] != child.pid] or [0])
                values = {'dataBytes': directory_bytes(root), 'scratchBytes': directory_bytes(scratch), 'ownedRSS': sum(row['rssBytes'] for row in combined), 'nativeRSS': external['rssBytes'] if external else 0, 'nodeRSS': node_rss, 'browserProcessRSS': browser_rss, 'processes': len(combined)}
                disk = os.statvfs(base)
                available = disk.f_bavail * disk.f_frsize
                minimum_free = min(minimum_free, available)
                for name, value in values.items():
                    peaks[name] = max(peaks[name], value)
                samples += 1
                limits = [(time.monotonic() - started > arguments.seconds, 'Target wall deadline'), (values['dataBytes'] > MAX_DATA, 'Aggregate scale data exceeds 1.1 GiB'), (values['scratchBytes'] > 512 * MIB, 'Profile/download scratch exceeds 512 MiB'), (log.stat().st_size > 128 * MIB, 'Launcher log exceeds 128 MiB'), (available < MIN_FREE, '6 GiB reserve plus 128 MiB guard'), (node_rss > GIB, 'Node process exceeds 1 GiB'), (values['nativeRSS'] > GIB, 'Native process exceeds 1 GiB'), (browser_rss > 3 * GIB, 'Browser process exceeds 3 GiB'), (values['ownedRSS'] > 4 * GIB, 'Union owned RSS including native exceeds 4 GiB'), (len(combined) > 256, 'Owned process count exceeds 256')]
                for exceeded, reason in limits:
                    if exceeded:
                        raise RuntimeError(reason)
                ready = control / 'probe-ready.json'
                if arguments.mode == 'crash' and not forced_crash and ready.exists():
                    proof = read_metadata(ready)
                    if proof.get('token') != token or proof.get('nodePID') != child.pid or proof.get('browserPID') != owned.leaders['browser']['pid'] or proof.get('status') != 'pass' or proof.get('ownershipAcknowledgedBeforeWorker') is not True or not before_ack:
                        raise RuntimeError('Invalid acknowledged crash-control readiness')
                    check = owned.observe()
                    if not any(row['pid'] == child.pid for row in check['liveMembers']):
                        raise RuntimeError('Crash-control root exited before deliberate signal')
                    browser_group = owned.leaders['browser']['pgid']
                    pre_crash_browser = [dict(row) for row in check['liveMembers'] if row['pgid'] == browser_group]
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)
                    forced_crash = True
                    post_crash = owned.observe()
                    crash_survivors = known_group_survivors(pre_crash_browser, post_crash['liveMembers'], browser_group)
                    if not crash_survivors:
                        raise RuntimeError('No exact pre-admitted browser-group member survived controlled Node crash')
                if child.poll() is not None:
                    break
                time.sleep(.1 if not browser_ack else .25)
            if not browser_ack or not before_ack:
                raise RuntimeError('Root exited without acknowledged browser/work ownership')
            if arguments.mode == 'crash':
                if not forced_crash or child.returncode != -signal.SIGKILL:
                    raise RuntimeError('Controlled crash did not observe expected root exit')
            elif child.returncode != 0:
                raise RuntimeError('Qualification root exited unsuccessfully')
    except BaseException as error:
        primary = {'type': type(error).__name__, 'message': str(error)[:4096], 'traceback': traceback.format_exc()[-8192:]}
    finally:
        # Before the BrowserServer handle/candidate settles, terminating Node
        # could orphan an unadmitted detached child. Flag-only TERM lets the
        # bootstrap finish its bounded launch and close that actual handle.
        if child is not None and owned is not None and 'browser' not in owned.leaders and child.poll() is None:
            try:
                child.terminate()
                child.wait(timeout=25)
            except BaseException as error:
                cleanup.append({'phase': 'unadmitted-startup-settlement', 'type': type(error).__name__, 'message': str(error)[:4096]})
        if owned is not None and (child is None or child.poll() is not None or 'browser' in owned.leaders):
            try:
                final_observation = owned.cleanup()
            except BaseException as error:
                cleanup.append({'phase': 'owned-groups', 'type': type(error).__name__, 'message': str(error)[:4096], 'details': getattr(error, 'details', None)})
        if child is not None:
            # Reap our direct Popen even if group observation was refused. Node
            # cannot launch Chrome before ACK; its own finally closes the server.
            try:
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=5)
            except BaseException as error:
                cleanup.append({'phase': 'direct-child', 'type': type(error).__name__, 'message': str(error)[:4096]})
        try:
            if owned is not None:
                final_observation = owned.observe()
                if final_observation['liveMembers']:
                    raise RuntimeError('Final owned groups remain live')
            if directory_bytes(root) > MAX_DATA or directory_bytes(scratch) > 512 * MIB:
                raise RuntimeError('Final task disk size exceeds bound')
            final_disk = os.statvfs(base)
            minimum_free = min(minimum_free, final_disk.f_bavail * final_disk.f_frsize)
            if minimum_free < MIN_FREE:
                raise RuntimeError('Final disk reserve violated')
        except BaseException as error:
            cleanup.append({'phase': 'final-observation', 'type': type(error).__name__, 'message': str(error)[:4096]})
        result = {'version': 2, 'mode': arguments.mode, 'launch': launch, 'status': 'pass' if primary is None and not cleanup else 'fail', 'primary': primary, 'cleanup': cleanup, 'exitCode': child.poll() if child else None, 'seconds': round(time.monotonic() - started, 3), 'samples': samples, 'peaks': peaks, 'minimumFreeBytes': minimum_free, 'profilePaths': sorted(profiles), 'beforeWorkAcknowledgments': len(before_ack), 'leaders': owned.leaders if owned else None, 'admissions': owned.admissions if owned else [], 'events': owned.events if owned else [], 'preCrashBrowserMembers': pre_crash_browser, 'confirmedCrashSurvivors': crash_survivors, 'postCrashObservation': post_crash, 'finalObservation': final_observation, 'externalNative': native.identity if native else None, 'limits': {'seconds': arguments.seconds, 'dataBytes': MAX_DATA, 'scratchBytes': 512 * MIB, 'logBytes': 128 * MIB, 'minimumFreeBytes': MIN_FREE, 'nodeRSS': GIB, 'nativeRSS': GIB, 'browserProcessRSS': 3 * GIB, 'unionOwnedRSS': 4 * GIB}}
        try:
            with receipt.open('x') as file:
                json.dump(result, file, indent=2)
                file.write('\n')
        except BaseException as error:
            result['receiptFailure'] = {'type': type(error).__name__, 'message': str(error)[:1024]}
            result['status'] = 'fail'
        print(json.dumps(result), flush=True)
    return 0 if result['status'] == 'pass' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as setup_error:
        # Pre-Popen errors still produce a bounded structured stdout receipt;
        # they never claim cleanup or a successful workload.
        print(json.dumps({'version': 2, 'status': 'fail', 'phase': 'setup', 'primary': {'type': type(setup_error).__name__, 'message': str(setup_error)[:4096], 'traceback': traceback.format_exc()[-8192:]}, 'cleanup': [], 'workloadQualified': False}), flush=True)
        raise SystemExit(1)
