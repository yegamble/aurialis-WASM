"""SOURCE only: fake process/API observations and tiny private file controls."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from attention_contract import parse_actual_command
from attention_identity import darwin_pidpath, COMMAND_CAP, PATH_CAP, RECORD_CAP, ExecutableFileFailure, RawCommandFailure, bounded_ps, decode_pidpath, executable_file, static_identity

EXPECTED = {'pid': 123, 'ppid': 10, 'pgid': 10, 'start': 'same-start', 'rssBytes': 1024, 'state': 'S'}
PIN = {'path': '/pinned/python3.9', 'bytes': 100, 'sha256': 'a' * 64}


def deps(raw=None, after=None, kernel=None):
    records = []
    snapshots = iter([{123: dict(EXPECTED)}, {123: dict(EXPECTED) if after is None else after}])
    options = {'rows': lambda: next(snapshots), 'command': lambda _pid: b'/pinned/python3.9 /source/serve.py\n' if raw is None else raw, 'kernel_path': lambda _pid: PIN['path'] if kernel is None else kernel, 'file_record': lambda path: {'path': path, 'bytes': 100, 'sha256': PIN['sha256'], 'device': 1, 'inode': 2}}
    return records, options


class Identity(unittest.TestCase):
    def test_preparse_record_preserves_raw_and_old_strict_alias_refusal(self):
        records, options = deps(b'Python /source/serve.py\n')
        text = static_identity(EXPECTED, PIN, records.append, **options)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['rawCommandText'], 'Python /source/serve.py\n')
        self.assertEqual(records[0]['rawCommandSHA256'], hashlib.sha256(b'Python /source/serve.py\n').hexdigest())
        self.assertTrue(records[0]['kernelHashMatchesExpected'])
        self.assertEqual(records[0]['before'], EXPECTED)
        self.assertEqual(records[0]['after'], EXPECTED)
        with self.assertRaisesRegex(RuntimeError, 'prefix differs'):
            parse_actual_command(text, PIN['path'])

    def test_original_kernel_error_survives_after_identity_and_persistence_errors(self):
        records, options = deps(after={**EXPECTED, 'start': 'reused'})
        options['kernel_path'] = mock.Mock(side_effect=OSError('first kernel failure'))
        with self.assertRaisesRegex(OSError, 'first kernel failure'):
            static_identity(EXPECTED, PIN, records.append, **options)
        self.assertEqual(records[0]['error']['type'], 'OSError')
        self.assertEqual([error['type'] for error in records[0]['errors']], ['OSError', 'RuntimeError'])
        records, options = deps()
        options['kernel_path'] = mock.Mock(side_effect=OSError('first kernel failure'))
        with self.assertRaisesRegex(RuntimeError, 'original primary OSError: first kernel failure') as combined:
            static_identity(EXPECTED, PIN, mock.Mock(side_effect=OSError('persist unconfirmed')), **options)
        self.assertIsInstance(combined.exception.__cause__, OSError)

    def test_canonical_text_keeps_exact_original_argument_rule(self):
        records, options = deps()
        text = static_identity(EXPECTED, PIN, records.append, **options)
        self.assertEqual(parse_actual_command(text, PIN['path']), [PIN['path'], '/source/serve.py'])
        self.assertTrue(records[0]['rawCommandComplete'])
        self.assertEqual(records[0]['error'], None)

    def test_changed_or_missing_process_retains_actual_before_after_and_refuses(self):
        for changed in ({**EXPECTED, 'start': 'reused'}, {**EXPECTED, 'pgid': 99}, {**EXPECTED, 'ppid': 99}, {**EXPECTED, 'state': 'Z'}):
            records, options = deps(after=changed)
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, 'identity changed'):
                static_identity(EXPECTED, PIN, records.append, **options)
            self.assertEqual(records[0]['after'], changed)
            self.assertIsNotNone(records[0]['rawCommandText'])
        records, options = deps()
        options['rows'] = lambda: {}
        with self.assertRaises(RuntimeError):
            static_identity(EXPECTED, PIN, records.append, **options)
        self.assertIsNone(records[0]['before'])
        self.assertIsNone(records[0]['after'])

    def test_unavailable_kernel_observation_preserves_command_but_refuses(self):
        records, options = deps()
        options['kernel_path'] = mock.Mock(side_effect=OSError('injected unavailable API'))
        with self.assertRaisesRegex(OSError, 'unavailable'):
            static_identity(EXPECTED, PIN, records.append, **options)
        self.assertIn('/pinned/python3.9', records[0]['rawCommandText'])
        self.assertEqual(records[0]['error']['type'], 'OSError')

    def test_kernel_different_path_is_diagnostic_and_cannot_authorize_alias(self):
        records, options = deps(b'Python /source/serve.py\n', kernel='/different/Python')
        options['file_record'] = lambda path: {'path': path, 'bytes': 80, 'sha256': 'b' * 64}
        text = static_identity(EXPECTED, PIN, records.append, **options)
        self.assertFalse(records[0]['kernelPathMatchesExpected'])
        self.assertFalse(records[0]['kernelHashMatchesExpected'])
        with self.assertRaises(RuntimeError):
            parse_actual_command(text, PIN['path'])

    def test_invalid_utf8_or_partial_overflow_remains_bounded_failure_evidence(self):
        records, options = deps(b'\xff\xfe')
        with self.assertRaises(RuntimeError):
            static_identity(EXPECTED, PIN, records.append, **options)
        self.assertEqual(records[0]['rawCommandHex'], 'fffe')
        records, options = deps()
        options['command'] = mock.Mock(side_effect=RawCommandFailure('injected overflow', b'x' * (COMMAND_CAP + 1), True))
        with self.assertRaisesRegex(RawCommandFailure, 'overflow'):
            static_identity(EXPECTED, PIN, records.append, **options)
        self.assertEqual(records[0]['rawCommandBytes'], COMMAND_CAP)
        self.assertEqual(len(records[0]['rawCommandText']), COMMAND_CAP)
        self.assertFalse(records[0]['rawCommandComplete'])

    def test_persistence_failure_prevents_return_and_record_cap_covers_escaping(self):
        records, options = deps()
        with self.assertRaisesRegex(OSError, 'persist unconfirmed'):
            static_identity(EXPECTED, PIN, mock.Mock(side_effect=OSError('persist unconfirmed')), **options)
        records, options = deps(b'\0' * COMMAND_CAP, kernel='/' + 'a' * (PATH_CAP - 2))
        static_identity(EXPECTED, PIN, records.append, **options)
        self.assertLess(len(json.dumps(records[0]).encode()), RECORD_CAP)

    def test_pidpath_published_buffer_return_contract_has_no_native_call(self):
        value = b'/kernel/Python'
        raw = value + b'\0' * (PATH_CAP - len(value))
        self.assertEqual(decode_pidpath(raw, len(value)), '/kernel/Python')
        for data, count in [(raw, 0), (raw, -1), (raw, PATH_CAP), (b'x' * PATH_CAP, 10), (b'\0' * PATH_CAP, 1), (b'\xff' + b'\0' * (PATH_CAP - 1), 1)]:
            with self.subTest(count=count), self.assertRaises((RuntimeError, UnicodeDecodeError)):
                decode_pidpath(data, count)

    def test_native_binding_is_faked_and_uses_published_exact_abi_only(self):
        import ctypes
        path = b'/fake/kernel/Python'
        def copied(_pid, buffer, size):
            self.assertEqual(size, PATH_CAP)
            ctypes.memmove(buffer, path + b'\0', len(path) + 1)
            return len(path)
        function = mock.Mock(side_effect=copied)
        library = mock.Mock(proc_pidpath=function)
        with mock.patch('attention_identity.sys.platform', 'darwin'), mock.patch('attention_identity.ctypes.CDLL', return_value=library) as load:
            self.assertEqual(darwin_pidpath(123), '/fake/kernel/Python')
        load.assert_called_once_with('/usr/lib/libproc.dylib', use_errno=True)
        self.assertEqual(function.argtypes, [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32])
        self.assertEqual(function.restype, ctypes.c_int)

    def test_executable_file_streams_tiny_bytes_and_refuses_symlink(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-identity-source-') as directory:
            file = Path(directory) / 'tiny.bin'
            file.write_bytes(b'not executable; SOURCE unit fixture')
            observed = executable_file(str(file))
            self.assertEqual(observed['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
            alias = Path(directory) / 'alias'
            alias.symlink_to(file)
            with self.assertRaises(OSError):
                executable_file(str(alias))

    def test_executable_primary_and_close_failure_are_separately_persisted(self):
        with mock.patch('attention_identity.os.open', return_value=17), mock.patch('attention_identity.os.fstat', side_effect=OSError('original executable read failure')), mock.patch('attention_identity.os.close', side_effect=OSError('executable close failure')) as close:
            with self.assertRaises(ExecutableFileFailure) as failure:
                executable_file('/fake/executable')
        close.assert_called_once_with(17)
        self.assertEqual(failure.exception.primary['message'], 'original executable read failure')
        self.assertEqual(failure.exception.cleanup['message'], 'executable close failure')
        records, options = deps()
        options['file_record'] = mock.Mock(side_effect=failure.exception)
        with self.assertRaises(ExecutableFileFailure):
            static_identity(EXPECTED, PIN, records.append, **options)
        self.assertEqual(records[0]['error']['message'], 'original executable read failure')
        self.assertEqual(records[0]['fileCleanup'][0]['message'], 'executable close failure')

    def test_executable_single_read_or_close_failure_still_refuses(self):
        with mock.patch('attention_identity.os.open', return_value=17), mock.patch('attention_identity.os.fstat', side_effect=OSError('read only')), mock.patch('attention_identity.os.close') as close:
            with self.assertRaisesRegex(OSError, 'read only'):
                executable_file('/fake/executable')
        close.assert_called_once_with(17)
        with tempfile.TemporaryDirectory(prefix='aurialis-identity-source-') as directory:
            file = Path(directory) / 'tiny.bin'
            file.write_bytes(b'fixture')
            original_close = __import__('os').close
            def closed_then_failed(descriptor):
                original_close(descriptor)
                raise OSError('close only')
            with mock.patch('attention_identity.os.close', side_effect=closed_then_failed), self.assertRaises(ExecutableFileFailure) as failure:
                executable_file(str(file))
            self.assertIsNone(failure.exception.primary)
            self.assertEqual(failure.exception.cleanup['message'], 'close only')

    def fake_ps(self, chunks, timeout=False):
        output = mock.Mock()
        output.fileno.return_value = 1
        child = mock.Mock(stdout=output)
        exited = [False]
        child.poll.side_effect = lambda: 0 if exited[0] else None
        def reaped(**_kwargs):
            exited[0] = True
            return 0
        child.wait.side_effect = reaped
        selector = mock.Mock()
        selector.select.return_value = [(1, 1)]
        if timeout:
            selector.select.side_effect = [[(1, 1)], []]
        return child, selector, mock.patch('attention_identity.os.read', side_effect=chunks)

    def test_bounded_ps_uses_fake_subprocess_only_and_reaps_exact_helper(self):
        child, selector, reads = self.fake_ps([b'/pin arg\n', b''])
        with mock.patch('attention_identity.subprocess.Popen', return_value=child) as spawn, mock.patch('attention_identity.selectors.DefaultSelector', return_value=selector), reads:
            self.assertEqual(bounded_ps(123), b'/pin arg\n')
        self.assertEqual(spawn.call_args.args[0], ['/bin/ps', '-p', '123', '-o', 'command='])
        child.kill.assert_not_called()
        child.stdout.close.assert_called_once()
        selector.close.assert_called_once()

    def test_selector_close_failure_cannot_skip_exact_child_kill_reap_and_pipe_close(self):
        child, selector, reads = self.fake_ps([b'partial'], True)
        selector.close.side_effect = OSError('selector close unconfirmed')
        with mock.patch('attention_identity.subprocess.Popen', return_value=child), mock.patch('attention_identity.selectors.DefaultSelector', return_value=selector), reads, self.assertRaises(RawCommandFailure) as failure:
            bounded_ps(123)
        self.assertIn('deadline', str(failure.exception))
        self.assertIn('deadline', failure.exception.primary['message'])
        self.assertEqual(failure.exception.cleanup[0]['phase'], 'selector-close')
        child.kill.assert_called_once()
        child.wait.assert_called_once()
        child.stdout.close.assert_called_once()

    def test_all_cleanup_failures_are_recorded_without_replacing_original_timeout(self):
        child, selector, reads = self.fake_ps([b'partial'], True)
        selector.close.side_effect = OSError('selector close failed')
        child.kill.side_effect = OSError('kill unconfirmed')
        child.wait.side_effect = OSError('reap unconfirmed')
        child.stdout.close.side_effect = OSError('pipe close unconfirmed')
        with mock.patch('attention_identity.subprocess.Popen', return_value=child), mock.patch('attention_identity.selectors.DefaultSelector', return_value=selector), reads, self.assertRaises(RawCommandFailure) as failure:
            bounded_ps(123)
        self.assertIn('deadline', str(failure.exception))
        self.assertEqual([error['phase'] for error in failure.exception.cleanup], ['selector-close', 'direct-ps-kill', 'direct-ps-reap', 'ps-pipe-close'])
        child.kill.assert_called_once()
        child.wait.assert_called_once()
        child.stdout.close.assert_called_once()

    def test_bounded_ps_timeout_overflow_and_invalid_pid_never_escape_fake_cleanup(self):
        for chunks, timeout in [([b'partial'], True), ([b'x' * 4096] * 4 + [b'x'], False)]:
            child, selector, reads = self.fake_ps(chunks, timeout)
            with mock.patch('attention_identity.subprocess.Popen', return_value=child), mock.patch('attention_identity.selectors.DefaultSelector', return_value=selector), reads, self.assertRaises(RawCommandFailure) as failure:
                bounded_ps(123)
            self.assertLessEqual(len(failure.exception.raw), COMMAND_CAP)
            child.kill.assert_called_once()
            child.stdout.close.assert_called_once()
        with mock.patch('attention_identity.subprocess.Popen', side_effect=AssertionError('No process allowed')):
            for pid in (True, 0, 1, '123', 2 ** 31):
                with self.assertRaises(RuntimeError):
                    bounded_ps(pid)


if __name__ == '__main__':
    unittest.main()
