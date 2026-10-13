"""Base58 (Bitcoin alphabet), the text form of Solana public keys and signatures.

Facts relied on (checked 2026-10-12 against the Solana docs source, solana-foundation/
solana-com at c6eab5b8; solana.com itself was unreachable from the build environment):
- "Every account address is a 32-byte value, displayed as a base58-encoded string"
  (https://solana.com/docs/core/accounts/account-structure).
- "Each Signature is a 64-byte Ed25519 signature"
  (https://solana.com/docs/core/transactions/transaction-structure); RPC methods show
  signatures "as base-58 encoded string" (https://solana.com/docs/rpc/http/getsignaturesforaddress).
- The alphabet is Bitcoin's: no 0, O, I or l. Each leading "1" stands for one leading
  zero byte, so the system program 11111111111111111111111111111111 is 32 zero bytes.

Standard library only. Decoding refuses anything that is not plain base58 (whitespace,
other characters, overlong input) instead of guessing.
"""

from __future__ import annotations

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
PUBKEY_BYTES = 32
SIGNATURE_BYTES = 64
# 64 bytes need at most 88 characters; anything much longer is not a key or a signature
# (and decoding very long input is slow, so it is refused before any arithmetic).
MAX_ENCODED_CHARS = 128

_INDEX = {ch: i for i, ch in enumerate(ALPHABET)}


def b58encode(data: bytes) -> str:
    """Bytes -> base58 text. Leading zero bytes become leading "1"s."""
    if not isinstance(data, bytes | bytearray | memoryview):  # bytes(5) would be 5 zero bytes
        raise ValueError(f"base58 input must be bytes, got {type(data).__name__}")
    raw = bytes(data)
    zeros = len(raw) - len(raw.lstrip(b"\0"))
    number = int.from_bytes(raw, "big")
    digits: list[str] = []
    while number:
        number, rest = divmod(number, 58)
        digits.append(ALPHABET[rest])
    return "1" * zeros + "".join(reversed(digits))


def b58decode(text: str) -> bytes:
    """Base58 text -> bytes. Raises ValueError for anything that is not plain base58."""
    if not isinstance(text, str):
        raise ValueError(f"base58 input must be a string, got {type(text).__name__}")
    if len(text) > MAX_ENCODED_CHARS:
        raise ValueError(f"base58 input longer than {MAX_ENCODED_CHARS} characters")
    number = 0
    for ch in text:
        value = _INDEX.get(ch)
        if value is None:
            raise ValueError(f"character {ch!r} is not in the base58 alphabet")
        number = number * 58 + value
    zeros = len(text) - len(text.lstrip("1"))
    body = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\0" * zeros + body


def _decodes_to(text: object, size: int) -> bool:
    if not isinstance(text, str) or not text:
        return False
    try:
        return len(b58decode(text)) == size
    except ValueError:
        return False


def is_pubkey(text: object) -> bool:
    """True if ``text`` is a base58 string that decodes to exactly 32 bytes."""
    return _decodes_to(text, PUBKEY_BYTES)


def is_signature(text: object) -> bool:
    """True if ``text`` is a base58 string that decodes to exactly 64 bytes."""
    return _decodes_to(text, SIGNATURE_BYTES)
