"""One backtest run: fresh in-memory parts, one forward-only clock, the bot's own cycle.

``run_backtest`` first refuses (``BacktestRefused``, listing every problem, before any
cycle and before any part exists) a job it cannot run honestly: execution timing out of
range (``check_timing``); research limits that are not derived from the replay limits;
a job outside its fence period (the period is read from the dataset's physical cutoff:
research data -> research rules, holdout data -> holdout rules, anything later is
refused); universe symbols missing from the dataset; a plan that cannot run; a warm-up
shorter than the plan's bar window, or symbols listed at the first session without
``min_history`` bars before it; first or last session not a session inside the data; a
cost table whose currency disagrees with the data; and the no-fill cost guard
(``cost_guard_problems`` at 1x and 2x on the smallest open print of the run).

Then it builds new parts (``build_parts``: nothing is shared between runs) and, for each
session s from the first to the last (spec section 4):
1. RESET at ``reset_at`` (mode L only, while halted): the modeled owner's reset
   (``halts.apply_reset_policy``); the pending halt event records when, and the rebased
   peak. Mode R never resets: the halt stays, and later cycles are blocked.
2. The clock moves to the execution time E.
3. PRE-CHECKS (dataset metadata only): no KILL flag; every held symbol has an open print
   at s (else it was delisted while held); no corporate action on a held symbol at s (not
   modelled in M3); the universe is ``listed(s, at=E, min_bars=min_history)``, and each of
   its symbols has an open print at s.
4. SPEC: a fresh strategy instance for s (``plans.strategy_for_session``), the plan's bar
   window and the feed's calendar.
5. CYCLE: ``run_unlocked_cycle``, the very core ``samsulek run`` runs. Every order goes
   through the real router and risk engine there; this module never plans, checks or
   sends an order itself.
6. CLASSIFY: "error" voids the run; "blocked" is allowed only under an R-mode hard stop;
   "halted" must add halt reasons that ``classify_halt`` recognises (a limit halt), and a
   cap-drift halt must not name a symbol bought this session (that is a sizing bug).
   Any order the cycle had to cancel (an approved order that did not fill) voids the run.
7. AUDITS: no open order; ledger and broker reconcile; every new fill is stamped E and
   priced exactly ``expected_fill_price(raw open of s)`` with fee ``fee_for`` (a
   session-indexed oracle, independent of the feed's time lookup); the feed, asked again
   (it is stateless), quotes every universe and held symbol at exactly that raw open,
   labeled with the open print's own time; a "done" cycle leaves trading unblocked; the
   rejections logged match the report.
8. RECORD: the cycle's decision records give the ``SessionRecord`` (targets from the
   ``targets`` record; one rejection per rejected order, its reasons joined by "; ";
   actual weights = quantity x raw open / equity at the raw opens after the cycle) and
   one ``FillRecord`` per fill, with its cost attribution.
9. MARK at ``close_utc(s)``: equity = ledger cash + quantity x ``feed.mark`` (the raw
   close). No engine or broker call: a quote at that instant would raise ``PhaseError``.

Any exception during a session (from the cycle shell, the feed, the marks, the audits or
anything else) is a ``BacktestIntegrityError`` naming the session and the job's label:
the run is void and never continues. After the last session: episodes, the exact
profit-and-loss invariant (``book.check_invariant``), and in mode L with any halt the
frozen-positions equity from the end of the first halted cycle. Nothing here reads the
wall clock or writes a file: the run owns its one ``MonotoneClock`` and only this module
sets it.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, ClassVar, Final

from samsulek.backtest.book import build_episodes, check_invariant, frozen_equity_series
from samsulek.backtest.clock import MonotoneClock, SessionTimes, session_times
from samsulek.backtest.feed import MAX_WINDOW, BacktestFeed
from samsulek.backtest.fence import (
    HOLDOUT_DATA_CUTOFF,
    RESEARCH_DATA_CUTOFF,
    HoldoutFenceError,
    check_job_inside,
)
from samsulek.backtest.halts import (
    ResetPolicy,
    apply_reset_policy,
    cap_drift_symbols,
    classify_halt,
    reset_policy_for,
)
from samsulek.backtest.inmemory import MemoryDecisionLog, MemoryLedger, MemoryRiskStateStore, RecordingAlerter
from samsulek.backtest.limits import research_config_problems
from samsulek.backtest.plans import plan_problems, plan_window, strategy_for_session
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BacktestRefused,
    Detail,
    EngineContext,
    EquityPoint,
    ExecutionTiming,
    FillRecord,
    HaltEvent,
    HaltKind,
    Period,
    RiskMode,
    RunJob,
    RunResult,
    SessionRecord,
)
from samsulek.config import ConfigError, MarketLimits, RiskConfig
from samsulek.costs.stocks import StockCostModel, cost_guard_problems
from samsulek.cycle import CycleReport, CycleSpec, run_unlocked_cycle
from samsulek.execution.router import OrderRouter
from samsulek.execution.sim_broker import SimBroker
from samsulek.portfolio.reconcile import reconcile
from samsulek.quotes import collect_quotes
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import FlagState
from samsulek.types import Fill, Market, Mode, Quote, Side

FeedFactory = Callable[..., BacktestFeed]  # same keyword signature as BacktestFeed; planted feeds subclass it

MAX_EXEC_DELAY: Final = timedelta(minutes=10)  # after the open-print label (spec C1)
QUOTE_AGE_MARGIN: Final = timedelta(seconds=60)  # the open quote must still be fresh at E, with room
MIN_RESET_LEAD: Final = timedelta(minutes=1)
MAX_RESET_LEAD: Final = timedelta(minutes=120)
_ZERO: Final = Decimal(0)
# Records of a cycle cancelling orders. An approved order always fills at E (the cost
# guard), so any cancellation means the no-fill guarantee broke: the run is void.
_CANCEL_KINDS: Final = frozenset(
    {"stale_orders_cancelled", "unfilled_orders_cancelled", "cancel_non_exits", "cancel_all"}
)


@dataclass(frozen=True, slots=True)
class BacktestParts:
    """Everything one cycle needs (satisfies ``cycle.CycleParts``). Built fresh for every run."""

    in_memory: ClassVar[bool] = True
    mode: Mode  # always Mode.SIM
    clock: MonotoneClock
    broker: SimBroker
    ledger: MemoryLedger
    engine: RiskEngine
    router: OrderRouter
    log: MemoryDecisionLog
    alerter: RecordingAlerter
    risk_config: RiskConfig
    feed: BacktestFeed
    store: MemoryRiskStateStore
    pricer: StockCostModel

    def quotes_for(self, symbols: set[str]) -> dict[str, Quote]:
        return collect_quotes(self.feed.quote, symbols)


def check_timing(timing: ExecutionTiming, limits: MarketLimits) -> list[str]:
    """Every reason ``timing`` cannot be used with these limits; [] if none."""
    problems: list[str] = []
    delay, lead = timing.exec_delay, timing.reset_lead
    if not isinstance(delay, timedelta) or not timedelta(0) <= delay <= MAX_EXEC_DELAY:
        problems.append(f"the execution delay must be 0 to 10 minutes after the open print, got {delay}")
    elif delay + QUOTE_AGE_MARGIN > timedelta(seconds=limits.max_quote_age_seconds):
        problems.append(
            f"the execution delay {delay} plus {QUOTE_AGE_MARGIN.seconds} s is more than the "
            f"{limits.max_quote_age_seconds} s quote age limit: the open price would be stale at execution"
        )
    if not isinstance(lead, timedelta) or not MIN_RESET_LEAD <= lead <= MAX_RESET_LEAD:
        problems.append(f"the modeled reset must come 1 to 120 minutes before execution, got {lead}")
    return problems


def build_parts(
    job: RunJob, ctx: EngineContext, *, feed_factory: FeedFactory = BacktestFeed
) -> BacktestParts:
    """New in-memory parts for ``job``: the clock at the close before its first session."""
    calendar = ctx.dataset.calendar
    clock = MonotoneClock(calendar.close_utc(calendar.previous_session(job.first_session)))
    store = MemoryRiskStateStore()
    ledger = MemoryLedger()
    log = MemoryDecisionLog(clock, keep_all=job.detail is Detail.FULL)
    alerter = RecordingAlerter(log)
    pricer = StockCostModel(ctx.costs, multiplier=job.cost_multiplier)
    feed = feed_factory(
        ctx.dataset,
        clock=clock,
        universe=job.universe,
        window=plan_window(job.plan),
        exec_delay=ctx.timing.exec_delay,
    )
    broker = SimBroker(
        starting_cash=job.starting_cash_eur,
        fee_eur=_ZERO,
        fee_bps=_ZERO,
        slippage_bps=_ZERO,
        price_source=feed.quote,
        clock=clock,
        state_path=None,
        pricer=pricer,
    )
    risk_config = ctx.modes.for_mode(job.risk_mode)
    engine = RiskEngine(risk_config, store, clock, {Market.STOCKS: job.universe}, log)
    router = OrderRouter(broker, engine, log, alerter, register_order=ledger.remember_order)
    return BacktestParts(
        mode=Mode.SIM,
        clock=clock,
        broker=broker,
        ledger=ledger,
        engine=engine,
        router=router,
        log=log,
        alerter=alerter,
        risk_config=risk_config,
        feed=feed,
        store=store,
        pricer=pricer,
    )


def run_backtest(job: RunJob, ctx: EngineContext, *, feed_factory: FeedFactory = BacktestFeed) -> RunResult:
    """``job`` on ``ctx``: ``BacktestRefused`` before the first cycle, ``BacktestIntegrityError``
    during the run. Never writes files."""
    problems = refusal_problems(job, ctx)
    if problems:
        raise BacktestRefused(problems)
    try:
        parts = build_parts(job, ctx, feed_factory=feed_factory)
    except Exception as exc:  # every check above passed: a failure here is a bug
        raise BacktestIntegrityError(
            f"could not build the backtest parts: {type(exc).__name__}: {exc}", session=None, label=job.label
        ) from exc
    return _Run(job, ctx, parts).run()


# ------------------------------------------------------------------------------ refusals
def _period(cutoff: datetime) -> Period | None:
    """The fence period a dataset cut at ``cutoff`` belongs to (None: past the holdout)."""
    if cutoff <= RESEARCH_DATA_CUTOFF:
        return Period.RESEARCH
    if cutoff <= HOLDOUT_DATA_CUTOFF:
        return Period.HOLDOUT
    return None


def refusal_problems(job: RunJob, ctx: EngineContext) -> list[str]:
    """Every reason ``run_backtest`` refuses ``job`` on ``ctx`` (before any part exists)."""
    dataset = ctx.dataset
    try:
        limits = ctx.modes.for_mode(job.risk_mode).limits_for(Market.STOCKS)
    except ConfigError as exc:
        return [str(exc)]
    problems = check_timing(ctx.timing, limits)
    if job.risk_mode is RiskMode.R:
        problems.extend(
            f"research limits: {p}" for p in research_config_problems(ctx.modes.replay, ctx.modes.research)
        )
    period = _period(dataset.cutoff)
    if period is None:
        problems.append(
            f"the dataset is cut at {dataset.cutoff.isoformat()}, after the holdout ends "
            f"({HOLDOUT_DATA_CUTOFF.isoformat()}): no study may use it"
        )
    else:
        try:
            check_job_inside(period, first_session=job.first_session, last_session=job.last_session)
        except HoldoutFenceError as exc:
            problems.extend(exc.problems)
    known = set(dataset.symbols())
    unknown = sorted(set(job.universe) - known)
    if unknown:
        problems.append(f"universe symbols not in the dataset: {', '.join(unknown)}")
    in_data = sorted(set(job.universe) & known)
    plan_issues = plan_problems(job.plan, universe=job.universe, first_session=job.first_session)
    problems.extend(f"plan: {p}" for p in plan_issues)
    if not plan_issues:
        window = plan_window(job.plan)
        if window > MAX_WINDOW:
            problems.append(f"the plan needs {window} bars per symbol, more than the feed's {MAX_WINDOW}")
        if job.min_history < window:
            problems.append(
                f"min_history {job.min_history} is below the plan's bar window {window}: the strategy "
                "would start on a shorter history than it needs"
            )
    sessions_ok = _session_problems(job, ctx, problems)
    if sessions_ok and in_data:
        problems.extend(_warmup_problems(job, ctx, in_data))
    for symbol in in_data:
        listed_in = dataset.listing(symbol).currency
        costed_in = ctx.costs.currency.get(symbol)
        if costed_in is not None and costed_in != listed_in:
            problems.append(f"{symbol} trades in {listed_in}, but the cost table says {costed_in}")
    if not (ctx.quantity_step.is_finite() and ctx.quantity_step > 0):
        problems.append(f"the quantity step must be a finite amount > 0, got {ctx.quantity_step}")
    if sessions_ok and in_data:
        try:
            lowest = dataset.min_open_eur(in_data, job.first_session, job.last_session)
        except LookupError as exc:
            problems.append(str(exc))
        else:
            problems.extend(
                cost_guard_problems(
                    ctx.costs,
                    limits,
                    symbols=job.universe,
                    price_tick=ctx.price_tick,
                    min_reference_eur=lowest,
                )
            )
    return problems


def _session_problems(job: RunJob, ctx: EngineContext, problems: list[str]) -> bool:
    """Append why the job's sessions are unusable; True when they are fine."""
    dataset = ctx.dataset
    calendar = dataset.calendar
    first, last = job.first_session, job.last_session
    try:
        bad = [d for d in (first, last) if not calendar.is_session(d)]
        if bad:
            problems.extend(f"{d} is not a {calendar.name} session" for d in bad)
            return False
        calendar.previous_session(first)
        session_times(calendar, first, ctx.timing)
    except ValueError as exc:  # CalendarRangeError included: a year the calendar was not checked for
        problems.append(f"the job's sessions cannot be timed: {type(exc).__name__}: {exc}")
        return False
    days = dataset.sessions(first, last)
    if not days or days[0] != first or days[-1] != last:
        problems.append(
            f"the job's sessions {first} .. {last} are not all inside the data "
            f"(it holds {days[0] if days else 'nothing'} .. {days[-1] if days else 'nothing'} of them)"
        )
        return False
    return True


def _warmup_problems(job: RunJob, ctx: EngineContext, symbols: Sequence[str]) -> list[str]:
    """Symbols listed at the first session without ``min_history`` bars before it."""
    dataset = ctx.dataset
    first = job.first_session
    at = session_times(dataset.calendar, first, ctx.timing).execute
    listed = dataset.listed(first, at=at, min_bars=0, among=symbols)
    if not listed:
        return [f"no symbol of the universe is listed at the first session {first}"]
    warm = set(dataset.listed(first, at=at, min_bars=job.min_history, among=symbols))
    out = []
    for symbol in listed:
        if symbol not in warm:
            have = len(dataset.adjusted_window(symbol, at, max(job.min_history, 1)))
            out.append(
                f"{symbol} has {have} bars before {first}, fewer than min_history {job.min_history} (warm-up)"
            )
    return out


# ------------------------------------------------------------------------------- the run
class _Run:
    """The state of one run while its sessions go by (used once, by ``run_backtest``)."""

    def __init__(self, job: RunJob, ctx: EngineContext, parts: BacktestParts) -> None:
        self._job = job
        self._ctx = ctx
        self._parts = parts
        self._dataset = ctx.dataset
        self._calendar = ctx.dataset.calendar
        self._policy = reset_policy_for(job.risk_mode)
        self._window = plan_window(job.plan)
        self._limits = parts.risk_config.limits_for(Market.STOCKS)
        self._start = parts.clock.now()
        self._points: list[EquityPoint] = []
        self._sessions: list[SessionRecord] = []
        self._fills: list[FillRecord] = []
        self._halts: list[HaltEvent] = []
        self._last_fill_id: str | None = None
        self._last_marks: dict[str, Decimal] = {}
        self._frozen: tuple[int, Decimal, dict[str, Decimal]] | None = None

    def _void(self, reason: str, session: date | None) -> BacktestIntegrityError:
        return BacktestIntegrityError(reason, session=session, label=self._job.label)

    def run(self) -> RunResult:
        days = self._dataset.sessions(self._job.first_session, self._job.last_session)
        for index, session in enumerate(days):
            try:
                self._session(index, session)
            except BacktestIntegrityError:
                raise
            except Exception as exc:  # anything else is a bug or bad data too: never continue
                raise self._void(f"{type(exc).__name__}: {exc}", session) from exc
        try:
            return self._finish(days)
        except BacktestIntegrityError as exc:
            raise self._void(exc.reason, exc.session) from exc
        except Exception as exc:
            raise self._void(f"{type(exc).__name__}: {exc}", None) from exc

    # ------------------------------------------------------------------ one session
    def _session(self, index: int, session: date) -> None:
        parts = self._parts
        times = session_times(self._calendar, session, self._ctx.timing)
        reset_before = self._reset(session, times)
        parts.clock.set(times.execute)
        universe = self._pre_checks(session, times.execute)
        spec = CycleSpec(
            market=Market.STOCKS,
            universe=universe,
            strategy=strategy_for_session(self._job.plan, session),
            quantity_step=self._ctx.quantity_step,
            price_tick=self._ctx.price_tick,
            calendar=parts.feed.calendar,
            bar_window=self._window,
        )
        halt_before = parts.store.read_halt()
        report = run_unlocked_cycle(parts, spec)
        records = parts.log.drain_cycle()
        fills = self._new_fills()
        execute = times.execute
        self._classify(
            session,
            execute=execute,
            report=report,
            records=records,
            fills=fills,
            halt_before=halt_before,
            reset_before=reset_before,
        )
        self._audit(session, execute=execute, report=report, records=records, fills=fills, universe=universe)
        self._record(
            index,
            session,
            execute=execute,
            report=report,
            records=records,
            fills=fills,
            universe=universe,
            reset_before=reset_before,
        )
        parts.clock.set(times.close_print)
        self._mark(session, times.close_print)

    def _reset(self, session: date, times: SessionTimes) -> bool:
        """Step 1: the modeled owner's reset of a pending mode-L halt. True if it ran."""
        store = self._parts.store
        if self._policy is not ResetPolicy.NEXT_SESSION or not store.read_halt().active:
            return False
        pending = self._halts[-1] if self._halts else None
        if pending is None or pending.reset_at is not None:
            raise self._void("trading is halted, but no modeled halt is waiting for a reset (a bug)", session)
        self._parts.clock.set(times.reset_at)
        outcome = apply_reset_policy(store, kinds=pending.kinds, at=times.reset_at)
        self._halts[-1] = replace(pending, reset_at=times.reset_at, peak_rebased_to=outcome.peak_rebased_to)
        return True

    def _pre_checks(self, session: date, execute: datetime) -> tuple[str, ...]:
        """Step 3, from the dataset's metadata only; returns the session's universe."""
        parts, dataset = self._parts, self._dataset
        if parts.store.read_kill().active:
            raise self._void("the KILL flag is set: a backtest never models the kill switch", session)
        held = sorted(s for s, p in parts.ledger.positions.items() if p.quantity > 0)
        gone = [s for s in held if not dataset.has_open_print(s, session)]
        if gone:
            raise self._void(
                f"held {', '.join(gone)} has no open print (delisted while held, or the delisting was "
                "announced too late): not modelled in M3",
                session,
            )
        acting = sorted({a.symbol for a in dataset.actions_on(session)} & set(held))
        if acting:
            raise self._void(
                f"corporate action on a held symbol: not modelled in M3 ({', '.join(acting)})", session
            )
        universe = dataset.listed(
            session, at=execute, min_bars=self._job.min_history, among=self._job.universe
        )
        unpriced = [s for s in universe if not dataset.has_open_print(s, session)]
        if unpriced:
            raise self._void(f"listed {', '.join(unpriced)} has no open print", session)
        return universe

    def _new_fills(self) -> list[Fill]:
        fills = self._parts.broker.fills_since(self._last_fill_id)
        if fills:
            self._last_fill_id = fills[-1].fill_id
        return fills

    def _hard_stop(self) -> bool:
        """A mode-R halt is in force (a hard stop): the only way a cycle may be blocked."""
        store = self._parts.store
        return (
            self._job.risk_mode is RiskMode.R
            and bool(self._halts)
            and store.read_halt().active
            and not store.read_kill().active
        )

    def _classify(
        self,
        session: date,
        *,
        execute: datetime,
        report: CycleReport,
        records: Sequence[Mapping[str, Any]],
        fills: Sequence[Fill],
        halt_before: FlagState,
        reset_before: bool,
    ) -> None:
        """Step 6: only modeled limit halts and R hard stops let a run go on."""
        said = "; ".join(report.messages) or "no message"
        if report.status == "error":
            raise self._void(f"the cycle ended in an error: {said}", session)
        if report.status == "blocked":
            if not self._hard_stop():
                raise self._void(f"the cycle was blocked without a mode-R hard stop: {said}", session)
        elif report.status == "halted":
            self._halts.append(
                self._halt_event(
                    session,
                    execute=execute,
                    report=report,
                    fills=fills,
                    halt_before=halt_before,
                    reset_before=reset_before,
                )
            )
        elif report.status != "done":
            raise self._void(f"unknown cycle status {report.status!r}: {said}", session)
        cancelled = [r for r in records if r.get("kind") in _CANCEL_KINDS and r.get("cancelled")]
        if cancelled:
            raise self._void(
                "the cycle cancelled orders it could not fill "
                f"({', '.join(str(r['kind']) for r in cancelled)}): an approved order must always fill "
                "at the execution time (no-fill guard)",
                session,
            )

    def _halt_event(
        self,
        session: date,
        *,
        execute: datetime,
        report: CycleReport,
        fills: Sequence[Fill],
        halt_before: FlagState,
        reset_before: bool,
    ) -> HaltEvent:
        halt = self._parts.store.read_halt()
        new = halt.reasons[len(halt_before.reasons) :] if halt_before.active else halt.reasons
        if not halt.active or not new:
            said = "; ".join(report.messages) or "no message"
            raise self._void(f"the cycle halted without a new halt reason: {said}", session)
        kinds: list[HaltKind] = []
        for reason in new:
            kind = classify_halt(reason)
            if kind is None:
                raise self._void(f"not a modeled limit halt (a bug or bad data): {reason}", session)
            if kind not in kinds:
                kinds.append(kind)
        if HaltKind.CAP_DRIFT in kinds:
            named = {symbol for reason in new for symbol in cap_drift_symbols(reason)}
            bought = sorted({f.symbol for f in fills if f.side is Side.BUY} & named)
            if bought:
                raise self._void(
                    f"position cap exceeded right after buying {', '.join(bought)} in the same cycle: "
                    "a sizing bug, not price drift",
                    session,
                )
        return HaltEvent(
            session=session,
            ts=execute,
            kinds=tuple(kinds),
            reasons=tuple(new),
            reset_at=None,
            peak_rebased_to=None,
            immediate_rehalt=reset_before and report.orders_sent == 0,
        )

    def _audit(
        self,
        session: date,
        *,
        execute: datetime,
        report: CycleReport,
        records: Sequence[Mapping[str, Any]],
        fills: Sequence[Fill],
        universe: Sequence[str],
    ) -> None:
        """Step 7: production checks after every cycle; any failure voids the run."""
        parts = self._parts
        account = parts.broker.account()
        if account.open_orders:
            raise self._void(f"{len(account.open_orders)} order(s) still open after the cycle", session)
        check = reconcile(parts.ledger.snapshot(execute), account, parts.ledger.known_client_ids)
        if not check.ok:
            raise self._void(
                "ledger and simulated broker disagree after the cycle: " + "; ".join(check.differences),
                session,
            )
        for fill in fills:
            self._audit_fill(session, execute, fill)
        held = {s for s, p in parts.ledger.positions.items() if p.quantity > 0}
        self._audit_quotes(session, sorted(set(universe) | held))
        if report.status == "done":
            blocked = parts.engine.blocked_reason()
            if blocked is not None:
                raise self._void(f"the cycle ended done while trading is blocked: {blocked}", session)
        rejected = sum(1 for r in records if r.get("kind") == "risk_decision" and r.get("approved") is False)
        if rejected != report.orders_rejected:
            raise self._void(
                f"{rejected} risk rejection(s) logged, but the cycle reports {report.orders_rejected}",
                session,
            )

    def _audit_quotes(self, session: date, symbols: Sequence[str]) -> None:
        """The price the cycle traded on, asked again (``quote`` is stateless): the raw open
        print of the session in EUR, labeled with its own print time, for every symbol."""
        label = self._calendar.open_print_utc(session)
        for symbol in symbols:
            quote = self._parts.feed.quote(symbol)
            reference = self._dataset.raw_open_eur(symbol, session)
            if (
                quote is None
                or quote.symbol != symbol
                or quote.market is not Market.STOCKS
                or quote.ts != label
                or quote.price != reference
            ):
                shown = "none" if quote is None else f"{quote.price} labeled {quote.ts.isoformat()}"
                raise self._void(
                    f"quote audit: {symbol} is quoted {shown}, not its open print {reference} labeled "
                    f"{label.isoformat()}",
                    session,
                )

    def _audit_fill(self, session: date, execute: datetime, fill: Fill) -> None:
        if fill.ts != execute:
            raise self._void(
                f"fill {fill.fill_id} is stamped {fill.ts.isoformat()}, not the execution time "
                f"{execute.isoformat()}",
                session,
            )
        if fill.market is not Market.STOCKS:
            raise self._void(f"fill {fill.fill_id} is for market {fill.market.value}", session)
        reference = self._dataset.raw_open_eur(fill.symbol, session)
        expected = self._parts.pricer.expected_fill_price(fill.symbol, fill.side, reference)
        if fill.price != expected:
            raise self._void(
                f"fill {fill.fill_id} of {fill.symbol} at {fill.price}, but the open print {reference} with "
                f"the cost model gives {expected}",
                session,
            )
        fee = self._parts.pricer.fee_for(fill.symbol, fill.quantity, fill.price)
        if fill.fee != fee:
            raise self._void(f"fill {fill.fill_id} paid fee {fill.fee}, the cost model says {fee}", session)

    def _record(
        self,
        index: int,
        session: date,
        *,
        execute: datetime,
        report: CycleReport,
        records: Sequence[Mapping[str, Any]],
        fills: Sequence[Fill],
        universe: tuple[str, ...],
        reset_before: bool,
    ) -> None:
        """Step 8: the session's record, its fills, and (first halt) the frozen positions."""
        parts, dataset = self._parts, self._dataset
        targets: tuple[tuple[str, float], ...] = ()
        planned = 0
        rejections: list[str] = []
        for r in records:
            kind = r.get("kind")
            if kind == "targets":
                weights = r.get("weights") or {}
                targets = tuple(sorted((str(s), float(w)) for s, w in weights.items()))
            elif kind == "orders_planned":
                planned = int(r.get("count", 0))
            elif kind == "risk_decision" and r.get("approved") is False:
                rejections.append("; ".join(str(x) for x in r.get("reasons") or ()))
        snap = parts.ledger.snapshot(execute)
        held = {s: p.quantity for s, p in sorted(snap.positions.items()) if p.quantity > 0}
        opens = {s: dataset.raw_open_eur(s, session) for s in held}
        open_equity = snap.cash + sum((q * opens[s] for s, q in held.items()), _ZERO)
        if not (open_equity.is_finite() and open_equity > 0):
            raise self._void(f"equity at the open prices is {open_equity} after the cycle", session)
        self._sessions.append(
            SessionRecord(
                session=session,
                status=report.status,
                universe=universe,
                reset_before=reset_before,
                orders_planned=planned,
                orders_sent=report.orders_sent,
                orders_rejected=report.orders_rejected,
                rejections=tuple(rejections),
                targets=targets,
                actual=tuple((s, float(q * opens[s] / open_equity)) for s, q in held.items()),
                open_equity=open_equity,
            )
        )
        for fill in fills:
            reference = dataset.raw_open_eur(fill.symbol, session)
            cost = parts.pricer.attribution(fill.symbol, fill.quantity, reference)
            self._fills.append(
                FillRecord(
                    session=session,
                    fill=fill,
                    reference=reference,
                    spread_eur=cost.spread_eur,
                    slippage_eur=cost.slippage_eur,
                )
            )
        if self._frozen is None and report.status == "halted":
            self._frozen = (index, snap.cash, held)

    def _mark(self, session: date, close: datetime) -> None:
        """Step 9: the equity point at the close (raw closes; no engine or broker call)."""
        snap = self._parts.ledger.snapshot(close)
        held = {s: p.quantity for s, p in sorted(snap.positions.items()) if p.quantity > 0}
        marks = {s: self._parts.feed.mark(s, session) for s in held}
        gross = sum((q * marks[s] for s, q in held.items()), _ZERO)
        self._points.append(
            EquityPoint(session=session, ts=close, cash=snap.cash, gross=gross, equity=snap.cash + gross)
        )
        self._last_marks = marks

    # -------------------------------------------------------------------- the end
    def _close_or_none(self, symbol: str, session: date) -> Decimal | None:
        try:
            return self._dataset.raw_close_eur(symbol, session)
        except KeyError:
            return None

    def _finish(self, days: Sequence[date]) -> RunResult:
        job, modes = self._job, self._ctx.modes
        episodes, residual = build_episodes(
            self._fills, self._sessions, min_order_eur=self._limits.min_order_eur, last_marks=self._last_marks
        )
        frozen: tuple[EquityPoint, ...] = ()
        if job.risk_mode is RiskMode.L and self._frozen is not None:
            index, cash, positions = self._frozen
            frozen = frozen_equity_series(
                positions=positions,
                cash=cash,
                sessions=days[index:],
                close=self._close_or_none,
                ts=self._calendar.close_utc,
            )
        result = RunResult(
            job=job,
            start_ts=self._start,
            start_equity=job.starting_cash_eur,
            equity=tuple(self._points),
            sessions=tuple(self._sessions),
            fills=tuple(self._fills),
            halts=tuple(self._halts),
            episodes=episodes,
            residual_eur=residual,
            frozen_equity=frozen,
            decisions_gz=self._parts.log.gz_bytes(),
            data_fingerprint=self._dataset.fingerprint,
            risk_config_sha256=modes.replay_sha256 if job.risk_mode is RiskMode.L else modes.research_sha256,
        )
        check_invariant(result)
        return result
