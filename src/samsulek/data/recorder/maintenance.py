"""Recorder housekeeping: a health summary, and compacting old journal days into Parquet.

Compaction turns whole UTC days of hourly JSON-lines files, once every hour of the day is
older than ``RAW_KEEP``, into one Parquet file per stream per day with two columns:
``recorded_at`` and ``record`` (the journal line exactly as written; query it with
DuckDB's JSON functions, e.g. ``record->>'pool_address'``). Values are kept as text on
purpose: letting a reader guess column types would drop time zones and round big
integers. The raw files are deleted only after the Parquet file has been read back and
matches the journal line for line; a day with any damaged line is left as it is (and
reported) so nothing is lost silently. ``RAW_KEEP`` must stay longer than the window the
recorder reads back on restart (oldest snapshot age + 1 hour), or a restart would forget
pools that still have snapshots due.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from samsulek.data.recorder.journal import FILE_SUFFIX, read_stream
from samsulek.data.recorder.solana import PUMP_FUN_DEX
from samsulek.data.store import connect
from samsulek.fsutil import fsync_dir, fsync_file
from samsulek.types import require_aware

HEARTBEAT = "solana_heartbeat.json"
RAW_KEEP = timedelta(days=7)
STREAMS = (
    "pools",
    "gt_pages",
    "pump_creations",
    "mint_facts",
    "pair_snapshots",
    "pair_missing",
    "snapshot_skipped",
    "curve_states",
    "holders",
    "tasks",
    "coverage",
    "journal_repairs",
)
RUNNING_IF_BEAT_WITHIN = timedelta(minutes=3)


def _parse(ts: object) -> datetime | None:
    if not isinstance(ts, str):
        return None
    try:
        value = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return value if value.tzinfo is not None else None


@dataclass
class Health:
    last_beat: datetime | None = None
    stopped_at: datetime | None = None  # a recorded stop after the latest start
    stop_error: str | None = None  # set when that stop was caused by an error
    counts: dict[str, int] = field(default_factory=dict)
    gap_count: dict[str, int] = field(default_factory=dict)
    gap_seconds: dict[str, float] = field(default_factory=dict)
    open_outages: list[str] = field(default_factory=list)
    disabled: list[str] = field(default_factory=list)
    pump_launches: int = 0
    pump_pools_found: int = 0
    unreadable_mints: int = 0

    def running(self, now: datetime) -> bool:
        return (
            self.stopped_at is None
            and self.last_beat is not None
            and now - self.last_beat < RUNNING_IF_BEAT_WITHIN
        )

    def lines(self, now: datetime) -> list[str]:
        out: list[str] = []
        if self.last_beat is None:
            out.append("Recorder: never ran (no heartbeat yet).")
        elif self.stopped_at is not None and self.stop_error is not None:
            out.append(
                f"Recorder: STOPPED after an error at {self.stopped_at:%Y-%m-%d %H:%M} UTC: {self.stop_error}"
            )
        elif self.stopped_at is not None:
            out.append(f"Recorder: STOPPED cleanly at {self.stopped_at:%Y-%m-%d %H:%M} UTC")
        else:
            state = "RUNNING" if self.running(now) else "NOT RUNNING"
            age = int((now - self.last_beat).total_seconds())
            out.append(f"Recorder: {state} (last heartbeat {age} s ago)")
        out.append("Last 24 hours, records per stream:")
        if not any(self.counts.values()):
            out.append("  (none)")
        for stream in STREAMS:
            if self.counts.get(stream):
                out.append(f"  {stream:<17} {self.counts[stream]:>8}")
        for kind in sorted(self.gap_count):
            minutes = self.gap_seconds.get(kind, 0.0) / 60
            out.append(f"  GAP {kind}: {self.gap_count[kind]} time(s), {minutes:.1f} min in total")
        for outage in self.open_outages:
            out.append(f"  SOURCE DOWN (not recovered yet): {outage}")
        for task in self.disabled:
            out.append(f"  TASK SWITCHED OFF in the current run: {task}")
        if self.unreadable_mints:
            out.append(
                f"  MINT FACTS UNREADABLE for {self.unreadable_mints} token(s) (each rejected);"
                " many of them means the provider's format changed"
            )
        if self.pump_launches:
            share = self.pump_pools_found / self.pump_launches
            out.append(
                f"  pump.fun launches on-chain: {self.pump_launches}; found by discovery: "
                f"{self.pump_pools_found} ({share:.0%})"
            )
        return out


def health(root: Path, now: datetime) -> Health:
    """What the recorder did in the 24 hours before ``now``, read from its journal.

    While it runs, open outages and switched-off tasks come from its heartbeat, so they
    stay visible however long ago they started; otherwise from the journal."""
    require_aware(now, "now")
    h = Health()
    beat: Any = None
    try:
        beat = json.loads((root / HEARTBEAT).read_text(encoding="utf-8"))
        h.last_beat = _parse(beat.get("last_beat")) if isinstance(beat, dict) else None
    except (OSError, ValueError):
        h.last_beat = None
    since = now - timedelta(hours=24)
    recent: dict[str, list[dict[str, Any]]] = {}
    for stream in STREAMS:
        rows = []
        for r in read_stream(root, stream, since=since):
            at = _parse(r.get("recorded_at"))
            if at is not None and since < at <= now:
                rows.append(r)
        recent[stream] = rows
        h.counts[stream] = len(rows)

    # A new run starts with every source and task presumed healthy: only what happened
    # after the latest start is still open.
    last_start: datetime | None = None
    down: dict[str, str] = {}
    for r in recent["coverage"]:
        event = r.get("event")
        if event == "start":
            last_start = _parse(r.get("recorded_at"))
            h.stopped_at = None
            h.stop_error = None
            down.clear()
        elif event == "stop":
            h.stopped_at = _parse(r.get("recorded_at"))
            if r.get("reason") == "error":
                h.stop_error = str(r.get("error") or "unknown error")[:200]
        elif event == "gap":
            kind = str(r.get("kind"))
            h.gap_count[kind] = h.gap_count.get(kind, 0) + 1
            h.gap_seconds[kind] = h.gap_seconds.get(kind, 0.0) + _seconds(r.get("seconds"))
            if kind == "source_down":
                down.pop(str(r.get("source")), None)
        elif event == "source_down":
            down[str(r.get("source"))] = str(r.get("error"))[:200]
    h.open_outages = [f"{s}: {e}" for s, e in sorted(down.items())]
    h.disabled = sorted(
        {
            str(r.get("task"))
            for r in recent["tasks"]
            if r.get("event") == "task_disabled"
            and (last_start is None or (_parse(r.get("recorded_at")) or since) >= last_start)
        }
    )
    if h.running(now) and isinstance(beat, dict):
        failing, off = beat.get("failing"), beat.get("off")
        if isinstance(failing, dict):
            h.open_outages = [
                f"{s}: {e.get('error') if isinstance(e, dict) else e}" for s, e in sorted(failing.items())
            ]
        if isinstance(off, dict):
            h.disabled = sorted(str(task) for task in off)
    h.pump_launches = sum(
        max(0, _int(r.get("count")) - _int(r.get("failed")))
        for r in recent["pump_creations"]
        if not r.get("baseline")
    )
    h.pump_pools_found = sum(1 for r in recent["pools"] if r.get("dex_id") == PUMP_FUN_DEX)
    h.unreadable_mints = sum(1 for r in recent["mint_facts"] if _unreadable(r.get("facts")))
    return h


def _unreadable(facts: object) -> bool:
    return isinstance(facts, dict) and str(facts.get("reason", "")).startswith("unreadable")


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _seconds(value: object) -> float:
    if isinstance(value, int | float) and not isinstance(value, bool) and value >= 0:
        return float(value)
    return 0.0


@dataclass
class CompactReport:
    days_written: list[str] = field(default_factory=list)
    files_removed: int = 0
    skipped: list[str] = field(default_factory=list)
    finished: list[str] = field(default_factory=list)  # leftovers of an earlier run removed


def compact(root: Path, now: datetime, keep: timedelta = RAW_KEEP) -> CompactReport:
    """Compact every whole UTC day that ended more than ``keep`` before ``now``."""
    require_aware(now, "now")
    report = CompactReport()
    root = root.resolve()  # the same spelling DuckDB's allowed_directories was given
    # A day qualifies only when all of it is older than `keep`, so a day is never split.
    first_kept_day = (now - keep).astimezone(UTC).strftime("%Y%m%d")
    con = connect(root)
    try:
        for stream in STREAMS:
            folder = root / stream
            if not folder.is_dir():
                continue
            by_day: dict[str, list[Path]] = defaultdict(list)
            for path in sorted(folder.glob("*" + FILE_SUFFIX)):
                if path.name[:8] < first_kept_day:
                    by_day[path.name[:8]].append(path)
            for day, files in sorted(by_day.items()):
                _compact_day(con, folder, day, files, report)
    finally:
        con.close()
    return report


def _compact_day(con: Any, folder: Path, day: str, files: list[Path], report: CompactReport) -> None:
    """One stream-day. Memory stays small whatever the day's size: Python only hashes the
    journal lines as it reads them, and DuckDB reads the files itself."""
    target = folder / f"{day}.parquet"
    label = f"{folder.name}/{day}"
    count, damaged, digest = _scan(files)
    if damaged:
        report.skipped.append(f"{label}: {damaged} damaged line(s); left as raw text")
        return
    if count == 0:
        return
    if target.exists():
        _finish_earlier(con, target, files, label, report)
        return
    tmp = folder / f".{day}.parquet.tmp"
    sources = ", ".join(_sql_text(p) for p in files)
    try:
        # The only text put into SQL is our own file paths, quoted by _sql_text.
        con.execute(
            "COPY (SELECT json_extract_string(line, '$.recorded_at') AS recorded_at, line AS record FROM ("  # noqa: S608
            "SELECT filename, unnest(range(len(parts))) AS i, unnest(parts) AS line FROM ("
            f"SELECT filename, string_split(content, chr(10)) AS parts FROM read_text([{sources}])"
            ")) WHERE line <> '' ORDER BY filename, i) "
            f"TO {_sql_text(tmp)} (FORMAT parquet, COMPRESSION zstd)"
        )
        stored_count, stored_digest = _parquet_digest(con, tmp)
    except Exception as exc:  # keep the raw files
        tmp.unlink(missing_ok=True)
        report.skipped.append(f"{label}: {type(exc).__name__}: {str(exc)[:200]}")
        return
    if (stored_count, stored_digest) != (count, digest):
        tmp.unlink(missing_ok=True)
        report.skipped.append(
            f"{label}: Parquet ({stored_count} rows) does not match the journal ({count}); raw files kept"
        )
        return
    # On disk before anything is deleted: a power cut must not keep the deletions and
    # lose the Parquet data (the OS may write metadata before file contents).
    fsync_file(tmp)
    os.replace(tmp, target)
    fsync_dir(folder)
    _remove(files, label, report)
    report.days_written.append(label)


def _finish_earlier(con: Any, target: Path, files: list[Path], label: str, report: CompactReport) -> None:
    """A Parquet file exists but raw files are left: an earlier compaction couldn't delete
    them (Windows can't delete a file another handle has open). Delete them only if every
    remaining line is already in the Parquet file; otherwise keep everything."""
    try:
        stored = _parquet_hashes(con, target)
    except Exception as exc:
        report.skipped.append(
            f"{label}: can't read the existing Parquet file ({type(exc).__name__}); raw files kept"
        )
        return
    if all(_line_hash(line) in stored for line in _iter_valid(files)):
        _remove(files, label, report)
        report.finished.append(label)
    else:
        report.skipped.append(f"{label}: a Parquet file for this day already exists; raw files kept")


def _remove(files: list[Path], label: str, report: CompactReport) -> None:
    for path in files:
        try:
            path.unlink()
        except OSError as exc:  # e.g. still open elsewhere on Windows: the next run finishes it
            report.skipped.append(f"{label}: could not delete {path.name} yet ({type(exc).__name__})")
            continue
        report.files_removed += 1


def _parquet_digest(con: Any, path: Path) -> tuple[int, str]:
    digest, count = hashlib.sha256(), 0
    cursor = con.execute(f"SELECT record FROM read_parquet({_sql_text(path)})")  # noqa: S608
    while rows := cursor.fetchmany(10_000):
        for (record,) in rows:
            digest.update(record.encode("utf-8") + b"\n")
            count += 1
    return count, digest.hexdigest()


def _parquet_hashes(con: Any, path: Path) -> set[bytes]:
    hashes: set[bytes] = set()
    cursor = con.execute(f"SELECT record FROM read_parquet({_sql_text(path)})")  # noqa: S608
    while rows := cursor.fetchmany(10_000):
        hashes.update(_line_hash(record) for (record,) in rows)
    return hashes


def _line_hash(line: str) -> bytes:
    return hashlib.sha256(line.encode("utf-8")).digest()


def _sql_text(path: Path) -> str:
    """A path as an SQL string literal (paths come from our own folder listing)."""
    return "'" + str(path).replace("'", "''") + "'"


def _scan(files: list[Path]) -> tuple[int, int, str]:
    """Whole record lines (count and a hash of them, in order) and damaged lines. A
    crash-cut last line counts as damaged here: only fully intact days are compacted."""
    digest, count, damaged = hashlib.sha256(), 0, 0
    for path in files:
        for raw, ok in _lines(path):
            if ok:
                digest.update(raw.encode("utf-8") + b"\n")
                count += 1
            else:
                damaged += 1
    return count, damaged, digest.hexdigest()


def _iter_valid(files: list[Path]) -> Iterator[str]:
    for path in files:
        for raw, ok in _lines(path):
            if ok:
                yield raw


def _lines(path: Path) -> Iterator[tuple[str, bool]]:
    """Each non-empty line of one hour file, and whether it is a whole journal record."""
    for raw in path.read_bytes().decode("utf-8", errors="replace").split("\n"):
        if not raw:
            continue
        try:
            record: Any = json.loads(raw)
        except ValueError:
            yield raw, False
            continue
        yield (
            raw,
            isinstance(record, dict) and isinstance(record.get("recorded_at"), str) and "\ufffd" not in raw,
        )
