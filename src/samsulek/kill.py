"""The kill switch.

Order of operations (each step runs even if an earlier one failed):
1. Set the persistent KILL flag FIRST: from this instant no new risk can be added
   by any process, because the risk engine checks it before every order.
2. Cancel every open order at the broker.
3. Optionally (--flatten) sell every position the BROKER reports (not our ledger:
   in an emergency the broker is the source of truth), via reduce-only orders.
4. Report anything that could not be done, with a plain instruction to finish it
   by hand in the broker's app.

A running bot stops at its next check: the cycle checks the flag before trading
and the risk engine checks it before every order.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from samsulek.app import App
from samsulek.cycle import sync_ledger


@dataclass
class KillReport:
    cancelled: list[str] = field(default_factory=list)
    flattened: list[str] = field(default_factory=list)
    not_flattened: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return not self.errors and not self.not_flattened


def execute_kill(app: App, *, flatten: bool, reason: str) -> KillReport:
    report = KillReport()
    app.store.set_kill(reason, app.clock.now())
    app.log.write("kill_switch", reason=reason, flatten=flatten)

    try:
        report.cancelled = app.router.cancel_all()
    except Exception as exc:
        report.errors.append(f"cancelling open orders failed: {type(exc).__name__}: {exc}")

    if flatten:
        try:
            account = app.broker.account()
            portfolio = account.to_portfolio()
            quotes = app.quotes_for({s for s, p in portfolio.positions.items() if p.quantity > 0})
            results, report.not_flattened = app.router.flatten(
                portfolio, quotes, reason, app.config.sim.price_tick
            )
            report.flattened = [r.decision.order.symbol for r in results if r.sent]
        except Exception as exc:
            report.errors.append(f"flattening failed: {type(exc).__name__}: {exc}")

    try:
        sync_ledger(app)
    except Exception as exc:
        report.errors.append(f"ledger sync after kill failed: {type(exc).__name__}: {exc}")

    body = [f"reason: {reason}", f"cancelled orders: {len(report.cancelled)}"]
    if flatten:
        body.append(f"positions closed: {', '.join(report.flattened) or 'none'}")
    if report.not_flattened:
        body.append("NOT closed, close these by hand in the broker app: " + "; ".join(report.not_flattened))
    body.extend(report.errors)
    app.alerter.alert("critical", "KILL switch engaged: bot stopped", "\n".join(body))
    app.log.write(
        "kill_switch_done",
        cancelled=report.cancelled,
        flattened=report.flattened,
        not_flattened=report.not_flattened,
        errors=report.errors,
    )
    return report
