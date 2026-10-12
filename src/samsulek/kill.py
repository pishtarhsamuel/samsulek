"""The kill switch.

Order of operations (each step runs even if an earlier one failed):
1. Set the persistent KILL flag FIRST: from this instant no new risk can be added
   by any process. The risk engine checks it before every order, and the router
   re-checks it right before sending.
2. Briefly wait for a running cycle to finish (it stops at its next check), so
   the two processes don't write the same files at once. If it doesn't finish
   in time, carry on anyway: stopping matters more.
3. Cancel open orders at the broker. With --flatten: every order (fresh exits
   at current prices replace any old ones). Without: every order EXCEPT
   reduce-only exits left by an earlier flatten, which only reduce risk.
4. Optionally (--flatten) sell every position the BROKER reports (not our ledger:
   in an emergency the broker is the source of truth), via reduce-only orders.
5. Cancel risk-adding orders again (catches anything a racing cycle sent; our
   exit orders keep working). If that freed shares, try selling them too.
6. Re-read the broker and report every position still held, saying whether a
   sell order is really working for it, with a plain instruction to act by hand.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from samsulek.app import App
from samsulek.cycle import sync_ledger
from samsulek.runlock import RunLock
from samsulek.types import OrderStatus, Side


@dataclass
class KillReport:
    flag_set: bool = False
    cancelled: list[str] = field(default_factory=list)
    flattened: list[str] = field(default_factory=list)
    not_flattened: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return self.flag_set and not self.errors and not self.not_flattened


def execute_kill(
    app: App, *, flatten: bool, reason: str, lock_wait_seconds: float = 20.0, already_locked: bool = False
) -> KillReport:
    """``already_locked``: the caller (the CLI) took the run lock BEFORE loading broker/ledger files."""
    report = KillReport()
    try:
        app.store.set_kill(reason, app.clock.now())
        report.flag_set = True
    except Exception as exc:
        report.errors.append(f"KILL FLAG NOT PERSISTED: {type(exc).__name__}: {exc}")
    _safe_log(app, report, "kill_switch", reason=reason, flatten=flatten)

    lock: RunLock | None = None
    if not already_locked:
        try:
            lock = RunLock(app.config.state_dir, app.clock, wait_seconds=lock_wait_seconds).__enter__()
        except Exception as exc:  # busy, unreadable, anything: stopping matters more
            report.notes.append(
                f"a trading run may still be active ({type(exc).__name__}: {exc}); proceeding"
            )
    try:
        cancel_errors_before = len(report.errors)
        if flatten:
            _cancel(app, report)
        else:
            _cancel_keeping_exits(app, report)
        if len(report.errors) > cancel_errors_before:
            # Cancelling failed: retry order by order, so resting strategy sells don't
            # block the exit (the flatten only sells what isn't already claimed).
            _record_cancelled(report, app.router.cancel_risk_adding())
        if flatten:
            _flatten(app, report, reason)
        # Second pass: anything risk-adding a racing cycle managed to send. Our own
        # reduce-only exit orders stay working at the broker.
        freed = _record_cancelled(report, app.router.cancel_risk_adding())
        if flatten and freed:
            _flatten(app, report, reason)  # shares those orders were holding back are free now
        try:
            sync_ledger(app)
        except Exception as exc:
            report.errors.append(f"ledger sync after kill failed: {type(exc).__name__}: {exc}")
        if flatten:
            _verify_flat(app, report)
        else:
            _note_kept_exits(app, report)
    finally:
        if lock is not None:
            lock.__exit__(None, None, None)

    body = [f"reason: {reason}", f"cancelled orders: {len(report.cancelled)}"]
    if flatten:
        body.append(f"positions closed: {', '.join(report.flattened) or 'none'}")
    if report.not_flattened:
        body.append("NOT closed, close these by hand in the broker app: " + "; ".join(report.not_flattened))
    body.extend(report.errors)
    body.extend(report.notes)
    title = (
        "KILL switch engaged: bot stopped"
        if report.flag_set
        else "KILL FLAG NOT PERSISTED: stop the bot by hand"
    )
    app.alerter.alert("critical", title, "\n".join(body))
    _safe_log(
        app,
        report,
        "kill_switch_done",
        cancelled=report.cancelled,
        flattened=report.flattened,
        not_flattened=report.not_flattened,
        errors=report.errors,
        notes=report.notes,
    )
    return report


def _safe_log(app: App, report: KillReport, kind: str, **fields: object) -> None:
    try:
        app.log.write(kind, **fields)
    except Exception as exc:
        report.notes.append(f"decision log write failed: {type(exc).__name__}: {exc}")


def _record_cancelled(report: KillReport, ids: list[str]) -> list[str]:
    new = [oid for oid in ids if oid not in report.cancelled]
    report.cancelled.extend(new)
    return new


def _cancel(app: App, report: KillReport) -> None:
    try:
        _record_cancelled(report, app.router.cancel_all())
    except Exception as exc:
        report.errors.append(f"cancelling open orders failed: {type(exc).__name__}: {exc}")


def _cancel_keeping_exits(app: App, report: KillReport) -> None:
    try:
        _record_cancelled(report, app.router.cancel_non_exits())
    except Exception as exc:
        report.errors.append(f"cancelling open orders failed: {type(exc).__name__}: {exc}")


def _note_kept_exits(app: App, report: KillReport) -> None:
    """A plain kill leaves earlier exit orders working: say so, so nobody thinks they were cancelled."""
    try:
        account = app.broker.account()
    except Exception as exc:
        report.errors.append(f"could not re-check open orders after kill: {type(exc).__name__}: {exc}")
        return
    for o in account.open_orders:
        if o.request.reduce_only:
            report.notes.append(
                f"exit order kept working: sell {o.request.quantity} {o.request.symbol} ({o.broker_id})"
            )


def _flatten(app: App, report: KillReport, reason: str) -> None:
    try:
        account = app.broker.account()
        portfolio = account.to_portfolio()
        quotes = app.quotes_for({s for s, p in portfolio.positions.items() if p.quantity > 0})
        results, problems = app.router.flatten(portfolio, quotes, reason, app.config.sim.price_tick)
        report.not_flattened.extend(problems)
        for r in results:
            if r.broker_order is not None and r.broker_order.status is OrderStatus.FILLED:
                report.flattened.append(r.decision.order.symbol)
    except Exception as exc:
        report.errors.append(f"flattening failed: {type(exc).__name__}: {exc}")


_CLAIMED = "already in an open sell order"


def _verify_flat(app: App, report: KillReport) -> None:
    """Trust only the broker: rebuild the list of positions still held from its final state,
    saying for each one whether a sell order is really still working."""
    try:
        account = app.broker.account()
    except Exception as exc:
        report.errors.append(f"could not re-check positions after flatten: {type(exc).__name__}: {exc}")
        return
    # Why an exit couldn't be sent (no price, rejected...). "Claimed by an open sell" is
    # re-derived below from the orders that are actually still open.
    why_not_sent: dict[str, str] = {}
    for item in report.not_flattened:
        symbol, _, why = item.partition(":")
        if _CLAIMED not in why:
            why_not_sent[symbol] = why.strip()
    working: dict[str, Decimal] = {}
    for o in account.open_orders:
        if o.request.side is Side.SELL:
            left = o.request.quantity - o.filled_quantity
            working[o.request.symbol] = working.get(o.request.symbol, Decimal(0)) + left
    report.not_flattened = []
    for symbol, pos in sorted(account.positions.items()):
        if pos.quantity <= 0:
            continue
        selling = working.get(symbol, Decimal(0))
        if selling >= pos.quantity:
            text = (
                f"{symbol}: still held ({pos.quantity}); a sell order for it is still working at the broker"
            )
        elif selling > 0:
            text = (
                f"{symbol}: still held ({pos.quantity}); only {selling} is in a working sell order, "
                "close the rest by hand"
            )
        else:
            text = f"{symbol}: still held ({pos.quantity}); NO sell order is working for it, close it by hand"
        if symbol in why_not_sent:
            text += f" (exit not sent: {why_not_sent[symbol]})"
        report.not_flattened.append(text)
        if symbol in report.flattened:
            report.flattened.remove(symbol)
