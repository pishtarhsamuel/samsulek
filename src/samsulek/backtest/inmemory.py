"""In-memory stand-ins for the bot's disk-backed parts (M3 skeleton; WP2 fills it in).

``MemoryRiskStateStore``, ``MemoryLedger`` and ``MemoryDecisionLog`` inherit ALL logic
from ``RiskStateStore``, ``Ledger`` and ``DecisionLog`` and replace only the file hooks, so
a backtest halts, resets and records exactly as the bot does. No file or folder is ever
created: the parent constructors that would create a folder are not called, and the path
they would use is ``_NOWHERE``, under the OS null device, where any accidental write
raises ``OSError`` instead of creating a file. ``in_memory = True`` marks the parts
``run_unlocked_cycle`` accepts. ``RecordingAlerter`` keeps alerts like ``ConsoleAlerter``
(redacted, logged as ``alert`` records) without console output.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from typing import Any, ClassVar, Final

from samsulek.clock import Clock
from samsulek.logging_setup import DecisionLog
from samsulek.portfolio.ledger import Ledger
from samsulek.risk.state import RiskStateStore

_NOWHERE: Final = Path(os.devnull) / "samsulek-in-memory-never-written"


class MemoryRiskStateStore(RiskStateStore):
    in_memory: ClassVar[bool] = True
    files: dict[str, str]  # file name -> json.dumps(data, indent=2, sort_keys=True)
    history: list[dict[str, str]]

    def __init__(self) -> None:
        raise NotImplementedError("WP2")


class MemoryLedger(Ledger):
    in_memory: ClassVar[bool] = True

    def __init__(self) -> None:
        raise NotImplementedError("WP2")

    def save(self) -> None:
        raise NotImplementedError("WP2")


class MemoryDecisionLog(DecisionLog):
    in_memory: ClassVar[bool] = True
    all_records: list[dict[str, Any]]  # keep_all only

    def __init__(self, clock: Clock, *, keep_all: bool) -> None:
        raise NotImplementedError("WP2")

    def write(self, kind: str, **fields: Any) -> dict[str, Any]:
        raise NotImplementedError("WP2")

    def drain_cycle(self) -> list[dict[str, Any]]:
        raise NotImplementedError("WP2")

    def read_day(self, day: date) -> list[dict[str, Any]]:
        raise NotImplementedError("WP2")

    def gz_bytes(self) -> bytes | None:
        raise NotImplementedError("WP2")


class RecordingAlerter:
    in_memory: ClassVar[bool] = True
    sent: list[tuple[str, str, str]]

    def __init__(self, log: MemoryDecisionLog) -> None:
        raise NotImplementedError("WP2")

    def alert(self, level: str, title: str, body: str = "") -> None:
        raise NotImplementedError("WP2")
