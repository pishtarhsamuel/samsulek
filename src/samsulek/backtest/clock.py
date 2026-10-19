"""The backtest clock, and the four instants of every simulated session (M3 contract).

Facts relied on:
- ``run_backtest`` owns ONE ``MonotoneClock`` per run and is the only thing that sets it;
  the engine, broker, ledger, decision log and feed only read it. Nothing on the backtest
  path reads the wall clock.
- The clock only moves forward: setting an earlier time raises ``ClockError`` (a bug),
  so state from a later instant can never leak into an earlier decision. Naive times are
  refused (``ValueError``, as everywhere else). Times are kept in UTC.
- Per session s (all UTC): ``open_print`` = the open's point-in-time label
  (``open_print_utc``, 09:05 Berlin); ``execute`` (E) = ``open_print + exec_delay``, so E
  is never before the price it trades on; ``reset_at`` = ``E - reset_lead``, when a
  modeled owner reset may run; ``close_print`` = ``close_utc(s)``, the mark. For every
  session ``reset_at < execute``, ``open_print <= execute < close_print``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from samsulek.backtest.types import ExecutionTiming
from samsulek.data.bars import SessionCalendar
from samsulek.types import require_aware


class ClockError(RuntimeError):
    """The backtest clock was asked to move backwards. This is a bug: the run is void."""


class MonotoneClock:
    """A clock (``samsulek.clock.Clock``) that never goes back in time."""

    def __init__(self, start: datetime) -> None:
        require_aware(start, "backtest clock start")
        self._now = start.astimezone(UTC)

    def now(self) -> datetime:
        return self._now

    def set(self, ts: datetime) -> None:
        require_aware(ts, "backtest clock time")
        ts = ts.astimezone(UTC)
        if ts < self._now:
            raise ClockError(
                f"backtest clock moved backwards: from {self._now.isoformat()} to {ts.isoformat()}"
            )
        self._now = ts


@dataclass(frozen=True, slots=True)
class SessionTimes:
    session: date
    reset_at: datetime
    open_print: datetime
    execute: datetime
    close_print: datetime


def session_times(cal: SessionCalendar, session: date, timing: ExecutionTiming) -> SessionTimes:
    """The instants of ``session``. ``ValueError`` if it is not a session or the order breaks."""
    open_print = cal.open_print_utc(session)
    execute = open_print + timing.exec_delay
    reset_at = execute - timing.reset_lead
    close_print = cal.close_utc(session)
    if timing.exec_delay < timedelta(0) or not reset_at < execute < close_print:
        raise ValueError(
            f"session {session}: execution timing out of order (reset {reset_at.isoformat()}, "
            f"open print {open_print.isoformat()}, execute {execute.isoformat()}, "
            f"close {close_print.isoformat()})"
        )
    return SessionTimes(
        session=session, reset_at=reset_at, open_print=open_print, execute=execute, close_print=close_print
    )
