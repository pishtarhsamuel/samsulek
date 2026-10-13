"""pump.fun bonding-curve decoder, tested on the REAL account bytes recorded 2026-10-12
21:27:39 UTC (the VeilCat curve inside tests/fixtures/solana_rpc/
getMultipleAccounts_mixed_jsonParsed.json) and checked field by field against the IDL
(pump-fun/pump-public-docs idl/pump.json at 2293f9a6)."""

from __future__ import annotations

import base64
import dataclasses
import json
import struct
from pathlib import Path

import pytest

from samsulek.data.sources.base58 import b58decode, is_pubkey
from samsulek.data.sources.pumpfun import (
    BONDING_CURVE_DISCRIMINATOR,
    BONDING_CURVE_SIZE,
    MINT_AUTHORITY_PDA,
    PROGRAM_ID,
    BondingCurve,
    PumpFormatError,
    decode_bonding_curve,
)

FIX = Path(__file__).parent / "fixtures" / "solana_rpc"
CURVE_ADDRESS = "CTwNRBQWaDQ9dMkRLiZyBfGpdDdfcHDRxUQazspznzez"
CREATOR = "EVqx653MoY6esB9L6qruh3dTThCV4B43cBSsVWx9LQty"
QUOTE_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"

# IDL field order and Borsh sizes: (name, offset after the discriminator, size).
IDL_FIELDS = [
    ("virtual_token_reserves", 8),
    ("virtual_quote_reserves", 8),
    ("real_token_reserves", 8),
    ("real_quote_reserves", 8),
    ("token_total_supply", 8),
    ("complete", 1),
    ("creator", 32),
    ("is_mayhem_mode", 1),
    ("is_cashback_coin", 1),
    ("quote_mint", 32),
    ("creator_fee_bps", 8),
    ("can_edit_creator_fee", 1),
    ("is_holder_reward", 1),
    ("creator_fee", 8),
    ("protocol_fees", 8),
    ("depth", 1),
    ("initial_virtual_quote_reserves", 8),
    ("post_complete_base_out", 8),
    ("post_complete_quote_in", 8),
]


def offset_of(name: str) -> int:
    offset = 8
    for field_name, size in IDL_FIELDS:
        if field_name == name:
            return offset
        offset += size
    raise KeyError(name)


def real_curve() -> bytes:
    answer = json.loads((FIX / "getMultipleAccounts_mixed_jsonParsed.json").read_bytes())
    account = answer["result"]["value"][1]  # requested second: the VeilCat bonding curve
    assert account["owner"] == PROGRAM_ID and account["space"] == 166
    data, encoding = account["data"]
    assert encoding == "base64"
    return base64.b64decode(data, validate=True)


def test_constants_match_the_idl() -> None:
    assert is_pubkey(PROGRAM_ID) and is_pubkey(MINT_AUTHORITY_PDA)
    assert list(BONDING_CURVE_DISCRIMINATOR) == [23, 183, 248, 55, 96, 216, 172, 96]
    assert BONDING_CURVE_SIZE == 8 + sum(size for _, size in IDL_FIELDS) == 166
    assert [f.name for f in dataclasses.fields(BondingCurve)] == [name for name, _ in IDL_FIELDS]


def test_decodes_the_real_curve_field_by_field() -> None:
    curve = decode_bonding_curve(real_curve())
    assert curve == BondingCurve(
        virtual_token_reserves=1_073_000_000_000_000,
        virtual_quote_reserves=633_634_814_948,
        real_token_reserves=793_100_000_000_000,
        real_quote_reserves=2,
        token_total_supply=1_000_000_000_000_000,
        complete=False,
        creator=CREATOR,
        is_mayhem_mode=False,
        is_cashback_coin=False,
        quote_mint=QUOTE_MINT,  # not SOL: coins can be paired with other quote mints
        creator_fee_bps=300,
        can_edit_creator_fee=False,
        is_holder_reward=False,
        creator_fee=0,
        protocol_fees=15_145_960,
        depth=0,
        initial_virtual_quote_reserves=633_634_814_946,
        post_complete_base_out=0,
        post_complete_quote_in=0,
    )


def test_every_integer_is_little_endian_and_unsigned_as_in_the_idl() -> None:
    data = bytearray(real_curve())
    at = offset_of("virtual_quote_reserves")
    data[at : at + 8] = (2**64 - 1).to_bytes(8, "little")  # would be -1 if read as signed
    at = offset_of("depth")
    data[at] = 255
    curve = decode_bonding_curve(bytes(data))
    assert curve.virtual_quote_reserves == 2**64 - 1 and curve.depth == 255
    at = offset_of("creator")
    data[at : at + 32] = b58decode(PROGRAM_ID)
    assert decode_bonding_curve(bytes(data)).creator == PROGRAM_ID


@pytest.mark.parametrize("name", [n for n, size in IDL_FIELDS if size == 1 and n != "depth"])
def test_bools_must_be_zero_or_one(name: str) -> None:
    data = bytearray(real_curve())
    data[offset_of(name)] = 1
    assert getattr(decode_bonding_curve(bytes(data)), name) is True
    data[offset_of(name)] = 2
    with pytest.raises(PumpFormatError, match=name):
        decode_bonding_curve(bytes(data))


@pytest.mark.parametrize("size", [0, 8, 150, 165, 167, 200])
def test_any_other_length_is_an_unknown_layout(size: int) -> None:
    data = (real_curve() + bytes(64))[:size]
    with pytest.raises(PumpFormatError, match="166 bytes"):
        decode_bonding_curve(data)


def test_a_different_account_type_is_refused() -> None:
    data = bytearray(real_curve())
    data[0] ^= 1
    with pytest.raises(PumpFormatError, match="discriminator"):
        decode_bonding_curve(bytes(data))
    global_account = bytes([167, 232, 232, 177, 200, 108, 114, 127]) + bytes(real_curve()[8:])  # IDL "Global"
    with pytest.raises(PumpFormatError, match="discriminator"):
        decode_bonding_curve(global_account)


def test_non_bytes_are_refused() -> None:
    for bad in (base64.b64encode(real_curve()).decode(), None, list(real_curve())):
        with pytest.raises(PumpFormatError, match="expected bytes"):
            decode_bonding_curve(bad)  # type: ignore[arg-type]


def test_format_errors_are_value_errors_for_the_recorder() -> None:
    # The recorder records a ValueError from the decoder as "undecodable" instead of guessing.
    assert issubclass(PumpFormatError, ValueError)
    assert struct.calcsize("<8s5QB32sBB32sQBBQQBQQQ") == BONDING_CURVE_SIZE
    assert CURVE_ADDRESS != PROGRAM_ID
