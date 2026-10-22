"""SYNTHETIC Xetra-session daily bars for plumbing studies and tests.

Not market data; never evidence. Facts the tests rely on:
- One seeded random walk per symbol: ``random.Random(int.from_bytes(sha256(f"{seed}:
  {symbol}").digest()[:8], "big"))``, so a symbol's series depends only on (seed, symbol,
  first session) and never on other symbols, ``PYTHONHASHSEED`` or the process. A longer
  range extends a shorter one (same prefix).
- One bar per real Xetra session (DST switches, the 14:00 early close, Easter and the
  Christmas closures included) labeled ``calendar.close_utc(session)``, in EUR, source
  "synthetic". OHLC is consistent and every price is positive.
- Every bar has ``open != close`` and an overnight gap of at least ``min_gap``
  (``|open / previous close - 1| >= min_gap``), so a same-bar fill or a close-used-as-open
  bug changes the result (M1's synthetic feed had ``open == close``, which hid both).
- The ``plant_*`` helpers return new lists (the input is not changed) with the defects and
  events the leakage tests need: a split (with its ``CorporateAction``), a one-session bad
  print, and the "coin gap" pattern of trap 1.
"""

from __future__ import annotations

import hashlib
import math
import random
from collections.abc import Sequence
from dataclasses import replace
from datetime import date, datetime

from samsulek.backtest.dataset import CorporateAction
from samsulek.data.bars import DailyBar
from samsulek.data.calendars import XetraCalendar
from samsulek.types import require_aware

SOURCE = "synthetic"
_FLOOR = -0.5  # no single move below -50%, so prices stay positive for any vol setting
_MARGIN = 1 + 1e-6  # float rounding cannot pull a clamped move back under min_gap


def _rng(label: str) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(label.encode("utf-8")).digest()[:8], "big"))


def _at_least(move: float, gap: float) -> float:
    """``move`` pushed away from zero to at least ``gap`` (keeping its sign), and floored."""
    if abs(move) < gap * _MARGIN:
        move = math.copysign(gap * _MARGIN, move)
    return max(move, _FLOOR)


def synthetic_daily_bars(
    symbols: Sequence[str],
    calendar: XetraCalendar,
    first: date,
    last: date,
    *,
    seed: int,
    start_price: float = 50.0,
    drift: float = 0.0003,
    vol: float = 0.01,
    gap_vol: float = 0.004,
    min_gap: float = 1e-4,
) -> dict[str, list[DailyBar]]:
    """Bars for every Xetra session in ``[first, last]``, per symbol (in ``symbols`` order)."""
    if not (math.isfinite(start_price) and start_price > 0):
        raise ValueError(f"start_price must be a positive number, got {start_price}")
    if not (0 < min_gap < 0.1) or vol < 0 or gap_vol < 0 or not math.isfinite(drift):
        raise ValueError("need 0 < min_gap < 0.1, vol >= 0, gap_vol >= 0 and a finite drift")
    if len(set(symbols)) != len(symbols) or not all(symbols):
        raise ValueError("symbols must be non-empty and unique")
    sessions = calendar.sessions(first, last)
    out: dict[str, list[DailyBar]] = {}
    for symbol in symbols:
        rng = _rng(f"{seed}:{symbol}")
        previous_close = start_price
        bars: list[DailyBar] = []
        for session in sessions:
            gap = _at_least(rng.gauss(0.0, gap_vol), min_gap)
            move = _at_least(rng.gauss(drift, vol), min_gap)
            wick_up = abs(rng.gauss(0.0, vol / 2))
            wick_down = min(abs(rng.gauss(0.0, vol / 2)), 0.5)
            volume = float(rng.randrange(1_000, 100_000))
            open_ = previous_close * (1 + gap)
            close = open_ * (1 + move)
            bars.append(
                DailyBar(
                    symbol=symbol,
                    session=session,
                    close_ts=calendar.close_utc(session),
                    open=open_,
                    high=max(open_, close) * (1 + wick_up),
                    low=min(open_, close) * (1 - wick_down),
                    close=close,
                    volume=volume,
                    currency="EUR",
                    source=SOURCE,
                )
            )
            previous_close = close
        out[symbol] = bars
    return out


def _position(bars: list[DailyBar], session: date) -> int:
    for i, bar in enumerate(bars):
        if bar.session == session:
            return i
    raise ValueError(f"no bar for {session}")


def plant_split(
    bars: list[DailyBar], session: date, ratio: float, known_at: datetime
) -> tuple[list[DailyBar], CorporateAction]:
    """Raw prices divide by ``ratio`` from ``session`` on (volume multiplies by it); the
    action's ``price_factor`` is ``1 / ratio``, so adjusted history lines up."""
    require_aware(known_at, "split known_at")
    if not (math.isfinite(ratio) and ratio > 0) or ratio == 1:
        raise ValueError(f"split ratio must be a positive number other than 1, got {ratio}")
    start = _position(bars, session)
    out = list(bars[:start])
    for bar in bars[start:]:
        out.append(
            replace(
                bar,
                open=None if bar.open is None else bar.open / ratio,
                high=None if bar.high is None else bar.high / ratio,
                low=None if bar.low is None else bar.low / ratio,
                close=bar.close / ratio,
                volume=None if bar.volume is None else bar.volume * ratio,
            )
        )
    action = CorporateAction(
        symbol=bars[start].symbol, ex_session=session, kind="split", price_factor=1 / ratio, known_at=known_at
    )
    return out, action


def plant_spike(bars: list[DailyBar], session: date, jump: float) -> list[DailyBar]:
    """One bad close print: ``session``'s close times ``1 + jump`` (high/low widened to
    contain it); the next session is untouched, so the move reverses at once."""
    if not (math.isfinite(jump) and jump > -1) or jump == 0:
        raise ValueError(f"jump must be a non-zero number above -1, got {jump}")
    i = _position(bars, session)
    bar = bars[i]
    close = bar.close * (1 + jump)
    out = list(bars)
    out[i] = replace(
        bar,
        close=close,
        high=None if bar.high is None else max(bar.high, close),
        low=None if bar.low is None else min(bar.low, close),
    )
    return out


def plant_coin_gaps(
    bars: list[DailyBar], *, seed: int, intraday: float = 0.01, gap: float = 0.02
) -> list[DailyBar]:
    """``close_t = open_t (1 + intraday c_t)``; ``open_t+1 = close_t (1 + gap c_t)``; ``c_t = +-1``
    seeded (test L1: only a same-bar fill can exploit it)."""
    if not (0 < intraday < 0.5 and 0 < gap < 0.5):
        raise ValueError("intraday and gap must be in (0, 0.5)")
    if not bars:
        return []
    first = bars[0]
    if first.open is None:
        raise ValueError(f"{first.symbol} {first.session}: the first bar needs an open")
    rng = _rng(f"{seed}:{first.symbol}:coin-gaps")
    open_ = first.open
    out: list[DailyBar] = []
    for bar in bars:
        coin = 1 if rng.random() < 0.5 else -1
        close = open_ * (1 + intraday * coin)
        out.append(replace(bar, open=open_, high=max(open_, close), low=min(open_, close), close=close))
        open_ = close * (1 + gap * coin)
    return out
