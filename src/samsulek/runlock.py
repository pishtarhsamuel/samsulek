"""Single-instance lock so two bot runs never trade at the same time."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from types import TracebackType

from samsulek.clock import Clock

LOCK_FILE = "run.lock"


class AlreadyRunningError(RuntimeError):
    pass


class RunLock:
    def __init__(self, state_dir: Path, clock: Clock, stale_after: timedelta = timedelta(hours=2)) -> None:
        self._path = state_dir / LOCK_FILE
        self._clock = clock
        self._stale_after = stale_after
        self.took_over_stale = False

    def _try_create(self) -> bool:
        try:
            fd = os.open(self._path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"pid": os.getpid(), "started": self._clock.now().isoformat()}, fh)
        return True

    def __enter__(self) -> RunLock:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if self._try_create():
            return self
        try:
            info = json.loads(self._path.read_text(encoding="utf-8"))
            started = datetime.fromisoformat(info["started"])
        except (OSError, ValueError, KeyError, TypeError):
            raise AlreadyRunningError(
                f"lock file {self._path} exists and is unreadable; if no bot is running, delete it"
            ) from None
        if self._clock.now() - started < self._stale_after:
            raise AlreadyRunningError(f"another run (pid {info.get('pid')}) started at {started.isoformat()}")
        self._path.unlink(missing_ok=True)
        if not self._try_create():
            raise AlreadyRunningError("lost the race for a stale lock")
        self.took_over_stale = True
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self._path.unlink(missing_ok=True)
