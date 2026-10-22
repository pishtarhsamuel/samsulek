"""One trading cycle: reconcile -> data checks -> strategy -> sizing -> risk -> orders -> reconcile.

Every early exit is fail-closed: broker errors, ledger mismatches, missing or
stale data, and any unexpected exception HALT (owner reset required) and alert.

Orders live for one cycle only (DAY semantics): open orders left from earlier
runs are cancelled before planning, and anything still unfilled at the end of
the cycle is cancelled. While a cycle runs, open orders count toward cash,
position and exposure limits.

One core, two shells (owner decision Q4), so the bot and the backtest run the very same
cycle code:
- ``run_cycle_core`` is the cycle itself. It reads every part it touches from a
  ``CycleParts`` at call time and what to trade from a ``CycleSpec``. It takes no lock and
  does not check for a halt first: the shells do both.
- ``run_cycle`` is the bot's shell: the ``cycle_start`` line, the blocked check, then the
  OS run lock, then the core, with a catch-all that halts. The spec is built inside the
  lock and the catch-all.
- ``run_unlocked_cycle`` is the same shell without the lock, for the backtest's in-memory
  parts: they own no folder, so there is nothing to lock. It refuses an ``App`` and any
  parts not marked ``in_memory = True`` (``TypeError``), so the bot can never skip its
  lock through it.

Data freshness is calendar-aware (owner decision Q11, ``data.freshness``): the latest bar
of every symbol must be from the newest session whose close plus the spec's publish delay
(``DATA_PUBLISH_DELAY`` by default) has passed, judged by the spec's calendar. The bot's
spec takes the calendar its feed declares (``live_cycle_spec``). A calendar error (for
example a year the calendar was not checked for) halts like stale data. The strategy gets
each symbol's bars as a tuple, so it cannot change what the feed holds.
"""

from __future__ import annotations

import contextlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Final, Protocol

from samsulek.alerts import Alerter
from samsulek.app import App
from samsulek.clock import Clock
from samsulek.config import RiskConfig
from samsulek.data.bars import TradingCalendar
from samsulek.data.freshness import stale_bars_problem
from samsulek.execution.broker import Broker, BrokerError
from samsulek.execution.router import OrderRouter
from samsulek.logging_setup import DecisionLog
from samsulek.portfolio.ledger import Ledger, LedgerError
from samsulek.portfolio.reconcile import reconcile
from samsulek.risk.engine import RiskEngine
from samsulek.risk.sizing import SizingError, plan_orders
from samsulek.risk.state import StateCorruptError
from samsulek.runlock import AlreadyRunningError, RunLock
from samsulek.strategies.base import LookaheadError, Strategy, StrategyContext
from samsulek.types import AccountSnapshot, Bar, Market, MissingQuoteError, Mode, PortfolioSnapshot, Quote

# How long after a session's close its daily bar must be available (the source's publish
# delay). At the scheduled run after the open, this means: the previous session's bar.
DATA_PUBLISH_DELAY: Final = timedelta(hours=6)
MAX_PUBLISH_DELAY: Final = timedelta(hours=24)
# After a cycle, a position more than 10% above its cap means something went wrong
# (price drift within one cycle is far smaller).
POST_CYCLE_CAP_TOLERANCE = Decimal("1.10")
SYNC_ERRORS = (BrokerError, LedgerError, StateCorruptError, OSError, ArithmeticError, ValueError)


class BarFeed(Protocol):
    """Where a cycle's daily bars come from, and the calendar those bars follow."""

    @property
    def calendar(self) -> TradingCalendar: ...

    def bars_until(self, asof: datetime) -> Mapping[str, Sequence[Bar]]: ...


class CycleParts(Protocol):
    """Everything one cycle touches. The bot's ``App`` and the backtest's in-memory parts
    both satisfy it, so both run the very same cycle code."""

    @property
    def mode(self) -> Mode: ...

    @property
    def clock(self) -> Clock: ...

    @property
    def broker(self) -> Broker: ...

    @property
    def ledger(self) -> Ledger: ...

    @property
    def engine(self) -> RiskEngine: ...

    @property
    def router(self) -> OrderRouter: ...

    @property
    def log(self) -> DecisionLog: ...

    @property
    def alerter(self) -> Alerter: ...

    @property
    def risk_config(self) -> RiskConfig: ...

    @property
    def feed(self) -> BarFeed: ...

    def quotes_for(self, symbols: set[str]) -> dict[str, Quote]: ...


@dataclass(frozen=True, slots=True)
class CycleSpec:
    """What one cycle trades, and the rule its data must meet."""

    market: Market
    universe: tuple[str, ...]
    strategy: Strategy
    quantity_step: Decimal
    price_tick: Decimal
    calendar: TradingCalendar  # the calendar the feed's bars follow (freshness rule)
    publish_delay: timedelta = DATA_PUBLISH_DELAY
    bar_window: int | None = None  # bars per symbol the strategy sees; None: all (the bot)

    def __post_init__(self) -> None:
        # 0 or a negative number would silently mean "all bars" or "drop the oldest" below.
        if self.bar_window is not None and self.bar_window < 1:
            raise ValueError(f"bar_window must be None or at least 1, got {self.bar_window}")
        # A longer delay would let a missing session's bar pass as "not due yet".
        if not timedelta(0) <= self.publish_delay <= MAX_PUBLISH_DELAY:
            raise ValueError(
                f"publish_delay must be between 0 and {MAX_PUBLISH_DELAY}, got {self.publish_delay}"
            )


def live_cycle_spec(app: App) -> CycleSpec:
    """The bot's cycle: its stock universe and strategy, its broker's sizing, its feed's calendar."""
    return CycleSpec(
        market=Market.STOCKS,
        universe=tuple(app.config.universe.get(Market.STOCKS, [])),
        strategy=app.strategy,
        quantity_step=app.config.sim.quantity_step,
        price_tick=app.config.sim.price_tick,
        calendar=app.feed.calendar,
    )


@dataclass
class CycleReport:
    status: str  # "done" | "halted" | "blocked" | "error"
    messages: list[str] = field(default_factory=list)
    orders_sent: int = 0
    orders_rejected: int = 0

    @property
    def ok(self) -> bool:
        return self.status == "done"


def sync_ledger(app: CycleParts) -> AccountSnapshot:
    """Bring the ledger up to date with broker fills. Initialises a brand-new sim ledger."""
    account = app.broker.account()
    if not app.ledger.initialized:
        if app.mode is not Mode.SIM:
            raise LedgerError("ledger is not initialised for this account")
        fills = app.broker.fills_since(None)
        app.ledger.initialize_from(account, fills[-1].fill_id if fills else None)
        app.log.write("ledger_initialized", cash=account.cash, positions=account.positions)
    else:
        applied = app.ledger.apply_fills(app.broker.fills_since(app.ledger.last_fill_id))
        if applied:
            app.log.write("fills_applied", count=applied)
        account = app.broker.account()
    return account


def portfolio_view(app: CycleParts, account: AccountSnapshot) -> PortfolioSnapshot:
    """Our ledger, plus the orders the broker says are still open."""
    return app.ledger.snapshot(app.clock.now(), tuple(o.request for o in account.open_orders))


def halt_and_alert(app: CycleParts, title: str, detail: str) -> None:
    """Alert first (never raises), then persist the halt, then cancel risk-adding orders."""
    app.alerter.alert("critical", f"{title}: trading HALTED", detail)
    try:
        app.engine.halt(f"{title}: {detail}")
    except Exception as exc:
        app.alerter.alert(
            "critical", "COULD NOT PERSIST HALT: stop the bot by hand", f"{type(exc).__name__}: {exc}"
        )
    app.router.cancel_risk_adding()


def reconcile_or_halt(app: CycleParts, account: AccountSnapshot, when: str) -> bool:
    result = reconcile(app.ledger.snapshot(app.clock.now()), account, app.ledger.known_client_ids)
    app.log.write("reconcile", when=when, ok=result.ok, differences=result.differences)
    if not result.ok:
        halt_and_alert(app, "Ledger and broker disagree", "\n".join(result.differences))
    return result.ok


def _fail(app: CycleParts, report: CycleReport, title: str, detail: str) -> CycleReport:
    halt_and_alert(app, title, detail)
    with contextlib.suppress(Exception):  # the halt and alert above matter; this line is best effort
        app.log.write("cycle_end", status="halted", reason=f"{title}: {detail}")
    report.status = "halted"
    report.messages.append(f"{title}: {detail}")
    return report


def _data_problem(
    bars: Mapping[str, Sequence[Bar]], universe: list[str], now: datetime, spec: CycleSpec
) -> str | None:
    """Why the bars can't be traded on (missing or stale), or None. A calendar error is a problem too."""
    try:
        return stale_bars_problem(bars, universe, now, spec.calendar, spec.publish_delay)
    except ValueError as exc:  # e.g. CalendarRangeError: a year the calendar was not checked for
        return f"{type(exc).__name__}: {exc}"


def _window(series: Sequence[Bar], window: int | None) -> tuple[Bar, ...]:
    """The strategy's copy of one symbol's bars: the last ``window`` of them (None: all)."""
    return tuple(series[-window:]) if window else tuple(series)


def _blocked(parts: CycleParts, report: CycleReport) -> bool:
    """Halted, killed or unreadable risk state: record it in the report and say so. Never trades."""
    blocked = parts.engine.blocked_reason()
    if not blocked:
        return False
    if "unreadable" in blocked:
        parts.alerter.alert("critical", "Risk state unreadable: trading blocked", blocked)
    parts.log.write("cycle_end", status="blocked", reason=blocked)
    report.status = "blocked"
    report.messages.append(blocked)
    return True


def _unexpected(parts: CycleParts, report: CycleReport, exc: Exception) -> CycleReport:
    """Anything unexpected: halt, alert, report."""
    detail = f"{type(exc).__name__}: {exc}"
    halt_and_alert(parts, "Unexpected error in the trading cycle", detail)
    report.status = "error"
    report.messages.append(detail)
    return report


def run_cycle(app: App) -> CycleReport:
    """One cycle of the bot: blocked check, the OS run lock, then the shared core."""
    report = CycleReport(status="done")
    try:
        app.log.write("cycle_start", mode=app.mode, strategy=app.strategy.name)
        if _blocked(app, report):
            return report
        try:
            with RunLock(app.config.state_dir, app.clock) as lock:
                if lock.took_over_stale:
                    app.alerter.alert(
                        "warning", "Took over a stale run lock", "a previous run did not finish cleanly"
                    )
                return run_cycle_core(app, live_cycle_spec(app), report)
        except AlreadyRunningError as exc:
            app.alerter.alert("warning", "Run skipped: another run is in progress", str(exc))
            app.log.write("cycle_end", status="blocked", reason=str(exc))
            report.status = "blocked"
            report.messages.append(str(exc))
            return report
    except Exception as exc:  # anything unexpected: halt, alert, report
        return _unexpected(app, report, exc)


def run_unlocked_cycle(parts: CycleParts, spec: CycleSpec) -> CycleReport:
    """The same cycle for the backtest's in-memory parts: ``run_cycle`` without the OS run lock.

    Raises ``TypeError`` for an ``App`` or for parts not marked ``in_memory = True``: the bot
    must always take its lock.
    """
    if isinstance(parts, App) or getattr(parts, "in_memory", False) is not True:
        raise TypeError(
            f"run_unlocked_cycle is for in-memory backtest parts only, not {type(parts).__name__}; "
            "the bot runs through run_cycle, which takes the run lock"
        )
    report = CycleReport(status="done")
    try:
        parts.log.write("cycle_start", mode=parts.mode, strategy=spec.strategy.name)
        if _blocked(parts, report):
            return report
        return run_cycle_core(parts, spec, report)
    except Exception as exc:  # anything unexpected: halt, alert, report
        return _unexpected(parts, report, exc)


def run_cycle_core(app: CycleParts, spec: CycleSpec, report: CycleReport) -> CycleReport:
    """The cycle itself. The caller has checked for a halt and holds the run lock (if any)."""
    now = app.clock.now()
    try:
        account = sync_ledger(app)
    except SYNC_ERRORS as exc:
        return _fail(app, report, "Cannot sync with broker", str(exc))
    if not reconcile_or_halt(app, account, "start"):
        report.status = "halted"
        report.messages.append("reconciliation mismatch at start")
        return report

    # Orders live for one cycle: cancel anything left over, then re-sync (a fill may race the cancel).
    # Reduce-only exits (e.g. from the kill switch) are never cancelled here.
    if any(not o.request.reduce_only for o in account.open_orders):
        try:
            cancelled = app.router.cancel_non_exits()
            app.log.write("stale_orders_cancelled", cancelled=cancelled)
            account = sync_ledger(app)
        except SYNC_ERRORS as exc:
            return _fail(app, report, "Cannot cancel leftover open orders", str(exc))
        if not reconcile_or_halt(app, account, "after cancelling leftover orders"):
            report.status = "halted"
            report.messages.append("reconciliation mismatch after cancelling leftover orders")
            return report

    market = spec.market
    universe = list(spec.universe)
    portfolio = portfolio_view(app, account)
    symbols = (
        set(universe)
        | {s for s, p in portfolio.positions.items() if p.quantity > 0}
        | {o.symbol for o in portfolio.open_orders}
    )
    quotes = app.quotes_for(symbols)
    missing = sorted(symbols - quotes.keys())
    if missing:
        return _fail(app, report, "Missing prices", ", ".join(missing))
    try:
        equity = portfolio.equity(quotes)
    except MissingQuoteError as exc:
        return _fail(app, report, "Cannot value portfolio", str(exc))
    tripped = app.engine.observe_equity(equity)
    if tripped:
        app.alerter.alert("critical", "Risk limit hit: trading HALTED", "\n".join(tripped))
        app.router.cancel_risk_adding()
    blocked = app.engine.blocked_reason()
    if blocked:
        app.log.write("cycle_end", status="halted", reason=blocked, equity=equity)
        report.status = "halted"
        report.messages.append(blocked)
        return report

    bars = app.feed.bars_until(now)
    problem = _data_problem(bars, universe, now, spec)
    if problem:
        return _fail(app, report, "Stale or missing data", problem)
    try:
        ctx = StrategyContext(
            asof=now, market=market, bars={s: _window(bars[s], spec.bar_window) for s in universe}
        )
        targets = spec.strategy.target_weights(ctx)
        app.log.write("targets", strategy=spec.strategy.name, weights=targets.weights, reason=targets.reason)
        limits = app.risk_config.limits_for(market)
        orders = plan_orders(
            targets=targets,
            market=market,
            portfolio=portfolio,
            quotes=quotes,
            limits=limits,
            quantity_step=spec.quantity_step,
            price_tick=spec.price_tick,
            id_prefix=now.strftime("%Y%m%dT%H%M%S"),
        )
    except (LookaheadError, SizingError, MissingQuoteError, ValueError, ArithmeticError) as exc:
        return _fail(app, report, "Strategy/sizing error", f"{type(exc).__name__}: {exc}")
    app.log.write("orders_planned", count=len(orders), orders=orders)

    for order in orders:
        blocked = app.engine.blocked_reason()
        if blocked:
            # A limit was hit while this cycle was trading (e.g. inside evaluate()).
            app.alerter.alert("critical", "Risk limit hit mid-cycle: trading HALTED", blocked)
            app.router.cancel_risk_adding()
            report.status = "halted"
            report.messages.append(blocked)
            break
        result = app.router.submit(order, portfolio, quotes)
        if result.sent:
            report.orders_sent += 1
        else:
            report.orders_rejected += 1
        if result.error:
            report.status = "halted"
            report.messages.append(result.error)
            break
        try:
            account = sync_ledger(app)
        except SYNC_ERRORS as exc:
            return _fail(app, report, "Cannot sync with broker", str(exc))
        portfolio = portfolio_view(app, account)

    # A limit tripped by the LAST order (inside evaluate) must not end the run as "done".
    blocked = app.engine.blocked_reason()
    if blocked and report.status == "done":
        app.alerter.alert("critical", "Risk limit hit mid-cycle: trading HALTED", blocked)
        app.router.cancel_risk_adding()
        report.status = "halted"
        report.messages.append(blocked)

    # End of cycle: unfilled orders do not survive until the next run (exits keep working).
    try:
        account = sync_ledger(app)
        if any(not o.request.reduce_only for o in account.open_orders):
            cancelled = app.router.cancel_non_exits()
            app.log.write("unfilled_orders_cancelled", cancelled=cancelled)
            account = sync_ledger(app)
    except SYNC_ERRORS as exc:
        return _fail(app, report, "Cannot sync with broker", str(exc))
    if not reconcile_or_halt(app, account, "end"):
        report.status = "halted"
        report.messages.append("reconciliation mismatch at end")

    final = account.to_portfolio()
    final_quotes = app.quotes_for(set(final.positions) | set(universe))
    try:
        final_equity = final.equity(final_quotes)
    except MissingQuoteError as exc:
        return _fail(app, report, "Cannot value portfolio after trading", str(exc))
    breaches = cap_breaches(app, final, final_quotes, final_equity)
    if breaches:
        return _fail(app, report, "Position cap exceeded after trading", "; ".join(breaches))
    app.log.write(
        "cycle_end",
        status=report.status,
        orders_sent=report.orders_sent,
        orders_rejected=report.orders_rejected,
        cash=account.cash,
        equity=final_equity,
    )
    return report


def cap_breaches(
    app: CycleParts, portfolio: PortfolioSnapshot, quotes: Mapping[str, Quote], equity: Decimal
) -> list[str]:
    """Defence in depth: after trading, no position may sit far above its hard cap."""
    breaches: list[str] = []
    for symbol, pos in portfolio.positions.items():
        limits = app.risk_config.markets.get(pos.market)
        if limits is None or pos.quantity <= 0:
            continue
        value = portfolio.position_value(symbol, quotes)
        cap = min(limits.max_position_pct * equity, limits.max_position_eur)
        if value > cap * POST_CYCLE_CAP_TOLERANCE:
            breaches.append(f"{symbol} is EUR {value:.2f}, cap EUR {cap:.2f}")
    return breaches
