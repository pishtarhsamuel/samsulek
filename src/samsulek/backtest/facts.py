"""The four facts a study reports, the sanity flags and the verdict (spec section 7.5).

Facts relied on:
- The facts are judged on the R-mode walk-forward out-of-sample runs. Thresholds are owner
  questions and each lives in one constant below.
  1. Beats random entries AND buy-and-hold, risk-adjusted: PASS iff the random-entry
     p-value is <= 0.05 AND the bootstrap probability that the strategy's Sharpe ratio is
     above buy-and-hold's is >= 0.90 (a missing probability is not a pass).
  2. Survives 2x costs: fact 1 recomputed on the 2x runs AND the 2x Sharpe ratio > 0.
     Facts 1 and 2 are INCONCLUSIVE (never PASS) with fewer than 3 folds, 756
     out-of-sample sessions, 10 closed episodes or 200 random seeds, and FAIL whenever an
     R-mode strategy run hit the hard stop (a 50% day or a 90% drawdown).
  3. One holdout run: NOT_RUN until a holdout is claimed; then PASS or FAIL by its
     pre-registered acceptance.
  4. Deflated Sharpe over ALL trials: PASS iff ``used >= 0.95``; WEAK if the Sharpe ratio
     only beats the conservative SR0'; UNKNOWN without a deflated Sharpe; FAIL otherwise.
- Synthetic (S-) studies are never evidence: every fact is NOT_EVIDENCE (its numbers are
  still shown, to check the plumbing) and the verdict is PLUMBING ONLY.
- Any sanity flag (a Sharpe ratio above 3, a tiny drawdown, an unrealistic win rate or
  profit factor, an out-of-sample Sharpe above every variant's, costs that cost nothing,
  an R-mode hard stop, a number that is not finite) makes the verdict SUSPICIOUS: a result
  that looks too good is presumed a bug or leakage until it is hunted down.
- A missing number (None) never passes a threshold and never raises a flag on its own;
  a non-finite number (NaN or an infinity) never passes either and raises its own flag.
- All text is ASCII.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Final

from samsulek.backtest.metrics import PERIODS_PER_YEAR
from samsulek.backtest.stats import DsrResult, RandomComparison
from samsulek.backtest.types import Metrics

# ------------------------------------------------------------------ thresholds (owner questions)
RANDOM_P_MAX: Final = 0.05  # fact 1: p-value against the random-entry seeds
BOOTSTRAP_P_MIN: Final = 0.90  # fact 1: P(Sharpe strategy > Sharpe buy-and-hold)
DSR_MIN: Final = 0.95  # fact 4: the deflated Sharpe probability used
MIN_FOLDS: Final = 3
MIN_OOS_SESSIONS: Final = 756  # about 3 years
MIN_CLOSED_EPISODES: Final = 10
MIN_SEEDS: Final = 200
# ------------------------------------------------------------------ sanity flags
SUSPICIOUS_SHARPE: Final = 3.0
SUSPICIOUS_MAX_DRAWDOWN: Final = 0.02  # with at least 250 returns and exposure above 20%
DRAWDOWN_MIN_RETURNS: Final = 250
DRAWDOWN_MIN_EXPOSURE: Final = 0.20
SUSPICIOUS_WIN_RATE: Final = 0.80  # with at least 30 closed episodes
SUSPICIOUS_PROFIT_FACTOR: Final = 5.0  # with at least 30 closed episodes
RATES_MIN_EPISODES: Final = 30
# ------------------------------------------------------------------ verdicts
PLUMBING_ONLY: Final = "PLUMBING ONLY: NOT EVIDENCE"
SUSPICIOUS: Final = "SUSPICIOUS: hunt for a bug or leakage first"
CANDIDATE: Final = "CANDIDATE: next: paper trading (M5); not proof of an edge"
PROMISING: Final = "PROMISING IN RESEARCH: freeze the design, then run the holdout once"
NO_EDGE: Final = "NO EDGE (as tested)"

TITLES: Final = (
    "Beats random entries and buy-and-hold, risk-adjusted (walk-forward, out of sample)",
    "Survives 2x costs",
    "One holdout run, accepted by its pre-registered rule",
    "Deflated Sharpe over all trials",
)
_SYNTHETIC_LINE: Final = "synthetic data: plumbing only, never evidence (the numbers check the pipeline)"
_HARD_STOP_LINE: Final = "FAIL: an R-mode strategy run hit the hard stop (a 50% day or a 90% drawdown)"


class FactState(StrEnum):
    PASS = "PASS"  # noqa: S105 (a fact state, not a password)
    FAIL = "FAIL"
    WEAK = "WEAK"
    INCONCLUSIVE = "INCONCLUSIVE"
    NOT_RUN = "NOT_RUN"
    UNKNOWN = "UNKNOWN"
    NOT_EVIDENCE = "NOT_EVIDENCE"


@dataclass(frozen=True, slots=True)
class Fact:
    number: int
    title: str
    state: FactState
    lines: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class HoldoutOutcome:
    accepted: bool
    lines: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Evidence:
    """What the facts are judged on (R mode; out-of-sample unless the name says otherwise).

    ``variant_sharpes`` are the variants' full-period R/1x annualised Sharpe ratios, in
    variant order; ``r_hard_stops`` counts the R-mode strategy runs that ended on the hard
    stop; ``n_seeds`` is the number of random-entry seeds run at each cost level.
    """

    synthetic: bool
    n_oos: int
    n_folds: int
    n_seeds: int
    strategy_1x: Metrics
    strategy_2x: Metrics
    bh_1x: Metrics
    bh_2x: Metrics
    random_1x: RandomComparison
    random_2x: RandomComparison
    boot_1x: float | None
    boot_2x: float | None
    dsr: DsrResult | None
    variant_sharpes: tuple[float | None, ...]
    r_hard_stops: int
    holdout: HoldoutOutcome | None


def _num(x: float | None, digits: int = 2) -> str:
    return "n/a" if x is None else f"{x:.{digits}f}"


# A missing or non-finite number never passes a threshold (NaN compares false, but an
# infinite p-value or probability is a bug, not a pass); infinities raise their own flag.
def _le(x: float | None, limit: float) -> bool:
    return x is not None and math.isfinite(x) and x <= limit


def _ge(x: float | None, limit: float) -> bool:
    return x is not None and math.isfinite(x) and x >= limit


def _gt(x: float | None, limit: float) -> bool:
    return x is not None and math.isfinite(x) and x > limit


def _annual(per_period: float | None) -> float | None:
    return None if per_period is None else per_period * math.sqrt(PERIODS_PER_YEAR)


def _too_little_evidence(ev: Evidence, strategy: Metrics, seeds: RandomComparison) -> list[str]:
    reasons: list[str] = []
    if ev.n_folds < MIN_FOLDS:
        reasons.append(f"only {ev.n_folds} walk-forward fold(s); needs at least {MIN_FOLDS}")
    if ev.n_oos < MIN_OOS_SESSIONS:
        reasons.append(f"only {ev.n_oos} out-of-sample sessions; needs at least {MIN_OOS_SESSIONS}")
    if strategy.n_episodes_closed < MIN_CLOSED_EPISODES:
        reasons.append(
            f"only {strategy.n_episodes_closed} closed episode(s); needs at least {MIN_CLOSED_EPISODES}"
        )
    n_seeds = min(ev.n_seeds, seeds.n)
    if n_seeds < MIN_SEEDS:
        reasons.append(f"only {n_seeds} random-entry seed(s); needs at least {MIN_SEEDS}")
    return reasons


def _beats_baselines(
    ev: Evidence,
    *,
    number: int,
    strategy: Metrics,
    bh: Metrics,
    seeds: RandomComparison,
    boot: float | None,
    cost: str,
    needs_positive_sharpe: bool,
) -> Fact:
    lines = [
        f"{cost}: random entries p = {seeds.p_value:.3f} (PASS needs <= {RANDOM_P_MAX}); strategy Sharpe "
        f"{_num(strategy.sharpe)} vs the {seeds.n} seeds' median {_num(seeds.median)} "
        f"(5%: {_num(seeds.q05)}, 95%: {_num(seeds.q95)})",
        f"{cost}: P(strategy Sharpe > buy-and-hold Sharpe) = {_num(boot, 3)} (PASS needs >= "
        f"{BOOTSTRAP_P_MIN}); buy-and-hold Sharpe {_num(bh.sharpe)}",
    ]
    passed = _le(seeds.p_value, RANDOM_P_MAX) and _ge(boot, BOOTSTRAP_P_MIN)
    if needs_positive_sharpe:
        lines.append(f"{cost}: strategy Sharpe {_num(strategy.sharpe)} (PASS needs > 0)")
        passed = passed and _gt(strategy.sharpe, 0.0)
    reasons = _too_little_evidence(ev, strategy, seeds)
    if ev.r_hard_stops > 0:
        state = FactState.FAIL
        lines.append(_HARD_STOP_LINE)
    elif reasons:
        state = FactState.INCONCLUSIVE
        lines.extend(f"not enough evidence: {r}" for r in reasons)
    else:
        state = FactState.PASS if passed else FactState.FAIL
    return Fact(number=number, title=TITLES[number - 1], state=state, lines=tuple(lines))


def _holdout_fact(ev: Evidence) -> Fact:
    outcome = ev.holdout
    if outcome is None:
        state = FactState.NOT_RUN
        lines: tuple[str, ...] = (
            "not run yet: the holdout runs once per family and strategy, after the design is frozen",
        )
    else:
        state = FactState.PASS if outcome.accepted is True else FactState.FAIL
        lines = tuple(outcome.lines) or (("accepted" if state is FactState.PASS else "not accepted"),)
    return Fact(number=3, title=TITLES[2], state=state, lines=lines)


def _dsr_fact(ev: Evidence) -> Fact:
    d = ev.dsr
    if d is None:
        return Fact(
            number=4,
            title=TITLES[3],
            state=FactState.UNKNOWN,
            lines=("no deflated Sharpe: the out-of-sample returns have no Sharpe ratio (flat or too short)",),
        )
    if d.used is None or not math.isfinite(d.used):
        return Fact(
            number=4,
            title=TITLES[3],
            state=FactState.UNKNOWN,
            lines=(f"no deflated Sharpe probability ({d.note})",),
        )
    lines = (
        f"DSR used = {d.used:.3f} (PASS needs >= {DSR_MIN}), the lower of {_num(d.dsr, 3)} and the "
        f"conservative {_num(d.dsr_conservative, 3)}",
        f"Sharpe {_num(_annual(d.stats.sr))} vs SR0 {_num(_annual(d.sr0))} and SR0' "
        f"{_num(_annual(d.sr0_conservative))} (annualised) over N = {d.n_trials} trials, "
        f"V from {d.n_completed} completed",
        d.note,
    )
    if d.used >= DSR_MIN:
        state = FactState.PASS
    elif d.sr0_conservative is not None and d.stats.sr > d.sr0_conservative:
        state = FactState.WEAK
    else:
        state = FactState.FAIL
    return Fact(number=4, title=TITLES[3], state=state, lines=lines)


def compute_facts(ev: Evidence) -> tuple[Fact, Fact, Fact, Fact]:
    one, two, three, four = (
        _beats_baselines(
            ev,
            number=1,
            strategy=ev.strategy_1x,
            bh=ev.bh_1x,
            seeds=ev.random_1x,
            boot=ev.boot_1x,
            cost="1x costs",
            needs_positive_sharpe=False,
        ),
        _beats_baselines(
            ev,
            number=2,
            strategy=ev.strategy_2x,
            bh=ev.bh_2x,
            seeds=ev.random_2x,
            boot=ev.boot_2x,
            cost="2x costs",
            needs_positive_sharpe=True,
        ),
        _holdout_fact(ev),
        _dsr_fact(ev),
    )
    if not ev.synthetic:
        return one, two, three, four
    return _not_evidence(one), _not_evidence(two), _not_evidence(three), _not_evidence(four)


def _not_evidence(fact: Fact) -> Fact:
    return replace(fact, state=FactState.NOT_EVIDENCE, lines=(_SYNTHETIC_LINE, *fact.lines))


def _not_finite(name: str, x: float | None) -> list[str]:
    if x is None or math.isfinite(x):
        return []
    return [f"{name} is {x!r}, not a finite number (a bug)"]


def sanity_flags(ev: Evidence) -> tuple[str, ...]:
    """Every reason to distrust the result before believing it (empty when none)."""
    flags: list[str] = []
    runs = (("strategy at 1x", ev.strategy_1x), ("strategy at 2x", ev.strategy_2x))
    for name, m in runs:
        if _gt(m.sharpe, SUSPICIOUS_SHARPE):
            flags.append(
                f"{name}: Sharpe {m.sharpe:.2f} is above {SUSPICIOUS_SHARPE:g} (presumed a bug or leakage)"
            )
    for i, s in enumerate(ev.variant_sharpes):
        if _gt(s, SUSPICIOUS_SHARPE):
            flags.append(f"variant {i:03d}: full-period Sharpe {s:.2f} is above {SUSPICIOUS_SHARPE:g}")
    for name, m in runs:
        if (
            m.n_returns >= DRAWDOWN_MIN_RETURNS
            and m.exposure > DRAWDOWN_MIN_EXPOSURE
            and m.max_drawdown < SUSPICIOUS_MAX_DRAWDOWN
        ):
            flags.append(
                f"{name}: max drawdown {m.max_drawdown:.2%} over {m.n_returns} sessions at "
                f"{m.exposure:.0%} exposure is too small to be real"
            )
        if m.n_episodes_closed >= RATES_MIN_EPISODES and _gt(m.win_rate, SUSPICIOUS_WIN_RATE):
            flags.append(f"{name}: win rate {m.win_rate:.0%} over {m.n_episodes_closed} closed episodes")
        if m.n_episodes_closed >= RATES_MIN_EPISODES and _gt(m.profit_factor, SUSPICIOUS_PROFIT_FACTOR):
            flags.append(
                f"{name}: profit factor {m.profit_factor:.2f} over {m.n_episodes_closed} closed episodes"
            )
    oos = ev.strategy_1x.sharpe
    if (
        oos is not None
        and ev.variant_sharpes
        and all(v is None or (math.isfinite(oos) and v < oos) for v in ev.variant_sharpes)
    ):
        flags.append(
            f"the out-of-sample Sharpe {oos:.2f} is above every variant's full-period Sharpe "
            "(selection should not beat hindsight)"
        )
    for name, m in (*runs, ("buy-and-hold at 1x", ev.bh_1x), ("buy-and-hold at 2x", ev.bh_2x)):
        if m.n_fills > 0 and not m.cost_drag_bps_per_year > 0:
            flags.append(
                f"{name}: {m.n_fills} fills cost nothing (cost drag {m.cost_drag_bps_per_year!r} bps)"
            )
    if ev.r_hard_stops > 0:
        flags.append(
            f"{ev.r_hard_stops} R-mode strategy run(s) hit the hard stop: a catastrophic strategy or a bug"
        )
    # Every number a flag or a fact reads: a threshold test on NaN or an infinity would
    # silently say "nothing to flag", so a non-finite value is a flag of its own.
    per_run = tuple(
        (f"{name}'s {what}", x)
        for name, m in runs
        for what, x in (
            ("max drawdown", m.max_drawdown),
            ("exposure", m.exposure),
            ("win rate", m.win_rate),
            ("profit factor", m.profit_factor),
            ("cost drag", m.cost_drag_bps_per_year),
        )
    )
    for name, x in (
        ("the strategy Sharpe at 1x", ev.strategy_1x.sharpe),
        ("the strategy Sharpe at 2x", ev.strategy_2x.sharpe),
        ("the buy-and-hold Sharpe at 1x", ev.bh_1x.sharpe),
        ("the buy-and-hold Sharpe at 2x", ev.bh_2x.sharpe),
        *per_run,
        ("buy-and-hold at 1x's cost drag", ev.bh_1x.cost_drag_bps_per_year),
        ("buy-and-hold at 2x's cost drag", ev.bh_2x.cost_drag_bps_per_year),
        ("the random-entry p-value at 1x", ev.random_1x.p_value),
        ("the random-entry p-value at 2x", ev.random_2x.p_value),
        ("the bootstrap probability at 1x", ev.boot_1x),
        ("the bootstrap probability at 2x", ev.boot_2x),
        ("the deflated Sharpe used", None if ev.dsr is None else ev.dsr.used),
        ("the deflated Sharpe's per-session Sharpe", None if ev.dsr is None else ev.dsr.stats.sr),
        ("the deflated Sharpe's SR0'", None if ev.dsr is None else ev.dsr.sr0_conservative),
        *((f"variant {i:03d}'s Sharpe", s) for i, s in enumerate(ev.variant_sharpes)),
    ):
        flags.extend(_not_finite(name, x))
    return tuple(flags)


def verdict(facts: Sequence[Fact], flags: Sequence[str], *, synthetic: bool) -> str:
    """One line: what the study shows, most cautious reading first."""
    if [f.number for f in facts] != [1, 2, 3, 4]:
        raise ValueError(f"a verdict needs facts 1 to 4 in order, got {[f.number for f in facts]}")
    if synthetic:
        return PLUMBING_ONLY
    if flags:
        return f"{SUSPICIOUS} ({len(flags)} sanity flag{'' if len(flags) == 1 else 's'})"
    one, two, three, four = (f.state for f in facts)
    if all(s is FactState.PASS for s in (one, two, three, four)):
        return CANDIDATE
    if all(s is FactState.PASS for s in (one, two, four)) and three is FactState.NOT_RUN:
        return PROMISING
    failing = [
        f
        for f in facts
        if f.state is not FactState.PASS and not (f.number == 3 and f.state is FactState.NOT_RUN)
    ]
    first = failing[0]
    return f"{NO_EDGE}: fact {first.number} ({first.title}) is {first.state.value}"
