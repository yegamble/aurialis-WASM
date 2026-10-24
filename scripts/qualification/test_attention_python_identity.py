"""Pure held-child SOURCE controls. All process/group/API objects are injected."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import attention_python_identity as probe

TOKEN = 'a' * 64
PIN = {'path': '/pinned/python3.9', 'bytes': 1, 'sha256': 'b' * 64}
LAUNCH = [PIN['path'], '/source/serve.py']


def load_server():
    path = Path(__file__).resolve().parents[2] / 'internal/audio/steminfer/testdata/webgpu/attention/serve.py'
    spec = importlib.util.spec_from_file_location('attention_identity_hold_server', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HeldChild(unittest.TestCase):
    def run_fake(self, *, ready_error=None, admit_error=None, capture_error=None, close_error=None, cleanup_error=None, waits=None, text=None):
        events = []
        child = mock.Mock(pid=321, stdin=mock.Mock())
        child.poll.return_value = None
        child.wait.side_effect = waits
        child.stdin.close.side_effect = close_error
        owner = mock.Mock(leaders={'node': {'pid': 321, 'ppid': 123, 'pgid': 321, 'start': 'held'}}, events=[])
        owner.observe.return_value = {'liveMembers': [], 'members': [], 'rssBytes': 0}
        owner.cleanup.side_effect = cleanup_error
        def spawn(*args, **kwargs):
            events.append('spawn')
            self.assertEqual(args[0], LAUNCH)
            self.assertTrue(kwargs['start_new_session'])
            self.assertEqual(kwargs['env'], {'hold': TOKEN})
            return child
        def ready(*_args):
            events.append('ready-after-framework-exec')
            if ready_error:
                raise ready_error
        def groups(*_args):
            events.append('group-admit')
            if admit_error:
                raise admit_error
            return owner
        def capture(_expected, _pin, persist):
            events.append('capture')
            if capture_error:
                raise capture_error
            persist({'source': 'fake'})
            return PIN['path'] + ' /source/serve.py' if text is None else text
        def check(_owner):
            events.append('resource')
        persisted = []
        with tempfile.TemporaryDirectory(prefix='aurialis-identity-runner-source-') as directory:
            result = probe.run_child(LAUNCH, {'hold': TOKEN}, Path(directory), TOKEN, PIN, check, mock.Mock(), persisted.append, spawn=spawn, groups=groups, ready=ready, capture=capture)
        return result, child, owner, events, persisted

    def test_ready_precedes_group_admission_and_capture_without_stdin_release(self):
        result, child, owner, events, persisted = self.run_fake()
        self.assertEqual(events[:4], ['spawn', 'ready-after-framework-exec', 'group-admit', 'resource'])
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(result['strictCommand']['status'], 'matches')
        self.assertFalse(result['stdinWorkReleaseSent'])
        child.stdin.write.assert_not_called()
        child.stdin.close.assert_called_once()
        owner.cleanup.assert_called_once()
        child.wait.assert_called_once()
        self.assertEqual(persisted, [{'source': 'fake'}])

    def test_alias_is_retained_as_rejection_not_normal_qualification(self):
        result, *_ = self.run_fake(text='Python /source/serve.py')
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(result['strictCommand']['status'], 'rejected')
        self.assertIn('prefix differs', result['strictCommand']['error']['message'])
        self.assertIn('not normal/crash/adapter', result['scope'])

    def test_ready_or_admission_failure_still_closes_terminates_and_reaps_exact_child(self):
        for stage in ('ready_error', 'admit_error'):
            with self.subTest(stage=stage):
                result, child, owner, events, _ = self.run_fake(**{stage: RuntimeError(stage)})
                self.assertEqual(result['status'], 'fail')
                self.assertEqual(result['primary']['message'], stage)
                child.stdin.close.assert_called_once()
                child.terminate.assert_called_once()
                child.wait.assert_called_once()
                owner.cleanup.assert_not_called()
                self.assertNotIn('capture', events)

    def test_capture_primary_survives_stdin_group_and_reap_failure(self):
        result, child, owner, _, _ = self.run_fake(capture_error=RuntimeError('capture first'), close_error=OSError('close uncertain'), cleanup_error=OSError('group uncertain'), waits=[OSError('reap uncertain')])
        self.assertEqual(result['primary']['message'], 'capture first')
        self.assertEqual(result['status'], 'fail')
        self.assertEqual([item['phase'] for item in result['cleanup']][:3], ['hold-stdin-close', 'owned-groups', 'direct-child-reap'])
        child.stdin.write.assert_not_called()
        owner.cleanup.assert_called_once()

    def test_before_admission_reap_timeout_attempts_exact_kill_and_second_reap(self):
        result, child, _, _, _ = self.run_fake(ready_error=RuntimeError('not ready'), waits=[TimeoutError('wait'), 0])
        child.terminate.assert_called_once()
        child.kill.assert_called_once()
        self.assertEqual(child.wait.call_count, 2)
        self.assertEqual(result['status'], 'fail')

    def test_admitted_failed_cleanup_still_kills_and_reaps_exact_direct_child(self):
        result, child, owner, _, _ = self.run_fake(capture_error=RuntimeError('first'), close_error=OSError('close failed'), cleanup_error=OSError('group refusal'), waits=[TimeoutError('wait'), 0])
        self.assertEqual(result['primary']['message'], 'first')
        self.assertEqual(result['status'], 'fail')
        owner.cleanup.assert_called_once()
        child.terminate.assert_called_once()
        child.kill.assert_called_once()
        self.assertEqual(child.wait.call_count, 2)

    def test_imports_cannot_launch_or_call_native_identity(self):
        path = Path(probe.__file__)
        spec = importlib.util.spec_from_file_location('attention_identity_import_source_control', path)
        module = importlib.util.module_from_spec(spec)
        with mock.patch('subprocess.Popen', side_effect=AssertionError('No child')), mock.patch('subprocess.run', side_effect=AssertionError('No ps')), mock.patch('subprocess.check_output', side_effect=AssertionError('No command')), mock.patch('ctypes.CDLL', side_effect=AssertionError('No libproc')):
            spec.loader.exec_module(module)

    def test_final_live_observation_cannot_claim_observed(self):
        def live_final():
            return {'liveMembers': [{'pid': 321}], 'members': [{'pid': 321}]}
        with tempfile.TemporaryDirectory(prefix='aurialis-identity-runner-source-') as directory:
            child = mock.Mock(pid=321)
            owner = mock.Mock(leaders={'node': {}}, events=[])
            owner.observe.side_effect = live_final
            result = probe.run_child(LAUNCH, {}, Path(directory), TOKEN, PIN, mock.Mock(), mock.Mock(), mock.Mock(), spawn=mock.Mock(return_value=child), groups=mock.Mock(return_value=owner), ready=mock.Mock(), capture=mock.Mock(return_value='Python'))
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['cleanup'][-1]['phase'], 'final-owned-empty-bounds')

    def test_ready_marker_is_closed_exact_and_token_pid_bound(self):
        good = {'phase': 'identity-held-before-bind', 'pid': 321, 'token': TOKEN}
        probe.ready_marker(good, 321, TOKEN)
        for value in (None, {**good, 'pid': 322}, {**good, 'token': 'b' * 64}, {**good, 'extra': True}, {**good, 'phase': 'release'}):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                probe.ready_marker(value, 321, TOKEN)

    def test_serve_hold_eof_exits_without_httpserver_or_asset_loading(self):
        server = load_server()
        destination = io.StringIO()
        self.assertFalse(server.identity_hold({'AURIALIS_ATTENTION_IDENTITY_HOLD': TOKEN}, io.StringIO(''), destination, 321))
        self.assertEqual(json.loads(destination.getvalue()), {'phase': 'identity-held-before-bind', 'pid': 321, 'token': TOKEN})
        with mock.patch.object(server.os, 'environ', {'AURIALIS_ATTENTION_IDENTITY_HOLD': TOKEN}), mock.patch.object(server.sys, 'stdin', io.StringIO('')), mock.patch.object(server.sys, 'stdout', io.StringIO()), mock.patch.object(server.http.server, 'HTTPServer', side_effect=AssertionError('No socket allowed')) as bind, mock.patch.object(server, 'assets', side_effect=AssertionError('No assets allowed')):
            server.main()
        bind.assert_not_called()

    def test_serve_hold_has_no_release_token_or_oversize_escape(self):
        server = load_server()
        for text in ('release\n', json.dumps({'phase': 'release', 'token': TOKEN}) + '\n', 'x' * 8192):
            with self.subTest(length=len(text)), self.assertRaises(ValueError):
                server.identity_hold({'AURIALIS_ATTENTION_IDENTITY_HOLD': TOKEN}, io.StringIO(text), io.StringIO(), 321)
        with self.assertRaises(ValueError):
            server.identity_hold({'AURIALIS_ATTENTION_IDENTITY_HOLD': 'bad'}, io.StringIO(''), io.StringIO(), 321)
        self.assertTrue(server.identity_hold({}, mock.Mock(readline=mock.Mock(side_effect=AssertionError('No diagnostic read'))), io.StringIO(), 321))

    def test_checked_file_refuses_tiny_symlink_hash_and_size_changes(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-identity-runner-source-') as directory:
            file = Path(directory) / 'tiny.bin'
            file.write_bytes(b'fixed')
            pin = {'bytes': 5, 'sha256': __import__('hashlib').sha256(b'fixed').hexdigest()}
            probe.checked_file(file, pin)
            for changed in ({**pin, 'bytes': 4}, {**pin, 'sha256': '0' * 64}):
                with self.assertRaises(RuntimeError):
                    probe.checked_file(file, changed)
            alias = Path(directory) / 'alias'
            alias.symlink_to(file)
            with self.assertRaises(RuntimeError):
                probe.checked_file(alias, pin)


if __name__ == '__main__':
    unittest.main()
