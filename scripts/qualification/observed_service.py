"""Read-only external service group observations; never authorize signals."""
from owned_groups import snapshot, command_hash, same

IDENTITY_CAP = 4096


def _row(value):
    if (not isinstance(value, dict)
            or any(type(value.get(key)) is not int for key in ("pid", "ppid", "pgid", "rssBytes"))
            or value["pid"] <= 1 or value["ppid"] < 0 or value["pgid"] <= 1 or value["rssBytes"] < 0
            or not isinstance(value.get("start"), str) or not 1 <= len(value["start"]) <= 128
            or not isinstance(value.get("state"), str) or not 1 <= len(value["state"]) <= 16):
        raise RuntimeError("Invalid service resource identity")
    return value


def _live(value):
    return "Z" not in value["state"]


def _digest(value):
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


class ObservedService:
    """An exact live leader anchors observed ancestry, without signal authority."""

    def __init__(self, pid):
        rows = snapshot()
        leader = rows.get(pid)
        if leader is None or not _live(_row(leader)) or leader["pgid"] != pid:
            raise RuntimeError("External service requires its exact live session leader")
        command = command_hash(pid)
        if not _digest(command):
            raise RuntimeError("External service command unavailable before admission")
        self.identity = {**leader, "commandSHA256": command}
        self.known = {pid: dict(self.identity)}
        self.admissions = []
        self.events = []
        self.departed = set()
        self.observe(rows)

    def _event(self, value):
        if len(self.events) >= IDENTITY_CAP:
            raise RuntimeError("Service event quota exceeded")
        self.events.append(value)

    def _retire(self, pid):
        if len(set(self.known) | self.departed | {pid}) > IDENTITY_CAP:
            raise RuntimeError("Service terminal identity quota exceeded")
        self.departed.add(pid)

    def _command(self, current, expected=None):
        value = command_hash(current["pid"])
        if _digest(value) and (expected is None or value == expected):
            return value
        fresh = snapshot().get(current["pid"])
        if fresh is None or (same(_row(fresh), current) and not _live(fresh)):
            self._retire(current["pid"])
            self._event({"phase": "confirmed-member-exit", "before": dict(current),
                         "after": None if fresh is None else dict(fresh),
                         "observedCommandSHA256": value})
            return None
        raise RuntimeError("Service command or identity change did not settle as an exit")

    def observe(self, rows=None):
        rows = snapshot() if rows is None else rows
        leader = rows.get(self.identity["pid"])
        if leader is None or not same(_row(leader), self.identity) or not _live(leader):
            self._retire(self.identity["pid"])
            raise RuntimeError("External service lost its exact live leader anchor")
        if self._command(leader, self.identity["commandSHA256"]) is None:
            raise RuntimeError("External service leader exited during observation")
        for pid in self.departed:
            current = rows.get(pid)
            if current is not None and _live(_row(current)):
                raise RuntimeError("A confirmed departed or terminal service member reappeared live")
        for pid, previous in self.known.items():
            current = rows.get(pid)
            if current is not None and not same(_row(current), previous):
                raise RuntimeError("Known service member identity changed")
        selected = {pid: dict(_row(row)) for pid, row in rows.items()
                    if row.get("pgid") == self.identity["pgid"]}
        if any(pid != row["pid"] for pid, row in selected.items()):
            raise RuntimeError("Service snapshot key differs from its identity")
        if len(set(self.known) | self.departed | set(selected)) > IDENTITY_CAP:
            raise RuntimeError("Service identity quota exceeded")
        for row in rows.values():
            if row.get("ppid") in selected and row.get("pgid") != self.identity["pgid"]:
                raise RuntimeError("Observed service descendant escaped its admitted group")
        proven = {self.identity["pid"]}
        visiting = set()

        def ancestry(pid):
            if pid in proven:
                return
            if pid in visiting:
                raise RuntimeError("Service ancestry cycle refused")
            current = selected[pid]
            previous = self.known.get(pid)
            if previous is not None:
                proven.add(pid)
                return
            visiting.add(pid)
            parent = selected.get(current["ppid"])
            if parent is None or not _live(parent):
                raise RuntimeError("New service member lacks current admitted ancestry")
            ancestry(parent["pid"])
            visiting.remove(pid)
            proven.add(pid)

        for pid in selected:
            ancestry(pid)
        pending = []
        live = []
        for pid, current in selected.items():
            previous = self.known.get(pid)
            if not _live(current):
                if pid not in self.departed:
                    self._retire(pid)
                    self._event({"phase": "member-terminal", "identity": dict(current)})
                command = previous.get("commandSHA256") if previous else None
            else:
                if previous is not None and previous.get("commandSHA256") is None:
                    raise RuntimeError("An unconfirmed terminal service member became live")
                command = self._command(current, previous.get("commandSHA256") if previous else None)
                if command is None:
                    if pid == self.identity["pid"]:
                        raise RuntimeError("External service leader exited during observation")
                    continue
                live.append(dict(current))
            if previous is None:
                pending.append({**current, "commandSHA256": command})
        if len(self.admissions) + len(pending) > IDENTITY_CAP:
            raise RuntimeError("Service admission quota exceeded")
        for entry in pending:
            self._event({"phase": "member-admitted", "pid": entry["pid"],
                         "start": entry["start"], "pgid": entry["pgid"],
                         "parentPID": entry["ppid"]})
            self.known[entry["pid"]] = dict(entry)
            self.admissions.append(dict(entry))
        for pid, previous in self.known.items():
            if pid not in selected and pid not in self.departed:
                self._event({"phase": "member-departed", "identity": dict(previous)})
                self._retire(pid)
        return live


def resource_union(*groups):
    """Count the greatest observed RSS once per exact PID/start/group identity."""
    result = {}
    for group in groups:
        for value in group:
            row = _row(value)
            previous = result.get(row["pid"])
            if previous is not None:
                if not same(previous, row):
                    raise RuntimeError("Resource union process identity changed")
                peak = max(previous["rssBytes"], row["rssBytes"])
                if (_live(row) and not _live(previous)) or row["rssBytes"] > previous["rssBytes"]:
                    result[row["pid"]] = {**row, "rssBytes": peak}
                else:
                    previous["rssBytes"] = peak
            else:
                result[row["pid"]] = dict(row)
    return list(result.values())
