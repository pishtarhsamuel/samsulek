"""Baseline plans: random entries (stars and bars) and buy-and-hold (spec section 7.3).

Facts relied on:
- Seeds come from the study id only (``seeds_for``: sha256, never ``hash()``), so they are
  fixed before any result exists and are the same in every process and on every OS.
- Random entries keep the strategy's own episode shapes per symbol: the exact multiset
  of ``(sessions_held, weight)``, so the count, the holding lengths, the weights and the
  per-symbol exposure are the strategy's. The shapes come from the strategy's R-mode run
  at 1x costs (spec 7.3; the same schedule is then run at 1x and 2x), so
  ``episode_shapes`` refuses any other run. They are placed uniformly at random over the
  out-of-sample sessions by stars and bars: with S sessions and K episodes,
  ``free = S - sum(h) - (K - 1)`` spare sessions are split into K + 1 gaps by K cuts drawn
  without replacement from ``range(free + K)``, the shapes are laid out in a random order,
  and consecutive episodes are always at least one session apart (one exit session), so
  they never overlap or merge. ``free < 0`` cannot happen for the strategy's own episodes
  and is an integrity error. Each symbol has its own ``random.Random`` seeded from
  ``sha256(f"{seed}:{symbol}")``, so one symbol's draws never shift another's. An episode
  is ``(first session, end, weight)`` with ``end`` exclusive: the exit session, or the day
  after the last session when it runs to the end (``ScheduledWeights`` holds weight w while
  ``first <= d < end``).
- Buy-and-hold starts at ``w0 = min(max_position_pct, 1/n)`` per symbol, over the n
  symbols the runner trades at its first session: those of the universe listed there at
  the execution time with at least ``min_bars`` bars before it (the caller passes the
  jobs' ``min_history``; a gross cap below 100% would scale the weights down in sizing,
  as for any strategy). The execution time must lie between that session's open print
  and its close. Each symbol is anchored at the adjusted close of the previous session
  as visible at the execution time, i.e. the last bar the strategy sees there (adjusted
  for the corporate actions in effect then), so it starts exactly at ``w0`` and then
  drifts without churning.
- The unconstrained buy-and-hold (equal weight, 100% invested at the first open, no costs,
  no caps) is shown for context only and is never used in a fact. It is valued at the
  adjusted closes in effect at the close of the window's last session: adjusted for
  every corporate action whose ``effective_at = max(known_at, open print of its
  ex-session)`` is at or before that close (the dataset's rule; one consistent
  adjustment basis, so splits and distributions do not show as jumps), and it stops at
  the first session where a holding has no close (a delisting).

Dataset methods used: ``calendar`` (``is_session``, ``previous_session``, ``close_utc``,
``open_print_utc``), ``listed``, ``adjusted_close``, ``sessions`` and ``adjusted_window``.
"""

from __future__ import annotations

import hashlib
import math
import random
from bisect import bisect_left
from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import Final

from samsulek.backtest.dataset import PitDataset
from samsulek.backtest.types import (
    BacktestIntegrityError,
    BacktestRefused,
    BuyAndHoldPlan,
    Episode,
    EquityPoint,
    RandomEntriesPlan,
    RiskMode,
    RunResult,
)
from samsulek.config import MarketLimits
from samsulek.types import Bar, require_aware

_RANDOM_LABEL: Final = "random_entries"  # names the plan in an integrity error
_ZERO: Final = Decimal(0)


def seeds_for(study_id: str, count: int) -> tuple[int, ...]:
    """``int(sha256(f"{study_id}:random-entries:{i}").hexdigest()[:12], 16)`` for i in range(count)."""
    if not isinstance(study_id, str) or not study_id:
        raise ValueError("seeds need a study id")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise ValueError(f"count must be an integer >= 0, got {count!r}")
    return tuple(
        int(hashlib.sha256(f"{study_id}:random-entries:{i}".encode()).hexdigest()[:12], 16)
        for i in range(count)
    )


def _check_shape(symbol: str, held: object, weight: object) -> str | None:
    """Why ``(held, weight)`` cannot be an episode shape, or None."""
    if isinstance(held, bool) or not isinstance(held, int) or held < 1:
        return f"{symbol}: an episode must be held for at least 1 session, got {held!r}"
    if isinstance(weight, bool) or not isinstance(weight, float | int) or not 0 < weight < math.inf:
        # NaN fails too. Above 1 is kept: it is the strategy's own (raw) target, which sizing
        # clips the same way for the random copy.
        return f"{symbol}: an episode weight must be a finite number > 0, got {weight!r}"
    return None


def episode_shapes(result: RunResult) -> dict[str, tuple[tuple[int, float], ...]]:
    """Per symbol: (sessions_held, weight) of every episode, closed or open at the end, by entry."""
    job = result.job
    if job.risk_mode is not RiskMode.R or job.cost_multiplier != 1:
        raise BacktestIntegrityError(
            f"random entries copy the R-mode run at 1x costs; this one is {job.risk_mode} at "
            f"{job.cost_multiplier}x",
            session=None,
            label=job.label,
        )
    by_symbol: dict[str, list[Episode]] = {}
    for episode in result.episodes:
        problem = _check_shape(episode.symbol, episode.sessions_held, episode.weight)
        if problem is not None:
            raise BacktestIntegrityError(problem, session=episode.entry_session, label=result.job.label)
        by_symbol.setdefault(episode.symbol, []).append(episode)
    return {
        symbol: tuple(
            (e.sessions_held, float(e.weight))
            for e in sorted(by_symbol[symbol], key=lambda e: e.entry_session)
        )
        for symbol in sorted(by_symbol)
    }


def _symbol_rng(seed: int, symbol: str) -> random.Random:
    digest = hashlib.sha256(f"{seed}:{symbol}".encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def random_entry_schedule(
    shapes: Mapping[str, Sequence[tuple[int, float]]], sessions: Sequence[date], *, seed: int
) -> RandomEntriesPlan:
    """The strategy's episode shapes, placed at random without overlap over ``sessions``."""
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ValueError(f"seed must be an integer >= 0, got {seed!r}")
    days = tuple(sessions)
    if any(a >= b for a, b in pairwise(days)):
        raise ValueError("sessions must be sorted, without repeats")
    n = len(days)
    schedule: list[tuple[str, tuple[tuple[date, date, float], ...]]] = []
    for symbol in sorted(shapes):
        given = list(shapes[symbol])
        if not given:
            continue
        for held, weight in given:  # checked before float() could turn True into 1.0
            problem = _check_shape(symbol, held, weight)
            if problem is not None:
                raise ValueError(problem)
        items = [(held, float(weight)) for held, weight in given]
        k = len(items)
        free = n - sum(held for held, _ in items) - (k - 1)
        if free < 0:
            raise BacktestIntegrityError(
                f"{symbol}: {k} episodes holding {sum(h for h, _ in items)} sessions do not fit in "
                f"{n} sessions (the strategy's own episodes always fit)",
                session=None,
                label=_RANDOM_LABEL,
            )
        rng = _symbol_rng(seed, symbol)
        cuts = sorted(rng.sample(range(free + k), k))
        gaps = [cuts[0], *(b - a - 1 for a, b in pairwise(cuts)), free + k - 1 - cuts[-1]]
        order = rng.sample(items, k)
        episodes: list[tuple[date, date, float]] = []
        pos = gaps[0]
        for j, (held, weight) in enumerate(order):
            start, end = pos, pos + held
            episodes.append((days[start], days[end] if end < n else days[-1] + timedelta(days=1), weight))
            pos = end + gaps[j + 1] + 1  # one exit session between episodes
        if pos != n + 1:  # the K + 1 gaps and K - 1 exit sessions fill the window exactly
            raise BacktestIntegrityError(
                f"{symbol}: the random layout ends at {pos - 1}, not {n} (a bug)",
                session=None,
                label=_RANDOM_LABEL,
            )
        schedule.append((symbol, tuple(episodes)))
    return RandomEntriesPlan(seed=seed, schedule=tuple(schedule))


def _check_session(dataset: PitDataset, day: date, what: str) -> None:
    if not dataset.calendar.is_session(day):
        raise ValueError(f"{what} {day} is not a {dataset.calendar.name} session")


def buy_and_hold_plan(
    dataset: PitDataset,
    universe: Sequence[str],
    *,
    limits: MarketLimits,
    first_session: date,
    execute_at: datetime,
    min_bars: int,
) -> BuyAndHoldPlan:
    """Equal starting weights over the symbols listed at ``first_session`` with at least
    ``min_bars`` (>= 1, the jobs' ``min_history``) bars before it, anchored at the adjusted
    closes visible at ``execute_at`` (that session's execution time)."""
    require_aware(execute_at, "execution time")
    if isinstance(min_bars, bool) or not isinstance(min_bars, int) or min_bars < 1:
        raise ValueError(f"min_bars must be an integer >= 1, got {min_bars!r}")
    cal = dataset.calendar
    _check_session(dataset, first_session, "the buy-and-hold first session")
    previous = cal.previous_session(first_session)
    if not cal.open_print_utc(first_session) <= execute_at < cal.close_utc(first_session):
        raise ValueError(
            f"execute_at {execute_at.isoformat()} must fall between the open print and the close of "
            f"{first_session}"
        )
    symbols = sorted(dataset.listed(first_session, at=execute_at, min_bars=min_bars, among=universe))
    if not symbols:
        raise BacktestRefused([f"buy-and-hold: no symbol of {sorted(universe)} is listed at {first_session}"])
    w0 = min(float(limits.max_position_pct), 1.0 / len(symbols))
    anchors: list[tuple[str, float]] = []
    problems: list[str] = []
    for symbol in symbols:
        try:
            close = dataset.adjusted_close(symbol, previous, as_of=execute_at)
        except KeyError:
            problems.append(f"buy-and-hold: {symbol} has no close on {previous} to anchor at")
            continue
        if not (math.isfinite(close) and close > 0):
            problems.append(f"buy-and-hold: {symbol} closed at {close!r} on {previous}")
            continue
        anchors.append((symbol, close))
    if problems:
        raise BacktestRefused(problems)
    return BuyAndHoldPlan(weights0=tuple((s, w0) for s in symbols), anchor_closes=tuple(anchors))


def unconstrained_buy_and_hold(
    dataset: PitDataset, universe: Sequence[str], *, first: date, last: date, starting_cash: Decimal
) -> tuple[EquityPoint, ...]:
    """Marks ``m_1..m_T`` (at the closes of ``first``..``last``) of an equal-weight portfolio
    bought at ``first``'s adjusted open; the start ``m_0 = starting_cash`` is not included."""
    if not isinstance(starting_cash, Decimal) or not starting_cash.is_finite() or starting_cash <= 0:
        raise ValueError(f"starting cash must be a finite Decimal > 0, got {starting_cash!r}")
    cal = dataset.calendar
    _check_session(dataset, first, "the first session")
    days = dataset.sessions(first, last)
    if not days or days[0] != first:
        raise ValueError(f"the dataset has no data for {first}")
    symbols = sorted(dataset.listed(first, at=cal.open_print_utc(first), min_bars=0, among=universe))
    if not symbols:
        raise BacktestRefused(
            [f"unconstrained buy-and-hold: no symbol of {sorted(universe)} is listed at {first}"]
        )
    closes_at = [cal.close_utc(d) for d in days]
    rows: dict[str, list[Bar | None]] = {}
    quantity: dict[str, Decimal] = {}
    share = starting_cash / len(symbols)
    for symbol in symbols:
        row: list[Bar | None] = [None] * len(days)
        for bar in dataset.adjusted_window(symbol, closes_at[-1], len(days)):
            i = bisect_left(closes_at, bar.close_ts)
            if i < len(days) and closes_at[i] == bar.close_ts:
                row[i] = bar
        entry = row[0]
        if entry is None or not (math.isfinite(entry.open) and entry.open > 0):
            raise BacktestRefused([f"unconstrained buy-and-hold: {symbol} has no usable bar on {first}"])
        rows[symbol] = row
        quantity[symbol] = share / Decimal(repr(entry.open))
    points: list[EquityPoint] = []
    for i, day in enumerate(days):
        value = _ZERO
        for symbol in symbols:
            mark = rows[symbol][i]
            if mark is None or not (math.isfinite(mark.close) and mark.close > 0):
                return tuple(points)  # a holding has no close (delisted): stop rather than guess
            value += quantity[symbol] * Decimal(repr(mark.close))
        points.append(EquityPoint(session=day, ts=closes_at[i], cash=_ZERO, gross=value, equity=value))
    return tuple(points)
