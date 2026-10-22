"""Episodes, the profit-and-loss invariant, and halt bookkeeping (M3 spec sections 4 and 6).

Facts relied on:
- An episode opens at the first BUY of a symbol not in an episode, and closes at a SELL
  after which the remaining quantity times that fill's price is below ``min_order_eur``
  (the sizing dust rule; a zero remainder always closes). Fills are taken in run order.
- ``pnl = sum over sells (q p - fee) - sum over buys (q p + fee)`` within the episode; an
  episode still open after the last session adds ``qty_T x last mark``. The dust left after
  closed episodes is ``residual_eur``, valued at the last mark; a sale of dust while no
  episode is open (the dust grew above the minimum) is credited to the residual too. So
  every fill and every unit held at the end is counted exactly once.
- These sums are computed EXACTLY (a wide local Decimal context that refuses to round),
  from the fills' own quantity, price and fee. The broker and the ledger keep cash in
  Decimal's default 28 significant digits. With short EUR prices and step-sized
  quantities nothing rounds and ``sum(pnl) + residual`` equals the final equity minus the
  starting cash exactly. But a price can carry up to 28 digits (an FX-converted price
  always does; a EUR price from a 17-digit float repr below about EUR 0.50 can push a
  product past 28 digits), and then the ledger's running cash rounds and the two differ
  by those roundings alone: a few units in the 28th digit per operation, about 1e-25 EUR
  on a EUR 50 account. So ``check_invariant`` always allows a bound of twice the worst
  case of those roundings (computed from the run's own values and number of operations,
  far below a cent) and nothing more; a strict ``==`` would void such runs for no bug.
  Any bookkeeping bug (a lost fee, a missing fill) is many orders of magnitude larger and
  voids the run (``BacktestIntegrityError``), as does a non-finite amount.
- ``sessions_held = idx(exit) - idx(entry)`` in the run's session list; an episode open at
  the end counts to one past the last session. ``weight`` is the mean target weight over
  ``[entry, exit)``, over the sessions in which the strategy ran (it logged targets, or
  the cycle ended "done"; a symbol it did not target weighs 0).
- ``summarize_halts`` reads only the run's records: "sessions halted" counts sessions whose
  cycle ended halted or blocked; the first halt is when the account would have stopped for
  good without the modeled owner resets (its equity is that session's closing mark).
"""

from __future__ import annotations

import decimal
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Final

from samsulek.backtest.types import (
    BacktestIntegrityError,
    Episode,
    EquityPoint,
    FillRecord,
    HaltKind,
    HaltSummary,
    RiskMode,
    RunResult,
    SessionRecord,
)
from samsulek.types import Side

_ZERO: Final = Decimal(0)
# Exact arithmetic: only +, - and * are used here, and 200 digits hold every sum of
# 28-digit products a run can produce. Rounding would raise (Inexact) instead of hiding.
_EXACT: Final = decimal.Context(
    prec=200,
    traps=[decimal.InvalidOperation, decimal.DivisionByZero, decimal.Overflow, decimal.Inexact],
)
_LABEL: Final = "episodes"  # build_episodes does not know the job; the runner reports which run
_HALTED_STATUSES: Final = frozenset({"halted", "blocked"})


@dataclass(slots=True)
class _OpenEpisode:
    """Running totals of one episode while it is open (mutable, local to build_episodes)."""

    symbol: str
    entry: int  # index into the run's sessions
    order: int  # opening order, for a deterministic output order
    buy_eur: Decimal = _ZERO
    sell_eur: Decimal = _ZERO
    fees_eur: Decimal = _ZERO


def _strategy_ran(s: SessionRecord) -> bool:
    """The strategy produced targets this session: it logged some, or the cycle ended "done"
    (a done cycle always runs the strategy; empty targets then mean "all cash")."""
    return bool(s.targets) or s.status == "done"


def _mean_weight(symbol: str, targets: Sequence[Mapping[str, float] | None], first: int, end: int) -> float:
    """Mean target weight of ``symbol`` over the sessions in [first, end) the strategy ran in
    (``None``: it did not run, e.g. halted before trading); a symbol not targeted weighs 0."""
    window = [t.get(symbol, 0.0) for t in targets[first:end] if t is not None]
    if not window and 0 <= first < len(targets) and (entry := targets[first]) is not None:
        window = [entry.get(symbol, 0.0)]  # opened and closed in one session
    return math.fsum(window) / len(window) if window else 0.0


def build_episodes(
    fills: Sequence[FillRecord],
    sessions: Sequence[SessionRecord],
    *,
    min_order_eur: Decimal,
    last_marks: Mapping[str, Decimal],
) -> tuple[tuple[Episode, ...], Decimal]:
    """(episodes, residual). ``BacktestIntegrityError`` for fills that cannot be booked."""
    index: dict[date, int] = {}
    for pos, srec in enumerate(sessions):
        if srec.session in index:
            raise BacktestIntegrityError(
                "two session records for one session", session=srec.session, label=_LABEL
            )
        index[srec.session] = pos
    targets = [dict(srec.targets) if _strategy_ran(srec) else None for srec in sessions]
    n = len(sessions)
    open_eps: dict[str, _OpenEpisode] = {}
    qty: dict[str, Decimal] = {}
    done: list[tuple[int, Episode]] = []
    orphan = _ZERO  # dust sold while no episode was open
    opened = 0
    last_idx = -1

    def close(ep: _OpenEpisode, *, exit_idx: int | None, extra: Decimal) -> None:
        end = n if exit_idx is None else exit_idx
        pnl = ep.sell_eur - ep.buy_eur - ep.fees_eur + extra
        done.append(
            (
                ep.order,
                Episode(
                    symbol=ep.symbol,
                    entry_session=sessions[ep.entry].session,
                    exit_session=None if exit_idx is None else sessions[exit_idx].session,
                    sessions_held=end - ep.entry,
                    weight=_mean_weight(ep.symbol, targets, ep.entry, end),
                    buy_eur=ep.buy_eur,
                    sell_eur=ep.sell_eur,
                    fees_eur=ep.fees_eur,
                    pnl_eur=pnl,
                    open_at_end=exit_idx is None,
                ),
            )
        )

    try:
        with decimal.localcontext(_EXACT):
            for rec in fills:
                f = rec.fill
                i = index.get(rec.session)
                if i is None:
                    raise BacktestIntegrityError(
                        f"fill {f.fill_id} belongs to no session of the run",
                        session=rec.session,
                        label=_LABEL,
                    )
                if i < last_idx:
                    raise BacktestIntegrityError(
                        f"fill {f.fill_id} is out of session order", session=rec.session, label=_LABEL
                    )
                last_idx = i
                value = f.quantity * f.price  # Fill itself guarantees quantity, price > 0, fee >= 0
                held = qty.get(f.symbol, _ZERO)
                ep = open_eps.get(f.symbol)
                if f.side is Side.BUY:
                    if ep is None:
                        ep = open_eps[f.symbol] = _OpenEpisode(symbol=f.symbol, entry=i, order=opened)
                        opened += 1
                    ep.buy_eur += value
                    ep.fees_eur += f.fee
                    qty[f.symbol] = held + f.quantity
                    continue
                if f.quantity > held:
                    raise BacktestIntegrityError(
                        f"fill {f.fill_id} sells {f.quantity} {f.symbol} but only {held} is held",
                        session=rec.session,
                        label=_LABEL,
                    )
                remaining = held - f.quantity
                qty[f.symbol] = remaining
                if ep is None:
                    orphan += value - f.fee
                    continue
                ep.sell_eur += value
                ep.fees_eur += f.fee
                if remaining == 0 or remaining * f.price < min_order_eur:
                    del open_eps[f.symbol]
                    close(ep, exit_idx=i, extra=_ZERO)

            residual = orphan
            for symbol in sorted(qty):
                q = qty[symbol]
                if q == 0:
                    continue
                mark = last_marks.get(symbol)
                if mark is None:
                    raise BacktestIntegrityError(
                        f"{q} {symbol} is held at the end but has no last mark", session=None, label=_LABEL
                    )
                if not mark.is_finite() or mark <= 0:
                    raise BacktestIntegrityError(
                        f"{q} {symbol} is held at the end but its last mark is {mark}",
                        session=None,
                        label=_LABEL,
                    )
                ep = open_eps.pop(symbol, None)
                if ep is None:
                    residual += q * mark
                else:
                    close(ep, exit_idx=None, extra=q * mark)
            for ep in open_eps.values():  # open, but nothing left: cannot happen (a zero remainder closes)
                close(ep, exit_idx=None, extra=_ZERO)
    except decimal.DecimalException as exc:
        raise BacktestIntegrityError(
            f"episode arithmetic could not stay exact ({type(exc).__name__})", session=None, label=_LABEL
        ) from exc
    done.sort(key=lambda item: item[0])
    return tuple(e for _, e in done), residual


def _rounding_allowance(result: RunResult) -> Decimal:
    """The most the 28-digit Decimal roundings of broker, ledger and mark can add up to.

    Each rounding loses at most half a unit in the last kept digit of its result; every
    result is below 10x the largest money value seen (M). A fill causes at most 3 of them
    (product, fee, cash update) and each held symbol 3 at the final mark (product, sum,
    cash + gross). The bound counts one full unit at 10 M per operation, twice what is
    possible, and stays far below a cent (about 1e-21 EUR for a EUR 50 run of 1000 fills).
    """
    with decimal.localcontext(_EXACT):
        values = [abs(result.start_equity)]
        for p in result.equity:
            values.extend((abs(p.cash), abs(p.gross), abs(p.equity)))
        values.extend(abs(f.fill.quantity * f.fill.price) + abs(f.fill.fee) for f in result.fills)
        biggest = max(v for v in values if v.is_finite())
    if biggest == 0:
        return _ZERO
    prec = decimal.getcontext().prec  # the context the run's own arithmetic used
    unit = Decimal(10) ** (biggest.adjusted() + 2 - prec)
    operations = 3 * len(result.fills) + 3 * len(result.job.universe) + 3
    return operations * unit


def check_invariant(result: RunResult) -> None:
    """``sum(pnl) + residual == equity[-1] - start`` up to Decimal's own rounding; else integrity."""
    label = result.job.label
    if not result.equity:
        raise BacktestIntegrityError("the run has no equity marks", session=None, label=label)
    last = result.equity[-1]
    try:
        with decimal.localcontext(_EXACT):
            booked = sum((e.pnl_eur for e in result.episodes), _ZERO) + result.residual_eur
            moved = last.equity - result.start_equity
            gap = abs(booked - moved)
    except decimal.DecimalException as exc:
        raise BacktestIntegrityError(
            f"profit and loss could not be added up exactly ({type(exc).__name__})",
            session=last.session,
            label=label,
        ) from exc
    if not gap.is_finite():  # a NaN or infinite amount somewhere: never a comparison that raises
        raise BacktestIntegrityError(
            f"profit and loss are not finite: episodes plus residual give {booked}, equity moved {moved}",
            session=last.session,
            label=label,
        )
    allowance = _rounding_allowance(result)
    if gap > allowance:
        raise BacktestIntegrityError(
            f"profit and loss do not add up: episodes plus residual give {booked}, but equity moved "
            f"{moved} (difference {gap}, rounding allows {allowance})",
            session=last.session,
            label=label,
        )


def frozen_equity_series(
    *,
    positions: Mapping[str, Decimal],
    cash: Decimal,
    sessions: Sequence[date],
    close: Callable[[str, date], Decimal | None],
    ts: Callable[[date], datetime],
) -> tuple[EquityPoint, ...]:
    """The equity of positions frozen at a halt, marked at each close; stops at the first missing close."""
    if not cash.is_finite() or cash < 0:
        raise ValueError(f"frozen cash must be a finite amount >= 0, got {cash}")
    held = sorted((symbol, q) for symbol, q in positions.items() if q != 0)
    for symbol, q in held:
        if not q.is_finite() or q < 0:
            raise ValueError(f"frozen position {symbol} must be a finite quantity >= 0, got {q}")
    points: list[EquityPoint] = []
    for day in sessions:
        gross = _ZERO
        for symbol, q in held:
            price = close(symbol, day)
            if price is None:
                return tuple(points)
            if not price.is_finite() or price <= 0:
                raise ValueError(f"the close of {symbol} on {day} must be a finite price > 0, got {price}")
            gross += q * price
        points.append(EquityPoint(session=day, ts=ts(day), cash=cash, gross=gross, equity=cash + gross))
    return tuple(points)


def summarize_halts(result: RunResult) -> HaltSummary:
    halts = result.halts
    first = halts[0] if halts else None
    first_equity = None
    if first is not None:
        marks = [p.equity for p in result.equity if p.session == first.session and p.ts > result.start_ts]
        first_equity = marks[-1] if marks else None
    return HaltSummary(
        n_halts=len(halts),
        sessions_halted=sum(1 for s in result.sessions if s.status in _HALTED_STATUSES),
        immediate_rehalts=sum(1 for h in halts if h.immediate_rehalt),
        first_halt_session=None if first is None else first.session,
        first_halt_equity=first_equity,
        equity_sanity_halts=sum(1 for h in halts if HaltKind.EQUITY_SANITY in h.kinds),
        cap_drift_halts=sum(1 for h in halts if HaltKind.CAP_DRIFT in h.kinds),
        hard_stop_active_at_end=result.job.risk_mode is RiskMode.R and any(h.reset_at is None for h in halts),
        frozen_end_equity=result.frozen_equity[-1].equity if result.frozen_equity else None,
    )
