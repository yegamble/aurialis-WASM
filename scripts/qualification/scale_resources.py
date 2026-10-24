"""QA-only resource arithmetic and fd-relative disk observations; no signal authority."""
import json
import os
from pathlib import Path
import stat

from observed_service import resource_union

MIB = 1024 ** 2
GIB = 1024 ** 3
MAX_IDENTITIES = 4096
MAX_DATA = 1_000_000_000
MAX_SCRATCH = 512 * MIB
MAX_LOGS = 8 * MIB
MAX_REPORTS = 8 * MIB
MAX_MISC = 31_631_476
MIN_FREE = 6 * GIB + 128 * MIB
TERMINAL_BYTES = 2 * MIB
TERMINAL_RESERVE = TERMINAL_BYTES + 64 * 1024


def _disk_entries(path):
    """Conservatively count allocated/logical entry bytes; never follow symlinks."""
    path = Path(path)
    if path.is_symlink():
        raise RuntimeError("Resource root must not be a symlink")
    if not path.exists():
        return 0
    if not path.is_dir() or path.resolve() != path:
        raise RuntimeError("Resource root must be its exact real directory")
    for current, names, files, descriptor in os.fwalk(path, follow_symlinks=False):
        own = os.fstat(descriptor)
        yield Path(current), max(own.st_size, own.st_blocks * 512)
        for name in names + files:
            try:
                entry = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(entry.st_mode):
                continue  # The visited directory itself is counted once above.
            if not (stat.S_ISREG(entry.st_mode) or stat.S_ISLNK(entry.st_mode)):
                raise RuntimeError("Special file refused in qualification budget")
            yield Path(current) / name, max(entry.st_size, entry.st_blocks * 512)


def directory_bytes(path):
    return sum(value for _, value in _disk_entries(path))


def disk_values(root, scratch):
    """Subcaps overlap scratch conservatively; aggregate counts every entry exactly once."""
    values = dict.fromkeys(("dataBytes", "scratchBytes", "logBytes", "reportBytes", "miscBytes"), 0)
    for path, size in _disk_entries(root):
        relative = path.relative_to(root)
        parts = relative.parts
        values["dataBytes"] += size
        if path == scratch or scratch in path.parents:
            values["scratchBytes"] += size
        if path.suffix == ".log":
            values["logBytes"] += size
        elif path.suffix in (".json", ".jsonl") or "ownership" in parts:
            values["reportBytes"] += size
        elif not parts or not (parts[0] == "sources" or parts[0].startswith("results-") or path == scratch or scratch in path.parents):
            values["miscBytes"] += size
    return values


def resource_values(owned, node_pid, native, service, parent):
    combined = resource_union(owned, [native] if native else [], service, [parent])
    nodes = [row["rssBytes"] for row in owned if row["pgid"] == node_pid]
    browsers = [row["rssBytes"] for row in owned if row["pgid"] != node_pid]
    return {"ownedRSS": sum(row["rssBytes"] for row in combined),
            "nativeRSS": native["rssBytes"] if native else 0,
            "nodeRSS": max(nodes or [0]), "browserGroupRSS": sum(browsers),
            "serviceGroupRSS": sum(row["rssBytes"] for row in resource_union(service)),
            "supervisorRSS": parent["rssBytes"], "processes": len(combined)}


def known_identity_count(owned, service, retired, native, parent):
    rows = list(owned.values()) + list(service.values()) + ([native] if native else []) + [parent]
    identities = {(row["pid"], row["start"], row["pgid"]) for row in rows}
    # A disappeared command candidate may be retired before its full row enters
    # known. Charge each such entry separately; never invent/deduplicate its identity.
    unknown_retired = set(retired) - set(service)
    return len(identities) + len(unknown_retired)


def admit_sample(values, *, available, elapsed, seconds, log_bytes=0, report_bytes=0, misc_bytes=0):
    """Every work ACK must follow this fresh complete sample, including reserved publication."""
    data, scratch = values["dataBytes"], values["scratchBytes"]
    limits = [(elapsed > seconds, "Target wall deadline"),
              (data + TERMINAL_RESERVE > MAX_DATA, "Combined scale budget including terminal publication"),
              (scratch > MAX_SCRATCH, "Profile/download scratch exceeds 512 MiB"),
              (log_bytes > MAX_LOGS, "Aggregate logs exceed 8 MiB"),
              (report_bytes + TERMINAL_RESERVE > MAX_REPORTS, "Reports/control and terminal publication exceed 8 MiB"),
              (misc_bytes > MAX_MISC, "External service state/misc exceeds admitted remainder"),
              (available < MIN_FREE + max(0, MAX_DATA - data), "Free reserve plus remaining combined demand"),
              (values["nodeRSS"] > GIB, "Node process exceeds sampled 1 GiB ceiling"),
              (values["nativeRSS"] > GIB, "Native process exceeds sampled 1 GiB ceiling"),
              (values["supervisorRSS"] > GIB, "Supervisor exceeds sampled 1 GiB ceiling"),
              (values["serviceGroupRSS"] > GIB, "External service group exceeds sampled 1 GiB ceiling"),
              (values["browserGroupRSS"] > 3 * GIB, "Collective browser group exceeds sampled 3 GiB ceiling"),
              (values["ownedRSS"] > 4 * GIB, "Complete union exceeds sampled 4 GiB ceiling"),
              (values["processes"] > 256, "Resource union process count exceeds 256"),
              (values["knownIdentities"] > MAX_IDENTITIES, "Combined historical identity count exceeds 4096")]
    for exceeded, reason in limits:
        if exceeded:
            raise RuntimeError(reason)


def bounded_json(value, limit=TERMINAL_BYTES):
    """A publication exceeding its reserved bytes fails; no truncated PASS is returned."""
    result = bytearray()
    for part in json.JSONEncoder(ensure_ascii=True, separators=(",", ":"), allow_nan=False).iterencode(value):
        encoded = part.encode("utf-8")
        if len(result) + len(encoded) + 1 > limit:
            raise RuntimeError("Qualification receipt exceeds its reserved publication bound")
        result.extend(encoded)
    result.extend(b"\n")
    return bytes(result)
