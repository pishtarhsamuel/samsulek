"""Recorder building blocks: the append-only journal and coverage (heartbeats and gaps)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from samsulek.clock import FixedClock
from samsulek.data.recorder import coverage as coverage_module
from samsulek.data.recorder.coverage import Coverage
from samsulek.data.recorder.journal import Journal, JournalError, ReadReport, hour_file_name, read_stream

T = datetime(2026, 10, 12, 21, 59, 30, tzinfo=UTC)


def records(root: Path, stream: str, report: ReadReport | None = None) -> list[dict[str, object]]:
    return list(read_stream(root, stream, report))


def test_records_are_stamped_and_split_by_utc_hour(tmp_path: Path) -> None:
    clock = FixedClock(T)
    with Journal(tmp_path, clock) as j:
        j.append("pools", {"pool": "A", "seen_at": T})
        clock.advance(timedelta(minutes=1))  # 22:00:30, the next hour
        j.append("pools", {"pool": "B"})
    files = sorted(p.name for p in (tmp_path / "pools").iterdir())
    assert files == ["20261012T21Z.jsonl", "20261012T22Z.jsonl"]
    assert ":" not in "".join(files), "Windows file names can't contain ':'"
    got = records(tmp_path, "pools")
    assert [r["pool"] for r in got] == ["A", "B"]
    assert got[0]["recorded_at"] == T.isoformat()
    assert got[0]["seen_at"] == T.isoformat()


def test_invalid_records_are_refused(tmp_path: Path) -> None:
    with Journal(tmp_path, FixedClock(T)) as j:
        with pytest.raises(JournalError):
            j.append("Bad Name", {})
        with pytest.raises(JournalError):
            j.append("pools", {"recorded_at": "forged"})
        with pytest.raises(TypeError):
            j.append("pools", {"x": object()})
        with pytest.raises(ValueError, match="timezone"):
            j.append("pools", {"when": datetime(2026, 1, 1)})  # noqa: DTZ001


def test_a_line_cut_by_a_crash_is_trimmed_and_the_trim_recorded(tmp_path: Path) -> None:
    clock = FixedClock(T)
    with Journal(tmp_path, clock) as j:
        j.append("pools", {"pool": "A"})
    path = tmp_path / "pools" / hour_file_name(T)
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"recorded_at": "2026-10-12T21:59:31+00:00", "pool": "B"')  # crash mid-line
    report = ReadReport()
    assert [r["pool"] for r in records(tmp_path, "pools", report)] == ["A"]
    assert report.truncated_tails == 1 and report.damaged_lines == []
    with Journal(tmp_path, clock) as j:  # restart, same hour
        j.append("pools", {"pool": "C"})
    report = ReadReport()
    assert [r["pool"] for r in records(tmp_path, "pools", report)] == ["A", "C"]
    assert report.truncated_tails == 0 and report.damaged_lines == []
    repairs = records(tmp_path, "journal_repairs")
    assert repairs and repairs[0]["file"] == f"pools/{hour_file_name(T)}"
    assert int(repairs[0]["dropped_bytes"]) > 0  # type: ignore[call-overload]


def test_damage_in_the_middle_of_a_file_is_reported(tmp_path: Path) -> None:
    with Journal(tmp_path, FixedClock(T)) as j:
        j.append("pools", {"pool": "A"})
        j.append("pools", {"pool": "B"})
    path = tmp_path / "pools" / hour_file_name(T)
    lines = path.read_text(encoding="utf-8").split("\n")
    lines[0] = "garbage"
    path.write_text("\n".join(lines), encoding="utf-8")
    report = ReadReport()
    assert [r["pool"] for r in records(tmp_path, "pools", report)] == ["B"]
    assert report.damaged_lines == [f"{hour_file_name(T)}:1"]


def test_closed_hours_only(tmp_path: Path) -> None:
    clock = FixedClock(T)
    with Journal(tmp_path, clock) as j:
        j.append("pools", {"pool": "A"})
        clock.advance(timedelta(hours=1))
        j.append("pools", {"pool": "B"})
    current = hour_file_name(clock.now())
    closed = list(read_stream(tmp_path, "pools", before_file=current))
    assert [r["pool"] for r in closed] == ["A"]


def gaps(root: Path) -> list[dict[str, object]]:
    return [r for r in records(root, "coverage") if r["event"] == "gap"]


def test_downtime_between_runs_is_recorded_as_a_gap(tmp_path: Path) -> None:
    clock = FixedClock(T)
    with Journal(tmp_path, clock) as j:
        cov = Coverage(j, tmp_path, clock, "solana")
        cov.start()
        assert gaps(tmp_path) == [], "first run ever: nothing was missed that we know of"
        clock.advance(timedelta(minutes=2))
        cov.beat()
        last_beat = clock.now()
        clock.advance(timedelta(seconds=30))  # crash: no stop(), no further beat
    clock.advance(timedelta(hours=3))
    with Journal(tmp_path, clock) as j:
        Coverage(j, tmp_path, clock, "solana").start()
    (gap,) = gaps(tmp_path)
    assert gap["kind"] == "not_running"
    assert gap["start"] == last_beat.isoformat()
    assert gap["end"] == clock.now().isoformat()


def test_heartbeats_are_rate_limited(tmp_path: Path) -> None:
    clock = FixedClock(T)
    with Journal(tmp_path, clock) as j:
        cov = Coverage(j, tmp_path, clock, "solana", beat_every=timedelta(seconds=60))
        cov.start()
        state = tmp_path / "solana_heartbeat.json"
        first = state.read_text(encoding="utf-8")
        clock.advance(timedelta(seconds=30))
        cov.beat()
        assert state.read_text(encoding="utf-8") == first
        clock.advance(timedelta(seconds=30))
        cov.beat()
        assert state.read_text(encoding="utf-8") != first


def test_source_outages_become_gaps_and_are_closed_at_stop(tmp_path: Path) -> None:
    clock = FixedClock(T)
    with Journal(tmp_path, clock) as j:
        cov = Coverage(j, tmp_path, clock, "solana")
        cov.start()
        cov.source_failed("geckoterminal", "HTTP 503")
        down_at = clock.now()
        clock.advance(timedelta(minutes=5))
        cov.source_failed("geckoterminal", "HTTP 503 again")  # still the same outage
        clock.advance(timedelta(minutes=5))
        cov.source_ok("geckoterminal")
        cov.source_failed("solana_rpc", "timeout")
        assert cov.failing_sources == ["solana_rpc"]
        clock.advance(timedelta(minutes=1))
        cov.stop()
    found = gaps(tmp_path)
    assert [(g["kind"], g["source"]) for g in found] == [
        ("source_down", "geckoterminal"),
        ("source_down", "solana_rpc"),
    ]
    assert found[0]["start"] == down_at.isoformat() and found[0]["seconds"] == 600
    assert found[0]["error"] == "HTTP 503"
    assert found[1]["open_at_stop"] is True
    downs = [r for r in records(tmp_path, "coverage") if r["event"] == "source_down"]
    assert len(downs) == 2, "one event per outage, not one per failed call"


def test_the_heartbeat_never_vouches_for_records_not_yet_on_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    order: list[str] = []
    clock = FixedClock(T)
    with Journal(tmp_path, clock) as j:
        real_sync = j.sync
        monkeypatch.setattr(j, "sync", lambda: (order.append("sync"), real_sync())[1])
        real_beat = coverage_module.atomic_write_text
        monkeypatch.setattr(
            coverage_module, "atomic_write_text", lambda p, t: (order.append("beat"), real_beat(p, t))[1]
        )
        cov = Coverage(j, tmp_path, clock, "solana")
        cov.start()
        clock.advance(timedelta(minutes=2))
        cov.beat()
        cov.task_off("holders", "solana_rpc", "HTTP 403")
        cov.stop()
    assert order == ["sync", "beat"] * 4, "start, beat, task_off and stop each sync first"


def test_a_switched_off_task_is_a_gap_until_stop_and_in_the_heartbeat(tmp_path: Path) -> None:
    clock = FixedClock(T)
    with Journal(tmp_path, clock) as j:
        cov = Coverage(j, tmp_path, clock, "solana")
        cov.start()
        cov.source_failed("solana_rpc", "HTTP 503")
        cov.task_off("holders", "solana_rpc", "HTTP 403 blocked")
        clock.advance(timedelta(minutes=1))
        cov.source_ok("solana_rpc")  # another task of the same source works again
        beat = json.loads((tmp_path / "solana_heartbeat.json").read_text(encoding="utf-8"))
        assert beat["off"]["holders"]["reason"] == "HTTP 403 blocked" and beat["failing"]
        clock.advance(timedelta(minutes=9))
        cov.stop()
    found = gaps(tmp_path)
    assert [(g["kind"], g.get("task"), g["seconds"]) for g in found] == [
        ("source_down", None, 60.0),
        ("task_off", "holders", 600.0),
    ]
    assert found[1]["open_at_stop"] is True


def test_a_damaged_heartbeat_file_is_reported_not_trusted(tmp_path: Path) -> None:
    clock = FixedClock(T)
    (tmp_path / "solana_heartbeat.json").write_bytes(b"\xff\xfe garbage")
    with Journal(tmp_path, clock) as j:
        Coverage(j, tmp_path, clock, "solana").start()
    events = [r["event"] for r in records(tmp_path, "coverage")]
    assert events[0] == "heartbeat_unreadable"
    assert "gap" not in events
