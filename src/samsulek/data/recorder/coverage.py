"""Coverage bookkeeping: when was the recorder watching, and when was a source down?

Written to the journal stream ``coverage``:
- ``start`` / ``stop`` events for each run;
- ``gap`` records, each with ``start``/``end`` (UTC) and a ``kind``:
  ``not_running`` - from the last heartbeat before this run to this run's start
  (conservative: the downtime really began somewhere after that heartbeat);
  ``source_down`` - a source kept failing from its first failure to its next success
  (or to ``stop``, flagged ``open_at_stop``);
  ``task_off`` - a task switched off after an error it must not guess past, from then
  to ``stop`` (always ``open_at_stop``: only a restart switches it back on). Other
  tasks of the same source succeeding does not close it.
  A ``not_running`` gap with ``reason: stalled`` is written when the loop itself froze
  for longer than STALL_GAP (the PC slept, the console was paused): the process was
  alive but observing nothing. After an unclean exit (power cut, window closed) the next
  start closes the outages and switched-off tasks the last heartbeat still listed, with
  ``open_at_crash``.
- ``stop`` events carry a ``reason`` (``ctrl_c``, ``time_limit``, ``error``...).
Research must treat anything inside a gap as "not observed", never as "nothing happened".

The heartbeat file also carries the sources failing and the tasks switched off right now,
so `record status` can show them however long ago they started.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

from samsulek.clock import Clock
from samsulek.data.recorder.journal import Journal
from samsulek.fsutil import atomic_write_text

STREAM = "coverage"
STATE_FILE = "heartbeat.json"
STALL_GAP = timedelta(minutes=5)  # a longer pause between beats means nothing was watched


class Coverage:
    def __init__(
        self,
        journal: Journal,
        root: Path,
        clock: Clock,
        recorder: str,
        beat_every: timedelta = timedelta(seconds=60),
    ) -> None:
        self._journal = journal
        self._state = root / f"{recorder}_{STATE_FILE}"
        self._clock = clock
        self._recorder = recorder
        self._beat_every = beat_every
        self._last_beat: datetime | None = None
        self._failing: dict[str, tuple[datetime, str]] = {}  # source -> (since, first error)
        self._off: dict[str, tuple[datetime, str, str]] = {}  # task -> (since, source, reason)

    def start(self) -> None:
        now = self._clock.now()
        previous, failing, off = self._read_previous()
        if previous is not None:
            # A clean stop leaves these empty: anything listed died with the process.
            for source, since in failing.items():
                if since < previous:
                    self._gap("source_down", since, previous, source=source, open_at_crash=True)
            for task, (since, source) in off.items():
                if since < previous:
                    self._gap("task_off", since, previous, task=task, source=source, open_at_crash=True)
        if previous is not None and previous < now:
            self._gap("not_running", previous, now)
        self._journal.append(STREAM, {"event": "start", "recorder": self._recorder, "pid": os.getpid()})
        self._journal.sync()
        self._write_beat(now)

    def beat(self) -> None:
        now = self._clock.now()
        if self._last_beat is not None and now - self._last_beat > STALL_GAP:
            # Alive but frozen (sleep, a paused console, a huge clock step): not observed.
            self._gap("not_running", self._last_beat, now, reason="stalled")
        if self._last_beat is None or now - self._last_beat >= self._beat_every:
            # Records first, heartbeat second: the heartbeat must never vouch for
            # records that a power cut could still take away.
            self._journal.sync()
            self._write_beat(now)

    def source_failed(self, source: str, error: str) -> None:
        if source not in self._failing:
            self._failing[source] = (self._clock.now(), error)
            self._journal.append(STREAM, {"event": "source_down", "source": source, "error": error[:500]})

    def source_ok(self, source: str) -> None:
        failing = self._failing.pop(source, None)
        if failing is not None:
            self._gap("source_down", failing[0], self._clock.now(), source=source, error=failing[1][:500])

    def task_off(self, task: str, source: str, reason: str) -> None:
        """A task is switched off for the rest of this run; its gap stays open until stop."""
        if task in self._off:
            return
        now = self._clock.now()
        self._off[task] = (now, source, reason)
        self._journal.append(
            STREAM, {"event": "task_off", "task": task, "source": source, "reason": reason[:500]}
        )
        self._journal.sync()
        self._write_beat(now)  # visible in `record status` at once

    def stop(self, reason: str = "stopped", error: str | None = None) -> None:
        now = self._clock.now()
        for source, (since, first_error) in sorted(self._failing.items()):
            self._gap("source_down", since, now, source=source, error=first_error[:500], open_at_stop=True)
        self._failing.clear()
        for task, (since, task_source, why) in sorted(self._off.items()):
            self._gap(
                "task_off", since, now, task=task, source=task_source, error=why[:500], open_at_stop=True
            )
        self._off.clear()
        stop: dict[str, object] = {"event": "stop", "recorder": self._recorder, "reason": reason}
        if error is not None:
            stop["error"] = error[:500]
        self._journal.append(STREAM, stop)
        self._journal.sync()
        self._write_beat(now)

    @property
    def failing_sources(self) -> list[str]:
        return sorted(self._failing)

    def _gap(self, kind: str, start: datetime, end: datetime, **extra: object) -> None:
        self._journal.append(
            STREAM,
            {
                "event": "gap",
                "kind": kind,
                "recorder": self._recorder,
                "start": start.astimezone(UTC).isoformat(),
                "end": end.astimezone(UTC).isoformat(),
                "seconds": round((end - start).total_seconds(), 3),
                **extra,
            },
        )

    def _write_beat(self, now: datetime) -> None:
        state = {
            "last_beat": now.astimezone(UTC).isoformat(),
            "failing": {
                s: {"since": t.astimezone(UTC).isoformat(), "error": e[:200]}
                for s, (t, e) in sorted(self._failing.items())
            },
            "off": {
                task: {"since": t.astimezone(UTC).isoformat(), "source": s, "reason": r[:200]}
                for task, (t, s, r) in sorted(self._off.items())
            },
        }
        atomic_write_text(self._state, json.dumps(state))
        self._last_beat = now

    def _read_previous(
        self,
    ) -> tuple[datetime | None, dict[str, datetime], dict[str, tuple[datetime, str]]]:
        """The previous run's last heartbeat, and the outages and switched-off tasks it
        still listed. Unreadable -> nothing, and the journal says so."""
        none: tuple[None, dict[str, datetime], dict[str, tuple[datetime, str]]] = (None, {}, {})
        try:
            raw = self._state.read_text(encoding="utf-8")
        except FileNotFoundError:
            return none
        except (OSError, ValueError) as exc:
            self._journal.append(STREAM, {"event": "heartbeat_unreadable", "error": type(exc).__name__})
            return none
        try:
            state = json.loads(raw)
            value = _aware(state["last_beat"])
        except Exception as exc:  # damaged file: say so; the gap length is then unknown
            self._journal.append(STREAM, {"event": "heartbeat_unreadable", "error": type(exc).__name__})
            return none
        failing: dict[str, datetime] = {}
        off: dict[str, tuple[datetime, str]] = {}
        try:  # older heartbeats have neither map; a damaged entry is just skipped
            for source, entry in (state.get("failing") or {}).items():
                failing[str(source)] = _aware(entry["since"])
            for task, entry in (state.get("off") or {}).items():
                off[str(task)] = (_aware(entry["since"]), str(entry.get("source")))
        except Exception as exc:
            self._journal.append(STREAM, {"event": "heartbeat_unreadable", "error": type(exc).__name__})
        return value, failing, off


def _aware(text: object) -> datetime:
    value = datetime.fromisoformat(str(text))
    if value.tzinfo is None:
        raise ValueError("naive timestamp")
    return value
