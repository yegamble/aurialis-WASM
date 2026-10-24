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

    def test_fresh_same_snapshot_resources_precede_every_ack(self):
        spec = importlib.util.spec_from_file_location('attention_parent_ack_unit', Path(__file__).with_name('attention-parent.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        rows = {10: row(10), 20: row(20), 99: row(99)}
        owned = mock.Mock(known={10: rows[10], 20: rows[20]}, leaders={'node': rows[10], 'browser': rows[20]})
        owned.observe.return_value = {'liveMembers': [rows[10], rows[20]]}
        supervisor = mock.Mock()
        supervisor.observe.return_value = rows[99]
        disk = mock.Mock(f_bavail=7 * 1024 ** 3, f_frsize=1)
        events = []
        def sample(*args, **kwargs):
            events.append('fresh-sample')
            return module.sample_resources(*args, **kwargs, observer=lambda: rows, disk_reader=lambda _: disk, byte_counter=lambda _: 128, clock=lambda: 2)
        for phase in ('node', 'browser', 'work'):
            history = []
            module.checked_ack(Path('/not-written'), {'phase': phase}, owned, supervisor, '/base', '/output', 1, history, validate=lambda observed: events.append('validate'), sampler=sample, writer=lambda *_: events.append('write'))
            self.assertEqual(events[-3:], ['fresh-sample', 'validate', 'write'])
            self.assertEqual(history[0]['outputBytes'], 128 + 4096)
            self.assertEqual(history[0]['rssBytes'], 3072)
            self.assertIs(owned.observe.call_args.args[0], rows)
            self.assertIs(supervisor.observe.call_args.args[0], rows)
        for change in ('rss', 'free', 'disk', 'wall', 'known', 'missing-leader', 'validation'):
            with self.subTest(change=change):
                writer = mock.Mock()
                owned.known = {10: rows[10], 20: rows[20]}
                owned.observe.return_value = {'liveMembers': [rows[10], rows[20]]}
                disk.f_bavail = 7 * 1024 ** 3
                if change == 'rss':
                    owned.observe.return_value = {'liveMembers': [row(10, rss=4 * 1024 ** 3), rows[20]]}
                if change == 'free':
                    disk.f_bavail = 6 * 1024 ** 3
                if change == 'known':
                    owned.known = dict.fromkeys(range(4096))
                if change == 'missing-leader':
                    owned.observe.return_value = {'liveMembers': [rows[10]]}
                def failing_sample(*args, **kwargs):
                    return module.sample_resources(*args, **kwargs, observer=lambda: rows, disk_reader=lambda _: disk, byte_counter=lambda _: 64 * 1024 ** 2 if change == 'disk' else 128, clock=lambda: 62 if change == 'wall' else 2)
                def validate(_):
                    if change == 'validation':
                        raise RuntimeError('Fresh work identity refused')
                with self.assertRaises(RuntimeError):
                    module.checked_ack(Path('/not-written'), {}, owned, supervisor, '/base', '/output', 1, [], validate=validate, sampler=failing_sample, writer=writer)
                writer.assert_not_called()

    def test_node_memory_flags_and_unreleased_modes(self):
        self.assertEqual(node_command('/node', '/launcher', 'normal', '/control'), ['/node', '--max-old-space-size=192', '--stack-size=8192', '/launcher', 'normal', '/control'])
        with self.assertRaises(ValueError):
            node_command('/node', '/launcher', 'capture', '/control')

    def test_ps_space_path_and_actual_forbidden_flag_controls(self):
        brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        command = parse_actual_command(brave + ' --remote-debugging-pipe --user-data-dir=/tmp/fresh/profile', brave)
        self.assertEqual(check_browser_command(command, brave, '/tmp/fresh'), str(Path('/tmp/fresh/profile').resolve()))
        for flag in ('--no-sandbox', '--enable-unsafe-swiftshader', '--headless=new', '--use-angle=metal', '--use-angle=swiftshader', '--disable-gpu', '--disable-web-security', '--ignore-certificate-errors'):
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

    def test_metadata_mode_requires_truthful_adapter_flag_and_same_owned_work(self):
        self.assertEqual(node_command('/node', '/launcher', 'metadata', '/control')[-2:], ['metadata', '/control'])
        state, observed = self.state()
        ready = {'token': 'token', 'nodePID': 10, 'browserPID': 20, 'serverPID': 30, 'status': 'pass', 'mode': 'metadata', 'ownershipAcknowledgedBeforeWorker': True, 'audioProcessing': False, 'gpuRequested': True}
        with self.assertRaises(RuntimeError):
            state.ready(ready, 'metadata')
        state.admit_work(self.work(), observed)
        state.ready(ready, 'metadata')
        for changed in ({'gpuRequested': False}, {'audioProcessing': True}, {'mode': 'normal'}):
            with self.assertRaises(RuntimeError):
                state.ready({**ready, **changed}, 'metadata')

    def test_first_four_requires_exactly_four_case_acknowledgments(self):
        state, observed = self.state()
        ready = {'token': 'token', 'nodePID': 10, 'browserPID': 20, 'serverPID': 30, 'status': 'pass', 'mode': 'first-four', 'ownershipAcknowledgedBeforeWorker': True, 'audioProcessing': False, 'gpuRequested': True}
        for i in range(4):
            with self.assertRaises(RuntimeError):
                state.ready(ready, 'first-four')
            state.admit_work({**self.work(), 'id': f'{i:08d}-1234-1234-1234-123456789abc'}, observed)
        state.ready(ready, 'first-four')
        with self.assertRaises(RuntimeError):
            state.admit_work({**self.work(), 'id': '00000004-1234-1234-1234-123456789abc'}, observed)

    def test_each_remaining_mode_requires_four_fresh_ack_pairs_and_truthful_gpu_flag(self):
        for ordinal in range(1, 7):
            mode = 'remaining-' + str(ordinal)
            self.assertEqual(node_command('/node', '/launch', mode, '/control')[-2:], [mode, '/control'])
            state, observed = self.state()
            ready = {'token': 'token', 'nodePID': 10, 'browserPID': 20, 'serverPID': 30, 'status': 'pass', 'mode': mode, 'ownershipAcknowledgedBeforeWorker': True, 'audioProcessing': False, 'gpuRequested': True}
            for index in range(4):
                with self.assertRaises(RuntimeError):
                    state.ready(ready, mode)
                state.admit_work({**self.work(), 'id': f'{index:08d}-1234-1234-1234-123456789abc'}, observed)
            state.ready(ready, mode)
            for changed in ({'gpuRequested': False}, {'mode': 'first-four'}, {'audioProcessing': True}):
                with self.assertRaises(RuntimeError):
                    state.ready({**ready, **changed}, mode)
            with self.assertRaises(RuntimeError):
                state.admit_work({**self.work(), 'id': '00000004-1234-1234-1234-123456789abc'}, observed)

    def test_invalid_remaining_modes_fail_before_node_command_or_ready(self):
        for mode in ('remaining-0', 'remaining-7', 'remaining-01', 'remaining-1x', 'remaining-1;flag'):
            with self.assertRaises(ValueError):
                node_command('/node', '/launch', mode, '/control')
            state, _ = self.state()
            with self.assertRaises(RuntimeError):
                state.ready({}, mode)

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
