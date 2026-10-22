"""Sharpe statistics, deflated Sharpe, bootstrap and the random-entry comparison (M3 spec section 6).

Facts relied on:
- Everything is PER PERIOD (one period = one session); annualising multiplies a Sharpe
  ratio by sqrt(252). The Sharpe ratio is ``mean / s`` with ``s`` the sample standard
  deviation (ddof 1). Skewness and kurtosis use POPULATION moments
  ``m_k = sum((r - mean)^k) / T``: ``skew = m3 / m2^1.5``, ``kurt = m4 / m2^2``
  (non-excess: a normal distribution has 3).
- A series with fewer than 2 returns, or whose returns are all equal, has no Sharpe
  ratio (None). "All equal" is tested exactly, so float rounding of the mean can never
  turn a flat series into a huge Sharpe ratio. Values are divided by their largest
  magnitude before any mean or square is taken (every statistic here is scale-free), so
  tiny returns neither underflow nor lose precision.
- PSR and DSR follow Bailey and Lopez de Prado (2014):
  ``PSR(SR*) = Phi((SR - SR*) sqrt(T - 1) / sqrt(1 - skew SR + (kurt - 1) / 4 SR^2))`` and
  ``SR0 = sqrt(V) ((1 - g) PhiInv(1 - 1/N) + g PhiInv(1 - 1/(N e)))``, g = Euler's gamma.
  N is the GLOBAL count of registered research trials (every variant, aborted studies
  included) and V the sample variance (ddof 1) of the completed trials' per-period Sharpe
  ratios. The conservative variant floors V at ``var_floor`` (0.25/252: an annual Sharpe
  spread of 0.5 between variants); ``used = min(dsr, dsr_conservative)``. With N >= 2 and
  fewer than 2 completed trials V is unknown, so no DSR is reported (the fact is UNKNOWN),
  never a number computed from a guess.
- The buy-and-hold comparison is a paired stationary bootstrap (Politis and Romano 1994):
  both series are resampled with the SAME indices, in circular blocks whose lengths are
  geometric with mean ``mean_block``. The answer is the share of resamples in which a's
  Sharpe ratio is strictly above b's; resamples where either side has zero variance are
  skipped. A seeded ``random.Random`` makes it reproducible.
- The random-entry comparison counts a missing Sharpe ratio (None) as minus infinity, on
  both sides: ``p = (1 + #{seeds >= strategy}) / (K + 1)``.
- Only ``statistics.NormalDist`` is used (no numpy, no scipy).
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence
from dataclasses import dataclass
from statistics import NormalDist
from typing import Final

EULER_GAMMA: Final = 0.5772156649015329
_PERIODS_PER_YEAR: Final = 252  # = metrics.PERIODS_PER_YEAR (metrics imports this module, not the reverse)
_NORMAL: Final = NormalDist()
_MINUS_INF: Final = -math.inf


@dataclass(frozen=True, slots=True)
class SharpeStats:
    sr: float  # per period
    t: int
    skew: float
    kurt: float  # non-excess


def _scaled_deviations(values: Sequence[float]) -> tuple[float, list[float], float] | None:
    """(mean, deviations from it, sample std), all divided by ``max |x|``; None if undefined.

    Undefined: fewer than 2 values, all values equal, or values so close that they become
    equal once scaled. The scaling happens BEFORE the mean is taken, so tiny returns
    (1e-160, or subnormal numbers) keep their precision: unscaled, their mean or squares
    would round to 0 and give a wrong skew or a wrong "no variance". The Sharpe ratio,
    skew and kurtosis are all scale-free, so they can be read off the scaled values.
    """
    n = len(values)
    if n < 2 or min(values) == max(values):
        return None
    scale = max(abs(x) for x in values)  # > 0: the values differ
    scaled = [x / scale for x in values]  # in [-1, 1]
    mu = math.fsum(scaled) / n
    dev = [x - mu for x in scaled]
    sum_sq = math.fsum(d * d for d in dev)
    if not sum_sq > 0:  # the values only differed below float precision once scaled
        return None
    return mu, dev, math.sqrt(sum_sq / (n - 1))


def _require_finite(values: Sequence[float], what: str) -> None:
    for x in values:
        if not math.isfinite(x):
            raise ValueError(f"{what} must be finite numbers, got {x!r}")


def sharpe_stats(returns: Sequence[float]) -> SharpeStats | None:
    """None if fewer than 2 returns or a zero standard deviation."""
    _require_finite(returns, "returns")
    moments = _scaled_deviations(returns)
    if moments is None:
        return None
    mu, dev, s = moments
    t = len(returns)
    # Population moments of the standardised deviations: m_k = sum(z^k) / T. Skew and
    # kurtosis do not depend on the unit, and standardising keeps m2^2 far from underflow.
    z = [d / s for d in dev]
    m2 = math.fsum(v * v for v in z) / t
    m3 = math.fsum(v**3 for v in z) / t
    m4 = math.fsum(v**4 for v in z) / t
    if not m2 > 0:  # cannot happen once sum_sq > 0; fail closed rather than divide by zero
        return None
    return SharpeStats(sr=mu / s, t=t, skew=m3 / m2**1.5, kurt=m4 / m2**2)


def sharpe_annual(returns: Sequence[float]) -> float | None:
    stats = sharpe_stats(returns)
    return None if stats is None else stats.sr * math.sqrt(_PERIODS_PER_YEAR)


def psr(stats: SharpeStats, benchmark: float) -> float | None:
    """None if the radicand is <= 0."""
    sr = stats.sr
    radicand = 1.0 - stats.skew * sr + (stats.kurt - 1.0) / 4.0 * sr * sr
    if not radicand > 0 or stats.t < 2:
        return None
    return _NORMAL.cdf((sr - benchmark) * math.sqrt(stats.t - 1) / math.sqrt(radicand))


def expected_max_sharpe(var_sr: float, n_trials: int) -> float:
    """0.0 when n_trials == 1."""
    if isinstance(n_trials, bool) or n_trials < 1:
        raise ValueError(f"n_trials must be >= 1, got {n_trials!r}")
    if not math.isfinite(var_sr) or var_sr < 0:
        raise ValueError(f"the variance of the trials' Sharpe ratios must be finite and >= 0, got {var_sr!r}")
    if n_trials == 1:
        return 0.0
    n = float(n_trials)
    z = (1.0 - EULER_GAMMA) * _NORMAL.inv_cdf(1.0 - 1.0 / n) + EULER_GAMMA * _NORMAL.inv_cdf(
        1.0 - 1.0 / (n * math.e)
    )
    return math.sqrt(var_sr) * z


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


def _sample_variance(values: Sequence[float]) -> float | None:
    n = len(values)
    if n < 2:
        return None
    mu = math.fsum(values) / n
    return math.fsum((x - mu) ** 2 for x in values) / (n - 1)


def deflated_sharpe(
    returns: Sequence[float], *, trial_srs: Sequence[float], n_trials: int, var_floor: float = 0.25 / 252
) -> DsrResult | None:
    """None if ``sharpe_stats(returns)`` is None."""
    if isinstance(n_trials, bool) or n_trials < 1:
        raise ValueError(
            f"n_trials must be >= 1 (the deflated Sharpe needs the registry count), got {n_trials!r}"
        )
    _require_finite(trial_srs, "trial Sharpe ratios")
    if len(trial_srs) > n_trials:
        raise ValueError(f"{len(trial_srs)} completed trials but only {n_trials} registered (a registry bug)")
    if not math.isfinite(var_floor) or var_floor < 0:
        raise ValueError(f"var_floor must be finite and >= 0, got {var_floor!r}")
    stats = sharpe_stats(returns)
    if stats is None:
        return None
    n_completed = len(trial_srs)
    var_sr = _sample_variance(trial_srs)
    if n_trials == 1:
        # One trial: nothing was selected, so there is nothing to deflate (SR0 = 0).
        dsr = psr(stats, 0.0)
        return DsrResult(
            stats=stats,
            n_trials=1,
            n_completed=n_completed,
            var_sr=var_sr,
            var_floor=var_floor,
            sr0=0.0,
            sr0_conservative=0.0,
            dsr=dsr,
            dsr_conservative=dsr,
            used=dsr,
            note="N = 1: one trial, SR0 = 0 (no selection to deflate)",
        )
    if var_sr is None:
        return DsrResult(
            stats=stats,
            n_trials=n_trials,
            n_completed=n_completed,
            var_sr=None,
            var_floor=var_floor,
            sr0=None,
            sr0_conservative=None,
            dsr=None,
            dsr_conservative=None,
            used=None,
            note=(
                f"N = {n_trials} but only {n_completed} completed trial(s): the variance of the trials' "
                "Sharpe ratios is unknown, so no deflated Sharpe is reported"
            ),
        )
    var_conservative = max(var_sr, var_floor)
    sr0 = expected_max_sharpe(var_sr, n_trials)
    sr0_conservative = expected_max_sharpe(var_conservative, n_trials)
    dsr = psr(stats, sr0)
    dsr_conservative = psr(stats, sr0_conservative)
    used = None if dsr is None or dsr_conservative is None else min(dsr, dsr_conservative)
    note = f"N = {n_trials} registered trials, V from {n_completed} completed trial(s)"
    if var_sr < var_floor:
        note += f"; V below the floor {var_floor:.3g}, the conservative value uses the floor"
    if used is None:
        note += "; the PSR radicand is <= 0 (extreme skew or kurtosis), so no DSR is reported"
    return DsrResult(
        stats=stats,
        n_trials=n_trials,
        n_completed=n_completed,
        var_sr=var_sr,
        var_floor=var_floor,
        sr0=sr0,
        sr0_conservative=sr0_conservative,
        dsr=dsr,
        dsr_conservative=dsr_conservative,
        used=used,
        note=note,
    )


def _block_length(rng: random.Random, p: float) -> int:
    """A geometric block length with mean 1/p (support 1, 2, ...)."""
    if p >= 1.0:
        return 1
    u = 1.0 - rng.random()  # in (0, 1]
    return 1 + int(math.log(u) / math.log(1.0 - p))


def _sharpe_of(values: list[float]) -> float | None:
    moments = _scaled_deviations(values)
    return None if moments is None else moments[0] / moments[2]


def bootstrap_prob_sharpe_higher(
    a: Sequence[float], b: Sequence[float], *, seed: int, n_boot: int = 2000, mean_block: int = 20
) -> float | None:
    """P(Sharpe of a > Sharpe of b) over paired stationary-bootstrap resamples.

    None if the series are shorter than 2 or every resample had a zero-variance side.
    """
    if len(a) != len(b):
        raise ValueError(f"the bootstrap needs aligned series, got lengths {len(a)} and {len(b)}")
    if isinstance(n_boot, bool) or n_boot < 1:
        raise ValueError(f"n_boot must be >= 1, got {n_boot!r}")
    if isinstance(mean_block, bool) or mean_block < 1:
        raise ValueError(f"mean_block must be >= 1, got {mean_block!r}")
    _require_finite(a, "returns")
    _require_finite(b, "returns")
    n = len(a)
    if n < 2:
        return None
    xa, xb = list(a), list(b)
    rng = random.Random(seed)
    p = 1.0 / mean_block
    higher = valid = 0
    for _ in range(n_boot):
        idx: list[int] = []
        while len(idx) < n:
            start = rng.randrange(n)
            take = min(_block_length(rng, p), n - len(idx))
            idx.extend((start + k) % n for k in range(take))
        sa = _sharpe_of([xa[i] for i in idx])
        sb = _sharpe_of([xb[i] for i in idx])
        if sa is None or sb is None:
            continue
        valid += 1
        if sa > sb:
            higher += 1
    return higher / valid if valid else None


@dataclass(frozen=True, slots=True)
class RandomComparison:
    p_value: float
    percentile: float
    median: float
    q05: float
    q95: float
    n: int


def _nearest_rank(ordered: Sequence[float], percent: int) -> float:
    """The nearest-rank percentile: the value of rank ceil(percent/100 x K), 1-based."""
    k = len(ordered)
    rank = max(1, -(-percent * k // 100))
    return ordered[rank - 1]


def compare_to_random(value: float | None, others: Sequence[float | None]) -> RandomComparison:
    """Where the strategy's Sharpe ratio falls among the random-entry seeds' (None = -inf)."""
    if not others:
        raise ValueError("the random-entry comparison needs at least one seed")
    v = _MINUS_INF if value is None else value
    xs = sorted(_MINUS_INF if x is None else x for x in others)
    for x in (v, *xs):
        if math.isnan(x) or x == math.inf:
            raise ValueError(f"Sharpe ratios must be finite or None, got {x!r}")
    k = len(xs)
    at_least = sum(1 for x in xs if x >= v)
    below = sum(1 for x in xs if x < v)
    return RandomComparison(
        p_value=(1 + at_least) / (k + 1),
        percentile=below / k,
        median=_nearest_rank(xs, 50),
        q05=_nearest_rank(xs, 5),
        q95=_nearest_rank(xs, 95),
        n=k,
    )
