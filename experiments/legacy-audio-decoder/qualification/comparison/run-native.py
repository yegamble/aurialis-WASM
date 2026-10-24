"""Run only frozen generated fixtures through the exact native9 oracle in offline Docker."""
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import time

IMAGE = "emscripten/emsdk@sha256:badbe38bedc8f4ff88a5a24672a2d59606015ba9a3bbe69801ad2fbdf75ab500"
LIMITS = {
    "cpus": 2, "memoryBytes": 4 * 1024**3, "pids": 256,
    "tmpfsBytes": 512 * 1024**2, "wallSeconds": 900,
    "outputBytes": 192 * 1024**2, "minimumFreeBytes": 6 * 1024**3,
    "beforeBuildMinimumBytes": 6 * 1024**3 + 192 * 1024**2,
}


def result_code(state, timed_out, resource_failure, attach_code):
    """Do not convert an observed container OOM or watchdog failure to success."""
    if state.get("OOMKilled"):
        return 137
    if timed_out:
        return 124
    if resource_failure:
        return 125
    return int(state.get("ExitCode", attach_code or 1))


def main():
    if len(sys.argv) != 5:
        raise SystemExit("Usage: run-native.py FIXTURES NEW_OUTPUT MATRIX_SHA256 ORACLE")
    import hashlib, re
    raw_fixtures, raw_output, matrix_pin, raw_oracle = sys.argv[1:5]
    # Reject supplied symlinks before resolving to avoid hiding them.
    if any(Path(p).is_symlink() for p in (raw_fixtures, raw_output, raw_oracle, __file__)):
        raise SystemExit("No symlink mounts or runner source.")
    fixtures, output, oracle = (Path(p).resolve() for p in (raw_fixtures, raw_output, raw_oracle))
    recipe = fixtures / "recipe"
    if output.exists():
        raise SystemExit("Fresh native comparison output required.")
    if any((fixtures / name).is_symlink() for name in ("inputs", "references", "recipe", "matrix.json")):
        raise SystemExit("No symlink stage components.")
    manifest = fixtures / "matrix.json"
    if not manifest.is_file() or not 0 < manifest.stat().st_size <= 256 * 1024 or hashlib.sha256(manifest.read_bytes()).hexdigest() != matrix_pin:
        raise SystemExit("Frozen matrix pin mismatch.")
    matrix = json.loads(manifest.read_text())
    if oracle.stat().st_size != matrix["native"]["bytes"] or hashlib.sha256(oracle.read_bytes()).hexdigest() != matrix["native"]["sha256"]:
        raise SystemExit("Exact native oracle pin mismatch.")
    if len(matrix["candidates"]) != 24 or len({row["id"] for row in matrix["candidates"]}) != 24:
        raise SystemExit("Wrong unique finite fixture matrix.")
    for row in matrix["candidates"]:
        if not re.fullmatch(r"[a-z0-9-]{1,64}", row["id"]) or not re.fullmatch(r"inputs/" + row["id"] + r"\.(mp3|flac|ogg|aac|m4a)", row["file"]):
            raise SystemExit("Closed candidate path required.")
        candidate = fixtures / row["file"]
        if candidate.is_symlink() or not candidate.is_file() or candidate.stat().st_size != row["bytes"] or hashlib.sha256(candidate.read_bytes()).hexdigest() != row["sha256"]:
            raise SystemExit("Fixture changed before container admission.")
        reference = row["expected"]["losslessSource"]
        if reference:
            if reference["file"] != "references/" + row["id"] + ".f32le":
                raise SystemExit("Closed reference path required.")
            path = fixtures / reference["file"]
            if path.is_symlink() or not path.is_file() or path.stat().st_size != reference["bytes"] or hashlib.sha256(path.read_bytes()).hexdigest() != reference["sha256"]:
                raise SystemExit("Lossless source reference changed.")
    actual_recipe = set(p.name for p in recipe.iterdir())
    if actual_recipe != set(r["file"] for r in matrix["recipe"]) or len(actual_recipe) > 16:
        raise SystemExit("Closed recipe inventory required.")
    for entry in matrix["recipe"]:
        if not re.fullmatch(r"[a-z0-9-]+\.(py|mjs)", entry["file"]):
            raise SystemExit("Closed recipe path required.")
        path = recipe / entry["file"]
        if path.is_symlink() or not path.is_file() or path.stat().st_size != entry["bytes"] or hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise SystemExit("Frozen runner recipe changed.")
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != next(r["sha256"] for r in matrix["recipe"] if r["file"] == "run-native.py"):
        raise SystemExit("Host must execute the reviewed frozen runner bytes.")
    if matrix["retainedBudget"]["nativePartitionBytes"] != LIMITS["outputBytes"] or matrix["retainedBudget"]["baselineBytes"] + matrix["retainedBudget"]["nativePartitionBytes"] + matrix["retainedBudget"]["wasmPartitionBytes"] + matrix["retainedBudget"]["supervisorAndReceiptBytes"] > 512 * 1024**2:
        raise SystemExit("Shared retained fixture/native/WASM budget exceeded.")
    output.mkdir(mode=0o700)
    name = "aurialis-native-fixtures-" + secrets.token_hex(8)
    receipt = {"image": IMAGE, "container": name, "limits": LIMITS, "events": [], "matrixSHA256": matrix_pin, "oracleSHA256": matrix["native"]["sha256"], "retainedBudget": matrix["retainedBudget"]}
    state = {}
    created = False
    attached = None
    timed_out = False
    resource_failure = None
    start = time.monotonic()

    def persist():
        (output / "run-status.json").write_text(json.dumps(receipt, indent=2) + "\n")

    def command(arguments, timeout=30, checked=False):
        result = subprocess.run(["docker", *arguments], capture_output=True, text=True, timeout=timeout, check=False)
        receipt["events"].append({"command": ["docker", *arguments], "exitCode": result.returncode,
                                  "stdout": result.stdout[-16384:], "stderr": result.stderr[-16384:]})
        persist()
        if checked and result.returncode:
            raise RuntimeError("Docker setup command failed; preserved in run-status.json.")
        return result

    def interrupted(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        if shutil.disk_usage(output).free < LIMITS["beforeBuildMinimumBytes"]:
            resource_failure = "disk-headroom-before-build"
            raise RuntimeError(resource_failure)
        command(["image", "inspect", IMAGE], checked=True)
        command([
            "create", "--name", name, "--pull=never", "--platform", "linux/amd64",
            "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--cpus", str(LIMITS["cpus"]),
            "--memory", str(LIMITS["memoryBytes"]), "--memory-swap", str(LIMITS["memoryBytes"]),
            "--pids-limit", str(LIMITS["pids"]), "--ulimit", "core=0",
            "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=" + str(LIMITS["tmpfsBytes"]),
            "-e", "SOURCE_DATE_EPOCH=1786505071", "-e", "TZ=UTC", "-e", "LC_ALL=C",
            "-v", str(fixtures) + ":/fixtures:ro", "-v", str(recipe) + ":/recipe:ro",
            "-v", str(oracle) + ":/oracle/native-oracle:ro",
            "-v", str(output) + ":/output:rw",
            IMAGE, "python3", "/recipe/native-batch.py",
        ], checked=True)
        created = True
        preflight = command(["inspect", name], checked=True)
        host = json.loads(preflight.stdout)[0]["HostConfig"]
        if host["Memory"] != LIMITS["memoryBytes"] or host["MemorySwap"] != LIMITS["memoryBytes"] or host["NanoCpus"] != 2000000000 or host["PidsLimit"] != 256 or not host["ReadonlyRootfs"] or host["NetworkMode"] != "none" or "ALL" not in host["CapDrop"] or "no-new-privileges" not in host["SecurityOpt"]:
            raise RuntimeError("Actual container hardening did not match reviewed limits.")
        print("Private native fixture limits active; output: " + str(output), flush=True)
        with (output / "native-batch.log").open("wb") as log:
            attached = subprocess.Popen(["docker", "start", "--attach", name], stdout=log, stderr=subprocess.STDOUT)
            while attached.poll() is None:
                if time.monotonic() - start > LIMITS["wallSeconds"]:
                    timed_out = True
                    break
                if shutil.disk_usage(output).free < LIMITS["minimumFreeBytes"]:
                    resource_failure = "disk-headroom-during-build"
                    break
                retained = 0
                for path in output.rglob("*"):
                    try:
                        if path.is_file():
                            retained += path.stat().st_size
                    except FileNotFoundError:
                        # Compiler temporary files may disappear between stats.
                        pass
                if retained > LIMITS["outputBytes"]:
                    resource_failure = "private-output-size"
                    break
                time.sleep(1)
            if timed_out or resource_failure:
                command(["kill", "--signal", "KILL", name], timeout=20)
            try:
                attached.wait(timeout=30)
            except subprocess.TimeoutExpired:
                attached.kill()
                attached.wait(timeout=10)
                resource_failure = resource_failure or "docker-attach-did-not-settle"
        inspected = command(["inspect", name], checked=True)
        details = json.loads(inspected.stdout)[0]
        (output / "container-inspect.json").write_text(json.dumps(details, indent=2) + "\n")
        state = details["State"]
        receipt["containerState"] = state
        receipt["elapsedSeconds"] = round(time.monotonic() - start, 3)
        receipt["timedOut"] = timed_out
        receipt["resourceFailure"] = resource_failure
        receipt["exitCode"] = result_code(state, timed_out, resource_failure, attached.returncode)
        persist()
    except (Exception, KeyboardInterrupt) as error:
        receipt["driverError"] = type(error).__name__ + ": " + str(error)
        receipt["timedOut"] = timed_out
        receipt["resourceFailure"] = resource_failure
        receipt["exitCode"] = 130 if isinstance(error, KeyboardInterrupt) else result_code(state, timed_out, resource_failure, 1)
        persist()
    finally:
        if created:
            # Remove only the random name created by this invocation. Capture
            # final state first so an OOM, watchdog kill or interruption survives.
            try:
                before_cleanup = command(["inspect", name])
                if before_cleanup.returncode == 0:
                    receipt["beforeCleanupContainerState"] = json.loads(before_cleanup.stdout)[0]["State"]
                    if receipt["beforeCleanupContainerState"].get("Running"):
                        command(["kill", "--signal", "KILL", name], timeout=20)
                if attached is not None:
                    attached.wait(timeout=10)
                final = command(["inspect", name])
                if final.returncode == 0:
                    receipt["finalContainerState"] = json.loads(final.stdout)[0]["State"]
                    if receipt["finalContainerState"].get("OOMKilled"):
                        receipt["exitCode"] = 137
                removed = command(["rm", "--force", name])
                if removed.returncode:
                    raise RuntimeError("Owned native fixture container cleanup failed.")
            except Exception as error:
                receipt["cleanupError"] = str(error)
                if receipt["exitCode"] == 0:
                    receipt["exitCode"] = 125
            persist()
    return receipt["exitCode"]


if __name__ == "__main__":
    raise SystemExit(main())
