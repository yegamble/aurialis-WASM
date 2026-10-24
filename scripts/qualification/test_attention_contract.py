"""Pure fake-row controls. No ps, subprocess, socket, browser or GPU calls."""
import unittest
from pathlib import Path
from unittest import mock
import importlib.util
from attention_contract import ProbeState, check_browser_command, check_resources, final_empty, node_command, parse_actual_command


def row(pid, group=None, parent=10, start='same', rss=1024):
    return {'pid': pid, 'pgid': pid if group is None else group, 'ppid': parent, 'start': start, 'rssBytes': rss, 'state': 'S'}


class Contract(unittest.TestCase):
    def state(self):
        value = ProbeState('token', 10)
        value.browser_admitted(20)
        observed = {'liveMembers': [row(10), row(20), row(30, 10)]}
        value.admit_server({'token': 'token', 'nodePID': 10, 'browserPID': 20, 'serverPID': 30, 'url': 'http://127.0.0.1:1234'}, observed)
        return value, observed

    def work(self):
        return {'token': 'token', 'nodePID': 10, 'browserPID': 20, 'workerPID': 10, 'phase': 'before-worker', 'id': '12345678-1234-1234-1234-123456789abc'}

    def test_parent_import_has_no_process_or_signal_side_effect(self):
        source = Path(__file__).with_name('attention-parent.py')
        spec = importlib.util.spec_from_file_location('attention_parent_source_unit', source)
        module = importlib.util.module_from_spec(spec)
        with mock.patch('subprocess.Popen', side_effect=AssertionError('No actual process allowed')), mock.patch('subprocess.run', side_effect=AssertionError('No ps allowed')), mock.patch('subprocess.check_output', side_effect=AssertionError('No command allowed')), mock.patch('os.killpg', side_effect=AssertionError('No group signal allowed')):
            spec.loader.exec_module(module)
        self.assertTrue(callable(module.main))

    def test_node_memory_flags_and_unreleased_modes(self):
        self.assertEqual(node_command('/node', '/launcher', 'normal', '/control'), ['/node', '--max-old-space-size=192', '--stack-size=8192', '/launcher', 'normal', '/control'])
        with self.assertRaises(ValueError):
            node_command('/node', '/launcher', 'capture', '/control')

    def test_ps_space_path_and_actual_forbidden_flag_controls(self):
        brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        command = parse_actual_command(brave + ' --remote-debugging-pipe --user-data-dir=/tmp/fresh/profile', brave)
        self.assertEqual(check_browser_command(command, brave, '/tmp/fresh'), str(Path('/tmp/fresh/profile').resolve()))
        for flag in ('--no-sandbox', '--headless=new', '--use-angle=metal', '--use-angle=swiftshader', '--disable-gpu', '--disable-web-security', '--ignore-certificate-errors'):
            with self.subTest(flag=flag), self.assertRaises(RuntimeError):
                check_browser_command(command + [flag], brave, '/tmp/fresh')
        with self.assertRaises(ValueError):
            check_browser_command([brave, '--user-data-dir=/tmp/other'], brave, '/tmp/fresh')
        with self.assertRaises(RuntimeError):
            parse_actual_command('/Applications/Brave fake --flag', brave)

    def test_exact_resource_boundaries_and_union_count_once(self):
        exact = {'liveMembers': [row(10, rss=4 * 1024 ** 3)]}
        self.assertEqual(check_resources(exact, 4096, 64 * 1024 ** 2, 6 * 1024 ** 3, 60)['liveProcesses'], 1)
        with self.assertRaises(RuntimeError):
            check_resources(exact, 4096, 0, 6 * 1024 ** 3, 1, row(99))
        for observation, known, size, free, seconds in [(exact, 4097, 0, 6 * 1024 ** 3, 1), (exact, 1, 64 * 1024 ** 2 + 1, 6 * 1024 ** 3, 1), (exact, 1, 0, 6 * 1024 ** 3 - 1, 1), (exact, 1, 0, 6 * 1024 ** 3, 60.1), ({'liveMembers': [row(10, rss=4 * 1024 ** 3 + 1)]}, 1, 0, 6 * 1024 ** 3, 1), ({'liveMembers': [row(i) for i in range(257)]}, 257, 0, 6 * 1024 ** 3, 1)]:
            with self.assertRaises(RuntimeError):
                check_resources(observation, known, size, free, seconds)

    def test_server_must_be_admitted_before_exact_fresh_prework(self):
        state = ProbeState('token', 10)
        with self.assertRaises(RuntimeError):
            state.admit_work(self.work(), {'liveMembers': []})
        state, observed = self.state()
        state.admit_work(self.work(), observed)
        with self.assertRaises(RuntimeError):
            state.admit_work(self.work(), observed)
        state, observed = self.state()
        for changed in ({'liveMembers': observed['liveMembers'][:-1]}, {'liveMembers': [*observed['liveMembers'][:-1], row(30, 10, start='reused')]}):
            with self.assertRaises(RuntimeError):
                state.admit_work(self.work(), changed)

    def test_server_network_and_reparenting_cannot_grant_authority(self):
        for url, parent in [('http://example.com:1', 10), ('http://127.0.0.1:1/path', 10), ('http://127.0.0.1:1?x', 10), ('http://user@127.0.0.1:1', 10), ('http://127.0.0.1:1', 99)]:
            state = ProbeState('token', 10)
            state.browser_admitted(20)
            with self.assertRaises(RuntimeError):
                state.admit_server({'token': 'token', 'nodePID': 10, 'browserPID': 20, 'serverPID': 30, 'url': url}, {'liveMembers': [row(30, 10, parent=parent)]})

    def test_normal_ready_requires_actual_noaudio_nogpu_and_work_ack(self):
        state, observed = self.state()
        ready = {'token': 'token', 'nodePID': 10, 'browserPID': 20, 'serverPID': 30, 'status': 'pass', 'mode': 'normal', 'ownershipAcknowledgedBeforeWorker': True, 'audioProcessing': False, 'gpuRequested': False}
        with self.assertRaises(RuntimeError):
            state.ready(ready, 'normal')
        state.admit_work(self.work(), observed)
        state.ready(ready, 'normal')
        for change in ({'gpuRequested': True}, {'audioProcessing': True}, {'browserPID': 99}, {'status': 'fail'}):
            with self.assertRaises(RuntimeError):
                state.ready({**ready, **change}, 'normal')

    def test_crash_only_exact_pre_admitted_live_survivor_and_final_empty(self):
        state, _ = self.state()
        before = [row(20), row(21, 20, parent=20)]
        after = [row(21, 20, parent=1)]
        self.assertEqual(state.crash_survivors(before, after), after)
        for changed in ([], [row(22, 20)], [row(21, 20, start='reused')], [{**after[0], 'state': 'Z'}]):
            with self.assertRaises(RuntimeError):
                state.crash_survivors(before, changed)
        final_empty({'liveMembers': []})
        with self.assertRaises(RuntimeError):
            final_empty({'liveMembers': after})


if __name__ == '__main__':
    unittest.main()
