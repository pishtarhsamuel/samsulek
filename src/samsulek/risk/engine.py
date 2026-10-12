"""The risk engine: every order is checked here before it can reach a broker.

Design rules
- Strategy code never calls this directly; ``execution/router.py`` does, for
  every single order, and the router is the only path to a broker.
- Fail closed: missing/stale/future-dated prices, unreadable state, unknown
  symbols or markets -> REJECT.
- Orders that only REDUCE an existing long position (``reduce_only``) are
  allowed even while halted or killed, so emergency exits always work. They
  still need a fresh price and must respect the (wider) flatten slippage cap.
- Daily-loss, drawdown and equity-sanity breaches set a persistent HALT that
  only the owner can clear (``samsulek reset-halt`` at a real terminal).
"""

from __future__ import annotations

import contextlib
from collections.abc import Collection, Mapping
from dataclasses import replace
from datetime import timedelta
from decimal import Decimal

from samsulek.clock import Clock, trading_day
from samsulek.config import MarketLimits, RiskConfig
from samsulek.logging_setup import DecisionLog
from samsulek.risk.state import DayState, RiskStateStore, StateCorruptError
from samsulek.types import (
    Market,
    MissingQuoteError,
    OrderRequest,
    OrderType,
    PortfolioSnapshot,
    Quote,
    RiskDecision,
    Side,
)

BPS = Decimal(10_000)
# Tolerate small clock differences between us and the price source.
MAX_FUTURE_SKEW = timedelta(seconds=5)
TOTAL = "total"


class RiskEngine:
    def __init__(
        self,
        config: RiskConfig,
        store: RiskStateStore,
        clock: Clock,
        universe: Mapping[Market, Collection[str]],
        decision_log: DecisionLog | None = None,
    ) -> None:
        self._config = config
        self._store = store
        self._clock = clock
        self._universe = {m: frozenset(s) for m, s in universe.items()}
        self._log = decision_log

    @property
    def config(self) -> RiskConfig:
        return self._config

    # ------------------------------------------------------------------ state
    def blocked_reason(self) -> str | None:
        """Why NEW risk is blocked right now, or None if trading is allowed."""
        try:
            kill = self._store.read_kill()
            halt = self._store.read_halt()
        except Exception as exc:  # any read problem blocks new risk; exits stay allowed
            return f"risk state unreadable ({type(exc).__name__}: {exc}); failing closed"
        if kill.active:
            return "KILL switch is active: " + "; ".join(kill.reasons)
        if halt.active:
            return "trading is HALTED: " + "; ".join(halt.reasons)
        return None

    def halt(self, reason: str) -> None:
        self._store.set_halt(reason, self._clock.now())  # may raise: callers must know
        if self._log:
            with contextlib.suppress(Exception):  # the halt is persisted; the log line is best effort
                self._log.write("halt", reason=reason)

    def _today(self) -> DayState | None:
        return self._store.read_day()

    def observe_equity(self, equity: Decimal) -> list[str]:
        """Record equity, roll the trading day, and HALT on loss/drawdown/sanity breaches.

        Returns the halt reasons tripped by this observation (empty if none).
        """
        acc = self._config.account
        now = self._clock.now()
        today = trading_day(now, acc.risk_day_timezone)
        tripped: list[str] = []

        if not equity.is_finite() or equity <= 0:
            tripped.append(f"equity is {equity} (zero, negative or invalid)")
        elif equity > acc.equity_sanity_max_eur:
            tripped.append(
                f"equity EUR {equity} is above the sanity maximum EUR {acc.equity_sanity_max_eur} "
                "(bug, or an unannounced deposit)"
            )
        if tripped:
            # Don't let an anomalous value move the day baseline or the peak.
            for reason in tripped:
                self.halt(reason)
            return tripped

        try:
            day = self._store.read_day()
            peak = self._store.read_peak()
        except StateCorruptError as exc:
            reason = f"risk state unreadable ({exc}); failing closed"
            self.halt(reason)
            return [reason]

        # A baseline of 0 means "not observed yet" (e.g. an emergency exit was counted first).
        if day is None:
            day = DayState(day=today, day_start_equity=equity, last_equity=equity, trades={})
        elif day.day < today:
            # New day. Baseline = the HIGHER of the last equity we saw and today's first
            # observation: an overnight gap DOWN counts against today's limit, and an
            # overnight gap UP is not credited as extra loss allowance.
            start = max(day.last_equity, equity) if day.last_equity > 0 else equity
            day = DayState(day=today, day_start_equity=start, last_equity=equity, trades={})
        elif day.day > today:
            reason = f"clock moved backwards (state day {day.day}, now {today})"
            self.halt(reason)
            return [reason]
        else:
            if day.day_start_equity > 0:
                start = day.day_start_equity
            else:  # baseline not observed yet today (an exit was counted first)
                start = max(day.last_equity, equity) if day.last_equity > 0 else equity
            day = replace(day, day_start_equity=start, last_equity=equity)
        self._store.write_day(day)

        peak = equity if peak is None else max(peak, equity)
        self._store.write_peak(peak)

        if day.day_start_equity > 0:
            daily_loss = (day.day_start_equity - equity) / day.day_start_equity
            if daily_loss >= acc.max_daily_loss_pct:
                tripped.append(
                    f"daily loss {daily_loss:.2%} reached the limit {acc.max_daily_loss_pct:.2%} "
                    f"(EUR {day.day_start_equity} -> EUR {equity})"
                )
        drawdown = (peak - equity) / peak
        if drawdown >= acc.max_drawdown_pct:
            tripped.append(
                f"drawdown {drawdown:.2%} from peak EUR {peak} reached the limit {acc.max_drawdown_pct:.2%}"
            )
        for reason in tripped:
            self.halt(reason)
        return tripped

    def record_submission(self, order: OrderRequest) -> None:
        """Count an order toward the daily trade limits. Called BEFORE it is sent (conservative)."""
        now = self._clock.now()
        today = trading_day(now, self._config.account.risk_day_timezone)
        day = self._store.read_day()
        if day is None:
            day = DayState(day=today, day_start_equity=Decimal(0), last_equity=Decimal(0), trades={})
        elif day.day < today:
            # New day, baseline not observed yet: observe_equity sets it to max(last, first).
            day = DayState(day=today, day_start_equity=Decimal(0), last_equity=day.last_equity, trades={})
        elif day.day > today:
            # Clock moved backwards: keep the real day's counts and baseline, and halt
            # (exits stay allowed). Rolling back would wipe the day's trade count.
            self.halt(f"clock moved backwards (state day {day.day}, now {today})")
        trades = dict(day.trades)
        trades[TOTAL] = trades.get(TOTAL, 0) + 1
        trades[order.market.value] = trades.get(order.market.value, 0) + 1
        self._store.write_day(replace(day, trades=trades))

    # --------------------------------------------------------------- evaluate
    def evaluate(
        self,
        order: OrderRequest,
        portfolio: PortfolioSnapshot,
        quotes: Mapping[str, Quote],
    ) -> RiskDecision:
        checks: list[str] = []
        reasons: list[str] = []
        equity: Decimal | None = None

        def decision() -> RiskDecision:
            return RiskDecision(
                approved=not reasons,
                order=order,
                reasons=tuple(reasons),
                checks=tuple(checks),
                equity=equity,
                halted=self.blocked_reason() is not None,
            )

        # 1. Market must be configured.
        limits = self._config.markets.get(order.market)
        if limits is None:
            reasons.append(f"no risk limits configured for market {order.market.value}")
            return decision()
        checks.append("market configured")

        held_qty = portfolio.quantity(order.symbol)
        sellable_qty = portfolio.sellable_quantity(order.symbol)  # minus open sell orders

        # 2. Instrument allow-list (exits of a held symbol are always allowed).
        allowed = self._universe.get(order.market, frozenset())
        if order.symbol not in allowed and not (order.reduce_only and held_qty > 0):
            reasons.append(f"{order.symbol} is not in the {order.market.value} universe")
            return decision()
        checks.append("symbol allowed")

        # 3. A fresh, consistent reference price for this symbol.
        quote = quotes.get(order.symbol)
        problem = self._quote_problem(order.symbol, order.market, quote, limits)
        if problem or quote is None:
            reasons.append(problem or f"no price for {order.symbol}")
            return decision()
        checks.append("price fresh")

        # 4. Market orders are off unless explicitly allowed.
        if order.order_type is OrderType.MARKET and not limits.allow_market_orders:
            reasons.append("market orders are not allowed (use a limit order)")
            return decision()

        # 5. Slippage collar on the limit price.
        collar_bps = limits.flatten_max_slippage_bps if order.reduce_only else limits.max_slippage_bps
        collar = collar_bps / BPS
        worst_buy = quote.price * (1 + collar)
        worst_sell = quote.price * (1 - collar)
        if order.limit_price is not None:
            if order.side is Side.BUY and order.limit_price > worst_buy:
                reasons.append(
                    f"buy limit {order.limit_price} exceeds the {collar_bps} bps cap over reference "
                    f"{quote.price} (max {worst_buy:.6f})"
                )
            if order.side is Side.SELL and order.limit_price < worst_sell:
                reasons.append(
                    f"sell limit {order.limit_price} is below the {collar_bps} bps cap under reference "
                    f"{quote.price} (min {worst_sell:.6f})"
                )
        checks.append(f"slippage cap {collar_bps} bps")
        exec_price = order.limit_price or (worst_buy if order.side is Side.BUY else worst_sell)
        notional = order.quantity * exec_price

        # 6. Reduce-only exits: allowed even when halted/killed.
        if order.reduce_only:
            if order.side is not Side.SELL:
                reasons.append("reduce_only orders must be sells (long-only account)")
            if order.quantity > sellable_qty:
                reasons.append(
                    f"reduce_only sell of {order.quantity} exceeds the sellable position {sellable_qty} "
                    f"(held {held_qty}, minus open sell orders)"
                )
            checks.append("reduce-only exit")
            return decision()

        # 7. Value the whole portfolio (and every open order) with fresh prices.
        to_value = {s: p.market for s, p in portfolio.positions.items() if p.quantity != 0}
        to_value.update({o.symbol: o.market for o in portfolio.open_orders})
        for symbol, market in to_value.items():
            if symbol == order.symbol:
                continue
            sym_limits = self._config.markets.get(market)
            if sym_limits is None:
                reasons.append(f"{symbol} is in an unconfigured market")
                continue
            held_problem = self._quote_problem(symbol, market, quotes.get(symbol), sym_limits)
            if held_problem:
                reasons.append(f"cannot value portfolio: {held_problem}")
        if reasons:
            return decision()
        try:
            equity = portfolio.equity(quotes)
        except MissingQuoteError as exc:
            reasons.append(f"cannot value portfolio: {exc}")
            return decision()
        checks.append(f"equity EUR {equity}")
        self.observe_equity(equity)

        # 8. Halt / kill / unreadable state blocks all new risk.
        blocked = self.blocked_reason()
        if blocked:
            reasons.append(blocked)
            return decision()
        checks.append("not halted")

        # 9. Daily trade counts.
        try:
            day = self._today()
        except StateCorruptError as exc:
            reasons.append(f"risk state unreadable ({exc}); failing closed")
            return decision()
        market_trades = day.trades_for(order.market.value) if day else 0
        total_trades = day.trades_for(TOTAL) if day else 0
        if market_trades >= limits.max_trades_per_day:
            reasons.append(
                f"{order.market.value} trades today {market_trades} >= limit {limits.max_trades_per_day}"
            )
        if total_trades >= self._config.account.max_trades_per_day:
            reasons.append(
                f"total trades today {total_trades} >= limit {self._config.account.max_trades_per_day}"
            )
        checks.append("trade count")

        # 10. Order size bounds.
        if notional < limits.min_order_eur:
            reasons.append(f"order value EUR {notional:.2f} is below the minimum EUR {limits.min_order_eur}")
        if notional > limits.max_order_eur:
            reasons.append(f"order value EUR {notional:.2f} exceeds the maximum EUR {limits.max_order_eur}")
        checks.append("order size")

        if order.side is Side.BUY:
            self._check_buy(
                order=order,
                portfolio=portfolio,
                quotes=quotes,
                quote=quote,
                limits=limits,
                equity=equity,
                exec_price=exec_price,
                notional=notional,
                reasons=reasons,
                checks=checks,
            )
        elif order.quantity > sellable_qty:
            reasons.append(
                f"sell of {order.quantity} exceeds the sellable position {sellable_qty} "
                f"(held {held_qty}, minus open sell orders; no short selling)"
            )
        return decision()

    # ---------------------------------------------------------------- helpers
    def _quote_problem(
        self, symbol: str, market: Market, quote: Quote | None, limits: MarketLimits
    ) -> str | None:
        if quote is None:
            return f"no price for {symbol}"
        if quote.symbol != symbol or quote.market is not market:
            return f"price record for {symbol} does not match ({quote.symbol}, {quote.market.value})"
        age = self._clock.now() - quote.ts
        if age < -MAX_FUTURE_SKEW:
            return f"price for {symbol} is timestamped in the future ({quote.ts.isoformat()})"
        if age > timedelta(seconds=limits.max_quote_age_seconds):
            return (
                f"price for {symbol} is stale: {int(age.total_seconds())}s old "
                f"(limit {limits.max_quote_age_seconds}s)"
            )
        return None

    def _open_buy_value(
        self,
        portfolio: PortfolioSnapshot,
        quotes: Mapping[str, Quote],
        *,
        symbol: str | None = None,
        market: Market | None = None,
    ) -> tuple[Decimal, Decimal]:
        """(cash reserved, exposure added) by OPEN buy orders, valued at their worst price.

        Callers have already checked that every open order has a fresh quote.
        """
        reserved = Decimal(0)
        exposure = Decimal(0)
        for o in portfolio.open_orders:
            if o.side is not Side.BUY:
                continue
            ref = quotes[o.symbol].price
            if o.limit_price is not None:
                price = o.limit_price
            else:
                o_limits = self._config.limits_for(o.market)
                price = ref * (1 + o_limits.max_slippage_bps / BPS)
            if (symbol is None or o.symbol == symbol) and (market is None or o.market is market):
                reserved += o.quantity * price
                exposure += o.quantity * max(price, ref)
        return reserved, exposure

    def _check_buy(
        self,
        *,
        order: OrderRequest,
        portfolio: PortfolioSnapshot,
        quotes: Mapping[str, Quote],
        quote: Quote,
        limits: MarketLimits,
        equity: Decimal,
        exec_price: Decimal,
        notional: Decimal,
        reasons: list[str],
        checks: list[str],
    ) -> None:
        # Open buys already claim cash and will add exposure when they fill: count them.
        reserved_all, pending_all = self._open_buy_value(portfolio, quotes)
        _, pending_symbol = self._open_buy_value(portfolio, quotes, symbol=order.symbol)
        _, pending_market = self._open_buy_value(portfolio, quotes, market=order.market)
        available_cash = portfolio.cash - reserved_all
        if notional > available_cash:
            reasons.append(
                f"order value EUR {notional:.2f} exceeds available cash EUR {available_cash:.2f} "
                f"(cash EUR {portfolio.cash:.2f} minus EUR {reserved_all:.2f} reserved by open buys; "
                "no leverage)"
            )
        # Value the added quantity at the worse of limit and reference price.
        added = order.quantity * max(exec_price, quote.price)
        new_position = portfolio.position_value(order.symbol, quotes) + pending_symbol + added
        if new_position > limits.max_position_pct * equity:
            reasons.append(
                f"position would be EUR {new_position:.2f} > {limits.max_position_pct:.0%} of equity "
                f"(EUR {limits.max_position_pct * equity:.2f})"
            )
        if new_position > limits.max_position_eur:
            reasons.append(f"position would be EUR {new_position:.2f} > cap EUR {limits.max_position_eur}")
        new_gross_market = portfolio.gross_exposure(quotes, order.market) + pending_market + added
        if new_gross_market > limits.max_gross_exposure_pct * equity:
            reasons.append(
                f"{order.market.value} exposure would be EUR {new_gross_market:.2f} > "
                f"{limits.max_gross_exposure_pct:.0%} of equity"
            )
        if new_gross_market > limits.max_gross_exposure_eur:
            reasons.append(
                f"{order.market.value} exposure would be EUR {new_gross_market:.2f} > "
                f"cap EUR {limits.max_gross_exposure_eur}"
            )
        if portfolio.gross_exposure(quotes) + pending_all + added > equity:
            reasons.append("total exposure would exceed equity (no leverage)")
        checks.append("position and exposure caps")

        if limits.max_pool_liquidity_pct is not None:
            liquidity = quote.pool_liquidity_eur
            if liquidity is None or liquidity <= 0:
                reasons.append(f"no pool liquidity data for {order.symbol}")
            elif new_position > limits.max_pool_liquidity_pct * liquidity:
                reasons.append(
                    f"position EUR {new_position:.2f} > {limits.max_pool_liquidity_pct:.2%} of pool "
                    f"liquidity EUR {liquidity:.2f} (exit would not be possible)"
                )
            checks.append("pool liquidity cap")
        if limits.require_safety_pass:
            if quote.safety_passed is not True:
                reasons.append(f"{order.symbol} has no passing safety-filter result")
            checks.append("safety filter")
