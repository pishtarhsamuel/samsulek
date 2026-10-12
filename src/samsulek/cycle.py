"""One trading cycle: reconcile -> data checks -> strategy -> sizing -> risk -> orders -> reconcile.

Every early exit is fail-closed: broker errors, ledger mismatches, missing or
stale data, and any unexpected exception HALT (owner reset required) and alert.

Orders live for one cycle only (DAY semantics): open orders left from earlier
runs are cancelled before planning, and anything still unfilled at the end of
the cycle is cancelled. While a cycle runs, open orders count toward cash,
position and exposure limits.
"""

from __future__ import annotations

import contextlib
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal

from samsulek.app import App
from samsulek.execution.broker import BrokerError
from samsulek.portfolio.ledger import LedgerError
from samsulek.portfolio.reconcile import reconcile
from samsulek.risk.sizing import SizingError, plan_orders
from samsulek.risk.state import StateCorruptError
from samsulek.runlock import AlreadyRunningError, RunLock
from samsulek.strategies.base import LookaheadError, StrategyContext
from samsulek.types import AccountSnapshot, Bar, Market, MissingQuoteError, Mode, PortfolioSnapshot, Quote

# Daily bars: the latest bar may be up to 4 calendar days old (weekend + holiday).
MAX_BAR_AGE = timedelta(days=4)
# After a cycle, a position more than 10% above its cap means something went wrong
# (price drift within one cycle is far smaller).
POST_CYCLE_CAP_TOLERANCE = Decimal("1.10")
SYNC_ERRORS = (BrokerError, LedgerError, StateCorruptError, OSError, ArithmeticError, ValueError)


@dataclass
class CycleReport:
    status: str  # "done" | "halted" | "blocked" | "error"
    messages: list[str] = field(default_factory=list)
    orders_sent: int = 0
    orders_rejected: int = 0

    @property
    def ok(self) -> bool:
        return self.status == "done"


def sync_ledger(app: App) -> AccountSnapshot:
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


def portfolio_view(app: App, account: AccountSnapshot) -> PortfolioSnapshot:
    """Our ledger, plus the orders the broker says are still open."""
    return app.ledger.snapshot(app.clock.now(), tuple(o.request for o in account.open_orders))


def halt_and_alert(app: App, title: str, detail: str) -> None:
    """Alert first (never raises), then persist the halt, then cancel risk-adding orders."""
    app.alerter.alert("critical", f"{title}: trading HALTED", detail)
    try:
        app.engine.halt(f"{title}: {detail}")
    except Exception as exc:
        app.alerter.alert(
            "critical", "COULD NOT PERSIST HALT: stop the bot by hand", f"{type(exc).__name__}: {exc}"
        )
    app.router.cancel_risk_adding()


def reconcile_or_halt(app: App, account: AccountSnapshot, when: str) -> bool:
    result = reconcile(app.ledger.snapshot(app.clock.now()), account, app.ledger.known_client_ids)
    app.log.write("reconcile", when=when, ok=result.ok, differences=result.differences)
    if not result.ok:
        halt_and_alert(app, "Ledger and broker disagree", "\n".join(result.differences))
    return result.ok


def _fail(app: App, report: CycleReport, title: str, detail: str) -> CycleReport:
    halt_and_alert(app, title, detail)
    with contextlib.suppress(Exception):  # the halt and alert above matter; this line is best effort
        app.log.write("cycle_end", status="halted", reason=f"{title}: {detail}")
    report.status = "halted"
    report.messages.append(f"{title}: {detail}")
    return report


def _bars_problem(bars: dict[str, list[Bar]], symbols: list[str], now: datetime) -> str | None:
    for symbol in symbols:
        series = bars.get(symbol) or []
        if not series:
            return f"no price history for {symbol}"
        age = now - series[-1].close_ts
        if age > MAX_BAR_AGE:
            return f"latest {symbol} bar is {age.days} days old"
    return None


def run_cycle(app: App) -> CycleReport:
    report = CycleReport(status="done")
    try:
        app.log.write("cycle_start", mode=app.mode, strategy=app.strategy.name)
        blocked = app.engine.blocked_reason()
        if blocked:
            if "unreadable" in blocked:
                app.alerter.alert("critical", "Risk state unreadable: trading blocked", blocked)
            app.log.write("cycle_end", status="blocked", reason=blocked)
            report.status = "blocked"
            report.messages.append(blocked)
            return report
        try:
            with RunLock(app.config.state_dir, app.clock) as lock:
                if lock.took_over_stale:
                    app.alerter.alert(
                        "warning", "Took over a stale run lock", "a previous run did not finish cleanly"
                    )
                return _run_locked(app, report)
        except AlreadyRunningError as exc:
            app.alerter.alert("warning", "Run skipped: another run is in progress", str(exc))
            app.log.write("cycle_end", status="blocked", reason=str(exc))
            report.status = "blocked"
            report.messages.append(str(exc))
            return report
    except Exception as exc:  # anything unexpected: halt, alert, report
        detail = f"{type(exc).__name__}: {exc}"
        halt_and_alert(app, "Unexpected error in the trading cycle", detail)
        report.status = "error"
        report.messages.append(detail)
        return report


def _run_locked(app: App, report: CycleReport) -> CycleReport:
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
    if account.open_orders:
        try:
            cancelled = app.router.cancel_all()
            app.log.write("stale_orders_cancelled", cancelled=cancelled)
            account = sync_ledger(app)
        except SYNC_ERRORS as exc:
            return _fail(app, report, "Cannot cancel leftover open orders", str(exc))
        if not reconcile_or_halt(app, account, "after cancelling leftover orders"):
            report.status = "halted"
            report.messages.append("reconciliation mismatch after cancelling leftover orders")
            return report

    market = Market.STOCKS
    universe = list(app.config.universe.get(market, []))
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
    problem = _bars_problem(bars, universe, now)
    if problem:
        return _fail(app, report, "Stale or missing data", problem)
    try:
        ctx = StrategyContext(asof=now, market=market, bars={s: bars[s] for s in universe})
        targets = app.strategy.target_weights(ctx)
        app.log.write("targets", strategy=app.strategy.name, weights=targets.weights, reason=targets.reason)
        limits = app.risk_config.limits_for(market)
        orders = plan_orders(
            targets=targets,
            market=market,
            portfolio=portfolio,
            quotes=quotes,
            limits=limits,
            quantity_step=app.config.sim.quantity_step,
            price_tick=app.config.sim.price_tick,
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

    # End of cycle: unfilled orders do not survive until the next run.
    try:
        account = sync_ledger(app)
        if account.open_orders:
            cancelled = app.router.cancel_all()
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
    app: App, portfolio: PortfolioSnapshot, quotes: Mapping[str, Quote], equity: Decimal
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
