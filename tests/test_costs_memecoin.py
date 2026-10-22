"""Memecoin cost math (costs/memecoin.py): hand-computed vectors, exact inverses, fail-closed inputs.

Every expected number below is worked out in the comment next to it from the documented
formula, independently of the code. Rounding is always in the venue's favour: fees round
UP, outputs round DOWN. Trap 20 (M3 part): a complete bonding curve refuses to quote.
"""

from __future__ import annotations

import random
from collections import Counter
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from samsulek.costs.memecoin import (
    MAX_P_FAIL,
    CurveState,
    FailureModel,
    GraduatedCurveError,
    PriorityFeeModel,
    TxOutcome,
    bonding_curve_buy,
    bonding_curve_sell,
    cp_amount_in,
    cp_amount_out,
    impact_bps,
    min_out,
    sol_eur,
)

# A pump.fun-style launch curve (amounts in lamports and token base units, 6 decimals):
# 1,073,000,000 virtual and 793,100,000 real tokens, as in the recorded curve of
# tests/test_pumpfun.py, and the commonly quoted 30 SOL of virtual quote (UNVERIFIED; the
# vectors below test the math, not the venue's numbers).
LAUNCH = CurveState(
    virtual_quote=30_000_000_000,
    virtual_token=1_073_000_000_000_000,
    real_token=793_100_000_000_000,
    complete=False,
)
SOL = 1_000_000_000  # lamports

reserves = st.integers(min_value=1, max_value=10**18)
amounts = st.integers(min_value=0, max_value=10**18)
fees = st.integers(min_value=0, max_value=9_999)


# ------------------------------------------------------------------ constant product
def test_cp_amount_out_hand_vector() -> None:
    # fee = ceil(1_000_000 x 25 / 10_000) = 2_500; net = 997_500
    # out = floor(997_500 x 20_000_000 / (10_000_000 + 997_500)) = floor(7_980_000_000 / 4_399)
    #     = floor(1_814_048.647...) = 1_814_048
    assert cp_amount_out(1_000_000, 10_000_000, 20_000_000, 25) == 1_814_048


def test_cp_fee_rounds_up_and_output_rounds_down() -> None:
    # fee = 12_345 x 30 / 10_000 = 37.035 -> 38 (a floored fee would be 37); net = 12_307
    # out = floor(12_307 x 3_000_000 / 1_012_307) = floor(36_472.15...) = 36_472
    assert cp_amount_out(12_345, 1_000_000, 3_000_000, 30) == 36_472
    # Fee 0: floor(12_345 x 3_000_000 / 1_012_345) = floor(36_583.37...) = 36_583
    assert cp_amount_out(12_345, 1_000_000, 3_000_000, 0) == 36_583
    assert cp_amount_out(0, 1_000_000, 3_000_000, 30) == 0


def test_cp_amount_in_hand_vector_is_the_exact_inverse() -> None:
    # net needed = ceil(1_814_048 x 10_000_000 / (20_000_000 - 1_814_048)) = 997_500
    # gross = ceil(997_500 x 10_000 / 9_975) = 1_000_000; one lamport less is not enough
    assert cp_amount_in(1_814_048, 10_000_000, 20_000_000, 25) == 1_000_000
    assert cp_amount_out(999_999, 10_000_000, 20_000_000, 25) < 1_814_048
    assert cp_amount_in(0, 10_000_000, 20_000_000, 25) == 0


@given(
    target=st.integers(min_value=1, max_value=10**15),
    reserve_in=reserves,
    extra=st.integers(min_value=1, max_value=10**15),
    fee=fees,
)
def test_cp_amount_in_is_the_smallest_sufficient_input(
    target: int, reserve_in: int, extra: int, fee: int
) -> None:
    reserve_out = target + extra  # the pool can pay the target
    gross = cp_amount_in(target, reserve_in, reserve_out, fee)
    assert cp_amount_out(gross, reserve_in, reserve_out, fee) >= target
    assert cp_amount_out(gross - 1, reserve_in, reserve_out, fee) < target


@given(amount_in=amounts, reserve_in=reserves, reserve_out=reserves, fee=fees)
def test_cp_never_lets_the_pool_lose(amount_in: int, reserve_in: int, reserve_out: int, fee: int) -> None:
    out = cp_amount_out(amount_in, reserve_in, reserve_out, fee)
    assert 0 <= out < reserve_out
    assert (reserve_in + amount_in) * (reserve_out - out) >= reserve_in * reserve_out  # k never falls
    assert cp_amount_out(amount_in + 1, reserve_in, reserve_out, fee) >= out  # monotone


def test_cp_refuses_impossible_or_malformed_input() -> None:
    with pytest.raises(ValueError, match="cannot take"):
        cp_amount_in(20_000_000, 10_000_000, 20_000_000, 25)  # the whole pool
    for bad in (
        lambda: cp_amount_out(-1, 10, 10, 25),
        lambda: cp_amount_out(1, 0, 10, 25),
        lambda: cp_amount_out(1, 10, 0, 25),
        lambda: cp_amount_out(1, 10, 10, 10_000),  # a 100% fee
        lambda: cp_amount_out(1, 10, 10, -1),
        lambda: cp_amount_out(True, 10, 10, 25),  # bools are not amounts
        lambda: cp_amount_out(1.5, 10, 10, 25),  # type: ignore[arg-type]
        lambda: cp_amount_in(-1, 10, 10, 25),
        lambda: impact_bps(0, 10, 10, 25),
    ):
        with pytest.raises(ValueError, match="must be"):
            bad()


def test_impact_hand_vector() -> None:
    # spot output = 1_000_000 x 20_000_000 / 10_000_000 = 2_000_000; actual 1_814_048
    # impact = (1 - 1_814_048 / 2_000_000) x 10_000 = 0.092976 x 10_000 = 929.76 bps (fee included)
    assert impact_bps(1_000_000, 10_000_000, 20_000_000, 25) == Decimal("929.76")
    # A tiny trade in a deep pool: fee ceil(1_000 x 30 / 10_000) = 3, net 997, but the output
    # floor(997 x 10^15 / (10^15 + 997)) = 996 (just below 997), so the cost is 4 units = 40 bps.
    assert impact_bps(1_000, 10**15, 10**15, 30) == Decimal(40)


@given(
    amount_in=st.integers(min_value=1_000, max_value=10**12),
    reserve=st.integers(min_value=10**6, max_value=10**15),
    fee=st.integers(min_value=0, max_value=500),
)
def test_the_2x_stress_never_lowers_impact(amount_in: int, reserve: int, fee: int) -> None:
    # The caller's 2x rule: fee rate doubled, reserves halved.
    one = impact_bps(amount_in, reserve, reserve, fee)
    two = impact_bps(amount_in, reserve // 2, reserve // 2, 2 * fee)
    assert Decimal(0) <= one <= two


# ------------------------------------------------------------------ bonding curve
def test_bonding_curve_buy_hand_vector() -> None:
    # 1 SOL in at launch, fee 100 bps: fee = 10_000_000; net = 990_000_000
    # tokens = floor(990_000_000 x 1_073_000_000_000_000 / 30_990_000_000)
    #        = floor(35_409_000_000_000_000 / 1_033) = floor(34_277_831_558_567.28...) = 34_277_831_558_567
    assert bonding_curve_buy(LAUNCH, SOL, 100) == 34_277_831_558_567
    # Without the fee: floor(10^9 x 1.073e15 / 31e9) = 34_612_903_225_806 (about 34.6M tokens)
    assert bonding_curve_buy(LAUNCH, SOL, 0) == 34_612_903_225_806
    assert bonding_curve_buy(LAUNCH, 0, 100) == 0


def test_bonding_curve_sell_hand_vector() -> None:
    # 10M tokens (10_000_000_000_000 base units) into the launch curve:
    # gross = floor(10^13 x 3e10 / (1.073e15 + 10^13)) = floor(100_000_000_000 / 361) = 277_008_310
    # fee = ceil(277_008_310 x 100 / 10_000) = ceil(2_770_083.10) = 2_770_084; net = 274_238_226
    assert bonding_curve_sell(LAUNCH, 10_000_000_000_000, 100) == 274_238_226
    assert bonding_curve_sell(LAUNCH, 0, 100) == 0


@given(
    quote_in=st.integers(min_value=0, max_value=10**12),
    virtual_quote=st.integers(min_value=1, max_value=10**12),
    virtual_token=st.integers(min_value=1, max_value=10**16),
    real_share=st.integers(min_value=0, max_value=100),
    fee=st.integers(min_value=0, max_value=500),
)
def test_the_curve_is_constant_product_on_virtual_reserves(
    quote_in: int, virtual_quote: int, virtual_token: int, real_share: int, fee: int
) -> None:
    state = CurveState(virtual_quote, virtual_token, virtual_token * real_share // 100, complete=False)
    expected = min(cp_amount_out(quote_in, virtual_quote, virtual_token, fee), state.real_token)
    assert bonding_curve_buy(state, quote_in, fee) == expected
    gross = cp_amount_out(quote_in, virtual_token, virtual_quote, 0)  # tokens in, no fee on the input
    assert bonding_curve_sell(state, quote_in, fee) == gross - -(-gross * fee // 10_000)


@given(expected=st.integers(min_value=0, max_value=10**18), bps=st.integers(min_value=0, max_value=10_000))
def test_min_out_is_the_floor_of_the_cap(expected: int, bps: int) -> None:
    floor = min_out(expected, bps)
    assert floor * 10_000 <= expected * (10_000 - bps) < (floor + 1) * 10_000


def test_a_buy_never_takes_more_than_the_real_tokens() -> None:
    nearly_done = CurveState(
        virtual_quote=80 * SOL, virtual_token=300_000_000_000_000, real_token=1_000, complete=False
    )
    assert bonding_curve_buy(nearly_done, SOL, 100) == 1_000


def test_trap20_a_complete_curve_refuses_to_quote() -> None:
    graduated = CurveState(
        virtual_quote=LAUNCH.virtual_quote, virtual_token=LAUNCH.virtual_token, real_token=0, complete=True
    )
    with pytest.raises(GraduatedCurveError, match="complete"):
        bonding_curve_buy(graduated, SOL, 100)
    with pytest.raises(GraduatedCurveError, match="complete"):
        bonding_curve_sell(graduated, 10_000, 100)
    assert issubclass(GraduatedCurveError, ValueError)


@given(
    quote_in=st.integers(min_value=1, max_value=50 * SOL),
    fee=st.integers(min_value=0, max_value=500),
)
def test_a_round_trip_on_the_curve_never_makes_money(quote_in: int, fee: int) -> None:
    tokens = bonding_curve_buy(LAUNCH, quote_in, fee)
    paid_net = quote_in - -(-quote_in * fee // 10_000)
    after = CurveState(
        virtual_quote=LAUNCH.virtual_quote + paid_net,
        virtual_token=LAUNCH.virtual_token - tokens,
        real_token=LAUNCH.real_token - tokens,
        complete=False,
    )
    assert bonding_curve_sell(after, tokens, fee) <= quote_in


def test_curve_state_refuses_nonsense() -> None:
    for kwargs in (
        {"virtual_quote": 0},
        {"virtual_token": 0},
        {"real_token": -1},
        {"real_token": LAUNCH.virtual_token + 1},
        {"complete": 1},
        {"virtual_quote": 1.0},
    ):
        fields = {
            "virtual_quote": LAUNCH.virtual_quote,
            "virtual_token": LAUNCH.virtual_token,
            "real_token": LAUNCH.real_token,
            "complete": False,
            **kwargs,
        }
        with pytest.raises(ValueError, match=r"must|cannot"):
            CurveState(**fields)  # type: ignore[arg-type]


# ------------------------------------------------------------------ fees and failures
def test_priority_fee_hand_vector_rounds_up_and_doubles_only_the_priority_part() -> None:
    # 333 micro-lamports x 200_001 CU = 66_600_333 micro-lamports -> ceil(66.600333) = 67 lamports
    model = PriorityFeeModel(cu_price_micro_lamports=(333,), compute_units=200_001, base_fee_lamports=5_000)
    assert model.sample_lamports(random.Random(1), 1) == 5_000 + 67
    assert model.sample_lamports(random.Random(1), 2) == 5_000 + 2 * 67


def test_priority_fee_samples_only_recorded_prices_and_is_seeded() -> None:
    prices = (0, 1_000, 50_000, 1_000_000)
    model = PriorityFeeModel(cu_price_micro_lamports=prices, compute_units=200_000, base_fee_lamports=5_000)
    allowed = {5_000 + p * 200_000 // 1_000_000 for p in prices}
    draws = [model.sample_lamports(random.Random(7), 1) for _ in range(3)]
    assert len(set(draws)) == 1  # same seed, same draw
    rng = random.Random(11)
    seen = {model.sample_lamports(rng, 1) for _ in range(400)}
    assert seen == allowed


def test_every_fee_value_is_a_required_parameter() -> None:
    with pytest.raises(TypeError):
        PriorityFeeModel(cu_price_micro_lamports=(1,), compute_units=1)  # type: ignore[call-arg]
    for kwargs in (
        {"cu_price_micro_lamports": ()},
        {"cu_price_micro_lamports": [1]},
        {"cu_price_micro_lamports": (-1,)},
        {"compute_units": 0},
        {"base_fee_lamports": -1},
    ):
        fields = {"cu_price_micro_lamports": (1,), "compute_units": 1, "base_fee_lamports": 0, **kwargs}
        with pytest.raises(ValueError, match="must"):
            PriorityFeeModel(**fields)  # type: ignore[arg-type]
    model = PriorityFeeModel(cu_price_micro_lamports=(1,), compute_units=1, base_fee_lamports=0)
    for m in (0, 3, True):
        with pytest.raises(ValueError, match="multiplier"):
            model.sample_lamports(random.Random(1), m)


def test_failure_model_is_deterministic_per_seed() -> None:
    fee = PriorityFeeModel(
        cu_price_micro_lamports=(1_000, 90_000), compute_units=150_000, base_fee_lamports=5_000
    )
    model = FailureModel(p_fail=0.4, max_attempts=4)
    for seed in range(50):
        a = model.simulate(random.Random(seed), 1, fee)
        b = model.simulate(random.Random(seed), 1, fee)
        assert a == b
    outcomes = {model.simulate(random.Random(seed), 1, fee) for seed in range(50)}
    assert len(outcomes) > 3  # different seeds really differ


def test_failure_model_draws_the_fee_then_the_failure_per_attempt() -> None:
    # The documented draw order is part of the contract: the same seed must give the same
    # outcome after any refactor. Replayed here by hand from random.Random itself.
    prices = (1_000, 90_000, 400_000)
    fee = PriorityFeeModel(cu_price_micro_lamports=prices, compute_units=150_000, base_fee_lamports=5_000)
    model = FailureModel(p_fail=0.45, max_attempts=4)
    for seed in range(40):
        for m in (1, 2):
            replay = random.Random(seed)
            p = min(0.45 * m, 0.95)
            paid, attempts, landed = 0, 0, False
            while attempts < 4 and not landed:
                attempts += 1
                paid += 5_000 + m * -(-replay.choice(prices) * 150_000 // 1_000_000)
                landed = replay.random() >= p
            got = model.simulate(random.Random(seed), m, fee)
            assert got == TxOutcome(landed=landed, attempts=attempts, fees_lamports=paid)


def test_every_attempt_pays_its_fee_landed_or_not() -> None:
    fee = PriorityFeeModel(cu_price_micro_lamports=(10_000,), compute_units=200_000, base_fee_lamports=5_000)
    per_attempt = 5_000 + 2_000
    model = FailureModel(p_fail=0.6, max_attempts=3)
    seen = Counter()
    for seed in range(300):
        out = model.simulate(random.Random(seed), 1, fee)
        assert out.fees_lamports == out.attempts * per_attempt
        assert 1 <= out.attempts <= 3
        if not out.landed:
            assert out.attempts == 3
        seen[out.landed] += 1
    assert seen[True] and seen[False]


def test_failure_extremes_and_the_cap() -> None:
    fee = PriorityFeeModel(cu_price_micro_lamports=(0,), compute_units=1, base_fee_lamports=5_000)
    never = FailureModel(p_fail=0.0, max_attempts=5)
    assert never.simulate(random.Random(3), 2, fee) == TxOutcome(landed=True, attempts=1, fees_lamports=5_000)
    # p_fail 0.6 at 2x would be 1.2: capped at 0.95, so some first attempts still land.
    capped = FailureModel(p_fail=0.6, max_attempts=1)
    landed = sum(capped.simulate(random.Random(s), 2, fee).landed for s in range(4_000))
    assert MAX_P_FAIL == 0.95
    assert 120 < landed < 290  # about 5% of 4_000 = 200
    # The multiplier doubles p_fail below the cap: 0.2 -> 0.4.
    model = FailureModel(p_fail=0.2, max_attempts=1)
    one = sum(not model.simulate(random.Random(s), 1, fee).landed for s in range(4_000))
    two = sum(not model.simulate(random.Random(s), 2, fee).landed for s in range(4_000))
    assert 700 < one < 900
    assert 1_500 < two < 1_700


def test_failure_model_refuses_nonsense() -> None:
    for kwargs in (
        {"p_fail": -0.1},
        {"p_fail": 1.5},
        {"p_fail": 1.0},  # the 0.95 cap would silently lower it: refused instead
        {"p_fail": 0.951},
        {"p_fail": float("nan")},
        {"p_fail": True},
        {"max_attempts": 0},
    ):
        fields = {"p_fail": 0.1, "max_attempts": 2, **kwargs}
        with pytest.raises(ValueError, match="must"):
            FailureModel(**fields)  # type: ignore[arg-type]
    fee = PriorityFeeModel(cu_price_micro_lamports=(0,), compute_units=1, base_fee_lamports=0)
    with pytest.raises(ValueError, match="multiplier"):
        FailureModel(p_fail=0.1, max_attempts=2).simulate(random.Random(1), 3, fee)
    # The cap itself is a valid rate: at 1x it is used as given.
    at_cap = FailureModel(p_fail=MAX_P_FAIL, max_attempts=1)
    landed = sum(at_cap.simulate(random.Random(s), 1, fee).landed for s in range(4_000))
    assert 120 < landed < 290  # about 5% of 4_000


# ------------------------------------------------------------------ slippage cap and SOL price
def test_min_out_hand_vector() -> None:
    # floor(1_814_048 x 9_950 / 10_000) = floor(1_804_977.76) = 1_804_977
    assert min_out(1_814_048, 50) == 1_804_977
    assert min_out(1_814_048, 0) == 1_814_048
    assert min_out(1_814_048, 10_000) == 0
    for bad in (lambda: min_out(-1, 50), lambda: min_out(1, -1), lambda: min_out(1, 10_001)):
        with pytest.raises(ValueError, match="must"):
            bad()


def test_sol_eur_hand_vector() -> None:
    # A token at 0.0002 USD and 0.000001 SOL: 1 SOL = 200 USD; at 1.25 USD per EUR that is 160 EUR.
    assert sol_eur(Decimal("0.0002"), Decimal("0.000001"), Decimal("1.25")) == Decimal(160)
    for bad in (
        (Decimal(0), Decimal(1), Decimal(1)),
        (Decimal(1), Decimal("-1"), Decimal(1)),
        (Decimal(1), Decimal(1), Decimal("NaN")),
        (1.0, Decimal(1), Decimal(1)),
    ):
        with pytest.raises(ValueError, match="must be a finite Decimal"):
            sol_eur(*bad)  # type: ignore[arg-type]
