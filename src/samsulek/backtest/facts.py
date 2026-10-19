"""The four facts a study reports, the sanity flags and the verdict (M3 skeleton; WP6a fills it in).

1. Beats random entries AND buy-and-hold, risk-adjusted; 2. survives 2x costs; 3. one
holdout run passed its pre-registered acceptance; 4. the deflated Sharpe over ALL trials.
Criteria are fixed here (thresholds are owner questions). Any sanity flag (Sharpe above
3, tiny drawdowns, unrealistic win rates...) makes the verdict SUSPICIOUS: hunt for a bug
first. Synthetic (S-) studies are never evidence: every fact is NOT_EVIDENCE and the
verdict says PLUMBING ONLY.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum

from samsulek.backtest.stats import DsrResult, RandomComparison
from samsulek.backtest.types import Metrics


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


def compute_facts(ev: Evidence) -> tuple[Fact, Fact, Fact, Fact]:
    raise NotImplementedError("WP6a")


def sanity_flags(ev: Evidence) -> tuple[str, ...]:
    raise NotImplementedError("WP6a")


def verdict(facts: Sequence[Fact], flags: Sequence[str], *, synthetic: bool) -> str:
    raise NotImplementedError("WP6a")
