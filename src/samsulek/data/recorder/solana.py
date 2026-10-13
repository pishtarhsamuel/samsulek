"""The Solana new-pool recorder (research data only; it never trades).

What it writes (journal streams under <data>/solana/):
  pools            every new pool seen in GeckoTerminal's new-pool feed (all of them)
  gt_pages         one line per feed page fetched (as-of time, how many pools)
  pump_creations   how many pump.fun tokens were created on-chain per interval (a
                   completeness check on the feed: it misses pools when it moves fast)
  mint_facts       mint/freeze authority, supply, Token-2022 extensions for each new token
  pair_snapshots   DexScreener state of SAMPLED pools at fixed ages after creation
  pair_missing     sampled pools DexScreener did not return (absent != rugged)
  snapshot_skipped snapshots that could not be taken on time (recorder down or behind)
  curve_states     pump.fun bonding-curve state at each snapshot of a pump.fun pool
  holders          top holders of a smaller sample, at a few ages
  tasks            a task switched off after an error it must not guess past
  coverage         heartbeats, and gaps (downtime, source outages, feed overruns)

Sampling is by a hash of the pool address, so it can't favour survivors. Pools outside
the sample still get their discovery record and safety facts.
"""

from __future__ import annotations

import dataclasses
import logging
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol

from samsulek.clock import Clock
from samsulek.data.recorder.coverage import Coverage
from samsulek.data.recorder.journal import Journal
from samsulek.data.recorder.schedule import Due, SnapshotSchedule, in_sample
from samsulek.data.sources.solana_rpc import SolanaRpcError
from samsulek.net.http import HttpError

log = logging.getLogger(__name__)

MINUTE = timedelta(minutes=1)
PUMP_FUN_DEX = "pump-fun"  # GeckoTerminal's dex id for pump.fun bonding curves
# JSON-RPC errors that only mean "ask again shortly" (verified 2026-10-13): -32005 node is
# behind (docs, getHealth), -32016 minimum context slot not reached (agave CHANGELOG). Any
# other RPC error code switches the task off: never guess past an error we don't know.
TRANSIENT_RPC_CODES = frozenset({-32005, -32016})
# A source that fails transiently is left alone for 30 s, then 1, 2, 4, 8 and at most 10 min.
SOURCE_PAUSE_FIRST = timedelta(seconds=30)
SOURCE_PAUSE_MAX = timedelta(minutes=10)


# --------------------------------------------------------------- source shapes
class _NewPool(Protocol):
    @property
    def pool_address(self) -> str: ...
    @property
    def dex_id(self) -> str: ...
    @property
    def base_mint(self) -> str: ...
    @property
    def pool_created_at(self) -> datetime: ...


class _NewPoolsPage(Protocol):
    @property
    def pools(self) -> Sequence[_NewPool]: ...
    @property
    def as_of(self) -> datetime: ...
    @property
    def fetched_at(self) -> datetime: ...


class Discovery(Protocol):
    def new_pools(self, page: int) -> _NewPoolsPage: ...


class _PairsBatch(Protocol):
    @property
    def found(self) -> Mapping[str, Any]: ...
    @property
    def missing(self) -> Sequence[str]: ...
    @property
    def as_of(self) -> datetime: ...
    @property
    def fetched_at(self) -> datetime: ...


class Snapshots(Protocol):
    def pairs(self, addresses: Sequence[str]) -> _PairsBatch: ...


class _Signature(Protocol):
    @property
    def signature(self) -> str: ...
    @property
    def slot(self) -> int: ...
    @property
    def failed(self) -> bool: ...


class _MintsResult(Protocol):
    @property
    def slot(self) -> int: ...
    @property
    def facts(self) -> Mapping[str, Any]: ...


class _RawAccount(Protocol):
    @property
    def owner(self) -> str: ...
    @property
    def data(self) -> bytes: ...


class _Holders(Protocol):
    @property
    def slot(self) -> int: ...
    @property
    def holders(self) -> Sequence[tuple[str, int]]: ...


class Chain(Protocol):
    def signatures(
        self, address: str, *, until: str | None = None, before: str | None = None, limit: int = 1000
    ) -> Sequence[_Signature]: ...
    def mints(self, addresses: Sequence[str]) -> _MintsResult: ...
    def accounts_raw(self, addresses: Sequence[str]) -> tuple[int, Mapping[str, _RawAccount | None]]: ...
    def token_holders(self, mint: str, token_program_id: str) -> _Holders: ...


@dataclass(frozen=True)
class PumpFun:
    """pump.fun facts the recorder needs (verified in sources/pumpfun.py)."""

    program_id: str
    mint_authority_pda: str
    decode_curve: Callable[[bytes], Any]


# ------------------------------------------------------------------- settings
@dataclass(frozen=True)
class RecorderSettings:
    discovery_pages: int = 10  # GeckoTerminal serves at most 10 pages of 20 pools
    discovery_interval: timedelta = timedelta(seconds=150)
    creation_count_interval: timedelta = timedelta(seconds=60)
    snapshot_ages: tuple[timedelta, ...] = (
        5 * MINUTE,
        15 * MINUTE,
        60 * MINUTE,
        240 * MINUTE,
        24 * 60 * MINUTE,
        72 * 60 * MINUTE,
    )
    snapshot_per_mille: int = 250
    holders_per_mille: int = 50
    holders_ages: tuple[timedelta, ...] = (15 * MINUTE, 24 * 60 * MINUTE)
    mint_batch_interval: timedelta = timedelta(seconds=30)
    curve_batch_interval: timedelta = timedelta(seconds=10)
    max_holder_queue: int = 500  # beyond this, holder jobs are skipped (and recorded)

    def __post_init__(self) -> None:
        if not 1 <= self.discovery_pages <= 10:
            raise ValueError("discovery_pages must be 1..10")
        if self.discovery_interval < timedelta(seconds=60):
            raise ValueError("discovery_interval below 60 s would exceed the free rate limit")
        if not set(self.holders_ages) <= set(self.snapshot_ages):
            raise ValueError("holders_ages must be among snapshot_ages")
        if not 0 <= self.holders_per_mille <= self.snapshot_per_mille <= 1000:
            raise ValueError("need 0 <= holders_per_mille <= snapshot_per_mille <= 1000")

    @property
    def holders_within_sample_per_mille(self) -> int:
        """Holder lists come from a sub-sample of the snapshot sample."""
        if self.snapshot_per_mille == 0:
            return 0
        return min(1000, round(self.holders_per_mille * 1000 / self.snapshot_per_mille))


TASKS = ("discovery", "creations", "mints", "snapshots", "curves", "holders")
SOURCE_OF = {
    "discovery": "geckoterminal",
    "creations": "solana_rpc",
    "mints": "solana_rpc",
    "snapshots": "dexscreener",
    "curves": "solana_rpc",
    "holders": "solana_rpc",
}


def _plain(obj: Any) -> Any:
    """A dataclass (or mapping of them) as plain JSON-able data."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    if isinstance(obj, Mapping):
        return {str(k): _plain(v) for k, v in obj.items()}
    return obj


class SolanaRecorder:
    def __init__(
        self,
        *,
        discovery: Discovery,
        snapshots: Snapshots,
        chain: Chain,
        pump: PumpFun,
        journal: Journal,
        coverage: Coverage,
        clock: Clock,
        settings: RecorderSettings | None = None,
    ) -> None:
        self.s = settings or RecorderSettings()
        self._discovery = discovery
        self._snapshots = snapshots
        self._chain = chain
        self._pump = pump
        self._journal = journal
        self._coverage = coverage
        self._clock = clock
        self.schedule = SnapshotSchedule(self.s.snapshot_ages)
        self._seen: set[str] = set()
        self._pool_info: dict[str, tuple[str, str]] = {}  # tracked pool -> (dex_id, base_mint)
        self._mint_program: dict[str, str] = {}  # mint -> owning token program id
        self._mint_queue: deque[str] = deque()
        self._queued_mints: set[str] = set()
        self._curve_queue: deque[tuple[str, Due]] = deque()
        self._holder_queue: deque[tuple[str, str, Due]] = deque()  # (pool, mint, due)
        self._newest_seen_created: datetime | None = None
        self._last_creation_sig: str | None = None
        self._last_creation_check: datetime | None = None
        self._next: dict[str, datetime] = {}
        self._source_pause: dict[str, timedelta] = {}  # source -> current pause after failures
        self._source_retry_at: dict[str, datetime] = {}
        self.disabled: dict[str, str] = {}

    # ----------------------------------------------------------- bookkeeping
    def _write(self, stream: str, record: Mapping[str, Any]) -> None:
        self._journal.append(stream, record)

    def _due(self, task: str, now: datetime) -> bool:
        return (
            task not in self.disabled
            and self._next.get(task, now) <= now
            and self._source_retry_at.get(SOURCE_OF[task], now) <= now
        )

    def _run(self, task: str, now: datetime, fn: Callable[[], None], every: timedelta) -> None:
        """Run one task. Transient HTTP problems: retry later (a coverage gap is open
        meanwhile). Anything else - a format the code doesn't know, a block, a bug -
        switches the task off: never guess past it."""
        source = SOURCE_OF[task]
        try:
            fn()
        except HttpError as exc:
            if exc.status in (401, 403):  # blocked / not allowed: don't hammer
                self._disable(task, f"{type(exc).__name__}: {exc}")
            else:
                self._source_down(source, f"{type(exc).__name__}: {exc}")
        except SolanaRpcError as exc:
            if exc.code in TRANSIENT_RPC_CODES:
                self._source_down(source, f"{type(exc).__name__}: {exc}")
            else:
                self._disable(task, f"{type(exc).__name__}: {exc}")
        except Exception as exc:
            self._disable(task, f"{type(exc).__name__}: {exc}")
        else:
            self._source_pause.pop(source, None)
            self._source_retry_at.pop(source, None)
            self._coverage.source_ok(source)
        finally:
            self._next[task] = now + every

    def _source_down(self, source: str, error: str) -> None:
        """Pause every task of a failing source, longer each time, so one dead provider
        (whose calls block while they retry) can't starve the others."""
        pause = self._source_pause.get(source)
        pause = SOURCE_PAUSE_FIRST if pause is None else min(pause * 2, SOURCE_PAUSE_MAX)
        self._source_pause[source] = pause
        self._source_retry_at[source] = self._clock.now() + pause
        self._coverage.source_failed(source, error)

    def _disable(self, task: str, reason: str) -> None:
        self.disabled[task] = reason
        queues: dict[str, deque[Any]] = {
            "mints": self._mint_queue,
            "curves": self._curve_queue,
            "holders": self._holder_queue,
        }
        dropped = queues.get(task)
        if dropped:
            self._write("tasks", {"event": "queue_dropped", "task": task, "items": len(dropped)})
            dropped.clear()
        if task == "mints":
            self._queued_mints.clear()
        self._coverage.source_failed(SOURCE_OF[task], reason)
        self._write("tasks", {"event": "task_disabled", "task": task, "reason": reason[:500]})
        log.error("recorder task %s switched off: %s", task, reason)

    # ------------------------------------------------------------- the loop
    def step(self) -> timedelta:
        """Do whatever is due now. Returns how long the caller may sleep."""
        now = self._clock.now()
        if self._due("discovery", now):
            self._run("discovery", now, self._discover, self.s.discovery_interval)
        if self._due("creations", now):
            self._run("creations", now, self._count_creations, self.s.creation_count_interval)
        if self._mint_queue and self._due("mints", now):
            self._run("mints", now, self._fetch_mint_facts, self.s.mint_batch_interval)
        if self._due("snapshots", now) and (nxt := self.schedule.next_due_at()) is not None and nxt <= now:
            self._run("snapshots", now, self._snapshot_due, timedelta(0))
        if self._curve_queue and self._due("curves", now):
            self._run("curves", now, self._fetch_curves, self.s.curve_batch_interval)
        if self._holder_queue and self._due("holders", now):
            self._run("holders", now, self._fetch_one_holder_list, timedelta(seconds=2))
        self._coverage.beat()
        return self._sleep_hint(now)

    def backlog(self) -> dict[str, int]:
        """Work waiting, for status output (and to show nothing grows without bound)."""
        return {
            "tracked_pools": len(self.schedule),
            "mints": len(self._mint_queue),
            "curves": len(self._curve_queue),
            "holders": len(self._holder_queue),
        }

    def _sleep_hint(self, now: datetime) -> timedelta:
        wake = [t for task, t in self._next.items() if task not in self.disabled and task != "snapshots"]
        nxt = self.schedule.next_due_at()
        if nxt is not None:
            wake.append(nxt)
        if not wake:
            return timedelta(seconds=5)
        return min(max(min(wake) - now, timedelta(milliseconds=200)), timedelta(seconds=5))

    def start(self) -> None:
        self._coverage.start()

    def stop(self) -> None:
        """Record what was still waiting (it is not carried over to the next run), then stop."""
        for task, queue in (
            ("mints", self._mint_queue),
            ("curves", self._curve_queue),
            ("holders", self._holder_queue),
        ):
            if queue:
                self._write(
                    "tasks", {"event": "queue_dropped", "task": task, "items": len(queue), "reason": "stop"}
                )
        self._coverage.stop()

    def run(self, sleep: Callable[[float], None], should_stop: Callable[[], bool]) -> None:
        self.start()
        try:
            while not should_stop():
                pause = self.step()
                sleep(pause.total_seconds())
        finally:
            self.stop()

    # ------------------------------------------------------------ discovery
    def _discover(self) -> None:
        previous_newest = self._newest_seen_created
        known_before = set(self._seen)  # pools known before this round started
        overlapped = previous_newest is None
        oldest_this_round: datetime | None = None
        for page_no in range(1, self.s.discovery_pages + 1):
            page = self._discovery.new_pools(page_no)
            new = [p for p in page.pools if p.pool_address not in self._seen]
            old = sum(1 for p in page.pools if p.pool_address in known_before)
            self._write(
                "gt_pages",
                {
                    "page": page_no,
                    "as_of": page.as_of,
                    "fetched_at": page.fetched_at,
                    "pools": len(page.pools),
                    "new": len(new),
                    "known_before": old,
                },
            )
            for p in page.pools:
                if oldest_this_round is None or p.pool_created_at < oldest_this_round:
                    oldest_this_round = p.pool_created_at
            if old:
                overlapped = True
            for p in new:
                self._on_new_pool(p, page)
            if not page.pools:
                break  # the feed ended: later pages are empty too
            if old == len(page.pools):
                break  # a page of pools we already knew: older pages hold nothing new
        if not overlapped and previous_newest is not None and oldest_this_round is not None:
            # Every pool on every page was new: pools created between the last round's
            # newest and this round's oldest may have scrolled past unseen.
            self._write(
                "coverage",
                {
                    "event": "gap",
                    "kind": "discovery_overrun",
                    "start": previous_newest,
                    "end": oldest_this_round,
                    "recorder": "solana",
                    "seconds": round((oldest_this_round - previous_newest).total_seconds(), 3),
                },
            )

    def _on_new_pool(self, p: _NewPool, page: _NewPoolsPage) -> None:
        self._seen.add(p.pool_address)
        if self._newest_seen_created is None or p.pool_created_at > self._newest_seen_created:
            self._newest_seen_created = p.pool_created_at
        sampled = in_sample(p.pool_address, self.s.snapshot_per_mille, "snapshots")
        holders = sampled and in_sample(p.pool_address, self.s.holders_within_sample_per_mille, "holders")
        self._write(
            "pools",
            {
                **_plain(p),
                "discovered_at": page.fetched_at,
                "as_of": page.as_of,
                "snapshot_sampled": sampled,
                "holders_sampled": holders,
            },
        )
        if (
            "mints" not in self.disabled
            and p.base_mint not in self._queued_mints
            and p.base_mint not in self._mint_program
        ):
            self._queued_mints.add(p.base_mint)
            self._mint_queue.append(p.base_mint)
        if sampled:
            self._pool_info[p.pool_address] = (p.dex_id, p.base_mint)
            self.schedule.add(p.pool_address, p.pool_created_at)

    # -------------------------------------------------------- creation counter
    def _count_creations(self) -> None:
        now = self._clock.now()
        sigs = self._chain.signatures(
            self._pump.mint_authority_pda, until=self._last_creation_sig, limit=1000
        )
        # First look: only remember where we are; the history before it isn't counted.
        baseline = self._last_creation_sig is None
        overflow = len(sigs) >= 1000
        self._write(
            "pump_creations",
            {
                "window_start": self._last_creation_check,
                "window_end": now,
                "baseline": baseline,
                "count": len(sigs),
                "failed": sum(1 for s in sigs if s.failed),
                "newest_signature": sigs[0].signature if sigs else self._last_creation_sig,
                "newest_slot": sigs[0].slot if sigs else None,
                "overflow": overflow,
            },
        )
        if overflow and not baseline:
            self._write(
                "coverage",
                {
                    "event": "gap",
                    "kind": "creation_count_overflow",
                    "start": self._last_creation_check,
                    "end": now,
                    "recorder": "solana",
                },
            )
        if sigs:
            self._last_creation_sig = sigs[0].signature
        self._last_creation_check = now

    # ------------------------------------------------------------ mint facts
    def _fetch_mint_facts(self) -> None:
        batch = [self._mint_queue.popleft() for _ in range(min(100, len(self._mint_queue)))]
        try:
            result = self._chain.mints(batch)
        except Exception:
            self._mint_queue.extendleft(reversed(batch))  # retry them next time
            raise
        for mint in batch:
            self._queued_mints.discard(mint)
            facts = result.facts.get(mint)
            record = _plain(facts) if facts is not None else None
            if isinstance(record, dict) and isinstance(record.get("owner"), str):
                self._mint_program[mint] = record["owner"]
            self._write("mint_facts", {"mint": mint, "slot": result.slot, "facts": record})

    # ------------------------------------------------------------- snapshots
    def _snapshot_due(self) -> None:
        now = self._clock.now()
        take, skipped = self.schedule.take_due(now, 30)
        for d in skipped:
            self._write(
                "snapshot_skipped",
                {"pool": d.pool, "target_age_minutes": d.age / MINUTE, "due_at": d.due_at, "reason": "late"},
            )
        if not take:
            return
        try:
            batch = self._snapshots.pairs([d.pool for d in take])
        except Exception:
            for d in take:  # these snapshots won't happen: say so, then report the error
                self._write(
                    "snapshot_skipped",
                    {
                        "pool": d.pool,
                        "target_age_minutes": d.age / MINUTE,
                        "due_at": d.due_at,
                        "reason": "source_error",
                    },
                )
            raise
        for d in take:
            info = self._pool_info.get(d.pool)
            target = d.age / MINUTE
            if d.pool in batch.found:
                self._write(
                    "pair_snapshots",
                    {
                        "pool": d.pool,
                        "target_age_minutes": target,
                        "due_at": d.due_at,
                        "as_of": batch.as_of,
                        "fetched_at": batch.fetched_at,
                        "pair": _plain(batch.found[d.pool]),
                    },
                )
            else:
                self._write(
                    "pair_missing",
                    {"pool": d.pool, "target_age_minutes": target, "due_at": d.due_at, "as_of": batch.as_of},
                )
            if info is not None and info[0] == PUMP_FUN_DEX and "curves" not in self.disabled:
                self._curve_queue.append((d.pool, d))
            if (
                info is not None
                and d.age in self.s.holders_ages
                and "holders" not in self.disabled
                and in_sample(d.pool, self.s.holders_within_sample_per_mille, "holders")
            ):
                if len(self._holder_queue) >= self.s.max_holder_queue:
                    self._write(
                        "snapshot_skipped",
                        {
                            "pool": d.pool,
                            "target_age_minutes": target,
                            "due_at": d.due_at,
                            "reason": "holder_queue_full",
                        },
                    )
                else:
                    self._holder_queue.append((d.pool, info[1], d))
            if d.age == self.s.snapshot_ages[-1]:
                self._pool_info.pop(d.pool, None)

    # ---------------------------------------------------------------- curves
    def _fetch_curves(self) -> None:
        batch = [self._curve_queue.popleft() for _ in range(min(100, len(self._curve_queue)))]
        try:
            slot, accounts = self._chain.accounts_raw([pool for pool, _ in batch])
        except Exception:
            self._curve_queue.extendleft(reversed(batch))  # retried next time (or dropped if switched off)
            raise
        for pool, d in batch:
            account = accounts.get(pool)
            record: dict[str, Any] = {"pool": pool, "slot": slot, "target_age_minutes": d.age / MINUTE}
            if account is None:
                record["state"] = None  # closed or never existed: recorded, not dropped
            elif account.owner != self._pump.program_id:
                record["error"] = f"owned by {account.owner}, not the pump.fun program"
            else:
                try:
                    record["state"] = _plain(self._pump.decode_curve(account.data))
                except ValueError as exc:  # an unknown layout: record it, don't guess
                    record["error"] = f"undecodable: {exc}"
            self._write("curve_states", record)

    # --------------------------------------------------------------- holders
    def _fetch_one_holder_list(self) -> None:
        pool, mint, d = self._holder_queue.popleft()
        program = self._mint_program.get(mint)
        if program is None:
            self._write(
                "holders",
                {
                    "pool": pool,
                    "mint": mint,
                    "target_age_minutes": d.age / MINUTE,
                    "error": "token program unknown",
                },
            )
            return
        try:
            result = self._chain.token_holders(mint, program)
        except Exception:
            self._holder_queue.appendleft((pool, mint, d))
            raise
        ranked = sorted(result.holders, key=lambda h: h[1], reverse=True)
        total = sum(a for _, a in ranked)
        self._write(
            "holders",
            {
                "pool": pool,
                "mint": mint,
                "target_age_minutes": d.age / MINUTE,
                "slot": result.slot,
                "accounts": len(ranked),
                "total_amount": total,
                "top": [{"owner": o, "amount": a} for o, a in ranked[:20]],
            },
        )

    # --------------------------------------------------------------- restart
    @property
    def restore_window(self) -> timedelta:
        """How far back restore() needs the journal: the oldest snapshot age plus slack."""
        return self.s.snapshot_ages[-1] + timedelta(hours=2)

    def restore(
        self,
        pools: Sequence[Mapping[str, Any]],
        snapshot_records: Sequence[Mapping[str, Any]],
        mint_facts: Sequence[Mapping[str, Any]],
        creations: Sequence[Mapping[str, Any]],
    ) -> None:
        """Rebuild state from the journal after a restart (records in file order)."""
        horizon = self._clock.now() - self.restore_window + timedelta(hours=1)
        # Ages already handled per pool. Distinct ages, not records: one age can leave two
        # records (a snapshot, then a holder list skipped because the queue was full).
        handled: dict[str, set[object]] = {}
        for r in snapshot_records:
            pool = r.get("pool")
            if isinstance(pool, str):
                handled.setdefault(pool, set()).add(r.get("target_age_minutes"))
        done = {pool: len(ages) for pool, ages in handled.items()}
        for r in mint_facts:
            facts = r.get("facts")
            if isinstance(facts, dict) and isinstance(facts.get("owner"), str):
                self._mint_program[str(r["mint"])] = facts["owner"]
        for r in pools:
            address = str(r["pool_address"])
            created = datetime.fromisoformat(str(r["pool_created_at"]))
            self._seen.add(address)
            if self._newest_seen_created is None or created > self._newest_seen_created:
                self._newest_seen_created = created
            if r.get("snapshot_sampled") and created >= horizon:
                self._pool_info[address] = (str(r["dex_id"]), str(r["base_mint"]))
                self.schedule.add(address, created, done=done.get(address, 0))
        for r in reversed(creations):
            sig = r.get("newest_signature")
            if isinstance(sig, str):
                self._last_creation_sig = sig
                break
