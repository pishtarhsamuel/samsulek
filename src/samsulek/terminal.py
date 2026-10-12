"""Typed confirmations read from a REAL terminal (not stdin, not a pipe).

Used for actions only a human present at the keyboard may take: starting live
trading and clearing a halt / kill. Each prompt includes a fresh random code,
so the answer can't be pre-scripted or piped in. Works on Windows (CONIN$/CONOUT$)
and on Linux/macOS (/dev/tty).
"""

from __future__ import annotations

import os
import secrets
import sys
from collections.abc import Callable
from typing import TextIO

Opener = Callable[[], tuple[TextIO, TextIO]]


class TerminalUnavailableError(RuntimeError):
    """No interactive terminal: refuse (fail closed)."""


def _open_console() -> tuple[TextIO, TextIO]:
    try:
        if os.name == "nt":
            fin = open("CONIN$", encoding="utf-8")  # noqa: SIM115
            fout = open("CONOUT$", "w", encoding="utf-8")  # noqa: SIM115
            return fin, fout
        # Separate read and write handles: a text-mode "r+" handle on a TTY is not seekable
        # and fails on first use.
        fin = open("/dev/tty", encoding="utf-8")  # noqa: SIM115
        fout = open("/dev/tty", "w", encoding="utf-8")  # noqa: SIM115
        return fin, fout
    except OSError as exc:
        raise TerminalUnavailableError("no interactive terminal available") from exc


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def require_interactive(stdin: TextIO | None = None, stdout: TextIO | None = None) -> None:
    sin = sys.stdin if stdin is None else stdin
    sout = sys.stdout if stdout is None else stdout
    if sin is None or sout is None or not sin.isatty() or not sout.isatty():
        raise TerminalUnavailableError(
            "this must be run by a person in an interactive terminal (stdin/stdout are not a TTY)"
        )


def confirm_phrase(prompt: str, expected: str, opener: Opener = _open_console) -> bool:
    """Show ``prompt`` on the terminal and return True only if the typed line equals ``expected``."""
    fin, fout = opener()
    try:
        fout.write(f"{prompt}\nType exactly:  {expected}\n> ")
        fout.flush()
        answer = fin.readline()
    finally:
        fin.close()
        if fout is not fin:
            fout.close()
    return answer.strip() == expected
