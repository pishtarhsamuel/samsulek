"""The order router: the ONLY component that sends orders to a broker.

Every order goes through ``RiskEngine.evaluate`` right here, immediately before
it is sent. Nothing else in the codebase calls ``broker.place_order``; a test
enforces that.

Fail closed: any broker error or rejection halts trading, alerts the owner and
cancels risk-adding open orders, because it means our view of the account may
be wrong.

Emergency exits (reduce-only orders) are never blocked by bookkeeping: if the
trade counter or the ledger can't be updated, the exit is still sent and the
failure is alerted.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal

from samsulek.alerts import Alerter
from samsulek.execution.broker import Broker, BrokerRejected
from samsulek.logging_setup import DecisionLog
from samsulek.risk.engine import BPS, RiskEngine
from samsulek.types import (
    BrokerOrder,
    OrderRequest,
    OrderType,
    PortfolioSnapshot,
    Quote,
    RiskDecision,
    Side,
)


@dataclass(frozen=True, slots=True)
class SubmitResult:
    decision: RiskDecision
    broker_order: BrokerOrder | None = None
    error: str | None = None

    @property
    def sent(self) -> bool:
        return self.broker_order is not None


class OrderRouter:
    def __init__(
        self,
        broker: Broker,
        risk: RiskEngine,
        decision_log: DecisionLog,
        alerter: Alerter,
        register_order: Callable[[OrderRequest], None] | None = None,
    ) -> None:
        self._broker = broker
        self._risk = risk
        self._log = decision_log
        self._alerter = alerter
        # Called right before sending, so the ledger accepts this order's fills and
        # reconciliation recognises it while it is open.
        self._register = register_order

    def _safe_log(self, kind: str, **fields: object) -> None:
        try:
            self._log.write(kind, **fields)
        except Exception as exc:  # logging must never stop a safety action
            self._alerter.alert("warning", "Decision log write failed", f"{type(exc).__name__}: {exc}")

    def submit(
        self, order: OrderRequest, portfolio: PortfolioSnapshot, quotes: Mapping[str, Quote]
    ) -> SubmitResult:
        decision = self._risk.evaluate(order, portfolio, quotes)
        self._safe_log(
            "risk_decision",
            approved=decision.approved,
            order=order,
            reasons=decision.reasons,
            checks=decision.checks,
            equity=decision.equity,
            halted=decision.halted,
        )
        if not decision.approved:
            return SubmitResult(decision=decision)

        # Count and register BEFORE sending: if the send times out after the broker
        # accepted the order, we must neither under-count nor reject its fills.
        try:
            self._risk.record_submission(order)
            if self._register is not None:
                self._register(order)
        except Exception as exc:
            if not order.reduce_only:
                return self._fail(decision, order, f"could not record order before sending: {exc}")
            self._alerter.alert(
                "critical",
                "Risk bookkeeping failed during an emergency exit: exit sent anyway, trading HALTED",
                f"{type(exc).__name__}: {exc}",
            )
            self._try_halt(f"bookkeeping failed during exit {order.client_id}: {exc}")

        # Last-moment re-check: a kill or halt may have landed since evaluate().
        if not order.reduce_only:
            blocked = self._risk.blocked_reason()
            if blocked:
                self._safe_log("order_withheld", client_id=order.client_id, reason=blocked)
                return SubmitResult(decision=decision, error=f"withheld: {blocked}")

        try:
            broker_order = self._broker.place_order(order)
        except BrokerRejected as exc:
            return self._fail(decision, order, f"broker rejected order: {exc}")
        except Exception as exc:
            return self._fail(decision, order, f"broker error ({type(exc).__name__}): {exc}")
        self._safe_log(
            "order_sent",
            client_id=order.client_id,
            broker_id=broker_order.broker_id,
            status=broker_order.status,
            filled_quantity=broker_order.filled_quantity,
        )
        return SubmitResult(decision=decision, broker_order=broker_order)

    def _try_halt(self, reason: str) -> bool:
        try:
            self._risk.halt(reason)
            return True
        except Exception as exc:
            self._alerter.alert(
                "critical",
                "COULD NOT PERSIST HALT: stop the bot by hand",
                f"{reason}\nhalt failed: {type(exc).__name__}: {exc}",
            )
            return False

    def _fail(self, decision: RiskDecision, order: OrderRequest, error: str) -> SubmitResult:
        # Alert first: the alerter never raises, persisting the halt might.
        self._alerter.alert("critical", "Order failed: trading HALTED", error)
        self._try_halt(f"{error} (order {order.client_id})")
        self.cancel_risk_adding()
        self._safe_log("order_failed", client_id=order.client_id, error=error)
        return SubmitResult(decision=decision, error=error)

    def cancel_all(self) -> list[str]:
        ids = self._broker.cancel_all_orders()
        self._safe_log("cancel_all", cancelled=ids)
        return ids

    def cancel_risk_adding(self) -> list[str]:
        """Best effort: cancel every open order that is not a reduce-only exit. Never raises."""
        cancelled: list[str] = []
        try:
            for bo in self._broker.account().open_orders:
                if not bo.request.reduce_only:
                    self._broker.cancel_order(bo.broker_id)
                    cancelled.append(bo.broker_id)
        except Exception as exc:
            self._alerter.alert(
                "critical",
                "Could not cancel open orders after a halt: cancel them by hand in the broker app",
                f"{type(exc).__name__}: {exc}",
            )
        if cancelled:
            self._safe_log("cancel_risk_adding", cancelled=cancelled)
        return cancelled

    def flatten(
        self, portfolio: PortfolioSnapshot, quotes: Mapping[str, Quote], reason: str, price_tick: Decimal
    ) -> tuple[list[SubmitResult], list[str]]:
        """Submit reduce-only sells for every position. Returns (results, problems per symbol)."""
        results: list[SubmitResult] = []
        not_flattened: list[str] = []
        for symbol, pos in sorted(portfolio.positions.items()):
            if pos.quantity <= 0:
                continue
            quote = quotes.get(symbol)
            if quote is None:
                not_flattened.append(f"{symbol}: no price available")
                continue
            limits = self._risk.config.limits_for(pos.market)
            floor = quote.price * (1 - limits.flatten_max_slippage_bps / BPS)
            limit = (floor / price_tick).to_integral_value(rounding=ROUND_CEILING) * price_tick
            order = OrderRequest(
                client_id=f"flatten-{symbol}-{uuid.uuid4().hex[:12]}",
                market=pos.market,
                symbol=symbol,
                side=Side.SELL,
                quantity=pos.quantity,
                order_type=OrderType.LIMIT,
                limit_price=limit,
                reduce_only=True,
                reason=f"flatten: {reason}",
            )
            result = self.submit(order, portfolio, quotes)
            results.append(result)
            if not result.sent:
                why = "; ".join(result.decision.reasons) or result.error or "not sent"
                not_flattened.append(f"{symbol}: {why}")
        return results, not_flattened
