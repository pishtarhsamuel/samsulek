"""The Solana recorder loop, driven by fake sources and a fixed clock (no network)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from samsulek.clock import FixedClock
from samsulek.data.recorder.coverage import Coverage
from samsulek.data.recorder.journal import Journal, read_stream
from samsulek.data.recorder.solana import PumpFun, RecorderSettings, SolanaRecorder
from samsulek.net.http import HttpError

T0 = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)
M = timedelta(minutes=1)
PUMP_PROGRAM = "PumpProgram111"
TOKEN_2022 = "TokenzQd"


@dataclass(frozen=True)
class Pool:
    pool_address: str
    dex_id: str
    base_mint: str
    quote_mint: str
    pool_created_at: datetime
    price_usd: Decimal | None = Decimal("0.0001")


@dataclass(frozen=True)
class Page:
    pools: tuple[Pool, ...]
    as_of: datetime
    fetched_at: datetime


class FakeDiscovery:
    def __init__(self, clock: FixedClock) -> None:
        self.clock = clock
        self.pages: dict[int, list[Pool]] = {}
        self.calls: list[int] = []
        self.fail: Exception | None = None

    def new_pools(self, page: int) -> Page:
        self.calls.append(page)
        if self.fail is not None:
            raise self.fail
        now = self.clock.now()
        return Page(tuple(self.pages.get(page, [])), now - timedelta(seconds=30), now)


@dataclass(frozen=True)
class Pair:
    pair_address: str
    price_usd: Decimal


@dataclass(frozen=True)
class Batch:
    found: Mapping[str, Pair]
    missing: Sequence[str]
    as_of: datetime
    fetched_at: datetime


class FakeSnapshots:
    def __init__(self, clock: FixedClock) -> None:
        self.clock = clock
        self.absent: set[str] = set()
        self.requests: list[list[str]] = []
        self.fail: Exception | None = None

    def pairs(self, addresses: Sequence[str]) -> Batch:
        self.requests.append(list(addresses))
        if self.fail is not None:
            raise self.fail
        now = self.clock.now()
        found = {a: Pair(a, Decimal("0.0002")) for a in addresses if a not in self.absent}
        return Batch(found, [a for a in addresses if a in self.absent], now - timedelta(seconds=10), now)


@dataclass(frozen=True)
class Sig:
    signature: str
    slot: int
    failed: bool = False


@dataclass(frozen=True)
class Facts:
    address: str
    owner: str
    mint_authority: str | None
    freeze_authority: str | None


@dataclass(frozen=True)
class Mints:
    slot: int
    facts: Mapping[str, Facts | None]


@dataclass(frozen=True)
class Raw:
    owner: str
    data: bytes


@dataclass(frozen=True)
class Holders:
    slot: int
    holders: Sequence[tuple[str, int]]


@dataclass
class FakeChain:
    sig_batches: list[list[Sig]] = field(default_factory=list)
    sig_calls: list[str | None] = field(default_factory=list)
    mint_calls: list[list[str]] = field(default_factory=list)
    curve_calls: list[list[str]] = field(default_factory=list)
    holder_calls: list[tuple[str, str]] = field(default_factory=list)
    curve_owner: dict[str, str] = field(default_factory=dict)
    mints_fail: Exception | None = None

    def signatures(
        self, address: str, *, until: str | None = None, before: str | None = None, limit: int = 1000
    ) -> list[Sig]:
        self.sig_calls.append(until)
        return self.sig_batches.pop(0) if self.sig_batches else []

    def mints(self, addresses: Sequence[str]) -> Mints:
        self.mint_calls.append(list(addresses))
        if self.mints_fail is not None:
            raise self.mints_fail
        return Mints(100, {a: Facts(a, TOKEN_2022, None, None) for a in addresses})

    def accounts_raw(self, addresses: Sequence[str]) -> tuple[int, dict[str, Raw | None]]:
        self.curve_calls.append(list(addresses))
        return 101, {a: Raw(self.curve_owner.get(a, PUMP_PROGRAM), b"curve:" + a.encode()) for a in addresses}

    def token_holders(self, mint: str, token_program_id: str) -> Holders:
        self.holder_calls.append((mint, token_program_id))
        return Holders(102, [("dev", 5), ("curve", 90), ("x", 5)])


@dataclass(frozen=True)
class Curve:
    complete: bool
    raw_len: int


def decode(data: bytes) -> Curve:
    if not data.startswith(b"curve:"):
        raise ValueError("unknown layout")
    return Curve(False, len(data))


ALL = RecorderSettings(snapshot_per_mille=1000, holders_per_mille=1000)


class Rig:
    def __init__(self, tmp: Path, settings: RecorderSettings = ALL) -> None:
        self.clock = FixedClock(T0)
        self.root = tmp
        self.journal = Journal(tmp, self.clock)
        self.coverage = Coverage(self.journal, tmp, self.clock, "solana")
        self.discovery = FakeDiscovery(self.clock)
        self.snapshots = FakeSnapshots(self.clock)
        self.chain = FakeChain()
        self.rec = SolanaRecorder(
            discovery=self.discovery,
            snapshots=self.snapshots,
            chain=self.chain,
            pump=PumpFun(PUMP_PROGRAM, "MintAuthPda", decode),
            journal=self.journal,
            coverage=self.coverage,
            clock=self.clock,
            settings=settings,
        )

    def stream(self, name: str) -> list[dict[str, Any]]:
        self.journal.sync()
        return list(read_stream(self.root, name))


def pool(i: int, created: datetime, dex: str = "pump-fun") -> Pool:
    return Pool(f"P{i}", dex, f"M{i}", "So111", created)


def test_discovery_records_every_new_pool_once_and_queues_its_facts(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.discovery.pages = {1: [pool(2, T0 - M), pool(1, T0 - 2 * M)], 2: []}
    r.rec.step()
    pools = r.stream("pools")
    assert [p["pool_address"] for p in pools] == ["P2", "P1"]
    assert pools[0]["snapshot_sampled"] is True and pools[0]["discovered_at"] == T0.isoformat()
    assert r.discovery.calls == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "first round reads every page"
    assert r.chain.mint_calls == [["M2", "M1"]]
    assert {m["mint"] for m in r.stream("mint_facts")} == {"M1", "M2"}
    r.clock.advance(timedelta(seconds=150))
    r.discovery.calls.clear()
    r.discovery.pages = {1: [pool(3, T0 + M), pool(2, T0 - M)], 2: [pool(1, T0 - 2 * M)]}
    r.rec.step()
    assert [p["pool_address"] for p in r.stream("pools")] == ["P2", "P1", "P3"]
    assert r.discovery.calls == [1, 2], "stops at a page of pools it already knew"
    assert not [g for g in r.stream("coverage") if g.get("kind") == "discovery_overrun"]


def test_cache_skew_duplicates_do_not_stop_the_round_early(tmp_path: Path) -> None:
    """Pages are cached separately: a pool new THIS round can show up again on a later
    page. Only a page of pools known BEFORE the round means older pages hold nothing new."""
    r = Rig(tmp_path)
    r.discovery.pages = {1: [pool(1, T0 - 5 * M)]}
    r.rec.step()
    r.clock.advance(timedelta(seconds=150))
    r.discovery.calls.clear()
    r.discovery.pages = {
        1: [pool(3, T0 + M)],
        2: [pool(3, T0 + M)],  # the same new pool again (stale cache)
        3: [pool(4, T0), pool(1, T0 - 5 * M)],
    }
    r.rec.step()
    assert [p["pool_address"] for p in r.stream("pools")] == ["P1", "P3", "P4"]
    assert r.discovery.calls[:3] == [1, 2, 3]


def test_a_feed_that_moved_past_us_is_recorded_as_a_gap(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.discovery.pages = {1: [pool(1, T0 - M)]}
    r.rec.step()
    r.clock.advance(timedelta(seconds=150))
    r.discovery.pages = {i: [pool(100 + i, T0 + 2 * M - i * timedelta(seconds=1))] for i in range(1, 11)}
    r.rec.step()
    (gap,) = [g for g in r.stream("coverage") if g.get("kind") == "discovery_overrun"]
    assert gap["start"] == (T0 - M).isoformat()
    assert gap["end"] == (T0 + 2 * M - 10 * timedelta(seconds=1)).isoformat()


def test_snapshots_at_each_age_missing_and_late_ones_are_recorded(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.discovery.pages = {1: [pool(1, T0, dex="meteora"), pool(2, T0, dex="meteora")]}
    r.snapshots.absent = {"P2"}
    r.rec.step()
    r.clock.advance(5 * M)
    r.rec.step()
    snaps = r.stream("pair_snapshots")
    assert [(s["pool"], s["target_age_minutes"]) for s in snaps] == [("P1", 5.0)]
    assert snaps[0]["pair"]["price_usd"] == "0.0002"
    assert [(m["pool"], m["target_age_minutes"]) for m in r.stream("pair_missing")] == [("P2", 5.0)]
    r.clock.advance(3 * 60 * M)  # the PC slept: 15 min and 1 h snapshots are too late now
    r.rec.step()
    skipped = {(s["pool"], s["target_age_minutes"], s["reason"]) for s in r.stream("snapshot_skipped")}
    assert ("P1", 15.0, "late") in skipped and ("P1", 60.0, "late") in skipped


def test_pump_fun_curves_and_holder_lists(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.discovery.pages = {1: [pool(1, T0), pool(2, T0)]}
    r.chain.curve_owner = {"P2": "SomeoneElse"}
    r.rec.step()
    r.clock.advance(5 * M)
    r.rec.step()
    curves = {c["pool"]: c for c in r.stream("curve_states")}
    assert curves["P1"]["state"] == {"complete": False, "raw_len": len(b"curve:P1")}
    assert "not the pump.fun program" in curves["P2"]["error"]
    r.clock.advance(10 * M)  # 15 min: a holder-list age
    r.rec.step()
    r.clock.advance(timedelta(seconds=3))
    r.rec.step()
    r.clock.advance(timedelta(seconds=3))
    r.rec.step()
    holders = r.stream("holders")
    assert {h["mint"] for h in holders} == {"M1", "M2"}
    assert holders[0]["top"][0] == {"owner": "curve", "amount": 90}
    assert holders[0]["total_amount"] == 100
    assert r.chain.holder_calls[0][1] == TOKEN_2022, "uses the token program from the mint facts"


def test_transient_errors_open_and_close_a_coverage_gap(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.discovery.fail = HttpError("HTTP 503", url="x", status=503)
    r.rec.step()
    assert "discovery" not in r.rec.disabled
    r.clock.advance(timedelta(seconds=150))
    r.discovery.fail = None
    r.rec.step()
    (gap,) = [g for g in r.stream("coverage") if g.get("event") == "gap"]
    assert gap["kind"] == "source_down" and gap["source"] == "geckoterminal"


@pytest.mark.parametrize(
    "error", [ValueError("unexpected schema"), HttpError("HTTP 403 blocked", url="x", status=403)]
)
def test_a_format_change_or_block_switches_the_task_off_and_the_rest_keeps_going(
    tmp_path: Path, error: Exception
) -> None:
    r = Rig(tmp_path)
    r.discovery.pages = {1: [pool(1, T0, dex="meteora")]}
    r.chain.mints_fail = error
    r.rec.step()
    assert "mints" in r.rec.disabled
    events = [t["event"] for t in r.stream("tasks")]
    assert "task_disabled" in events and "queue_dropped" in events
    r.clock.advance(5 * M)
    r.rec.step()
    assert [s["pool"] for s in r.stream("pair_snapshots")] == ["P1"], "snapshots still work"
    r.clock.advance(timedelta(seconds=150))
    r.discovery.pages = {1: [pool(2, T0 + 3 * M, dex="meteora"), pool(1, T0, dex="meteora")]}
    r.rec.step()
    assert len(r.chain.mint_calls) == 1, "a switched-off task is never called again"
    assert r.rec.backlog()["mints"] == 0, "and no work piles up for it"


def test_snapshot_source_errors_record_the_lost_snapshots(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.discovery.pages = {1: [pool(1, T0, dex="meteora")]}
    r.rec.step()
    r.clock.advance(5 * M)
    r.snapshots.fail = HttpError("HTTP 502", url="x", status=502)
    r.rec.step()
    assert [(s["pool"], s["reason"]) for s in r.stream("snapshot_skipped")] == [("P1", "source_error")]


def test_creation_counter_baseline_counts_and_overflow(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.chain.sig_batches = [
        [Sig("s3", 30), Sig("s2", 20)],
        [Sig("s5", 50), Sig("s4", 40, failed=True)],
        [Sig(f"x{i}", 100 + i) for i in range(1000)],
    ]
    r.rec.step()
    for _ in range(2):
        r.clock.advance(timedelta(seconds=60))
        r.rec.step()
    counts = r.stream("pump_creations")
    assert [c["baseline"] for c in counts] == [True, False, False]
    assert (counts[1]["count"], counts[1]["failed"], counts[1]["newest_signature"]) == (2, 1, "s5")
    assert r.chain.sig_calls == [None, "s3", "s5"], "each count continues from the newest seen"
    assert counts[2]["overflow"] is True
    assert [g["kind"] for g in r.stream("coverage") if g.get("event") == "gap"] == ["creation_count_overflow"]


def test_restart_resumes_from_the_journal(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.chain.sig_batches = [[Sig("s9", 90)]]
    r.discovery.pages = {1: [pool(1, T0, dex="meteora")]}
    r.rec.step()
    r.clock.advance(5 * M)
    r.rec.step()
    r.journal.close()

    again = Rig(tmp_path)
    again.clock.set(T0 + 15 * M)
    again.rec.restore(
        again.stream("pools"),
        again.stream("pair_snapshots"),
        again.stream("mint_facts"),
        again.stream("pump_creations"),
    )
    assert "P1" in again.rec.schedule
    again.rec.step()
    assert [(s["pool"], s["target_age_minutes"]) for s in again.stream("pair_snapshots")] == [
        ("P1", 5.0),
        ("P1", 15.0),
    ], "the 5-minute snapshot is not repeated"
    assert again.stream("snapshot_skipped") == [], "done ages are not re-scheduled (and then skipped)"
    assert again.chain.sig_calls == ["s9"]
    assert not [p for p in again.stream("pools") if p["pool_address"] == "P1"][1:], "not re-recorded"


def test_the_loop_never_spins(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.discovery.pages = {1: [pool(1, T0, dex="meteora")]}
    pause = r.rec.step()
    assert timedelta(milliseconds=200) <= pause <= timedelta(seconds=5)
    r.clock.advance(timedelta(seconds=10))
    assert r.rec.step() >= timedelta(milliseconds=200)


def test_settings_refuse_rates_above_the_free_limits() -> None:
    with pytest.raises(ValueError, match=r"1\.\.10"):
        RecorderSettings(discovery_pages=11)
    with pytest.raises(ValueError, match="rate limit"):
        RecorderSettings(discovery_interval=timedelta(seconds=30))
    with pytest.raises(ValueError, match="holders_per_mille"):
        RecorderSettings(snapshot_per_mille=100, holders_per_mille=200)
    assert RecorderSettings().holders_within_sample_per_mille == 200
