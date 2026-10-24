"""Private literal asset server; no fixture/audio upload or directory route."""
import hashlib
import http.server
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ALLOWED = {name: 'text/javascript; charset=utf-8' for name in ('harness.mjs', 'capture.mjs', 'capture-contract.mjs', 'client.mjs', 'contract.mjs', 'fixture-index.mjs', 'runtime-contract.mjs', 'propagated.mjs', 'shader.mjs', 'worker.mjs', 'gpu-runner.mjs')}
ALLOWED.update({'index.html': 'text/html; charset=utf-8', 'style.css': 'text/css; charset=utf-8', 'favicon.svg': 'image/svg+xml'})
POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'none'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"


def assets():
    manifest_path = ROOT / 'asset-manifest.json'
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 16384:
        raise ValueError('Unsafe asset manifest')
    with manifest_path.open('rb') as source:
        encoded = source.read(16385)
    if len(encoded) > 16384:
        raise ValueError('Manifest grew beyond cap')
    manifest = json.loads(encoded)
    if set(manifest) != set(ALLOWED):
        raise ValueError('Closed asset set changed')
    result = {}
    for name, record in manifest.items():
        path = ROOT / name
        if '/' in name or path.is_symlink() or not path.is_file():
            raise ValueError('Unsafe literal asset')
        with path.open('rb') as source:
            data = source.read(65537)
        if len(data) > 65536 or record['mime'] != ALLOWED[name] or len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError('Pinned asset changed: ' + name)
        result['/' + name] = (data, record['mime'])
    result['/'] = result['/index.html']
    return result


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'AurialisPrivateFixture/1'

    def handle_asset(self, body):
        authority = '127.0.0.1:' + str(self.server.server_port)
        status, item = 200, self.server.assets.get(self.path)
        if self.command not in ('GET', 'HEAD'):
            status = 405
        elif len(self.path) > 2048:
            status = 414
        elif self.headers.get_all('Host') != [authority] or self.headers.get_all('Origin') not in (None, ['http://' + authority]) or self.headers.get_all('Sec-Fetch-Site') not in (None, ['none'], ['same-origin']):
            status = 403
        elif self.headers.get_all('Transfer-Encoding') or self.headers.get_all('Content-Length') not in (None, ['0']):
            status = 400
        elif item is None:
            status = 404
        self.send_response(status)
        self.send_header('Content-Type', item[1] if status == 200 else 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(item[0])) if status == 200 else '0')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', POLICY)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        if body and status == 200:
            self.wfile.write(item[0])

    def do_GET(self):
        self.handle_asset(True)

    def do_HEAD(self):
        self.handle_asset(False)

    def do_POST(self):
        self.handle_asset(False)

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST
    do_OPTIONS = do_POST

    def log_message(self, *_args):
        pass


def identity_hold(environment, source, destination, pid):
    """Optional diagnostic-only barrier: it can stop, never release socket work."""
    token = environment.get('AURIALIS_ATTENTION_IDENTITY_HOLD')
    if token is None:
        return True
    if not isinstance(token, str) or re.fullmatch('[0-9a-f]{64}', token) is None:
        raise ValueError('Invalid identity hold token')
    destination.write(json.dumps({'phase': 'identity-held-before-bind', 'pid': pid, 'token': token}) + '\n')
    destination.flush()
    if source.readline(4097) != '':
        raise ValueError('Identity hold accepts EOF only; no work release exists')
    return False


def main():
    if not identity_hold(os.environ, sys.stdin, sys.stdout, os.getpid()):
        return
    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    server.assets = assets()
    print(json.dumps({'url': 'http://127.0.0.1:' + str(server.server_port), 'scope': 'private static assets only'}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
