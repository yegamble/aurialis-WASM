"""Injected owned-service/HTTP/deadline controls; never launches a process or socket."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent / "qualification"))
import qualification_clock as clock
import scale_service as service


def row(pid=100, state="S", start="start"):
    return {"pid": pid, "ppid": 90, "pgid": 100, "start": start, "state": state, "rssBytes": 1}


class StaticServiceControls(unittest.TestCase):
    def tearDown(self):
        clock.configure(None)

    def owned(self):
        value = service.OwnedStaticService.__new__(service.OwnedStaticService)
        value.process = Mock(pid=100); value.process.poll.return_value = 0
        value.observer = Mock(identity={**row(), "commandSHA256": "a" * 64}, known={100: row()}, departed=set(), admissions=[], events=[])
        value.events = []; value.cleanup_errors = []; value.log = None; value.terminal = None
        return value

    def test_terminal_empty_retains_same_active_history_without_admitting_any_identity(self):
        value = self.owned(); known = value.observer.known
        with patch.object(service, "snapshot", return_value={}):
            result = value.terminal_observation()
        self.assertEqual(result["liveMembers"], [])
        self.assertIs(value.observer.known, known)
        self.assertIn(100, known)
        value.observer.observe.assert_not_called()

    def test_terminal_live_unknown_reused_and_escaped_known_rows_refuse(self):
        for rows in ({100: row()}, {101: row(101, "Z")}, {100: row(state="Z", start="reused")}, {100: {**row(state="Z"), "pgid": 200}}):
            with self.subTest(rows=rows), patch.object(service, "snapshot", return_value=rows):
                with self.assertRaises(RuntimeError):
                    self.owned().terminal_observation()

    def test_terminal_requires_direct_child_exit_and_never_supplies_signal_authority(self):
        value = self.owned(); value.process.poll.return_value = None
        with patch.object(service.os, "killpg") as signal, self.assertRaisesRegex(RuntimeError, "direct child"):
            value.terminal_observation()
        signal.assert_not_called()

    def test_observer_setup_failure_keeps_assigned_child_for_mandatory_direct_reap(self):
        value = service.OwnedStaticService.__new__(service.OwnedStaticService)
        value.process = None; value.observer = None; value.events = []; value.cleanup_errors = []; value.log = io.BytesIO(); value.terminal = None
        process = Mock(pid=100); process.poll.side_effect = [None] + [0] * 20
        with patch.object(service.subprocess, "Popen", return_value=process), patch.object(service, "ObservedService", side_effect=RuntimeError("observer setup rejected")):
            with self.assertRaisesRegex(RuntimeError, "observer setup"):
                value.spawn({"argv": ["fixture-node"], "environment": {}})
        self.assertIs(value.process, process)
        with patch.object(service, "snapshot", return_value={}), patch.object(service.os, "killpg") as signal:
            with self.assertRaisesRegex(RuntimeError, "not identity-qualified"):
                value.stop()
        process.terminate.assert_called_once(); process.wait.assert_called()
        signal.assert_not_called()
        self.assertTrue(value.cleanup_errors)  # Unqualified setup cannot become a successful service.

    def test_lost_active_leader_never_authorizes_group_signal_but_reaps_direct_handle(self):
        value = self.owned(); value.process.poll.side_effect = [None] + [0] * 20
        value.observer.observe.side_effect = RuntimeError("lost exact active leader")
        with patch.object(service, "snapshot", return_value={}), patch.object(service.os, "killpg") as signal:
            value.stop()
        signal.assert_not_called(); value.process.terminate.assert_called_once(); value.process.wait.assert_called()
        self.assertIn("lost exact active leader", str(value.cleanup_errors))

    def test_int_timeout_uses_fresh_authority_before_kill_and_then_terminal_empty(self):
        value = self.owned(); value.process.poll.side_effect = [None, None, 0, 0]
        value.process.wait.side_effect = [service.subprocess.TimeoutExpired("fixture", 8), 0]
        value.observer.observe.return_value = [row()]
        with patch.object(service, "snapshot", return_value={}), patch.object(service.os, "killpg") as signal:
            self.assertEqual(value.stop()["liveMembers"], [])
        self.assertEqual([call.args[1] for call in signal.call_args_list], [service.signal.SIGINT, service.signal.SIGKILL])
        self.assertEqual(value.observer.observe.call_count, 2)
        self.assertEqual(value.cleanup_errors, [])

    def test_unowned_directory_cannot_receive_cleanup_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            value = self.owned(); value.directory = Path(temporary); value.directory_identity = None
            with self.assertRaisesRegex(RuntimeError, "not owned"): value.publish("exit.json", {"status": "fail"})
            self.assertEqual(list(value.directory.iterdir()), [])

    def test_replaced_directory_cannot_receive_cleanup_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            value = self.owned(); value.directory = Path(temporary); value.directory_identity = (1, 2)
            with self.assertRaisesRegex(RuntimeError, "identity changed"): value.publish("exit.json", {"status": "fail"})
            self.assertEqual(list(value.directory.iterdir()), [])

    def ready_fixture(self):
        value = self.owned(); value.process.poll.return_value = None
        value.contract = {"url": "http://127.0.0.1:3927"}
        value.accepted = {"identity": {"fingerprint": "a" * 64}, "identityReceipt": {}, "html": b"abc", "csp": "fixture", "manifest": {}, "members": 96}
        value.publish = Mock()
        headers = {"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Content-Security-Policy": "fixture", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"}
        return value, headers

    def test_wrong_served_build_or_html_or_header_is_hard_failure_without_readiness_publication(self):
        for fault in ("build", "html", "headers"):
            value, headers = self.ready_fixture()
            identity = json.dumps({"fingerprint": ("b" if fault == "build" else "a") * 64}).encode()
            html = b"bad" if fault == "html" else b"abc"
            if fault == "headers": headers["X-Frame-Options"] = "SAMEORIGIN"
            with self.subTest(fault=fault), patch.object(service, "metadata_get", side_effect=[(identity, {"headers": headers}), (html, {"headers": headers})]):
                with self.assertRaises(RuntimeError): value.ready(Path("/no-real-io"), Mock())
                value.publish.assert_not_called()

    def test_absolute_deadline_clamps_observation_and_expiry_refuses_before_wait(self):
        with patch.object(clock.time, "monotonic", return_value=10):
            clock.configure(20); clock.phase(15)
            self.assertEqual(clock.remaining(30), 5)
        with patch.object(clock.time, "monotonic", return_value=15):
            with self.assertRaisesRegex(RuntimeError, "deadline"):
                clock.remaining(3)

    def test_phase_cannot_extend_the_absolute_clock(self):
        with patch.object(clock.time, "monotonic", return_value=10):
            clock.configure(20); clock.phase(100)
            self.assertEqual(clock.remaining(30), 10)

    def response(self, chunks):
        stream = Mock(); stream.__enter__ = Mock(return_value=stream); stream.__exit__ = Mock(return_value=False)
        stream.recv.side_effect = chunks
        return stream

    def test_fixed_loopback_http_exact_body_and_security_headers(self):
        stream = self.response([b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nX-Content-Type-Options: nosniff\r\n\r\na", b"bc", b""])
        with patch.object(service.socket, "create_connection", return_value=stream) as connect:
            body, receipt = service.metadata_get(3927, "/", 3)
        self.assertEqual(body, b"abc"); self.assertEqual(receipt["bytes"], 3)
        self.assertEqual(connect.call_args.args[0], ("127.0.0.1", 3927))
        self.assertIn(b"Connection: close", stream.sendall.call_args.args[0])

    def test_redirect_chunked_duplicate_or_oversized_reply_refuses_without_followup(self):
        responses = [b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: http://foreign/\r\n\r\n",
                     b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
                     b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\na",
                     b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabcd"]
        for response in responses:
            stream = self.response([response, b""])
            with self.subTest(response=response), patch.object(service.socket, "create_connection", return_value=stream) as connect:
                with self.assertRaises(RuntimeError): service.metadata_get(3927, "/", 3)
                connect.assert_called_once()

    def test_header_and_body_drips_cannot_extend_absolute_read_deadline(self):
        stream = self.response([b"HTTP/1.1 200 OK\r\n", b"Content-Length: 3\r\n\r\na", b"b", b"c", b""])
        ticks = iter([0, 0, 0, 0, 0, .5, 1, 1.5, 2, 2.5, 3, 4, 5, 6])
        with patch.object(clock.time, "monotonic", side_effect=lambda: next(ticks)), patch.object(service.socket, "create_connection", return_value=stream):
            clock.configure(1)
            with self.assertRaisesRegex(RuntimeError, "deadline"):
                service.metadata_get(3927, "/", 3)
        stream.__exit__.assert_called_once()

    def test_http_header_byte_limit_and_trailing_body_are_bounded(self):
        for chunks in ([b"X" * (16 * 1024 + 1)], [b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nab"]):
            with self.subTest(chunks=chunks), patch.object(service.socket, "create_connection", return_value=self.response(chunks)):
                with self.assertRaises(RuntimeError): service.metadata_get(3927, "/", 3)


if __name__ == "__main__": unittest.main()
