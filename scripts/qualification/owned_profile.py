"""QA-only fresh diagnostic directory ownership. Never touches existing profiles."""
import os
from pathlib import Path
import re
import shutil
import stat

from qualification_runtime import qualification_runtime

SAFE_RMTREE = shutil.rmtree.avoids_symlink_attacks
SDK_VERSION = "1.64.1"


def identity(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700 or path.resolve() != path:
        raise RuntimeError("Owned diagnostic directory path, mode or owner changed")
    return {"path": str(path), "dev": str(info.st_dev), "ino": str(info.st_ino)}


class OwnedProfile:
    """The parent creates fresh directories; only its verified-success path may remove them."""
    def __init__(self, scratch, token):
        self.scratch = Path(scratch)
        if not self.scratch.is_absolute() or not re.fullmatch(r"[a-f0-9]{64}", token):
            raise RuntimeError("Invalid diagnostic profile owner")
        self.scratch_identity = identity(self.scratch)
        self.token = token
        self.created = {}
        self.removed = []
        self.runtime = None

    def create(self):
        self.runtime = qualification_runtime()
        if self.created:
            raise RuntimeError("Profile directories can be created only once")
        for key, name in [("userData", "profile"), ("artifacts", "browser-artifacts")]:
            path = self.scratch / name
            path.mkdir(mode=0o700)
            self.created[key] = identity(path)
        return self.descriptor()

    def descriptor(self):
        self.validate()
        return {"token": self.token, "sdkVersion": SDK_VERSION, **{key: dict(value) for key, value in self.created.items()}}

    def validate(self):
        if identity(self.scratch) != self.scratch_identity or set(self.created) != {"userData", "artifacts"}:
            raise RuntimeError("Diagnostic profile ownership is incomplete or changed")
        for record in self.created.values():
            if identity(Path(record["path"])) != record:
                raise RuntimeError("Diagnostic profile directory identity changed")

    def state(self):
        values = []
        for key, record in self.created.items():
            path = Path(record["path"])
            try:
                info = path.lstat()
                current = {"dev": str(info.st_dev), "ino": str(info.st_ino), "symlink": stat.S_ISLNK(info.st_mode)}
            except FileNotFoundError:
                current = None
            except OSError as error:
                current = {"unobserved": type(error).__name__, "reason": str(error)[:1024]}
            values.append({"kind": key, "expected": dict(record), "current": current, "absent": current is None})
        return {"diagnosticOnly": True, "paths": values, "removed": list(self.removed)}

    def cleanup_success(self):
        # Caller must first persist its validated-success/settled-groups receipt.
        # All legitimate writers are settled; the exact private scratch owner is retained.
        self.validate()
        if not SAFE_RMTREE:
            raise RuntimeError("Identity-bound profile cleanup requires symlink-safe rmtree")
        parent = os.open(self.scratch, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            held = os.fstat(parent)
            if str(held.st_dev) != self.scratch_identity["dev"] or str(held.st_ino) != self.scratch_identity["ino"]:
                raise RuntimeError("Diagnostic scratch identity changed before cleanup")
            for record in self.created.values():
                path = Path(record["path"])
                if identity(path) != record:
                    raise RuntimeError("Diagnostic profile identity changed before cleanup")
                shutil.rmtree(path.name, dir_fd=parent)
                try:
                    path.lstat()
                except FileNotFoundError:
                    self.removed.append(str(path))
                else:
                    raise RuntimeError("Diagnostic profile path remains after cleanup")
        finally:
            os.close(parent)
        return self.state()
