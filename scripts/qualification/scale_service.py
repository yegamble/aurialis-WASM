"""Exact QA-only static-service command and writable routes; observer never signals it."""
import hashlib
import http.client
import io
import json
import os
import signal
import socket
import stat
import time
from pathlib import Path
import shlex
import subprocess

from scale_completion import read_json
from qualification_clock import remaining
from observed_service import ObservedService
from owned_groups import snapshot, same
from scale_resources import bounded_json
from listener_probe import listener_probe, ListenerProbeError


def service_contract(base, budget_root, node, port):
    base, budget_root, node = Path(base), Path(budget_root), Path(node)
    if type(port) is not int or not 1024 <= port <= 65535:
        raise RuntimeError("Explicit loopback service port required")
    # Wrangler prefers an existing legacy global directory over XDG. Refuse it
    # instead of changing HOME, touching old state or silently escaping the ledger.
    legacy = Path.home() / ".wrangler"
    if legacy.exists() or legacy.is_symlink():
        raise RuntimeError("Existing legacy Wrangler home prevents isolated scale routing")
    service = budget_root / "service"
    original, _ = read_json(base / "deploy/cloudflare/wrangler.jsonc", 4096)
    if (set(original) != {"$schema", "name", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "assets", "observability"}
            or original["main"] != "worker.ts" or original["assets"] != {"directory": "./assets", "binding": "ASSETS", "run_worker_first": True, "html_handling": "none", "not_found_handling": "404-page"}):
        raise RuntimeError("Original static service configuration changed and requires review")
    config = {**original, "$schema": str(base / "node_modules/wrangler/config-schema.json"),
              "main": str(base / "deploy/cloudflare/worker.ts"),
              "assets": {**original["assets"], "directory": str(base / "deploy/cloudflare/assets")}}
    cli = (base / "node_modules/wrangler/wrangler-dist/cli.js").resolve(strict=True)
    argv = [str(node), str(cli), "dev", "--config", str(service / "wrangler.json"),
            "--local", "--ip", "127.0.0.1", "--port", str(port),
            "--persist-to", str(service / "state")]
    environment = {"TMPDIR": str(service / "tmp") + "/", "XDG_CONFIG_HOME": str(service / "config"),
                   "XDG_CACHE_HOME": str(service / "cache"),
                   "WRANGLER_REGISTRY_PATH": str(service / "registry"),
                   "WRANGLER_LOG_PATH": str(service / "debug.log"),
                   "WRANGLER_SEND_METRICS": "false", "WRANGLER_SEND_ERROR_REPORTS": "false",
                   "WRANGLER_NO_SKILLS_UPDATE_PROMPTS": "true"}
    return {"argv": argv, "environment": environment, "config": config,
            "url": "http://127.0.0.1:" + str(port), "cliSHA256": hashlib.sha256(cli.read_bytes()).hexdigest()}


def pin_service(observer, contract, rows):
    config_path = Path(contract["argv"][4])
    actual, config_receipt = read_json(config_path, 4096)
    if actual != contract["config"]:
        raise RuntimeError("External service effective config differs from the qualified static assets")
    command = subprocess.check_output(["/bin/ps", "-p", str(observer.identity["pid"]), "-o", "command="], text=True, timeout=remaining(3)).strip()
    if shlex.split(command) != contract["argv"]:
        raise RuntimeError("External service is not the exact pinned Node/Wrangler/config command")
    live = observer.observe(rows)
    port = contract["url"].rsplit(":", 1)[1]
    pids, probe = listener_probe(int(port))
    proved = {row["pid"]: row for row in live}
    if not pids or not pids <= set(proved):
        raise ListenerProbeError("External listener does not belong to the admitted service group", probe)
    return {"leader": dict(observer.identity), "listeners": [dict(proved[pid]) for pid in sorted(pids)],
            "config": config_receipt, "command": contract["argv"], "url": contract["url"],
            "cliSHA256": contract["cliSHA256"], "observationOnly": True, "listenerProbe": probe}


class ReadinessHTTPError(RuntimeError):
    """Selected framing metadata only; never raw headers, cookies or body bytes."""
    def __init__(self, message, diagnostic):
        super().__init__(message)
        self.diagnostic = json.loads(bounded_json(diagnostic, 4096))


def metadata_get(port, path, limit):
    """Two closed GETs: bounded RFC9112§6.3/7.1 framing and absolute read time."""
    if path not in ("/", "/processing-build.json") or type(port) is not int or not 1024 <= port <= 65535 or not 1 <= limit <= 64 * 1024:
        raise RuntimeError("Closed static readiness request required")
    maximum_framing = 16 * 1024
    diagnostic = {"path": path, "status": None, "headersParsed": False, "framingFieldsParsed": False, "mode": None, "wireBytes": 0,
                  "headerFramingBytes": 0, "decodedBytes": 0, "chunkCount": 0}
    for name in ("contentLength", "transferEncoding", "contentEncoding"):
        diagnostic[name] = {"count": 0, "values": [], "truncated": False}

    def refuse(message): raise ReadinessHTTPError(message, diagnostic)

    def selected(values):
        safe = ["".join(char if 32 <= ord(char) <= 126 else "?" for char in value[:80]) for value in values[:2]]
        return {"count": len(values), "values": safe, "truncated": len(values) > 2 or any(len(value) > 80 for value in values[:2])}

    request = ("GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + str(port) + "\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n").encode("ascii")
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=remaining(1)) as transport:
            transport.settimeout(remaining(1)); transport.sendall(request)
            pending = bytearray(); data = bytearray()

            def receive():
                transport.settimeout(remaining(1))
                capacity = maximum_framing + limit + 1 - diagnostic["wireBytes"]
                if capacity <= 0: refuse("Static readiness wire bytes exceed bound")
                chunk = transport.recv(min(4096, capacity))
                diagnostic["wireBytes"] += len(chunk)
                if diagnostic["wireBytes"] > maximum_framing + limit: refuse("Static readiness wire bytes exceed bound")
                pending.extend(chunk)
                return bool(chunk)

            def framing(count):
                diagnostic["headerFramingBytes"] += count
                if diagnostic["headerFramingBytes"] > maximum_framing: refuse("Static readiness header/framing exceeds 16 KiB")

            def exact(count):
                while len(pending) < count:
                    if not receive(): refuse("Static readiness framed body ended early")
                result = bytes(pending[:count]); del pending[:count]
                return result

            def line():
                while b"\r\n" not in pending:
                    if len(pending) >= 128: refuse("Static readiness chunk line exceeds 128 bytes")
                    if not receive(): refuse("Static readiness chunk line ended early")
                offset = pending.index(b"\r\n")
                if offset + 2 > 128: refuse("Static readiness chunk line exceeds 128 bytes")
                value = exact(offset + 2); framing(len(value))
                return value[:-2]

            while b"\r\n\r\n" not in pending:
                if len(pending) >= maximum_framing: refuse("Static readiness header exceeds 16 KiB")
                if not receive(): refuse("Static readiness header ended early")
            offset = pending.index(b"\r\n\r\n")
            head = exact(offset + 4); framing(len(head))
            status, _, raw_headers = head[:-4].partition(b"\r\n")
            parts = status.split(b" ", 2)
            if len(parts) >= 2 and len(parts[1]) == 3 and parts[1].isdigit(): diagnostic["status"] = int(parts[1])
            headers = http.client.parse_headers(io.BytesIO(raw_headers + b"\r\n\r\n"))
            if headers.defects or any(value[:1] in (b" ", b"\t") for value in raw_headers.split(b"\r\n")):
                refuse("Static readiness malformed/folded headers refused")
            diagnostic["headersParsed"] = True
            lengths, transfers, encodings = [headers.get_all(name, []) for name in ("Content-Length", "Transfer-Encoding", "Content-Encoding")]
            for name, values in (("contentLength", lengths), ("transferEncoding", transfers), ("contentEncoding", encodings)):
                diagnostic[name] = selected(values)
            diagnostic["framingFieldsParsed"] = True
            if not parts or parts[0] not in (b"HTTP/1.0", b"HTTP/1.1") or diagnostic["status"] != 200:
                refuse("Static readiness requires 200 without redirects")
            if len(lengths) > 1 or len(transfers) > 1 or len(encodings) > 1 or (lengths and transfers):
                refuse("Static readiness ambiguous/duplicate framing refused")
            if encodings and encodings[0].strip().lower() != "identity": refuse("Static readiness compressed content refused")
            if headers.get("Trailer") is not None: refuse("Static readiness trailers refused")
            if transfers:
                if transfers[0].strip().lower() != "chunked": refuse("Static readiness unsupported transfer coding")
                diagnostic["mode"] = "chunked"
                while True:
                    size_line = line()
                    if not size_line or any(char not in b"0123456789abcdefABCDEF" for char in size_line):
                        refuse("Static readiness chunk size/extension refused")
                    size = int(size_line, 16)
                    if size == 0:
                        if line() != b"": refuse("Static readiness trailers refused")
                        break
                    diagnostic["chunkCount"] += 1
                    if diagnostic["chunkCount"] > 128: refuse("Static readiness chunk count exceeds 128")
                    if size > limit - len(data): refuse("Static readiness decoded body exceeds bound")
                    data.extend(exact(size)); diagnostic["decodedBytes"] = len(data)
                    framing(2)
                    if exact(2) != b"\r\n": refuse("Static readiness chunk data terminator refused")
            elif lengths:
                diagnostic["mode"] = "content-length"; value = lengths[0].strip()
                if not value.isascii() or not value.isdigit() or not 0 <= int(value) <= limit:
                    refuse("Static readiness declared body exceeds bound or is invalid")
                data.extend(exact(int(value))); diagnostic["decodedBytes"] = len(data)
            else:
                diagnostic["mode"] = "close"
                while True:
                    if len(pending) > limit - len(data): refuse("Static readiness decoded body exceeds bound")
                    data.extend(pending); pending.clear(); diagnostic["decodedBytes"] = len(data)
                    if not receive(): break
            if pending or (diagnostic["mode"] != "close" and receive()): refuse("Static readiness bytes follow completed body")
            remaining(1)
    except ConnectionRefusedError:
        raise  # Only not-ready connection refusal can be retried by the startup loop.
    except ReadinessHTTPError:
        raise
    except Exception as error:
        reason = "Static readiness deadline exhausted" if isinstance(error, RuntimeError) and "deadline" in str(error) else "Static readiness transport/parse failure (" + type(error).__name__ + ")"
        raise ReadinessHTTPError(reason, diagnostic) from None
    return bytes(data), {"url": "http://127.0.0.1:" + str(port) + path, "status": 200, "bytes": len(data),
                         "sha256": hashlib.sha256(data).hexdigest(), "framing": diagnostic,
                         "headers": {name: headers.get(name) for name in ("Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy", "Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options")}}


def verify_static_assets(base):
    """The already-qualified34a closed receipt is authority, not a fresh build."""
    base = Path(base)
    manifest, receipt = read_json(base / "artifacts/album-producers-34a9cab/browser-restored-bytecheck.json", 256 * 1024)
    if receipt["sha256"] != "8db4ef3d66f9e9e44e511094f38b721e166977b25d06f4ad1acf12cc99667ea2":
        raise RuntimeError("Accepted34a asset receipt changed")
    files = manifest.get("files")
    if not isinstance(files, dict) or len(files) != 96:
        raise RuntimeError("Accepted34a closed member count changed")
    outer = {"artifacts/ci-browser-runtime/assets.tar", "artifacts/ci-browser-runtime/assets-manifest.json", "deploy/cloudflare/asset-policy.json"}
    for relative, expected in files.items():
        path = base / relative
        if (not isinstance(relative, str) or not (relative in outer or relative.startswith("deploy/cloudflare/assets/"))
                or path.resolve() != path or not isinstance(expected, dict) or set(expected) != {"bytes", "sha256"}):
            raise RuntimeError("Accepted34a member escaped its exact closed path")
        digest = hashlib.sha256(); size = 0
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode): raise RuntimeError("Accepted34a member must be regular")
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                while True:
                    remaining(3); chunk = source.read(64 * 1024)
                    if not chunk: break
                    size += len(chunk)
                    if size > expected["bytes"]: raise RuntimeError("Accepted34a member grew")
                    digest.update(chunk)
        finally: os.close(descriptor)
        if size != expected["bytes"] or digest.hexdigest() != expected["sha256"]:
            raise RuntimeError("Accepted34a member differs from qualified bytes")
    identity, identity_receipt = read_json(base / "deploy/cloudflare/assets/processing-build.json", 4096)
    policy, _ = read_json(base / "deploy/cloudflare/asset-policy.json", 16 * 1024)
    with (base / "deploy/cloudflare/assets/index.html").open("rb") as source: html = source.read(6461)
    if len(html) != 6460 or hashlib.sha256(html).hexdigest() != "271e8f53d3f17c498648bcbf98292ddc028560ce84978e8244ba16cc0aef1f6b":
        raise RuntimeError("Accepted34a HTML authority changed")
    return {"manifest": receipt, "members": len(files), "identity": identity,
            "identityReceipt": identity_receipt, "html": html, "csp": policy["csp"]}


class ServiceStillLive(RuntimeError):
    """Only transient live survivors may consume the bounded terminal wait."""


class OwnedStaticService:
    """One direct child of the already-counted QA parent, never another owner process."""
    def __init__(self, base, root, node, port):
        self.contract = service_contract(base, root, node, port)
        self.directory = Path(root) / "service"
        self.process = None; self.observer = None; self.log = None; self.terminal = None
        self.events = []; self.cleanup_errors = []; self.directory_identity = None; self.accepted = None

    def prepare(self):
        self.accepted = verify_static_assets(Path(self.contract["config"]["assets"]["directory"]).parents[2])
        self.directory.mkdir(mode=0o700, parents=False, exist_ok=False)
        info = self.directory.lstat()
        self.directory_identity = (info.st_dev, info.st_ino)
        for name in ("state", "tmp", "config", "cache", "registry"):
            (self.directory / name).mkdir(mode=0o700)
        self.publish("wrangler.json", self.contract["config"])
        descriptor = os.open(self.directory / "runtime.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        self.log = os.fdopen(descriptor, "wb")

    def publish(self, name, value, limit=64 * 1024):
        data = bounded_json(value, limit)
        remaining(3)
        if self.directory_identity is None: raise RuntimeError("Service directory is not owned")
        directory = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(directory)
            if (info.st_dev, info.st_ino) != self.directory_identity: raise RuntimeError("Owned service directory identity changed")
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(descriptor, "wb") as output:
                output.write(data); output.flush(); os.fsync(output.fileno())
            os.fsync(directory)
        finally: os.close(directory)
        remaining(3)

    def spawn(self, contract=None):
        if self.process is not None: raise RuntimeError("Owned service already assigned")
        definition = self.contract if contract is None else contract
        remaining(3)
        self.process = subprocess.Popen(definition["argv"], env={**os.environ, **definition["environment"]},
                                        stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        # Assignment precedes every fallible observer/readiness operation.
        self.observer = ObservedService(self.process.pid)
        if self.observer.identity["ppid"] != os.getpid():
            raise RuntimeError("Owned service no longer has its exact direct parent")

    def ready(self, base, sample):
        if self.accepted is None: raise RuntimeError("Accepted static bytes not verified before launch")
        expected, expected_receipt, html = self.accepted["identity"], self.accepted["identityReceipt"], self.accepted["html"]
        port = int(self.contract["url"].rsplit(":", 1)[1])
        # Retry only connection-not-ready inside the single fixed startup phase;
        # a served malformed/wrong build is a hard failure, never a cache fallback.
        while True:
            sample()
            if self.process.poll() is not None: raise RuntimeError("Owned service exited before readiness")
            try:
                identity_body, identity_receipt = metadata_get(port, "/processing-build.json", 4096)
                break
            except ConnectionRefusedError:
                time.sleep(remaining(.1))
        try: identity = json.loads(identity_body)
        except ValueError: raise ReadinessHTTPError("Served processing identity is invalid JSON", identity_receipt.get("framing", {})) from None
        if identity != expected: raise ReadinessHTTPError("Served processing identity differs from accepted browser producer", identity_receipt.get("framing", {}))
        body, html_receipt = metadata_get(port, "/", len(html))
        if body != html: raise ReadinessHTTPError("Served HTML differs from accepted browser producer", html_receipt.get("framing", {}))
        expected_headers = {"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Content-Security-Policy": self.accepted["csp"], "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"}
        if any(value["headers"] != expected_headers for value in (identity_receipt, html_receipt)):
            raise ReadinessHTTPError("Served static security headers differ from accepted Worker", {"responses": [identity_receipt.get("framing", {}), html_receipt.get("framing", {})]})
        proof = pin_service(self.observer, self.contract, snapshot())
        value = {"process": dict(self.observer.identity), "expectedIdentity": expected_receipt,
                 "identity": identity_receipt, "html": html_receipt, "pin": proof,
                 "audioProcessing": False, "directOwnerPID": os.getpid(), "acceptedManifest": self.accepted["manifest"], "verifiedMembers": self.accepted["members"]}
        self.publish("readiness.json", value)
        return proof

    def terminal_observation(self):
        if self.process is None or self.process.poll() is None:
            raise RuntimeError("Terminal service requires reaped direct child exit")
        if self.observer is None: raise RuntimeError("Service setup was not identity-qualified")
        rows = snapshot(); expected = self.observer.identity
        # Historical records stay in the SAME observer. No new identity, command
        # permission or signal authority is derived once its leader has exited.
        for pid, old in self.observer.known.items():
            current = rows.get(pid)
            if current is not None and not same(old, current):
                raise RuntimeError("Known terminal service identity changed")
        selected = [dict(value) for value in rows.values() if value["pgid"] == expected["pgid"]]
        for value in selected:
            old = self.observer.known.get(value["pid"])
            if old is None or not same(value, old): raise RuntimeError("Unknown terminal service group identity refused")
            if "Z" not in value["state"]: raise ServiceStillLive("Terminal service still has live members")
        self.terminal = {"phase": "terminal-read-only", "group": expected["pgid"], "members": selected, "liveMembers": [], "newAdmissions": [], "signalAuthority": False}
        return self.terminal

    def stop(self):
        if self.process is None: return None
        for number, wait in ((signal.SIGINT, 8), (signal.SIGKILL, 3)):
            if self.process.poll() is not None: break
            try:
                if self.observer is None: raise RuntimeError("Service has no admitted group signal authority")
                observed = self.observer.observe(snapshot())
                self.events.append({"phase": "before-owned-service-signal", "signal": int(number), "members": observed})
                os.killpg(self.observer.identity["pgid"], number)
            except BaseException as error:
                self.cleanup_errors.append({"phase": "service-group-signal-refused", "message": str(error)[:4096]})
                # Only this exact assigned Popen may be stopped without group authority.
                if number == signal.SIGINT: self.process.terminate()
                else: self.process.kill()
            try:
                self.process.wait(timeout=remaining(wait))
            except subprocess.TimeoutExpired:
                continue
            except BaseException as error:
                self.cleanup_errors.append({"phase": "service-wait", "message": str(error)[:4096]})
        if self.process.poll() is None: raise RuntimeError("Owned service direct child did not settle")
        until = time.monotonic() + remaining(3)
        while True:
            try:
                return self.terminal_observation()
            except ServiceStillLive as error:
                if time.monotonic() >= until: raise
                self.events.append({"phase": "service-terminal-wait", "message": str(error)[:4096]})
                time.sleep(remaining(min(.1, until - time.monotonic())))

    def close_log(self):
        if self.log is not None:
            self.log.close(); self.log = None
