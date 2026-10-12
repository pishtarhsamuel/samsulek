"""Secrets never leak: not via repr, f-strings, logs, exceptions, or the decision log."""

from __future__ import annotations

import io
import logging
import pickle
from pathlib import Path

import pytest

from samsulek.clock import FixedClock
from samsulek.credentials import MissingSecretError, Secret, get_secret, load_env_file, redact
from samsulek.logging_setup import DecisionLog, JsonFormatter, RedactingFilter

FAKE = "sk-test-0123456789abcdef"  # a fake value used only in tests


def test_secret_never_prints_its_value() -> None:
    s = Secret("T212_DEMO_API_KEY", FAKE)
    for rendered in (repr(s), str(s), f"{s}", f"{s!r}", "%s" % (s,), format(s, ">40")):  # noqa: UP031
        assert FAKE not in rendered
        assert "****" in rendered
    assert s.reveal() == FAKE


def test_secret_cannot_be_pickled() -> None:
    with pytest.raises(TypeError):
        pickle.dumps(Secret("X_TOKEN", FAKE))


def test_get_secret_missing_names_variable_only() -> None:
    with pytest.raises(MissingSecretError, match="T212_DEMO_API_KEY"):
        get_secret("T212_DEMO_API_KEY", {})
    assert get_secret("A_KEY", {"A_KEY": FAKE}).reveal() == FAKE


def test_redact_registered_values_and_key_value_pairs() -> None:
    Secret("T212_DEMO_API_SECRET", FAKE)
    assert FAKE not in redact(f"request failed with header {FAKE}")
    assert redact("TELEGRAM_BOT_TOKEN=abc:def123 next") == "TELEGRAM_BOT_TOKEN=**** next"
    assert redact('api_key: "hunter2hunter2"') == "api_key: ****"


def test_load_env_file_rules(tmp_path: Path) -> None:
    env_file = tmp_path / "secrets.env"
    env_file.write_text(
        "﻿# comment\n"
        "T212_DEMO_API_KEY=demo-key-value-1\n"
        'TELEGRAM_BOT_TOKEN="quoted-token-value"\n'
        "export EXPORTED_TOKEN=exported-value\n"
        "LIVE=true\n"
        "T212_LIVE_API_KEY=live-key-value-9\n"
        "ALREADY_SET=from-file\n"
        "this line is malformed\n",
        encoding="utf-8",
    )
    environ = {"ALREADY_SET": "from-shell"}
    loaded = load_env_file(env_file, environ)
    assert loaded == ["T212_DEMO_API_KEY", "TELEGRAM_BOT_TOKEN", "EXPORTED_TOKEN"]
    assert environ["TELEGRAM_BOT_TOKEN"] == "quoted-token-value"
    assert environ["ALREADY_SET"] == "from-shell", "the file must never override the shell"
    assert "LIVE" not in environ, "LIVE must never come from a file"
    assert "T212_LIVE_API_KEY" not in environ, "live keys must not load outside live mode"
    assert "live-key-value-9" not in redact("x live-key-value-9 x"), "live values are still redacted"


def test_load_env_file_live_keys_only_when_allowed(tmp_path: Path) -> None:
    env_file = tmp_path / "secrets.env"
    env_file.write_text("T212_LIVE_API_KEY=live-key-value-9\nLIVE=true\n", encoding="utf-8")
    environ: dict[str, str] = {}
    assert load_env_file(env_file, environ, allow_live_secrets=True) == ["T212_LIVE_API_KEY"]
    assert "LIVE" not in environ


def test_missing_env_file_is_fine(tmp_path: Path) -> None:
    assert load_env_file(tmp_path / "absent.env", {}) == []


def test_logging_filter_redacts_messages_and_tracebacks() -> None:
    Secret("SOME_API_KEY", FAKE)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(RedactingFilter())
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("redaction-test")
    logger.addHandler(handler)
    logger.propagate = False
    try:
        logger.warning("calling broker with %s", FAKE)
        try:
            raise RuntimeError(f"auth failed for {FAKE}")
        except RuntimeError:
            logger.exception("boom")
    finally:
        logger.removeHandler(handler)
    out = stream.getvalue()
    assert FAKE not in out
    assert "****" in out


def test_decision_log_redacts(tmp_path: Path) -> None:
    from helpers import T0

    Secret("ANOTHER_TOKEN", FAKE)
    log = DecisionLog(tmp_path, FixedClock(T0))
    log.write("test", note=f"leaked {FAKE}?", nested={"x": FAKE})
    text = log.path_for(T0.date()).read_text(encoding="utf-8")
    assert FAKE not in text
    assert log.read_day(T0.date())[0]["kind"] == "test"
