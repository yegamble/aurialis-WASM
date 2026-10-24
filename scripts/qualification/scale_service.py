"""Exact QA-only static-service command and writable routes; observer never signals it."""
import hashlib
from pathlib import Path
import shlex
import subprocess

from scale_completion import read_json


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
    command = subprocess.check_output(["/bin/ps", "-p", str(observer.identity["pid"]), "-o", "command="], text=True, timeout=3).strip()
    if shlex.split(command) != contract["argv"]:
        raise RuntimeError("External service is not the exact pinned Node/Wrangler/config command")
    live = observer.observe(rows)
    port = contract["url"].rsplit(":", 1)[1]
    text = subprocess.check_output(["/usr/sbin/lsof", "-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-Fp"], text=True, timeout=3)
    lines = text.splitlines()
    if not lines or any(not line.startswith("p") or not line[1:].isdigit() for line in lines):
        raise RuntimeError("Exact external service listener unavailable")
    pids = {int(line[1:]) for line in lines}
    proved = {row["pid"]: row for row in live}
    if not pids or not pids <= set(proved):
        raise RuntimeError("External listener does not belong to the admitted service group")
    return {"leader": dict(observer.identity), "listeners": [dict(proved[pid]) for pid in sorted(pids)],
            "config": config_receipt, "command": contract["argv"], "url": contract["url"],
            "cliSHA256": contract["cliSHA256"], "observationOnly": True}
