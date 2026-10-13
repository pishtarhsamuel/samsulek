"""pump.fun constants and the bonding-curve account decoder (research/simulation only).

Facts this module relies on (checked 2026-10-12 against the pump.fun IDL in
github.com/pump-fun/pump-public-docs at commit 2293f9a66c654e9fe82dc5e8f4618538f24bb35f,
https://github.com/pump-fun/pump-public-docs/blob/2293f9a66c654e9fe82dc5e8f4618538f24bb35f/idl/pump.json,
and live mainnet reads; pump.fun's own site was unreachable from the build environment,
so the GitHub org is not independently proven official - the program id is
cross-checked on-chain instead):
- Program id 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P (IDL "address"). On-chain:
  pump-fun pools listed by GeckoTerminal are accounts owned by it, and their addresses
  equal PDA(["bonding-curve", mint]) derived from this id.
- Mint-authority PDA TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM: seeds
  ["mint-authority"] (bump 255, derived offline). In the IDL only the ``create`` and
  ``create_v2`` instructions take this account, so its transaction list is a stream of
  coin creations (other transactions could still mention it: verify before counting).
- Account ``BondingCurve``: discriminator [23,183,248,55,96,216,172,96], then the IDL
  fields in order, Borsh little-endian, no padding: u64 virtual_token_reserves,
  u64 virtual_quote_reserves, u64 real_token_reserves, u64 real_quote_reserves,
  u64 token_total_supply, bool complete, pubkey creator, bool is_mayhem_mode,
  bool is_cashback_coin, pubkey quote_mint, u64 creator_fee_bps,
  bool can_edit_creator_fee, bool is_holder_reward, u64 creator_fee, u64 protocol_fees,
  u8 depth, u64 initial_virtual_quote_reserves, u64 post_complete_base_out,
  u64 post_complete_quote_in. 8 + 158 = 166 bytes, which matches the live account size
  (``space`` 166) of a real curve read 2026-10-12 21:27 UTC.
- Every field of BondingCurve is unsigned in this IDL. The "negative virtual quote
  reserves" note in the same repo (docs/NEGATIVE_VIRTUAL_QUOTE_RESERVES.md) is about the
  PumpSwap ``Pool`` account (pump_amm.json, an i128), not this account.
- Coins are not always paired with SOL: the live curve had
  quote_mint pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn.
- pump.fun changes its program often and the account has grown new fields before. So
  the decoder accepts exactly one layout (discriminator AND exact length AND bools that
  are 0 or 1); anything else raises PumpFormatError instead of guessing. Re-check the
  IDL at every milestone.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from samsulek.data.sources.base58 import b58encode

PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
MINT_AUTHORITY_PDA = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"
IDL_COMMIT = "2293f9a66c654e9fe82dc5e8f4618538f24bb35f"
BONDING_CURVE_DISCRIMINATOR = bytes([23, 183, 248, 55, 96, 216, 172, 96])

# Borsh layout of BondingCurve after the 8-byte discriminator, field by field (IDL order).
_LAYOUT = struct.Struct(
    "<"
    "8s"  # discriminator
    "Q"  # virtual_token_reserves: u64
    "Q"  # virtual_quote_reserves: u64
    "Q"  # real_token_reserves: u64
    "Q"  # real_quote_reserves: u64
    "Q"  # token_total_supply: u64
    "B"  # complete: bool
    "32s"  # creator: pubkey
    "B"  # is_mayhem_mode: bool
    "B"  # is_cashback_coin: bool
    "32s"  # quote_mint: pubkey
    "Q"  # creator_fee_bps: u64
    "B"  # can_edit_creator_fee: bool
    "B"  # is_holder_reward: bool
    "Q"  # creator_fee: u64
    "Q"  # protocol_fees: u64
    "B"  # depth: u8
    "Q"  # initial_virtual_quote_reserves: u64
    "Q"  # post_complete_base_out: u64
    "Q"  # post_complete_quote_in: u64
)
BONDING_CURVE_SIZE = _LAYOUT.size  # 166, the exact account size the IDL implies


class PumpFormatError(ValueError):
    """Bytes that are not the one BondingCurve layout this decoder knows: stop, don't guess."""


@dataclass(frozen=True, slots=True)
class BondingCurve:
    """A pump.fun bonding curve, field names and integer types as in the IDL.

    Amounts are raw on-chain integers (token base units / quote base units)."""

    virtual_token_reserves: int
    virtual_quote_reserves: int
    real_token_reserves: int
    real_quote_reserves: int
    token_total_supply: int
    complete: bool
    creator: str  # base58 pubkey
    is_mayhem_mode: bool
    is_cashback_coin: bool
    quote_mint: str  # base58 pubkey; not always wrapped SOL
    creator_fee_bps: int
    can_edit_creator_fee: bool
    is_holder_reward: bool
    creator_fee: int
    protocol_fees: int
    depth: int
    initial_virtual_quote_reserves: int
    post_complete_base_out: int
    post_complete_quote_in: int


def _bool(value: int, name: str) -> bool:
    if value not in (0, 1):
        raise PumpFormatError(f"{name}: a Borsh bool must be 0 or 1, got {value}")
    return value == 1


def decode_bonding_curve(data: bytes) -> BondingCurve:
    """Decode a BondingCurve account's raw data (the whole account, not a slice)."""
    if not isinstance(data, bytes | bytearray | memoryview):
        raise PumpFormatError(f"expected bytes, got {type(data).__name__}")
    raw = bytes(data)
    if len(raw) != BONDING_CURVE_SIZE:
        raise PumpFormatError(
            f"a BondingCurve is {BONDING_CURVE_SIZE} bytes in IDL {IDL_COMMIT[:8]}, got {len(raw)}"
            " (pump.fun may have changed its layout)"
        )
    (
        discriminator,
        virtual_token_reserves,
        virtual_quote_reserves,
        real_token_reserves,
        real_quote_reserves,
        token_total_supply,
        complete,
        creator,
        is_mayhem_mode,
        is_cashback_coin,
        quote_mint,
        creator_fee_bps,
        can_edit_creator_fee,
        is_holder_reward,
        creator_fee,
        protocol_fees,
        depth,
        initial_virtual_quote_reserves,
        post_complete_base_out,
        post_complete_quote_in,
    ) = _LAYOUT.unpack(raw)
    if discriminator != BONDING_CURVE_DISCRIMINATOR:
        raise PumpFormatError(f"not a BondingCurve account: discriminator {list(discriminator)}")
    return BondingCurve(
        virtual_token_reserves=virtual_token_reserves,
        virtual_quote_reserves=virtual_quote_reserves,
        real_token_reserves=real_token_reserves,
        real_quote_reserves=real_quote_reserves,
        token_total_supply=token_total_supply,
        complete=_bool(complete, "complete"),
        creator=b58encode(creator),
        is_mayhem_mode=_bool(is_mayhem_mode, "is_mayhem_mode"),
        is_cashback_coin=_bool(is_cashback_coin, "is_cashback_coin"),
        quote_mint=b58encode(quote_mint),
        creator_fee_bps=creator_fee_bps,
        can_edit_creator_fee=_bool(can_edit_creator_fee, "can_edit_creator_fee"),
        is_holder_reward=_bool(is_holder_reward, "is_holder_reward"),
        creator_fee=creator_fee,
        protocol_fees=protocol_fees,
        depth=depth,
        initial_virtual_quote_reserves=initial_virtual_quote_reserves,
        post_complete_base_out=post_complete_base_out,
        post_complete_quote_in=post_complete_quote_in,
    )
