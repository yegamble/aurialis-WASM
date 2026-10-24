"""One fixed lsof PID query with bounded pipes and exact direct-child cleanup."""
import base64
import hashlib
import json
import os
import selectors
import subprocess
import time

from qualification_clock import remaining
from scale_resources import bounded_json


class ListenerProbeError(RuntimeError):
    def __init__(self, message, diagnostic):
        super().__init__(message)
        self.diagnostic = json.loads(bounded_json(diagnostic, 4096))


def listener_probe(port):
    if type(port) is not int or not 1024 <= port <= 65535:
        raise RuntimeError("Fixed listener probe requires an explicit loopback port")
    command = ["/usr/sbin/lsof", "-nP", "-iTCP:" + str(port), "-sTCP:LISTEN", "-t"]
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": 4096, "stderr": 1024}
    complete = {"stdout": False, "stderr": False}
    process, selector, primary = None, None, None
    cleanup = []
    started = time.monotonic(); until = None

    def budget(): return remaining(min(3, until - time.monotonic()))
    def summary(error):
        return {"type": type(error).__name__[:32], "message": "".join(char if 32 <= ord(char) <= 126 else "?" for char in str(error)[:80])}

    try:
        until = started + remaining(3)
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        selector = selectors.DefaultSelector()
        for name in buffers:
            stream = getattr(process, name)
            if stream is None: raise RuntimeError("Listener probe output pipe unavailable")
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            ready = selector.select(timeout=budget())
            if not ready: raise RuntimeError("Listener probe read deadline exhausted")
            for key, _ in ready:
                budget()
                name = key.data
                try: chunk = os.read(key.fd, min(1024, limits[name] + 1 - len(buffers[name])))
                except BlockingIOError: continue
                if not chunk:
                    complete[name] = True; selector.unregister(key.fileobj)
                    continue
                buffers[name].extend(chunk)
                if len(buffers[name]) > limits[name]: raise RuntimeError("Listener probe " + name + " capture exceeds bound")
        process.wait(timeout=budget())
        budget()  # A late successful exit cannot bypass its phase/absolute deadline.
    except BaseException as error:
        primary = summary(error)
    finally:
        if process is not None:
            try:
                if process.poll() is None: process.kill()  # Exact assigned handle only; no group signal.
            except BaseException as error: cleanup.append({"phase": "listener-direct-kill", **summary(error)})
            try:
                try: allowance = remaining(3)
                except RuntimeError: allowance = 0
                process.wait(timeout=allowance)
            except BaseException as error: cleanup.append({"phase": "listener-direct-reap", **summary(error)})
            for name in buffers:
                stream = getattr(process, name, None)
                if stream is not None:
                    try: stream.close()
                    except BaseException as error: cleanup.append({"phase": "listener-" + name + "-close", **summary(error)})
        if selector is not None:
            try: selector.close()
            except BaseException as error: cleanup.append({"phase": "listener-selector-close", **summary(error)})
    exit_code = None
    if process is not None:
        try: exit_code = process.poll()
        except BaseException as error: cleanup.append({"phase": "listener-final-poll", **summary(error)})
    diagnostic = {"command": command, "executed": process is not None, "exitCode": exit_code,
                  "primary": primary, "cleanup": cleanup, "seconds": round(time.monotonic() - started, 3)}
    for name, prefix in (("stdout", 1024), ("stderr", 256)):
        raw = buffers[name]
        diagnostic[name] = {"bytesCaptured": len(raw), "complete": complete[name],
                            "captureLimitBytes": limits[name], "captureOverflow": len(raw) > limits[name],
                            "prefixBase64": base64.b64encode(raw[:prefix]).decode("ascii"),
                            "prefixTruncated": len(raw) > prefix, "capturedSHA256": hashlib.sha256(raw).hexdigest()}
    if primary is not None or cleanup or exit_code != 0:
        raise ListenerProbeError("Listener PID query failed", diagnostic)
    text = bytes(buffers["stdout"])
    lines = text.split(b"\n")
    if not text or lines.pop() != b"" or len(lines) > 256 or any(not line.isdigit() or len(line) > 10 or line.startswith(b"0") or not 1 < int(line) <= 2 ** 31 - 1 for line in lines):
        raise ListenerProbeError("Listener PID query returned malformed bounded output", diagnostic)
    try: budget()
    except BaseException as error:
        diagnostic["primary"] = summary(error)
        raise ListenerProbeError("Listener PID query completed after deadline", diagnostic) from None
    return {int(line) for line in lines}, diagnostic
