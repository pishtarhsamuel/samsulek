"""Memecoin cost components: pure on-chain math, no simulator yet (M3 skeleton; WP2 fills it in).

Integer math exactly as on-chain: constant-product output with the LP fee on the input,
bonding-curve buys and sells on virtual reserves (``GraduatedCurveError`` once the curve
is complete, because graduation moves the pool), a ``min_out`` slippage cap (a failed
transaction still pays its fees), base fee 5,000 lamports per signature plus a priority
fee sampled from recorded compute-unit prices, and a seeded failure model. The cost
multiplier (2x) doubles fee rates, the priority fee and the failure probability. Every
fee value is a required parameter, UNVERIFIED until checked against the venues' docs.
The memecoin simulator itself is M4; studies are refused by the holdout fence until then.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from decimal import Decimal


def cp_amount_out(amount_in: int, reserve_in: int, reserve_out: int, fee_bps: int) -> int:
    raise NotImplementedError("WP2")


def cp_amount_in(amount_out: int, reserve_in: int, reserve_out: int, fee_bps: int) -> int:
    raise NotImplementedError("WP2")


def impact_bps(amount_in: int, reserve_in: int, reserve_out: int, fee_bps: int) -> Decimal:
    raise NotImplementedError("WP2")


class GraduatedCurveError(ValueError):
    """The bonding curve is complete: the token trades on a different pool now."""


@dataclass(frozen=True, slots=True)
class CurveState:
    virtual_quote: int
    virtual_token: int
    real_token: int
    complete: bool


def bonding_curve_buy(state: CurveState, quote_in: int, fee_bps: int) -> int:
    raise NotImplementedError("WP2")


def bonding_curve_sell(state: CurveState, token_in: int, fee_bps: int) -> int:
    raise NotImplementedError("WP2")


@dataclass(frozen=True, slots=True)
class PriorityFeeModel:
    cu_price_micro_lamports: tuple[int, ...]  # recorded compute-unit prices to sample from
    compute_units: int
    base_fee_lamports: int = 5000

    def sample_lamports(self, rng: random.Random, multiplier: int) -> int:
        raise NotImplementedError("WP2")


@dataclass(frozen=True, slots=True)
class TxOutcome:
    landed: bool
    attempts: int
    fees_lamports: int


@dataclass(frozen=True, slots=True)
class FailureModel:
    p_fail: float  # per attempt, times the multiplier, capped at 0.95
    max_attempts: int

    def simulate(self, rng: random.Random, multiplier: int, fee: PriorityFeeModel) -> TxOutcome:
        raise NotImplementedError("WP2")


def min_out(expected_out: int, max_slippage_bps: int) -> int:
    raise NotImplementedError("WP2")


def sol_eur(price_usd: Decimal, price_native: Decimal, usd_per_eur: Decimal) -> Decimal:
    raise NotImplementedError("WP2")
