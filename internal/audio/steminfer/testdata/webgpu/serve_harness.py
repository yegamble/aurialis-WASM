"""Loopback-only closed static fixture harness. No upload, model or audio route."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit

FILES = {"/": ("index.html", "text/html; charset=utf-8"), "/style.css": ("style.css", "text/css"),
         **{"/" + name: (name, "text/javascript") for name in ("worker.mjs", "client.mjs", "contract.mjs", "harness.mjs", "shader.mjs")}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=3938)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise ValueError("Use an unprivileged loopback port")
    root = args.root.resolve(strict=True)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send(False)

        def do_POST(self):
            self.send_error(405, "Only GET/HEAD static files are served")

        def do_HEAD(self):
            self.send(True)

        def send(self, head):
            allowed = {"127.0.0.1:" + str(args.port), "localhost:" + str(args.port)}
            if self.headers.get("Host") not in allowed or self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.send_error(403)
                return
            origin = self.headers.get("Origin")
            if origin is not None and origin not in {"http://" + host for host in allowed}:
                self.send_error(403)
                return
            item = FILES.get(urlsplit(self.path).path)
            if not item:
                self.send_error(404)
                return
            path = root / item[0]
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
                self.send_error(404)
                return
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", item[1])
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'none'; frame-ancestors 'none'")
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head:
                self.wfile.write(data)

    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
