"""Data-quality checks for daily bar series.

Errors mean "do not use this series" (research must exclude or repair it; live trading
must refuse it). Warnings mean "look at this": real markets do produce big moves and
quiet days, so those are flagged, not silently "fixed".

Nothing here edits data. A bad print is reported with the session it happened on, so
a human (or a documented repair rule) decides what to do.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal, TypeGuard
from zoneinfo import ZoneInfo

from samsulek.data.bars import DailyBar, TradingCalendar
from samsulek.types import require_aware

Severity = Literal["error", "warning"]


@dataclass(frozen=True, slots=True)
class Issue:
    severity: Severity
    code: str
    symbol: str
    session: date | None
    detail: str

    def __str__(self) -> str:
        where = f" {self.session}" if self.session else ""
        return f"{self.severity.upper()} {self.symbol}{where} [{self.code}] {self.detail}"


@dataclass(frozen=True, slots=True)
class QualityLimits:
    # A daily move bigger than this is checked for a snap-back (a likely bad print).
    # 15% suits broad equity ETFs; their worst real days (e.g. March 2020) were ~ -12%.
    max_abs_daily_return: float = 0.15
    # A jump is a "spike" if the next session gives back at least this share of it.
    spike_reversal_ratio: float = 0.6
    # The same close this many sessions in a row (with no volume) looks like stale data.
    max_stale_sessions: int = 5
    # Missing sessions in a row up to this many are warnings; more is an error.
    max_missing_run: int = 2


def _finite_positive(x: float | None) -> TypeGuard[float]:
    return x is not None and math.isfinite(x) and x > 0


def check_bars(bars: Sequence[DailyBar], limits: QualityLimits | None = None) -> list[Issue]:
    """Checks that need nothing but the bars themselves."""
    limits = limits or QualityLimits()
    issues: list[Issue] = []
    if not bars:
        return issues
    symbol = bars[0].symbol

    def add(severity: Severity, code: str, session: date | None, detail: str) -> None:
        issues.append(Issue(severity, code, symbol, session, detail))

    if len({b.symbol for b in bars}) > 1:
        add("error", "mixed_symbols", None, f"series mixes symbols {sorted({b.symbol for b in bars})}")
    if len({b.currency for b in bars}) > 1:
        add("error", "mixed_currency", None, f"series mixes currencies {sorted({b.currency for b in bars})}")

    seen: set[date] = set()
    for prev, cur in zip([None, *bars[:-1]], bars, strict=True):
        if cur.session in seen:
            add("error", "duplicate_session", cur.session, "more than one bar for this session")
        seen.add(cur.session)
        if prev is not None and cur.session < prev.session:
            add("error", "out_of_order", cur.session, f"comes after {prev.session}")
        for name in ("open", "high", "low", "close"):
            value = getattr(cur, name)
            if value is not None and not _finite_positive(value):
                add("error", "bad_price", cur.session, f"{name} is {value}")
        if cur.volume is not None and (not math.isfinite(cur.volume) or cur.volume < 0):
            add("error", "bad_volume", cur.session, f"volume is {cur.volume}")
        prices = [p for p in (cur.open, cur.high, cur.low, cur.close) if _finite_positive(p)]
        if cur.high is not None and cur.low is not None and len(prices) >= 2:
            tol = 1e-9 * max(prices)
            if cur.high + tol < max(prices) or cur.low - tol > min(prices):
                add(
                    "error",
                    "ohlc_inconsistent",
                    cur.session,
                    f"O={cur.open} H={cur.high} L={cur.low} C={cur.close}",
                )

    ordered = sorted(
        {b.session: b for b in bars if _finite_positive(b.close)}.values(), key=lambda b: b.session
    )
    closes = [b.close for b in ordered]
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
    jump = math.log(1 + limits.max_abs_daily_return)
    reversal_of_previous = False  # the snap-back of a reported spike is the same bad print
    for i, r in enumerate(rets):
        if reversal_of_previous or abs(r) <= jump:
            reversal_of_previous = False
            continue
        session = ordered[i + 1].session
        nxt = rets[i + 1] if i + 1 < len(rets) else None
        if nxt is not None and nxt * r < 0 and abs(nxt) >= limits.spike_reversal_ratio * abs(r):
            add(
                "error",
                "spike_reversal",
                session,
                f"moved {math.expm1(r):+.1%} then {math.expm1(nxt):+.1%} the next session "
                "(likely a bad print)",
            )
            reversal_of_previous = True
        else:
            add("warning", "large_move", session, f"moved {math.expm1(r):+.1%} in one session")

    run_start = 0
    for i in range(1, len(ordered) + 1):
        same = (
            i < len(ordered)
            and ordered[i].close == ordered[run_start].close
            and (ordered[i].volume or 0) <= 0
        )
        if same:
            continue
        run = i - run_start
        if run >= limits.max_stale_sessions:
            add(
                "warning",
                "stale_run",
                ordered[run_start].session,
                f"close unchanged at {ordered[run_start].close} with no volume for {run} sessions",
            )
        run_start = i
    return sorted(issues, key=lambda x: (x.session or date.min, x.code))


def check_calendar(
    bars: Sequence[DailyBar], calendar: TradingCalendar, limits: QualityLimits | None = None
) -> list[Issue]:
    """Bars on non-trading days, and trading days with no bar (between first and last bar)."""
    limits = limits or QualityLimits()
    if not bars:
        return []
    symbol = bars[0].symbol
    have = {b.session for b in bars}
    issues = [
        Issue("warning", "unexpected_session", symbol, d, f"bar on a day {calendar.name} is closed")
        for d in sorted(have)
        if not calendar.is_session(d)
    ]
    expected = calendar.sessions(min(have), max(have))
    run: list[date] = []
    for d in [*expected, None]:
        if d is not None and d not in have:
            run.append(d)
            continue
        if run:
            severity: Severity = "error" if len(run) > limits.max_missing_run else "warning"
            span = f"{run[0]}" if len(run) == 1 else f"{run[0]} .. {run[-1]}"
            issues.append(
                Issue(
                    severity, "missing_sessions", symbol, run[0], f"{len(run)} trading day(s) missing: {span}"
                )
            )
            run = []
    return sorted(issues, key=lambda x: (x.session or date.min, x.code))


def check_fresh(
    bars: Sequence[DailyBar],
    calendar: TradingCalendar,
    now: datetime,
    publish_delay: timedelta,
    symbol: str,
) -> list[Issue]:
    """Is the newest bar the newest one that should exist by ``now``? Also rejects bars from the future.

    A session's bar is due once its close plus ``publish_delay`` (how long the source
    takes to publish) has passed.
    """
    require_aware(now, "now")
    issues = [
        Issue("error", "future_bar", symbol, b.session, f"closes at {b.close_ts.isoformat()}, after now")
        for b in bars
        if b.close_ts > now
    ]
    today = now.astimezone(ZoneInfo(calendar.tz)).date()
    recent = calendar.sessions(today - timedelta(days=14), today)
    due = [d for d in recent if calendar.close_utc(d) + publish_delay <= now]
    if not due:
        issues.append(Issue("error", "calendar_gap", symbol, None, "no trading day in the last 14 days?"))
        return issues
    expected = due[-1]
    latest = max((b.session for b in bars if b.close_ts <= now), default=None)
    if latest is None:
        issues.append(Issue("error", "no_data", symbol, None, "no bars at all"))
    elif latest < expected:
        issues.append(
            Issue(
                "error", "stale_series", symbol, latest, f"newest bar is {latest}, expected {expected} by now"
            )
        )
    return issues


def errors(issues: Sequence[Issue]) -> list[Issue]:
    return [i for i in issues if i.severity == "error"]
