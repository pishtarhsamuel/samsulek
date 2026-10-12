#!/usr/bin/env python3
"""PreToolUse guardrail hook for Claude Code in this repository.

DENY (Claude cannot do these at all):
  - start the bot in live mode (LIVE=true in any spelling, persistent Windows
    user/machine variables or registry, --live, --mode live and abbreviations, mode: live)
  - reset a risk halt, clear the kill switch, or run code that calls the risk-state API
  - modify bot runtime state (state/ directory and its files, any case, path or glob)
  - read, write, or search .env files (any case, glob, brace form, NTFS stream) or wallet keypairs
  - dump environment variables or expand secret-looking variables (sh/PowerShell/cmd,
    python/node/perl/ruby/awk/jq, /proc/*/environ, Windows registry Environment)
  - move funds or create wallets via the Solana CLI
  - searches that ignore .gitignore, `git clean -x`, `git stash --all`

ASK (the owner must approve in the permission prompt):
  - edit guardrail files: .claude/settings*.json, .claude/hooks/,
    config/risk.yaml (hard risk limits), ops/go_live_checklist.md

Wildcards are judged by what they could MATCH (brace expansion + fnmatch), not by
how they look: bash rules for leading dots in the Bash tool, Windows rules (where
`*` matches dot-files) for PowerShell/cmd, ripgrep rules for the Grep/Glob tools.
Paths are compared case-insensitively with trailing dots/spaces and NTFS stream
suffixes removed, because the owner runs Windows. Input is decoded as UTF-8.
Fails closed: malformed input or an internal error results in DENY.
Standard library only, so it works before any project dependency is installed.

This is defense in depth, not a sandbox. Pattern checks can be evaded by a
determined process; the real backstops are (1) live credentials never exist
where Claude runs and (2) live mode and halt resets need typed confirmation on a
real terminal (TTY).
"""

from __future__ import annotations

import fnmatch
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
_REGISTRY_ENV = (
    r"\b(?:HKCU|HKLM|HKEY_CURRENT_USER|HKEY_LOCAL_MACHINE)\b:?[\\/]+(?:[^|;&\s'\"]*[\\/])?Environment\b"
)

LIVE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(rf"\b{_VAR}\s*=\s*{_TRUTHY}", re.I), "sets LIVE to a truthy value"),
    (re.compile(rf"\b{_VAR}\s*=\s*(?:\$\(|`|\$\{{?\w)", re.I), "sets LIVE from a computed value"),
    (re.compile(rf"\bexport\s+{_VAR}\b", re.I), "exports a LIVE variable"),
    (re.compile(rf"env:[\\/]?{_VAR}\b", re.I), "sets LIVE (PowerShell env: drive)"),
    (re.compile(rf"env:[\\/]?['\"]?\s+-Name\s+['\"]?{_VAR}\b", re.I), "sets LIVE (PowerShell env: drive)"),
    (re.compile(rf"\bsetx?\s+{_VAR}\b", re.I), "sets LIVE (Windows)"),
    (re.compile(r"SetEnvironmentVariable", re.I), "sets a persistent environment variable"),
    (re.compile(_REGISTRY_ENV, re.I), "touches the registry environment (persistent variables)"),
    (re.compile(r"\bWin32_Environment\b", re.I), "touches persistent environment variables"),
    (re.compile(r"(?<![\w-])--live(?![\w-])", re.I), "passes --live"),
    (re.compile(r"(?<![\w-])--m(?:o(?:d(?:e)?)?)?(?:\s+|\s*=\s*)[\"']?live\b", re.I), "passes --mode live"),
    (re.compile(r"\bmode\s*:\s*[\"']?live\b", re.I), "sets mode: live in a config"),
]

OWNER_ONLY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\breset-halt\b", re.I), "resets a risk halt"),
    (re.compile(r"--clear-kill\b", re.I), "clears the kill switch"),
]
# Only when the command RUNS code (python -c, heredoc, pipe into an interpreter);
# mentioning these names in git grep / pytest -k is fine.
STATE_API_RE = re.compile(r"\b(?:RiskStateStore|clear_halt|clear_kill|_clear_flag|write_day|write_peak)\b")
CODE_EXEC_RE = re.compile(
    r"(?:\bpython[\d.]*|\bpy|\buv\s+run\s+python[\d.]*)\b[^|;&]*\s-c\b"
    r"|<<"
    r"|\|\s*(?:python[\d.]*|py|uv\s+run\s+python[\d.]*)\b",
    re.I,
)

# .env or .env.<anything> in any case, also followed by glob chars, ':' streams or dots.
# Does not match .venv, .envrc, os.environ, process.env.X, or env.example.
ENV_FILE_RE = re.compile(r"(?:^|[^\w.])\.env(?!\w)", re.I)
ENV_NAMES = (".env", ".env.local", ".env.production")
STATE_NAMES = (
    "state",
    "halt.json",
    "kill.json",
    "risk_day.json",
    "equity_peak.json",
    "ledger.json",
    "sim_broker.json",
    "state_history.jsonl",
    "run.lock",
)

KEYPAIR_RE = re.compile(r"(?:\.config[/\\]solana|\bid\.json\b|keypair[^\s/\\]*\.json)", re.I)

# Prefixes after which a command word starts (so `cmd /c set`, `bash -c env`, `{ env; }` count).
_CMD_START = (
    r"(?:^|[;&|(`{]\s*|\b(?:then|do|else|command|builtin|exec|nohup|xargs|sudo|time)\s+"
    r"|\btimeout\s+\S+\s+|\b(?:ba|z|da)?sh\s+-c\s+|\bcmd(?:\.exe)?\s+/[ck]\s+)"
)

# Bare dump commands at a command start. Checked with quoted text blanked out.
BARE_DUMP_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(
            _CMD_START + r"(?:(?:/usr)?/bin/)?"
            r"(?:export|declare|typeset|export\s+-p|declare\s+-[a-zA-Z]*|typeset\s+-[a-zA-Z]*"
            r"|compgen\s+-[a-zA-Z]*e[a-zA-Z]*)"
            r"\s*(?=$|[;&|)>`}])",
            re.I,
        ),
        "bare export/declare dumps environment variables",
    ),
    (
        # `set` alone dumps everything; `cmd /c set PREFIX` dumps matching variables.
        re.compile(_CMD_START + r"set(?:\s+[A-Za-z_]\w*)?\s*(?=$|[;&|)>`}])", re.I),
        "set dumps environment variables",
    ),
    (
        # `env` is only allowed as `env NAME=value ... command`
        re.compile(
            _CMD_START + r"(?:(?:/usr)?/bin/)?env(?=\s|$|[;&|)>`}])"
            r"(?!(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)+\s+[^\s=;&|<>-])"
        ),
        "env without a command dumps environment variables",
    ),
]

# Everything else, checked on the raw text (double quotes still expand variables).
ENV_DUMP_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bprintenv\b", re.I), "printenv dumps environment variables"),
    (re.compile(r"/proc/\S*(?:environ|[*?\[])", re.I), "reads a process environment"),
    (
        re.compile(
            r"(?:Get-ChildItem|gci|dir|ls|Get-Item|gi|Get-Content|gc|type|cat)\s+"
            r"(?:-(?:Literal)?Path\s+)?env:",
            re.I,
        ),
        "dumps env (PowerShell)",
    ),
    (re.compile(r"\[(?:System\.)?Environment\]::GetEnvironmentVariables?\b", re.I), "reads env vars (.NET)"),
    (re.compile(r"\benvironb?\b|\bgetenv\b", re.I), "reads env vars from code"),
    (re.compile(r"\bprocess\.env\b|%ENV\b|\bruby\b[^|;&]*\bENV\b"), "reads env vars from code"),
    (re.compile(r"\bjq\b[^|;&]*(?:\benv\b|\$ENV\b)"), "reads env vars (jq)"),
    (re.compile(r"\$\{!"), "indirect variable expansion"),
    (re.compile(rf"\$\{{?{_SECRETISH}\}}?", re.I), "expands a secret-looking variable"),
    (re.compile(rf"\$\{{?env:{_SECRETISH}", re.I), "expands a secret-looking variable (PowerShell)"),
    (re.compile(rf"%{_SECRETISH}%", re.I), "expands a secret-looking variable (cmd)"),
]

# A dump command written in quotes as the command word itself: "env", 'set'.
QUOTED_CMD_DUMP_RE = re.compile(
    r"(?:^|[;&|(`{]\s*)[\"']+(?:env|printenv|set|export|declare|typeset)[\"']+(?=\s|$|[;&|)])", re.I
)

# Dumps hidden inside a quoted wrapper: bash -c "env", cmd /c "set" (checked on the quote-stripped text).
WRAPPED_DUMP_RE = re.compile(
    r"\b(?:(?:ba|z|da)?sh\s+-c|cmd(?:\.exe)?\s+/[ck]|powershell(?:\.exe)?\s+-c\w*|pwsh\s+-c\w*)\s+"
    r"(?:env|printenv|set|export|declare|typeset|Get-ChildItem\s+env:|gci\s+env:)(?=\s|$|[;&|)])",
    re.I,
)

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
        re.compile(r"\bgit\s+grep\b[^|;&]*--no-exclude-standard"),
        "git grep including ignored files can read .env; use the Grep tool",
    ),
    (
        re.compile(r"\b(?:Select-String|sls)\b[^|;&]*-Recurse|\bfindstr\b[^|;&]*\s/s\b", re.I),
        "recursive search ignores .gitignore and can read .env; use the Grep tool",
    ),
    (
        re.compile(
            r"\b(?:Get-ChildItem|gci|ls|dir)\b[^|]*\|\s*(?:Get-Content|gc|cat|type|Select-String|sls)\b"
            r"|\|\s*xargs\b[^|;&]*\b(?:cat|head|tail|less|more|grep|strings|type)\b"
            r"|-exec\s+(?:cat|head|tail|less|more|grep|strings)\b",
            re.I,
        ),
        "reads every listed file (would include .env); use the Read/Grep tools",
    ),
    (
        re.compile(r"\bgit\s+clean\b[^|;&]*\s-[a-zA-Z]*[xX]", re.I),
        "git clean -x deletes ignored files (secrets, bot state)",
    ),
    (
        re.compile(r"\bgit\s+stash\b[^|;&]*\s(?:-[a-zA-Z]*a[a-zA-Z]*|--a(?:l(?:l)?)?)(?=\s|$|=)"),
        "git stash --all removes ignored files (secrets, bot state)",
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

# Commands that write/delete files. `2>&1`, `>/dev/null`, `$null`, `nul` and `->` are not writes.
SHELL_WRITE_HINT_RE = re.compile(
    r"(?:(?<![-=])>(?!&|>?\s*(?:/dev/null|\$null|nul)\b)|\b(?:sed|perl)\b[^|;&]*\s-i|\s-delete\b"
    r"|\b(?:rm|rmdir|mv|cp|tee|chmod|chown|truncate|ln|dd|install|unlink|touch|shred)\b"
    r"|\bgit\s+(?:checkout|restore|rm|mv|reset|stash|apply|am)\b"
    r"|\b(?:Remove-Item|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Rename-Item|New-Item"
    r"|Clear-Content|Clear-Item|del|erase|rd|ren|move|copy|ri|sc|ac)\b"
    r"|\b(?:open|write_text|write_bytes|unlink|remove|rmtree|replace|rename)\s*\()",
    re.I,
)

# Bot runtime state (halt/kill flags, ledger): only the bot and the owner touch it.
STATE_IN_SHELL_RE = re.compile(
    r"(?:^|[\s/\\'\"=$(])state(?=$|[\s\"'/\\;|&)])"
    r"|\b(?:halt|kill|risk_day|equity_peak|ledger|sim_broker|state_history|run)\.(?:json|jsonl|lock)\b",
    re.I,
)

# Guardrail files: changing them needs the owner's explicit approval.
PROTECTED_IN_SHELL_RE = re.compile(
    r"(?:\.claude[/\\](?:settings[^\s/\\'\"]*\.json|hooks\b)"
    r"|config[/\\]risk\.ya?ml"
    r"|ops[/\\]go_live_checklist\.md)",
    re.I,
)
DISABLE_HOOKS_RE = re.compile(r"disableAllHooks", re.I)
# Signs that a command is interpreted with Windows wildcard rules (`*` matches dot-files).
WINDOWS_SHELL_RE = re.compile(
    r"\b(?:powershell|pwsh|cmd(?:\.exe)?|findstr|Select-String|sls|Get-Content|gc|Get-ChildItem|gci"
    r"|Remove-Item|ri|Copy-Item|Move-Item|type|dir|del|erase)\b",
    re.I,
)

# ---------------------------------------------------------------------------
# Wildcard semantics
# ---------------------------------------------------------------------------

_WORD_SPLIT_RE = re.compile(r"[\s;|&<>()`]+")
_GLOB_CHARS = frozenset("*?[{")


def brace_expand(word: str, budget: int = 64) -> list[str]:
    m = re.search(r"\{([^{}]*)\}", word)
    if not m or budget <= 0:
        return [word]
    out: list[str] = []
    for alt in m.group(1).split(","):
        out.extend(brace_expand(word[: m.start()] + alt + word[m.end() :], budget - 1))
        if len(out) > 256:
            break
    return out


def pattern_matches(pattern: str, names: tuple[str, ...], dotfiles_need_explicit_dot: bool) -> bool:
    """Could glob ``pattern`` (one path segment) match any of ``names``?"""
    pat = pattern.lower()
    for name in names:
        if dotfiles_need_explicit_dot and name.startswith(".") and not pat.startswith("."):
            # bash: a leading '*', '?' or '[...]' never matches a leading dot... except we
            # fail closed for bracket/? forms, which some shells and options do allow.
            if pat.startswith("*"):
                continue
        if fnmatch.fnmatchcase(name, pat):
            return True
    return False


def _segments(alt: str, last_only: bool) -> list[str]:
    segs = [s for s in re.split(r"[\\/]+", alt) if s]
    return segs[-1:] if last_only else segs


def glob_could_match(
    text: str, names: tuple[str, ...], dotfiles_need_explicit_dot: bool, *, last_only: bool
) -> bool:
    """Could any wildcard word in ``text`` match one of ``names``?

    ``last_only``: compare only the final path segment (for FILE names like .env);
    otherwise any segment (for the state FOLDER and its files).
    """
    for word in _WORD_SPLIT_RE.split(text):
        w = word.strip("'\"")
        if not w or not (set(w) & _GLOB_CHARS):
            continue
        for alt in brace_expand(w):
            for seg in _segments(alt, last_only):
                seg = seg.split(":", 1)[0]  # NTFS stream suffix (or a drive letter: harmless)
                if seg and pattern_matches(seg.rstrip(" ."), names, dotfiles_need_explicit_dot):
                    return True
    return False


# ---------------------------------------------------------------------------
# File-tool path patterns (applied to normalised, lower-case paths)
# ---------------------------------------------------------------------------

PROTECTED_PATH_RES = [
    re.compile(r"(?:^|/)\.claude/settings[^/]*\.json$"),
    re.compile(r"(?:^|/)\.claude/hooks(?:/|$)"),
    re.compile(r"(?:^|/)config/risk\.ya?ml$"),
    re.compile(r"(?:^|/)ops/go_live_checklist\.md$"),
]
STATE_PATH_RE = re.compile(r"(?:^|/)state(?:/|$)")
PROC_ENVIRON_RE = re.compile(r"^/proc/.*/environ$")

FILE_TOOLS = {"Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "PowerShell", "Monitor"}
_DRIVE_RE = re.compile(r"^[a-z]:$", re.I)


def _norm(path: str) -> str:
    """Lower-case, forward slashes, no NTFS stream suffix, no trailing dots/spaces, no '//' or '/./'."""
    out: list[str] = []
    segs = path.replace("\\", "/").strip().split("/")
    for i, seg in enumerate(segs):
        if seg == "." or (seg == "" and 0 < i < len(segs) - 1):
            continue
        if seg == "..":
            out.append(seg)
            continue
        if ":" in seg and not (i == 0 and _DRIVE_RE.match(seg)):
            seg = seg.split(":", 1)[0]
        out.append(seg.rstrip(" .").lower())
    return "/".join(out)


def is_secret_path(path: str) -> bool:
    p = _norm(path)
    name = p.rsplit("/", 1)[-1]
    if name == ".env" or name.startswith(".env."):
        return True
    if name == "id.json" or ("keypair" in name and name.endswith(".json")):
        return True
    return ".config/solana" in p or bool(PROC_ENVIRON_RE.match(p))


def is_protected_path(path: str) -> bool:
    p = _norm(path)
    return any(r.search(p) for r in PROTECTED_PATH_RES)


def is_state_path(path: str) -> bool:
    return bool(STATE_PATH_RE.search(_norm(path)))


def secret_glob(pattern: str) -> bool:
    """True if a Grep/Glob path or glob could target .env or keypair files (ripgrep rules: `*` matches dots)."""
    p = _norm(pattern)
    if is_secret_path(p) or "keypair" in p or ENV_FILE_RE.search(p):
        return True
    for alt in brace_expand(pattern):
        for seg in _segments(alt, last_only=True):
            if seg and pattern_matches(seg, (*ENV_NAMES, "id.json"), dotfiles_need_explicit_dot=False):
                return True
    return False


# ---------------------------------------------------------------------------
# Decisions
# ---------------------------------------------------------------------------

Decision = tuple[str, str] | None  # ("deny"|"ask", reason) or None = no opinion


def check_shell(command: str, tool: str = "Bash") -> Decision:
    windows = tool == "PowerShell" or bool(WINDOWS_SHELL_RE.search(command))
    # Variants: raw; quotes/escapes removed (catches L\IVE=true, "--li""ve", L`IVE);
    # quoted text blanked (so grep alternations like "a|env" aren't read as pipes).
    stripped = re.sub(r"[\\'\"`^]", "", command)
    dequoted = re.sub(r"'[^']*'|\"[^\"]*\"", "''", command)

    for cmd in (command, stripped):
        for pat, why in LIVE_PATTERNS:
            if pat.search(cmd):
                return ("deny", f"Blocked: command {why}. Only the owner starts live mode, by hand.")
        for pat, why in OWNER_ONLY_PATTERNS:
            if pat.search(cmd):
                return ("deny", f"Blocked: command {why}. Only the owner does that, by hand at a terminal.")
        if ENV_FILE_RE.search(cmd):
            return ("deny", "Blocked: command touches a .env file. Claude never reads secrets.")
        if KEYPAIR_RE.search(cmd):
            return ("deny", "Blocked: command touches a wallet keypair file.")
        for pat, why in FUNDS_PATTERNS:
            if pat.search(cmd):
                return ("deny", f"Blocked: command {why}. Only the owner moves funds or manages wallets.")
    if CODE_EXEC_RE.search(command) and STATE_API_RE.search(command):
        return ("deny", "Blocked: code calling the risk-state API. Only the bot and the owner change risk state.")
    if glob_could_match(command, ENV_NAMES, dotfiles_need_explicit_dot=not windows, last_only=True):
        return ("deny", "Blocked: a wildcard in this command could match the .env file. Name files explicitly.")
    # Anchored "bare command" dumps are checked with quoted text blanked out (a grep
    # alternation like "a|env" is not a pipe); everything else is checked on the raw text.
    for pat, why in BARE_DUMP_PATTERNS:
        if pat.search(dequoted):
            return ("deny", f"Blocked: {why}. Claude never prints secrets.")
    for pat, why in ENV_DUMP_PATTERNS:
        if pat.search(command):
            return ("deny", f"Blocked: {why}. Claude never prints secrets.")
    if QUOTED_CMD_DUMP_RE.search(command):
        return ("deny", "Blocked: quoted command dumps environment variables. Claude never prints secrets.")
    if WRAPPED_DUMP_RE.search(stripped):
        return ("deny", "Blocked: wrapped command dumps environment variables. Claude never prints secrets.")
    for pat, why in RECURSIVE_SEARCH_PATTERNS:
        if pat.search(command):
            return ("deny", f"Blocked: {why}.")
    writes = SHELL_WRITE_HINT_RE.search(dequoted) or SHELL_WRITE_HINT_RE.search(command)
    if writes and (
        STATE_IN_SHELL_RE.search(command)
        or STATE_IN_SHELL_RE.search(stripped)
        or glob_could_match(command, STATE_NAMES, dotfiles_need_explicit_dot=not windows, last_only=False)
    ):
        return ("deny", "Blocked: command may modify bot state (halt/kill flags, ledger). Owner only.")
    for cmd in (command, stripped):
        if DISABLE_HOOKS_RE.search(cmd):
            return ("ask", "Command mentions disableAllHooks. Owner approval required.")
        if PROTECTED_IN_SHELL_RE.search(cmd) and writes:
            return ("ask", "Command may modify a guardrail file. Owner approval required.")
    return None


def check_file_tool(tool: str, tool_input: dict[str, Any]) -> Decision:
    path = str(
        tool_input.get("file_path") or tool_input.get("notebook_path") or tool_input.get("path") or ""
    )
    if path and is_secret_path(path):
        return ("deny", "Blocked: .env, wallet keypair and process-environment files are off-limits.")
    if tool in WRITE_TOOLS and path and is_state_path(path):
        return ("deny", "Blocked: bot runtime state (halt/kill flags, ledger) is written only by the bot.")
    if tool in WRITE_TOOLS and path and is_protected_path(path):
        return ("ask", f"Editing guardrail file {path} needs the owner's explicit approval.")
    return None


def check_search_tool(path_like_values: list[Any]) -> Decision:
    for val in path_like_values:
        if isinstance(val, str) and val and secret_glob(val):
            return ("deny", "Blocked: search could include .env or wallet keypair files.")
    return None


def decide(payload: dict[str, Any]) -> Decision:
    tool = str(payload.get("tool_name", ""))
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return ("deny", "Guard hook: unexpected tool_input shape; failing closed.")
    if tool in SHELL_TOOLS:
        return check_shell(str(tool_input.get("command", "")), tool)
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
        # Claude Code sends UTF-8. Never decode with the Windows ANSI code page.
        raw = sys.stdin.buffer.read().decode("utf-8")
        payload = json.loads(raw or "{}")
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
