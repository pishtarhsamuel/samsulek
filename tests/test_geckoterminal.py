"""GeckoTerminal new-pools adapter, tested on real responses recorded 2026-10-12
(tests/fixtures/geckoterminal).

The 200 pages were trimmed to a few real pools each (whole records removed, nothing
edited; the kept records are byte-identical to the recording). The error bodies and all
``.headers.txt`` dumps are byte-for-byte copies (curl dumps, starting with the proxy's
CONNECT answer; one was saved with CRLF line endings).
"""

from __future__ import annotations

import copy
import email.utils
import http.client
import io
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import astuple, dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from samsulek.data.sources.geckoterminal import (
    ACCEPT,
    HOST,
    MAX_BODY_BYTES,
    GeckoTerminalFormatError,
    GeckoTerminalSource,
    NewPool,
    clean_text,
    error_message,
    limiter,
    parse_new_pools,
)
from samsulek.net.http import HttpClient, HttpError, RateLimitedError, RateLimiter
from withheld import read_fixture

FIX = Path(__file__).parent / "fixtures" / "geckoterminal"
FETCHED = datetime(2026, 10, 12, 21, 15, 45, tzinfo=UTC)
P1 = "solana_new_pools_p1_r2"  # Age: 17, includes a name with a RIGHT-TO-LEFT OVERRIDE
P1_EARLY = "solana_new_pools_p1_t0"  # Age: 23, null and "0.0" reserves, CRLF header dump
P2_NO_AGE = "solana_new_pools_p2_r5"  # a cache HIT without an Age header
RATE_LIMITED = "solana_new_pools_p1_r1"  # HTTP 429
PAGE_11 = "solana_new_pools_p11_r2"  # HTTP 401 for page > 10
NEW_POOLS_URL = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools"
SOL = "So11111111111111111111111111111111111111112"
Mutation = Callable[[dict[str, Any]], None]


def body(name: str) -> bytes:
    return read_fixture(f"geckoterminal/{name}.json")


def recorded_headers(name: str) -> list[tuple[str, str]]:
    """Headers of the last HTTP response in a curl dump (skips the proxy's CONNECT answer)."""
    out: list[tuple[str, str]] = []
    for line in (FIX / f"{name}.headers.txt").read_text(encoding="ascii").splitlines():
        if line.startswith("HTTP/"):
            out = []
        elif ":" in line:
            key, value = line.split(":", 1)
            if key.strip().lower() != "content-length":  # it measured the untrimmed original
                out.append((key.strip(), value.strip()))
    return out


def headers(name: str) -> dict[str, str]:
    return {k.lower(): v for k, v in recorded_headers(name)}


def fetched(name: str) -> datetime:
    """A realistic receive time for a recording: one second after its server Date."""
    return email.utils.parsedate_to_datetime(headers(name)["date"]) + timedelta(seconds=1)


@dataclass
class Raw:
    status: int
    body: bytes
    headers: list[tuple[str, str]] = field(default_factory=list)

    def getheaders(self) -> list[tuple[str, str]]:
        return self.headers

    def read(self, amt: int | None = None) -> bytes:
        return self.body

    def close(self) -> None:
        pass


def recorded(name: str) -> Raw:
    return Raw(200, body(name), recorded_headers(name))


class Replay:
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


def http_error(status: int, name: str) -> urllib.error.HTTPError:
    msg = http.client.HTTPMessage()
    for key, value in recorded_headers(name):
        msg[key] = value
    return urllib.error.HTTPError(NEW_POOLS_URL, status, "error", msg, io.BytesIO(body(name)))


class FakeTime:
    """One fake clock for the client's backoff and the rate limiter: nothing really sleeps."""

    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def source(replay: Replay, sleeps: list[float] | None = None, retries: int = 3) -> GeckoTerminalSource:
    clock = FakeTime()
    backoffs = sleeps if sleeps is not None else []

    def backoff(seconds: float) -> None:
        backoffs.append(seconds)
        clock.sleep(seconds)

    client = HttpClient(
        user_agent="samsulek-test/0",
        allowed_hosts=frozenset({HOST}),
        limiters={HOST: RateLimiter(6, 60.0, burst=1, monotonic=clock.monotonic, sleep=clock.sleep)},
        opener=replay,
        now=lambda: FETCHED,
        sleep=backoff,
        retries=retries,
    )
    return GeckoTerminalSource(client)


def gmt(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


# ------------------------------------------------------------------------ happy path
def test_parses_a_real_new_pools_page() -> None:
    replay = Replay(recorded(P1))
    page = source(replay).new_pools(1)
    request = replay.requests[0]
    assert request.full_url == f"{NEW_POOLS_URL}?page=1&include=base_token,quote_token,dex"
    assert request.get_header("Accept") == ACCEPT == "application/json;version=20230203"
    assert page.page == 1
    assert page.fetched_at == FETCHED
    assert page.as_of == gmt("2026-10-12T21:15:44") - timedelta(seconds=17)  # Date - Age
    assert len(page.pools) == 4
    assert page.pools[0] == NewPool(
        pool_address="BgG9uP5e8kqN6xLFABcr8yphhRsJEm5QSVMQpzRqem8r",
        dex_id="pump-fun",
        base_mint="hoLdGrGibrN74H5okA94Q6UxBYmAfPW9AwsgeGaLSJp",
        quote_mint=SOL,
        pool_created_at=gmt("2026-10-12T21:14:20"),
        name="HOLDOUT / SOL",
        base_symbol="HOLDOUT",
        price_usd=Decimal("0.00000789888019740576210848748269510929955817832482987541507469178915"),
        fdv_usd=Decimal("7993.804985"),
        reserve_usd=Decimal("5357.2437"),
        buys_m5=15,
        sells_m5=13,
        volume_m5_usd=Decimal("2772.8978897562"),
        volume_h1_usd=Decimal("2772.8978897562"),
    )
    assert page.pools[0].pool_created_at.tzinfo is UTC


def test_other_dexes_quotes_and_tiny_reserves_come_through_unchanged() -> None:
    page = parse_new_pools(body(P1), headers(P1), FETCHED)
    _, memento, _, swiggapig = page.pools
    assert (memento.dex_id, memento.name, memento.base_symbol) == ("pumpswap", "Memento / SOL", "Memento")
    assert memento.reserve_usd == Decimal("0.002878468745")  # a dust reserve is data, not an error
    assert swiggapig.quote_mint == "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"  # quoted in PUMP, not SOL
    assert (swiggapig.name, swiggapig.base_symbol) == ("SWIGGAPIG / PUMP", "SWIGGAPIG")
    for pool in page.pools:  # nothing but the listed fields is kept: no URLs, images or socials
        assert not any("http" in str(value) for value in astuple(pool))


def test_a_real_bidi_override_in_a_name_is_neutralised() -> None:
    assert "\u202eMROW / SOL".encode() in body(P1)  # really in the recorded response
    mrow = parse_new_pools(body(P1), headers(P1), FETCHED).pools[2]
    assert (mrow.dex_id, mrow.name, mrow.base_symbol) == ("bags-fm", "?MROW / SOL", "?MROW")
    assert mrow.base_mint == "5DJxxAewuNpxUvgri4q3ioCxtj2TJ2HvxTuhBfShmYsD"


def test_brand_new_pools_have_null_or_zero_reserves_and_copycat_names() -> None:
    page = parse_new_pools(body(P1_EARLY), headers(P1_EARLY), fetched(P1_EARLY))
    assert page.as_of == gmt("2026-10-12T21:13:49") - timedelta(seconds=23)
    assert [p.reserve_usd for p in page.pools] == [None, None, Decimal("0.0")]
    assert [p.dex_id for p in page.pools] == ["meteora-damm-v2", "pump-fun", "meteora-dbc"]
    first, _, third = page.pools
    # Same token, same name, two different pools: always key on the pool address.
    assert first.name == third.name == "PONSPUMP / SOL"
    assert first.base_mint == third.base_mint == "3gYgGXDc5duLvM7baLDxLU8hFnSvek1i6z7k9fmM1LKB"
    assert first.pool_address != third.pool_address
    assert third.fdv_usd == Decimal("0.004905550161")


def test_without_an_age_header_as_of_assumes_the_whole_cache_minute() -> None:
    assert "age" not in headers(P2_NO_AGE)
    page = parse_new_pools(body(P2_NO_AGE), headers(P2_NO_AGE), fetched(P2_NO_AGE), page=2)
    assert page.page == 2
    assert page.as_of == gmt("2026-10-12T21:19:05") - timedelta(seconds=60)
    # as_of is then only a lower bound: this real page holds a pool created after it.
    assert max(p.pool_created_at for p in page.pools) == gmt("2026-10-12T21:18:18") > page.as_of
    qcat, rj = page.pools
    assert qcat.quote_mint == "1NJMqVM4PadjuzYmeB7zV7q7DV8oB3ExaQCd9x6KsLz"
    assert (rj.dex_id, rj.base_symbol) == ("stonkfun", "RJ")


def test_header_names_are_matched_case_insensitively() -> None:
    mixed = {k.title(): v for k, v in headers(P1).items()}
    assert parse_new_pools(body(P1), mixed, FETCHED).as_of == gmt("2026-10-12T21:15:27")
    clash = {**mixed, "age": "3"}
    with pytest.raises(GeckoTerminalFormatError, match="conflicting 'age'"):
        parse_new_pools(body(P1), clash, FETCHED)


def test_a_missing_base_token_record_gives_no_symbol_instead_of_an_error() -> None:
    doc = json.loads(body(P1))
    doc["included"] = [
        i for i in doc["included"] if i["id"] != "solana_hoLdGrGibrN74H5okA94Q6UxBYmAfPW9AwsgeGaLSJp"
    ]
    for item in doc["included"]:
        if item["id"] == "solana_5m8gXqRaWxYXqSCygTW5pZYYBfsPbZwQou4YUS9radoj":
            item["attributes"]["symbol"] = None
        if item["id"] == "solana_5DJxxAewuNpxUvgri4q3ioCxtj2TJ2HvxTuhBfShmYsD":
            item["attributes"]["symbol"] = " \t "
    page = parse_new_pools(dump(doc), headers(P1), FETCHED)
    assert [p.base_symbol for p in page.pools] == [None, None, None, "SWIGGAPIG"]
    assert page.pools[0].name == "HOLDOUT / SOL"


def test_each_value_comes_from_its_own_window() -> None:
    # Every recorded pool is younger than 5 minutes, so its m5 and h1 values are equal and
    # a swapped mapping would go unnoticed. Give each window its own value in memory.
    doc = json.loads(body(P1))
    attrs = doc["data"][0]["attributes"]
    attrs["volume_usd"]["h1"] = "9999.5"
    attrs["transactions"]["h1"] = {"buys": 99, "sells": 98, "buyers": 97, "sellers": 96}
    pool = parse_new_pools(dump(doc), headers(P1), FETCHED).pools[0]
    assert (pool.volume_m5_usd, pool.volume_h1_usd) == (Decimal("2772.8978897562"), Decimal("9999.5"))
    assert (pool.buys_m5, pool.sells_m5) == (15, 13)


def test_fetched_at_is_stored_in_utc() -> None:
    athens = FETCHED.astimezone(timezone(timedelta(hours=3)))
    page = parse_new_pools(body(P1), headers(P1), athens)
    assert page.fetched_at == FETCHED and page.fetched_at.tzinfo is UTC
    assert page.as_of.tzinfo is UTC


def test_page_10_is_allowed() -> None:
    replay = Replay(recorded(P1))
    assert source(replay).new_pools(10).page == 10
    assert "?page=10&include=" in replay.requests[0].full_url


# ------------------------------------------------------------------ refused requests
@pytest.mark.parametrize("bad", [0, 11, -1, 100, True, 1.0, "1", None])
def test_pages_outside_1_to_10_are_refused_before_any_request(bad: Any) -> None:
    replay = Replay()
    with pytest.raises(ValueError, match="page must be an integer from 1 to 10"):
        source(replay).new_pools(bad)
    with pytest.raises(ValueError, match="page must be"):
        parse_new_pools(body(P1), headers(P1), FETCHED, page=bad)
    assert replay.requests == []


def test_the_client_must_allow_the_host() -> None:
    client = HttpClient(user_agent="samsulek-test/0", allowed_hosts=frozenset({"example.org"}))
    with pytest.raises(ValueError, match=HOST):
        GeckoTerminalSource(client)


def test_the_client_must_rate_limit_the_host() -> None:
    # Ten pages unthrottled would draw 429s, and every 429 can lose pools for good.
    client = HttpClient(user_agent="samsulek-test/0", allowed_hosts=frozenset({HOST}))
    with pytest.raises(ValueError, match=f"rate limiter for {HOST}"):
        GeckoTerminalSource(client)
    limited = HttpClient(
        user_agent="samsulek-test/0", allowed_hosts=frozenset({HOST}), limiters={HOST: limiter()}
    )
    GeckoTerminalSource(limited)


def test_limiter_stays_below_the_documented_ten_per_minute() -> None:
    bucket = limiter()
    assert bucket._interval == 10.0  # one call every 10 s = 6 per minute
    assert bucket._burst == 1.0


# ------------------------------------------------------------------------ error bodies
def test_the_page_11_answer_is_an_http_error_with_a_readable_reason() -> None:
    # Pages > 10 never get requested; if the provider lowered the maximum, it would answer so.
    replay = Replay(http_error(401, PAGE_11))
    with pytest.raises(HttpError) as caught:
        source(replay).new_pools(10)
    assert caught.value.status == 401
    reason = error_message(caught.value.body)
    assert reason.startswith("401: Your request exceeds the allowed max number for page (10).")
    assert "http" not in reason and reason.endswith("<url>")


def test_rate_limit_answers_are_retried_with_our_own_backoff_then_raise() -> None:
    assert headers(RATE_LIMITED)["retry-after"] == "0"  # useless: we must back off ourselves
    sleeps: list[float] = []
    replay = Replay(http_error(429, RATE_LIMITED), http_error(429, RATE_LIMITED))
    with pytest.raises(RateLimitedError):
        source(replay, sleeps, retries=1).new_pools(1)
    assert len(replay.requests) == 2
    assert len(sleeps) == 1 and sleeps[0] > 0
    assert error_message(body(RATE_LIMITED)).startswith(
        "429: You've exceeded the Rate Limit. Please visit <url>"
    )


def test_a_rate_limit_then_success_returns_the_page() -> None:
    sleeps: list[float] = []
    page = source(Replay(http_error(429, RATE_LIMITED), recorded(P1)), sleeps).new_pools(1)
    assert len(page.pools) == 4 and len(sleeps) == 1


@pytest.mark.parametrize("name", [RATE_LIMITED, PAGE_11])
def test_an_error_body_with_a_success_status_is_refused(name: str) -> None:
    with pytest.raises(GeckoTerminalFormatError, match=r"error body in a successful response: (429|401): "):
        parse_new_pools(body(name), headers(P1), FETCHED)


@pytest.mark.parametrize(
    "raw",
    [
        b"<html>Bad gateway</html>",
        b'{"foo": 1}',
        b'{"errors": []}',
        b'{"errors": ["x"]}',
        b'{"status": {"error_code": "429", "error_message": "slow down"}}',
        b"[" * 100_000,
    ],
)
def test_unknown_error_bodies_are_not_guessed_at(raw: bytes) -> None:
    with pytest.raises(GeckoTerminalFormatError):
        error_message(raw)


def test_error_messages_lose_links_even_in_disguise() -> None:
    raw = (
        '{"errors":[{"status":"404","title":"see \\uff48\\uff54\\uff54\\uff50\\uff53://evil.example/x now"}]}'
    )
    assert error_message(raw) == "404: see <url> now"  # full-width letters fold to "https://"
    assert error_message(body(PAGE_11).decode("utf-8")) == error_message(body(PAGE_11))  # str or bytes


def test_a_non_200_success_status_is_refused() -> None:
    replay = Replay(Raw(203, body(P1), recorded_headers(P1)))
    with pytest.raises(GeckoTerminalFormatError, match="expected HTTP 200, got 203"):
        source(replay).new_pools(1)


# ------------------------------------------------------------- schema surprises (body)
def dump(doc: Any) -> bytes:
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def put(*path: Any, value: Any) -> Mutation:
    def mutate(doc: dict[str, Any]) -> None:
        target: Any = doc
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = copy.deepcopy(value)

    return mutate


def drop(*path: Any) -> Mutation:
    def mutate(doc: dict[str, Any]) -> None:
        target: Any = doc
        for key in path[:-1]:
            target = target[key]
        del target[path[-1]]

    return mutate


def append_copy_of_first_pool(doc: dict[str, Any]) -> None:
    doc["data"].append(copy.deepcopy(doc["data"][0]))


def six_times_the_pools(doc: dict[str, Any]) -> None:
    doc["data"] = doc["data"] * 6  # 24 records: more than a page holds


def drop_last_pool_but_keep_its_tokens(doc: dict[str, Any]) -> None:
    doc["data"].pop()


def duplicate_included_token(doc: dict[str, Any]) -> None:
    doc["included"].append(copy.deepcopy(doc["included"][0]))


A0 = ("data", 0, "attributes")
R0 = ("data", 0, "relationships")
BASE0 = (*R0, "base_token", "data")
OTHER_POOL = "6mLnRNKDNVyvhwmNg4rpZ2pRRJfiuyzvP2KdZAN9aSbW"  # data[1]'s address


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        # records that aren't Solana pools, or too many of them
        (put("data", 0, "type", value="token"), r"data\[0\]: not a pool"),
        (put("data", 0, "id", value="eth_BgG9uP5e8kqN6xLFABcr8yphhRsJEm5QSVMQpzRqem8r"), "not a Solana pool"),
        (put("data", 0, "id", value=f"solana_{OTHER_POOL}"), "doesn't match address"),
        (append_copy_of_first_pool, r"data\[4\]: duplicate pool"),
        (six_times_the_pools, "24 pools on one page, more than 20"),
        (put("data", value={"id": "x"}), "data and included must be arrays"),
        (put("data", 0, value=None), r"data\[0\]: expected an object"),
        # top level
        (put("links", value={"next": None}), "top-level keys"),
        (drop("included"), "top-level keys"),
        (put("errors", value=[{"status": "500", "title": "oops"}]), "error body in a successful response"),
        # missing or broken relationships
        (drop(*R0, "dex"), r"data\[0\]\.relationships: missing 'dex'"),
        (drop(*R0), r"data\[0\]: missing 'relationships'"),
        (put(*R0, "base_token", "data", value=None), r"base_token\.data: expected an object"),
        (put(*BASE0, "type", value="dex"), "expected type 'token'"),
        (put(*BASE0, "id", value="solana_0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"), "not a Solana address"),
        (put(*BASE0, "id", value="solana_" + "z" * 44), "not a Solana address"),  # 33 bytes
        (put(*BASE0, "id", value="solana_" + "2" * 31), "not a Solana address"),  # too short
        (put(*R0, "quote_token", "data", "id", value="eth_0xc02a"), "not a Solana token"),
        (
            put(*R0, "quote_token", "data", "id", value="solana_hoLdGrGibrN74H5okA94Q6UxBYmAfPW9AwsgeGaLSJp"),
            "same token",
        ),
        (put(*R0, "dex", "data", "id", value="Pump Fun!"), "unexpected dex id"),
        # missing fields and wrong types
        (drop(*A0, "address"), "missing 'address'"),
        (drop(*A0, "pool_created_at"), "missing 'pool_created_at'"),
        (drop(*A0, "volume_usd"), "missing 'volume_usd'"),
        (drop(*A0, "volume_usd", "m5"), r"volume_usd: missing 'm5'"),
        (drop(*A0, "volume_usd", "h1"), r"volume_usd: missing 'h1'"),
        (drop(*A0, "transactions", "m5"), r"transactions: missing 'm5'"),
        (drop(*A0, "transactions", "m5", "sells"), r"transactions\.m5: missing 'sells'"),
        (put(*A0, "volume_usd", value=None), r"volume_usd: expected an object"),
        (put(*A0, "name", value=None), r"name: expected a string"),
        (put(*A0, "pool_created_at", value="2026-10-12T21:14:20+02:00"), "pool_created_at"),
        (put(*A0, "pool_created_at", value="2026-10-12 21:14:20"), "pool_created_at"),
        (put(*A0, "pool_created_at", value="2026-13-12T21:14:20Z"), "pool_created_at"),
        (put(*A0, "pool_created_at", value=1791883460), "pool_created_at"),
        # created two hours after the server made the response: local time labelled "Z"
        (put(*A0, "pool_created_at", value="2026-10-12T23:14:20Z"), "after the response was made"),
        (put(*A0, "base_token_price_usd", value=7.8988e-06), "base_token_price_usd"),
        (put(*A0, "base_token_price_usd", value="NaN"), "base_token_price_usd"),
        (put(*A0, "fdv_usd", value="-7993.80"), "fdv_usd"),
        (put(*A0, "fdv_usd", value="7.99e3"), "fdv_usd"),
        (put(*A0, "reserve_in_usd", value=""), "reserve_in_usd"),
        (put(*A0, "volume_usd", "h1", value="1" * 41), r"volume_usd\.h1"),
        (put(*A0, "transactions", "m5", "buys", value="15"), r"m5\.buys"),
        (put(*A0, "transactions", "m5", "buys", value=True), r"m5\.buys"),
        (put(*A0, "transactions", "m5", "buys", value=15.0), r"m5\.buys"),
        (put(*A0, "transactions", "m5", "sells", value=-1), r"m5\.sells"),
        # included records
        (put("included", 0, "type", value="network"), "unexpected record type"),
        (duplicate_included_token, "duplicate token"),
        (put("included", 0, "attributes", "address", value=SOL), "doesn't match its address"),
        (drop("included", 0, "attributes"), r"included\[0\]: missing 'attributes'"),
        (put("included", 0, "attributes", "symbol", value=42), "symbol is int"),
        (drop_last_pool_but_keep_its_tokens, "included records no pool refers to"),
    ],
)
def test_schema_surprises_stop_instead_of_guessing(mutate: Mutation, message: str) -> None:
    doc = json.loads(body(P1))
    mutate(doc)
    with pytest.raises(GeckoTerminalFormatError, match=message):
        parse_new_pools(dump(doc), headers(P1), FETCHED)


def test_the_unmutated_document_round_trips() -> None:
    """Guards the test above: the re-serialised fixture itself parses fine."""
    assert dump(json.loads(body(P1))) == body(P1)
    assert len(parse_new_pools(dump(json.loads(body(P1))), headers(P1), FETCHED).pools) == 4


def test_a_pool_a_little_after_the_server_date_is_block_time_noise_not_an_error() -> None:
    doc = json.loads(body(P1))
    doc["data"][0]["attributes"]["pool_created_at"] = "2026-10-12T21:19:44Z"  # Date + 4 min
    assert parse_new_pools(dump(doc), headers(P1), FETCHED).pools[0].pool_created_at == gmt(
        "2026-10-12T21:19:44"
    )


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        # json.loads would silently keep the last of two equal keys
        (
            b'"name":"HOLDOUT / SOL"',
            b'"name":"HOLDOUT / SOL","name":"OTHER / SOL"',
            "duplicate JSON key 'name'",
        ),
        (b'{"data":[', b'{"data":[],"data":[', "duplicate JSON key 'data'"),
        # NaN/Infinity aren't JSON, even in a field the adapter doesn't keep
        (b'"buyers":15', b'"buyers":NaN', "non-finite number NaN"),
        (b'"buyers":15', b'"buyers":-Infinity', "non-finite number -Infinity"),
    ],
)
def test_json_that_python_would_accept_silently_is_refused(old: bytes, new: bytes, message: str) -> None:
    raw = body(P1).replace(old, new, 1)
    assert raw != body(P1)
    with pytest.raises(GeckoTerminalFormatError, match=message):
        parse_new_pools(raw, headers(P1), FETCHED)


# ---------------------------------------------------------- schema surprises (transport)
@pytest.mark.parametrize(
    ("raw", "header_changes", "message"),
    [
        (b"<html>maintenance</html>", {"content-type": "text/html"}, "expected application/json"),
        (None, {"content-type": None}, "expected application/json"),
        (b"{not json", {}, "not valid JSON"),
        (b'{"data": [}', {}, "not valid JSON"),
        (b"[" * 100_000, {}, "not valid JSON"),
        (b"\xff\xfe{}", {}, "not UTF-8"),
        (b"[]", {}, "expected a JSON object, got list"),
        (b" " * (MAX_BODY_BYTES + 1), {}, f"more than {MAX_BODY_BYTES}"),
        (None, {"date": None}, "no Date header"),
        (None, {"date": "yesterday"}, "bad Date header"),
        (None, {"date": "Mon, 12 Oct 2026 21:15:44 -0000"}, "without a time zone"),
        (None, {"age": "-5"}, "bad Age header"),
        (None, {"age": "1.5"}, "bad Age header"),
        (None, {"age": "abc"}, "bad Age header"),
        (None, {"age": "301"}, "stale cached copy"),
        # our clock is more than 5 minutes off the server's (either way)
        (None, {"date": "Mon, 12 Oct 2026 21:21:46 GMT"}, "away from our clock"),
        (None, {"date": "Mon, 12 Oct 2026 21:09:44 GMT"}, "away from our clock"),
    ],
)
def test_transport_surprises_stop_instead_of_guessing(
    raw: bytes | None, header_changes: dict[str, str | None], message: str
) -> None:
    hdrs = headers(P1)
    for key, value in header_changes.items():
        if value is None:
            del hdrs[key]
        else:
            hdrs[key] = value
    with pytest.raises(GeckoTerminalFormatError, match=message):
        parse_new_pools(body(P1) if raw is None else raw, hdrs, FETCHED)


def test_the_limits_on_age_and_clock_skew_are_inclusive() -> None:
    hdrs = {**headers(P1), "age": "300", "date": "Mon, 12 Oct 2026 21:20:45 GMT"}  # FETCHED + 5 min
    assert parse_new_pools(body(P1), hdrs, FETCHED).as_of == gmt("2026-10-12T21:15:45")


def test_fetched_at_must_be_timezone_aware() -> None:
    with pytest.raises(ValueError, match="aware"):
        parse_new_pools(body(P1), headers(P1), datetime(2026, 10, 12, 21, 15))  # noqa: DTZ001


# ------------------------------------------------------------------------ sanitizing
@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("\u202eMROW", "?MROW"),  # bidi override (seen live)
        ("\U0001f438 Moon Frog", "? Moon Frog"),  # emoji (seen live)
        ("\U0001f988Sea Shark\U0001f988", "?Sea Shark?"),  # (seen live)
        ("a\nb\tc\r\n  d", "a b c d"),
        ("\uff30\uff25\uff30\uff25", "PEPE"),  # full-width letters
        ("\x00\x1b[31mred", "??[31mred"),  # NUL and a terminal escape
        ("International Business Machines - Backpack Securities", "International Business Machines - Backpa"),
        ("x" * 10_000, "x" * 40),
        ("", ""),
    ],
)
def test_untrusted_text_becomes_short_printable_ascii(raw: str, clean: str) -> None:
    assert clean_text(raw) == clean
    assert len(clean) <= 40 and all(" " <= ch <= "~" for ch in clean)
