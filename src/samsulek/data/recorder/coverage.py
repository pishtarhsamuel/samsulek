"""Coverage bookkeeping: when was the recorder watching, and when was a source down?

Written to the journal stream ``coverage``:
- ``start`` / ``stop`` events for each run;
- ``gap`` records, each with ``start``/``end`` (UTC) and a ``kind``:
  ``not_running`` - from the last heartbeat before this run to this run's start
  (conservative: the downtime really began somewhere after that heartbeat);
  ``source_down`` - a source kept failing from its first failure to its next success
  (or to ``stop``, flagged ``open_at_stop``).
Research must treat anything inside a gap as "not observed", never as "nothing happened".
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

from samsulek.clock import Clock
from samsulek.data.recorder.journal import Journal
from samsulek.fsutil import atomic_write_text

STREAM = "coverage"
STATE_FILE = "heartbeat.json"


class Coverage:
    def __init__(
        self,
        journal: Journal,
        root: Path,
        clock: Clock,
        recorder: str,
        beat_every: timedelta = timedelta(seconds=60),
    ) -> None:
        self._journal = journal
        self._state = root / f"{recorder}_{STATE_FILE}"
        self._clock = clock
        self._recorder = recorder
        self._beat_every = beat_every
        self._last_beat: datetime | None = None
        self._failing: dict[str, tuple[datetime, str]] = {}  # source -> (since, first error)

    def start(self) -> None:
        now = self._clock.now()
        previous = self._read_last_beat()
        if previous is not None and previous < now:
            self._gap("not_running", previous, now)
        self._journal.append(STREAM, {"event": "start", "recorder": self._recorder, "pid": os.getpid()})
        self._write_beat(now)

    def beat(self) -> None:
        now = self._clock.now()
        if self._last_beat is None or now - self._last_beat >= self._beat_every:
            self._write_beat(now)
            self._journal.sync()

    def source_failed(self, source: str, error: str) -> None:
        if source not in self._failing:
            self._failing[source] = (self._clock.now(), error)
            self._journal.append(STREAM, {"event": "source_down", "source": source, "error": error[:500]})

    def source_ok(self, source: str) -> None:
        failing = self._failing.pop(source, None)
        if failing is not None:
            self._gap("source_down", failing[0], self._clock.now(), source=source, error=failing[1][:500])

    def stop(self) -> None:
        now = self._clock.now()
        for source, (since, error) in sorted(self._failing.items()):
            self._gap("source_down", since, now, source=source, error=error[:500], open_at_stop=True)
        self._failing.clear()
        self._journal.append(STREAM, {"event": "stop", "recorder": self._recorder})
        self._write_beat(now)
        self._journal.sync()

    @property
    def failing_sources(self) -> list[str]:
        return sorted(self._failing)

    def _gap(self, kind: str, start: datetime, end: datetime, **extra: object) -> None:
        self._journal.append(
            STREAM,
            {
                "event": "gap",
                "kind": kind,
                "recorder": self._recorder,
                "start": start.astimezone(UTC).isoformat(),
                "end": end.astimezone(UTC).isoformat(),
                "seconds": round((end - start).total_seconds(), 3),
                **extra,
            },
        )

    def _write_beat(self, now: datetime) -> None:
        atomic_write_text(self._state, json.dumps({"last_beat": now.astimezone(UTC).isoformat()}))
        self._last_beat = now

    def _read_last_beat(self) -> datetime | None:
        """The previous run's last heartbeat. Unreadable -> None, and the journal says so."""
        try:
            raw = self._state.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            self._journal.append(STREAM, {"event": "heartbeat_unreadable", "error": type(exc).__name__})
            return None
        try:
            value = datetime.fromisoformat(json.loads(raw)["last_beat"])
            if value.tzinfo is None:
                raise ValueError("naive timestamp")
            return value
        except Exception as exc:  # damaged file: say so; the gap length is then unknown
            self._journal.append(STREAM, {"event": "heartbeat_unreadable", "error": type(exc).__name__})
            return None
