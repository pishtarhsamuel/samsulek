"""`samsulek record solana`: the Solana recorder with the real free sources.

Runs until Ctrl+C (or for ``minutes``), one run at a time (an OS lock on
``<data>/solana/run.lock``). On start it reads the journal back so a restart neither
repeats nor forgets due snapshots, and compacts journal days older than a week; while
running it compacts again once a day and prints a short progress line every half hour.
Simulation research only: nothing here can trade.
"""

from __future__ import annotations

import logging
import time
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from samsulek.clock import Clock
from samsulek.config import RecorderConfig
from samsulek.data.recorder import maintenance
from samsulek.data.recorder.coverage import Coverage
from samsulek.data.recorder.journal import Journal, read_stream
from samsulek.data.recorder.solana import PumpFun, RecorderSettings, SolanaRecorder
from samsulek.data.sources import dexscreener, geckoterminal, pumpfun, solana_rpc
from samsulek.net.http import HttpClient

log = logging.getLogger(__name__)

FOLDER = "solana"
RECORDER = "solana"  # Coverage name: the heartbeat file is maintenance.HEARTBEAT
COMPACT_EVERY = timedelta(days=1)
PROGRESS_EVERY = timedelta(minutes=30)
SNAPSHOT_STREAMS = ("pair_snapshots", "pair_missing", "snapshot_skipped")


def recorder_root(data_dir: Path) -> Path:
    return data_dir / FOLDER


def settings_from(cfg: RecorderConfig) -> RecorderSettings:
    return RecorderSettings(
        discovery_pages=cfg.discovery_pages,
        discovery_interval=timedelta(seconds=cfg.discovery_interval_seconds),
        snapshot_per_mille=cfg.snapshot_per_mille,
        holders_per_mille=cfg.holders_per_mille,
    )


def build_http(user_agent: str, rpc_url: str, **kw: object) -> HttpClient:
    """One client for the three providers, each host with its own rate limit."""
    rpc_host = (urllib.parse.urlsplit(rpc_url).hostname or "").lower()
    limiters = {
        geckoterminal.HOST: geckoterminal.limiter(),
        dexscreener.HOST: dexscreener.limiter(),
        rpc_host: solana_rpc.limiter(),
    }
    return HttpClient(
        user_agent=user_agent,
        allowed_hosts=frozenset(limiters),
        limiters=limiters,
        # The recorder does one thing at a time, so a call stuck in retries holds up every
        # other source. Two quick retries, then the recorder pauses that source instead.
        retries=2,
        **kw,  # type: ignore[arg-type]  # test hooks: opener, sleep, now
    )


def build_recorder(
    root: Path, cfg: RecorderConfig, http: HttpClient, journal: Journal, clock: Clock
) -> SolanaRecorder:
    return SolanaRecorder(
        discovery=geckoterminal.GeckoTerminalSource(http),
        snapshots=dexscreener.DexScreenerSource(http),
        chain=solana_rpc.SolanaRpc(http, cfg.solana_rpc_url),
        pump=PumpFun(pumpfun.PROGRAM_ID, pumpfun.MINT_AUTHORITY_PDA, pumpfun.decode_bonding_curve),
        journal=journal,
        coverage=Coverage(journal, root, clock, RECORDER),
        clock=clock,
        settings=settings_from(cfg),
    )


def restore_from_journal(rec: SolanaRecorder, root: Path, now: datetime) -> int:
    """Rebuild the recorder's schedule from the journal. Returns the pools tracked again."""
    since = now - rec.restore_window
    if since <= now - maintenance.RAW_KEEP:
        raise RuntimeError("restore window is not covered by the raw journal; raise RAW_KEEP")
    snapshots = [r for stream in SNAPSHOT_STREAMS for r in read_stream(root, stream, since=since)]
    rec.restore(
        list(read_stream(root, "pools", since=since)),
        snapshots,
        list(read_stream(root, "mint_facts", since=since)),
        list(read_stream(root, "gt_pages", since=since)),
    )
    return len(rec.schedule)


@dataclass
class Housekeeping:
    """Work done between recorder steps: daily compaction and the progress line."""

    root: Path
    rec: SolanaRecorder
    clock: Clock
    say: Callable[[str], None]
    next_compact: datetime | None = None
    next_progress: datetime | None = None
    compacted_days: list[str] = field(default_factory=list)

    def __call__(self) -> None:
        now = self.clock.now()
        if self.next_compact is None or now >= self.next_compact:
            self.next_compact = now + COMPACT_EVERY
            try:
                report = maintenance.compact(self.root, now)
            except Exception as exc:  # compaction is optional: never stop recording for it
                log.warning("journal compaction failed: %s: %s", type(exc).__name__, exc)
            else:
                self.compacted_days += report.days_written
                for line in report.skipped:
                    log.warning("compaction skipped %s", line)
        if self.next_progress is None or now >= self.next_progress:
            self.next_progress = now + PROGRESS_EVERY
            self.say(progress_line(self.rec, now))


def progress_line(rec: SolanaRecorder, now: datetime) -> str:
    backlog = rec.backlog()
    parts = [
        f"{now:%Y-%m-%d %H:%M} UTC recording",
        f"tracking {backlog['tracked_pools']} pools",
        f"waiting: {backlog['mints']} mints, {backlog['curves']} curves, {backlog['holders']} holder lists",
    ]
    if rec.disabled:
        parts.append(f"SWITCHED OFF: {', '.join(sorted(rec.disabled))}")
    return "; ".join(parts)


def run_recorder(
    root: Path,
    rec: SolanaRecorder,
    clock: Clock,
    say: Callable[[str], None],
    *,
    minutes: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Restore, then step until Ctrl+C or ``minutes``. Always records the stop."""
    tracked = restore_from_journal(rec, root, clock.now())
    say(f"Resumed {tracked} pools with snapshots still due." if tracked else "Starting fresh.")
    deadline = clock.now() + timedelta(minutes=minutes) if minutes is not None else None
    chores = Housekeeping(root, rec, clock, say)
    rec.start()
    try:
        while deadline is None or clock.now() < deadline:
            pause = rec.step()
            chores()
            sleep(pause.total_seconds())
    except KeyboardInterrupt:
        say("Stopping (Ctrl+C)...")
    finally:
        rec.stop()
