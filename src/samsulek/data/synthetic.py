"""SYNTHETIC prices for M1 plumbing tests. Not market data; never research on this.

A deterministic random walk per symbol (seeded), one bar per calendar day closing
at 15:30 UTC, plus a "current" quote stamped at the time it is requested.
"""

from __future__ import annotations

import hashlib
import random
from collections.abc import Sequence
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal

from samsulek.clock import Clock
from samsulek.types import Bar, Market, Quote, require_aware

CLOSE_TIME_UTC = time(15, 30, tzinfo=UTC)
EPOCH = datetime(2020, 1, 1, 15, 30, tzinfo=UTC)


class SyntheticFeed:
    def __init__(self, symbols: Sequence[str], market: Market, clock: Clock, seed: int = 7) -> None:
        self._symbols = list(symbols)
        self._market = market
        self._clock = clock
        self._seed = seed

    def _rng(self, symbol: str) -> random.Random:
        digest = hashlib.sha256(f"{self._seed}:{symbol}".encode()).digest()
        return random.Random(int.from_bytes(digest[:8], "big"))

    def _series(self, symbol: str, n_days: int) -> list[float]:
        rng = self._rng(symbol)
        px = 20.0 + rng.random() * 80.0
        out = []
        for _ in range(n_days):
            px *= 1.0 + rng.gauss(0.0002, 0.01)
            out.append(round(px, 4))
        return out

    def bars_until(self, asof: datetime) -> dict[str, list[Bar]]:
        """Daily bars whose CLOSE is at or before ``asof`` (no lookahead)."""
        require_aware(asof, "asof")
        n_days = (asof - EPOCH).days + 1
        result: dict[str, list[Bar]] = {}
        for symbol in self._symbols:
            closes = self._series(symbol, max(n_days, 0))
            bars = []
            for i, close in enumerate(closes):
                close_ts = EPOCH + timedelta(days=i)
                if close_ts > asof:
                    break
                bars.append(Bar(symbol, close_ts, close, close * 1.005, close * 0.995, close, 1_000.0))
            result[symbol] = bars
        return result

    def quote(self, symbol: str) -> Quote | None:
        if symbol not in self._symbols:
            return None
        now = self._clock.now()
        bars = self.bars_until(now).get(symbol) or []
        if not bars:
            return None
        return Quote(symbol=symbol, market=self._market, price=Decimal(repr(bars[-1].close)), ts=now)
