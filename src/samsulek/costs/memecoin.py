"""Memecoin cost components: pure on-chain math, no simulator yet (M3; the simulator is M4).

Integer math, as on-chain programs do it (amounts in the smallest unit: lamports, token
base units), with every rounding in the venue's favour, never the trader's. ``fee_bps``
is the TOTAL fee the venue takes on that leg (LP, protocol and creator fees, summed by
the caller):
- Constant-product swap with the LP fee taken from the input, rounded the way the
  Raydium AMM does it as far as we know (other venues round slightly differently):
  ``fee = ceil(in x fee_bps / 10_000)``, ``net = in - fee``,
  ``out = floor(net x reserve_out / (reserve_in + net))``. ``cp_amount_in`` is its exact
  inverse: the smallest input whose output reaches the target.
- Bonding curve (pump.fun style) on virtual reserves: the same constant-product formula
  on ``(virtual_quote, virtual_token)``, fees always in the quote currency (SOL): taken
  from the input on a buy (slightly pessimistic if the venue charges its fee on the net
  amount), from the output on a sell. A buy can never take more than the curve's real
  token reserve (the whole input is still spent: pessimistic). Once the curve is complete
  it raises ``GraduatedCurveError``: the token then trades on a different pool
  (graduation moves it), so a price from the old curve would be fiction.
- ``min_out``: the slippage cap of a swap (the transaction fails below it, and a failed
  transaction still pays its fees).
- Fees per transaction attempt: the base fee per signature plus a priority fee, sampled
  from recorded compute-unit prices: ``ceil(cu_price_micro_lamports x compute_units /
  1_000_000)`` lamports, paid on the requested compute-unit limit (one signature assumed).
- A seeded failure model: each attempt fails with probability ``p_fail x m`` (capped at
  0.95) and pays its fees whether it lands or not. ``p_fail`` itself must be at most 0.95,
  so the cap never lowers a rate the caller gave.
- ``sol_eur``: the SOL price in EUR from a token's USD and SOL prices and the ECB rate.

The cost multiplier ``m`` (1 or 2) doubles the priority fee and the failure probability
here; the caller doubles fee rates (``fee_bps``) and halves pool reserves for the 2x
rerun. Every fee value is a required parameter, UNVERIFIED until checked against the
pump.fun, PumpSwap, Raydium and Solana docs (the rounding convention above included);
nothing here defaults to a fee, not even Solana's base fee of 5,000 lamports per
signature (``PriorityFeeModel.base_fee_lamports`` must be passed). Every input is
checked: a bool, a negative amount or an out-of-range rate raises ``ValueError`` (fail
closed, never a silent wrong price).
Randomness comes only from the ``random.Random`` passed in, so results are reproducible.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from typing import Final

BPS_INT: Final = 10_000
MICRO_LAMPORTS_PER_LAMPORT: Final = 1_000_000
MAX_P_FAIL: Final = 0.95
COST_MULTIPLIERS: Final = (1, 2)


def _int(name: str, value: object, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an int, got {value!a}")
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {value}")
    return value


def _fee_bps(value: object) -> int:
    fee = _int("fee_bps", value, minimum=0)
    if fee >= BPS_INT:
        raise ValueError(f"fee_bps must be below {BPS_INT}, got {fee}")
    return fee


def _multiplier(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value not in COST_MULTIPLIERS:
        raise ValueError(f"cost multiplier must be 1 or 2, got {value!a}")
    return value


def _ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def _fee_on(amount: int, fee_bps: int) -> int:
    """The fee on ``amount``, rounded up (in the venue's favour)."""
    return _ceil_div(amount * fee_bps, BPS_INT)


def _swap_out(net_in: int, reserve_in: int, reserve_out: int) -> int:
    return net_in * reserve_out // (reserve_in + net_in)


def cp_amount_out(amount_in: int, reserve_in: int, reserve_out: int, fee_bps: int) -> int:
    """Output of a constant-product swap, LP fee taken from the input (rounded up)."""
    _int("amount_in", amount_in, minimum=0)
    _int("reserve_in", reserve_in, minimum=1)
    _int("reserve_out", reserve_out, minimum=1)
    fee = _fee_bps(fee_bps)
    return _swap_out(amount_in - _fee_on(amount_in, fee), reserve_in, reserve_out)


def cp_amount_in(amount_out: int, reserve_in: int, reserve_out: int, fee_bps: int) -> int:
    """The smallest input whose ``cp_amount_out`` is at least ``amount_out``."""
    _int("amount_out", amount_out, minimum=0)
    _int("reserve_in", reserve_in, minimum=1)
    _int("reserve_out", reserve_out, minimum=1)
    fee = _fee_bps(fee_bps)
    if amount_out >= reserve_out:
        raise ValueError(f"cannot take {amount_out} out of a pool holding {reserve_out}")
    if amount_out == 0:
        return 0
    net = _ceil_div(amount_out * reserve_in, reserve_out - amount_out)
    # The gross input whose fee-adjusted amount (gross - ceil(gross x fee / BPS)) reaches net.
    return _ceil_div(net * BPS_INT, BPS_INT - fee)


def impact_bps(amount_in: int, reserve_in: int, reserve_out: int, fee_bps: int) -> Decimal:
    """Shortfall of the swap's output against the spot-price output, in bps (fee and rounding included)."""
    _int("amount_in", amount_in, minimum=1)
    out = cp_amount_out(amount_in, reserve_in, reserve_out, fee_bps)
    shortfall = 1 - Fraction(out * reserve_in, amount_in * reserve_out)
    return Decimal(shortfall.numerator * BPS_INT) / Decimal(shortfall.denominator)


class GraduatedCurveError(ValueError):
    """The bonding curve is complete: the token trades on a different pool now."""


@dataclass(frozen=True, slots=True)
class CurveState:
    virtual_quote: int
    virtual_token: int
    real_token: int
    complete: bool

    def __post_init__(self) -> None:
        _int("virtual_quote", self.virtual_quote, minimum=1)
        _int("virtual_token", self.virtual_token, minimum=1)
        _int("real_token", self.real_token, minimum=0)
        if self.real_token > self.virtual_token:
            raise ValueError(
                f"real_token ({self.real_token}) cannot exceed virtual_token ({self.virtual_token})"
            )
        if not isinstance(self.complete, bool):
            raise ValueError(f"complete must be a bool, got {self.complete!a}")


def _require_open(state: CurveState) -> None:
    if state.complete:
        raise GraduatedCurveError("the bonding curve is complete: the token now trades on another pool")


def bonding_curve_buy(state: CurveState, quote_in: int, fee_bps: int) -> int:
    """Tokens bought with ``quote_in`` (fee taken from it), at most the curve's real tokens."""
    _require_open(state)
    _int("quote_in", quote_in, minimum=0)
    fee = _fee_bps(fee_bps)
    tokens = _swap_out(quote_in - _fee_on(quote_in, fee), state.virtual_quote, state.virtual_token)
    return min(tokens, state.real_token)


def bonding_curve_sell(state: CurveState, token_in: int, fee_bps: int) -> int:
    """Quote (SOL) received for ``token_in``, after the fee taken from the output."""
    _require_open(state)
    _int("token_in", token_in, minimum=0)
    fee = _fee_bps(fee_bps)
    gross = _swap_out(token_in, state.virtual_token, state.virtual_quote)
    return gross - _fee_on(gross, fee)


@dataclass(frozen=True, slots=True)
class PriorityFeeModel:
    cu_price_micro_lamports: tuple[int, ...]  # recorded compute-unit prices to sample from
    compute_units: int  # the compute-unit LIMIT the transaction requests (the fee is paid on it)
    base_fee_lamports: int  # per signature; required, like every fee value (UNVERIFIED)

    def __post_init__(self) -> None:
        if not isinstance(self.cu_price_micro_lamports, tuple) or not self.cu_price_micro_lamports:
            raise ValueError("cu_price_micro_lamports must be a non-empty tuple of recorded prices")
        for i, price in enumerate(self.cu_price_micro_lamports):
            _int(f"cu_price_micro_lamports[{i}]", price, minimum=0)
        _int("compute_units", self.compute_units, minimum=1)
        _int("base_fee_lamports", self.base_fee_lamports, minimum=0)

    def sample_lamports(self, rng: random.Random, multiplier: int) -> int:
        """One attempt's fee: base fee plus ``m`` times a sampled priority fee (lamports)."""
        m = _multiplier(multiplier)
        price = rng.choice(self.cu_price_micro_lamports)
        priority = _ceil_div(price * self.compute_units, MICRO_LAMPORTS_PER_LAMPORT)
        return self.base_fee_lamports + m * priority


@dataclass(frozen=True, slots=True)
class TxOutcome:
    landed: bool
    attempts: int
    fees_lamports: int


@dataclass(frozen=True, slots=True)
class FailureModel:
    p_fail: float  # per attempt, 0..0.95; times the multiplier, capped at 0.95
    max_attempts: int

    def __post_init__(self) -> None:
        if isinstance(self.p_fail, bool) or not isinstance(self.p_fail, int | float):
            raise ValueError(f"p_fail must be a number, got {self.p_fail!a}")
        # At most the cap, so the cap only ever bites on the doubled rate: a higher p_fail at
        # 1x would be silently lowered to 0.95 (an optimistic repair). Also refuses NaN.
        if not 0.0 <= self.p_fail <= MAX_P_FAIL:
            raise ValueError(f"p_fail must be between 0 and {MAX_P_FAIL}, got {self.p_fail}")
        _int("max_attempts", self.max_attempts, minimum=1)

    def simulate(self, rng: random.Random, multiplier: int, fee: PriorityFeeModel) -> TxOutcome:
        """Send until one attempt lands or ``max_attempts`` are used. Every attempt pays its fee.

        Per attempt the fee is drawn first, then the failure; the same seed always gives the
        same outcome.
        """
        m = _multiplier(multiplier)
        p = min(self.p_fail * m, MAX_P_FAIL)
        fees = 0
        for attempt in range(1, self.max_attempts + 1):
            fees += fee.sample_lamports(rng, m)
            if rng.random() >= p:
                return TxOutcome(landed=True, attempts=attempt, fees_lamports=fees)
        return TxOutcome(landed=False, attempts=self.max_attempts, fees_lamports=fees)


def min_out(expected_out: int, max_slippage_bps: int) -> int:
    """The least output a swap may accept: ``floor(expected x (1 - bps/10_000))``."""
    _int("expected_out", expected_out, minimum=0)
    bps = _int("max_slippage_bps", max_slippage_bps, minimum=0)
    if bps > BPS_INT:
        raise ValueError(f"max_slippage_bps must be at most {BPS_INT}, got {bps}")
    return expected_out * (BPS_INT - bps) // BPS_INT


def sol_eur(price_usd: Decimal, price_native: Decimal, usd_per_eur: Decimal) -> Decimal:
    """EUR per SOL: ``(price_usd / price_native) / usd_per_eur`` (a token's USD and SOL prices, ECB rate)."""
    for name, value in (
        ("price_usd", price_usd),
        ("price_native", price_native),
        ("usd_per_eur", usd_per_eur),
    ):
        if not isinstance(value, Decimal) or not value.is_finite() or value <= 0:
            raise ValueError(f"{name} must be a finite Decimal > 0, got {value!a}")
    return (price_usd / price_native) / usd_per_eur
