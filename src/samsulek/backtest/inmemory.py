"""In-memory stand-ins for the bot's disk-backed parts, for backtests.

``MemoryRiskStateStore``, ``MemoryLedger`` and ``MemoryDecisionLog`` inherit ALL logic
from ``RiskStateStore``, ``Ledger`` and ``DecisionLog`` and replace only the file hooks, so
a backtest halts, resets and records exactly as the bot does. No file or folder is ever
created: the parent constructors that would create a folder are not called, and the path
they would use is ``_NOWHERE``, a name under THIS module's own file. A regular file can
hold no folder, so on every OS any accidental write there raises ``OSError`` (opening a
file under it, or ``mkdir(parents=True)``, which meets the existing file and stops with
``FileExistsError`` or ``NotADirectoryError``) instead of creating anything. (The OS
null device would not do: on Windows ``os.devnull`` is the relative name ``nul``.)
``in_memory = True`` marks the parts ``run_unlocked_cycle`` accepts. ``RecordingAlerter``
keeps alerts like ``ConsoleAlerter`` (redacted, logged as ``alert`` records) without
console output.

Facts relied on (tests/test_inmemory_parts.py compares each class with its disk twin):
- ``RiskStateStore`` touches files only in ``_read_json``, ``_write_json`` and
  ``_history``. The memory store keeps the exact text the disk store would write
  (``json.dumps(data, indent=2, sort_keys=True)``) and parses it back with the disk
  store's rules: invalid JSON or a non-object raises ``StateCorruptError``.
- ``Ledger`` touches files only in ``_load`` and ``save``. ``save`` still runs the
  usability check, so a broken ledger fails exactly as on disk.
- ``DecisionLog.write`` serialises every record with ``json.dumps(ensure_ascii=True)``;
  the memory log does the same, so a value the disk log cannot write fails here too
  instead of slipping through.
- An alert that cannot be recorded raises (``ConsoleAlerter`` swallows the error and
  logs it to the console). A backtest has no console to read, so a lost alert would be
  silent; raising voids the run instead.
"""

from __future__ import annotations

import gzip
import json
from datetime import date, datetime
from pathlib import Path
from typing import Any, ClassVar, Final

from samsulek.clock import Clock
from samsulek.credentials import redact
from samsulek.logging_setup import DecisionLog, to_jsonable
from samsulek.portfolio.ledger import Ledger
from samsulek.risk.state import RiskStateStore, StateCorruptError

_NOWHERE: Final = Path(__file__).resolve() / "in-memory-never-written"  # parent: a regular file


class MemoryRiskStateStore(RiskStateStore):
    """The risk store's halt, kill, day and peak records, kept in a dict of file texts."""

    in_memory: ClassVar[bool] = True
    files: dict[str, str]  # file name -> json.dumps(data, indent=2, sort_keys=True)
    history: list[dict[str, str]]

    def __init__(self) -> None:  # no RiskStateStore.__init__: it creates the bot's folder
        self.dir = _NOWHERE
        self.files = {}
        self.history = []

    def _read_json(self, name: str) -> dict[str, Any] | None:
        text = self.files.get(name)
        if text is None:
            return None
        try:
            data = json.loads(text)
        except ValueError as exc:
            raise StateCorruptError(f"in-memory {name} is not valid JSON") from exc
        if not isinstance(data, dict):
            raise StateCorruptError(f"in-memory {name} must contain a JSON object")
        return data

    def _write_json(self, name: str, data: dict[str, Any]) -> None:
        self.files[name] = json.dumps(data, indent=2, sort_keys=True)

    def _history(self, event: str, ts: datetime, **fields: str) -> None:
        self.history.append(
            {"ts": ts.isoformat(), "event": event, **{k: redact(v) for k, v in fields.items()}}
        )


class MemoryLedger(Ledger):
    """The ledger with nothing read at start and nothing written on save."""

    in_memory: ClassVar[bool] = True

    def __init__(self) -> None:
        super().__init__(_NOWHERE)  # Ledger's own setup; the _load below reads nothing

    def _load(self) -> None:
        return None

    def save(self) -> None:
        self._check_usable()


class MemoryDecisionLog(DecisionLog):
    """The decision log as a list: this cycle's records always, every record if ``keep_all``."""

    in_memory: ClassVar[bool] = True
    all_records: list[dict[str, Any]]  # keep_all only: every record, JSON round-tripped

    def __init__(self, clock: Clock, *, keep_all: bool) -> None:  # no DecisionLog.__init__: it makes a folder
        self._dir = _NOWHERE
        self._clock = clock
        self._keep_all = keep_all
        self._cycle: list[dict[str, Any]] = []
        self._days: list[date] = []  # keep_all only: the clock's date at each write (the disk file's day)
        self.all_records = []

    def write(self, kind: str, **fields: Any) -> dict[str, Any]:
        now = self._clock.now()
        record: dict[str, Any] = {"ts": now.isoformat(), "kind": kind}
        record.update(to_jsonable(fields))
        line = json.dumps(record, ensure_ascii=True, sort_keys=False)  # fails where the disk log fails
        self._cycle.append(record)
        if self._keep_all:
            self.all_records.append(json.loads(line))
            self._days.append(now.date())
        return record

    def drain_cycle(self) -> list[dict[str, Any]]:
        """This cycle's records, oldest first; the buffer starts empty again."""
        records, self._cycle = self._cycle, []
        return records

    def read_day(self, day: date) -> list[dict[str, Any]]:
        """Like the disk log: fresh copies of the records written on ``day`` (the clock's own date).

        The day is the one the disk log would have picked its file by, kept at write time,
        so a field that overwrites ``ts`` cannot move a record to another day.
        """
        if not self._keep_all:
            raise RuntimeError("this in-memory decision log keeps only the current cycle (keep_all=False)")
        return [
            json.loads(json.dumps(r, ensure_ascii=True))
            for r, written in zip(self.all_records, self._days, strict=True)
            if written == day
        ]

    def gz_bytes(self) -> bytes | None:
        """Every record as gzipped JSON lines (byte-identical for identical runs), or None."""
        if not self._keep_all:
            return None
        text = "".join(json.dumps(r, ensure_ascii=True, sort_keys=False) + "\n" for r in self.all_records)
        return gzip.compress(text.encode("utf-8"), mtime=0)


class RecordingAlerter:
    """Keeps alerts like ``ConsoleAlerter`` (redacted, logged as ``alert``), without console output."""

    in_memory: ClassVar[bool] = True
    sent: list[tuple[str, str, str]]

    def __init__(self, log: MemoryDecisionLog) -> None:
        self._log = log
        self.sent = []

    def alert(self, level: str, title: str, body: str = "") -> None:
        title, body = redact(title), redact(body)
        self.sent.append((level, title, body))
        self._log.write("alert", level=level, title=title, body=body)
