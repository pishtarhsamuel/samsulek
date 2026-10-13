"""Append-only JSON-lines journal, one file per stream per UTC hour.

- Every record gets ``recorded_at`` (UTC, when we observed it): the point-in-time
  "known at" stamp that research must respect.
- Files are only appended to. A crash can lose or cut the last line: when a file is
  reopened, a cut-off last line is trimmed and the trim is itself recorded (stream
  ``journal_repairs``). Readers also skip a damaged LAST line and count it; a damaged
  line anywhere else is reported (that is not what a crash looks like).
- File names contain no ':' so they are valid on Windows.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import IO, Any

from samsulek.clock import Clock
from samsulek.types import require_aware

_STREAM_RE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
FILE_SUFFIX = ".jsonl"
REPAIR_STREAM = "journal_repairs"


def hour_file_name(ts: datetime) -> str:
    require_aware(ts, "journal timestamp")
    return ts.astimezone(UTC).strftime("%Y%m%dT%HZ") + FILE_SUFFIX


class JournalError(RuntimeError):
    pass


class Journal:
    def __init__(self, root: Path, clock: Clock) -> None:
        self.root = root
        self._clock = clock
        self._open: dict[str, tuple[str, IO[str]]] = {}  # stream -> (file name, handle)

    def append(self, stream: str, record: Mapping[str, Any]) -> dict[str, Any]:
        if not _STREAM_RE.match(stream):
            raise JournalError(f"invalid stream name {stream!r}")
        if "recorded_at" in record:
            raise JournalError("'recorded_at' is set by the journal")
        now = self._clock.now()
        full = {"recorded_at": now.astimezone(UTC).isoformat(), **record}
        line = json.dumps(full, separators=(",", ":"), sort_keys=True, default=_json_default)
        if "\n" in line:
            raise JournalError("a record must serialize to one line")
        fh = self._handle(stream, hour_file_name(now))
        fh.write(line + "\n")
        fh.flush()
        return full

    def _handle(self, stream: str, name: str) -> IO[str]:
        current = self._open.get(stream)
        if current is not None and current[0] == name:
            return current[1]
        if current is not None:
            _close(current[1])
        folder = self.root / stream
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / name
        dropped = _trim_partial_last_line(path)
        fh = path.open("a", encoding="utf-8", newline="\n")
        self._open[stream] = (name, fh)
        if dropped and stream != REPAIR_STREAM:
            self.append(REPAIR_STREAM, {"file": f"{stream}/{name}", "dropped_bytes": dropped})
        return fh

    def sync(self) -> None:
        """Force written records to disk (call periodically and before exiting).

        Files of past hours are closed here too: a stream that goes quiet must not keep
        an old hour file open for days (Windows can't delete an open file, so the daily
        compaction would fail on it)."""
        current = hour_file_name(self._clock.now())
        for stream, (name, fh) in list(self._open.items()):
            if name == current:
                fh.flush()
                os.fsync(fh.fileno())
            else:
                _close(fh)
                del self._open[stream]

    def close(self) -> None:
        for _, fh in self._open.values():
            _close(fh)
        self._open.clear()

    def __enter__(self) -> Journal:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _trim_partial_last_line(path: Path) -> int:
    """Cut a last line that a crash left without its newline. Returns bytes removed."""
    if not path.exists():
        return 0
    with path.open("r+b") as fh:
        size = fh.seek(0, os.SEEK_END)
        if size == 0:
            return 0
        fh.seek(size - 1)
        if fh.read(1) == b"\n":
            return 0
        # Find the start of the partial line (just after the last newline).
        pos = size
        chunk = 4096
        while pos > 0:
            step = min(chunk, pos)
            pos -= step
            fh.seek(pos)
            block = fh.read(step)
            nl = block.rfind(b"\n")
            if nl != -1:
                keep = pos + nl + 1
                break
        else:
            keep = 0
        fh.truncate(keep)
        return size - keep


def _close(fh: IO[str]) -> None:
    try:
        fh.flush()
        os.fsync(fh.fileno())
    finally:
        fh.close()


def _json_default(obj: object) -> object:
    if isinstance(obj, datetime):
        require_aware(obj, "timestamp in record")
        return obj.astimezone(UTC).isoformat()
    if isinstance(obj, Decimal):  # exact, as text (a float would round it)
        return str(obj)
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, timedelta):
        return obj.total_seconds()
    raise TypeError(f"cannot store {type(obj).__name__} in the journal")


@dataclass
class ReadReport:
    records: int = 0
    truncated_tails: int = 0  # damaged last lines (expected after a crash)
    damaged_lines: list[str] | None = None  # damaged lines elsewhere (not expected)


def read_stream(
    root: Path,
    stream: str,
    report: ReadReport | None = None,
    *,
    before_file: str | None = None,
    since: datetime | None = None,
) -> Iterator[dict[str, Any]]:
    """Every record of ``stream`` in file order.

    ``before_file`` limits to closed hours (file names < that name); ``since`` skips whole
    hour files that end before that time (records inside a kept file are all returned).
    """
    first_file = hour_file_name(since) if since is not None else None
    report = report if report is not None else ReadReport()
    if report.damaged_lines is None:
        report.damaged_lines = []
    folder = root / stream
    if not folder.is_dir():
        return
    for path in sorted(folder.glob("*" + FILE_SUFFIX)):
        if before_file is not None and path.name >= before_file:
            continue
        if first_file is not None and path.name < first_file:
            continue
        lines = path.read_text(encoding="utf-8").split("\n")
        # A complete file ends with "\n", so the final element is "".
        for idx, raw in enumerate(lines):
            if not raw:
                continue
            try:
                record = json.loads(raw)
                if not isinstance(record, dict) or "recorded_at" not in record:
                    raise ValueError("not a journal record")
            except ValueError:
                if idx == len(lines) - 1:  # the last line, cut short by a crash
                    report.truncated_tails += 1
                else:
                    report.damaged_lines.append(f"{path.name}:{idx + 1}")
                continue
            report.records += 1
            yield record
