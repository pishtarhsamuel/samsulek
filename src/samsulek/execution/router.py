"""The order router: the ONLY component that sends orders to a broker.

Every order goes through ``RiskEngine.evaluate`` right here, immediately before
it is sent. Nothing else in the codebase calls ``broker.place_order``; a test
enforces that.

Fail closed: any broker error or rejection halts trading and alerts the owner,
because it means our view of the account may be wrong.
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
from samsulek.types import BrokerOrder, OrderRequest, OrderType, PortfolioSnapshot, Quote, RiskDecision, Side


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
        register_client_id: Callable[[str], None] | None = None,
    ) -> None:
        self._broker = broker
        self._risk = risk
        self._log = decision_log
        self._alerter = alerter
        # Called right before sending, so reconciliation recognises our own open orders.
        self._register = register_client_id

    def submit(
        self, order: OrderRequest, portfolio: PortfolioSnapshot, quotes: Mapping[str, Quote]
    ) -> SubmitResult:
        decision = self._risk.evaluate(order, portfolio, quotes)
        self._log.write(
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
        try:
            # Count the order before sending: if the send times out after the broker
            # accepted it, we must not under-count toward the daily limit.
            self._risk.record_submission(order)
            if self._register is not None:
                self._register(order.client_id)
            broker_order = self._broker.place_order(order)
        except BrokerRejected as exc:
            return self._fail(decision, order, f"broker rejected order: {exc}")
        except Exception as exc:
            return self._fail(decision, order, f"broker error ({type(exc).__name__}): {exc}")
        self._log.write(
            "order_sent",
            client_id=order.client_id,
            broker_id=broker_order.broker_id,
            status=broker_order.status,
            filled_quantity=broker_order.filled_quantity,
        )
        return SubmitResult(decision=decision, broker_order=broker_order)

    def _fail(self, decision: RiskDecision, order: OrderRequest, error: str) -> SubmitResult:
        self._risk.halt(f"{error} (order {order.client_id})")
        self._log.write("order_failed", client_id=order.client_id, error=error)
        self._alerter.alert("critical", "Order failed: trading HALTED", error)
        return SubmitResult(decision=decision, error=error)

    def cancel_all(self) -> list[str]:
        ids = self._broker.cancel_all_orders()
        self._log.write("cancel_all", cancelled=ids)
        return ids

    def flatten(
        self, portfolio: PortfolioSnapshot, quotes: Mapping[str, Quote], reason: str, price_tick: Decimal
    ) -> tuple[list[SubmitResult], list[str]]:
        """Submit reduce-only sells for every position. Returns (results, symbols not flattened)."""
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
