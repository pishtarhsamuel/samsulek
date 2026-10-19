"""Sharpe statistics, deflated Sharpe, bootstrap and the random-entry comparison (M3 skeleton; WP5).

Per-period statistics with population moments (kurtosis non-excess). PSR and DSR follow
Bailey and Lopez de Prado (2014); N is the GLOBAL count of registered research trials
(every variant, aborted studies included) and V the variance of the trials' Sharpe
ratios, with a conservative floor; ``used = min(dsr, dsr_conservative)``. The buy-and-hold
comparison is a paired stationary bootstrap (Politis-Romano); the random-entry p-value is
``(1 + #seeds at least as good) / (K + 1)``. Only ``statistics.NormalDist`` is used.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

EULER_GAMMA: Final = 0.5772156649015329


@dataclass(frozen=True, slots=True)
class SharpeStats:
    sr: float  # per period
    t: int
    skew: float
    kurt: float  # non-excess


def sharpe_stats(returns: Sequence[float]) -> SharpeStats | None:
    """None if fewer than 2 returns or a zero standard deviation."""
    raise NotImplementedError("WP5")


def sharpe_annual(returns: Sequence[float]) -> float | None:
    raise NotImplementedError("WP5")


def psr(stats: SharpeStats, benchmark: float) -> float | None:
    """None if the radicand is <= 0."""
    raise NotImplementedError("WP5")


def expected_max_sharpe(var_sr: float, n_trials: int) -> float:
    """0.0 when n_trials == 1."""
    raise NotImplementedError("WP5")


@dataclass(frozen=True, slots=True)
class DsrResult:
    stats: SharpeStats
    n_trials: int
    n_completed: int
    var_sr: float | None
    var_floor: float
    sr0: float | None
    sr0_conservative: float | None
    dsr: float | None
    dsr_conservative: float | None
    used: float | None  # min(dsr, dsr_conservative)
    note: str


def deflated_sharpe(
    returns: Sequence[float], *, trial_srs: Sequence[float], n_trials: int, var_floor: float = 0.25 / 252
) -> DsrResult | None:
    """None if ``sharpe_stats(returns)`` is None."""
    raise NotImplementedError("WP5")


def bootstrap_prob_sharpe_higher(
    a: Sequence[float], b: Sequence[float], *, seed: int, n_boot: int = 2000, mean_block: int = 20
) -> float | None:
    raise NotImplementedError("WP5")


@dataclass(frozen=True, slots=True)
class RandomComparison:
    p_value: float
    percentile: float
    median: float
    q05: float
    q95: float
    n: int


def compare_to_random(value: float | None, others: Sequence[float | None]) -> RandomComparison:
    raise NotImplementedError("WP5")
