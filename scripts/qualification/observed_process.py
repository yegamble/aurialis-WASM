"""Identity-bound external-host observations; never authorize external signals."""
from owned_groups import snapshot, command_hash, same


class ObservedProcess:
    def __init__(self, pid):
        current = snapshot().get(pid)
        command = command_hash(pid) if current else None
        if not current or "Z" in current["state"] or command is None:
            raise RuntimeError("External native host exited before admission")
        self.identity = {**current, "commandSHA256": command}

    def observe(self, rows):
        current = rows.get(self.identity["pid"])
        if not current or "Z" in current["state"]:
            raise RuntimeError("Admitted native host exited during qualification")
        if not same(current, self.identity) or command_hash(current["pid"]) != self.identity["commandSHA256"]:
            raise RuntimeError("Native host identity changed; observation refused")
        return current


def union_rows(owned_rows, external=None):
    result = {row["pid"]: row for row in owned_rows}
    if external is not None:
        old = result.get(external["pid"])
        if old is not None and not same(old, external):
            raise RuntimeError("Union process identity changed")
        result[external["pid"]] = external
    return list(result.values())


def known_group_survivors(before, after, group):
    """Only exact live identities admitted before the crash can prove survival."""
    admitted = {row["pid"]: row for row in before if row["pgid"] == group and "Z" not in row["state"]}
    return [dict(row) for row in after if row["pgid"] == group and "Z" not in row["state"] and row["pid"] in admitted and same(row, admitted[row["pid"]])]
