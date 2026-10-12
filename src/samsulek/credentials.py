"""Secrets come only from environment variables (optionally loaded from a gitignored file).

Rules enforced here:
- A secret's value never appears in repr/str/format, logs, or the decision log
  (values are registered for redaction the moment they are read).
- ``LIVE`` is never taken from the env file: it must be set in the terminal for
  the session, so one factor of the live gate is never permanently "on".
- Live-only credentials (``*_LIVE_*``) are not loaded unless explicitly allowed,
  so sim/paper processes never even hold live keys.
"""

from __future__ import annotations

import os
import re
from collections.abc import MutableMapping
from pathlib import Path
from typing import NoReturn

_MIN_REDACT_LEN = 4
_REDACTED = "****"
_registered: set[str] = set()

_SECRET_NAME = r"[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|MNEMONIC|SEED_PHRASE)[A-Z0-9_]*"  # noqa: S105
_SECRET_NAME_RE = re.compile(rf"(?i)^{_SECRET_NAME}$")
# Matches NAME=value / NAME: value where NAME looks secret-ish. The value stops at
# separators so JSON or query strings around it are not swallowed.
_KV_SECRET_RE = re.compile(rf"(?i)\b({_SECRET_NAME})(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|[^\s\"',;}}&]+)")
# Values of non-secret-looking variables are only redacted when long enough to be
# unambiguous; short ones ("true", "1234") would corrupt unrelated log text.
_MIN_PLAIN_VALUE_LEN = 12

LIVE_VAR = "LIVE"
_LIVE_ONLY_RE = re.compile(r"(?:^|_)LIVE(?:_|$)")


class MissingSecretError(KeyError):
    """A required secret is not set. The message names the variable, never a value."""


def register_for_redaction(value: str) -> None:
    if len(value) >= _MIN_REDACT_LEN:
        _registered.add(value)


def redact(text: str) -> str:
    """Remove every registered secret value and any NAME=value secret-looking pair."""
    for value in sorted(_registered, key=len, reverse=True):
        if value in text:
            text = text.replace(value, _REDACTED)
    return _KV_SECRET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{_REDACTED}", text)


class Secret:
    """Wraps a secret value. Only ``reveal()`` returns it; everything else prints ****."""

    __slots__ = ("_value", "name")

    def __init__(self, name: str, value: str) -> None:
        self.name = name
        self._value = value
        register_for_redaction(value)

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return f"Secret({self.name}={_REDACTED})"

    __str__ = __repr__

    def __format__(self, format_spec: str) -> str:
        return repr(self)

    def __reduce__(self) -> NoReturn:
        raise TypeError("secrets cannot be pickled")


def get_secret(name: str, environ: MutableMapping[str, str] | None = None) -> Secret:
    env = os.environ if environ is None else environ
    value = env.get(name)
    if not value:
        raise MissingSecretError(f"environment variable {name} is not set")
    return Secret(name, value)


def is_live_only(name: str) -> bool:
    return bool(_LIVE_ONLY_RE.search(name.upper()))


_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def _parse_value(raw: str) -> str:
    """dotenv-style value: quoted -> up to the matching quote; unquoted -> cut at ' #' comment."""
    if raw[:1] in ("'", '"'):
        end = raw.find(raw[0], 1)
        return raw[1:end] if end != -1 else raw[1:]
    m = re.search(r"\s#", raw)
    return (raw[: m.start()] if m else raw).strip()


def load_env_file(
    path: Path,
    environ: MutableMapping[str, str] | None = None,
    *,
    allow_live_secrets: bool = False,
) -> list[str]:
    """Load NAME=value lines into ``environ`` without overriding existing variables.

    Returns the names loaded (never values). Missing file is fine (returns []).
    ``LIVE`` is always ignored. Names containing a ``LIVE`` word (``T212_LIVE_KEY``,
    ``KEY_LIVE``) are ignored unless allowed.
    """
    env = os.environ if environ is None else environ
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return []
    loaded: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _LINE_RE.match(line)
        if not m:
            continue  # never echo the malformed line: it may contain a secret
        name, value = m.group(1), _parse_value(m.group(2))
        if (
            value
            and name.upper() != LIVE_VAR
            and (_SECRET_NAME_RE.match(name) or is_live_only(name) or len(value) >= _MIN_PLAIN_VALUE_LEN)
        ):
            register_for_redaction(value)  # even values we skip below must never be logged
        if name.upper() == LIVE_VAR:
            continue
        if is_live_only(name) and not allow_live_secrets:
            continue
        if name in env:
            continue
        env[name] = value
        loaded.append(name)
    return loaded
