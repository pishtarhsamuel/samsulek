"""SYNTHETIC Xetra-session daily bars for plumbing studies and tests (M3 skeleton; WP3).

Not market data; never evidence. One seeded random walk per symbol
(``random.Random(int.from_bytes(sha256(f"{seed}:{symbol}").digest()[:8], "big"))``), one
bar per real Xetra session labeled ``calendar.close_utc(session)``, in EUR, source
"synthetic". Every bar has ``open != close`` and an overnight gap of at least ``min_gap``,
so a same-bar fill or a close-as-open bug changes the result (unlike M1's synthetic feed).
The ``plant_*`` helpers add the defects and events the leakage tests need.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime

from samsulek.backtest.dataset import CorporateAction
from samsulek.data.bars import DailyBar
from samsulek.data.calendars import XetraCalendar


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
    raise NotImplementedError("WP3")


def plant_split(
    bars: list[DailyBar], session: date, ratio: float, known_at: datetime
) -> tuple[list[DailyBar], CorporateAction]:
    """Raw prices divide by ``ratio`` from ``session`` on."""
    raise NotImplementedError("WP3")


def plant_spike(bars: list[DailyBar], session: date, jump: float) -> list[DailyBar]:
    raise NotImplementedError("WP3")


def plant_coin_gaps(
    bars: list[DailyBar], *, seed: int, intraday: float = 0.01, gap: float = 0.02
) -> list[DailyBar]:
    """``close_t = open_t (1 + intraday c_t)``; ``open_t+1 = close_t (1 + gap c_t)``; ``c_t = +-1``
    seeded (test L1: only a same-bar fill can exploit it)."""
    raise NotImplementedError("WP3")
