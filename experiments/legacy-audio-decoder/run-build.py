"""Run only the pinned private build with host and container resource controls."""
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
    "tmpfsBytes": 512 * 1024**2, "wallSeconds": 1800,
    "outputBytes": 2 * 1024**3, "minimumFreeBytes": 6 * 1024**3,
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
    if len(sys.argv) != 4:
        raise SystemExit("Usage: run-build.py SOURCE RECIPE NEW_PRIVATE_OUTPUT")
    source, recipe, output = (Path(value).resolve() for value in sys.argv[1:])
    name = "aurialis-decoder-build-" + secrets.token_hex(8)
    receipt = {"image": IMAGE, "container": name, "limits": LIMITS, "events": []}
    state = {}
    created = False
    attached = None
    timed_out = False
    resource_failure = None
    start = time.monotonic()

    def persist():
        (output / "build-status.json").write_text(json.dumps(receipt, indent=2) + "\n")

    def command(arguments, timeout=30, checked=False):
        result = subprocess.run(["docker", *arguments], capture_output=True, text=True, timeout=timeout, check=False)
        receipt["events"].append({"command": ["docker", *arguments], "exitCode": result.returncode,
                                  "stdout": result.stdout[-16384:], "stderr": result.stderr[-16384:]})
        persist()
        if checked and result.returncode:
            raise RuntimeError("Docker setup command failed; preserved in build-status.json.")
        return result

    def interrupted(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        if shutil.disk_usage(output).free < LIMITS["minimumFreeBytes"]:
            resource_failure = "disk-headroom-before-build"
            raise RuntimeError(resource_failure)
        command(["image", "inspect", IMAGE], checked=True)
        command([
            "create", "--name", name, "--pull=never", "--platform", "linux/amd64",
            "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--cpus", str(LIMITS["cpus"]),
            "--memory", str(LIMITS["memoryBytes"]), "--memory-swap", str(LIMITS["memoryBytes"]),
            "--pids-limit", str(LIMITS["pids"]), "--ulimit", "core=0",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=" + str(LIMITS["tmpfsBytes"]),
            "-e", "SOURCE_DATE_EPOCH=1786505071", "-e", "TZ=UTC", "-e", "LC_ALL=C",
            "-e", "EM_CACHE=/output/emcache",
            "-v", str(source) + ":/ffmpeg:ro", "-v", str(recipe) + ":/recipe:ro",
            "-v", str(output) + ":/output:rw", IMAGE, "bash", "/recipe/build-container.sh",
        ], checked=True)
        created = True
        print("Private build resource limits active; output: " + str(output), flush=True)
        with (output / "build.log").open("wb") as log:
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
                final = command(["inspect", name])
                if final.returncode == 0:
                    receipt["finalContainerState"] = json.loads(final.stdout)[0]["State"]
                    if receipt["finalContainerState"].get("OOMKilled"):
                        receipt["exitCode"] = 137
                removed = command(["rm", "--force", name])
                if removed.returncode:
                    raise RuntimeError("Owned build container cleanup failed.")
            except Exception as error:
                receipt["cleanupError"] = str(error)
                if receipt["exitCode"] == 0:
                    receipt["exitCode"] = 125
            persist()
    return receipt["exitCode"]


if __name__ == "__main__":
    raise SystemExit(main())
