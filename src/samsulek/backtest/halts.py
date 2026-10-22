"""Which halts a backtest models, and the modeled owner reset.

Facts the runner relies on:
- Only the four limit halts are modeled. ``classify_halt`` recognises them by the exact
  wording the risk engine (daily loss, drawdown, equity sanity) and the cycle's cap check
  (``cap_breaches`` behind "Position cap exceeded after trading") write into the halt
  flag; tests pin it to messages produced by the real code, so a wording change there
  fails a test instead of silently turning a modeled halt into an unknown one (or the
  reverse). Every other halt reason (zero or invalid equity, stale data, missing prices,
  broker or bookkeeping errors, a clock that moved backwards, unreadable state, anything
  unexpected) gives None: a bug or bad data, and the run is void.
- ``ResetPolicy.NEXT_SESSION``: the halt freezes the rest of the session, and at the next
  session's ``reset_at`` the modeled owner runs the CLI's own reset steps
  (``apply_owner_reset``) on the in-memory store: the halt is cleared, the KILL flag is
  never touched, and the drawdown peak is rebased to the last seen equity only for a
  drawdown halt. The day state and trade counts are untouched, so the re-halt trap
  (a reset on a losing day halts again at the next look) is reproduced exactly.
- Mode L: every modeled halt is reset that way (owner decision Q2).
- Mode R: the relaxed daily loss (50%) and drawdown (90%) stops and the equity-sanity halt
  are hard stops (``ResetPolicy.NEVER``): never reset, the account stays frozen and later
  cycles are blocked. A cap-drift halt alone (a held position grew above its cap through
  price drift, with no buy of it that session) is NOT a hard stop: the research limits
  keep the percentage caps of the bot's own limits, so it is the same real halt as in L,
  and the modeled owner resets it at the next session exactly as in L (no peak rebase).
  Only kinds in ``R_RESETTABLE`` are reset in R: a halt that carries a cap drift together
  with any other kind is a hard stop, and so is a halt whose kinds are unknown.
- ``apply_reset_policy`` refuses any store that is not the backtest's in-memory one, so it
  can never clear a halt of the bot.
"""

from __future__ import annotations

import re
from collections.abc import Collection
from datetime import datetime
from enum import StrEnum
from typing import Final

from samsulek.backtest.inmemory import MemoryRiskStateStore
from samsulek.backtest.types import HaltKind, RiskMode
from samsulek.risk.reset import ResetOutcome, apply_owner_reset

MODELED_OWNER: Final = "backtest model of the owner"

_AMOUNT: Final = r"\S+"  # a Decimal as str() prints it
_PCT: Final = r"-?\d+(?:\.\d+)?%"
_BREACH: Final = rf"\S+ is EUR {_AMOUNT}, cap EUR {_AMOUNT}"
# The exact shapes written by risk/engine.py (observe_equity) and cycle.py (cap check).
_KINDS: Final = (
    (
        re.compile(rf"daily loss {_PCT} reached the limit {_PCT} \(EUR {_AMOUNT} -> EUR {_AMOUNT}\)"),
        HaltKind.DAILY_LOSS,
    ),
    (
        re.compile(rf"drawdown {_PCT} from peak EUR {_AMOUNT} reached the limit {_PCT}"),
        HaltKind.DRAWDOWN,
    ),
    (
        re.compile(
            rf"equity EUR {_AMOUNT} is above the sanity maximum EUR {_AMOUNT} "
            r"\(bug, or an unannounced deposit\)"
        ),
        HaltKind.EQUITY_SANITY,
    ),
    (
        re.compile(rf"Position cap exceeded after trading: {_BREACH}(?:; {_BREACH})*"),
        HaltKind.CAP_DRIFT,
    ),
)
_CAP_PREFIX: Final = "Position cap exceeded after trading: "
# The only halt kinds the modeled owner resets in mode R; every other kind is a hard stop.
R_RESETTABLE: Final = frozenset({HaltKind.CAP_DRIFT})


class ResetPolicy(StrEnum):
    NEXT_SESSION = "next_session"
    NEVER = "never"


def reset_policy_for(mode: RiskMode, *, kinds: Collection[HaltKind] | None = None) -> ResetPolicy:
    """What the modeled owner does with a halt of ``kinds`` in ``mode``. L: reset at the next
    session, whatever the kinds. R: reset at the next session only when every kind is in
    ``R_RESETTABLE`` (a cap-drift halt); otherwise never (a hard stop: daily loss, drawdown,
    equity sanity, or a mix with any of them). Without kinds (None or empty) R gives NEVER."""
    if RiskMode(mode) is RiskMode.L:
        return ResetPolicy.NEXT_SESSION
    found = {HaltKind(k) for k in kinds or ()}
    if found and found <= R_RESETTABLE:
        return ResetPolicy.NEXT_SESSION
    return ResetPolicy.NEVER


def classify_halt(reason: str) -> HaltKind | None:
    """The modeled limit halt ``reason`` reports, or None (not modeled: the run is void)."""
    for pattern, kind in _KINDS:
        if pattern.fullmatch(reason):
            return kind
    return None


def cap_drift_symbols(reason: str) -> tuple[str, ...]:
    """The symbols a CAP_DRIFT reason names (empty for any other reason)."""
    if classify_halt(reason) is not HaltKind.CAP_DRIFT:
        return ()
    return tuple(part.split(" is EUR ", 1)[0] for part in reason[len(_CAP_PREFIX) :].split("; "))


def apply_reset_policy(
    store: MemoryRiskStateStore, *, kinds: Collection[HaltKind], at: datetime
) -> ResetOutcome:
    """The modeled owner's reset of a halt of ``kinds`` that ``reset_policy_for`` resets (any
    mode-L halt, a mode-R cap-drift halt; the caller decides). Never the KILL flag; the peak
    is rebased only for a drawdown halt. ``TypeError`` for any store but the in-memory one;
    ``ValueError`` without a halt kind."""
    if not isinstance(store, MemoryRiskStateStore) or getattr(store, "in_memory", False) is not True:
        raise TypeError(
            f"the modeled owner resets only the backtest's in-memory risk store, not {type(store).__name__}"
        )
    found = {HaltKind(k) for k in kinds}
    if not found:
        raise ValueError("a modeled reset needs the kinds of the halt it clears")
    return apply_owner_reset(
        store, at, by=MODELED_OWNER, clear_kill=False, rebase_peak=HaltKind.DRAWDOWN in found
    )
