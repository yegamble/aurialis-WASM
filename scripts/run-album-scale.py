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
from observed_process import ObservedProcess, known_group_survivors  # noqa: E402
from observed_service import ObservedService  # noqa: E402
from owned_profile import OwnedProfile  # noqa: E402
from scale_resources import (MIB, GIB, MAX_DATA, MAX_IDENTITIES, MAX_SCRATCH, MAX_LOGS, MAX_REPORTS, MAX_MISC, MIN_FREE, TERMINAL_RESERVE, disk_values, resource_values, known_identity_count, admit_sample, bounded_json)  # noqa: E402
from scale_completion import read_json, validate_launcher, validate_scale_result  # noqa: E402
from scale_service import service_contract, pin_service, OwnedStaticService  # noqa: E402
from qualification_runtime import qualification_runtime  # noqa: E402
import qualification_clock as clock  # noqa: E402

class StopFlag:
    """Never raise across an OS spawn and assignment of its owned handle."""
    def __init__(self):
        self.signal = None

    def __call__(self, number, _frame):
        self.signal = number


def acknowledge_work(sample, publish, value):
    """No work ACK can precede the same fresh union/disk check or outlive membership."""
    fresh = sample()
    member = next((row for row in fresh["owned"]["liveMembers"] if row["pid"] == value["workerPID"]), None)
    if member is None or member["pgid"] != value["nodePID"]:
        raise RuntimeError("Work requester is not an admitted fresh live Node-group member")
    publish(value)
    return fresh


def read_metadata(path):
    value, _ = read_json(path, 4096)
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
            file.flush()
            os.fsync(file.fileno())
        os.link(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        temporary.unlink()


def reap_assigned(assigned):
    """Even exhaustion attempts wait(0) on the exact assigned direct Popen."""
    if assigned.poll() is None: assigned.kill()
    try: allowance = clock.remaining(3)
    except RuntimeError: allowance = 0
    assigned.wait(timeout=allowance)


def command(pid):
    return subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'command='], text=True, timeout=clock.remaining(3)).strip()


def main():
    runtime = qualification_runtime()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--budget-root', required=True)
    parser.add_argument('--scratch', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--mode', choices=['normal', 'crash', 'scale'], required=True)
    parser.add_argument('--project', choices=['album-native-scale', 'album-browser-scale'], default='album-native-scale')
    parser.add_argument('--native-pid', type=int)
    service_options = parser.add_mutually_exclusive_group()
    service_options.add_argument('--service-pid', type=int)
    service_options.add_argument('--launch-static-service', action='store_true')
    parser.add_argument('--service-port', type=int, default=3927)
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
    if arguments.mode == 'scale' and arguments.project == 'album-browser-scale' and not (arguments.service_pid or arguments.launch_static_service):
        parser.error('Browser scale requires its exact external service group')
    if arguments.mode == 'scale' and arguments.project == 'album-native-scale' and not arguments.native_pid:
        parser.error('Native scale must include its external host in union accounting')
    started = time.monotonic()
    work_until = started + arguments.seconds
    absolute_until = work_until + 60
    work_closed = False
    clock.configure(absolute_until); clock.phase(work_until)
    if subprocess.check_output([str(node_path), '--version'], text=True, timeout=clock.remaining(3)).strip() != 'v26.12.0':
        raise RuntimeError('Qualification requires the actual pinned Node 26.12.0 child')
    # Denied observation must fail before Popen, and Node waits for admission ACK
    # before launching BrowserServer. A setup failure cannot escape that barrier.
    preflight = snapshot()
    if os.getpid() not in preflight or command_hash(os.getpid()) is None:
        raise RuntimeError('Parent process monitoring preflight failed')
    parent = ObservedProcess(os.getpid())
    native = ObservedProcess(arguments.native_pid) if arguments.native_pid else None
    service = ObservedService(arguments.service_pid) if arguments.service_pid else None
    owned_service = OwnedStaticService(base, root, node_path, arguments.service_port) if arguments.launch_static_service else None
    service_terminal = False
    service_ready = service is not None
    service_definition = owned_service.contract if owned_service else (service_contract(base, root, node_path, arguments.service_port) if service else None)
    service_proof = pin_service(service, service_definition, snapshot()) if service else None
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
    profile_owner = OwnedProfile(scratch, token)
    environment = dict(os.environ, TMPDIR=str(scratch) + '/', AURIALIS_OWNERSHIP_DIR=str(control), AURIALIS_OWNERSHIP_TOKEN=token, AURIALIS_ALBUM_SCALE_SOURCES=str(root / 'sources'), AURIALIS_ALBUM_SCALE_OUTPUT=str(result_directory), AURIALIS_ALBUM_SCALE_JSON=str(result_json))
    if service_definition:
        environment['AURIALIS_ALBUM_BROWSER_URL'] = service_definition['url']
    launch = [str(node_path), 'scripts/qualification/playwright-scale.mjs', arguments.mode, arguments.project, str(control)]
    child, owned = None, None
    primary, cleanup, final_observation, post_crash = None, [], None, None
    pre_crash_browser, crash_survivors = [], []
    browser_ack = False
    before_ack = []
    profile_descriptor, profile_cleanup, completion_proof, last_sample = None, None, [], None
    samples, forced_crash = 0, False
    peaks = dict.fromkeys(['dataBytes', 'scratchBytes', 'logBytes', 'reportBytes', 'miscBytes', 'ownedRSS', 'nativeRSS', 'nodeRSS', 'browserGroupRSS', 'serviceGroupRSS', 'supervisorRSS', 'processes', 'knownIdentities'], 0)
    stopping = StopFlag()
    previous_signals = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
    for number in previous_signals:
        signal.signal(number, stopping)
    log = root / ('launcher-' + scratch.name + '.log')
    def sample(allow_stopped=False):
        nonlocal minimum_free, samples, last_sample, service_proof
        if stopping.signal is not None and not allow_stopped:
            raise RuntimeError("Qualification supervisor stopped by signal " + str(stopping.signal))
        rows = snapshot()
        observation = owned.observe(rows) if owned else {"liveMembers": [], "groups": []}
        native_row = native.observe(rows) if native else None
        terminal_observation = owned_service.terminal_observation() if owned_service and service_terminal else None
        service_rows = terminal_observation["liveMembers"] if terminal_observation else (service.observe(rows) if service else [])
        if service and service_ready and not service_terminal:
            service_proof = pin_service(service, service_definition, rows)
        parent_row = parent.observe(rows)
        values = {**disk_values(root, scratch), **resource_values(observation["liveMembers"], child.pid if child else None, native_row, service_rows, parent_row)}
        values["knownIdentities"] = known_identity_count(owned.known if owned else {}, service.known if service else {}, service.departed if service else set(), native.identity if native else None, parent.identity)
        disk = os.statvfs(base)
        available = disk.f_bavail * disk.f_frsize
        minimum_free = min(minimum_free, available)
        samples += 1
        for name, value in values.items():
            peaks[name] = max(peaks[name], value)
        admit_sample(values, available=available, elapsed=time.monotonic() - started, seconds=arguments.seconds + (60 if work_closed else 0),
                     log_bytes=values["logBytes"], report_bytes=values["reportBytes"], misc_bytes=values["miscBytes"])
        last_sample = {"values": values, "availableBytes": available, "owned": observation, "terminalService": terminal_observation, "phase": "cleanup" if work_closed else "work"}
        return last_sample

    try:
        sample()  # Unspent total demand and complete external/parent union precede allocations.
        if owned_service:
            # One already-counted Python parent owns both child lifetimes. No
            # external host supervisor or second service history is introduced.
            occupied = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:' + str(arguments.service_port), '-sTCP:LISTEN'], capture_output=True, timeout=clock.remaining(3), check=False)
            if occupied.returncode != 1 or occupied.stdout:
                raise RuntimeError('Static service port is occupied or its observation failed')
            owned_service.prepare()
            startup_previous = clock.phase(min(work_until, time.monotonic() + 15))
            try:
                owned_service.spawn()
                service = owned_service.observer
                sample()
                service_proof = owned_service.ready(base, sample)
                service_ready = True
            finally:
                clock.phase(startup_previous)
        profile_descriptor = profile_owner.create()
        with log.open('xb') as output:
            child = subprocess.Popen(launch, env=environment, start_new_session=True, stdout=output, stderr=subprocess.STDOUT)
            owned = OwnedGroups(child.pid, os.getpid(), token)
            sample()
            write_metadata(control / 'node-ack.json', {'token': token, 'nodePID': child.pid, 'parentPID': os.getpid(), 'phase': 'node-admitted', 'profile': profile_descriptor})
            while True:
                sample()
                candidate = control / 'candidate.json'
                if not browser_ack and candidate.exists():
                    value = read_metadata(candidate)
                    if set(value) != {'token', 'nodePID', 'browserPID', 'browserExecutable', 'profile'} or value['profile'] != profile_descriptor:
                        raise RuntimeError('Browser candidate omitted or changed the exact parent profile descriptor')
                    profile_owner.validate()
                    acknowledgment = owned.admit_browser(value)
                    browser_command = shlex.split(command(value['browserPID']))
                    found = [part.split('=', 1)[1] for part in browser_command if part.startswith('--user-data-dir=')]
                    if len(found) != 1:
                        raise RuntimeError('Actual browser profile directory missing or ambiguous')
                    profile = Path(found[0]).resolve()
                    if str(profile) != profile_descriptor['userData']['path']:
                        raise RuntimeError('Actual browser is using a different profile directory')
                    sample()
                    write_metadata(control / 'ack.json', {**acknowledgment, 'parentPID': os.getpid()})
                    browser_ack = True
                    sample()
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
                    profile_owner.validate()
                    acknowledge_work(sample, lambda payload: write_metadata(control / (request.stem + '-ack.json'), payload), value)
                    before_ack.append(request.stem)
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
                    child.wait(timeout=clock.remaining(3))
                    forced_crash = True
                    post_crash = owned.observe()
                    crash_survivors = known_group_survivors(pre_crash_browser, post_crash['liveMembers'], browser_group)
                    if not crash_survivors:
                        raise RuntimeError('No exact pre-admitted browser-group member survived controlled Node crash')
                if child.poll() is not None:
                    break
                time.sleep(clock.remaining(.1 if not browser_ack else .25))
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
        # A single absolute clock includes every cleanup. The last12s reserve
        # direct assigned-handle reaps(2x3), final observation3 and publication3.
        work_closed = True
        clock.phase(absolute_until - 12)
        # Before the BrowserServer handle/candidate settles, terminating Node
        # could orphan an unadmitted detached child. Flag-only TERM lets the
        # bootstrap finish its bounded launch and close that actual handle.
        if child is not None and owned is not None and 'browser' not in owned.leaders and child.poll() is None:
            try:
                child.terminate()
                child.wait(timeout=clock.remaining(25))
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
                try:
                    child.wait(timeout=clock.remaining(5))
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=clock.remaining(3))
            except BaseException as error:
                cleanup.append({'phase': 'direct-child', 'type': type(error).__name__, 'message': str(error)[:4096]})
        if owned_service is not None:
            service = owned_service.observer
            service_terminal = True
            try:
                owned_service.stop()
            except BaseException as error:
                cleanup.append({'phase': 'owned-service-stop', 'type': type(error).__name__, 'message': str(error)[:4096]})
            cleanup.extend(owned_service.cleanup_errors)
        # Deadline/refused observation cannot abandon either assigned Popen.
        # Only direct handles may be killed without group identity authority.
        clock.phase(absolute_until - 6)
        for phase_name, assigned in [('node-final-reap', child), ('service-final-reap', owned_service.process if owned_service else None)]:
            if assigned is not None:
                try:
                    reap_assigned(assigned)
                except BaseException as error:
                    cleanup.append({'phase': phase_name, 'type': type(error).__name__, 'message': str(error)[:4096]})
        clock.phase(absolute_until - 3)
        try:
            if owned is not None:
                final_observation = owned.observe()
                if final_observation['liveMembers']:
                    raise RuntimeError('Final owned groups remain live')
            sample(allow_stopped=True)
        except BaseException as error:
            cleanup.append({'phase': 'final-observation', 'type': type(error).__name__, 'message': str(error)[:4096]})
        if owned_service:
            try:
                owned_service.publish('settlement.json', {'events': owned_service.events, 'terminal': owned_service.terminal, 'cleanup': owned_service.cleanup_errors}, 32 * 1024)
                owned_service.publish('exit.json', {'pid': owned_service.process.pid if owned_service.process else None, 'exit': owned_service.process.poll() if owned_service.process else None, 'primary': primary, 'cleanup': cleanup, 'finalTerminal': owned_service.terminal}, 16 * 1024)
            except BaseException as error:
                cleanup.append({'phase': 'service-terminal-publication', 'type': type(error).__name__, 'message': str(error)[:4096]})
            try: owned_service.close_log()
            except BaseException as error: cleanup.append({'phase': 'service-log-close', 'message': str(error)[:4096]})
        # A deliberate crash preserves diagnostics even when its narrow control passed.
        if primary is None and not cleanup and arguments.mode != 'crash':
            try:
                launcher, launcher_receipt = read_json(control / 'launcher.json', 64 * 1024)
                validate_launcher(launcher, arguments.mode, arguments.project)
                completion_proof.append(launcher_receipt)
                if arguments.mode == 'scale':
                    report, report_receipt = read_json(result_json)
                    validate_scale_result(report, arguments.project)
                    completion_proof.append(report_receipt)
                else:
                    ready, ready_receipt = read_json(control / 'probe-ready.json', 4096)
                    if ready.get('token') != token or ready.get('status') != 'pass' or ready.get('ownershipAcknowledgedBeforeWorker') is not True or ready.get('nodePID') != child.pid or ready.get('browserPID') != owned.leaders['browser']['pid'] or ready.get('mode') != 'normal' or ready.get('audioProcessing') is not False:
                        raise RuntimeError('Normal diagnostic work did not prove its exact acknowledged completion')
                    completion_proof.append(ready_receipt)
                cleanup_sample = sample()
                final_observation = cleanup_sample['owned']
                if child.poll() != 0 or final_observation['liveMembers']:
                    raise RuntimeError('Profile cleanup requires settled child and empty owned groups')
                profile_owner.validate()
                # This durable commit point follows all work assertions and real group settlement.
                pre_cleanup = root / ('pre-cleanup-' + scratch.name + '.json')
                write_metadata(pre_cleanup, {'token': token, 'profile': profile_descriptor, 'status': 'verified-success-before-profile-cleanup', 'completion': completion_proof, 'emptyOwnedGroups': True, 'ownedObservation': final_observation, 'childExit': child.returncode, 'resourceSample': cleanup_sample['values']})
                profile_cleanup = {'commitReceipt': str(pre_cleanup), 'state': profile_owner.cleanup_success()}
                sample()
            except BaseException as error:
                cleanup.append({'phase': 'success-profile-cleanup', 'type': type(error).__name__, 'message': str(error)[:4096]})
        clock.phase(absolute_until)
        result = {'version': 4, 'pythonRuntime': runtime, 'mode': arguments.mode, 'launch': launch,
                  'status': 'pass' if primary is None and not cleanup else 'fail', 'primary': primary, 'cleanup': cleanup,
                  'exitCode': child.poll() if child else None, 'seconds': round(time.monotonic() - started, 3),
                  'samples': samples, 'peaks': peaks, 'minimumFreeBytes': minimum_free,
                  'profile': profile_owner.state(), 'profileCleanup': profile_cleanup, 'completion': completion_proof,
                  'beforeWorkAcknowledgments': len(before_ack), 'leaders': owned.leaders if owned else None,
                  'admissions': owned.admissions if owned else [], 'events': owned.events if owned else [],
                  'preCrashBrowserMembers': pre_crash_browser, 'confirmedCrashSurvivors': crash_survivors,
                  'postCrashObservation': post_crash, 'finalObservation': final_observation,
                  'externalNative': native.identity if native else None, 'supervisor': parent.identity,
                  'deadline': {'workSeconds': arguments.seconds, 'cleanupAllowanceSeconds': 60, 'absoluteSeconds': arguments.seconds + 60, 'publicationRequiresObservedExitZero': True},
                  'ownedService': {'directPID': owned_service.process.pid if owned_service.process else None, 'terminal': owned_service.terminal} if owned_service else None,
                  'externalService': {'proof': service_proof, 'admissions': service.admissions, 'events': service.events} if service else None,
                  'limits': {'seconds': arguments.seconds, 'dataBytes': MAX_DATA, 'scratchBytes': MAX_SCRATCH,
                             'logBytes': MAX_LOGS, 'reportBytes': MAX_REPORTS, 'miscBytes': MAX_MISC,
                             'terminalReservedBytes': TERMINAL_RESERVE, 'knownIdentities': MAX_IDENTITIES, 'minimumFreeBytes': MIN_FREE,
                             'nodeRSS': GIB, 'nativeRSS': GIB, 'supervisorRSS': GIB, 'serviceGroupRSS': GIB,
                             'browserGroupRSS': 3 * GIB, 'unionOwnedRSS': 4 * GIB, 'sampledNotKernelEnforced': True}}
        try:
            data = bounded_json(result)
        except BaseException as error:
            # Fail explicitly instead of publishing truncated observations as a pass.
            result = {'version': 3, 'status': 'fail', 'primary': primary,
                      'cleanup': [{key: value for key, value in entry.items() if key != 'details'} for entry in cleanup],
                      'publicationFailure': {'type': type(error).__name__, 'message': str(error)[:1024]},
                      'fullObservationsPublished': False, 'profile': profile_owner.state(), 'workloadQualified': False}
            data = bounded_json(result)
        try:
            clock.remaining(3)
            descriptor = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'wb') as file:
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            directory = os.open(receipt.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            clock.remaining(3)
        except BaseException as error:
            result['receiptFailure'] = {'type': type(error).__name__, 'message': str(error)[:1024]}
            result['status'] = 'fail'
        # No duplicate unbounded stdout receipt outside the single disk ledger.
        stdout = {'status': result['status'], 'receipt': str(receipt),
                  'primary': {key: value for key, value in primary.items() if key != 'traceback'} if primary else None,
                  'receiptFailure': result.get('receiptFailure'), 'profile': result.get('profile')}
        sys.stdout.buffer.write(bounded_json(stdout, 60 * 1024))
        sys.stdout.buffer.flush()
        for number, previous in previous_signals.items():
            signal.signal(number, previous)
    return 0 if result['status'] == 'pass' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as setup_error:
        # Pre-Popen errors still produce a bounded structured stdout receipt;
        # they never claim cleanup or a successful workload.
        print(json.dumps({'version': 2, 'status': 'fail', 'phase': 'setup', 'primary': {'type': type(setup_error).__name__, 'message': str(setup_error)[:4096], 'traceback': traceback.format_exc()[-8192:]}, 'cleanup': [], 'workloadQualified': False}), flush=True)
        raise SystemExit(1)
