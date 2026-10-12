"""Single-instance lock so two bot processes never trade at the same time.

Uses a real operating-system lock on ``state/run.lock`` (``flock`` on Linux/macOS,
``msvcrt.locking`` on Windows) held for the whole run. The OS releases it
automatically if the process dies, so there is no "stale lock" guessing, no
renaming and no deleting. The file is never removed; it just records who holds
it, so a run that died mid-way can be reported (``took_over_stale``).
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import time
from pathlib import Path
from types import TracebackType
from typing import BinaryIO

from samsulek.clock import Clock

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

LOCK_FILE = "run.lock"
_WIN_LOCK_OFFSET = 1_000_000  # lock a byte far past the status text we write


class AlreadyRunningError(RuntimeError):
    pass


def _lock(fh: BinaryIO) -> bool:
    try:
        if sys.platform == "win32":
            fh.seek(_WIN_LOCK_OFFSET)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    return True


def _unlock(fh: BinaryIO) -> None:
    if sys.platform == "win32":
        fh.seek(_WIN_LOCK_OFFSET)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


class RunLock:
    def __init__(self, state_dir: Path, clock: Clock, wait_seconds: float = 0.0) -> None:
        self._path = state_dir / LOCK_FILE
        self._clock = clock
        self._wait = wait_seconds
        self._fh: BinaryIO | None = None
        self.took_over_stale = False

    def _write_status(self, status: str) -> None:
        if self._fh is None:
            raise RuntimeError("run lock is not held")
        self._fh.seek(0)
        self._fh.truncate()
        self._fh.write(
            json.dumps({"pid": os.getpid(), "status": status, "at": self._clock.now().isoformat()}).encode(
                "utf-8"
            )
        )
        self._fh.flush()
        os.fsync(self._fh.fileno())

    def __enter__(self) -> RunLock:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self._wait
        while True:
            fd = os.open(self._path, os.O_RDWR | os.O_CREAT, 0o600)
            fh = os.fdopen(fd, "r+b")
            if _lock(fh):
                self._fh = fh
                break
            fh.close()
            if time.monotonic() >= deadline:
                raise AlreadyRunningError(f"another run holds {self._path}")
            time.sleep(0.25)
        try:
            fh.seek(0)
            previous = json.loads(fh.read(4096).decode("utf-8") or "{}")
            self.took_over_stale = isinstance(previous, dict) and previous.get("status") == "running"
        except (ValueError, UnicodeDecodeError):
            self.took_over_stale = True  # unreadable status: the previous holder didn't finish cleanly
        self._write_status("running")
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        # Never raises: a problem releasing the lock must not turn a finished run into an error.
        fh, self._fh = self._fh, None
        if fh is None:
            return
        with contextlib.suppress(OSError):
            self._fh = fh
            self._write_status("finished")
            self._fh = None
        with contextlib.suppress(OSError):
            _unlock(fh)
        with contextlib.suppress(OSError):
            fh.close()
