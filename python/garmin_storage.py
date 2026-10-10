"""Private storage and durable receipts; never store passwords or workout bodies."""
from __future__ import annotations

import contextlib
import os
from pathlib import Path
import sqlite3
import subprocess
import sys


class BridgeError(Exception):
    def __init__(self, code: str, workout_id: int | None = None):
        self.code = code
        self.workout_id = workout_id
        super().__init__(code)


def private_directory(configured: str | None, repo: Path) -> Path:
    if configured:
        path = Path(configured)
        if not path.is_absolute():
            raise BridgeError("CONFIG_INVALID")
    elif os.name == "nt":
        path = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "LocalWorkoutBuilder/garmin"
    elif sys.platform == "darwin":
        path = Path.home() / "Library/Application Support/LocalWorkoutBuilder/garmin"
    else:
        path = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "LocalWorkoutBuilder/garmin"
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise BridgeError("CONFIG_INVALID")
    path = path.resolve()
    if path == Path.home().resolve() or path in Path.home().resolve().parents or path == repo.resolve() or path in repo.resolve().parents or repo.resolve() in path.parents:
        raise BridgeError("CONFIG_INVALID")
    return path


def protect(path: Path) -> None:
    if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
        raise BridgeError("STORAGE_UNSAFE")
    if os.name != "nt":
        if path.stat().st_uid != os.getuid():
            raise BridgeError("STORAGE_UNSAFE")
        path.chmod(0o700 if path.is_dir() else 0o600)
        return
    # A fixed script with the path supplied as environment data, not shell text.
    script = """
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:LLM_GARMIN_PRIVATE_PATH -Force
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
# Read and write only the DACL. PowerShell Set-Acl can request audit/SACL
# privileges (SeSecurityPrivilege), which ordinary user sessions do not have.
$acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
if ($item.PSIsContainer) {
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
  $acl.PurgeAccessRules($rule.IdentityReference)
}
foreach ($identity in @($sid, $system)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$item.SetAccessControl($acl)
"""
    try:
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                       env={**os.environ, "LLM_GARMIN_PRIVATE_PATH": str(path)},
                       check=True, capture_output=True, timeout=10,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        raise BridgeError("STORAGE_UNSAFE") from None


def prepare_storage(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    protect(path)
    for name in ("garmin_tokens.json", "receipts.sqlite", "bridge.lock"):
        file = path / name
        if file.exists() or file.is_symlink():
            protect(file)


@contextlib.contextmanager
def exclusive_operation(directory: Path):
    """OS lock is released on process death; durable stage records remain."""
    lock_path = directory / "bridge.lock"
    if lock_path.is_symlink():
        raise BridgeError("STORAGE_UNSAFE")
    with lock_path.open("a+b") as lock:
        protect(lock_path)
        lock.seek(0)
        lock.write(b"0")
        lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise BridgeError("BUSY") from None
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


class Receipts:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS receipts (
            fingerprint TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
            account TEXT NOT NULL, stage TEXT NOT NULL, workout_id INTEGER)""")
        self.db.execute("CREATE TABLE IF NOT EXISTS operations (account TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(account, operation_id))")
        self.db.commit()

    def get(self, fingerprint: str):
        return self.db.execute("SELECT * FROM receipts WHERE fingerprint = ?", (fingerprint,)).fetchone()

    def check_operation(self, account: str, operation_id: str, fingerprint: str) -> None:
        row = self.db.execute("SELECT fingerprint FROM operations WHERE account = ? AND operation_id = ?", (account, operation_id)).fetchone()
        if row is not None and row[0] != fingerprint:
            raise BridgeError("OPERATION_CONFLICT")
        self.db.execute("INSERT OR IGNORE INTO operations VALUES (?, ?, ?)", (account, operation_id, fingerprint))
        self.db.commit()

    def save(self, fingerprint: str, operation_id: str, account: str, stage: str, workout_id: int | None) -> None:
        self.db.execute("INSERT INTO receipts VALUES (?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET stage=excluded.stage, workout_id=excluded.workout_id",
                        (fingerprint, operation_id, account, stage, workout_id))
        self.db.commit()

    def close(self):
        self.db.close()
