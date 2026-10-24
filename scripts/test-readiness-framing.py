"""Closed readiness framing/diagnostic controls; only injected sockets, no HTTP server."""
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent / "qualification"))
import qualification_clock as clock
import scale_service as service


class FramingControls(unittest.TestCase):
    def tearDown(self): clock.configure(None)

    def request(self, response, limit=3, fragment=False):
        stream = Mock(); stream.__enter__ = Mock(return_value=stream); stream.__exit__ = Mock(return_value=False)
        chunks = [response[index:index+1] for index in range(len(response))] if fragment else [response]
        stream.recv.side_effect = chunks + [b""]
        with patch.object(service.socket, "create_connection", return_value=stream):
            return service.metadata_get(3927, "/", limit)

    def test_three_valid_framings_preserve_identical_decoded_bytes_and_hash(self):
        messages = [(b"Content-Length: 3\r\n", b"abc", "content-length"),
                    (b"Transfer-Encoding: chunked\r\n", b"1\r\na\r\n2\r\nbc\r\n0\r\n\r\n", "chunked"),
                    (b"Connection: close\r\n", b"abc", "close")]
        hashes = set()
        for fields, body, framing in messages:
            with self.subTest(framing=framing):
                actual, receipt = self.request(b"HTTP/1.1 200 OK\r\n" + fields + b"\r\n" + body, fragment=True)
                self.assertEqual(actual, b"abc"); self.assertEqual(receipt["framing"]["mode"], framing)
                self.assertTrue(receipt["framing"]["headersParsed"]); self.assertTrue(receipt["framing"]["framingFieldsParsed"])
                hashes.add(receipt["sha256"])
        self.assertEqual(len(hashes), 1)

    def test_header_parse_failure_marks_framing_fields_unknown_instead_of_absent(self):
        with patch.object(service.http.client, "parse_headers", side_effect=service.http.client.HTTPException("fixture parse failure")):
            with self.assertRaises(service.ReadinessHTTPError) as caught:
                self.request(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc")
        diagnostic = caught.exception.diagnostic
        self.assertEqual(diagnostic["status"], 200)
        self.assertFalse(diagnostic["headersParsed"]); self.assertFalse(diagnostic["framingFieldsParsed"])
        self.assertEqual(diagnostic["contentLength"]["count"], 0)  # Unknown, not observed absence.

    def test_nonthrowing_partial_or_folded_headers_leave_framing_unknown(self):
        defective = b"X-Prefix: kept\r\nMalformed line without colon\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n"
        parsed = service.http.client.parse_headers(io.BytesIO(defective + b"\r\n"))
        self.assertTrue(parsed.defects)  # The real parser returns a partial message.
        self.assertEqual(parsed.get_all("Transfer-Encoding", []), [])
        self.assertEqual(parsed.get_all("Content-Length", []), [])
        folded = b"X-Prefix: kept\r\n Transfer-Encoding: chunked\r\nContent-Length: 3\r\n"
        for headers in (defective, folded):
            with self.subTest(headers=headers):
                with self.assertRaises(service.ReadinessHTTPError) as caught:
                    self.request(b"HTTP/1.1 200 OK\r\n" + headers + b"\r\nabc")
                diagnostic = caught.exception.diagnostic
                self.assertEqual(diagnostic["status"], 200)
                self.assertFalse(diagnostic["headersParsed"])
                self.assertFalse(diagnostic["framingFieldsParsed"])
                self.assertEqual(diagnostic["transferEncoding"]["count"], 0)  # Untrusted/unknown, not absent.

    def test_refusal_keeps_only_bounded_selected_framing_values(self):
        response = b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nTransfer-Encoding: chunked\r\nContent-Encoding: identity\r\nSet-Cookie: PRIVATE_COOKIE\r\nAuthorization: PRIVATE_AUTH\r\n\r\nc\r\nPRIVATE_BODY\r\n0\r\n\r\n"
        with self.assertRaises(service.ReadinessHTTPError) as caught: self.request(response, limit=12)
        diagnostic = caught.exception.diagnostic; encoded = json.dumps(diagnostic)
        self.assertEqual(diagnostic["status"], 200)
        self.assertEqual(diagnostic["contentLength"]["values"], ["12"])
        self.assertEqual(diagnostic["transferEncoding"]["values"], ["chunked"])
        self.assertEqual(diagnostic["contentEncoding"]["values"], ["identity"])
        self.assertLessEqual(len(encoded.encode()), 4096)
        self.assertNotIn("PRIVATE", encoded)

    def test_duplicate_ambiguous_compressed_and_nonchunked_coding_refuse(self):
        fields = [b"Content-Length: 3\r\nTransfer-Encoding: chunked\r\n", b"Content-Length: 3\r\nContent-Length: 3\r\n",
                  b"Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n", b"Transfer-Encoding: gzip, chunked\r\n",
                  b"Content-Encoding: gzip\r\n", b"Content-Encoding: identity\r\nContent-Encoding: identity\r\n",
                  b"Content-Length: +3\r\n", b"Content-Length: 3,3\r\n", b"Content-Length: -3\r\n"]
        for headers in fields:
            with self.subTest(headers=headers), self.assertRaises(RuntimeError): self.request(b"HTTP/1.1 200 OK\r\n" + headers + b"\r\nabc")

    def test_chunk_extensions_trailers_invalid_size_truncation_and_excess_refuse(self):
        bodies = [b"3;x=y\r\nabc\r\n0\r\n\r\n", b"3\r\nabc\r\n0\r\nX-Trailer: forbidden\r\n\r\n",
                  b"-1\r\n", b"xyz\r\n", b"4\r\nabcd\r\n0\r\n\r\n", b"3\r\nab", b"3\r\nabcXX0\r\n\r\n",
                  b"3\r\nabc\r\n", b"3\r\nabc\r\n0\r\n", b"3\r\nabc\r\n0\r\n\r\nEXCESS"]
        for body in bodies:
            with self.subTest(body=body), self.assertRaises(RuntimeError): self.request(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + body)

    def test_closed_and_declared_bodies_cannot_exceed_decoded_limit(self):
        for headers, body in [(b"", b"abcd"), (b"Content-Length: 3\r\n", b"ab"), (b"Content-Length: 3\r\n", b"abcd")]:
            with self.subTest(headers=headers, body=body), self.assertRaises(RuntimeError): self.request(b"HTTP/1.1 200 OK\r\n" + headers + b"\r\n" + body)

    def test_chunk_count_and_size_line_are_bounded_before_body_allocation(self):
        for body in [(b"1\r\na\r\n" * 129) + b"0\r\n\r\n", (b"0" * 129) + b"\r\n\r\n"]:
            with self.subTest(size=len(body)), self.assertRaises(RuntimeError): self.request(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + body, limit=129)

    def test_header_and_chunk_overhead_share_existing_16kib_cap(self):
        for padding, body, limit in [(16000, b"1\r\na\r\n" * 128 + b"0\r\n\r\n", 128),
                                      (16100, b"0" * 125 + b"1\r\na\r\n" + b"0" * 126 + b"\r\n\r\n", 6460)]:
            header = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-Padding: " + b"a" * padding + b"\r\n\r\n"
            with self.subTest(padding=padding), self.assertRaises(RuntimeError): self.request(header + body, limit=limit)

    def test_selected_duplicate_diagnostics_truncate_values_without_echoing_other_fields(self):
        headers = b"Content-Length: " + b"1" * 200 + b"\r\nContent-Length: 3\r\nContent-Length: 4\r\n"
        with self.assertRaises(service.ReadinessHTTPError) as caught: self.request(b"HTTP/1.1 200 OK\r\n" + headers + b"\r\n")
        value = caught.exception.diagnostic["contentLength"]
        self.assertEqual(value["count"], 3); self.assertTrue(value["truncated"])
        self.assertEqual(len(value["values"]), 2); self.assertLessEqual(len(value["values"][0]), 80)

    def test_slow_chunked_or_closed_drip_does_not_refresh_absolute_deadline(self):
        for fields, body in [(b"Transfer-Encoding: chunked\r\n", b"3\r\nabc\r\n0\r\n\r\n"), (b"", b"abc")]:
            ticks = [0.0]
            def tick(): ticks[0] += .01; return ticks[0]
            with self.subTest(fields=fields), patch.object(clock.time, "monotonic", side_effect=tick):
                clock.configure(.2)
                with self.assertRaisesRegex(RuntimeError, "deadline"): self.request(b"HTTP/1.1 200 OK\r\n" + fields + b"\r\n" + body, fragment=True)


if __name__ == "__main__": unittest.main()
