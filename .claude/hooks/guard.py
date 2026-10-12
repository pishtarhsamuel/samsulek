#!/usr/bin/env python3
"""PreToolUse guardrail hook for Claude Code in this repository.

DENY (Claude cannot do these at all):
  - start the bot in live mode (LIVE=true, --live, --mode live, mode: live, ...)
  - reset a risk halt or clear the kill switch (owner-only, by hand)
  - modify bot runtime state (state/: halt flag, kill flag, ledger)
  - read, write, or search .env files or Solana wallet keypair files
  - dump environment variables or expand secret-looking variables
  - move funds or create wallets via the Solana CLI
  - recursive grep that ignores .gitignore, or `git clean -x` (deletes .env/state)

ASK (the owner must approve in the permission prompt):
  - edit guardrail files: .claude/settings*.json, .claude/hooks/,
    config/risk.yaml (hard risk limits), ops/go_live_checklist.md

Covers bash, PowerShell and cmd spellings (the owner runs Windows).
Fails closed: malformed input or an internal error results in DENY.
Standard library only, so it works before any project dependency is installed.

This is defense in depth, not a sandbox. Regexes can be evaded by a determined
process; the real backstops are (1) live credentials never exist where Claude
runs and (2) live mode and halt resets need typed confirmation on a real
terminal (TTY).
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

# ---------------------------------------------------------------------------
# Shell command patterns
# ---------------------------------------------------------------------------

_VAR = r"(?:[A-Za-z0-9]+_)*LIVE"  # LIVE, SAMSULEK_LIVE, BOT_LIVE, ...
_TRUTHY = r"[\"']?(?:true|1|yes|on|y)\b"
_SECRETISH = r"[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|MNEMONIC|SEED_PHRASE)[A-Za-z0-9_]*"

LIVE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(rf"\b{_VAR}\s*=\s*{_TRUTHY}", re.I), "sets LIVE to a truthy value"),
    (re.compile(rf"\bexport\s+{_VAR}\b", re.I), "exports a LIVE variable"),
    (re.compile(rf"\$env:{_VAR}\b", re.I), "sets LIVE (PowerShell)"),
    (re.compile(rf"\bsetx?\s+{_VAR}\b", re.I), "sets LIVE (Windows)"),
    (re.compile(r"(?<![\w-])--live(?![\w-])", re.I), "passes --live"),
    (re.compile(r"--mode(?:\s+|\s*=\s*)[\"']?live\b", re.I), "passes --mode live"),
    (re.compile(r"\bmode\s*:\s*[\"']?live\b", re.I), "sets mode: live in a config"),
]

OWNER_ONLY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\breset-halt\b", re.I), "resets a risk halt"),
    (re.compile(r"--clear-kill\b", re.I), "clears the kill switch"),
]

# A path token that is .env or .env.<anything>. Does not match .venv, .envrc,
# os.environ, process.env.X, or env.example (the committed template).
ENV_FILE_RE = re.compile(
    r"(?:^|[\s/\\'\"=<>(:;|&`,])\.env(?:\.[A-Za-z0-9_.*-]+)?(?=$|[\s'\";|&)<>`,])"
)
# Globs that would expand to .env files, e.g. `cat .e*` or `cat .en?`.
ENV_GLOB_RE = re.compile(r"(?:^|[\s/\\'\"])\.en?[*?\[]")

KEYPAIR_RE = re.compile(
    r"(?:\.config[/\\]solana|\bid\.json\b|keypair[^\s/\\]*\.json)", re.I
)

ENV_DUMP_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bprintenv\b"), "printenv dumps environment variables"),
    (
        re.compile(
            r"(?:^|[;&|(`]\s*)(?:env|set|export\s+-p|declare\s+-[a-zA-Z]*x[a-zA-Z]*|compgen\s+-e)"
            r"\s*(?=$|[;&|)>`])",
            re.I,
        ),
        "bare env/set/export -p dumps environment variables",
    ),
    (re.compile(r"/proc/[^\s]*/environ"), "reads a process environment"),
    (
        re.compile(r"(?:Get-ChildItem|gci|dir|ls|Get-Item|gi|Get-Content|gc|type|cat)\s+env:", re.I),
        "dumps env (PowerShell)",
    ),
    (re.compile(r"\[(?:System\.)?Environment\]::GetEnvironmentVariables?\b", re.I), "reads env vars (.NET)"),
    (re.compile(r"\bos\.(?:environ|getenv)\b|\bgetenv\s*\("), "reads env vars from code"),
    (re.compile(rf"\$\{{?{_SECRETISH}\}}?", re.I), "expands a secret-looking variable"),
    (re.compile(rf"\$env:{_SECRETISH}", re.I), "expands a secret-looking variable (PowerShell)"),
    (re.compile(rf"%{_SECRETISH}%", re.I), "expands a secret-looking variable (cmd)"),
]

RECURSIVE_SEARCH_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"\b(?:grep|egrep|fgrep)\b[^|;&]*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b"),
        "recursive grep ignores .gitignore and can read .env; use the Grep tool",
    ),
    (
        re.compile(r"\brg\b[^|;&]*\s(?:-[a-zA-Z]*u[a-zA-Z]*|--no-ignore\S*|--hidden)\b"),
        "rg with ignore-overrides can read .env; use the Grep tool",
    ),
    (
        re.compile(r"\b(?:Select-String|sls)\b[^|;&]*-Recurse|\bfindstr\b[^|;&]*\s/s\b", re.I),
        "recursive search ignores .gitignore and can read .env; use the Grep tool",
    ),
    (
        re.compile(r"\bgit\s+clean\b[^|;&]*\s-[a-zA-Z]*[xX]", re.I),
        "git clean -x deletes ignored files (secrets, bot state)",
    ),
]

FUNDS_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"\bsolana\s+(?:transfer|pay|withdraw\S*|delegate\S*|stake\S*|close\S*)\b", re.I),
        "moves funds via the Solana CLI",
    ),
    (
        re.compile(r"\bspl-token\s+(?:transfer|burn|close|wrap|unwrap|approve|withdraw\S*)\b", re.I),
        "moves tokens via spl-token",
    ),
    (re.compile(r"\bsolana-keygen\b", re.I), "creates or recovers a wallet"),
]

# Commands that write/delete files (bash, PowerShell, cmd spellings).
SHELL_WRITE_HINT_RE = re.compile(
    r"(?:>|\b(?:sed|perl)\b[^|;&]*\s-i"
    r"|\b(?:rm|rmdir|mv|cp|tee|chmod|chown|truncate|ln|dd|install|unlink|touch|shred)\b"
    r"|\bgit\s+(?:checkout|restore|rm|mv|reset|stash|apply|am)\b"
    r"|\b(?:Remove-Item|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Rename-Item|New-Item"
    r"|Clear-Content|del|erase|rd|ren|move|copy|ri|sc|ac)\b"
    r"|\b(?:open|write_text|write_bytes|unlink|remove|rmtree)\s*\()",
    re.I,
)

# Bot runtime state (halt/kill flags, ledger): only the bot and the owner touch it.
STATE_IN_SHELL_RE = re.compile(
    r"(?:^|[\s/\\'\"=])state[/\\]"
    r"|\b(?:rm|rmdir|mv|Remove-Item|Move-Item|Rename-Item|del|erase|rd|ri|ren|move)\b[^|;&]*"
    r"\s[\"']?\.?[/\\]?state[\"']?(?=$|[\s;|&])",
    re.I,
)

# Guardrail files: changing them needs the owner's explicit approval.
PROTECTED_IN_SHELL_RE = re.compile(
    r"(?:\.claude[/\\](?:settings[^\s/\\'\"]*\.json|hooks\b)"
    r"|config[/\\]risk\.ya?ml"
    r"|ops[/\\]go_live_checklist\.md)"
)
DISABLE_HOOKS_RE = re.compile(r"disableAllHooks", re.I)

# ---------------------------------------------------------------------------
# File-tool path patterns
# ---------------------------------------------------------------------------

PROTECTED_PATH_RES = [
    re.compile(r"(?:^|/)\.claude/settings[^/]*\.json$"),
    re.compile(r"(?:^|/)\.claude/hooks(?:/|$)"),
    re.compile(r"(?:^|/)config/risk\.ya?ml$"),
    re.compile(r"(?:^|/)ops/go_live_checklist\.md$"),
]
STATE_PATH_RE = re.compile(r"(?:^|/)state(?:/|$)")

FILE_TOOLS = {"Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "PowerShell"}


def _norm(path: str) -> str:
    return path.replace("\\", "/").strip()


def is_secret_path(path: str) -> bool:
    p = _norm(path)
    name = p.rsplit("/", 1)[-1].lower()
    if name == ".env" or name.startswith(".env."):
        return True
    if name == "id.json" or ("keypair" in name and name.endswith(".json")):
        return True
    return ".config/solana" in p.lower()


def is_protected_path(path: str) -> bool:
    p = _norm(path)
    return any(r.search(p) for r in PROTECTED_PATH_RES)


def is_state_path(path: str) -> bool:
    return bool(STATE_PATH_RE.search(_norm(path)))


def secret_glob(pattern: str) -> bool:
    """True if a Grep/Glob path or glob could target .env or keypair files."""
    p = _norm(pattern).lower()
    return bool(
        re.search(r"(?:^|/|\{|,)\.e(?:n(?:v)?)?(?:$|[.*?\[{])", p)
        or is_secret_path(p)
        or "keypair" in p
    )


# ---------------------------------------------------------------------------
# Decisions
# ---------------------------------------------------------------------------

Decision = tuple[str, str] | None  # ("deny"|"ask", reason) or None = no opinion


def check_shell(command: str) -> Decision:
    # Check the raw command and a variant with quotes/backslashes/backticks
    # removed, to catch trivial obfuscation such as L\IVE=true or "--li""ve".
    variants = [command, re.sub(r"[\\'\"`^]", "", command)]
    for cmd in variants:
        for pat, why in LIVE_PATTERNS:
            if pat.search(cmd):
                return ("deny", f"Blocked: command {why}. Only the owner starts live mode, by hand.")
        for pat, why in OWNER_ONLY_PATTERNS:
            if pat.search(cmd):
                return ("deny", f"Blocked: command {why}. Only the owner does that, by hand at a terminal.")
        if ENV_FILE_RE.search(cmd) or ENV_GLOB_RE.search(cmd):
            return ("deny", "Blocked: command touches a .env file. Claude never reads or edits secrets.")
        if KEYPAIR_RE.search(cmd):
            return ("deny", "Blocked: command touches a wallet keypair file.")
        for pat, why in ENV_DUMP_PATTERNS:
            if pat.search(cmd):
                return ("deny", f"Blocked: {why}. Claude never prints secrets.")
        for pat, why in RECURSIVE_SEARCH_PATTERNS:
            if pat.search(cmd):
                return ("deny", f"Blocked: {why}.")
        for pat, why in FUNDS_PATTERNS:
            if pat.search(cmd):
                return ("deny", f"Blocked: command {why}. Only the owner moves funds or manages wallets.")
        if STATE_IN_SHELL_RE.search(cmd) and SHELL_WRITE_HINT_RE.search(cmd):
            return ("deny", "Blocked: command may modify bot state (halt/kill flags, ledger). Owner only.")
    for cmd in variants:
        if DISABLE_HOOKS_RE.search(cmd):
            return ("ask", "Command mentions disableAllHooks. Owner approval required.")
        if PROTECTED_IN_SHELL_RE.search(cmd) and SHELL_WRITE_HINT_RE.search(cmd):
            return ("ask", "Command may modify a guardrail file. Owner approval required.")
    return None


def check_file_tool(tool: str, tool_input: dict[str, Any]) -> Decision:
    path = str(
        tool_input.get("file_path") or tool_input.get("notebook_path") or tool_input.get("path") or ""
    )
    if path and is_secret_path(path):
        return ("deny", "Blocked: .env and wallet keypair files are off-limits to Claude.")
    if tool in WRITE_TOOLS and path and is_state_path(path):
        return ("deny", "Blocked: bot runtime state (halt/kill flags, ledger) is written only by the bot.")
    if tool in WRITE_TOOLS and path and is_protected_path(path):
        return ("ask", f"Editing guardrail file {path} needs the owner's explicit approval.")
    return None


def check_search_tool(path_like_values: list[Any]) -> Decision:
    for val in path_like_values:
        if isinstance(val, str) and val and secret_glob(val):
            return ("deny", "Blocked: search targets .env or wallet keypair files.")
    return None


def decide(payload: dict[str, Any]) -> Decision:
    tool = str(payload.get("tool_name", ""))
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return ("deny", "Guard hook: unexpected tool_input shape; failing closed.")
    if tool in SHELL_TOOLS:
        return check_shell(str(tool_input.get("command", "")))
    if tool in FILE_TOOLS:
        return check_file_tool(tool, tool_input)
    if tool == "Grep":  # Grep's `pattern` is the regex, not a path
        return check_search_tool([tool_input.get("path"), tool_input.get("glob")])
    if tool == "Glob":
        return check_search_tool([tool_input.get("path"), tool_input.get("pattern")])
    return None


def emit(decision: str, reason: str) -> None:
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }
    sys.stdout.write(json.dumps(out))


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            raise ValueError("payload is not an object")
        result = decide(payload)
    except Exception as exc:  # fail closed
        emit("deny", f"Guard hook error ({type(exc).__name__}); failing closed.")
        return 0
    if result is not None:
        emit(*result)
    # No output = no opinion: the normal permission flow continues.
    # Never emit "allow": that would skip the owner's permission prompts.
    return 0


if __name__ == "__main__":
    sys.exit(main())
