"""Application logging and the decision log (append-only JSONL audit trail).

Every line written anywhere passes through ``redact`` first.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any

from samsulek.clock import Clock
from samsulek.credentials import redact


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = redact(record.getMessage())
        if record.exc_info:
            formatter = logging.Formatter()
            msg = msg + "\n" + redact(formatter.formatException(record.exc_info))
            record.exc_info = None
            record.exc_text = None
        record.msg = msg
        record.args = None
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created).astimezone().isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        return redact(json.dumps(payload, ensure_ascii=True))


def setup_logging(log_dir: Path, level: int = logging.INFO) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(level)
    for h in list(root.handlers):
        root.removeHandler(h)
    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    console.addFilter(RedactingFilter())
    file_handler = logging.FileHandler(log_dir / "samsulek.log", encoding="utf-8")
    file_handler.setFormatter(JsonFormatter())
    file_handler.addFilter(RedactingFilter())
    root.addHandler(console)
    root.addHandler(file_handler)


def to_jsonable(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        return str(obj)
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, Path):
        return str(obj)
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: to_jsonable(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [to_jsonable(v) for v in obj]
    return obj


class DecisionLog:
    """One JSON object per line: what happened, when, and WHY."""

    def __init__(self, log_dir: Path, clock: Clock) -> None:
        self._dir = log_dir
        self._clock = clock
        self._dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, day: date) -> Path:
        return self._dir / f"decisions-{day.isoformat()}.jsonl"

    def write(self, kind: str, **fields: Any) -> dict[str, Any]:
        now = self._clock.now()
        record: dict[str, Any] = {"ts": now.isoformat(), "kind": kind}
        record.update(to_jsonable(fields))
        line = redact(json.dumps(record, ensure_ascii=True, sort_keys=False))
        path = self.path_for(now.date())
        with path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return record

    def read_day(self, day: date) -> list[dict[str, Any]]:
        path = self.path_for(day)
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
