"""Alerting. Telegram arrives in M5; until then alerts go to the log and the console."""

from __future__ import annotations

import logging
from typing import Protocol

from samsulek.credentials import redact
from samsulek.logging_setup import DecisionLog

log = logging.getLogger(__name__)


class Alerter(Protocol):
    def alert(self, level: str, title: str, body: str = "") -> None: ...


class ConsoleAlerter:
    """Writes alerts to the console (via logging) and the decision log. Never raises."""

    def __init__(self, decision_log: DecisionLog | None = None) -> None:
        self._log = decision_log
        self.sent: list[tuple[str, str, str]] = []

    def alert(self, level: str, title: str, body: str = "") -> None:
        title, body = redact(title), redact(body)
        self.sent.append((level, title, body))
        try:
            # Python prints WARNING+ to stderr even before logging is configured.
            log.warning("[ALERT %s] %s%s", level.upper(), title, f"\n  {body}" if body else "")
            if self._log:
                self._log.write("alert", level=level, title=title, body=body)
        except Exception:  # an alert failure must never break the safety path
            log.exception("failed to deliver alert")
