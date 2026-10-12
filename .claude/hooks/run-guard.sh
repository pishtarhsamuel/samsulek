#!/usr/bin/env bash
# Launches guard.py with a working Python 3, on Linux, macOS and Windows (Git Bash).
# Order: Windows `py -3` launcher, then python3, then python. Each candidate is
# probed first, so the Windows Store "python3" stub (which only opens the Store)
# is skipped. If no Python works, exit non-zero: settings.json sets
# onFailure=block, so the tool call is blocked (fail closed).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for cand in "py -3" python3 python; do
  # shellcheck disable=SC2086  # word-splitting of "py -3" is intended
  if $cand -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" </dev/null >/dev/null 2>&1; then
    exec $cand "$here/guard.py"
  fi
done
echo "guard hook: no working Python 3.10+ found (install Python 3.12 from python.org)" >&2
exit 1
