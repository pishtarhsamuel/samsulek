"""Solana JSON-RPC adapter, tested on real responses recorded 2026-10-12 21:22-21:34 UTC
from https://api.mainnet-beta.solana.com (tests/fixtures/solana_rpc, see manifest.jsonl).

Bodies are byte-for-byte copies, except two getMultipleAccounts answers whose value
array was trimmed to a few real entries (structure edit only; the kept entries are
byte-identical, see manifest.jsonl). Fail-closed tests mutate copies in memory.
"""

from __future__ import annotations

import copy
import dataclasses
import http.client
import io
import itertools
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from samsulek.data.recorder.solana import Chain, PumpFun
from samsulek.data.sources.base58 import b58encode
from samsulek.data.sources.pumpfun import MINT_AUTHORITY_PDA, PROGRAM_ID, decode_bonding_curve
from samsulek.data.sources.solana_rpc import (
    DEFAULT_URL,
    HOST,
    KNOWN_EXTENSIONS,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    UNIT_EXTENSIONS,
    MintFacts,
    NotAMint,
    RawAccount,
    RpcBlockedError,
    SolanaFormatError,
    SolanaRpc,
    SolanaRpcError,
    clean_text,
    error_text,
    limiter,
    parse_envelope,
    parse_mint_account,
)
from samsulek.net.http import HttpClient, HttpError, RateLimitedError, RateLimiter

FIX = Path(__file__).parent / "fixtures" / "solana_rpc"
FETCHED = datetime(2026, 10, 12, 21, 27, 39, tzinfo=UTC)
BETA_HOST = "api.mainnet-beta.solana.com"  # where the fixtures were recorded

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
VEILCAT = "BwJ3d66CxNdahNF6UsxzLgf31Ma5uG1vCixDGU9upump"  # pump.fun coin, Token-2022
VEILCAT_CURVE = "CTwNRBQWaDQ9dMkRLiZyBfGpdDdfcHDRxUQazspznzez"
ARCHER = "GMP28mzGzJPodyzSpbL7HhpthAoPKajsuaJU46Jppump"  # second pump.fun coin
UNUSED = "7cbcGmk8P7tzBq7wzQA5JNmALMNCXRnNYp5TbKivy1w9"  # random pubkey: no account
MIXED_KEYS = [PROGRAM_ID, VEILCAT_CURVE, ARCHER, USDC, UNUSED]  # request order of the recording
CREATOR = "EVqx653MoY6esB9L6qruh3dTThCV4B43cBSsVWx9LQty"
BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"
JSON_HEADERS = [("Content-Type", "application/json")]
Mutation = Callable[[dict[str, Any]], None]


def body(name: str) -> bytes:
    return (FIX / f"{name}.json").read_bytes()


def doc(name: str) -> dict[str, Any]:
    loaded = json.loads(body(name))
    assert isinstance(loaded, dict)
    return loaded


def encode(document: dict[str, Any]) -> bytes:
    return json.dumps(document, separators=(",", ":")).encode()


def recorded_headers(name: str) -> list[tuple[str, str]]:
    """Response headers from a ``.headers.txt`` dump (metadata block, blank line, headers)."""
    _, _, headers = (FIX / f"{name}.headers.txt").read_text().partition("\n\n")
    return [
        (k.strip(), v.strip()) for k, _, v in (line.partition(":") for line in headers.splitlines() if line)
    ]


@dataclass
class Raw:
    status: int
    body: bytes
    headers: list[tuple[str, str]] = field(default_factory=lambda: list(JSON_HEADERS))

    def getheaders(self) -> list[tuple[str, str]]:
        return self.headers

    def read(self, amt: int | None = None) -> bytes:
        return self.body

    def close(self) -> None:
        pass


class Replay:
    """A fake opener: answers requests in order and keeps what was sent."""

    def __init__(self, *outcomes: object) -> None:
        self.outcomes = list(outcomes)
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> Raw:
        self.requests.append(request)
        out = self.outcomes.pop(0)
        if isinstance(out, BaseException):
            raise out
        assert isinstance(out, Raw)
        return out

    def payloads(self) -> list[Any]:
        out = []
        for r in self.requests:
            assert isinstance(r.data, bytes)
            out.append(json.loads(r.data))
        return out


def ok(name: str) -> Raw:
    return Raw(200, body(name))


def http_error(
    status: int, data: bytes, headers: list[tuple[str, str]] | None = None
) -> urllib.error.HTTPError:
    msg = http.client.HTTPMessage()
    for k, v in headers or JSON_HEADERS:
        msg[k] = v
    return urllib.error.HTTPError("https://x", status, "error", msg, io.BytesIO(data))


class FakeTime:
    def __init__(self) -> None:
        self.t = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


@dataclass
class Setup:
    rpc: SolanaRpc
    replay: Replay
    time: FakeTime
    http_sleeps: list[float]


def make(*outcomes: object, url: str = DEFAULT_URL) -> Setup:
    replay = Replay(*outcomes)
    fake = FakeTime()
    http_sleeps: list[float] = []
    client = HttpClient(
        user_agent="samsulek-test/0",
        allowed_hosts=frozenset({HOST, BETA_HOST}),
        opener=replay,
        now=lambda: FETCHED,
        sleep=http_sleeps.append,
    )
    rpc = SolanaRpc(
        client,
        url,
        call_limiter=RateLimiter(1, 1.0, monotonic=fake.monotonic, sleep=fake.sleep),
        heavy_limiter=RateLimiter(1, 2.0, monotonic=fake.monotonic, sleep=fake.sleep),
    )
    return Setup(rpc, replay, fake, http_sleeps)


def rpc_request(method: str, params: list[Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}


# --------------------------------------------------------------------- basics
def test_slot_from_a_real_answer_and_the_exact_request() -> None:
    s = make(ok("getSlot_confirmed"))
    assert s.rpc.slot() == 456194328
    (request,) = s.replay.requests
    assert request.full_url == "https://api.mainnet.solana.com"
    assert request.get_method() == "POST"
    assert request.get_header("Content-type") == "application/json"
    assert s.replay.payloads() == [rpc_request("getSlot", [{"commitment": "confirmed"}])]


def test_the_url_is_configurable_but_must_be_allowed_and_plain_https() -> None:
    s = make(ok("getSlot_confirmed"), url=f"https://{BETA_HOST}")
    s.rpc.slot("finalized")
    assert s.replay.requests[0].full_url == f"https://{BETA_HOST}"
    assert s.replay.payloads()[0]["params"] == [{"commitment": "finalized"}]
    client = HttpClient(user_agent="samsulek-test/0", allowed_hosts=frozenset({BETA_HOST}))
    with pytest.raises(ValueError, match=r"must allow api\.mainnet\.solana\.com"):
        SolanaRpc(client)
    for bad in (f"http://{BETA_HOST}", f"https://user:pw@{BETA_HOST}", f"https://{BETA_HOST}/#x"):
        with pytest.raises(ValueError, match="RPC URL"):
            SolanaRpc(client, bad)


def test_limiter_is_one_call_per_second_without_bursts() -> None:
    bucket = limiter()
    assert (bucket._interval, bucket._burst) == (1.0, 1.0)
    client = HttpClient(
        user_agent="samsulek-test/0", allowed_hosts=frozenset({HOST}), limiters={HOST: bucket}
    )
    assert SolanaRpc(client).host == HOST


def test_every_call_waits_one_second_and_heavy_methods_two() -> None:
    s = make(ok("getSlot_confirmed"), ok("getSlot_confirmed"))
    s.rpc.slot()
    s.rpc.slot()
    assert s.time.sleeps == [1.0]
    sig = "getSignaturesForAddress_pump_mintauth_pda_limit20"
    s = make(ok(sig), ok(sig))
    s.rpc.signatures(MINT_AUTHORITY_PDA, limit=20, commitment="confirmed")
    s.rpc.signatures(MINT_AUTHORITY_PDA, limit=20, commitment="confirmed")
    assert s.time.sleeps == [2.0]  # the heavy budget; the 1/s budget refilled meanwhile


# ----------------------------------------------------------------------- mints
def test_mints_from_a_real_mixed_batch() -> None:
    s = make(ok("getMultipleAccounts_mixed_jsonParsed"))
    result = s.rpc.mints(MIXED_KEYS)
    assert s.replay.payloads() == [
        rpc_request(
            "getMultipleAccounts", [MIXED_KEYS, {"encoding": "jsonParsed", "commitment": "confirmed"}]
        )
    ]
    assert (result.slot, result.fetched_at) == (456194475, FETCHED)
    assert list(result.facts) == MIXED_KEYS  # request order
    program = result.facts[PROGRAM_ID]
    assert program == NotAMint(
        PROGRAM_ID, BPF_UPGRADEABLE_LOADER, "a bpf-upgradeable-loader account, not a token mint"
    )
    curve = result.facts[VEILCAT_CURVE]
    assert isinstance(curve, NotAMint) and curve.account_owner == PROGRAM_ID
    assert result.facts[UNUSED] is None
    usdc = result.facts[USDC]
    assert usdc == MintFacts(
        address=USDC,
        token_program="spl-token",  # noqa: S106 (a program name)
        owner=TOKEN_PROGRAM_ID,
        mint_authority="BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG",
        freeze_authority="7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar",
        supply=7607200924013341,
        decimals=6,
        is_initialized=True,
        extensions=(),
    )
    archer = result.facts[ARCHER]
    assert isinstance(archer, MintFacts)
    assert (archer.token_program, archer.owner) == ("spl-token-2022", TOKEN_2022_PROGRAM_ID)
    assert (archer.mint_authority, archer.freeze_authority) == (None, None)
    assert (archer.supply, archer.decimals) == (1_000_000_000_000_000, 6)
    assert archer.extension_names == ("metadataPointer", "tokenMetadata")
    assert archer.unknown_extensions == ()
    assert archer.extensions[0][1] == {"authority": None, "metadataAddress": ARCHER}
    assert archer.extensions[1][1] == {
        "updateAuthority": None,
        "mint": ARCHER,
        "name": "pumpfun cat",
        "symbol": "Archer",
        "additionalMetadataEntries": 0,
    }


def test_get_account_info_values_parse_and_never_keep_urls() -> None:
    usdc = parse_mint_account(USDC, doc("getAccountInfo_USDC_jsonParsed")["result"]["value"])
    assert isinstance(usdc, MintFacts) and usdc.supply == 7607200924013347 and usdc.extensions == ()
    veil = parse_mint_account(VEILCAT, doc("getAccountInfo_pumpmint_token2022_jsonParsed")["result"]["value"])
    assert isinstance(veil, MintFacts)
    assert (veil.mint_authority, veil.freeze_authority, veil.is_initialized) == (None, None, True)
    assert dict(veil.extensions)["tokenMetadata"]["name"] == "VeilCat"
    assert dict(veil.extensions)["tokenMetadata"]["symbol"] == "VEILCAT"
    stored = json.dumps(dataclasses.asdict(veil))
    assert "ipfs" not in stored and "http" not in stored and "uri" not in stored


def test_untrusted_token_text_is_cleaned_and_links_dropped() -> None:
    value = doc("getAccountInfo_pumpmint_token2022_jsonParsed")["result"]["value"]
    meta = value["data"]["parsed"]["info"]["extensions"][1]["state"]
    meta["name"] = "\u202eVeil\U0001f431Cat\x1b[31m" + "x" * 100
    meta["symbol"] = "VEIL\nCAT"
    meta["additionalMetadata"] = [["twitter", "https://example.invalid/@veil"], ["site", "http://a.b"]]
    facts = parse_mint_account(VEILCAT, value)
    assert isinstance(facts, MintFacts)
    state = dict(facts.extensions)["tokenMetadata"]
    assert state["name"].startswith("?Veil?Cat?[31m") and len(state["name"]) == 40
    assert state["symbol"] == "VEIL CAT"
    assert state["additionalMetadataEntries"] == 2
    assert "http" not in json.dumps(dataclasses.asdict(facts))
    assert clean_text("a\u00e9\u202e b\t\tc") == "a?? b c"  # NFKC keeps e-acute as one char


def test_extensions_without_state_and_unknown_names_are_recorded_for_the_filter() -> None:
    value = doc("getAccountInfo_pumpmint_token2022_jsonParsed")["result"]["value"]
    info = value["data"]["parsed"]["info"]
    info["extensions"].append({"extension": "nonTransferable"})
    info["extensions"].append(
        {"extension": "someFutureThing", "state": {"authority": CREATOR, "note": "x" * 90}}
    )
    facts = parse_mint_account(VEILCAT, value)
    assert isinstance(facts, MintFacts)
    assert facts.extension_names[-2:] == ("nonTransferable", "someFutureThing")
    assert facts.extensions[-2][1] == {}
    assert facts.extensions[-1][1] == {"authority": CREATOR, "note": "x" * 40}  # pubkeys kept whole
    assert facts.unknown_extensions == ("someFutureThing",)


def test_token_accounts_and_unparsed_token_accounts_are_not_mints() -> None:
    value = doc("getAccountInfo_USDC_jsonParsed")["result"]["value"]
    as_account = copy.deepcopy(value)
    as_account["data"]["parsed"]["type"] = "account"
    assert parse_mint_account(USDC, as_account) == NotAMint(
        USDC, TOKEN_PROGRAM_ID, "a token account, not a mint"
    )
    unparsed = copy.deepcopy(value)
    unparsed["data"] = ["AAAA", "base64"]
    unparsed["space"] = 3
    facts = parse_mint_account(USDC, unparsed)
    assert isinstance(facts, NotAMint) and "could not parse" in facts.reason
    unparsed["space"] = 82  # the fallback bytes must be the whole account
    with pytest.raises(SolanaFormatError, match="3 data bytes but the account is 82 bytes"):
        parse_mint_account(USDC, unparsed)


def test_duplicate_addresses_are_asked_once() -> None:
    answer = doc("getMultipleAccounts_mixed_jsonParsed")
    answer["result"]["value"] = [answer["result"]["value"][3]]  # USDC only
    s = make(Raw(200, encode(answer)))
    result = s.rpc.mints([USDC, USDC])
    assert s.replay.payloads()[0]["params"][0] == [USDC]
    assert list(result.facts) == [USDC]


def test_bad_requests_are_refused_before_asking() -> None:
    s = make()
    hundred_and_one = [b58encode(bytes([n + 1]) * 32) for n in range(101)]
    with pytest.raises(ValueError, match="at most 100"):
        s.rpc.mints(hundred_and_one)
    with pytest.raises(ValueError, match="at most 100"):
        s.rpc.accounts_raw(hundred_and_one)
    for bad in ([], ["not-a-key"], [USDC[:-1] + "0"], [USDC + "1"]):
        with pytest.raises(ValueError, match="address"):
            s.rpc.mints(bad)
    with pytest.raises(ValueError, match="not one string"):
        s.rpc.mints(USDC)
    with pytest.raises(ValueError, match="commitment"):
        s.rpc.mints([USDC], commitment="processed")
    with pytest.raises(ValueError, match="commitment"):
        s.rpc.slot("processed")
    assert s.replay.requests == []


def test_the_real_101_keys_error_arrives_with_http_200() -> None:
    s = make(ok("getMultipleAccounts_101_keys_error"))
    with pytest.raises(SolanaRpcError) as caught:
        s.rpc.mints([USDC])
    assert (caught.value.code, caught.value.message) == (-32602, "Too many inputs provided; max 100")
    assert caught.value.method == "getMultipleAccounts"
    assert not isinstance(caught.value, ValueError | HttpError)


def _set(path: str, value: Any) -> Mutation:
    """Set doc[path] where path is like 'result.value.3.data.parsed.info.supply'."""

    def mutate(d: dict[str, Any]) -> None:
        *parents, last = path.split(".")
        node: Any = d
        for part in parents:
            node = node[int(part)] if isinstance(node, list) else node[part]
        if isinstance(node, list):
            node[int(last)] = value
        elif value is _DELETE:
            del node[last]
        else:
            node[last] = value

    return mutate


def _both(*mutations: Mutation) -> Mutation:
    def mutate(d: dict[str, Any]) -> None:
        for m in mutations:
            m(d)

    return mutate


def _future_extension(state: dict[str, Any]) -> Mutation:
    """Replace Archer's first extension with one this code doesn't know."""

    def mutate(d: dict[str, Any]) -> None:
        extensions = d["result"]["value"][2]["data"]["parsed"]["info"]["extensions"]
        extensions[0] = {"extension": "someFutureThing", "state": state}

    return mutate


_DELETE = object()
USDC_AT = "result.value.3"  # paths inside the mixed getMultipleAccounts answer
USDC_INFO = f"{USDC_AT}.data.parsed.info"
ARCHER_AT = "result.value.2"
ARCHER_INFO = f"{ARCHER_AT}.data.parsed.info"
ARCHER_META = f"{ARCHER_INFO}.extensions.1"


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (_set(f"{USDC_INFO}.supply", _DELETE), "missing"),
        (_set(f"{USDC_INFO}.supply", 7607200924013341), "expected a string"),
        (_set(f"{USDC_INFO}.supply", "-1"), "u64"),
        (_set(f"{USDC_INFO}.supply", str(2**64)), "u64"),
        (_set(f"{USDC_INFO}.supply", "1.5"), "u64"),
        (_set(f"{USDC_INFO}.decimals", 256), "decimals"),
        (_set(f"{USDC_INFO}.decimals", "6"), "decimals"),
        (_set(f"{USDC_INFO}.isInitialized", "true"), "isInitialized"),
        (_set(f"{USDC_INFO}.mintAuthority", "not-a-key"), "mintAuthority"),
        (_set(f"{USDC_INFO}.freezeAuthority", 7), "freezeAuthority"),
        (_set(f"{USDC_INFO}.newAuthority", None), "unexpected"),
        (_set(f"{USDC_INFO}.extensions", []), "extensions on a spl-token mint"),
        (_set("result.value.3.owner", TOKEN_2022_PROGRAM_ID), "parsed as spl-token but owned by"),
        (_set("result.value.3.data.program", "spl-governance"), "owned by a token program but parsed"),
        (_set("result.value.3.data.parsed.type", "weird"), "unknown token account type"),
        (_set("result.value.3.data.parsed.extra", 1), "parsed: unexpected keys 'extra'"),
        (_set("result.value.3.lamports", -1), "lamports"),
        (_set("result.value.3.executable", "no"), "executable"),
        (_set("result.value.3.owner", "Tokenkeg"), "owner"),
        (_set("result.value.3.data", "base58text"), "expected an object"),
        (_set("result.value.1.data", ["%%%", "base64"]), "bad base64"),
        (_set("result.value.1.data", ["AAAA", "base58"]), "base64"),
        (_set(f"{ARCHER_INFO}.extensions", {}), "expected an array"),
        (_set(f"{ARCHER_INFO}.extensions.0.extension", "Bad Name"), "odd extension name"),
        (_set(f"{ARCHER_INFO}.extensions.0.state", None), "expected an object"),
        (_set(f"{ARCHER_INFO}.extensions.0.other", 1), "unexpected keys"),
        (_future_extension({"authority": {"a": {"b": {"c": 1}}}}), "nested deeper"),
        (_future_extension({"bad-key": 1}), "unexpected key"),
        (_set(f"{ARCHER_INFO}.extensions.0.state.bad-key", 1), "unexpected keys 'bad-key'"),
        (_set(f"{ARCHER_META}.state.uri", _DELETE), "missing 'uri'"),
        (_set(f"{ARCHER_META}.state.mint", "x"), "mint"),
        (_set(f"{ARCHER_META}.state.name", 5), "name"),
        # account objects: exactly agave's UiAccount fields
        (_set(f"{USDC_AT}.newField", 1), "unexpected keys 'newField'"),
        (_set(f"{USDC_AT}.rentEpoch", _DELETE), "missing 'rentEpoch'"),
        (_set(f"{USDC_AT}.rentEpoch", -1), "rentEpoch"),
        (_set(f"{USDC_AT}.space", "82"), "space"),
        (_set(f"{USDC_AT}.data.space", 83), "account space 82 but data.space 83"),
        (_set(f"{USDC_AT}.data.space", _DELETE), "missing 'space'"),
        (_set(f"{USDC_AT}.data.extra", 1), "data: unexpected keys 'extra'"),
        (_set(f"{USDC_AT}.executable", True), "can't be executable"),
        (_set("result.value.1.space", 165), "166 data bytes but the account is 165 bytes"),
        (_set("result.context.apiVersion", 4), "apiVersion"),
        (_set("result.context.extra", 1), "context: unexpected keys 'extra'"),
        # mint sizes: 82 bytes, Token-2022 extensions only after them
        (
            _both(_set(f"{USDC_AT}.space", 165), _set(f"{USDC_AT}.data.space", 165)),
            "an spl-token mint is 82 bytes, this one 165",
        ),
        (
            _both(_set(f"{ARCHER_AT}.space", 82), _set(f"{ARCHER_AT}.data.space", 82)),
            "extensions listed on a 82-byte mint",
        ),
        (_set(f"{ARCHER_INFO}.extensions", []), "empty extensions list"),
        # known extension states: exactly agave's fields and types
        (_set(f"{ARCHER_INFO}.extensions.0.state.authority", "x"), "state.authority: not a Solana address"),
        (_set(f"{ARCHER_INFO}.extensions.0.state.metadataAddress", _DELETE), "missing 'metadataAddress'"),
        (_set(f"{ARCHER_INFO}.extensions.0.state", _DELETE), "metadataPointer has no state"),
        (_set(f"{ARCHER_INFO}.extensions.0.extension", "immutableOwner"), "immutableOwner has a state"),
        (_set(f"{ARCHER_META}.state.additionalMetadata", [["twitter"]]), "string pair"),
        (_set(f"{ARCHER_META}.state.additionalMetadata", [["a", 1]]), "string pair"),
        (_set("result.value", [None] * 4), "asked for 5 accounts, got 4"),
        (_set("result.value", [None] * 6), "asked for 5 accounts, got 6"),
        (_set("result.context.slot", "456194475"), "slot"),
        (_set("result.context", _DELETE), "context and value"),
        (_set("result.extra", 1), "context and value"),
    ],
)
def test_unexpected_mint_content_stops_instead_of_guessing(mutate: Mutation, message: str) -> None:
    answer = doc("getMultipleAccounts_mixed_jsonParsed")
    mutate(answer)
    s = make(Raw(200, encode(answer)))
    with pytest.raises(SolanaFormatError, match=message):
        s.rpc.mints(MIXED_KEYS, strict=True)


def test_one_unreadable_mint_is_marked_and_the_others_keep_their_facts() -> None:
    answer = doc("getMultipleAccounts_mixed_jsonParsed")
    _set(f"{ARCHER_INFO}.extensions", [])(answer)  # Archer is refused, USDC is fine
    result = make(Raw(200, encode(answer))).rpc.mints(MIXED_KEYS)
    archer = result.facts[ARCHER]
    assert isinstance(archer, NotAMint) and archer.account_owner == TOKEN_2022_PROGRAM_ID
    assert archer.reason.startswith("unreadable: ") and "empty extensions list" in archer.reason
    assert isinstance(result.facts[USDC], MintFacts)
    assert result.facts[UNUSED] is None


def test_many_unreadable_mints_look_like_a_format_change_and_stop() -> None:
    answer = doc("getMultipleAccounts_mixed_jsonParsed")
    # 4 accounts exist (program, curve, Archer, USDC); 2 of them are not mints anyway.
    _both(_set(f"{ARCHER_INFO}.extensions", []), _set(f"{USDC_INFO}.supply", "-1"))(answer)
    s = make(Raw(200, encode(answer)))
    result = s.rpc.mints(MIXED_KEYS)  # 2 refused: below the 3 that suggest a format change
    assert isinstance(result.facts[USDC], NotAMint)
    _set(f"{USDC_AT}.data.parsed.type", "weird")(answer)
    _set("result.value.1.data", ["%%%", "base64"])(answer)  # a third one refused
    with pytest.raises(SolanaFormatError, match="3 of 4 mint accounts unreadable"):
        make(Raw(200, encode(answer))).rpc.mints(MIXED_KEYS)


def test_a_token_2022_mint_with_unlisted_extensions_is_never_a_clean_mint() -> None:
    # agave builds the list with get_extension_types().unwrap_or_default(): a node that
    # can't read the TLV data (an extension newer than the node) shows NO extensions.
    value = doc("getAccountInfo_pumpmint_token2022_jsonParsed")["result"]["value"]
    assert value["space"] == value["data"]["space"] == 412  # 82 + TLV (2 extensions)
    del value["data"]["parsed"]["info"]["extensions"]
    facts = parse_mint_account(VEILCAT, value)
    assert facts == NotAMint(
        VEILCAT,
        TOKEN_2022_PROGRAM_ID,
        "a 412-byte Token-2022 mint whose extensions the node did not list: facts incomplete",
    )
    value["space"] = value["data"]["space"] = 82  # a plain 82-byte mint really has none
    plain = parse_mint_account(VEILCAT, value)
    assert isinstance(plain, MintFacts) and plain.extensions == ()
    value["data"]["parsed"]["info"]["mintAuthority"] = "x"  # still checked in full
    with pytest.raises(SolanaFormatError, match="mintAuthority"):
        parse_mint_account(VEILCAT, value)


# Extension states built in memory from agave's Ui* structs (token.rs at 809b5598). Only
# metadataPointer and tokenMetadata were seen live; these test the checks, not the node.
TRANSFER_FEE = {"epoch": 812, "maximumFee": 5_000_000, "transferFeeBasisPoints": 250}
CONSTRUCTED_STATES: dict[str, dict[str, Any]] = {
    "transferFeeConfig": {
        "transferFeeConfigAuthority": CREATOR,
        "withdrawWithheldAuthority": None,
        "withheldAmount": 0,
        "olderTransferFee": TRANSFER_FEE,
        "newerTransferFee": TRANSFER_FEE,
    },
    "pausableConfig": {"authority": CREATOR, "paused": False},
    "permanentDelegate": {"delegate": CREATOR},
    "defaultAccountState": {"accountState": "frozen"},
    "interestBearingConfig": {
        "rateAuthority": None,
        "initializationTimestamp": 1791840498,
        "preUpdateAverageRate": -5,
        "lastUpdateTimestamp": 1791840498,
        "currentRate": 32767,
    },
    "confidentialTransferMint": {
        "authority": None,
        "autoApproveNewAccounts": True,
        "auditorElgamalPubkey": "a" * 43 + "=",  # 44 chars: kept whole, not cut to 40
    },
    "scaledUiAmountConfig": {
        "authority": None,
        "multiplier": "1.5",
        "newMultiplierEffectiveTimestamp": 0,
        "newMultiplier": "1.5",
    },
}


def with_extension(name: str, state: dict[str, Any] | None) -> dict[str, Any]:
    """The real VeilCat mint with its first extension replaced."""
    value = doc("getAccountInfo_pumpmint_token2022_jsonParsed")["result"]["value"]
    item: dict[str, Any] = {"extension": name}
    if state is not None:
        item["state"] = state
    value["data"]["parsed"]["info"]["extensions"][0] = item
    return value


@pytest.mark.parametrize("name", sorted(CONSTRUCTED_STATES))
def test_known_extension_states_are_kept_whole_and_typed(name: str) -> None:
    state = CONSTRUCTED_STATES[name]
    facts = parse_mint_account(VEILCAT, with_extension(name, copy.deepcopy(state)))
    assert isinstance(facts, MintFacts) and facts.extensions[0] == (name, state)
    assert facts.unknown_extensions == ()


def test_every_agave_extension_variant_is_known() -> None:
    assert len(KNOWN_EXTENSIONS) == 30  # agave UiExtension has 30 variants
    for name in UNIT_EXTENSIONS:
        facts = parse_mint_account(VEILCAT, with_extension(name, None))
        assert isinstance(facts, MintFacts) and facts.extensions[0] == (name, {})


def _state_set(name: str, path: str, value: Any) -> tuple[str, dict[str, Any]]:
    state = copy.deepcopy(CONSTRUCTED_STATES[name])
    *parents, last = path.split(".")
    node = state
    for part in parents:
        node = node[part]
    if value is _DELETE:
        del node[last]
    else:
        node[last] = value
    return name, state


@pytest.mark.parametrize(
    ("case", "message"),
    [
        (_state_set("pausableConfig", "paused", "false"), "paused: expected true/false"),
        (_state_set("pausableConfig", "authority", "not-a-key"), "authority: not a Solana address"),
        (_state_set("pausableConfig", "pausedSince", 1), "unexpected keys 'pausedSince'"),
        (_state_set("permanentDelegate", "delegate", _DELETE), "missing 'delegate'"),
        (_state_set("transferFeeConfig", "newerTransferFee.transferFeeBasisPoints", 65536), "0..65535"),
        (_state_set("transferFeeConfig", "newerTransferFee.transferFeeBasisPoints", "250"), "0..65535"),
        (_state_set("transferFeeConfig", "olderTransferFee.extra", 1), "unexpected keys 'extra'"),
        (_state_set("transferFeeConfig", "withheldAmount", -1), "withheldAmount"),
        (_state_set("defaultAccountState", "accountState", "thawed"), "unknown account state"),
        (_state_set("interestBearingConfig", "currentRate", 32768), "expected an i16"),
        (_state_set("interestBearingConfig", "initializationTimestamp", 1.5), "expected an i64"),
        (_state_set("confidentialTransferMint", "auditorElgamalPubkey", "a b"), "printable ASCII"),
        (_state_set("confidentialTransferMint", "auditorElgamalPubkey", "a" * 129), "printable ASCII"),
        (_state_set("scaledUiAmountConfig", "multiplier", 1.5), "printable ASCII"),
    ],
)
def test_wrong_extension_state_types_stop_instead_of_guessing(
    case: tuple[str, dict[str, Any]], message: str
) -> None:
    name, state = case
    with pytest.raises(SolanaFormatError, match=message):
        parse_mint_account(VEILCAT, with_extension(name, state))


# ------------------------------------------------------------------- envelope
@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b'{"jsonrpc":"1.0","result":1,"id":1}', "JSON-RPC 2.0"),
        (b'{"jsonrpc":"2.0","result":1,"id":2}', "request id"),
        (b'{"jsonrpc":"2.0","result":1,"id":true}', "request id"),
        (b'{"jsonrpc":"2.0","result":1,"error":{"code":1,"message":"x"},"id":1}', "both"),
        (b'{"jsonrpc":"2.0","id":1}', "neither"),
        (b'{"jsonrpc":"2.0","error":{"code":"1","message":"x"},"id":1}', "malformed error"),
        (b'{"jsonrpc":"2.0","error":"boom","id":1}', "malformed error"),
        (b'{"jsonrpc":"2.0","result":1,"id":1,"extra":1}', "unexpected keys"),
        (b'{"jsonrpc":"2.0","result":NaN,"id":1}', "not valid JSON"),
        (b"[1]", "expected a JSON object"),
        (b"<html>maintenance</html>", "not valid JSON"),
        (b"", "not valid JSON"),
    ],
)
def test_broken_envelopes_are_refused(data: bytes, message: str) -> None:
    with pytest.raises(SolanaFormatError, match=message):
        parse_envelope(data, "getSlot")


def test_slot_must_be_a_u64_and_answers_must_be_json() -> None:
    with pytest.raises(SolanaFormatError, match="getSlot result"):
        make(Raw(200, b'{"jsonrpc":"2.0","result":-5,"id":1}')).rpc.slot()
    with pytest.raises(SolanaFormatError, match="getSlot result"):
        make(Raw(200, b'{"jsonrpc":"2.0","result":1.5,"id":1}')).rpc.slot()
    html = Raw(200, b"<html>maintenance</html>", [("Content-Type", "text/html")])
    with pytest.raises(SolanaFormatError, match="application/json"):
        make(html).rpc.slot()
    charset = Raw(200, body("getSlot_confirmed"), [("Content-Type", "application/json; charset=utf-8")])
    assert make(charset).rpc.slot() == 456194328


def test_http_403_means_blocked_stop_and_alert() -> None:
    blocked = body("getProgramAccounts_403_blocked")
    s = make(ok("getSlot_confirmed"), http_error(403, blocked))
    with pytest.raises(RpcBlockedError, match="Your IP or provider is blocked") as caught:
        s.rpc.token_holders(VEILCAT, TOKEN_2022_PROGRAM_ID)
    assert isinstance(caught.value, HttpError) and caught.value.status == 403
    assert "stop and alert" in str(caught.value)
    assert len(s.replay.requests) == 2  # never retried
    assert error_text(blocked.decode()) == "Your IP or provider is blocked from this endpoint"
    assert error_text("<html>\x00nope</html>") == "<html>?nope</html>"


def test_http_429_is_retried_after_retry_after_then_reported() -> None:
    name = "getTokenLargestAccounts_429_method_limit_0_pumpmint"
    headers = recorded_headers(name)
    assert ("retry-after", "10") in headers and ("x-ratelimit-method-limit", "0") in headers
    s = make(*(http_error(429, body(name), headers) for _ in range(4)))
    with pytest.raises(RateLimitedError) as caught:
        s.rpc.signatures(MINT_AUTHORITY_PDA, limit=20)
    assert caught.value.status == 429
    assert s.http_sleeps == [10.0, 10.0, 10.0]  # HttpClient honours Retry-After: 10
    assert len(s.replay.requests) == 4


def test_receive_times_are_utc_and_a_naive_clock_is_refused() -> None:
    athens = datetime(2026, 10, 13, 0, 27, 39, tzinfo=timezone(timedelta(hours=3)))
    naive = datetime(2026, 10, 12, 21, 27, 39)  # noqa: DTZ001 (deliberately naive)
    for now, expected in ((athens, FETCHED), (naive, None)):
        client = HttpClient(
            user_agent="samsulek-test/0",
            allowed_hosts=frozenset({HOST}),
            opener=Replay(ok("getMultipleAccounts_mixed_jsonParsed")),
            now=lambda now=now: now,  # type: ignore[misc]
        )
        rpc = SolanaRpc(client)  # the first call of a fresh limiter doesn't wait
        if expected is None:
            with pytest.raises(ValueError, match="timezone-aware"):
                rpc.mints(MIXED_KEYS)
        else:
            fetched_at = rpc.mints(MIXED_KEYS).fetched_at
            assert fetched_at == expected and fetched_at.tzinfo is UTC


def test_other_http_errors_pass_through() -> None:
    s = make(http_error(400, b'{"jsonrpc":"2.0","error":{"code":-32600,"message":"bad"},"id":1}'))
    with pytest.raises(HttpError) as caught:
        s.rpc.slot()
    assert caught.value.status == 400 and not isinstance(caught.value, RpcBlockedError)


# ------------------------------------------------------------------ signatures
PDA_SIGS = "getSignaturesForAddress_pump_mintauth_pda_limit20"
PROGRAM_SIGS = "getSignaturesForAddress_pumpfun_limit20"


def test_signatures_of_the_real_creation_stream() -> None:
    s = make(ok(PDA_SIGS))
    sigs = s.rpc.signatures(MINT_AUTHORITY_PDA, limit=20, commitment="confirmed")
    assert s.replay.payloads() == [
        rpc_request("getSignaturesForAddress", [MINT_AUTHORITY_PDA, {"commitment": "confirmed", "limit": 20}])
    ]
    assert len(sigs) == 20 and not any(x.failed for x in sigs)
    first, last = sigs[0], sigs[-1]
    assert first.signature.startswith("3ghEnYoVG6hf") and first.slot == 456194812
    assert first.block_time == datetime.fromtimestamp(1791840532, UTC)
    assert last.slot == 456194657 and last.block_time == datetime.fromtimestamp(1791840498, UTC)
    assert all(a.slot >= b.slot for a, b in itertools.pairwise(sigs))
    assert all(x.block_time is not None and x.block_time.tzinfo is UTC for x in sigs)


def test_failed_transactions_are_listed_and_flagged() -> None:
    sigs = make(ok(PROGRAM_SIGS)).rpc.signatures(PROGRAM_ID, limit=20, commitment="confirmed")
    assert len(sigs) == 20 and sum(x.failed for x in sigs) == 6
    assert {x.slot for x in sigs} == {456194496}


def test_signatures_default_to_finalized_and_pass_until_and_before() -> None:
    other = doc(PROGRAM_SIGS)["result"]
    until, before = other[-1]["signature"], other[0]["signature"]
    s = make(ok(PDA_SIGS))
    s.rpc.signatures(MINT_AUTHORITY_PDA, until=until, before=before)
    (payload,) = s.replay.payloads()
    assert payload["params"] == [
        MINT_AUTHORITY_PDA,
        {"commitment": "finalized", "limit": 1000, "until": until, "before": before},
    ]


def test_bad_signature_requests_are_refused_before_asking() -> None:
    s = make()
    for limit in (0, 1001, True, 20.0, "20"):
        with pytest.raises(ValueError, match="limit"):
            s.rpc.signatures(MINT_AUTHORITY_PDA, limit=limit)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="commitment"):
        s.rpc.signatures(MINT_AUTHORITY_PDA, commitment="processed")
    with pytest.raises(ValueError, match="until"):
        s.rpc.signatures(MINT_AUTHORITY_PDA, until=USDC)  # a pubkey is 32 bytes, not 64
    with pytest.raises(ValueError, match="before"):
        s.rpc.signatures(MINT_AUTHORITY_PDA, before="0" * 88)
    with pytest.raises(ValueError, match="address"):
        s.rpc.signatures("TSLvdd")
    assert s.replay.requests == []


def _sig_set(index: int, key: str, value: Any) -> Mutation:
    return lambda d: d["result"][index].__setitem__(key, value)


def _sig_del(index: int, key: str) -> Mutation:
    return lambda d: d["result"][index].pop(key)


@pytest.mark.parametrize(
    ("mutate", "limit", "until", "message"),
    [
        (lambda d: None, 19, None, "at most 19 signatures, got 20"),
        (lambda d: d["result"].append(d["result"][0]), 1000, None, "listed twice"),
        (lambda d: d["result"].reverse(), 1000, None, r"newest-first \(slot 456194662 after 456194657\)"),
        (lambda d: None, 1000, "first", "until/before signature itself"),
        (_sig_del(3, "slot"), 1000, None, "missing 'slot'"),
        (_sig_set(3, "slot", "456194800"), 1000, None, "slot"),
        (_sig_del(3, "err"), 1000, None, "missing 'err'"),
        (_sig_set(3, "blockTime", "2026-10-12"), 1000, None, "blockTime"),
        (_sig_set(3, "blockTime", -1), 1000, None, "blockTime"),
        (_sig_set(3, "confirmationStatus", "rooted"), 1000, None, "confirmationStatus"),
        (_sig_set(3, "signature", USDC), 1000, None, "not a transaction signature"),
        (_sig_set(3, "signature", 7), 1000, None, "expected a string"),
        (_sig_set(3, "memo", 7), 1000, None, "memo"),
        (_sig_set(3, "newField", 1), 1000, None, "unexpected keys 'newField'"),
        (_sig_set(3, "err", 5), 1000, None, "err: expected an object, a string or null"),
        (_sig_set(3, "err", False), 1000, None, "err: expected an object, a string or null"),
        (_sig_set(3, "transactionIndex", "813"), 1000, None, "transactionIndex"),
        (_sig_set(1, "transactionIndex", 392), 1000, None, "transactionIndex 392 after 392"),
        (lambda d: d.__setitem__("result", {"value": []}), 1000, None, "expected an array"),
        (lambda d: d["result"].__setitem__(2, "x"), 1000, None, "expected an object"),
    ],
)
def test_unexpected_signature_content_stops_instead_of_guessing(
    mutate: Mutation, limit: int, until: str | None, message: str
) -> None:
    answer = doc(PDA_SIGS)
    if until == "first":
        until = answer["result"][0]["signature"]
    mutate(answer)
    s = make(Raw(200, encode(answer)))
    with pytest.raises(SolanaFormatError, match=message):
        s.rpc.signatures(MINT_AUTHORITY_PDA, until=until, limit=limit, commitment="confirmed")


def test_null_block_time_and_memo_are_allowed() -> None:
    answer = doc(PDA_SIGS)
    answer["result"][0]["blockTime"] = None
    answer["result"][0]["confirmationStatus"] = None
    answer["result"][1]["memo"] = "[12] some memo"
    answer["result"][2]["err"] = "AccountInUse"  # documented: "object | string | null"
    sigs = make(Raw(200, encode(answer))).rpc.signatures(MINT_AUTHORITY_PDA, limit=20)
    assert sigs[0].block_time is None and sigs[1].block_time is not None
    assert [x.failed for x in sigs[:4]] == [False, False, True, False]


def test_order_inside_one_slot_is_checked_with_the_transaction_index() -> None:
    answer = doc(PROGRAM_SIGS)  # all 20 in one slot, transactionIndex 588, 581, ...
    items = answer["result"]
    items[0], items[1] = items[1], items[0]  # the slots can't show this swap
    with pytest.raises(SolanaFormatError, match="transactionIndex 588 after 581"):
        make(Raw(200, encode(answer))).rpc.signatures(PROGRAM_ID, limit=20, commitment="confirmed")
    for item in items:
        del item["transactionIndex"]  # undocumented: without it only the slots are checked
    sigs = make(Raw(200, encode(answer))).rpc.signatures(PROGRAM_ID, limit=20, commitment="confirmed")
    assert len(sigs) == 20


# --------------------------------------------------------------------- holders
HOLDERS = "getProgramAccounts_token2022_memcmp_mint_holders"


def test_holders_of_a_real_dead_coin() -> None:
    s = make(ok("getSlot_confirmed"), ok(HOLDERS))
    result = s.rpc.token_holders(VEILCAT, TOKEN_2022_PROGRAM_ID)
    slot_request, gpa_request = s.replay.payloads()
    assert slot_request == rpc_request("getSlot", [{"commitment": "confirmed"}])
    assert gpa_request == rpc_request(
        "getProgramAccounts",
        [
            TOKEN_2022_PROGRAM_ID,
            {
                "encoding": "base64",
                "commitment": "confirmed",
                "minContextSlot": 456194328,
                "dataSlice": {"offset": 32, "length": 40},
                "filters": [{"memcmp": {"offset": 0, "bytes": VEILCAT}}],
            },
        ],
    )
    assert (result.slot, result.fetched_at) == (456194328, FETCHED)
    # Everyone sold, the dev included: the whole supply is back in the bonding curve.
    assert result.holders == (
        (VEILCAT_CURVE, 1_000_000_000_000_000),
        ("5zopDst7DYhXbhg3Jc9bqb9SMmBX5EUgV9R8U2KBLtsY", 0),
        (CREATOR, 0),
    )
    assert s.time.sleeps == [1.0]  # getSlot, then the heavy call one second later


def test_holder_requests_are_refused_before_asking() -> None:
    s = make()
    with pytest.raises(ValueError, match="token program"):
        s.rpc.token_holders(VEILCAT, PROGRAM_ID)
    with pytest.raises(ValueError, match="address"):
        s.rpc.token_holders("VeilCat", TOKEN_2022_PROGRAM_ID)
    with pytest.raises(ValueError, match="commitment"):
        s.rpc.token_holders(VEILCAT, TOKEN_2022_PROGRAM_ID, commitment="processed")
    assert s.replay.requests == []


def _acct(key: str, value: Any) -> Mutation:
    return lambda d: d["result"][1]["account"].__setitem__(key, value)


@pytest.mark.parametrize(
    ("mutate", "program", "message"),
    [
        (_acct("owner", TOKEN_PROGRAM_ID), TOKEN_2022_PROGRAM_ID, "not the token program asked for"),
        (_acct("space", 82), TOKEN_2022_PROGRAM_ID, "82 bytes is not a token account"),
        (_acct("space", 355), TOKEN_2022_PROGRAM_ID, "355 bytes is not a token account"),
        (_acct("space", None), TOKEN_2022_PROGRAM_ID, "space"),
        (_acct("executable", True), TOKEN_2022_PROGRAM_ID, "can't be executable"),
        (_acct("data", ["AAAA", "base64"]), TOKEN_2022_PROGRAM_ID, "40-byte slice"),
        (_acct("data", {"parsed": {}}), TOKEN_2022_PROGRAM_ID, "expected an array"),
        (lambda d: d["result"].append(d["result"][0]), TOKEN_2022_PROGRAM_ID, "listed twice"),
        (lambda d: d["result"][0].__setitem__("pubkey", "x"), TOKEN_2022_PROGRAM_ID, "pubkey"),
        (lambda d: d["result"][0].pop("account"), TOKEN_2022_PROGRAM_ID, "missing 'account'"),
        (lambda d: d["result"][0].__setitem__("extra", 1), TOKEN_2022_PROGRAM_ID, "unexpected keys 'extra'"),
        (_acct("extra", 1), TOKEN_2022_PROGRAM_ID, "account: unexpected keys 'extra'"),
        (lambda d: d["result"][1]["account"].pop("lamports"), TOKEN_2022_PROGRAM_ID, "missing 'lamports'"),
        (_acct("rentEpoch", "x"), TOKEN_2022_PROGRAM_ID, "rentEpoch"),
        (lambda d: d.__setitem__("result", {"context": {}, "value": []}), TOKEN_2022_PROGRAM_ID, "array"),
    ],
)
def test_unexpected_holder_content_stops_instead_of_guessing(
    mutate: Mutation, program: str, message: str
) -> None:
    answer = doc(HOLDERS)
    mutate(answer)
    s = make(ok("getSlot_confirmed"), Raw(200, encode(answer)))
    with pytest.raises(SolanaFormatError, match=message):
        s.rpc.token_holders(VEILCAT, program)


def test_spl_token_holder_accounts_must_be_exactly_165_bytes() -> None:
    answer = doc(HOLDERS)
    for item in answer["result"]:
        item["account"]["owner"] = TOKEN_PROGRAM_ID  # same records, as if SPL Token
    s = make(ok("getSlot_confirmed"), Raw(200, encode(answer)))
    with pytest.raises(SolanaFormatError, match="170 bytes is not a token account"):
        s.rpc.token_holders(VEILCAT, TOKEN_PROGRAM_ID)
    for item in answer["result"]:
        item["account"]["space"] = 165
    s = make(ok("getSlot_confirmed"), Raw(200, encode(answer)))
    assert len(s.rpc.token_holders(VEILCAT, TOKEN_PROGRAM_ID).holders) == 3


# ------------------------------------------------------------------ raw accounts
def test_raw_accounts_give_the_real_bonding_curve_bytes() -> None:
    s = make(ok("getMultipleAccounts_mixed_jsonParsed_trimmed_curve_null"))
    slot, accounts = s.rpc.accounts_raw([VEILCAT_CURVE, UNUSED])
    assert s.replay.payloads()[0]["params"] == [
        [VEILCAT_CURVE, UNUSED],
        {"encoding": "base64", "commitment": "confirmed"},
    ]
    assert slot == 456194475 and list(accounts) == [VEILCAT_CURVE, UNUSED]
    curve = accounts[VEILCAT_CURVE]
    assert isinstance(curve, RawAccount)
    assert (curve.owner, curve.lamports, len(curve.data)) == (PROGRAM_ID, 1493520, 166)
    assert decode_bonding_curve(curve.data).creator == CREATOR
    assert accounts[UNUSED] is None


def test_raw_accounts_refuse_parsed_data_short_data_and_wrong_counts() -> None:
    s = make(ok("getMultipleAccounts_mixed_jsonParsed"))
    with pytest.raises(SolanaFormatError, match="expected an array"):
        s.rpc.accounts_raw(MIXED_KEYS)  # a parsed object where raw bytes were expected
    s = make(ok("getMultipleAccounts_base64_dataSlice0_trimmed"))
    # A sliced answer can't pass as whole accounts. (Both recorded entries are the USDC
    # mint, asked 100 times; the first one already fails, so the second key is moot.)
    with pytest.raises(SolanaFormatError, match="0 data bytes but the account is 82 bytes"):
        s.rpc.accounts_raw([USDC, ARCHER])
    s = make(ok("getMultipleAccounts_mixed_jsonParsed_trimmed_curve_null"))
    with pytest.raises(SolanaFormatError, match="asked for 3 accounts, got 2"):
        s.rpc.accounts_raw([VEILCAT_CURVE, UNUSED, USDC])
    answer = doc("getMultipleAccounts_mixed_jsonParsed_trimmed_curve_null")
    answer["result"]["value"][0]["space"] = None  # documented as "u64 | null": no length check
    _, accounts = make(Raw(200, encode(answer))).rpc.accounts_raw([VEILCAT_CURVE, UNUSED])
    assert accounts[VEILCAT_CURVE] is not None


# -------------------------------------------------------------------- recorder
def test_the_recorder_can_use_this_client_and_the_pump_decoder() -> None:
    chain: Chain = make().rpc  # checked by mypy: the recorder's protocol is satisfied
    pump = PumpFun(
        program_id=PROGRAM_ID, mint_authority_pda=MINT_AUTHORITY_PDA, decode_curve=decode_bonding_curve
    )
    assert chain is not None and pump.decode_curve is decode_bonding_curve
    record = dataclasses.asdict(NotAMint(VEILCAT_CURVE, PROGRAM_ID, "x"))
    assert "owner" not in record  # the recorder reads "owner" as the mint's token program
