"""Performance metrics of one run, exactly as the M3 spec section 6 defines them.

Facts relied on:
- Returns are mark to mark: ``m_0`` is the starting cash at ``ts_0`` (the close of the
  session before the first), ``m_1..m_T`` the marks at the closes of the sessions run, and
  ``r_i = m_i / m_{i-1} - 1``, halted sessions included. ``RunResult.equity`` holds
  ``m_1..m_T``; a leading point stamped ``ts_0`` is accepted as ``m_0`` (it must equal the
  starting cash) and is not counted as a return.
- Years are ``Y = (ts_T - ts_0) / 365.25 days``; ``PERIODS_PER_YEAR`` = 252. The risk-free
  rate and interest on cash are 0 (pessimistic for strategies that hold cash).
- CAGR is -1.0 once ``m_T <= 0`` and None below half a year (annualising a few weeks is
  noise). The Sharpe ratio (sample std, ddof 1), Sortino ratio, skew and kurtosis are
  None when undefined (fewer than 2 returns, no variance, no downside), never a made-up
  number. The drawdown is ``max_i (1 - m_i / max(m_0..m_i))`` over i = 0..T; its duration
  runs from the peak before the trough (the LAST mark at that peak) to the first mark back
  at the peak (or to the end, ``recovered = False``), in sessions and calendar days. The
  date of ``m_0`` is the UTC date of ``ts_0`` (a Xetra close is the same day in UTC).
- Episode statistics use CLOSED episodes only; a win is ``pnl > 0`` and a loss ``pnl < 0``
  (an episode at exactly 0 is neither). Turnover is one-way per year; exposure is the mean
  of ``gross / equity`` over the marks; cost drag is fees + spread + slippage per year, in
  bps of the mean equity. The weight gap is the mean ``|target - actual|`` over the
  sessions in which the strategy ran (it logged targets, or the cycle ended "done") and,
  per session, over its universe plus every symbol targeted or held (a missing weight is
  0). A run that reaches zero equity is aborted by the runner, so equity <= 0 is accepted
  only as the LAST mark here (an earlier one is a ValueError).
- ``summarize`` keeps the session dates and daily returns for ``Detail.FULL`` and
  ``Detail.RETURNS`` (walk-forward prefix scoring needs them) and drops them for
  ``Detail.METRICS``.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date
from decimal import Decimal
from typing import Final

from samsulek.backtest.book import summarize_halts
from samsulek.backtest.stats import sharpe_stats
from samsulek.backtest.types import (
    BacktestIntegrityError,
    Detail,
    Episode,
    EquityPoint,
    Metrics,
    RunResult,
    RunSummary,
    SessionRecord,
)

PERIODS_PER_YEAR: Final = 252
_SECONDS_PER_YEAR: Final = 365.25 * 86_400
_MIN_YEARS_FOR_CAGR: Final = 0.5
_BPS: Final = 10_000.0
_ZERO: Final = Decimal(0)


def daily_returns(points: Sequence[EquityPoint], start_equity: Decimal) -> list[float]:
    """``r_i = m_i / m_{i-1} - 1`` with ``m_0 = start_equity``. ValueError on a base <= 0."""
    out: list[float] = []
    prev = start_equity
    for i, p in enumerate(points):
        if not prev.is_finite() or prev <= 0:
            where = "the starting equity" if i == 0 else f"the mark of {points[i - 1].session}"
            raise ValueError(f"{where} is {prev}: returns after zero equity are undefined")
        if not p.equity.is_finite():
            raise ValueError(f"the mark of {p.session} is not a finite number: {p.equity}")
        out.append(float((p.equity - prev) / prev))
        prev = p.equity
    return out


def _marks(result: RunResult) -> list[EquityPoint]:
    """``m_1..m_T``: the run's marks, strictly after ts_0 and in time order."""
    points = list(result.equity)
    label = result.job.label
    if points and points[0].ts == result.start_ts:
        if points[0].equity != result.start_equity:
            raise BacktestIntegrityError(
                f"the start mark {points[0].equity} differs from the starting equity {result.start_equity}",
                session=points[0].session,
                label=label,
            )
        points = points[1:]
    if not points:
        raise BacktestIntegrityError("the run has no equity marks", session=None, label=label)
    prev_ts = result.start_ts
    for p in points:
        if p.ts <= prev_ts:
            raise BacktestIntegrityError(
                f"equity marks out of time order ({p.ts.isoformat()} after {prev_ts.isoformat()})",
                session=p.session,
                label=label,
            )
        prev_ts = p.ts
    return points


@dataclass(frozen=True, slots=True)
class _Drawdown:
    max_drawdown: float
    peak: date | None
    trough: date | None
    recovery: date | None
    duration_sessions: int
    duration_days: int
    longest_underwater_sessions: int
    recovered: bool


def _drawdown(values: Sequence[Decimal], dates: Sequence[date]) -> _Drawdown:
    """Max drawdown over ``values`` (m_0..m_T), its peak/trough/recovery and durations."""
    t = len(values) - 1
    peak_idx = 0
    best_dd = _ZERO
    best: tuple[int, int] | None = None  # (peak index, trough index); ties keep the first trough
    longest = 0
    under_since: int | None = None  # peak index of the current underwater period
    for i, v in enumerate(values):
        if v >= values[peak_idx]:
            if under_since is not None:  # back at (or above) the peak: the period ends here
                longest = max(longest, i - under_since)
                under_since = None
            peak_idx = i
            continue
        if under_since is None:
            under_since = peak_idx
        dd = 1 - v / values[peak_idx]
        if dd > best_dd:
            best_dd, best = dd, (peak_idx, i)
    if under_since is not None:
        longest = max(longest, t - under_since)
    if best is None:
        return _Drawdown(
            max_drawdown=0.0,
            peak=None,
            trough=None,
            recovery=None,
            duration_sessions=0,
            duration_days=0,
            longest_underwater_sessions=longest,
            recovered=True,
        )
    peak, trough = best
    recovery = next((j for j in range(trough + 1, t + 1) if values[j] >= values[peak]), None)
    end = t if recovery is None else recovery
    return _Drawdown(
        max_drawdown=float(best_dd),
        peak=dates[peak],
        trough=dates[trough],
        recovery=None if recovery is None else dates[recovery],
        duration_sessions=end - peak,
        duration_days=(dates[end] - dates[peak]).days,
        longest_underwater_sessions=longest,
        recovered=recovery is not None,
    )


@dataclass(frozen=True, slots=True)
class _EpisodeStats:
    n_closed: int
    n_open: int
    win_rate: float | None
    avg_win_eur: float | None
    avg_loss_eur: float | None
    avg_win_pct: float | None
    avg_loss_pct: float | None
    profit_factor: float | None


def _mean(values: Sequence[float]) -> float | None:
    return math.fsum(values) / len(values) if values else None


def _episode_stats(episodes: Sequence[Episode]) -> _EpisodeStats:
    closed = [e for e in episodes if not e.open_at_end]
    wins = [e for e in closed if e.pnl_eur > 0]
    losses = [e for e in closed if e.pnl_eur < 0]
    win_sum = sum((e.pnl_eur for e in wins), _ZERO)
    loss_sum = sum((e.pnl_eur for e in losses), _ZERO)
    return _EpisodeStats(
        n_closed=len(closed),
        n_open=len(episodes) - len(closed),
        win_rate=len(wins) / len(closed) if closed else None,
        avg_win_eur=_mean([float(e.pnl_eur) for e in wins]),
        avg_loss_eur=_mean([float(e.pnl_eur) for e in losses]),
        avg_win_pct=_mean([float(e.pnl_eur / e.buy_eur) for e in wins]),
        avg_loss_pct=_mean([float(e.pnl_eur / e.buy_eur) for e in losses]),
        profit_factor=float(win_sum / -loss_sum) if losses else None,
    )


def _strategy_ran(s: SessionRecord) -> bool:
    """The strategy produced targets this session: it logged some, or the cycle ended "done"
    (a done cycle always runs the strategy; empty targets then mean "all cash")."""
    return bool(s.targets) or s.status == "done"


def _weight_gap(sessions: Sequence[SessionRecord]) -> float:
    """Mean |target - actual| over (session, symbol) pairs; the sessions the strategy ran in,
    and per session its universe plus any symbol targeted or held (a missing weight is 0)."""
    gaps: list[float] = []
    for s in sessions:
        if not _strategy_ran(s):  # halted or blocked before the strategy ran: nothing to compare
            continue
        targets, actual = dict(s.targets), dict(s.actual)
        symbols = sorted(set(s.universe) | targets.keys() | actual.keys())
        gaps.extend(abs(targets.get(sym, 0.0) - actual.get(sym, 0.0)) for sym in symbols)
    return math.fsum(gaps) / len(gaps) if gaps else 0.0


def _sample_std(returns: Sequence[float]) -> float | None:
    """None below 2 returns; exactly 0.0 when every return is equal. Scaled by ``max |r|``
    first, so tiny returns neither underflow nor lose precision."""
    t = len(returns)
    if t < 2:
        return None
    if min(returns) == max(returns):
        return 0.0
    scale = max(abs(r) for r in returns)
    scaled = [r / scale for r in returns]
    mu = math.fsum(scaled) / t
    return scale * math.sqrt(math.fsum((r - mu) ** 2 for r in scaled) / (t - 1))


def _sortino(returns: Sequence[float]) -> float | None:
    """``mean / sqrt(sum(min(r, 0)^2) / T) x sqrt(252)``; None without a downside (scale-free,
    so it is computed on ``r / max |r|``)."""
    scale = max((abs(r) for r in returns), default=0.0)
    if not scale > 0:
        return None
    scaled = [r / scale for r in returns]
    t = len(scaled)
    downside = math.sqrt(math.fsum(min(r, 0.0) ** 2 for r in scaled) / t)
    if downside == 0:
        return None
    return math.fsum(scaled) / t / downside * math.sqrt(PERIODS_PER_YEAR)


def compute_metrics(result: RunResult) -> Metrics:
    points = _marks(result)
    m0 = result.start_equity
    for p in points[:-1]:
        if p.equity <= 0:
            raise ValueError(
                f"equity reached {p.equity} at {p.session} before the end (the run should be void)"
            )
    returns = daily_returns(points, m0)
    t = len(returns)
    years = (points[-1].ts - result.start_ts).total_seconds() / _SECONDS_PER_YEAR
    m_t = points[-1].equity
    ann = math.sqrt(PERIODS_PER_YEAR)

    stats = sharpe_stats(returns)
    std = _sample_std(returns)
    if m_t <= 0:
        cagr: float | None = -1.0
    elif years < _MIN_YEARS_FOR_CAGR:
        cagr = None
    else:
        cagr = float(m_t / m0) ** (1.0 / years) - 1.0

    start_date = result.start_ts.astimezone(UTC).date()
    dd = _drawdown([m0, *(p.equity for p in points)], [start_date, *(p.session for p in points)])
    ep = _episode_stats(result.episodes)

    mean_equity = math.fsum(float(p.equity) for p in points) / t
    if not mean_equity > 0:
        raise ValueError(f"the mean equity is {mean_equity}: activity ratios are undefined")
    exposure_terms: list[float] = []
    for p in points:
        if p.gross == 0:
            exposure_terms.append(0.0)
        elif p.equity > 0:
            exposure_terms.append(float(p.gross / p.equity))
        else:
            raise ValueError(f"positions worth {p.gross} at {p.session} with equity {p.equity}")
    traded = sum((abs(f.fill.quantity * f.fill.price) for f in result.fills), _ZERO)
    fees = sum((f.fill.fee for f in result.fills), _ZERO)
    spread = sum((f.spread_eur for f in result.fills), _ZERO)
    slippage = sum((f.slippage_eur for f in result.fills), _ZERO)

    return Metrics(
        first_session=points[0].session,
        last_session=points[-1].session,
        n_returns=t,
        years=years,
        total_return=float((m_t - m0) / m0),
        cagr=cagr,
        ann_vol=None if std is None else std * ann,
        sharpe=None if stats is None else stats.sr * ann,
        sortino=_sortino(returns),
        sr_per_period=None if stats is None else stats.sr,
        skew=None if stats is None else stats.skew,
        kurtosis=None if stats is None else stats.kurt,
        max_drawdown=dd.max_drawdown,
        mdd_peak=dd.peak,
        mdd_trough=dd.trough,
        mdd_recovery=dd.recovery,
        mdd_duration_sessions=dd.duration_sessions,
        mdd_duration_days=dd.duration_days,
        longest_underwater_sessions=dd.longest_underwater_sessions,
        recovered=dd.recovered,
        n_episodes_closed=ep.n_closed,
        n_episodes_open=ep.n_open,
        win_rate=ep.win_rate,
        avg_win_eur=ep.avg_win_eur,
        avg_loss_eur=ep.avg_loss_eur,
        avg_win_pct=ep.avg_win_pct,
        avg_loss_pct=ep.avg_loss_pct,
        profit_factor=ep.profit_factor,
        turnover=float(traded) / 2 / mean_equity / years,
        exposure=math.fsum(exposure_terms) / t,
        time_in_market=sum(1 for p in points if p.gross > 0) / t,
        weight_gap=_weight_gap(result.sessions),
        n_fills=len(result.fills),
        fees_eur=float(fees),
        spread_eur=float(spread),
        slippage_eur=float(slippage),
        cost_drag_bps_per_year=float(fees + spread + slippage) / mean_equity / years * _BPS,
        n_rejections=sum(s.orders_rejected for s in result.sessions),
    )


def summarize(result: RunResult, detail: Detail) -> RunSummary:
    keep = Detail(detail) is not Detail.METRICS
    points = _marks(result)
    return RunSummary(
        job=result.job,
        sessions=tuple(p.session for p in points) if keep else None,
        returns=tuple(daily_returns(points, result.start_equity)) if keep else None,
        metrics=compute_metrics(result),
        halts=summarize_halts(result),
    )
