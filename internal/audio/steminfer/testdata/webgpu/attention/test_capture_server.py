"""Pure handler/source tests: binds no socket and launches no browser."""
import importlib.util
import io
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location('private_capture_serve', Path(__file__).with_name('serve.py'))
SERVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVE)


class ServerPolicyTests(unittest.TestCase):
    def request(self, method='GET', target='/', changes=None):
        handler = object.__new__(SERVE.Handler)
        handler.server = SimpleNamespace(server_port=12345, assets={'/': (b'private source', 'text/html')})
        handler.path, handler.command = target, method
        handler.headers = Message()
        values = {'Host': '127.0.0.1:12345'}
        values.update(changes or {})
        for name, value in values.items():
            handler.headers[name] = value
        handler.wfile = io.BytesIO()
        observed = {'headers': {}}
        handler.send_response = lambda status: observed.update(status=status)
        handler.send_header = lambda name, value: observed['headers'].update({name: value})
        handler.end_headers = lambda: None
        handler.handle_asset(method == 'GET')
        observed['body'] = handler.wfile.getvalue()
        return observed

    def test_literal_get_head_and_bodyless_denials(self):
        self.assertEqual(self.request()['body'], b'private source')
        head = self.request('HEAD')
        self.assertEqual(head['body'], b'')
        self.assertEqual(head['headers']['Content-Length'], '14')
        for method in ('POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'):
            result = self.request(method)
            self.assertEqual((result['status'], result['body']), (405, b''))
        for target in ('/../unit-pattern-m1-n1.bin', '/fixture.bin', '/?query=1', '//index.html', '/%69ndex.html'):
            self.assertEqual(self.request(target=target)['status'], 404)

    def test_host_origin_body_and_security_policy(self):
        for changes in ({'Host': 'evil.invalid'}, {'Origin': 'https://evil.invalid'}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.request(changes=changes)['status'], 403)
        self.assertEqual(self.request(changes={'Content-Length': '2'})['status'], 400)
        self.assertEqual(self.request(changes={'Transfer-Encoding': 'chunked'})['status'], 400)
        headers = self.request()['headers']
        self.assertIn("connect-src 'none'", headers['Content-Security-Policy'])
        self.assertEqual(headers['Cross-Origin-Embedder-Policy'], 'require-corp')
        self.assertEqual(headers['Cross-Origin-Opener-Policy'], 'same-origin')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')

    def test_closed_hash_bound_assets_contain_no_fixture_or_node_driver(self):
        assets = SERVE.assets()
        self.assertEqual(set(assets), {'/'} | {'/' + name for name in SERVE.ALLOWED})
        self.assertFalse(any(name.endswith('.bin') or 'driver' in name or 'files' in name for name in assets))


if __name__ == '__main__':
    unittest.main()
