"""Snapshot scheduling and outcome-independent sampling."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from samsulek.data.recorder.schedule import SnapshotSchedule, in_sample, tolerance

T0 = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)
M = timedelta(minutes=1)
AGES = [5 * M, 15 * M, 60 * M]


def test_snapshots_come_due_at_each_age_in_order() -> None:
    s = SnapshotSchedule(AGES)
    s.add("A", T0)
    s.add("B", T0 + M)
    assert s.take_due(T0 + 4 * M, 10) == ([], [])
    take, skipped = s.take_due(T0 + 6 * M, 10)
    assert [(d.pool, d.age) for d in take] == [("A", 5 * M), ("B", 5 * M)] and skipped == []
    take, _ = s.take_due(T0 + 15 * M, 10)
    assert [(d.pool, d.age) for d in take] == [("A", 15 * M)]
    take, _ = s.take_due(T0 + 16 * M, 10)
    assert [(d.pool, d.age) for d in take] == [("B", 15 * M)]
    assert s.next_due_at() == T0 + 60 * M
    take, _ = s.take_due(T0 + 60 * M, 10)
    assert [(d.pool, d.age) for d in take] == [("A", 60 * M)]
    assert "A" not in s and "B" in s, "a pool stops being tracked after its last age"
    take, skipped = s.take_due(T0 + 62 * M, 10)
    assert [(d.pool, d.age) for d in take] == [("B", 60 * M)] and skipped == []
    assert len(s) == 0 and s.next_due_at() is None


def test_late_snapshots_are_skipped_not_taken_late() -> None:
    s = SnapshotSchedule(AGES)
    s.add("A", T0)
    # The recorder was off for 3 hours: every age is past its tolerance.
    take, skipped = s.take_due(T0 + 3 * 60 * M, 10)
    assert take == []
    assert [d.age for d in skipped] == [5 * M, 15 * M, 60 * M]
    assert len(s) == 0


def test_tolerance_scales_with_age() -> None:
    assert tolerance(5 * M) == 2 * M
    assert tolerance(60 * M) == 15 * M
    s = SnapshotSchedule(AGES)
    s.add("A", T0)
    s.take_due(T0 + 6 * M, 10)
    take, skipped = s.take_due(T0 + 15 * M + 3 * M, 10)  # 3 min late for 15 min: within 3m45s
    assert [d.age for d in take] == [15 * M] and skipped == []


def test_the_limit_defers_but_does_not_drop() -> None:
    s = SnapshotSchedule(AGES)
    for i in range(5):
        s.add(f"P{i}", T0)
    take, _ = s.take_due(T0 + 5 * M, 2)
    assert [d.pool for d in take] == ["P0", "P1"]
    take, _ = s.take_due(T0 + 6 * M, 10)
    assert [d.pool for d in take] == ["P2", "P3", "P4"]


def test_restart_resumes_after_ages_already_done() -> None:
    s = SnapshotSchedule(AGES)
    s.add("A", T0, done=2)
    take, _ = s.take_due(T0 + 61 * M, 10)
    assert [d.age for d in take] == [60 * M]
    s.add("B", T0, done=3)  # everything done: not tracked at all
    assert "B" not in s


def test_bad_schedules_are_refused() -> None:
    for ages in ([], [0 * M], [15 * M, 5 * M], [5 * M, 5 * M]):
        with pytest.raises(ValueError, match="ages"):
            SnapshotSchedule(ages)
    with pytest.raises(ValueError, match="timezone"):
        SnapshotSchedule(AGES).add("A", datetime(2026, 1, 1))  # noqa: DTZ001


def test_sampling_is_deterministic_and_about_the_right_size() -> None:
    addresses = [f"pool{i}" for i in range(20_000)]
    picked = [a for a in addresses if in_sample(a, 250)]
    assert 0.23 < len(picked) / len(addresses) < 0.27
    assert picked == [a for a in addresses if in_sample(a, 250)], "same answer every time"
    assert not any(in_sample(a, 0) for a in addresses[:100])
    assert all(in_sample(a, 1000) for a in addresses[:100])
    other_salt = [a for a in addresses if in_sample(a, 250, salt="holders")]
    assert set(other_salt) != set(picked), "independent samples for different purposes"
    with pytest.raises(ValueError, match="per_mille"):
        in_sample("x", 1001)
