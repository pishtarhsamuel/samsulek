"""Every risk rule, one at a time, plus halt/kill persistence. Limits come from tests/helpers.py."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from helpers import T0, UNIVERSE, make_risk_config, order, pf, q
from samsulek.clock import FixedClock
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import RiskStateStore
from samsulek.types import Market, OrderType, Side

BUY, SELL = Side.BUY, Side.SELL
QUOTES = {"AAA": q("AAA", "100"), "BBB": q("BBB", "10"), "CCC": q("CCC", "50")}


def reasons(decision: object) -> str:
    return " | ".join(decision.reasons)  # type: ignore[attr-defined]


# --------------------------------------------------------------------- approve
def test_plain_buy_within_limits_is_approved(engine: RiskEngine) -> None:
    d = engine.evaluate(order("AAA", BUY, "0.1", "100.40"), pf("50"), QUOTES)
    assert d.approved, reasons(d)
    assert d.equity == Decimal(50)
    assert "position and exposure caps" in d.checks


def test_plain_sell_of_held_position_is_approved(engine: RiskEngine) -> None:
    d = engine.evaluate(order("AAA", SELL, "0.05", "99.60"), pf("40", {"AAA": "0.1"}), QUOTES)
    assert d.approved, reasons(d)


# ------------------------------------------------------- structural rejections
def test_unconfigured_market_rejected(store: RiskStateStore, clock: FixedClock) -> None:
    cfg = make_risk_config()
    cfg = cfg.model_copy(update={"markets": {Market.STOCKS: cfg.markets[Market.STOCKS]}})
    eng = RiskEngine(cfg, store, clock, UNIVERSE)
    d = eng.evaluate(order("MEME", BUY, "1", "1", market=Market.MEMECOIN), pf("50"), QUOTES)
    assert not d.approved and "no risk limits configured" in reasons(d)


def test_symbol_outside_universe_rejected(engine: RiskEngine) -> None:
    quotes = {**QUOTES, "ZZZ": q("ZZZ", "10")}
    d = engine.evaluate(order("ZZZ", BUY, "0.5", "10"), pf("50"), quotes)
    assert not d.approved and "not in the stocks universe" in reasons(d)


def test_missing_price_rejected(engine: RiskEngine) -> None:
    d = engine.evaluate(order("AAA", BUY, "0.1", "100"), pf("50"), {})
    assert not d.approved and "no price for AAA" in reasons(d)


def test_stale_price_rejected(engine: RiskEngine) -> None:
    old = {"AAA": q("AAA", "100", ts=T0 - timedelta(seconds=901))}
    d = engine.evaluate(order("AAA", BUY, "0.1", "100"), pf("50"), old)
    assert not d.approved and "stale" in reasons(d)


def test_price_exactly_at_max_age_is_fresh(engine: RiskEngine) -> None:
    edge = {"AAA": q("AAA", "100", ts=T0 - timedelta(seconds=900))}
    assert engine.evaluate(order("AAA", BUY, "0.1", "100"), pf("50"), edge).approved


def test_future_dated_price_rejected(engine: RiskEngine) -> None:
    future = {"AAA": q("AAA", "100", ts=T0 + timedelta(minutes=1))}
    d = engine.evaluate(order("AAA", BUY, "0.1", "100"), pf("50"), future)
    assert not d.approved and "in the future" in reasons(d)


def test_mismatched_price_record_rejected(engine: RiskEngine) -> None:
    wrong = {"AAA": q("BBB", "100")}
    d = engine.evaluate(order("AAA", BUY, "0.1", "100"), pf("50"), wrong)
    assert not d.approved and "does not match" in reasons(d)


def test_market_orders_rejected_when_not_allowed(engine: RiskEngine) -> None:
    o = order("AAA", BUY, "0.1", None, order_type=OrderType.MARKET)
    d = engine.evaluate(o, pf("50"), QUOTES)
    assert not d.approved and "market orders are not allowed" in reasons(d)


# ------------------------------------------------------------- slippage collar
def test_buy_limit_above_collar_rejected(engine: RiskEngine) -> None:
    d = engine.evaluate(order("AAA", BUY, "0.1", "100.51"), pf("50"), QUOTES)
    assert not d.approved and "exceeds the 50 bps cap" in reasons(d)


def test_buy_limit_exactly_at_collar_approved(engine: RiskEngine) -> None:
    assert engine.evaluate(order("AAA", BUY, "0.1", "100.50"), pf("50"), QUOTES).approved


def test_sell_limit_below_collar_rejected(engine: RiskEngine) -> None:
    d = engine.evaluate(order("AAA", SELL, "0.05", "99.49"), pf("40", {"AAA": "0.1"}), QUOTES)
    assert not d.approved and "below the 50 bps cap" in reasons(d)


# ------------------------------------------------------------------ size rules
def test_below_min_order_rejected(engine: RiskEngine) -> None:
    d = engine.evaluate(order("BBB", BUY, "0.05", "10"), pf("50"), QUOTES)  # EUR 0.50
    assert not d.approved and "below the minimum" in reasons(d)


def test_above_max_order_rejected(store: RiskStateStore, clock: FixedClock) -> None:
    eng = RiskEngine(
        make_risk_config(markets={"stocks": {"max_position_pct": "1", "max_position_eur": "60"}}),
        store,
        clock,
        UNIVERSE,
    )
    d = eng.evaluate(order("BBB", BUY, "2.1", "10"), pf("50"), QUOTES)  # EUR 21 > 20
    assert not d.approved and "exceeds the maximum" in reasons(d)


def test_insufficient_cash_rejected(engine: RiskEngine) -> None:
    d = engine.evaluate(order("BBB", BUY, "1.2", "10"), pf("10", {"AAA": "0.4"}), QUOTES)  # 12 > 10 cash
    assert not d.approved and "exceeds cash" in reasons(d)


def test_position_pct_cap_rejected(engine: RiskEngine) -> None:
    # equity 50 -> 30% = 15. Buying EUR 15.10 of AAA.
    d = engine.evaluate(order("AAA", BUY, "0.151", "100"), pf("50"), QUOTES)
    assert not d.approved and "30% of equity" in reasons(d)


def test_position_pct_cap_counts_existing_holding(engine: RiskEngine) -> None:
    # Hold EUR 10 of AAA, equity 50; adding EUR 6 makes 16 > 15.
    d = engine.evaluate(order("AAA", BUY, "0.06", "100"), pf("40", {"AAA": "0.1"}), QUOTES)
    assert not d.approved and "30% of equity" in reasons(d)


def test_position_eur_cap_rejected(store: RiskStateStore, clock: FixedClock) -> None:
    eng = RiskEngine(make_risk_config(account={"equity_sanity_max_eur": "1000"}), store, clock, UNIVERSE)
    # equity 100 -> 30% = 30, but absolute cap is EUR 20.
    d = eng.evaluate(order("BBB", BUY, "2.05", "10"), pf("100", {"CCC": "0"}), QUOTES)
    assert not d.approved and "> cap EUR 20" in reasons(d)


def test_gross_exposure_caps_rejected(store: RiskStateStore, clock: FixedClock) -> None:
    eng = RiskEngine(
        make_risk_config(markets={"stocks": {"max_gross_exposure_pct": "0.5"}}), store, clock, UNIVERSE
    )
    # Hold 20 of BBB + 0.04 AAA... equity 50, gross cap 25. Holding 20, adding 6 -> 26.
    d = eng.evaluate(order("CCC", BUY, "0.12", "50"), pf("30", {"BBB": "2"}), QUOTES)
    assert not d.approved and "exposure would be" in reasons(d)


def test_gross_eur_cap_rejected(store: RiskStateStore, clock: FixedClock) -> None:
    eng = RiskEngine(
        make_risk_config(
            account={"equity_sanity_max_eur": "1000"},
            markets={"stocks": {"max_gross_exposure_eur": "30", "max_position_eur": "20"}},
        ),
        store,
        clock,
        UNIVERSE,
    )
    d = eng.evaluate(order("CCC", BUY, "0.2", "50"), pf("80", {"BBB": "2.5"}), QUOTES)  # 25 + 10 > 30
    assert not d.approved and "cap EUR 30" in reasons(d)


def test_short_sell_rejected(engine: RiskEngine) -> None:
    d = engine.evaluate(order("AAA", SELL, "0.2", "100"), pf("40", {"AAA": "0.1"}), QUOTES)
    assert not d.approved and "no short selling" in reasons(d)


def test_sell_with_no_position_rejected(engine: RiskEngine) -> None:
    d = engine.evaluate(order("AAA", SELL, "0.1", "100"), pf("50"), QUOTES)
    assert not d.approved and "no short selling" in reasons(d)


def test_stale_price_on_other_holding_blocks_new_risk(engine: RiskEngine) -> None:
    quotes = {**QUOTES, "BBB": q("BBB", "10", ts=T0 - timedelta(hours=1))}
    d = engine.evaluate(order("AAA", BUY, "0.1", "100"), pf("40", {"BBB": "1"}), quotes)
    assert not d.approved and "cannot value portfolio" in reasons(d)


def test_missing_price_on_other_holding_blocks_new_risk(engine: RiskEngine) -> None:
    quotes = {"AAA": QUOTES["AAA"]}
    d = engine.evaluate(order("AAA", BUY, "0.1", "100"), pf("40", {"BBB": "1"}), quotes)
    assert not d.approved and "cannot value portfolio" in reasons(d)


# ----------------------------------------------------------------- trade count
def test_daily_trade_limit_per_market(engine: RiskEngine) -> None:
    portfolio = pf("50")
    for _ in range(6):
        o = order("BBB", BUY, "0.1", "10")
        assert engine.evaluate(o, portfolio, QUOTES).approved
        engine.record_submission(o)
    d = engine.evaluate(order("BBB", BUY, "0.1", "10"), portfolio, QUOTES)
    assert not d.approved and "trades today 6 >= limit 6" in reasons(d)


def test_daily_trade_limit_resets_next_day(engine: RiskEngine, clock: FixedClock) -> None:
    portfolio = pf("50")
    for _ in range(6):
        o = order("BBB", BUY, "0.1", "10")
        engine.evaluate(o, portfolio, QUOTES)
        engine.record_submission(o)
    clock.advance(timedelta(days=1))
    quotes = {s: q(s, str(v.price), ts=clock.now()) for s, v in QUOTES.items()}
    assert engine.evaluate(order("BBB", BUY, "0.1", "10"), pf("50", ts=clock.now()), quotes).approved


def test_total_trade_limit_across_markets(store: RiskStateStore, clock: FixedClock) -> None:
    eng = RiskEngine(make_risk_config(account={"max_trades_per_day": 2}), store, clock, UNIVERSE)
    for _ in range(2):
        o = order("BBB", BUY, "0.1", "10")
        assert eng.evaluate(o, pf("50"), QUOTES).approved
        eng.record_submission(o)
    d = eng.evaluate(order("BBB", BUY, "0.1", "10"), pf("50"), QUOTES)
    assert not d.approved and "total trades today 2 >= limit 2" in reasons(d)


# ------------------------------------------------------------------- memecoins
def meme_quote(**kw: object) -> dict[str, object]:
    return {"MEME": q("MEME", "0.001", market=Market.MEMECOIN, **kw)}  # type: ignore[arg-type]


def test_memecoin_buy_needs_pool_liquidity(engine: RiskEngine) -> None:
    quotes = meme_quote(safety_passed=True)
    d = engine.evaluate(order("MEME", BUY, "1500", "0.001", market=Market.MEMECOIN), pf("50"), quotes)  # type: ignore[arg-type]
    assert not d.approved and "no pool liquidity data" in reasons(d)


def test_memecoin_buy_capped_by_pool_liquidity(engine: RiskEngine) -> None:
    quotes = meme_quote(safety_passed=True, pool_liquidity_eur=Decimal("200"))  # 0.5% = EUR 1
    d = engine.evaluate(order("MEME", BUY, "1500", "0.001", market=Market.MEMECOIN), pf("50"), quotes)  # type: ignore[arg-type]
    assert not d.approved and "of pool liquidity" in reasons(d)


def test_memecoin_buy_needs_safety_pass(engine: RiskEngine) -> None:
    for verdict in (None, False):
        quotes = meme_quote(safety_passed=verdict, pool_liquidity_eur=Decimal("100000"))
        d = engine.evaluate(order("MEME", BUY, "1500", "0.001", market=Market.MEMECOIN), pf("50"), quotes)  # type: ignore[arg-type]
        assert not d.approved and "safety-filter" in reasons(d)


def test_memecoin_buy_with_everything_ok_approved(engine: RiskEngine) -> None:
    quotes = meme_quote(safety_passed=True, pool_liquidity_eur=Decimal("100000"))
    d = engine.evaluate(order("MEME", BUY, "1500", "0.001", market=Market.MEMECOIN), pf("50"), quotes)  # type: ignore[arg-type]
    assert d.approved, reasons(d)


def test_memecoin_price_older_than_30s_is_stale(engine: RiskEngine) -> None:
    quotes = meme_quote(
        safety_passed=True, pool_liquidity_eur=Decimal("100000"), ts=T0 - timedelta(seconds=31)
    )
    d = engine.evaluate(order("MEME", BUY, "1500", "0.001", market=Market.MEMECOIN), pf("50"), quotes)  # type: ignore[arg-type]
    assert not d.approved and "stale" in reasons(d)


# ------------------------------------------------------- halts and kill switch
def test_daily_loss_trips_persistent_halt(
    engine: RiskEngine, store: RiskStateStore, clock: FixedClock
) -> None:
    assert engine.observe_equity(Decimal("50")) == []
    tripped = engine.observe_equity(Decimal("48.50"))  # -3.0%
    assert tripped and "daily loss" in tripped[0]
    assert store.read_halt().active
    # A brand-new engine (process restart) still sees the halt.
    fresh = RiskEngine(make_risk_config(), store, clock, UNIVERSE)
    d = fresh.evaluate(order("BBB", BUY, "0.1", "10"), pf("48.50"), QUOTES)
    assert not d.approved and "HALTED" in reasons(d)


def test_daily_loss_just_under_limit_does_not_halt(engine: RiskEngine, store: RiskStateStore) -> None:
    engine.observe_equity(Decimal("50"))
    assert engine.observe_equity(Decimal("48.51")) == []
    assert not store.read_halt().active


def test_overnight_gap_counts_toward_next_days_loss(engine: RiskEngine, clock: FixedClock) -> None:
    engine.observe_equity(Decimal("50"))
    clock.advance(timedelta(days=1))
    tripped = engine.observe_equity(Decimal("48"))  # gapped down 4% overnight
    assert tripped and "daily loss" in tripped[0]


def test_drawdown_from_peak_trips_halt(engine: RiskEngine, clock: FixedClock) -> None:
    engine.observe_equity(Decimal("60"))
    for day, equity in enumerate(["59", "58", "57", "56", "55", "54", "53", "52", "51.01"], start=1):
        clock.set(T0 + timedelta(days=day))
        assert engine.observe_equity(Decimal(equity)) == [], equity
    clock.set(T0 + timedelta(days=10))
    tripped = engine.observe_equity(Decimal("50.99"))  # 15.02% below 60
    assert any("drawdown" in t for t in tripped)


def test_equity_above_sanity_max_halts_and_keeps_peak(engine: RiskEngine, store: RiskStateStore) -> None:
    engine.observe_equity(Decimal("50"))
    tripped = engine.observe_equity(Decimal("201"))
    assert tripped and "sanity" in tripped[0]
    assert store.read_peak() == Decimal("50")


def test_zero_equity_halts(engine: RiskEngine) -> None:
    assert engine.observe_equity(Decimal("0"))


def test_clock_moving_backwards_halts(engine: RiskEngine, clock: FixedClock) -> None:
    engine.observe_equity(Decimal("50"))
    clock.set(T0 - timedelta(days=2))
    tripped = engine.observe_equity(Decimal("50"))
    assert tripped and "backwards" in tripped[0]


def test_halt_blocks_buys_but_allows_reduce_only_exit(engine: RiskEngine) -> None:
    engine.halt("test halt")
    portfolio = pf("40", {"AAA": "0.1"})
    assert not engine.evaluate(order("BBB", BUY, "0.1", "10"), portfolio, QUOTES).approved
    assert not engine.evaluate(order("AAA", SELL, "0.1", "99.6"), portfolio, QUOTES).approved
    exit_order = order("AAA", SELL, "0.1", "98.00", reduce_only=True)  # within 200 bps flatten cap
    d = engine.evaluate(exit_order, portfolio, QUOTES)
    assert d.approved, reasons(d)
    assert d.halted


def test_kill_blocks_buys_but_allows_reduce_only_exit(engine: RiskEngine, store: RiskStateStore) -> None:
    store.set_kill("test kill", T0)
    portfolio = pf("40", {"AAA": "0.1"})
    d = engine.evaluate(order("BBB", BUY, "0.1", "10"), portfolio, QUOTES)
    assert not d.approved and "KILL" in reasons(d)
    assert engine.evaluate(order("AAA", SELL, "0.1", "98", reduce_only=True), portfolio, QUOTES).approved


def test_reduce_only_rules(engine: RiskEngine) -> None:
    portfolio = pf("40", {"AAA": "0.1"})
    too_much = engine.evaluate(order("AAA", SELL, "0.2", "98", reduce_only=True), portfolio, QUOTES)
    assert not too_much.approved and "exceeds position" in reasons(too_much)
    buy = engine.evaluate(order("AAA", BUY, "0.01", "100", reduce_only=True), portfolio, QUOTES)
    assert not buy.approved and "must be sells" in reasons(buy)
    too_cheap = engine.evaluate(order("AAA", SELL, "0.1", "97.99", reduce_only=True), portfolio, QUOTES)
    assert not too_cheap.approved and "200 bps" in reasons(too_cheap)
    stale = {"AAA": q("AAA", "100", ts=T0 - timedelta(hours=1))}
    s = engine.evaluate(order("AAA", SELL, "0.1", "98", reduce_only=True), portfolio, stale)
    assert not s.approved and "stale" in reasons(s)


def test_reduce_only_exit_of_symbol_removed_from_universe(engine: RiskEngine) -> None:
    quotes = {"OLD": q("OLD", "10")}
    d = engine.evaluate(order("OLD", SELL, "1", "9.9", reduce_only=True), pf("40", {"OLD": "1"}), quotes)
    assert d.approved, reasons(d)


# ------------------------------------------------------------ fail-closed state
@pytest.mark.parametrize("name", ["halt.json", "kill.json"])
def test_corrupt_flag_file_blocks_trading(engine: RiskEngine, state_dir: Path, name: str) -> None:
    (state_dir / name).write_text("{not json", encoding="utf-8")
    d = engine.evaluate(order("BBB", BUY, "0.1", "10"), pf("50"), QUOTES)
    assert not d.approved and "unreadable" in reasons(d)


def test_corrupt_day_file_halts(engine: RiskEngine, state_dir: Path, store: RiskStateStore) -> None:
    (state_dir / "risk_day.json").write_text('{"day": "garbage"}', encoding="utf-8")
    d = engine.evaluate(order("BBB", BUY, "0.1", "10"), pf("50"), QUOTES)
    assert not d.approved
    assert store.read_halt().active


def test_wrong_typed_flag_file_blocks_trading(engine: RiskEngine, state_dir: Path) -> None:
    (state_dir / "halt.json").write_text('{"active": "no"}', encoding="utf-8")
    d = engine.evaluate(order("BBB", BUY, "0.1", "10"), pf("50"), QUOTES)
    assert not d.approved and "unreadable" in reasons(d)


def test_record_submission_before_any_equity_observation(engine: RiskEngine, store: RiskStateStore) -> None:
    o = order("AAA", SELL, "0.1", "98", reduce_only=True)
    engine.record_submission(o)  # e.g. an emergency exit on a fresh day
    day = store.read_day()
    assert day is not None and day.trades == {"total": 1, "stocks": 1}
    assert engine.observe_equity(Decimal("50")) == []
    day = store.read_day()
    assert day is not None and day.day_start_equity == Decimal("50")


def test_halt_reasons_accumulate_and_history_is_written(store: RiskStateStore, state_dir: Path) -> None:
    store.set_halt("first", T0)
    state = store.set_halt("second", T0 + timedelta(minutes=1))
    assert state.reasons == ("first", "second")
    assert state.since == T0
    store.clear_halt(T0 + timedelta(minutes=2), by="owner")
    assert not store.read_halt().active
    history = (state_dir / "state_history.jsonl").read_text(encoding="utf-8")
    assert "set:halt.json" in history and "clear:halt.json" in history
