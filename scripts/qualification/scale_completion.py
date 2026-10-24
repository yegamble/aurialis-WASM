"""Closed successful-work receipts for parent-owned profile cleanup; no deletion here."""
import hashlib
import json
import os
from pathlib import Path
import stat

from scale_resources import MAX_REPORTS

DELIVERY = "three real 180-second 48 kHz tracks use bounded durable delivery beyond the old aggregate cache"
REFUSAL = "the real 180-second source is refused by the 512 MiB Album policy before a worker starts"


def read_json(path, limit=MAX_REPORTS):
    path = Path(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or not 1 <= info.st_size <= limit:
            raise RuntimeError("Closed result receipt file is invalid or exceeds its bound")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise RuntimeError("Closed result receipt grew beyond its bound")
    finally:
        os.close(descriptor)
    value = json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite receipt")))
    if not isinstance(value, dict):
        raise RuntimeError("Closed result receipt must be an object")
    return value, {"path": str(path), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def validate_launcher(value, mode, project):
    if (set(value) != {"mode", "project", "primary", "cleanup", "childExit", "audioProcessing"}
            or value["mode"] != mode or value["project"] != project
            or value["primary"] is not None or value["cleanup"] != []
            or value["audioProcessing"] is not (mode == "scale")
            or value["childExit"] != ({"code": 0, "signal": None} if mode == "scale" else None)):
        raise RuntimeError("Launcher did not prove clean completed work")


def validate_scale_result(value, project):
    if project not in ("album-native-scale", "album-browser-scale"):
        raise RuntimeError("Unexpected scale project")
    expected = {DELIVERY} if project == "album-native-scale" else {DELIVERY, REFUSAL}
    stats = value.get("stats", {})
    if not isinstance(stats, dict) or any(type(stats.get(key)) is not int for key in ("expected", "unexpected", "skipped", "flaky")):
        raise RuntimeError("Scale result counters must be exact integers")
    if (value.get("errors") != [] or any(stats.get(key) != count for key, count in
            (("expected", len(expected)), ("unexpected", 0), ("skipped", 0), ("flaky", 0)))):
        raise RuntimeError("Scale result has errors, missing work, retries or skipped/flaky cases")
    found, visited = [], 0

    def visit(suites):
        nonlocal visited
        if not isinstance(suites, list):
            raise RuntimeError("Invalid scale suites")
        for suite in suites:
            visited += 1
            if visited > 16 or not isinstance(suite, dict):
                raise RuntimeError("Scale suite metadata exceeds its shape bound")
            for spec in suite.get("specs", []):
                tests = spec.get("tests")
                if spec.get("ok") is not True or not isinstance(tests, list) or len(tests) != 1:
                    raise RuntimeError("Scale case is incomplete or repeated")
                case = tests[0]
                results = case.get("results")
                if (case.get("projectName") != project or case.get("projectId") != project
                        or case.get("expectedStatus") != "passed" or case.get("status") != "expected"
                        or not isinstance(results, list) or len(results) != 1
                        or results[0].get("status") != "passed" or results[0].get("retry") != 0
                        or results[0].get("errors") != []):
                    raise RuntimeError("Scale case is not one fresh successful execution")
                found.append(spec.get("title"))
                if len(found) > len(expected):
                    raise RuntimeError("Unexpected extra scale cases")
            visit(suite.get("suites", []))
    visit(value.get("suites"))
    if len(found) != len(expected) or set(found) != expected:
        raise RuntimeError("Required complete scale cases are missing or duplicated")
    return sorted(found)
