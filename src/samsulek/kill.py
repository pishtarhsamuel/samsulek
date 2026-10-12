"""The kill switch.

Order of operations (each step runs even if an earlier one failed):
1. Set the persistent KILL flag FIRST: from this instant no new risk can be added
   by any process. The risk engine checks it before every order, and the router
   re-checks it right before sending.
2. Briefly wait for a running cycle to finish (it stops at its next check), so
   the two processes don't write the same files at once. If it doesn't finish
   in time, carry on anyway: stopping matters more.
3. Cancel every open order at the broker.
4. Optionally (--flatten) sell every position the BROKER reports (not our ledger:
   in an emergency the broker is the source of truth), via reduce-only orders.
5. Cancel risk-adding orders again (catches anything a racing cycle sent; our
   exit orders keep working), re-read the broker, and report every position still
   held, with a plain instruction to close it by hand.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from samsulek.app import App
from samsulek.cycle import sync_ledger
from samsulek.runlock import AlreadyRunningError, RunLock
from samsulek.types import OrderStatus


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


def execute_kill(app: App, *, flatten: bool, reason: str, lock_wait_seconds: float = 20.0) -> KillReport:
    report = KillReport()
    try:
        app.store.set_kill(reason, app.clock.now())
        report.flag_set = True
    except Exception as exc:
        report.errors.append(f"KILL FLAG NOT PERSISTED: {type(exc).__name__}: {exc}")
    _safe_log(app, report, "kill_switch", reason=reason, flatten=flatten)

    lock = RunLock(app.config.state_dir, app.clock, wait_seconds=lock_wait_seconds)
    try:
        lock.__enter__()
        have_lock = True
    except (AlreadyRunningError, OSError) as exc:
        have_lock = False
        report.notes.append(f"a trading run may still be active ({exc}); proceeding anyway")
    try:
        _cancel(app, report)
        if flatten:
            _flatten(app, report, reason)
        # Second pass: anything risk-adding a racing cycle managed to send. Our own
        # reduce-only exit orders stay working at the broker.
        for oid in app.router.cancel_risk_adding():
            if oid not in report.cancelled:
                report.cancelled.append(oid)
        try:
            sync_ledger(app)
        except Exception as exc:
            report.errors.append(f"ledger sync after kill failed: {type(exc).__name__}: {exc}")
        if flatten:
            _verify_flat(app, report)
    finally:
        if have_lock:
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


def _cancel(app: App, report: KillReport) -> None:
    try:
        for oid in app.router.cancel_all():
            if oid not in report.cancelled:
                report.cancelled.append(oid)
    except Exception as exc:
        report.errors.append(f"cancelling open orders failed: {type(exc).__name__}: {exc}")


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


def _verify_flat(app: App, report: KillReport) -> None:
    """Trust only the broker: anything still held is reported, whatever the orders said."""
    try:
        account = app.broker.account()
    except Exception as exc:
        report.errors.append(f"could not re-check positions after flatten: {type(exc).__name__}: {exc}")
        return
    already = {item.split(":", 1)[0] for item in report.not_flattened}
    for symbol, pos in sorted(account.positions.items()):
        if pos.quantity > 0 and symbol not in already:
            report.not_flattened.append(
                f"{symbol}: still held ({pos.quantity}); "
                "the exit order has not filled (it may still be working)"
            )
        if symbol in report.flattened and pos.quantity > 0:
            report.flattened.remove(symbol)
