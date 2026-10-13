"""Base58 (Bitcoin alphabet): known vectors, real Solana addresses and signatures
from the recorded RPC answers (tests/fixtures/solana_rpc), and refusals."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from samsulek.data.sources.base58 import (
    ALPHABET,
    MAX_ENCODED_CHARS,
    b58decode,
    b58encode,
    is_pubkey,
    is_signature,
)

FIX = Path(__file__).parent / "fixtures" / "solana_rpc"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
REAL_ADDRESSES = [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC mint
    "BwJ3d66CxNdahNF6UsxzLgf31Ma5uG1vCixDGU9upump",  # a pump.fun mint (Token-2022)
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  # pump.fun program
    "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",  # pump.fun mint-authority PDA
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  # SPL Token program
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  # Token-2022 program
    "BPFLoaderUpgradeab1e11111111111111111111111",  # upgradeable loader (trailing 1s are digits)
]


def test_known_vectors() -> None:
    assert b58decode(SYSTEM_PROGRAM) == bytes(32)
    assert b58encode(bytes(32)) == SYSTEM_PROGRAM
    assert b58encode(b"hello world") == "StV1DL6CwTryKyV"  # the common Bitcoin test vector
    assert b58decode("StV1DL6CwTryKyV") == b"hello world"
    assert b58encode(b"") == "" and b58decode("") == b""
    assert b58encode(b"\0\0\x01") == "112" and b58decode("112") == b"\0\0\x01"
    assert b58encode(b"\x00\xff") == "15Q"
    assert b58encode(bytes([57])) == "z" and b58encode(bytes([58])) == "21"
    assert len(ALPHABET) == 58 and not set("0OIl") & set(ALPHABET)


@pytest.mark.parametrize("address", REAL_ADDRESSES)
def test_real_addresses_round_trip_as_32_bytes(address: str) -> None:
    raw = b58decode(address)
    assert len(raw) == 32
    assert b58encode(raw) == address
    assert is_pubkey(address) and not is_signature(address)


def test_real_signatures_from_the_recordings_are_64_bytes() -> None:
    answer = json.loads((FIX / "getSignaturesForAddress_pump_mintauth_pda_limit20.json").read_bytes())
    signatures = [item["signature"] for item in answer["result"]]
    assert len(signatures) == 20
    for signature in signatures:
        raw = b58decode(signature)
        assert len(raw) == 64 and b58encode(raw) == signature
        assert is_signature(signature) and not is_pubkey(signature)


def test_addresses_inside_the_mint_answer_round_trip() -> None:
    answer = json.loads((FIX / "getMultipleAccounts_mixed_jsonParsed.json").read_bytes())
    owners = [v["owner"] for v in answer["result"]["value"] if v is not None]
    assert owners and all(is_pubkey(o) and b58encode(b58decode(o)) == o for o in owners)


@pytest.mark.parametrize(
    "bad",
    ["0", "O", "I", "l", " 1", "1 ", "abc!", "EPjF\u0412dd", "\u0661\u0662", "1" * (MAX_ENCODED_CHARS + 1)],
)
def test_anything_but_plain_base58_is_refused(bad: str) -> None:
    with pytest.raises(ValueError, match="base58"):
        b58decode(bad)
    assert not is_pubkey(bad) and not is_signature(bad)


def test_wrong_types_and_lengths_are_not_keys() -> None:
    with pytest.raises(ValueError, match="string"):
        b58decode(b"111")  # type: ignore[arg-type]
    for not_bytes in (5, "abc", [0, 1]):  # bytes(5) would silently be five zero bytes
        with pytest.raises(ValueError, match="must be bytes"):
            b58encode(not_bytes)  # type: ignore[arg-type]
    assert b58encode(bytearray(b"hello world")) == b58encode(memoryview(b"hello world")) == "StV1DL6CwTryKyV"
    for not_a_key in (
        None,
        1,
        b"1" * 32,
        "",
        "1" * 31,
        "1" * 33,
        "z" * 44,  # a number too large for 32 bytes
        "2" * 30,  # too small
        REAL_ADDRESSES[0] + "1",
    ):
        assert not is_pubkey(not_a_key)
    assert is_pubkey("1" * 32) and is_signature("1" * 64)
    # base58 has no checksum: a shortened address can still be 32 bytes, so a typo is
    # only caught when the length changes. Never trust an address for its looks.
    assert is_pubkey(REAL_ADDRESSES[0][:-1])


@given(st.binary(max_size=64))
def test_round_trip_any_bytes(raw: bytes) -> None:
    text = b58encode(raw)
    assert set(text) <= set(ALPHABET)
    assert b58decode(text) == raw
