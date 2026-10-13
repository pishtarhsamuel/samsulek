"""When to snapshot each tracked pool, and which pools are in the random sample.

Each pool is snapshotted at fixed ages after creation (e.g. 5 min, 15 min, 1 h, ...).
A snapshot counts for its target age only if taken within a tolerance window after it;
if the recorder was down (or behind) past that window, the snapshot is recorded as
SKIPPED - never taken late and mislabeled, because "price at 1 h" taken at 5 h would
quietly corrupt research.

Sampling is a deterministic hash of the pool address: which pools are followed does not
depend on anything about the pool (its name, size, or success), so the sample is not
biased toward survivors, and the choice is reproducible.
"""

from __future__ import annotations

import hashlib
import heapq
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from samsulek.types import require_aware


def in_sample(address: str, per_mille: int, salt: str = "") -> bool:
    """Deterministic, outcome-independent sampling: per_mille out of 1000 addresses."""
    if not 0 <= per_mille <= 1000:
        raise ValueError("per_mille must be within 0..1000")
    digest = hashlib.sha256(f"{salt}:{address}".encode()).digest()
    return int.from_bytes(digest[:4], "big") % 1000 < per_mille


def tolerance(age: timedelta) -> timedelta:
    """How late a snapshot may be and still count for its target age."""
    return max(timedelta(minutes=2), age / 4)


@dataclass(frozen=True, slots=True)
class Due:
    pool: str
    age: timedelta  # the target age this snapshot is for
    due_at: datetime


@dataclass
class _Tracked:
    created_at: datetime
    next_index: int  # index into ages of the next snapshot to take


@dataclass
class SnapshotSchedule:
    ages: Sequence[timedelta]
    _pools: dict[str, _Tracked] = field(default_factory=dict)
    _heap: list[tuple[datetime, str, int]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.ages or any(a <= timedelta(0) for a in self.ages):
            raise ValueError("snapshot ages must be positive")
        if list(self.ages) != sorted(set(self.ages)):
            raise ValueError("snapshot ages must be strictly increasing")

    def __len__(self) -> int:
        return len(self._pools)

    def __contains__(self, pool: str) -> bool:
        return pool in self._pools

    def add(self, pool: str, created_at: datetime, done: int = 0) -> None:
        """Track a pool. ``done`` = how many of the ages were already handled (on restart)."""
        require_aware(created_at, "pool creation time")
        if pool in self._pools or done >= len(self.ages):
            return
        self._pools[pool] = _Tracked(created_at, done)
        heapq.heappush(self._heap, (created_at + self.ages[done], pool, done))

    def take_due(self, now: datetime, limit: int) -> tuple[list[Due], list[Due]]:
        """Pop up to ``limit`` snapshots that are due now, plus every one that is too late.

        Returns (to_take, skipped). Pools whose last age is handled stop being tracked.
        """
        require_aware(now, "now")
        take: list[Due] = []
        skipped: list[Due] = []
        while self._heap and self._heap[0][0] <= now:
            due_at, pool, index = self._heap[0]
            tracked = self._pools.get(pool)
            if tracked is None or tracked.next_index != index:  # stale heap entry
                heapq.heappop(self._heap)
                continue
            age = self.ages[index]
            late = now - due_at > tolerance(age)
            if not late and len(take) >= limit:
                break  # stays queued for the next round (it may become late: then skipped)
            heapq.heappop(self._heap)
            (skipped if late else take).append(Due(pool, age, due_at))
            self._advance(pool, tracked)
        return take, skipped

    def _advance(self, pool: str, tracked: _Tracked) -> None:
        tracked.next_index += 1
        if tracked.next_index >= len(self.ages):
            del self._pools[pool]
            return
        heapq.heappush(
            self._heap, (tracked.created_at + self.ages[tracked.next_index], pool, tracked.next_index)
        )

    def next_due_at(self) -> datetime | None:
        while self._heap:
            due_at, pool, index = self._heap[0]
            tracked = self._pools.get(pool)
            if tracked is not None and tracked.next_index == index:
                return due_at
            heapq.heappop(self._heap)
        return None
