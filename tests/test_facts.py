"""The four facts, the sanity flags and the verdict (spec section 7.5): full truth tables.

The tables are written from the spec, not from facts.py: fact 1 PASS needs random p <= 0.05
AND bootstrap P >= 0.90, with INCONCLUSIVE below 3 folds, 756 out-of-sample sessions, 10
closed episodes or 200 seeds; fact 2 is fact 1 at 2x plus a positive 2x Sharpe; an R-mode
hard stop fails both (C12); fact 3 is NOT_RUN until a holdout ran; fact 4 is PASS at
``used >= 0.95``, WEAK when only SR > SR0', UNKNOWN without a DSR. S-studies are never
evidence. Any flag makes the verdict SUSPICIOUS.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import replace
from datetime import date
from typing import Any

import pytest

from samsulek.backtest.facts import (
    CANDIDATE,
    NO_EDGE,
    PLUMBING_ONLY,
    PROMISING,
    SUSPICIOUS,
    Evidence,
    Fact,
    FactState,
    HoldoutOutcome,
    compute_facts,
    sanity_flags,
    verdict,
)
from samsulek.backtest.stats import DsrResult, RandomComparison, SharpeStats
from samsulek.backtest.types import Metrics

PASS, FAIL, WEAK = FactState.PASS, FactState.FAIL, FactState.WEAK
INCONCLUSIVE, NOT_RUN, UNKNOWN, NOT_EVIDENCE = (
    FactState.INCONCLUSIVE,
    FactState.NOT_RUN,
    FactState.UNKNOWN,
    FactState.NOT_EVIDENCE,
)

# A plausible, unremarkable strategy: nothing here may raise a flag.
GOOD = Metrics(
    first_session=date(2015, 3, 2), last_session=date(2024, 9, 30), n_returns=2400, years=9.6,
    total_return=0.6, cagr=0.05, ann_vol=0.12, sharpe=0.8, sortino=1.1, sr_per_period=0.8 / math.sqrt(252),
    skew=-0.4, kurtosis=6.0, max_drawdown=0.18, mdd_peak=date(2020, 2, 19), mdd_trough=date(2020, 3, 18),
    mdd_recovery=date(2020, 11, 20), mdd_duration_sessions=190, mdd_duration_days=275,
    longest_underwater_sessions=300, recovered=True, n_episodes_closed=40, n_episodes_open=1, win_rate=0.55,
    avg_win_eur=1.2, avg_loss_eur=-0.9, avg_win_pct=0.08, avg_loss_pct=-0.06, profit_factor=1.4, turnover=2.0,
    exposure=0.6, time_in_market=0.7, weight_gap=0.02, n_fills=90, fees_eur=0.0, spread_eur=1.1,
    slippage_eur=0.6, cost_drag_bps_per_year=35.0, n_rejections=3,
)  # fmt: skip
BH = replace(
    GOOD, sharpe=0.5, n_episodes_closed=0, n_episodes_open=3, win_rate=None, profit_factor=None, n_fills=3
)
RANDOM_OK = RandomComparison(p_value=0.01, percentile=0.99, median=0.1, q05=-0.4, q95=0.6, n=200)
STATS = SharpeStats(sr=0.8 / math.sqrt(252), t=2400, skew=-0.4, kurt=6.0)
DSR_OK = DsrResult(
    stats=STATS, n_trials=12, n_completed=12, var_sr=0.0005, var_floor=0.25 / 252, sr0=0.02,
    sr0_conservative=0.03, dsr=0.98, dsr_conservative=0.97, used=0.97,
    note="N = 12 registered trials, V from 12 completed trial(s)",
)  # fmt: skip
EV = Evidence(
    synthetic=False, n_oos=2400, n_folds=9, n_seeds=200, strategy_1x=GOOD,
    strategy_2x=replace(GOOD, sharpe=0.6), bh_1x=BH, bh_2x=replace(BH, sharpe=0.48),
    random_1x=RANDOM_OK, random_2x=RANDOM_OK, boot_1x=0.95,
    boot_2x=0.92, dsr=DSR_OK, variant_sharpes=(0.9, 1.1, None), r_hard_stops=0, holdout=None,
)  # fmt: skip
ACCEPTED = HoldoutOutcome(
    accepted=True, lines=("Sharpe 0.70 >= 0.00", "beats buy-and-hold", "2x Sharpe 0.40 > 0")
)
REJECTED = HoldoutOutcome(accepted=False, lines=("Sharpe -0.20 < 0.00",))


def states(ev: Evidence) -> tuple[FactState, ...]:
    return tuple(f.state for f in compute_facts(ev))


def ascii_lines(facts: tuple[Fact, ...]) -> None:
    for f in facts:
        assert f.title.isascii() and all(line.isascii() for line in f.lines)


# ------------------------------------------------------------------------------ the baseline evidence
def test_the_good_evidence_passes_and_raises_no_flag() -> None:
    facts = compute_facts(EV)
    assert [f.number for f in facts] == [1, 2, 3, 4]
    assert states(EV) == (PASS, PASS, NOT_RUN, PASS)
    assert sanity_flags(EV) == ()
    assert verdict(facts, (), synthetic=False) == PROMISING
    ascii_lines(facts)


def test_an_accepted_holdout_makes_a_candidate_and_a_rejected_one_no_edge() -> None:
    assert states(replace(EV, holdout=ACCEPTED)) == (PASS, PASS, PASS, PASS)
    assert verdict(compute_facts(replace(EV, holdout=ACCEPTED)), (), synthetic=False) == CANDIDATE
    facts = compute_facts(replace(EV, holdout=REJECTED))
    assert facts[2].state is FAIL and facts[2].lines == REJECTED.lines
    assert verdict(facts, (), synthetic=False).startswith(f"{NO_EDGE}: fact 3 ")


# ------------------------------------------------------------------------------ facts 1 and 2
P_VALUES = (0.001, 0.05, 0.0500001, 0.5)
BOOTS = (None, 0.0, 0.8999, 0.90, 1.0)
SHORTFALLS: tuple[dict[str, Any], ...] = (
    {},
    {"n_folds": 2},
    {"n_oos": 755},
    {"n_seeds": 199},
    {"episodes": 9},
    {"seeds_n": 199},  # the comparison itself was made with fewer seeds than the study says
)
HARD_STOPS = (0, 1)


def _evidence_at(cost: int, p: float, boot: float | None, shortfall: dict[str, Any], hard: int) -> Evidence:
    seeds = replace(RANDOM_OK, p_value=p, n=shortfall.get("seeds_n", 200))
    ev = replace(
        EV,
        n_folds=shortfall.get("n_folds", 9),
        n_oos=shortfall.get("n_oos", 2400),
        n_seeds=shortfall.get("n_seeds", 200),
        r_hard_stops=hard,
    )
    episodes = shortfall.get("episodes", 40)
    if cost == 1:
        return replace(
            ev, random_1x=seeds, boot_1x=boot, strategy_1x=replace(GOOD, n_episodes_closed=episodes)
        )
    return replace(
        ev, random_2x=seeds, boot_2x=boot, strategy_2x=replace(EV.strategy_2x, n_episodes_closed=episodes)
    )


def expected_beats(p: float, boot: float | None, shortfall: dict[str, Any], hard: int) -> FactState:
    if hard:
        return FAIL
    if shortfall:
        return INCONCLUSIVE
    return PASS if p <= 0.05 and boot is not None and boot >= 0.90 else FAIL


@pytest.mark.parametrize("cost", [1, 2])
def test_facts_1_and_2_truth_table(cost: int) -> None:
    rows = 0
    for p, boot, shortfall, hard in itertools.product(P_VALUES, BOOTS, SHORTFALLS, HARD_STOPS):
        ev = _evidence_at(cost, p, boot, shortfall, hard)
        facts = compute_facts(ev)
        got = facts[cost - 1].state
        assert got is expected_beats(p, boot, shortfall, hard), (cost, p, boot, shortfall, hard)
        if cost == 1 and not hard and not shortfall:
            assert facts[1].state is PASS  # fact 2 does not depend on the 1x numbers
        ascii_lines(facts)
        rows += 1
    assert rows == len(P_VALUES) * len(BOOTS) * len(SHORTFALLS) * len(HARD_STOPS)


@pytest.mark.parametrize(
    ("sharpe_2x", "state"), [(0.6, PASS), (1e-9, PASS), (0.0, FAIL), (-0.0, FAIL), (-0.3, FAIL), (None, FAIL)]
)
def test_fact_2_needs_a_positive_2x_sharpe(sharpe_2x: float | None, state: FactState) -> None:
    ev = replace(EV, strategy_2x=replace(EV.strategy_2x, sharpe=sharpe_2x))
    assert states(ev)[1] is state
    assert states(ev)[0] is PASS  # fact 1 is the 1x run: unaffected


def test_fact_1_is_the_two_comparisons_only() -> None:
    # Unlike fact 2, fact 1 has no sign test of its own: the two comparisons decide it.
    assert states(replace(EV, strategy_1x=replace(GOOD, sharpe=-0.2)))[0] is PASS


def test_an_r_hard_stop_fails_facts_1_and_2_whatever_the_numbers() -> None:
    facts = compute_facts(replace(EV, r_hard_stops=1))
    assert (facts[0].state, facts[1].state) == (FAIL, FAIL)
    assert any("hard stop" in line for line in facts[0].lines + facts[1].lines)
    # it wins over too little evidence too: a catastrophic run is a failure, not a maybe
    assert states(replace(EV, r_hard_stops=2, n_folds=1))[:2] == (FAIL, FAIL)


def test_too_little_evidence_names_every_shortfall() -> None:
    ev = replace(EV, n_folds=2, n_oos=500, n_seeds=20, strategy_1x=replace(GOOD, n_episodes_closed=3))
    fact = compute_facts(ev)[0]
    assert fact.state is INCONCLUSIVE
    text = " ".join(fact.lines)
    for part in (
        "2 walk-forward fold",
        "500 out-of-sample sessions",
        "3 closed episode",
        "20 random-entry seed",
    ):
        assert part in text, part


def test_boundaries_count_as_enough_evidence() -> None:
    ev = replace(EV, n_folds=3, n_oos=756, n_seeds=200, strategy_1x=replace(GOOD, n_episodes_closed=10))
    assert states(ev)[0] is PASS


def test_fact_lines_show_the_numbers() -> None:
    text = " ".join(compute_facts(EV)[0].lines)
    assert "p = 0.010" in text and "0.950" in text and "0.80" in text and "0.50" in text


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_a_non_finite_number_never_passes(bad: float) -> None:
    assert states(replace(EV, boot_1x=bad))[0] is FAIL
    assert states(replace(EV, random_1x=replace(RANDOM_OK, p_value=bad)))[0] is FAIL
    assert states(replace(EV, strategy_2x=replace(EV.strategy_2x, sharpe=bad)))[1] is FAIL
    assert sanity_flags(replace(EV, boot_1x=bad))


# ------------------------------------------------------------------------------ fact 3
@pytest.mark.parametrize(
    ("holdout", "state"),
    [(None, NOT_RUN), (ACCEPTED, PASS), (REJECTED, FAIL), (HoldoutOutcome(accepted=False, lines=()), FAIL)],
)
def test_fact_3_truth_table(holdout: HoldoutOutcome | None, state: FactState) -> None:
    fact = compute_facts(replace(EV, holdout=holdout))[2]
    assert fact.state is state and fact.lines


# ------------------------------------------------------------------------------ fact 4
def dsr(*, used: float | None, sr: float, sr0c: float | None, n_trials: int = 12) -> DsrResult:
    return replace(
        DSR_OK, stats=replace(STATS, sr=sr), used=used, sr0_conservative=sr0c, n_trials=n_trials, dsr=used,
        dsr_conservative=used,
    )  # fmt: skip


@pytest.mark.parametrize(
    ("result", "state"),
    [
        (None, UNKNOWN),
        (dsr(used=None, sr=0.05, sr0c=None), UNKNOWN),  # N >= 2 with fewer than 2 completed trials
        (dsr(used=math.nan, sr=0.05, sr0c=0.03), UNKNOWN),
        (dsr(used=0.95, sr=0.05, sr0c=0.03), PASS),
        (dsr(used=0.999, sr=0.05, sr0c=0.03), PASS),
        (dsr(used=0.9499, sr=0.05, sr0c=0.03), WEAK),  # SR above SR0' but not significant
        (dsr(used=0.6, sr=0.031, sr0c=0.03), WEAK),
        (dsr(used=0.5, sr=0.03, sr0c=0.03), FAIL),  # SR == SR0' is not above it
        (dsr(used=0.2, sr=0.01, sr0c=0.03), FAIL),
        (dsr(used=0.2, sr=0.01, sr0c=None), FAIL),
        (dsr(used=0.99, sr=0.05, sr0c=0.0, n_trials=1), PASS),
    ],
)
def test_fact_4_truth_table(result: DsrResult | None, state: FactState) -> None:
    fact = compute_facts(replace(EV, dsr=result))[3]
    assert fact.state is state and fact.lines
    ascii_lines((fact,))


# ------------------------------------------------------------------------------ synthetic studies
def test_synthetic_studies_are_never_evidence() -> None:
    for ev in (
        EV,
        replace(EV, holdout=ACCEPTED),
        replace(EV, r_hard_stops=1),
        replace(EV, dsr=None, n_folds=1),
    ):
        facts = compute_facts(replace(ev, synthetic=True))
        assert states(replace(ev, synthetic=True)) == (NOT_EVIDENCE,) * 4
        assert all(f.lines[0].startswith("synthetic data") for f in facts)
        assert verdict(facts, sanity_flags(ev), synthetic=True) == PLUMBING_ONLY


# ------------------------------------------------------------------------------ sanity flags
FLAG_CASES: tuple[tuple[str, Evidence, str], ...] = (
    ("sharpe 1x", replace(EV, strategy_1x=replace(GOOD, sharpe=3.01)), "above 3"),
    ("sharpe 2x", replace(EV, strategy_2x=replace(GOOD, sharpe=3.5)), "above 3"),
    ("variant sharpe", replace(EV, variant_sharpes=(0.9, 3.2)), "variant 001"),
    ("tiny drawdown", replace(EV, strategy_1x=replace(GOOD, max_drawdown=0.0199)), "too small to be real"),
    ("win rate", replace(EV, strategy_2x=replace(GOOD, win_rate=0.81)), "win rate"),
    ("profit factor", replace(EV, strategy_1x=replace(GOOD, profit_factor=5.01)), "profit factor"),
    ("oos above variants", replace(EV, variant_sharpes=(0.7, 0.79)), "above every variant"),
    ("oos above None variants", replace(EV, variant_sharpes=(None, 0.5)), "above every variant"),
    ("free strategy", replace(EV, strategy_1x=replace(GOOD, cost_drag_bps_per_year=0.0)), "cost nothing"),
    ("free 2x", replace(EV, strategy_2x=replace(GOOD, cost_drag_bps_per_year=-1.0)), "cost nothing"),
    ("free buy-and-hold", replace(EV, bh_1x=replace(BH, cost_drag_bps_per_year=0.0)), "buy-and-hold at 1x"),
    (
        "free buy-and-hold 2x",
        replace(EV, bh_2x=replace(BH, cost_drag_bps_per_year=0.0)),
        "buy-and-hold at 2x",
    ),
    ("hard stop", replace(EV, r_hard_stops=1), "hard stop"),
    ("nan sharpe", replace(EV, bh_2x=replace(BH, sharpe=math.nan)), "not a finite number"),
    ("nan boot", replace(EV, boot_2x=math.nan), "not a finite number"),
    ("nan variant", replace(EV, variant_sharpes=(0.9, math.nan)), "not a finite number"),
    ("nan dsr", replace(EV, dsr=replace(DSR_OK, used=math.inf)), "not a finite number"),
    # a threshold test on NaN or an infinity says "nothing to flag": each is a flag itself
    (
        "inf profit factor",
        replace(EV, strategy_1x=replace(GOOD, profit_factor=math.inf)),
        "profit factor is inf",
    ),
    ("nan win rate", replace(EV, strategy_2x=replace(GOOD, win_rate=math.nan)), "win rate is nan"),
    ("nan drawdown", replace(EV, strategy_1x=replace(GOOD, max_drawdown=math.nan)), "max drawdown is nan"),
    ("nan exposure", replace(EV, strategy_2x=replace(GOOD, exposure=math.nan)), "exposure is nan"),
    (
        "inf cost drag",
        replace(EV, strategy_1x=replace(GOOD, cost_drag_bps_per_year=math.inf)),
        "cost drag is inf",
    ),
    ("inf bh cost drag", replace(EV, bh_2x=replace(BH, cost_drag_bps_per_year=math.inf)), "cost drag is inf"),
    ("nan dsr sr0'", replace(EV, dsr=replace(DSR_OK, sr0_conservative=math.nan)), "SR0' is nan"),
    # the boundaries count: 30 closed episodes, 250 returns
    (
        "win rate, 30 episodes",
        replace(EV, strategy_1x=replace(GOOD, win_rate=0.9, n_episodes_closed=30)),
        "win rate",
    ),
    (
        "profit factor, 30 episodes",
        replace(EV, strategy_1x=replace(GOOD, profit_factor=6.0, n_episodes_closed=30)),
        "profit factor",
    ),
    (
        "tiny drawdown, 250 returns",
        replace(EV, strategy_1x=replace(GOOD, max_drawdown=0.001, n_returns=250)),
        "too small to be real",
    ),
)


@pytest.mark.parametrize(("name", "ev", "text"), FLAG_CASES, ids=[c[0] for c in FLAG_CASES])
def test_each_flag_fires_alone_and_makes_the_verdict_suspicious(name: str, ev: Evidence, text: str) -> None:
    flags = sanity_flags(ev)
    assert flags and any(text in f for f in flags), (name, flags)
    assert all(f.isascii() for f in flags)
    v = verdict(compute_facts(ev), flags, synthetic=False)
    assert v.startswith(SUSPICIOUS)


NOT_FLAGGED: tuple[tuple[str, Evidence], ...] = (
    ("sharpe exactly 3", replace(EV, strategy_1x=replace(GOOD, sharpe=3.0), variant_sharpes=(3.0, 3.0))),
    ("drawdown exactly 2%", replace(EV, strategy_1x=replace(GOOD, max_drawdown=0.02))),
    ("tiny drawdown, short run", replace(EV, strategy_1x=replace(GOOD, max_drawdown=0.001, n_returns=249))),
    ("tiny drawdown, low exposure", replace(EV, strategy_1x=replace(GOOD, max_drawdown=0.001, exposure=0.2))),
    ("win rate exactly 80%", replace(EV, strategy_1x=replace(GOOD, win_rate=0.8))),
    ("win rate, few episodes", replace(EV, strategy_1x=replace(GOOD, win_rate=0.95, n_episodes_closed=29))),
    ("profit factor exactly 5", replace(EV, strategy_1x=replace(GOOD, profit_factor=5.0))),
    (
        "profit factor, few episodes",
        replace(EV, strategy_1x=replace(GOOD, profit_factor=9.0, n_episodes_closed=29)),
    ),
    ("oos equal to the best variant", replace(EV, variant_sharpes=(0.8, 0.5))),
    ("no variants", replace(EV, variant_sharpes=())),
    ("no oos sharpe", replace(EV, strategy_1x=replace(GOOD, sharpe=None), variant_sharpes=(None,))),
    ("no fills, no costs", replace(EV, bh_1x=replace(BH, n_fills=0, cost_drag_bps_per_year=0.0))),
    (
        "missing numbers",
        replace(EV, strategy_1x=replace(GOOD, win_rate=None, profit_factor=None), boot_2x=None),
    ),
)


@pytest.mark.parametrize(("name", "ev"), NOT_FLAGGED, ids=[c[0] for c in NOT_FLAGGED])
def test_boundaries_and_missing_numbers_raise_no_flag(name: str, ev: Evidence) -> None:
    assert sanity_flags(ev) == (), name


def test_finite_metrics_raise_no_non_finite_flag() -> None:
    # The good evidence, every metric finite or None: no "not a finite number" flag.
    ev = replace(EV, strategy_1x=replace(GOOD, win_rate=None, profit_factor=None))
    assert not any("finite" in f for f in sanity_flags(ev))


def test_every_flag_is_reported_not_just_the_first() -> None:
    ev = replace(
        EV,
        strategy_1x=replace(GOOD, sharpe=4.0, win_rate=0.9, profit_factor=8.0, max_drawdown=0.01),
        r_hard_stops=1,
    )
    flags = sanity_flags(ev)
    for text in ("above 3", "win rate", "profit factor", "too small", "above every variant", "hard stop"):
        assert any(text in f for f in flags), text
    assert verdict(compute_facts(ev), flags, synthetic=False) == f"{SUSPICIOUS} ({len(flags)} sanity flags)"


# ------------------------------------------------------------------------------ the verdict
def fact(number: int, state: FactState) -> Fact:
    return Fact(number=number, title=f"fact {number} title", state=state, lines=("x",))


def expected_verdict(four: tuple[FactState, ...], flagged: bool, synthetic: bool) -> str:
    if synthetic:
        return PLUMBING_ONLY
    if flagged:
        return f"{SUSPICIOUS} (1 sanity flag)"
    if four == (PASS, PASS, PASS, PASS):
        return CANDIDATE
    if (four[0], four[1], four[3]) == (PASS, PASS, PASS) and four[2] is NOT_RUN:
        return PROMISING
    for n, s in enumerate(four, start=1):
        if s is PASS or (n == 3 and s is NOT_RUN):
            continue
        return f"{NO_EDGE}: fact {n} (fact {n} title) is {s.value}"
    raise AssertionError("unreachable")


def test_verdict_truth_table_over_every_state_combination() -> None:
    combos = 0
    for four in itertools.product(list(FactState), repeat=4):
        facts = tuple(fact(n, s) for n, s in enumerate(four, start=1))
        for flagged, synthetic in itertools.product((False, True), repeat=2):
            flags = ("a flag",) if flagged else ()
            got = verdict(facts, flags, synthetic=synthetic)
            assert got == expected_verdict(four, flagged, synthetic), (four, flagged, synthetic)
            assert got.isascii()
            combos += 1
    assert combos == 7**4 * 4


@pytest.mark.parametrize(
    ("four", "text"),
    [
        ((PASS, PASS, PASS, PASS), "CANDIDATE: next: paper trading (M5); not proof of an edge"),
        ((PASS, PASS, NOT_RUN, PASS), "PROMISING IN RESEARCH: freeze the design, then run the holdout once"),
        ((FAIL, FAIL, NOT_RUN, FAIL), "NO EDGE (as tested): fact 1 (fact 1 title) is FAIL"),
        ((PASS, INCONCLUSIVE, NOT_RUN, PASS), "NO EDGE (as tested): fact 2 (fact 2 title) is INCONCLUSIVE"),
        ((PASS, PASS, NOT_RUN, WEAK), "NO EDGE (as tested): fact 4 (fact 4 title) is WEAK"),
        ((PASS, PASS, NOT_RUN, UNKNOWN), "NO EDGE (as tested): fact 4 (fact 4 title) is UNKNOWN"),
        ((PASS, PASS, FAIL, PASS), "NO EDGE (as tested): fact 3 (fact 3 title) is FAIL"),
    ],
)
def test_verdict_texts(four: tuple[FactState, ...], text: str) -> None:
    facts = tuple(fact(n, s) for n, s in enumerate(four, start=1))
    assert verdict(facts, (), synthetic=False) == text


def test_verdict_names_the_flag_count() -> None:
    facts = tuple(fact(n, PASS) for n in range(1, 5))
    assert verdict(facts, ("a", "b"), synthetic=False) == f"{SUSPICIOUS} (2 sanity flags)"
    assert SUSPICIOUS == "SUSPICIOUS: hunt for a bug or leakage first"
    assert PLUMBING_ONLY == "PLUMBING ONLY: NOT EVIDENCE"


@pytest.mark.parametrize("numbers", [(1, 2, 3), (1, 2, 4, 3), (2, 1, 3, 4), (1, 2, 3, 4, 5)])
def test_verdict_needs_the_four_facts_in_order(numbers: tuple[int, ...]) -> None:
    with pytest.raises(ValueError, match="facts 1 to 4"):
        verdict(tuple(fact(n, PASS) for n in numbers), (), synthetic=False)


def test_end_to_end_no_edge_for_a_weak_strategy() -> None:
    weak = replace(
        EV,
        random_1x=replace(RANDOM_OK, p_value=0.3),
        boot_1x=0.4,
        dsr=dsr(used=0.3, sr=0.01, sr0c=0.03),
    )
    facts = compute_facts(weak)
    assert states(weak) == (FAIL, PASS, NOT_RUN, FAIL)
    assert verdict(facts, sanity_flags(weak), synthetic=False).startswith(f"{NO_EDGE}: fact 1 ")
