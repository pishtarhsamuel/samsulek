"""Solana mainnet JSON-RPC over plain HTTPS POST (no SDK): safety facts for new tokens and
the pump.fun creation stream. Research/simulation only; free public endpoint, no key.

Facts this adapter relies on (checked 2026-10-12 against the official docs SOURCE,
github.com/solana-foundation/solana-com at c6eab5b860f10989829c8f5b1df94642ea059799,
because solana.com itself was unreachable from the build environment; the agave
account decoder at 809b55983c1dfe4eb410a0c89fad3ee50208f76e; and 21 live POSTs to
https://api.mainnet-beta.solana.com, solana-core 4.3.0):
- Endpoint: the docs name https://api.mainnet.solana.com
  (https://solana.com/docs/references/clusters) and no longer mention mainnet-beta,
  which still answered live. The URL is configurable. UNVERIFIED: the documented host
  itself could not be reached from the build environment.
- JSON-RPC 2.0: POST {"jsonrpc":"2.0","id":1,"method":M,"params":[...]} with
  Content-Type application/json. An RPC error is {"error":{"code","message"}}, also
  with HTTP 200 (live: 101 keys -> 200 + -32602 "Too many inputs provided; max 100").
- Limits (clusters page): 100 requests / 10 s per IP and 40 / 10 s for one method,
  "subject to change"; public endpoints are "not intended for production". The live
  x-ratelimit-method-limit headers are stricter: 10 for getSignaturesForAddress,
  getTransaction and getProgramAccounts, 50 for getAccountInfo/getMultipleAccounts,
  150 for getSlot, and 0 for getTokenLargestAccounts (always 429, so it is NOT used).
  429 answers carry ``retry-after: 10`` (HttpClient honours it). So this client sends
  at most 1 call per second, and the methods limited to 10 at most 1 per 2 s (our own
  budget, not a documented rule). The window behind the header numbers is UNVERIFIED.
- HTTP 403 "Your IP or provider is blocked from this endpoint" (docs: "Your IP address
  or website has been blocked") -> RpcBlockedError: callers must stop and alert.
- getSlot [{"commitment"}] -> the slot as an integer.
- getMultipleAccounts: "up to a maximum of 100" keys; live: values in request order,
  null for an account that doesn't exist; {context:{apiVersion, slot}, value:[...]}.
  An account is exactly {data, executable, lamports, owner, rentEpoch, space} with
  space "u64 | null" (docs; agave account-decoder-client-types src/lib.rs UiAccount).
  With encoding jsonParsed, data is {program, parsed, space} (agave ParsedAccount), or
  ["<base64>","base64"] when the node has no parser (live: the pump.fun bonding
  curve). A token mint is program "spl-token" (owner Tokenkeg...) or "spl-token-2022"
  (owner TokenzQd...) with parsed {type:"mint", info:{mintAuthority, supply (a
  string), decimals, isInitialized, freezeAuthority, extensions?}}. agave's UiMint omits
  "extensions" when there are none; each extension is {"extension": <camelCase name>,
  "state": {...}}, without "state" for the unit variants (agave token.rs UiExtension).
  The fields and types of every known extension's state are agave's Ui* structs in
  the same file and are checked exactly (addresses kept whole). Only metadataPointer
  and tokenMetadata were seen live; the live node ran solana-core 4.3.0 while the
  source read is agave master, so a field list that differs there is refused, not
  guessed (UNVERIFIED live for the other extensions).
- Mint size and the missing-extensions trap: the Mint struct (docs tokens/basics/
  create-mint) is 36+8+1+1+36 = 82 bytes (live: USDC space 82) and Token-2022 keeps
  extensions in TLV data after it (docs tokens/extensions). agave builds the list with
  ``get_extension_types().unwrap_or_default()`` (account-decoder src/parse_token.rs):
  a node that can't read a mint's TLV data (say, an extension newer than the node)
  reports NO extensions. So an spl-token mint must be 82 bytes, a Token-2022 mint with
  listed extensions must be larger, and a larger Token-2022 mint with none listed is
  returned as NotAMint (facts incomplete), never as a clean mint.
- getSignaturesForAddress [address, {commitment, limit, before, until}]: limit 1..1000,
  default 1000; commitment confirmed|finalized ("This method does not accept
  processed"); results newest to oldest: {signature, slot, err (null = succeeded),
  memo, blockTime (i64 or null, "estimated production time"), confirmationStatus}.
  Failed transactions ARE listed (live: 6 of 20 on the pump program); err is "object |
  string | null". Live items also carry an undocumented ``transactionIndex``, falling
  within one slot (newest first); it is accepted and used to check that order.
  UNVERIFIED: whether ``until``/``before`` themselves are excluded from the answer
  (assumed; a result that contains them is refused).
- getProgramAccounts [program, {encoding, commitment, minContextSlot, dataSlice,
  filters}]: up to 4 filters, memcmp bytes base58 by default; without withContext the
  result is a bare array of {pubkey, account} (live), so the slot comes from a getSlot
  made just before, passed as minContextSlot ("the minimum slot that the request can
  be evaluated at"): it is a LOWER bound. A token account is mint (32 bytes) | owner
  (32) | amount (u64 little-endian) | ... (docs tokens/index), so dataSlice {offset 32,
  length 40} gives owner + amount. Original Token Program accounts are 165 bytes;
  Token-2022 accounts are 165, or more with extensions (170 with the automatic
  immutable owner), and never 355 bytes (a multisig's size; docs tokens/extensions).
- RPC returns current state only (no history): every result carries the slot it
  describes and our own fetched_at (UTC), the point-in-time "known at" stamp.
- Token names and symbols in tokenMetadata are attacker-chosen: they are reduced to 40
  printable ASCII characters; uri and additionalMetadata are dropped (never fetched).
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import unicodedata
import urllib.parse
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from samsulek.data.sources.base58 import b58encode, is_pubkey, is_signature
from samsulek.net.http import HttpClient, HttpError, RateLimiter

HOST = "api.mainnet.solana.com"
DEFAULT_URL = f"https://{HOST}"
SOURCE = "solana_rpc"
REQUEST_ID = 1  # one request per HTTP POST; the answer must echo it
TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"  # noqa: S105 (public program id)
TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"  # noqa: S105 (public program id)
TOKEN_PROGRAMS: Mapping[str, str] = {"spl-token": TOKEN_PROGRAM_ID, "spl-token-2022": TOKEN_2022_PROGRAM_ID}
COMMITMENTS = ("confirmed", "finalized")  # "processed" can roll back; never used here
MAX_ACCOUNTS_PER_CALL = 100  # getMultipleAccounts: "up to a maximum of 100"
MAX_SIGNATURES = 1000  # getSignaturesForAddress: limit 1..1000
HEAVY_METHODS = frozenset({"getSignaturesForAddress", "getTransaction", "getProgramAccounts"})
CALL_INTERVAL_SECONDS = 1.0
HEAVY_INTERVAL_SECONDS = 2.0
HOLDER_SLICE_OFFSET = 32  # token account: owner at 32..64, amount at 64..72
HOLDER_SLICE_LENGTH = 40
TOKEN_ACCOUNT_SIZE = 165
MULTISIG_SIZE = 355
MINT_SIZE = 82  # the Mint struct; Token-2022 extensions follow it (TLV)
MAX_TEXT_CHARS = 40
MAX_ERROR_CHARS = 200
_U64 = 2**64
_MAX_STATE_DEPTH = 4
# agave account-decoder-client-types src/token.rs (809b5598): enum UiExtension and the
# Ui* struct of each variant, camelCase. Field kinds: "address" / "address?" (a pubkey /
# or null), "bool", "u16", "u64", "i16", "i64", "text" / "text?" (a short string the node
# writes itself: base64 keys and ciphertexts, f64 numbers; kept whole), "accountState",
# "transferFee" (a nested UiTransferFee).
UNIT_EXTENSIONS = frozenset(
    {
        "uninitialized",
        "immutableOwner",
        "nonTransferable",
        "nonTransferableAccount",
        "unparseableExtension",  # the node could not parse that extension
        "pausableAccount",
    }
)
_A, _A_OPT, _BOOL, _U64_T, _TEXT = "address", "address?", "bool", "u64", "text"
_EXTENSION_FIELDS: Mapping[str, Mapping[str, str]] = {
    "transferFeeConfig": {
        "transferFeeConfigAuthority": _A_OPT,
        "withdrawWithheldAuthority": _A_OPT,
        "withheldAmount": _U64_T,
        "olderTransferFee": "transferFee",
        "newerTransferFee": "transferFee",
    },
    "transferFeeAmount": {"withheldAmount": _U64_T},
    "mintCloseAuthority": {"closeAuthority": _A_OPT},
    "confidentialTransferMint": {
        "authority": _A_OPT,
        "autoApproveNewAccounts": _BOOL,
        "auditorElgamalPubkey": "text?",
    },
    "confidentialTransferAccount": {
        "approved": _BOOL,
        "elgamalPubkey": _TEXT,
        "pendingBalanceLo": _TEXT,
        "pendingBalanceHi": _TEXT,
        "availableBalance": _TEXT,
        "decryptableAvailableBalance": _TEXT,
        "allowConfidentialCredits": _BOOL,
        "allowNonConfidentialCredits": _BOOL,
        "pendingBalanceCreditCounter": _U64_T,
        "maximumPendingBalanceCreditCounter": _U64_T,
        "expectedPendingBalanceCreditCounter": _U64_T,
        "actualPendingBalanceCreditCounter": _U64_T,
    },
    "defaultAccountState": {"accountState": "accountState"},
    "memoTransfer": {"requireIncomingTransferMemos": _BOOL},
    "interestBearingConfig": {
        "rateAuthority": _A_OPT,
        "initializationTimestamp": "i64",
        "preUpdateAverageRate": "i16",
        "lastUpdateTimestamp": "i64",
        "currentRate": "i16",
    },
    "cpiGuard": {"lockCpi": _BOOL},
    "permanentDelegate": {"delegate": _A_OPT},
    "confidentialTransferFeeConfig": {
        "authority": _A_OPT,
        "withdrawWithheldAuthorityElgamalPubkey": "text?",
        "harvestToMintEnabled": _BOOL,
        "withheldAmount": _TEXT,
    },
    "confidentialTransferFeeAmount": {"withheldAmount": _TEXT},
    "transferHook": {"authority": _A_OPT, "programId": _A_OPT},
    "transferHookAccount": {"transferring": _BOOL},
    "metadataPointer": {"authority": _A_OPT, "metadataAddress": _A_OPT},
    "groupPointer": {"authority": _A_OPT, "groupAddress": _A_OPT},
    "groupMemberPointer": {"authority": _A_OPT, "memberAddress": _A_OPT},
    "tokenGroup": {"updateAuthority": _A_OPT, "mint": _A, "size": _U64_T, "maxSize": _U64_T},
    "tokenGroupMember": {"mint": _A, "group": _A, "memberNumber": _U64_T},
    "confidentialMintBurn": {
        "confidentialSupply": _TEXT,
        "decryptableSupply": _TEXT,
        "supplyElgamalPubkey": _TEXT,
        "pendingBurn": _TEXT,
    },
    "scaledUiAmountConfig": {
        "authority": _A_OPT,
        "multiplier": _TEXT,
        "newMultiplierEffectiveTimestamp": "i64",
        "newMultiplier": _TEXT,
    },
    "pausableConfig": {"authority": _A_OPT, "paused": _BOOL},
    "permissionedBurnConfig": {"authority": _A_OPT},
}
_TRANSFER_FEE_FIELDS: Mapping[str, str] = {
    "epoch": _U64_T,
    "maximumFee": _U64_T,
    "transferFeeBasisPoints": "u16",
}
_ACCOUNT_STATES = frozenset({"uninitialized", "initialized", "frozen"})  # agave UiAccountState
# All 30 UiExtension variants (tokenMetadata has its own handling: untrusted text).
KNOWN_EXTENSIONS = frozenset(_EXTENSION_FIELDS) | UNIT_EXTENSIONS | {"tokenMetadata"}
_MINT_INFO_KEYS = frozenset({"mintAuthority", "supply", "decimals", "isInitialized", "freezeAuthority"})
_TOKEN_METADATA_KEYS = frozenset({"updateAuthority", "mint", "name", "symbol", "uri", "additionalMetadata"})
_ENVELOPE_KEYS = frozenset({"jsonrpc", "id", "result", "error"})
_ACCOUNT_KEYS = frozenset({"data", "executable", "lamports", "owner", "rentEpoch", "space"})
_PARSED_DATA_KEYS = frozenset({"program", "parsed", "space"})
_PROGRAM_ACCOUNT_KEYS = frozenset({"pubkey", "account"})
_SIGNATURE_KEYS = frozenset({"signature", "slot", "err", "memo", "blockTime", "confirmationStatus"})
_SIGNATURE_OPTIONAL_KEYS = frozenset({"transactionIndex"})  # live, undocumented
_IDENTIFIER_RE = re.compile(r"^[a-z][A-Za-z0-9]{0,63}$")
_DIGITS_RE = re.compile(r"^(0|[1-9][0-9]{0,19})$")
_NODE_TEXT_RE = re.compile(r"^[!-~]{1,128}$")  # printable ASCII, no spaces
_CONFIRMATION_STATUSES = frozenset({"processed", "confirmed", "finalized"})


class SolanaFormatError(ValueError):
    """The response doesn't look like what the adapter was written for: stop, don't guess."""


class SolanaRpcError(RuntimeError):
    """The node answered with a JSON-RPC error object (it can come with HTTP 200)."""

    def __init__(self, code: int, message: str, method: str = "") -> None:
        super().__init__(f"{method or 'RPC'} error {code}: {message}")
        self.code = code
        self.message = message
        self.method = method


class RpcBlockedError(HttpError):
    """HTTP 403: the endpoint blocked this request or this IP. Stop and alert the owner."""

    def __init__(self, message: str, *, url: str, body: str = "") -> None:
        super().__init__(message, url=url, status=403, body=body)


@dataclass(frozen=True, slots=True)
class MintFacts:
    """A token mint as the node parsed it (jsonParsed), at ``MintsResult.slot``."""

    address: str
    token_program: str  # "spl-token" or "spl-token-2022"
    owner: str  # the token program id that owns the mint account
    mint_authority: str | None  # None = nobody can mint more
    freeze_authority: str | None  # None = nobody can freeze holders' accounts
    supply: int  # raw base units
    decimals: int
    is_initialized: bool
    # (name, state) in the node's order. Known extensions: exactly agave's fields, type-
    # checked; tokenMetadata keeps updateAuthority, mint, cleaned name/symbol and a count
    # of additionalMetadata entries; unit variants have {}. Unknown names: a cleaned copy
    # (see unknown_extensions). () = no extensions (only ever for an 82-byte mint).
    extensions: tuple[tuple[str, dict[str, Any]], ...] = ()

    @property
    def extension_names(self) -> tuple[str, ...]:
        return tuple(name for name, _ in self.extensions)

    @property
    def unknown_extensions(self) -> tuple[str, ...]:
        """Extension names this code doesn't know: a safety filter must reject them."""
        return tuple(name for name, _ in self.extensions if name not in KNOWN_EXTENSIONS)


@dataclass(frozen=True, slots=True)
class NotAMint:
    """The account exists but is not a fully parsed token mint (a program, a bonding
    curve, a token account, an account the node couldn't parse, or a Token-2022 mint
    whose extensions the node didn't list). Never treat it as a (safe) mint."""

    address: str
    account_owner: str  # deliberately not called "owner": it is not a token program id
    reason: str


@dataclass(frozen=True, slots=True)
class MintsResult:
    slot: int  # the slot the node answered at (context.slot)
    facts: dict[str, MintFacts | NotAMint | None]  # None = the account doesn't exist
    fetched_at: datetime  # UTC: when we received it


@dataclass(frozen=True, slots=True)
class RawAccount:
    owner: str  # program id that owns the account
    data: bytes  # the whole account data
    lamports: int


@dataclass(frozen=True, slots=True)
class SignatureInfo:
    signature: str
    slot: int
    block_time: datetime | None  # UTC; the node's estimate, may be missing
    failed: bool  # the transaction is on chain but failed (err is not null)


@dataclass(frozen=True, slots=True)
class HoldersResult:
    slot: int  # LOWER bound: the answer was evaluated at this slot or later
    holders: tuple[tuple[str, int], ...]  # (owner, raw amount) per token account, largest first
    fetched_at: datetime  # UTC: when we received it


def limiter() -> RateLimiter:
    """For the HttpClient entry of the RPC host: 1 request per second, no bursts.
    SolanaRpc adds its own per-method budget on top (1 per 2 s for the heavy methods)."""
    return RateLimiter(1, CALL_INTERVAL_SECONDS)


def clean_text(value: str, limit: int = MAX_TEXT_CHARS) -> str:
    """Untrusted text -> printable ASCII. Whitespace runs become one space; any other
    character outside printable ASCII (controls, bidi overrides, emoji) becomes "?"."""
    text = unicodedata.normalize("NFKC", value[: limit * 5])
    out = "".join(ch if " " <= ch <= "~" else (" " if ch.isspace() else "?") for ch in text)
    return " ".join(out.split())[:limit].rstrip()


# ---------------------------------------------------------------- JSON-RPC envelope
def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


def _loads(body: bytes | str, what: str) -> Any:
    try:
        return json.loads(body, parse_float=Decimal, parse_constant=_reject_constant)
    except (ValueError, RecursionError) as exc:
        raise SolanaFormatError(f"{what}: response is not valid JSON: {exc}") from exc


def parse_envelope(body: bytes, method: str) -> Any:
    """The ``result`` of a JSON-RPC 2.0 answer. An error object raises SolanaRpcError."""
    doc = _loads(body, method)
    if not isinstance(doc, dict):
        raise SolanaFormatError(f"{method}: expected a JSON object, got {type(doc).__name__}")
    extra = set(doc) - _ENVELOPE_KEYS
    if extra:
        raise SolanaFormatError(f"{method}: unexpected keys {sorted(_show(k) for k in extra)}")
    if doc.get("jsonrpc") != "2.0":
        raise SolanaFormatError(f"{method}: not a JSON-RPC 2.0 answer: jsonrpc={_show(doc.get('jsonrpc'))}")
    if type(doc.get("id")) is not int or doc["id"] != REQUEST_ID:
        raise SolanaFormatError(f"{method}: answer id {_show(doc.get('id'))} is not our request id")
    if "error" in doc:
        if "result" in doc:
            raise SolanaFormatError(f"{method}: answer has both result and error")
        error = doc["error"]
        if not (
            isinstance(error, dict)
            and type(error.get("code")) is int
            and isinstance(error.get("message"), str)
        ):
            raise SolanaFormatError(f"{method}: malformed error object {_show(error)}")
        raise SolanaRpcError(error["code"], clean_text(error["message"], MAX_ERROR_CHARS), method)
    if "result" not in doc:
        raise SolanaFormatError(f"{method}: answer has neither result nor error")
    return doc["result"]


def error_text(body: str) -> str:
    """A short, safe message from an HTTP error body (a JSON-RPC error, or anything)."""
    try:
        doc = json.loads(body)
    except (ValueError, RecursionError):
        return clean_text(body, MAX_ERROR_CHARS)
    if isinstance(doc, dict) and isinstance(doc.get("error"), dict):
        message = doc["error"].get("message")
        if isinstance(message, str):
            return clean_text(message, MAX_ERROR_CHARS)
    return clean_text(body, MAX_ERROR_CHARS)


# -------------------------------------------------------------------- field checks
def _show(value: Any) -> str:
    """A short, safe rendering of an untrusted value for error messages."""
    return clean_text(repr(value), 60)


def _obj(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SolanaFormatError(f"{where}: expected an object, got {type(value).__name__}")
    return value


def _list(value: Any, where: str) -> list[Any]:
    if not isinstance(value, list):
        raise SolanaFormatError(f"{where}: expected an array, got {type(value).__name__}")
    return value


def _keys(
    value: Any, where: str, required: frozenset[str], optional: frozenset[str] = frozenset()
) -> dict[str, Any]:
    """An object with exactly the ``required`` keys plus any of the ``optional`` ones."""
    obj = _obj(value, where)
    unexpected = set(obj) - required - optional
    missing = required - set(obj)
    if unexpected or missing:
        problems = []
        if unexpected:
            problems.append(f"unexpected keys {', '.join(sorted(map(_show, unexpected)))}")
        if missing:
            problems.append(f"missing {', '.join(repr(k) for k in sorted(missing))}")
        raise SolanaFormatError(f"{where}: {'; '.join(problems)}")
    return obj


def _str(value: Any, where: str) -> str:
    if not isinstance(value, str):
        raise SolanaFormatError(f"{where}: expected a string, got {type(value).__name__}")
    return value


def _bool(value: Any, where: str) -> bool:
    if not isinstance(value, bool):
        raise SolanaFormatError(f"{where}: expected true/false, got {_show(value)}")
    return value


def _uint(value: Any, where: str, limit: int = _U64) -> int:
    if type(value) is not int or not 0 <= value < limit:
        raise SolanaFormatError(f"{where}: expected an integer 0..{limit - 1}, got {_show(value)}")
    return value


def _sint(value: Any, where: str, bits: int) -> int:
    bound = 2 ** (bits - 1)
    if type(value) is not int or not -bound <= value < bound:
        raise SolanaFormatError(f"{where}: expected an i{bits}, got {_show(value)}")
    return value


def _pubkey(value: Any, where: str) -> str:
    if not isinstance(value, str) or not is_pubkey(value):
        raise SolanaFormatError(f"{where}: not a Solana address: {_show(value)}")
    return value


def _optional_pubkey(value: Any, where: str) -> str | None:
    return None if value is None else _pubkey(value, where)


def _base64(value: Any, where: str) -> bytes:
    """Account data in the ["<base64>", "base64"] form."""
    pair = _list(value, where)
    if len(pair) != 2 or pair[1] != "base64" or not isinstance(pair[0], str):
        raise SolanaFormatError(f"{where}: expected [<data>, 'base64'], got {_show(pair)}")
    try:
        return base64.b64decode(pair[0], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SolanaFormatError(f"{where}: bad base64: {exc}") from exc


def _context_values(result: Any, count: int, where: str) -> tuple[int, list[Any]]:
    """An RpcResponse {context:{slot, apiVersion?}, value:[...]} with exactly ``count`` values."""
    obj = _obj(result, where)
    if set(obj) != {"context", "value"}:
        raise SolanaFormatError(f"{where}: expected keys context and value, got {sorted(map(_show, obj))}")
    context = _keys(obj["context"], f"{where}.context", frozenset({"slot"}), frozenset({"apiVersion"}))
    slot = _uint(context["slot"], f"{where}.context.slot")
    if "apiVersion" in context:
        _str(context["apiVersion"], f"{where}.context.apiVersion")
    values = _list(obj["value"], f"{where}.value")
    if len(values) != count:
        raise SolanaFormatError(f"{where}: asked for {count} accounts, got {len(values)}")
    return slot, values


def _account_fields(value: Any, where: str) -> tuple[dict[str, Any], str, bool, int | None]:
    """An account object (agave UiAccount), every field but ``data`` checked.
    Returns (the object, owner, executable, space or None)."""
    account = _keys(value, where, _ACCOUNT_KEYS)
    owner = _pubkey(account["owner"], f"{where}.owner")
    executable = _bool(account["executable"], f"{where}.executable")
    _uint(account["lamports"], f"{where}.lamports")
    _uint(account["rentEpoch"], f"{where}.rentEpoch")
    space = account["space"]  # documented as "u64 | null"
    return account, owner, executable, None if space is None else _uint(space, f"{where}.space")


# ------------------------------------------------------------------------- mints
def _clean_value(value: Any, where: str, depth: int) -> Any:
    """Extension state: keep pubkeys whole, cut every other string to clean ASCII."""
    if depth > _MAX_STATE_DEPTH:
        raise SolanaFormatError(f"{where}: nested deeper than {_MAX_STATE_DEPTH} levels")
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if not _IDENTIFIER_RE.fullmatch(key):
                raise SolanaFormatError(f"{where}: unexpected key {_show(key)}")
            out[key] = _clean_value(item, f"{where}.{key}", depth + 1)
        return out
    if isinstance(value, list):
        return [_clean_value(item, f"{where}[]", depth + 1) for item in value]
    if isinstance(value, str):
        return value if is_pubkey(value) else clean_text(value)
    if value is None or isinstance(value, bool | int | Decimal):
        return value
    raise SolanaFormatError(f"{where}: unexpected value {_show(value)}")  # pragma: no cover


def _node_text(value: Any, where: str) -> str:
    """A string the node writes itself (base64 keys/ciphertexts, f64 text): kept whole,
    so it must be short printable ASCII; anything else is refused, not cut."""
    if not isinstance(value, str) or not _NODE_TEXT_RE.fullmatch(value):
        raise SolanaFormatError(f"{where}: expected 1-128 printable ASCII characters, got {_show(value)}")
    return value


def _typed(value: Any, kind: str, where: str) -> Any:
    """One field of a known extension state, checked against its agave type."""
    if kind == "address?":
        return _optional_pubkey(value, where)
    if kind == "address":
        return _pubkey(value, where)
    if kind == "bool":
        return _bool(value, where)
    if kind == "u16":
        return _uint(value, where, 2**16)
    if kind == "u64":
        return _uint(value, where)
    if kind in ("i16", "i64"):
        return _sint(value, where, int(kind[1:]))
    if kind == "text":
        return _node_text(value, where)
    if kind == "text?":
        return None if value is None else _node_text(value, where)
    if kind == "accountState":
        if value not in _ACCOUNT_STATES:
            raise SolanaFormatError(f"{where}: unknown account state {_show(value)}")
        return value
    if kind == "transferFee":
        return _typed_state(value, _TRANSFER_FEE_FIELDS, where)
    raise AssertionError(f"unknown field kind {kind}")  # pragma: no cover (a bug in the table)


def _typed_state(value: Any, fields: Mapping[str, str], where: str) -> dict[str, Any]:
    state = _keys(value, where, frozenset(fields))
    return {key: _typed(state[key], kind, f"{where}.{key}") for key, kind in fields.items()}


def _token_metadata(state: Any, where: str) -> dict[str, Any]:
    """tokenMetadata minus the parts we never keep (uri, additionalMetadata: links/socials)."""
    state = _keys(state, where, _TOKEN_METADATA_KEYS)
    _str(state["uri"], f"{where}.uri")  # checked, never kept
    extra = _list(state["additionalMetadata"], f"{where}.additionalMetadata")
    for n, pair in enumerate(extra):  # agave: Vec<(String, String)>; checked, never kept
        if not (isinstance(pair, list) and len(pair) == 2 and all(isinstance(p, str) for p in pair)):
            raise SolanaFormatError(f"{where}.additionalMetadata[{n}]: expected a [key, value] string pair")
    return {
        "updateAuthority": _optional_pubkey(state["updateAuthority"], f"{where}.updateAuthority"),
        "mint": _pubkey(state["mint"], f"{where}.mint"),
        "name": clean_text(_str(state["name"], f"{where}.name")),
        "symbol": clean_text(_str(state["symbol"], f"{where}.symbol")),
        "additionalMetadataEntries": len(extra),
    }


def _extension(item: Any, where: str) -> tuple[str, dict[str, Any]]:
    obj = _keys(item, where, frozenset({"extension"}), frozenset({"state"}))
    name = _str(obj["extension"], f"{where}.extension")
    if not _IDENTIFIER_RE.fullmatch(name):
        raise SolanaFormatError(f"{where}: odd extension name {_show(name)}")
    if name in KNOWN_EXTENSIONS and ("state" in obj) == (name in UNIT_EXTENSIONS):
        has = "has a state" if "state" in obj else "has no state"
        raise SolanaFormatError(f"{where}: {name} {has}, unlike agave's UiExtension")
    if "state" not in obj:  # unit variants (immutableOwner, nonTransferable, ...) or unknown
        return name, {}
    if name == "tokenMetadata":
        return name, _token_metadata(obj["state"], f"{where}.state")
    fields = _EXTENSION_FIELDS.get(name)
    if fields is not None:
        return name, _typed_state(obj["state"], fields, f"{where}.state")
    # Unknown to this code: keep a cleaned copy for the record (the safety filter rejects it).
    state = _obj(obj["state"], f"{where}.state")
    return name, _obj(_clean_value(state, f"{where}.state", 1), f"{where}.state")


def _mint_info(
    address: str, info: dict[str, Any], where: str, *, program: str, owner: str, size: int
) -> MintFacts | NotAMint:
    keys = set(info)
    missing = _MINT_INFO_KEYS - keys
    extra = keys - _MINT_INFO_KEYS - {"extensions"}
    if missing or extra:
        raise SolanaFormatError(
            f"{where}: mint fields differ from the known UiMint: missing {sorted(missing)},"
            f" unexpected {sorted(map(_show, extra))}"
        )
    supply_text = _str(info["supply"], f"{where}.supply")
    if not _DIGITS_RE.fullmatch(supply_text) or int(supply_text) >= _U64:
        raise SolanaFormatError(
            f"{where}.supply: expected a u64 as a decimal string, got {_show(supply_text)}"
        )
    extensions: tuple[tuple[str, dict[str, Any]], ...] = ()
    if "extensions" in info:
        if program != "spl-token-2022":
            raise SolanaFormatError(f"{where}: extensions on a {program} mint")
        items = _list(info["extensions"], f"{where}.extensions")
        if not items:  # agave omits the key when the list is empty
            raise SolanaFormatError(f"{where}: an empty extensions list (agave leaves the key out)")
        if size <= MINT_SIZE:
            raise SolanaFormatError(f"{where}: extensions listed on a {size}-byte mint")
        extensions = tuple(_extension(item, f"{where}.extensions[{n}]") for n, item in enumerate(items))
    elif size != MINT_SIZE and program == "spl-token":
        raise SolanaFormatError(f"{where}: an spl-token mint is {MINT_SIZE} bytes, this one {size}")
    facts = MintFacts(
        address=address,
        token_program=program,
        owner=owner,
        mint_authority=_optional_pubkey(info["mintAuthority"], f"{where}.mintAuthority"),
        freeze_authority=_optional_pubkey(info["freezeAuthority"], f"{where}.freezeAuthority"),
        supply=int(supply_text),
        decimals=_uint(info["decimals"], f"{where}.decimals", 256),
        is_initialized=_bool(info["isInitialized"], f"{where}.isInitialized"),
        extensions=extensions,
    )
    if not extensions and size != MINT_SIZE:
        # A Token-2022 mint with TLV data but no extensions listed: the node could not
        # read them (agave falls back to an empty list). Its facts are incomplete.
        return NotAMint(
            address,
            owner,
            f"a {size}-byte Token-2022 mint whose extensions the node did not list: facts incomplete",
        )
    return facts


MIN_REFUSED_FOR_FORMAT_CHANGE = 3


def _owner_text(value: Any) -> str:
    """The owner of an account the parser refused, if it is at least a valid address."""
    owner = value.get("owner") if isinstance(value, dict) else None
    return owner if isinstance(owner, str) and is_pubkey(owner) else "?"


def parse_mint_account(address: str, value: Any) -> MintFacts | NotAMint | None:
    """One getMultipleAccounts/getAccountInfo value fetched with encoding jsonParsed."""
    where = f"account {address}"
    if value is None:
        return None
    account, owner, executable, space = _account_fields(value, where)
    data = account["data"]
    if isinstance(data, list):  # the node had no parser for it
        raw = _base64(data, f"{where}.data")
        if space is not None and space != len(raw):
            raise SolanaFormatError(f"{where}: {len(raw)} data bytes but the account is {space} bytes")
        if owner in TOKEN_PROGRAMS.values():
            return NotAMint(address, owner, "owned by a token program, but the node could not parse it")
        return NotAMint(address, owner, "not a token-program account")
    data = _keys(data, f"{where}.data", _PARSED_DATA_KEYS)
    program = _str(data["program"], f"{where}.data.program")
    size = _uint(data["space"], f"{where}.data.space")
    if space is not None and space != size:
        raise SolanaFormatError(f"{where}: account space {space} but data.space {size}")
    if program not in TOKEN_PROGRAMS:
        _obj(data["parsed"], f"{where}.data.parsed")
        if owner in TOKEN_PROGRAMS.values():
            raise SolanaFormatError(f"{where}: owned by a token program but parsed as {_show(program)}")
        return NotAMint(address, owner, f"a {clean_text(program)} account, not a token mint")
    if TOKEN_PROGRAMS[program] != owner:
        raise SolanaFormatError(f"{where}: parsed as {program} but owned by {owner}")
    if executable:
        raise SolanaFormatError(f"{where}: a token-program account can't be executable")
    parsed = _keys(data["parsed"], f"{where}.data.parsed", frozenset({"type", "info"}))
    kind = _str(parsed["type"], f"{where}.type")
    if kind in ("account", "multisig"):
        return NotAMint(address, owner, f"a token {kind}, not a mint")
    if kind != "mint":
        raise SolanaFormatError(f"{where}: unknown token account type {_show(kind)}")
    info = _obj(parsed["info"], f"{where}.info")
    return _mint_info(address, info, f"{where}.info", program=program, owner=owner, size=size)


def parse_raw_account(address: str, value: Any) -> RawAccount | None:
    """One getMultipleAccounts value fetched with encoding base64 (no data slice)."""
    where = f"account {address}"
    if value is None:
        return None
    account, owner, _, space = _account_fields(value, where)
    data = _base64(account["data"], f"{where}.data")
    if space is not None and space != len(data):
        raise SolanaFormatError(f"{where}: {len(data)} data bytes but the account is {space} bytes")
    return RawAccount(owner=owner, data=data, lamports=account["lamports"])


# -------------------------------------------------------------------- signatures
def _block_time(value: Any, where: str) -> datetime | None:
    if value is None:
        return None
    seconds = _uint(value, where, 253_402_300_800)  # up to the year 9999
    return datetime.fromtimestamp(seconds, UTC)


def parse_signatures(
    result: Any, *, limit: int, until: str | None = None, before: str | None = None
) -> list[SignatureInfo]:
    """A getSignaturesForAddress result: newest first, at most ``limit`` entries."""
    where = "getSignaturesForAddress"
    items = _list(result, where)
    if len(items) > limit:
        raise SolanaFormatError(f"{where}: asked for at most {limit} signatures, got {len(items)}")
    out: list[SignatureInfo] = []
    seen: set[str] = set()
    previous_index: int | None = None
    for n, raw in enumerate(items):
        at = f"{where}[{n}]"
        item = _keys(raw, at, _SIGNATURE_KEYS, _SIGNATURE_OPTIONAL_KEYS)
        signature = _str(item["signature"], f"{at}.signature")
        if not is_signature(signature):
            raise SolanaFormatError(f"{at}: not a transaction signature: {_show(signature)}")
        if signature in seen:
            raise SolanaFormatError(f"{at}: signature listed twice")
        if signature in (until, before):
            raise SolanaFormatError(f"{at}: the until/before signature itself was returned")
        seen.add(signature)
        slot = _uint(item["slot"], f"{at}.slot")
        if out and slot > out[-1].slot:
            raise SolanaFormatError(f"{at}: not newest-first (slot {slot} after {out[-1].slot})")
        index = item.get("transactionIndex")
        if index is not None:
            _uint(index, f"{at}.transactionIndex")
            if out and slot == out[-1].slot and previous_index is not None and index >= previous_index:
                raise SolanaFormatError(
                    f"{at}: not newest-first in slot {slot} (transactionIndex {index} after {previous_index})"
                )
        previous_index = index
        err = item["err"]
        if err is not None and not isinstance(err, dict | str):
            raise SolanaFormatError(f"{at}.err: expected an object, a string or null, got {_show(err)}")
        memo = item["memo"]
        if memo is not None:
            _str(memo, f"{at}.memo")  # untrusted text: checked, never kept
        status = item["confirmationStatus"]
        if status is not None and status not in _CONFIRMATION_STATUSES:
            raise SolanaFormatError(f"{at}: unknown confirmationStatus {_show(status)}")
        out.append(
            SignatureInfo(
                signature=signature,
                slot=slot,
                block_time=_block_time(item["blockTime"], f"{at}.blockTime"),
                failed=err is not None,
            )
        )
    return out


# ----------------------------------------------------------------------- holders
def parse_holders(result: Any, token_program_id: str) -> tuple[tuple[str, int], ...]:
    """A getProgramAccounts result with dataSlice {32, 40}: (owner, amount) per token
    account, largest first. One owner can appear more than once (several accounts)."""
    where = "getProgramAccounts"
    items = _list(result, where)
    holders: list[tuple[str, int]] = []
    seen: set[str] = set()
    for n, raw in enumerate(items):
        at = f"{where}[{n}]"
        item = _keys(raw, at, _PROGRAM_ACCOUNT_KEYS)
        pubkey = _pubkey(item["pubkey"], f"{at}.pubkey")
        if pubkey in seen:
            raise SolanaFormatError(f"{at}: token account listed twice")
        seen.add(pubkey)
        account, owner, executable, space_or_none = _account_fields(item["account"], f"{at}.account")
        if owner != token_program_id:
            raise SolanaFormatError(f"{at}: owned by {owner}, not the token program asked for")
        if executable:
            raise SolanaFormatError(f"{at}: a token account can't be executable")
        if space_or_none is None:
            raise SolanaFormatError(f"{at}.account.space: null, so the account size can't be checked")
        space = space_or_none
        if token_program_id == TOKEN_PROGRAM_ID:
            plausible = space == TOKEN_ACCOUNT_SIZE
        else:
            plausible = space >= TOKEN_ACCOUNT_SIZE and space != MULTISIG_SIZE
        if not plausible:
            raise SolanaFormatError(f"{at}: {space} bytes is not a token account's size")
        data = _base64(account["data"], f"{at}.account.data")
        if len(data) != HOLDER_SLICE_LENGTH:
            raise SolanaFormatError(f"{at}: expected a {HOLDER_SLICE_LENGTH}-byte slice, got {len(data)}")
        holders.append((b58encode(data[:32]), int.from_bytes(data[32:40], "little")))
    holders.sort(key=lambda h: (-h[1], h[0]))
    return tuple(holders)


# ------------------------------------------------------------------------ client
def _check_commitment(commitment: str) -> None:
    if commitment not in COMMITMENTS:
        raise ValueError(f"commitment must be one of {COMMITMENTS}, got {commitment!r}")


def _unique_pubkeys(addresses: Sequence[str]) -> list[str]:
    if isinstance(addresses, str):
        raise ValueError("pass a list of addresses, not one string")
    keys = list(dict.fromkeys(addresses))  # duplicates asked once; order kept
    if not keys:
        raise ValueError("no addresses given")
    if len(keys) > MAX_ACCOUNTS_PER_CALL:
        raise ValueError(f"at most {MAX_ACCOUNTS_PER_CALL} addresses per call, got {len(keys)}")
    bad = [k for k in keys if not is_pubkey(k)]
    if bad:
        raise ValueError(f"not Solana addresses: {[_show(b) for b in bad[:3]]}")
    return keys


class SolanaRpc:
    """A small JSON-RPC client for the few read-only methods the recorder needs."""

    def __init__(
        self,
        http: HttpClient,
        url: str = DEFAULT_URL,
        *,
        call_limiter: RateLimiter | None = None,
        heavy_limiter: RateLimiter | None = None,
    ) -> None:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https":
            raise ValueError("the RPC URL must start with https://")
        if parts.username or parts.password or parts.fragment:
            raise ValueError("the RPC URL must not contain credentials or a fragment")
        host = (parts.hostname or "").lower()
        if host not in http.allowed_hosts:
            raise ValueError(f"the HTTP client must allow {host}")
        self._http = http
        self._url = url  # may one day carry a provider key: never put it in messages
        self.host = host
        self._calls = call_limiter or RateLimiter(1, CALL_INTERVAL_SECONDS)
        self._heavy = heavy_limiter or RateLimiter(1, HEAVY_INTERVAL_SECONDS)

    def _call(self, method: str, params: list[Any]) -> tuple[Any, datetime]:
        if method in HEAVY_METHODS:
            self._heavy.acquire()
        self._calls.acquire()
        payload = {"jsonrpc": "2.0", "id": REQUEST_ID, "method": method, "params": params}
        try:
            response = self._http.post_json(self._url, payload)
        except HttpError as exc:
            if exc.status == 403:
                raise RpcBlockedError(
                    f"{method}: HTTP 403 {error_text(exc.body)!r} - the RPC endpoint blocked us;"
                    " stop and alert the owner",
                    url=exc.url,
                    body=exc.body,
                ) from exc
            raise
        content_type = response.headers.get("content-type", "")
        if not content_type.lower().startswith("application/json"):
            raise SolanaFormatError(f"{method}: expected application/json, got {_show(content_type)}")
        received = response.received_at
        if received.tzinfo is None or received.utcoffset() is None:  # never guess a time zone
            raise ValueError("HttpClient.now must return timezone-aware times")
        return parse_envelope(response.body, method), received.astimezone(UTC)

    def slot(self, commitment: str = "confirmed") -> int:
        _check_commitment(commitment)
        result, _ = self._call("getSlot", [{"commitment": commitment}])
        return _uint(result, "getSlot result")

    def mints(
        self, addresses: Sequence[str], *, commitment: str = "confirmed", strict: bool = False
    ) -> MintsResult:
        """Mint facts for up to 100 addresses (getMultipleAccounts, jsonParsed).

        An account whose content the parser refuses comes back as ``NotAMint`` with the
        reason ("unreadable: ..."), so one odd (or deliberately crafted) token can't hide
        the facts of the others; the safety filter rejects it like any non-mint.
        ``strict=True`` raises instead. Either way, when at least 3 accounts and at least
        half of the existing ones are refused, it raises: that looks like the node's format
        changed, not like one odd token, and must stop the caller rather than fill its
        records with markers."""
        _check_commitment(commitment)
        keys = _unique_pubkeys(addresses)
        result, fetched_at = self._call(
            "getMultipleAccounts", [keys, {"encoding": "jsonParsed", "commitment": commitment}]
        )
        slot, values = _context_values(result, len(keys), "getMultipleAccounts")
        facts: dict[str, MintFacts | NotAMint | None] = {}
        refused: list[SolanaFormatError] = []
        for key, value in zip(keys, values, strict=True):
            try:
                facts[key] = parse_mint_account(key, value)
            except SolanaFormatError as exc:
                if strict:
                    raise
                refused.append(exc)
                facts[key] = NotAMint(key, _owner_text(value), f"unreadable: {exc}"[:300])
        existing = sum(1 for v in values if v is not None)
        if len(refused) >= MIN_REFUSED_FOR_FORMAT_CHANGE and 2 * len(refused) >= existing:
            raise SolanaFormatError(
                f"{len(refused)} of {existing} mint accounts unreadable (format change?): {refused[0]}"
            ) from refused[0]
        return MintsResult(slot=slot, facts=facts, fetched_at=fetched_at)

    def accounts_raw(
        self, addresses: Sequence[str], *, commitment: str = "confirmed"
    ) -> tuple[int, dict[str, RawAccount | None]]:
        """Raw account bytes for up to 100 addresses (getMultipleAccounts, base64)."""
        _check_commitment(commitment)
        keys = _unique_pubkeys(addresses)
        result, _ = self._call(
            "getMultipleAccounts", [keys, {"encoding": "base64", "commitment": commitment}]
        )
        slot, values = _context_values(result, len(keys), "getMultipleAccounts")
        return slot, {key: parse_raw_account(key, value) for key, value in zip(keys, values, strict=True)}

    def signatures(
        self,
        address: str,
        *,
        until: str | None = None,
        before: str | None = None,
        limit: int = MAX_SIGNATURES,
        commitment: str = "finalized",
    ) -> list[SignatureInfo]:
        """Transactions that mention ``address``, newest first, failed ones included."""
        if not is_pubkey(address):
            raise ValueError(f"not a Solana address: {_show(address)}")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_SIGNATURES:
            raise ValueError(f"limit must be an integer from 1 to {MAX_SIGNATURES}, got {limit!r}")
        _check_commitment(commitment)
        config: dict[str, Any] = {"commitment": commitment, "limit": limit}
        for name, signature in (("until", until), ("before", before)):
            if signature is not None:
                if not is_signature(signature):
                    raise ValueError(f"{name} is not a transaction signature: {_show(signature)}")
                config[name] = signature
        result, _ = self._call("getSignaturesForAddress", [address, config])
        return parse_signatures(result, limit=limit, until=until, before=before)

    def token_holders(
        self, mint: str, token_program_id: str, *, commitment: str = "confirmed"
    ) -> HoldersResult:
        """Every token account of ``mint`` as (owner, raw amount), largest first.

        Two calls: getSlot, then getProgramAccounts with minContextSlot = that slot, so
        ``HoldersResult.slot`` is a lower bound of the slot the list describes."""
        if not is_pubkey(mint):
            raise ValueError(f"not a Solana address: {_show(mint)}")
        if token_program_id not in TOKEN_PROGRAMS.values():
            raise ValueError(f"not a token program id: {_show(token_program_id)}")
        min_slot = self.slot(commitment)
        result, fetched_at = self._call(
            "getProgramAccounts",
            [
                token_program_id,
                {
                    "encoding": "base64",
                    "commitment": commitment,
                    "minContextSlot": min_slot,
                    "dataSlice": {"offset": HOLDER_SLICE_OFFSET, "length": HOLDER_SLICE_LENGTH},
                    "filters": [{"memcmp": {"offset": 0, "bytes": mint}}],
                },
            ],
        )
        return HoldersResult(
            slot=min_slot, holders=parse_holders(result, token_program_id), fetched_at=fetched_at
        )
