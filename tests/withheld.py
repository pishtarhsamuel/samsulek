"""Recorded provider responses that are kept out of the public repository.

DexScreener's terms forbid passing its data to third parties, and GeckoTerminal's terms
could not be checked, so their recorded response bodies are not published while the
repository is public (they are listed in .gitignore). Tests that need one skip with this
reason when the file is absent; everything else about these sources is still tested.
"""

from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
WITHHELD = frozenset(
    {
        "geckoterminal/solana_new_pools_p1_r2.json",
        "geckoterminal/solana_new_pools_p1_t0.json",
        "geckoterminal/solana_new_pools_p2_r5.json",
        "dexscreener/pairs_solana_batch30_new_gt.json",
    }
)
REASON = "recorded provider data withheld from the public repository (see tests/withheld.py)"


def read_fixture(relative: str) -> bytes:
    """The fixture's bytes; skips the test if it is a withheld file that isn't present."""
    path = FIXTURES / relative
    if relative in WITHHELD and not path.exists():
        pytest.skip(REASON)
    return path.read_bytes()
