"""Persistent risk state on disk: halt flag, kill flag, daily counters, peak equity.

Fail-closed rules:
- Writes are atomic (temp file + fsync + os.replace), so a crash never leaves a
  half-written file.
- A state file that exists but can't be read, decoded or parsed (wrong
  encoding, flipped bytes, wrong field types) raises ``StateCorruptError``;
  the risk engine treats that as HALTED.
- Clearing a halt or the kill flag is recorded in ``state_history.jsonl``.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from samsulek.credentials import redact
from samsulek.types import require_aware

HALT_FILE = "halt.json"
KILL_FILE = "kill.json"
DAY_FILE = "risk_day.json"
PEAK_FILE = "equity_peak.json"
HISTORY_FILE = "state_history.jsonl"


class StateCorruptError(RuntimeError):
    """A state file exists but can't be read. Treat as halted."""


@dataclass(frozen=True, slots=True)
class FlagState:
    active: bool
    reasons: tuple[str, ...] = ()
    since: datetime | None = None


@dataclass(frozen=True, slots=True)
class DayState:
    day: date
    day_start_equity: Decimal
    last_equity: Decimal
    trades: dict[str, int] = field(default_factory=dict)  # "total" and per market

    def trades_for(self, key: str) -> int:
        return self.trades.get(key, 0)


def atomic_write_text(path: Path, text: str, attempts: int = 5) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    last_exc: OSError | None = None
    for i in range(attempts):
        try:
            os.replace(tmp, path)
            return
        except PermissionError as exc:  # Windows: target briefly locked (antivirus, reader)
            last_exc = exc
            time.sleep(0.05 * (i + 1))
    tmp.unlink(missing_ok=True)
    raise last_exc or OSError(f"could not replace {path}")


class RiskStateStore:
    def __init__(self, state_dir: Path) -> None:
        self.dir = state_dir
        self.dir.mkdir(parents=True, exist_ok=True)

    # ---- low level -------------------------------------------------------
    def _read_json(self, name: str) -> dict[str, Any] | None:
        path = self.dir / name
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:  # ValueError: not UTF-8 (e.g. saved as UTF-16)
            raise StateCorruptError(f"cannot read {path}: {type(exc).__name__}") from exc
        try:
            data = json.loads(text)
        except ValueError as exc:
            raise StateCorruptError(f"{path} is not valid JSON") from exc
        if not isinstance(data, dict):
            raise StateCorruptError(f"{path} must contain a JSON object")
        return data

    def _write_json(self, name: str, data: dict[str, Any]) -> None:
        atomic_write_text(self.dir / name, json.dumps(data, indent=2, sort_keys=True))

    def _history(self, event: str, ts: datetime, **fields: str) -> None:
        """Append to the audit history. Best effort: the flag file itself is already written."""
        record = {"ts": ts.isoformat(), "event": event, **{k: redact(v) for k, v in fields.items()}}
        try:
            with (self.dir / HISTORY_FILE).open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, sort_keys=True) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
        except OSError:
            pass

    # ---- flags -----------------------------------------------------------
    def _read_flag(self, name: str) -> FlagState:
        data = self._read_json(name)
        if data is None:
            return FlagState(active=False)
        try:
            active = data["active"]
            reasons = data.get("reasons", [])
            since_raw = data.get("since")
            if not isinstance(active, bool) or not isinstance(reasons, list):
                raise TypeError("bad field types")
            since = datetime.fromisoformat(since_raw) if since_raw else None
        except Exception as exc:  # any damage: corrupt (fail closed), never a crash
            raise StateCorruptError(f"{name} has an invalid structure") from exc
        return FlagState(active=active, reasons=tuple(str(r) for r in reasons), since=since)

    def _set_flag(self, name: str, reason: str, ts: datetime) -> FlagState:
        require_aware(ts, "flag timestamp")
        reason = redact(reason)
        try:
            current = self._read_flag(name)
        except Exception:  # any damage: overwrite it with a valid ACTIVE flag
            current = FlagState(active=False)
        if current.active and reason in current.reasons:
            reasons = current.reasons
        else:
            reasons = (*current.reasons, reason) if current.active else (reason,)
        since = current.since if current.active and current.since else ts
        self._write_json(name, {"active": True, "reasons": list(reasons), "since": since.isoformat()})
        self._history(f"set:{name}", ts, reason=reason)
        return FlagState(active=True, reasons=reasons, since=since)

    def _clear_flag(self, name: str, ts: datetime, by: str) -> None:
        require_aware(ts, "flag timestamp")
        self._write_json(name, {"active": False, "reasons": [], "since": None})
        self._history(f"clear:{name}", ts, by=by)

    def read_halt(self) -> FlagState:
        return self._read_flag(HALT_FILE)

    def set_halt(self, reason: str, ts: datetime) -> FlagState:
        return self._set_flag(HALT_FILE, reason, ts)

    def clear_halt(self, ts: datetime, by: str) -> None:
        self._clear_flag(HALT_FILE, ts, by)

    def read_kill(self) -> FlagState:
        return self._read_flag(KILL_FILE)

    def set_kill(self, reason: str, ts: datetime) -> FlagState:
        return self._set_flag(KILL_FILE, reason, ts)

    def clear_kill(self, ts: datetime, by: str) -> None:
        self._clear_flag(KILL_FILE, ts, by)

    # ---- day counters / equity --------------------------------------------
    def read_day(self) -> DayState | None:
        data = self._read_json(DAY_FILE)
        if data is None:
            return None
        try:
            trades = data["trades"]
            if not isinstance(trades, dict) or not all(
                isinstance(k, str) and isinstance(v, int) and v >= 0 for k, v in trades.items()
            ):
                raise TypeError("bad trades")
            start = Decimal(data["day_start_equity"])
            last = Decimal(data["last_equity"])
            if not (start.is_finite() and last.is_finite()) or start < 0 or last < 0:
                raise ValueError("equity values must be finite and >= 0")
            return DayState(
                day=date.fromisoformat(data["day"]),
                day_start_equity=start,
                last_equity=last,
                trades=dict(trades),
            )
        except Exception as exc:  # any damage: corrupt (fail closed), never a crash
            raise StateCorruptError(f"{DAY_FILE} has an invalid structure") from exc

    def write_day(self, state: DayState) -> None:
        self._write_json(
            DAY_FILE,
            {
                "day": state.day.isoformat(),
                "day_start_equity": str(state.day_start_equity),
                "last_equity": str(state.last_equity),
                "trades": dict(state.trades),
            },
        )

    def read_peak(self) -> Decimal | None:
        data = self._read_json(PEAK_FILE)
        if data is None:
            return None
        try:
            peak = Decimal(data["peak_equity"])
        except Exception as exc:  # e.g. Decimal([]) raises ValueError: corrupt, never a crash
            raise StateCorruptError(f"{PEAK_FILE} has an invalid structure") from exc
        if not peak.is_finite() or peak <= 0:
            raise StateCorruptError(f"{PEAK_FILE} has a non-positive peak")
        return peak

    def write_peak(self, peak: Decimal) -> None:
        self._write_json(PEAK_FILE, {"peak_equity": str(peak)})
