"""Single-instance lock so two bot processes never trade at the same time.

- The lock file holds a random token; we only ever delete a lock that holds OUR token.
- A lock older than ``stale_after`` (by its recorded start time, or by file
  modification time if it's unreadable) is taken over: it is first renamed
  away atomically, so two processes can't both take it over.
- ``wait_seconds`` lets the kill switch wait briefly for a running cycle to finish.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import TracebackType

from samsulek.clock import Clock

LOCK_FILE = "run.lock"


class AlreadyRunningError(RuntimeError):
    pass


class RunLock:
    def __init__(
        self,
        state_dir: Path,
        clock: Clock,
        stale_after: timedelta = timedelta(hours=2),
        wait_seconds: float = 0.0,
    ) -> None:
        self._path = state_dir / LOCK_FILE
        self._clock = clock
        self._stale_after = stale_after
        self._wait = wait_seconds
        self._token = secrets.token_hex(16)
        self.took_over_stale = False

    def _try_create(self) -> bool:
        try:
            fd = os.open(self._path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(
                {"pid": os.getpid(), "started": self._clock.now().isoformat(), "token": self._token}, fh
            )
            fh.flush()
            os.fsync(fh.fileno())
        return True

    def _read_existing(self) -> tuple[dict[str, object] | None, datetime]:
        """Return (lock contents or None if unreadable, when the lock was taken)."""
        try:
            info = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(info, dict):
                raise ValueError("not an object")
            return info, datetime.fromisoformat(str(info["started"]))
        except (ValueError, KeyError, TypeError):
            mtime = datetime.fromtimestamp(self._path.stat().st_mtime, tz=UTC)
            return None, mtime

    def _attempt(self) -> bool:
        if self._try_create():
            return True
        try:
            info, started = self._read_existing()
        except FileNotFoundError:
            return self._try_create()
        if self._clock.now() - started < self._stale_after:
            return False
        # Stale: move it aside atomically, check we moved the lock we judged, then take it.
        aside = self._path.with_name(f"{LOCK_FILE}.stale-{self._token}")
        try:
            os.replace(self._path, aside)
        except FileNotFoundError:
            return self._try_create()
        try:
            moved = json.loads(aside.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            moved = None
        if info is not None and (not isinstance(moved, dict) or moved.get("token") != info.get("token")):
            # Someone replaced the lock between our read and our rename: give it back.
            if not self._path.exists():
                os.replace(aside, self._path)
            return False
        aside.unlink(missing_ok=True)
        if self._try_create():
            self.took_over_stale = True
            return True
        return False

    def __enter__(self) -> RunLock:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self._wait
        while True:
            if self._attempt():
                return self
            if time.monotonic() >= deadline:
                raise AlreadyRunningError(f"another run holds {self._path}")
            time.sleep(0.25)

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        try:
            info = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(info, dict) and info.get("token") == self._token:
            self._path.unlink(missing_ok=True)
