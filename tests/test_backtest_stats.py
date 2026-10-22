"""Sharpe statistics, PSR/DSR, the paired bootstrap and the random-entry comparison (spec section 6).

Hand-computed vectors pin every formula; the DSR vector is the one in the spec (and in
m3_design/dsr_check.py): SR_ann 2.5, T 1250, skew -3, kurt 10, N 100, V_ann 0.5 at 250
periods a year gives SR0_ann 1.7894 and DSR 0.9004.
"""

from __future__ import annotations

import itertools
import math
import random

import pytest
from hypothesis import given
from hypothesis import strategies as st

from samsulek.backtest import metrics, stats
from samsulek.backtest.stats import (
    EULER_GAMMA,
    DsrResult,
    RandomComparison,
    SharpeStats,
    bootstrap_prob_sharpe_higher,
    compare_to_random,
    deflated_sharpe,
    expected_max_sharpe,
    psr,
    sharpe_annual,
    sharpe_stats,
)

returns_lists = st.lists(
    st.floats(min_value=-0.2, max_value=0.2, allow_nan=False, allow_infinity=False), min_size=3, max_size=60
)


# =============================================================================== sharpe_stats
def test_sharpe_stats_symmetric_hand_vector() -> None:
    # mean 0.005; deviations +-0.005, +-0.015; sample var 0.0005/3; population m2 0.000125,
    # m3 0, m4 2.5625e-8 -> kurt 2.5625e-8 / 1.5625e-8 = 1.64
    s = sharpe_stats([0.01, -0.01, 0.02, 0.0])
    assert s is not None
    assert s.t == 4
    assert s.sr == pytest.approx(0.005 / math.sqrt(0.0005 / 3), rel=1e-12)
    assert s.skew == pytest.approx(0.0, abs=1e-9)
    assert s.kurt == pytest.approx(1.64, rel=1e-12)


def test_sharpe_stats_skewed_hand_vector() -> None:
    # [0, 0, 0, 1]: mean 0.25, sample std 0.5 -> SR 0.5; skew 2/sqrt(3); kurt 7/3 (non-excess)
    s = sharpe_stats([0.0, 0.0, 0.0, 1.0])
    assert s == SharpeStats(
        sr=pytest.approx(0.5), t=4, skew=pytest.approx(2 / math.sqrt(3)), kurt=pytest.approx(7 / 3)
    )


@pytest.mark.parametrize("returns", [[], [0.01], [0.0] * 30, [0.1] * 50, [-0.0123456789] * 7])
def test_no_sharpe_without_two_unequal_returns(returns: list[float]) -> None:
    # [0.1] * 50: the float mean is not exactly 0.1, so a naive std is ~1e-17 and the Sharpe
    # ratio ~1e16. The exact "all equal" test prevents that.
    assert sharpe_stats(returns) is None
    assert sharpe_annual(returns) is None


@pytest.mark.parametrize("scale", [1.0, 1e-160, 5e-324])
def test_tiny_returns_keep_their_statistics(scale: float) -> None:
    # [0, 0, 1]: mean 1/3, sample std sqrt(1/3) -> SR sqrt(1/3); m2 2/9, m3 2/27, m4 2/27 ->
    # skew 1/sqrt(2), kurt 1.5. Scaled to 5e-324 (the smallest float) an unscaled mean
    # rounds to 0 and the skew comes out as sqrt(3).
    s = sharpe_stats([0.0, 0.0, scale])
    assert s is not None
    assert s.sr == pytest.approx(math.sqrt(1 / 3), rel=1e-12)
    assert s.skew == pytest.approx(1 / math.sqrt(2), rel=1e-12)
    assert s.kurt == pytest.approx(1.5, rel=1e-12)
    assert stats._sharpe_of([0.0, 0.0, scale]) == pytest.approx(math.sqrt(1 / 3), rel=1e-12)


def test_sharpe_stats_refuses_non_finite_returns() -> None:
    with pytest.raises(ValueError, match="finite"):
        sharpe_stats([0.01, math.nan, 0.02])


def test_sharpe_annual_is_per_period_times_sqrt_252() -> None:
    r = [0.01, -0.01, 0.02, 0.0]
    s = sharpe_stats(r)
    assert s is not None
    assert sharpe_annual(r) == pytest.approx(s.sr * math.sqrt(252), rel=1e-15)
    assert stats._PERIODS_PER_YEAR == metrics.PERIODS_PER_YEAR == 252


@given(returns_lists, st.floats(min_value=0.01, max_value=100))
def test_scaling_returns_keeps_sharpe_skew_and_kurtosis(returns: list[float], c: float) -> None:
    a, b = sharpe_stats(returns), sharpe_stats([c * r for r in returns])
    if a is not None and b is not None and abs(a.sr) < 1e6:
        assert b.sr == pytest.approx(a.sr, rel=1e-6, abs=1e-9)
        assert b.skew == pytest.approx(a.skew, rel=1e-6, abs=1e-6)
        assert b.kurt == pytest.approx(a.kurt, rel=1e-6, abs=1e-6)


@given(returns_lists)
def test_negating_returns_negates_sharpe_and_skew(returns: list[float]) -> None:
    a, b = sharpe_stats(returns), sharpe_stats([-r for r in returns])
    if a is None:
        assert b is None
        return
    assert b is not None
    assert b.sr == pytest.approx(-a.sr, rel=1e-9, abs=1e-12)
    assert b.skew == pytest.approx(-a.skew, rel=1e-9, abs=1e-9)
    assert b.kurt == pytest.approx(a.kurt, rel=1e-9)
    assert a.kurt >= 1.0 - 1e-9  # kurtosis >= skew^2 + 1 >= 1 for any distribution
    assert a.kurt >= a.skew**2 + 1 - 1e-6


# =============================================================================== PSR and SR0
def _vector() -> tuple[SharpeStats, float]:
    ppy = 250
    return SharpeStats(sr=2.5 / math.sqrt(ppy), t=1250, skew=-3.0, kurt=10.0), 0.5 / ppy


def test_dsr_spec_vector() -> None:
    s, var = _vector()
    sr0 = expected_max_sharpe(var, 100)
    assert round(sr0 * math.sqrt(250), 4) == 1.7894
    assert round(sr0, 5) == 0.11317
    value = psr(s, sr0)
    assert value is not None
    assert round(value, 4) == 0.9004


def test_expected_max_sharpe_formula_by_hand() -> None:
    n = stats.NormalDist()
    var, trials = 0.002, 25
    z = (1 - EULER_GAMMA) * n.inv_cdf(1 - 1 / trials) + EULER_GAMMA * n.inv_cdf(1 - 1 / (trials * math.e))
    assert expected_max_sharpe(var, trials) == pytest.approx(math.sqrt(var) * z, rel=1e-15)
    assert EULER_GAMMA == 0.5772156649015329


def test_one_trial_means_no_deflation() -> None:
    assert expected_max_sharpe(0.5, 1) == 0.0
    assert expected_max_sharpe(0.0, 1000) == 0.0


def test_sr0_rises_with_the_number_of_trials() -> None:
    values = [expected_max_sharpe(0.001, n) for n in (1, 2, 3, 5, 10, 23, 100, 1000, 100_000)]
    assert values == sorted(values)
    assert len(set(values)) == len(values)


@pytest.mark.parametrize(("var", "n"), [(-0.1, 5), (math.nan, 5), (0.1, 0), (0.1, -3)])
def test_expected_max_sharpe_refuses_bad_inputs(var: float, n: int) -> None:
    with pytest.raises(ValueError, match=r"n_trials|variance"):
        expected_max_sharpe(var, n)


def test_psr_hand_values() -> None:
    s = SharpeStats(sr=0.1, t=101, skew=0.0, kurt=3.0)
    # z = (0.1 - 0) * sqrt(100) / sqrt(1 + 0.5 * 0.01) = 1 / sqrt(1.005)
    assert psr(s, 0.0) == pytest.approx(stats.NormalDist().cdf(1 / math.sqrt(1.005)), rel=1e-15)
    assert psr(s, 0.1) == pytest.approx(0.5)


def test_psr_none_when_the_radicand_is_not_positive() -> None:
    # 1 - skew * SR + (kurt - 1) / 4 * SR^2 = 1 - 3 + 0 = -2
    assert psr(SharpeStats(sr=1.0, t=100, skew=3.0, kurt=1.0), 0.0) is None
    assert psr(SharpeStats(sr=1.0, t=100, skew=2.0, kurt=1.0), 0.0) is None  # 1 - 2 + 0 = -1
    assert psr(SharpeStats(sr=1.0, t=100, skew=1.0, kurt=1.0), 0.0) is None  # 1 - 1 + 0: exactly 0


@given(st.floats(min_value=-0.5, max_value=0.5), st.floats(min_value=-0.5, max_value=0.5))
def test_psr_falls_as_the_benchmark_rises(b1: float, b2: float) -> None:
    s = SharpeStats(sr=0.05, t=500, skew=-0.5, kurt=5.0)
    lo, hi = sorted((b1, b2))
    p_lo, p_hi = psr(s, lo), psr(s, hi)
    assert p_lo is not None
    assert p_hi is not None
    assert p_lo >= p_hi


# =============================================================================== deflated_sharpe
R = [0.0, 0.0, 0.0, 1.0, 0.5, -0.2, 0.1]


def test_deflated_sharpe_wires_psr_and_sr0() -> None:
    trial_srs = [0.1, 0.3, -0.2, 0.25]
    var = sum((x - sum(trial_srs) / 4) ** 2 for x in trial_srs) / 3
    d = deflated_sharpe(R, trial_srs=trial_srs, n_trials=10, var_floor=0.001)
    s = sharpe_stats(R)
    assert d is not None
    assert s is not None
    assert d.stats == s
    assert (d.n_trials, d.n_completed) == (10, 4)
    assert d.var_sr == pytest.approx(var, rel=1e-12)
    assert d.sr0 == pytest.approx(expected_max_sharpe(var, 10), rel=1e-12)
    assert d.sr0_conservative == d.sr0  # V above the floor
    assert d.dsr == pytest.approx(psr(s, expected_max_sharpe(var, 10)), rel=1e-12)
    assert d.used == d.dsr == d.dsr_conservative


def test_the_variance_floor_makes_the_conservative_value_the_one_used() -> None:
    trial_srs = [0.10, 0.1001, 0.0999]  # V ~ 1e-8, far below the default floor 0.25/252
    d = deflated_sharpe(R, trial_srs=trial_srs, n_trials=3)
    s = sharpe_stats(R)
    assert d is not None
    assert s is not None
    assert d.var_floor == 0.25 / 252
    assert d.var_sr is not None
    assert d.var_sr < d.var_floor
    assert d.sr0_conservative == pytest.approx(expected_max_sharpe(0.25 / 252, 3), rel=1e-12)
    assert d.sr0 is not None
    assert d.sr0_conservative > d.sr0
    assert d.dsr is not None
    assert d.dsr_conservative is not None
    assert d.dsr_conservative < d.dsr
    assert d.used == min(d.dsr, d.dsr_conservative) == d.dsr_conservative
    assert "floor" in d.note


def test_one_trial_gives_sr0_zero() -> None:
    d = deflated_sharpe(R, trial_srs=[0.3], n_trials=1)
    s = sharpe_stats(R)
    assert d is not None
    assert s is not None
    assert (d.sr0, d.sr0_conservative) == (0.0, 0.0)
    assert d.dsr == d.used == psr(s, 0.0)
    assert d.var_sr is None  # one completed trial has no variance; it is not needed at N = 1


@pytest.mark.parametrize("completed", [[], [0.4]])
def test_unknown_variance_gives_no_dsr(completed: list[float]) -> None:
    d = deflated_sharpe(R, trial_srs=completed, n_trials=5)
    assert d is not None
    assert (d.var_sr, d.sr0, d.sr0_conservative, d.dsr, d.dsr_conservative, d.used) == (None,) * 6
    assert "unknown" in d.note


def test_deflated_sharpe_none_without_a_sharpe_ratio() -> None:
    assert deflated_sharpe([0.0] * 20, trial_srs=[0.1, 0.2], n_trials=2) is None


@pytest.mark.parametrize(
    ("trial_srs", "n_trials", "floor"),
    [([0.1, 0.2, 0.3], 2, 0.001), ([0.1], 0, 0.001), ([0.1, 0.2], 3, -1.0)],
)
def test_deflated_sharpe_refuses_inconsistent_inputs(
    trial_srs: list[float], n_trials: int, floor: float
) -> None:
    with pytest.raises(ValueError, match=r"registered|n_trials|var_floor"):
        deflated_sharpe(R, trial_srs=trial_srs, n_trials=n_trials, var_floor=floor)


def test_dsr_falls_as_n_rises_with_the_same_variance() -> None:
    trial_srs = [0.05, 0.2, -0.1, 0.15]
    values = []
    for n in (4, 10, 50, 500):
        d = deflated_sharpe(R, trial_srs=trial_srs, n_trials=n)
        assert isinstance(d, DsrResult)
        assert d.used is not None
        values.append(d.used)
    assert values == sorted(values, reverse=True)


# =============================================================================== bootstrap
def _noise(seed: int, n: int, mu: float = 0.0) -> list[float]:
    rng = random.Random(seed)
    return [mu + rng.gauss(0, 0.01) for _ in range(n)]


def test_bootstrap_is_deterministic_per_seed() -> None:
    a, b = _noise(1, 300, 0.0005), _noise(2, 300)
    p1 = bootstrap_prob_sharpe_higher(a, b, seed=42, n_boot=300)
    assert p1 == bootstrap_prob_sharpe_higher(a, b, seed=42, n_boot=300)
    others = {bootstrap_prob_sharpe_higher(a, b, seed=s, n_boot=300) for s in range(5)}
    assert len(others) > 1  # the seed matters


def test_identical_series_are_never_strictly_better() -> None:
    a = _noise(3, 250)
    assert bootstrap_prob_sharpe_higher(a, list(a), seed=7, n_boot=400) == 0.0


def test_a_clearly_better_series_wins_almost_always() -> None:
    b = _noise(4, 400)
    a = [x + 0.003 for x in b]  # same noise, higher mean
    p = bootstrap_prob_sharpe_higher(a, b, seed=9, n_boot=400)
    assert p is not None
    assert p == 1.0  # every resample has a's mean above b's with the same std
    assert bootstrap_prob_sharpe_higher(b, a, seed=9, n_boot=400) == 0.0


def test_bootstrap_resamples_are_paired_and_blocked() -> None:
    # If the two series were resampled with DIFFERENT indices, a strongly correlated pair
    # would sometimes swap order; paired resampling keeps the shifted series ahead.
    b = _noise(5, 120)
    a = [x * 1.0 + 0.0008 for x in b]
    assert bootstrap_prob_sharpe_higher(a, b, seed=1, n_boot=500, mean_block=1) == 1.0
    assert bootstrap_prob_sharpe_higher(a, b, seed=1, n_boot=500, mean_block=50) == 1.0


def test_every_resample_has_the_length_of_the_series(monkeypatch: pytest.MonkeyPatch) -> None:
    # The last block is cut at n: a resample longer than the series would weigh its start
    # twice and shrink the spread of the Sharpe ratios.
    lengths: list[int] = []
    real = stats._sharpe_of

    def spy(values: list[float]) -> float | None:
        lengths.append(len(values))
        return real(values)

    monkeypatch.setattr(stats, "_sharpe_of", spy)
    a, b = _noise(1, 37), _noise(2, 37)
    assert bootstrap_prob_sharpe_higher(a, b, seed=3, n_boot=200, mean_block=20) is not None
    assert len(lengths) == 400  # two series per resample
    assert set(lengths) == {37}


def test_blocks_wrap_around_the_end_of_the_series(monkeypatch: pytest.MonkeyPatch) -> None:
    # Politis-Romano blocks are circular: after the last return comes the first. Cutting a
    # block at the end instead (or repeating the last value) would over-weight the end of
    # the series. The series' values are their own indices, so the spy sees the indices.
    n = 50
    resamples: list[list[int]] = []
    real = stats._sharpe_of

    def spy(values: list[float]) -> float | None:
        resamples.append([int(v) for v in values])
        return real(values)

    monkeypatch.setattr(stats, "_sharpe_of", spy)
    series = [float(i) for i in range(n)]
    bootstrap_prob_sharpe_higher(series, list(series), seed=8, n_boot=300, mean_block=20)
    assert any(a == n - 1 and b == 0 for r in resamples for a, b in itertools.pairwise(r))
    counts = [0] * n
    for r in resamples:
        for i in r:
            counts[i] += 1
    mean = sum(counts) / n
    assert max(counts) < 1.5 * mean  # every index about equally often (circular, uniform starts)
    assert min(counts) > 0.5 * mean


def test_zero_variance_resamples_are_skipped() -> None:
    a = _noise(6, 50)
    assert bootstrap_prob_sharpe_higher(a, [0.001] * 50, seed=1, n_boot=50) is None  # b never varies
    assert bootstrap_prob_sharpe_higher([0.1], [0.2], seed=1) is None


def test_bootstrap_refuses_bad_inputs() -> None:
    with pytest.raises(ValueError, match="aligned"):
        bootstrap_prob_sharpe_higher([0.1, 0.2], [0.1], seed=1)
    with pytest.raises(ValueError, match="n_boot"):
        bootstrap_prob_sharpe_higher([0.1, 0.2], [0.1, 0.3], seed=1, n_boot=0)
    with pytest.raises(ValueError, match="mean_block"):
        bootstrap_prob_sharpe_higher([0.1, 0.2], [0.1, 0.3], seed=1, mean_block=0)
    with pytest.raises(ValueError, match="finite"):
        bootstrap_prob_sharpe_higher([0.1, math.inf], [0.1, 0.3], seed=1)


def test_bootstrap_block_lengths_have_the_requested_mean() -> None:
    rng = random.Random(11)
    lengths = [stats._block_length(rng, 1 / 20) for _ in range(20_000)]
    assert min(lengths) == 1
    assert sum(lengths) / len(lengths) == pytest.approx(20, rel=0.05)
    assert stats._block_length(rng, 1.0) == 1


# =============================================================================== random comparison
def test_compare_to_random_with_ties_and_none() -> None:
    c = compare_to_random(1.0, [0.5, 1.0, 1.0, 2.0, None])
    # >= 1.0: three seeds (ties count against the strategy); below: 0.5 and None (= -inf)
    assert c == RandomComparison(p_value=4 / 6, percentile=2 / 5, median=1.0, q05=-math.inf, q95=2.0, n=5)


def test_a_strategy_without_sharpe_is_worse_than_every_seed() -> None:
    c = compare_to_random(None, [0.1, None, -0.3])
    assert c.p_value == 1.0
    assert c.percentile == 0.0


def test_a_strategy_above_every_seed() -> None:
    c = compare_to_random(5.0, [float(i) / 100 for i in range(199)])
    assert c.p_value == 1 / 200
    assert c.percentile == 1.0


def test_nearest_rank_quantiles_for_200_seeds() -> None:
    c = compare_to_random(0.0, [float(i) for i in reversed(range(200))])
    assert (c.q05, c.median, c.q95) == (9.0, 99.0, 189.0)  # ranks 10, 100, 190
    one = compare_to_random(0.0, [3.0])
    assert (one.q05, one.median, one.q95, one.n) == (3.0, 3.0, 3.0, 1)


def test_compare_to_random_refuses_bad_inputs() -> None:
    with pytest.raises(ValueError, match="at least one seed"):
        compare_to_random(1.0, [])
    with pytest.raises(ValueError, match="finite"):
        compare_to_random(math.nan, [1.0])
    with pytest.raises(ValueError, match="finite"):
        compare_to_random(1.0, [math.inf])


@given(
    st.lists(st.one_of(st.none(), st.floats(-5, 5)), min_size=1, max_size=50),
    st.one_of(st.none(), st.floats(-5, 5)),
)
def test_random_p_value_bounds(others: list[float | None], value: float | None) -> None:
    c = compare_to_random(value, others)
    k = len(others)
    assert 1 / (k + 1) <= c.p_value <= 1.0
    assert 0.0 <= c.percentile <= 1.0
    assert c.q05 <= c.median <= c.q95
    # p and percentile partition the seeds: at least as good + strictly below = K
    assert round(c.p_value * (k + 1)) - 1 + round(c.percentile * k) == k
