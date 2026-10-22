"""P1: the bot's own disk-backed cycle and the backtest's in-memory path agree exactly.

Disk path: for every session a fresh ``build_app`` on a tmp project root (as one
``samsulek run`` process per day), with the production ``BacktestFeed`` as its feed and as
its broker's price source (and the backtest's cost model as the broker's pricer), then
``run_cycle``: the RunLock, the disk risk store, ledger, simulated broker file and
decision log. The owner's resets go through ``cli.main reset-halt`` (``--rebase-peak``
after a drawdown halt), with the terminal faked.

Memory path: ``build_parts`` plus ``run_unlocked_cycle`` plus ``apply_reset_policy`` by
hand, session by session, AND ``run_backtest`` on the same job: the runner's records
must be the hand loop's.

Planted in the data (Xetra sessions 2023-10-02 .. 2024-06-28: the October DST switch,
Christmas, Easter and the March DST switch): a gap-down daily-loss halt; the re-halt trap
(the reset leaves the day's baseline alone, so a second gap-down at the next open halts
again before any order); and a crash that trips daily loss and drawdown, reset with
--rebase-peak so the next session trades again. Identical on both paths, session by
session: every CycleReport, every fill field, ledger cash and positions, read_day,
read_peak, the halt and kill flags; and at the end the full risk-state history (every field;
only who cleared a halt differs) and the full decision-log stream, alert records included.

Isolation: the disk path runs in a tmp copy of config/, ops/ and the research limits; it
never touches the real project's state/, logs/ or secrets file (env loading would fail the
test).
"""

from __future__ import annotations

import contextlib
import gzip
import io
import json
import shutil
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from samsulek import cli
from samsulek.app import build_app
from samsulek.backtest.clock import session_times
from samsulek.backtest.dataset import Listing, PitDataset
from samsulek.backtest.feed import BacktestFeed
from samsulek.backtest.fence import RESEARCH_DATA_CUTOFF
from samsulek.backtest.halts import MODELED_OWNER, apply_reset_policy, classify_halt
from samsulek.backtest.limits import RESEARCH_RISK_FILE, load_mode_configs
from samsulek.backtest.plans import plan_window, strategy_for_session
from samsulek.backtest.runner import build_parts, run_backtest
from samsulek.backtest.sources import SourceData
from samsulek.backtest.synthetic_data import synthetic_daily_bars
from samsulek.backtest.types import (
    Detail,
    EngineContext,
    ExecutionTiming,
    HaltKind,
    RegistryPlan,
    RiskMode,
    RunJob,
)
from samsulek.clock import FixedClock, SystemClock
from samsulek.costs.stocks import StockCostModel, StockCostParams
from samsulek.cycle import CycleReport, CycleSpec, run_cycle, run_unlocked_cycle
from samsulek.data.calendars import XetraCalendar
from samsulek.risk.state import DayState, FlagState, RiskStateStore
from samsulek.strategies.params import as_params
from samsulek.types import Fill, Market, Mode, Position

ROOT = Path(__file__).resolve().parents[1]
CAL = XetraCalendar()
SYMS = ("DEMO_BONDS", "DEMO_EQUITY", "DEMO_GOLD")  # the default config's universe, sorted
FIRST, LAST = date(2023, 10, 2), date(2024, 6, 28)
HALT_1, REHALT, CRASH = date(2023, 12, 12), date(2023, 12, 13), date(2024, 4, 16)
GAPS = {HALT_1: 0.95, REHALT: 0.955, CRASH: 0.72}  # every price from that open on, times this
TIMING = ExecutionTiming()
PLAN = RegistryPlan(
    "demo_above_average",
    (
        (FIRST, as_params({"lookback": 10, "gross": 0.9})),
        (date(2024, 2, 1), as_params({"lookback": 20, "gross": 0.9})),
    ),
)
COSTS = StockCostParams(
    half_spread_bps={s: Decimal(10) for s in SYMS},
    slippage_bps=Decimal(5),
    adverse_bps=Decimal(0),
    fx_fee_bps=Decimal(15),
    commission_eur=Decimal(0),
    currency={s: "EUR" for s in SYMS},
)
JOB = RunJob(
    index=0,
    label="parity_L_1x",
    plan=PLAN,
    universe=SYMS,
    min_history=20,
    first_session=FIRST,
    last_session=LAST,
    risk_mode=RiskMode.L,
    cost_multiplier=1,
    starting_cash_eur=Decimal(50),
    detail=Detail.FULL,
)


def _dataset() -> PitDataset:
    raw = synthetic_daily_bars(
        SYMS, CAL, date(2023, 9, 1), LAST, seed=3, drift=0.0015, vol=0.006, gap_vol=0.003
    )
    rows = []
    for symbol in SYMS:
        factor = 1.0
        for bar in raw[symbol]:
            factor *= GAPS.get(bar.session, 1.0)
            assert bar.open is not None and bar.high is not None and bar.low is not None
            rows.append(
                replace(
                    bar,
                    open=bar.open * factor,
                    high=bar.high * factor,
                    low=bar.low * factor,
                    close=bar.close * factor,
                )
            )
    listings = tuple(Listing(s, "EUR", date(2023, 9, 1), None, None, "synthetic (test)") for s in SYMS)
    data = SourceData("synthetic", True, tuple(rows), listings, (), None)
    return PitDataset.build(data, calendar=CAL, cutoff=RESEARCH_DATA_CUTOFF)


@dataclass(frozen=True)
class SessionState:
    report: CycleReport
    fills: tuple[Fill, ...]
    cash: Decimal
    positions: dict[str, Position]
    day: DayState | None
    peak: Decimal | None
    halt: FlagState
    kill: FlagState


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A tmp project root: config (universe sorted), ops, and the research limits."""
    root = tmp_path / "project"
    shutil.copytree(ROOT / "config", root / "config")
    shutil.copytree(ROOT / "ops", root / "ops")
    (root / RESEARCH_RISK_FILE).parent.mkdir(parents=True)
    shutil.copy(ROOT / RESEARCH_RISK_FILE, root / RESEARCH_RISK_FILE)
    default = root / "config" / "default.yaml"
    text = default.read_text(encoding="utf-8")
    before = "stocks: [DEMO_EQUITY, DEMO_BONDS, DEMO_GOLD]"
    assert before in text, "the default universe changed: update this test"
    default.write_text(text.replace(before, f"stocks: [{', '.join(SYMS)}]"), encoding="utf-8")

    def no_secrets(*args: object, **kwargs: object) -> None:
        pytest.fail("the parity test must never load a secrets file")

    monkeypatch.setattr(cli, "load_env_file", no_secrets)
    monkeypatch.chdir(tmp_path)
    return root


@contextlib.contextmanager
def owner_at_terminal(when: Any) -> Iterator[list[str]]:
    """The owner typing the right code at a real terminal, at ``when``."""
    out = io.StringIO()
    with pytest.MonkeyPatch.context() as mp, contextlib.redirect_stdout(out):
        mp.setattr(cli, "require_interactive", lambda: None)
        mp.setattr(cli, "confirm_phrase", lambda prompt, expected: expected.startswith("RESET "))
        mp.setattr(SystemClock, "now", lambda self: when)
        lines: list[str] = []
        yield lines
    lines.extend(out.getvalue().splitlines())


class DiskPath:
    """One `samsulek run` per session on the tmp project, plus the owner's CLI resets."""

    def __init__(self, root: Path, dataset: PitDataset) -> None:
        self.root = root
        self.dataset = dataset
        self.clock = FixedClock(CAL.close_utc(CAL.previous_session(FIRST)))
        self.resets: list[tuple[date, bool, list[str]]] = []

    def reset_if_halted(self, session: date) -> None:
        halt = RiskStateStore(self.root / "state").read_halt()
        if not halt.active:
            return
        kinds = {classify_halt(r) for r in halt.reasons}
        assert None not in kinds, halt.reasons
        rebase = HaltKind.DRAWDOWN in kinds
        when = session_times(CAL, session, TIMING).reset_at
        self.clock.set(when)
        flags = ["--rebase-peak"] if rebase else []
        with owner_at_terminal(when) as lines:
            code = cli.main(["--root", str(self.root), "reset-halt", *flags])
        assert code == cli.EXIT_OK, lines
        self.resets.append((session, rebase, lines))

    def cycle(self, session: date) -> SessionState:
        times = session_times(CAL, session, TIMING)
        self.clock.set(times.execute)
        app = build_app(self.root, Path("config/default.yaml"), Mode.SIM, clock=self.clock)
        assert app.config.state_dir.is_relative_to(self.root)
        assert app.config.log_dir.is_relative_to(self.root)
        feed = BacktestFeed(
            self.dataset,
            clock=self.clock,
            universe=SYMS,
            window=plan_window(PLAN),
            exec_delay=TIMING.exec_delay,
        )
        app.feed = feed  # type: ignore[assignment]
        app.broker._prices = feed.quote
        app.broker._pricer = StockCostModel(COSTS, multiplier=JOB.cost_multiplier)
        app.strategy = strategy_for_session(PLAN, session)  # type: ignore[assignment]
        report = run_cycle(app)
        state = SessionState(
            report=report,
            fills=tuple(app.broker.fills_since(None)),
            cash=app.ledger.cash,
            positions=dict(app.ledger.positions),
            day=app.store.read_day(),
            peak=app.store.read_peak(),
            halt=app.store.read_halt(),
            kill=app.store.read_kill(),
        )
        self.clock.set(times.close_print)
        return state

    def decisions(self) -> list[dict[str, Any]]:
        files = sorted((self.root / "logs").glob("decisions-*.jsonl"))
        return [
            json.loads(line) for f in files for line in f.read_text(encoding="utf-8").splitlines() if line
        ]

    def history(self) -> list[dict[str, str]]:
        text = (self.root / "state" / "state_history.jsonl").read_text(encoding="utf-8")
        return [json.loads(line) for line in text.splitlines() if line]


class MemoryPath:
    """``build_parts`` + ``run_unlocked_cycle`` + ``apply_reset_policy``, by hand."""

    def __init__(self, ctx: EngineContext) -> None:
        self.ctx = ctx
        self.parts = build_parts(JOB, ctx)
        self.resets: list[tuple[date, Decimal | None]] = []

    def reset_if_halted(self, session: date) -> None:
        halt = self.parts.store.read_halt()
        if not halt.active:
            return
        kinds = [classify_halt(r) for r in halt.reasons]
        assert None not in kinds, halt.reasons
        at = session_times(CAL, session, TIMING).reset_at
        self.parts.clock.set(at)
        outcome = apply_reset_policy(self.parts.store, kinds=[k for k in kinds if k is not None], at=at)
        self.resets.append((session, outcome.peak_rebased_to))

    def cycle(self, session: date) -> SessionState:
        parts = self.parts
        times = session_times(CAL, session, TIMING)
        parts.clock.set(times.execute)
        universe = self.ctx.dataset.listed(session, at=times.execute, min_bars=JOB.min_history, among=SYMS)
        assert universe == SYMS
        spec = CycleSpec(
            market=Market.STOCKS,
            universe=universe,
            strategy=strategy_for_session(PLAN, session),
            quantity_step=self.ctx.quantity_step,
            price_tick=self.ctx.price_tick,
            calendar=parts.feed.calendar,
            bar_window=plan_window(PLAN),
        )
        report = run_unlocked_cycle(parts, spec)
        parts.log.drain_cycle()
        state = SessionState(
            report=report,
            fills=tuple(parts.broker.fills_since(None)),
            cash=parts.ledger.cash,
            positions=dict(parts.ledger.positions),
            day=parts.store.read_day(),
            peak=parts.store.read_peak(),
            halt=parts.store.read_halt(),
            kill=parts.store.read_kill(),
        )
        parts.clock.set(times.close_print)
        return state


def test_disk_cycle_and_backtest_agree_session_by_session(project: Path) -> None:
    dataset = _dataset()
    ctx = EngineContext(
        dataset=dataset,
        modes=load_mode_configs(project),
        costs=COSTS,
        timing=TIMING,
        quantity_step=Decimal("0.000001"),
        price_tick=Decimal("0.0001"),
    )
    sessions = dataset.sessions(FIRST, LAST)
    # The span the spec asks for: >= 120 sessions over both DST switches, Christmas and Easter.
    assert len(sessions) >= 120
    assert date(2023, 12, 27) in sessions and date(2023, 12, 25) not in sessions
    assert date(2024, 4, 2) in sessions and date(2024, 3, 29) not in sessions
    offsets = {session_times(CAL, s, TIMING).execute.hour for s in sessions}
    assert offsets == {7, 8}, "both CET (08:05 UTC) and CEST (07:05 UTC) executions"

    disk, memory = DiskPath(project, dataset), MemoryPath(ctx)
    per_session: list[tuple[date, SessionState]] = []
    for session in sessions:
        disk.reset_if_halted(session)
        memory.reset_if_halted(session)
        d, m = disk.cycle(session), memory.cycle(session)
        assert d.report == m.report, session
        assert d.fills == m.fills, session
        assert (d.cash, d.positions) == (m.cash, m.positions), session
        assert (d.day, d.peak) == (m.day, m.peak), session
        assert (d.halt, d.kill) == (m.halt, m.kill), session
        per_session.append((session, m))
    assert [s for s, _, _ in disk.resets] == [s for s, _ in memory.resets]
    # The risk-state history, every field of every record (halt reasons included). Only who
    # cleared the halt differs: the CLI names the user, the backtest its modeled owner.
    disk_history, memory_history = disk.history(), memory.parts.store.history

    def without_by(records: list[dict[str, str]]) -> list[dict[str, str]]:
        return [{k: v for k, v in r.items() if k != "by"} for r in records]

    assert without_by(disk_history) == without_by(memory_history)
    clears = [r for r in memory_history if r["event"].startswith("clear:")]
    assert len(clears) == len(disk.resets) and {r.get("by") for r in clears} == {MODELED_OWNER}
    assert all(
        r.get("by") not in (None, MODELED_OWNER) for r in disk_history if r["event"].startswith("clear:")
    )
    assert any("reason" in r for r in memory_history), "the set records carry their reasons"

    # The full decision-log stream, alerts included.
    disk_log = disk.decisions()
    memory_log = memory.parts.log.all_records
    assert disk_log == memory_log
    assert any(r["kind"] == "alert" for r in disk_log)

    # run_backtest on the same job: the very same records as the hand loop.
    result = run_backtest(JOB, ctx)
    assert result.decisions_gz is not None
    lines = gzip.decompress(result.decisions_gz).decode("ascii").splitlines()
    assert [json.loads(line) for line in lines] == memory_log
    final = per_session[-1][1]
    assert tuple(f.fill for f in result.fills) == final.fills
    assert [r.status for r in result.sessions] == [st.report.status for _, st in per_session]
    assert [(r.orders_sent, r.orders_rejected) for r in result.sessions] == [
        (st.report.orders_sent, st.report.orders_rejected) for _, st in per_session
    ]
    for point, (session, st) in zip(result.equity, per_session, strict=True):
        assert point.session == session and point.cash == st.cash
        gross = sum(
            (p.quantity * dataset.raw_close_eur(s, session) for s, p in st.positions.items()), Decimal(0)
        )
        assert point.equity == st.cash + gross

    # The planted events happened, on both paths, as modeled halts.
    by_session = {h.session: h for h in result.halts}
    assert sorted(by_session) == [HALT_1, REHALT, CRASH]
    assert by_session[HALT_1].kinds == (HaltKind.DAILY_LOSS,)
    assert not by_session[HALT_1].immediate_rehalt
    trap = by_session[REHALT]
    assert trap.kinds == (HaltKind.DAILY_LOSS,) and trap.immediate_rehalt
    assert trap.reasons[0].startswith("daily loss ")
    crash = by_session[CRASH]
    assert set(crash.kinds) == {HaltKind.DAILY_LOSS, HaltKind.DRAWDOWN}
    after_crash = CAL.next_session(CRASH)
    assert [(s, rebase) for s, rebase, _ in disk.resets] == [
        (REHALT, False),
        (CAL.next_session(REHALT), False),
        (after_crash, True),
    ]
    rebased = dict(memory.resets)[after_crash]
    crash_day = dict(per_session)[CRASH].day
    assert crash_day is not None and rebased == crash_day.last_equity == crash.peak_rebased_to
    assert any("Peak equity reset to the last seen equity" in line for line in disk.resets[-1][2])
    assert dict(per_session)[after_crash].report.status == "done", "the rebased peak lets it trade again"
    peak_after = dict(per_session)[after_crash].peak
    assert peak_after is not None and peak_after < crash_day.day_start_equity, "the old peak is gone"
    assert len(result.fills) > 30
    assert all(r.fill.ts == session_times(CAL, r.session, TIMING).execute for r in result.fills)
