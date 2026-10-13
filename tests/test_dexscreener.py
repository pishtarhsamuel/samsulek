"""DexScreener pairs adapter, tested on real responses recorded 2026-10-12 (tests/fixtures/dexscreener).

pairs_solana_batch30_new_gt.json is the live answer for 30 brand-new pools, trimmed to 5 of
its real records (meteora DYN2 and pumpswap with liquidity, two pump.fun bonding curves and
a Meteora DBC pool without it). manifest.jsonl holds the exact request URLs.
"""

from __future__ import annotations

import dataclasses
import http.client
import io
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from samsulek.data.sources.dexscreener import (
    HOST,
    MAX_PAIRS,
    DexScreenerFormatError,
    DexScreenerSource,
    PairsBatch,
    clean_text,
    limiter,
    parse_pairs,
)
from samsulek.net.http import HttpClient, HttpError
from withheld import read_fixture

FIX = Path(__file__).parent / "fixtures" / "dexscreener"
BATCH = "pairs_solana_batch30_new_gt"
NOT_A_PAIR = "pairs_solana_not_a_pair"
OVER_LIMIT = "pairs_solana_batch31_over_limit"
FETCHED = datetime(2026, 10, 12, 21, 22, 29, 432000, tzinfo=UTC)  # request 21:22:29.18 + 0.25 s
METEORA = "dgacoMNB5yu6JS4U5QaV1P8Vkiz2NwUjRK6m4avQ6Km"
PUMPFUN = "2243WKeaMswtxCBMyx9YocWGcriymssRFx65Ee6XuNr3"
METEORA_DBC = "79jqiBfyXfBMjnNNuuAbEEiY8YcmmezDGAYL6Uui2i21"
PUMPFUN_ACTIVE = "F9t7PnaeACvdMvk4KQojzqWNFEmBn6YhGu62ZQNm2i6a"
PUMPSWAP = "337UW9o4ZjXQLoKZd7y8Q9VQhLnosQDZUWpgHGmBBEdQ"
IN_FIXTURE = (METEORA, PUMPFUN, METEORA_DBC, PUMPFUN_ACTIVE, PUMPSWAP)
WSOL = "So11111111111111111111111111111111111111112"
SYSTEM_PROGRAM = "11111111111111111111111111111111"  # a valid address that is not a pair
# Built with chr() so this file stays ASCII.
RIGHT_TO_LEFT = chr(0x202E)  # reverses the text displayed after it
CYRILLIC = "".join(map(chr, (0x0434, 0x0435, 0x0445)))
ROCKET = chr(0x1F680)


def body(name: str) -> bytes:
    return read_fixture(f"dexscreener/{name}.json")


def headers(name: str) -> list[tuple[str, str]]:
    """The final response's headers from a curl dump (the proxy's CONNECT answer comes first)."""
    blocks = (FIX / f"{name}.headers.txt").read_bytes().decode("ascii").split("\r\n\r\n")
    final = [b for b in blocks if b.startswith("HTTP/")][-1]
    pairs = [line.split(": ", 1) for line in final.split("\r\n")[1:] if line]
    return [(k, v) for k, v in pairs]


def requested(name: str) -> list[str]:
    for line in (FIX / "manifest.jsonl").read_text("utf-8").splitlines():
        record = json.loads(line)
        if record["name"] == name:
            return str(record["url"]).rsplit("/", 1)[1].split(",")
    raise KeyError(name)


def request_url(name: str) -> str:
    for line in (FIX / "manifest.jsonl").read_text("utf-8").splitlines():
        record = json.loads(line)
        if record["name"] == name:
            return str(record["url"])
    raise KeyError(name)


REQUESTED_30 = requested(BATCH)
REQUESTED_31 = requested(OVER_LIMIT)


def records() -> dict[str, str]:
    """The fixture's pair records as their exact original text, by pair address."""
    text = body(BATCH).decode("utf-8")
    start = text.index("[") + 1
    decoder = json.JSONDecoder()
    out: dict[str, str] = {}
    while text[start] != "]":
        obj, end = decoder.raw_decode(text, start)
        out[obj["pairAddress"]] = text[start:end]
        start = end + 1 if text[end] == "," else end
    return out


def subset(addresses: list[str]) -> bytes:
    """The real answer cut down to the given pairs (structure edited, values untouched)."""
    kept = [raw for address, raw in records().items() if address in addresses]
    return ('{"schemaVersion":"1.0.0","pairs":[' + ",".join(kept) + '],"pair":null}').encode()


def mutated(change: Callable[[dict[str, Any]], object]) -> bytes:
    doc = json.loads(body(BATCH))
    change(doc)
    return json.dumps(doc).encode()


@dataclass
class Raw:
    status: int
    body: bytes
    headers: list[tuple[str, str]] = field(default_factory=lambda: headers(BATCH))

    def getheaders(self) -> list[tuple[str, str]]:
        return self.headers

    def read(self, amt: int | None = None) -> bytes:
        return self.body

    def close(self) -> None:
        pass


class Replay:
    def __init__(self, *outcomes: object) -> None:
        self.outcomes = list(outcomes)
        self.urls: list[str] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> Raw:
        self.urls.append(request.full_url)
        out = self.outcomes.pop(0)
        if isinstance(out, BaseException):
            raise out
        assert isinstance(out, Raw)
        return out

    def sizes(self) -> list[int]:
        return [len(url.rsplit("/", 1)[1].split(",")) for url in self.urls]


def http_error(status: int, name: str | None) -> urllib.error.HTTPError:
    msg = http.client.HTTPMessage()
    for key, value in headers(name or OVER_LIMIT):
        msg[key] = value
    payload = body(name) if name else b""
    return urllib.error.HTTPError("https://x", status, "error", msg, io.BytesIO(payload))


def bad_request() -> urllib.error.HTTPError:
    return http_error(400, OVER_LIMIT)  # the real answer to 31 addresses


class Ticking:
    """A clock that moves one second per reading."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> datetime:
        self.calls += 1
        return FETCHED + timedelta(seconds=self.calls - 1)


def source(replay: Replay, now: Callable[[], datetime] = lambda: FETCHED) -> DexScreenerSource:
    client = HttpClient(
        user_agent="samsulek-test/0", allowed_hosts=frozenset({HOST}), opener=replay, now=now, retries=0
    )
    return DexScreenerSource(client)


def parse(raw: bytes, hdrs: list[tuple[str, str]] | None = None, fetched: datetime = FETCHED) -> PairsBatch:
    return parse_pairs(raw, dict(hdrs if hdrs is not None else headers(BATCH)), REQUESTED_30, fetched)


# ---------------------------------------------------------------- happy paths
def test_parses_real_new_pools_with_and_without_liquidity() -> None:
    batch = parse(body(BATCH))
    assert list(batch.found) == list(IN_FIXTURE)  # request order
    assert len(batch.missing) == 25 and set(batch.missing) == set(REQUESTED_30) - set(IN_FIXTURE)
    assert list(batch.missing) == [a for a in REQUESTED_30 if a not in IN_FIXTURE]
    assert batch.fetched_at == FETCHED
    # The response was a cache MISS without an Age header: as_of = Date - 30 s.
    assert batch.as_of == datetime(2026, 10, 12, 21, 21, 59, tzinfo=UTC)

    meteora = batch.found[METEORA]
    assert (meteora.dex_id, meteora.labels) == ("meteora", ("DYN2",))
    assert meteora.base_mint == "3gYgGXDc5duLvM7baLDxLU8hFnSvek1i6z7k9fmM1LKB"
    assert meteora.quote_mint == WSOL
    assert (meteora.price_usd, meteora.price_native) == (Decimal("0.0002470"), Decimal("0.000002285"))
    assert meteora.txns == {"m5": (0, 0), "h1": (7, 6), "h6": (7, 6), "h24": (7, 6)}
    assert list(meteora.volume_usd) == ["m5", "h1", "h6", "h24"]
    assert meteora.volume_usd["h24"] == Decimal("0.07") and meteora.volume_usd["m5"] == 0
    assert meteora.price_change_pct == {
        "h1": Decimal("-61.94"),
        "h6": Decimal("-61.94"),
        "h24": Decimal("-61.94"),
    }
    assert meteora.liquidity_usd == 0
    assert meteora.liquidity_base == Decimal("15.8607")
    assert meteora.liquidity_quote == Decimal("0.000006282")  # sent as 6.282e-06: no float rounding
    assert meteora.fdv_usd == meteora.market_cap_usd == Decimal(247043)
    assert meteora.pair_created_at == datetime(2026, 10, 12, 21, 13, 14, tzinfo=UTC)

    curve = batch.found[PUMPFUN]  # pump.fun bonding curve: no liquidity, and that's normal
    assert (curve.dex_id, curve.labels) == ("pumpfun", ())
    assert curve.base_mint == "218ETXq3MsT2mgqYAJTQ5E52n8k4p9eTnYkLxmY9pump"
    assert (curve.liquidity_usd, curve.liquidity_base, curve.liquidity_quote) == (None, None, None)
    assert curve.fdv_usd == Decimal("4520.8") and curve.txns["h1"] == (13, 6)

    dbc = batch.found[METEORA_DBC]  # Meteora DBC at $0 reserve: no liquidity, fdv or price change
    assert dbc.dex_id == "meteoradbc" and dbc.liquidity_usd is None
    assert (dbc.fdv_usd, dbc.market_cap_usd, dbc.price_change_pct) == (None, None, {})
    assert dbc.price_usd == Decimal("0.000000000004912")

    active = batch.found[PUMPFUN_ACTIVE]
    assert active.price_change_pct["m5"] == Decimal("-21.49") and active.txns["m5"] == (5, 14)

    swap = batch.found[PUMPSWAP]
    assert (swap.liquidity_usd, swap.liquidity_base, swap.liquidity_quote) == (
        Decimal("2.63"),
        Decimal(462800186),
        Decimal("0.01228"),
    )
    for snap in batch.found.values():
        for value in (snap.price_usd, snap.liquidity_usd, *snap.volume_usd.values()):
            assert value is None or type(value) is Decimal
        assert snap.pair_created_at is not None and snap.pair_created_at.tzinfo is UTC


def test_fetch_uses_the_recorded_url_and_replays_the_real_answer() -> None:
    replay = Replay(Raw(200, body(BATCH)))
    batch = source(replay).pairs(REQUESTED_30)
    assert replay.urls == [request_url(BATCH)]
    assert len(batch.found) == 5 and len(batch.missing) == 25


def test_unknown_address_is_missing_not_dead() -> None:
    replay = Replay(Raw(200, body(NOT_A_PAIR), headers(NOT_A_PAIR)))
    batch = source(replay).pairs([SYSTEM_PROGRAM])
    assert replay.urls == [request_url(NOT_A_PAIR)]
    assert batch.found == {} and batch.missing == (SYSTEM_PROGRAM,)
    assert batch.as_of == datetime(2026, 10, 12, 21, 22, 6, tzinfo=UTC)  # Date 21:22:36 - 30 s


def test_age_header_moves_as_of_back() -> None:
    batch = parse(body(BATCH), [*headers(BATCH), ("Age", "44")])
    assert batch.as_of == datetime(2026, 10, 12, 21, 21, 45, tzinfo=UTC)


def without(name: str) -> list[tuple[str, str]]:
    return [(k, v) for k, v in headers(BATCH) if k != name]


@pytest.mark.parametrize(
    ("cache_control", "seconds"),
    [
        ("public, max-age=30", 30),  # what this endpoint sent
        ("public, max-age=60", 60),  # what other DexScreener endpoints send
        ("public, max-age=10", 30),  # never less than 30 s
        ("public, max-age=30, s-maxage=120", 120),
        ('public, max-age="45"', 45),
        ("no-cache", 30),
        (None, 30),
    ],
)
def test_without_age_as_of_assumes_the_longest_cache_lifetime(
    cache_control: str | None, seconds: int
) -> None:
    hdrs = without("cache-control") + ([("cache-control", cache_control)] if cache_control else [])
    date = datetime(2026, 10, 12, 21, 22, 29, tzinfo=UTC)
    assert parse(body(BATCH), hdrs).as_of == date - timedelta(seconds=seconds)


def test_as_of_is_never_after_we_had_the_data() -> None:
    behind = FETCHED - timedelta(minutes=2)  # our clock lags the server's (within the skew allowed)
    assert parse(body(BATCH), fetched=behind).as_of == behind
    assert parse(body(BATCH), [*headers(BATCH), ("age", "0")], fetched=behind).as_of == behind


def test_json_content_type_is_matched_exactly() -> None:
    for value in ("application/json", "Application/JSON; charset=utf-8"):
        assert len(parse(body(BATCH), [*headers(BATCH), ("content-type", value)]).found) == 5
    with pytest.raises(DexScreenerFormatError, match="application/json"):
        parse(body(BATCH), [*headers(BATCH), ("content-type", "application/jsonp")])


def test_header_names_are_case_insensitive() -> None:
    upper = [(k.upper(), v) for k, v in headers(BATCH)]
    assert parse(body(BATCH), upper).as_of == datetime(2026, 10, 12, 21, 21, 59, tzinfo=UTC)


def test_documented_nulls_are_accepted() -> None:
    def nulls(doc: dict[str, Any]) -> None:
        pair = doc["pairs"][0]
        pair.update(
            labels=None, priceUsd=None, priceChange=None, fdv=None, marketCap=None, pairCreatedAt=None
        )
        pair["liquidity"]["usd"] = None
        doc["pairs"][1]["liquidity"] = None
        del doc["pairs"][2]["priceNative"]

    batch = parse(mutated(nulls))
    meteora = batch.found[METEORA]
    assert (meteora.labels, meteora.price_usd, meteora.price_change_pct) == ((), None, {})
    assert (meteora.fdv_usd, meteora.market_cap_usd, meteora.pair_created_at) == (None, None, None)
    assert meteora.liquidity_usd is None and meteora.liquidity_base == Decimal("15.8607")
    assert batch.found[PUMPFUN].liquidity_base is None
    assert batch.found[METEORA_DBC].price_native is None


def test_empty_pairs_list_means_all_missing() -> None:
    batch = parse(b'{"schemaVersion":"1.0.0","pairs":[]}')
    assert batch.found == {} and batch.missing == tuple(REQUESTED_30)


def test_found_follows_the_request_order_not_the_response_order() -> None:
    batch = parse(mutated(lambda doc: doc["pairs"].reverse()))
    assert list(batch.found) == list(IN_FIXTURE)


# ------------------------------------------------------------------ HTTP 400
def test_http_400_splits_the_batch_in_halves_and_merges() -> None:
    clock = Ticking()
    replay = Replay(
        bad_request(),
        Raw(200, body(BATCH)),  # every pair in the fixture is in the first half
        Raw(200, body(NOT_A_PAIR), headers(NOT_A_PAIR)),
    )
    batch = source(replay, clock).pairs(REQUESTED_30)
    assert replay.sizes() == [30, 15, 15]
    assert replay.urls[1].endswith("/solana/" + ",".join(REQUESTED_30[:15]))
    assert replay.urls[2].endswith("/solana/" + ",".join(REQUESTED_30[15:]))
    assert list(batch.found) == list(IN_FIXTURE)
    assert list(batch.missing) == [a for a in REQUESTED_30 if a not in IN_FIXTURE]
    assert batch.as_of == datetime(2026, 10, 12, 21, 21, 59, tzinfo=UTC)  # the older part
    assert batch.fetched_at == FETCHED + timedelta(seconds=clock.calls - 1)  # the later part


def test_http_400_splits_two_levels_deep() -> None:
    replay = Replay(
        bad_request(),
        bad_request(),
        Raw(200, subset(REQUESTED_30[:7])),
        Raw(200, subset(REQUESTED_30[7:15])),
        Raw(200, body(NOT_A_PAIR), headers(NOT_A_PAIR)),
    )
    batch = source(replay, Ticking()).pairs(REQUESTED_30)
    assert replay.sizes() == [30, 15, 7, 8, 15]
    assert list(batch.found) == list(IN_FIXTURE)
    assert len(batch.missing) == 25


def test_http_400_gives_up_after_two_levels() -> None:
    replay = Replay(bad_request(), bad_request(), bad_request())
    with pytest.raises(HttpError, match="400") as info:
        source(replay).pairs(REQUESTED_30)
    assert info.value.status == 400
    assert replay.sizes() == [30, 15, 7]


def test_http_400_for_one_address_is_not_retried() -> None:
    replay = Replay(bad_request())
    with pytest.raises(HttpError, match="400"):
        source(replay).pairs([SYSTEM_PROGRAM])
    assert len(replay.urls) == 1


def test_a_failing_half_fails_the_whole_batch() -> None:
    replay = Replay(bad_request(), Raw(200, body(BATCH)), http_error(403, None))
    with pytest.raises(HttpError, match="403"):
        source(replay).pairs(REQUESTED_30)


def test_other_http_errors_are_not_split() -> None:
    replay = Replay(http_error(404, None))
    with pytest.raises(HttpError, match="404"):
        source(replay).pairs(REQUESTED_30)
    assert len(replay.urls) == 1


# --------------------------------------------------- refused before any request
def test_bad_requests_are_refused_before_asking() -> None:
    replay = Replay()
    src = source(replay)
    assert len(REQUESTED_31) == MAX_PAIRS + 1
    with pytest.raises(ValueError, match="at most 30"):
        src.pairs(REQUESTED_31)
    with pytest.raises(ValueError, match="duplicate"):
        src.pairs([METEORA, PUMPFUN, METEORA])
    with pytest.raises(ValueError, match="no pair addresses"):
        src.pairs([])
    with pytest.raises(ValueError, match="single string"):
        src.pairs(METEORA)
    for bad in (
        METEORA[:31] + "0",  # 0 is not in the base58 alphabet
        "O" + METEORA[1:],  # nor is O
        "1" * 31,  # too short
        "1" * 45,  # too long
        METEORA + "\n",
        "0x4200000000000000000000000000000000000006",
        f"{METEORA},{PUMPFUN}",  # a comma would smuggle a second address into the path
    ):
        with pytest.raises(ValueError, match="base58"):
            src.pairs([PUMPFUN, bad])
    for chain in ("", "Solana", "solana/../x", "solana\n", "solana,base"):
        with pytest.raises(ValueError, match="chain"):
            src.pairs([PUMPFUN], chain=chain)
    assert replay.urls == []


def test_parse_pairs_checks_the_request_and_clock_too() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        parse_pairs(body(BATCH), dict(headers(BATCH)), [METEORA, METEORA], FETCHED)
    naive = datetime(2026, 10, 12, 21, 22, 29)  # noqa: DTZ001
    with pytest.raises(ValueError, match="aware"):
        parse_pairs(body(BATCH), dict(headers(BATCH)), REQUESTED_30, naive)


def test_source_needs_an_allowed_host_and_a_slow_limiter() -> None:
    client = HttpClient(user_agent="samsulek-test/0", allowed_hosts=frozenset({"example.com"}))
    with pytest.raises(ValueError, match=HOST):
        DexScreenerSource(client)
    assert limiter()._interval == 2.0  # one call every 2 s, far below 300/min


# --------------------------------------------------------- fail-closed parsing
def _pair(n: int, **changes: object) -> Callable[[dict[str, Any]], object]:
    return lambda doc: doc["pairs"][n].update(changes)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda d: d.update(schemaVersion="1.1.0"), "schemaVersion"),
        (lambda d: d.pop("schemaVersion"), "missing"),
        (lambda d: d.pop("pairs"), "missing"),
        (lambda d: d.update(pair=d["pairs"][0]), "'pair' is not null"),
        (lambda d: d.update(cursor="next"), "unexpected keys"),
        (lambda d: d.update(pairs={}), "'pairs' must be a list"),
        (lambda d: d["pairs"].append(d["pairs"][0]), "returned twice"),
        (lambda d: d["pairs"].append("x"), "expected an object"),
        (_pair(0, pairAddress="F3oyHrGjM7LWAvGyoeedruT2pXwVfQEawZPqewBFxNLC"), "was not requested"),
        (_pair(0, pairAddress=METEORA.lower()), "was not requested"),
        (_pair(0, pairAddress=None), "was not requested"),
        (_pair(0, chainId="ethereum"), "chainId"),
        (_pair(0, dexId="Meteora DAMM"), "dexId"),
        (_pair(0, dexId=7), "dexId"),
        (lambda d: d["pairs"][0].pop("dexId"), "missing"),
        (lambda d: d["pairs"][0].pop("txns"), "missing"),
        (lambda d: d["pairs"][0].pop("volume"), "missing"),
        (_pair(0, newField=1), "unexpected keys"),
        (_pair(0, labels="DYN2"), "labels"),
        (_pair(0, labels=[2]), "labels"),
        (lambda d: d["pairs"][0]["baseToken"].update(address="not-an-address"), "baseToken.address"),
        (lambda d: d["pairs"][0]["quoteToken"].pop("address"), "quoteToken: missing"),
        (lambda d: d["pairs"][0]["baseToken"].update(name=5), "baseToken.name"),
        (lambda d: d["pairs"][0]["baseToken"].update(logo="https://x"), "unexpected keys"),
        (_pair(0, priceUsd=0.000247), "priceUsd"),
        (_pair(0, priceUsd="abc"), "priceUsd"),
        (_pair(0, priceUsd="-1"), "priceUsd"),
        (_pair(0, priceUsd=" 1"), "priceUsd"),
        (_pair(0, priceNative="NaN"), "priceNative"),
        (_pair(0, priceNative="Infinity"), "priceNative"),
        (lambda d: d["pairs"][0]["txns"]["h1"].update(buys="7"), "txns.h1.buys"),
        (lambda d: d["pairs"][0]["txns"]["h1"].update(buys=True), "txns.h1.buys"),
        (lambda d: d["pairs"][0]["txns"]["h1"].update(sells=-1), "txns.h1.sells"),
        (lambda d: d["pairs"][0]["txns"]["h1"].update(buys=1.5), "txns.h1.buys"),
        (lambda d: d["pairs"][0]["txns"]["h1"].pop("sells"), "txns.h1: missing"),
        (lambda d: d["pairs"][0]["txns"]["h1"].update(makers=3), "txns.h1: unexpected"),
        (lambda d: d["pairs"][0]["txns"].update(m15={"buys": 0, "sells": 0}), "txns: unexpected"),
        (_pair(0, txns=[]), "txns: expected an object"),
        (lambda d: d["pairs"][0]["volume"].update(h24="0.07"), "volume.h24"),
        (lambda d: d["pairs"][0]["volume"].update(h24=-1), "volume.h24"),
        (lambda d: d["pairs"][0]["volume"].update(h24=None), "volume.h24"),
        (lambda d: d["pairs"][0]["priceChange"].update(h1=-100.5), "priceChange.h1"),
        (_pair(0, priceChange=[]), "priceChange"),
        (lambda d: d["pairs"][0]["liquidity"].pop("base"), "liquidity: missing"),
        (lambda d: d["pairs"][0]["liquidity"].update(base=None), "liquidity.base"),
        (lambda d: d["pairs"][0]["liquidity"].update(usd=-5), "liquidity.usd"),
        (lambda d: d["pairs"][0]["liquidity"].update(locked=1), "liquidity: unexpected"),
        (_pair(0, fdv="247043"), "fdv"),
        (_pair(0, marketCap=False), "marketCap"),
        (_pair(0, pairCreatedAt=1791839594.5), "pairCreatedAt"),
        (_pair(0, pairCreatedAt="1791839594000"), "pairCreatedAt"),
        (_pair(0, pairCreatedAt=1791839594), "pairCreatedAt"),  # seconds, not milliseconds
        (_pair(0, pairCreatedAt=1791839594000 + 86_400_000), "pairCreatedAt"),  # after the response
        (_pair(0, pairCreatedAt=10**30), "pairCreatedAt"),
    ],
)
def test_unexpected_content_stops_instead_of_guessing(
    change: Callable[[dict[str, Any]], object], message: str
) -> None:
    with pytest.raises(DexScreenerFormatError, match=message):
        parse(mutated(change))


@pytest.mark.parametrize(
    ("raw", "message"),
    [  # built inside the test, so a withheld fixture skips one case instead of the module
        (lambda: body(BATCH).replace(b'"fdv":247043', b'"fdv":NaN'), "non-finite"),
        (lambda: body(BATCH).replace(b'"fdv":247043', b'"fdv":Infinity'), "non-finite"),
        (lambda: body(BATCH).replace(b'"fdv":247043', b'"fdv":247043,"fdv":1'), "duplicate key"),
        (lambda: body(BATCH)[:-1], "not valid JSON"),
        (lambda: b"\xef\xbb\xbf" + body(BATCH), "not valid JSON"),  # a byte-order mark
        (lambda: body(BATCH).replace(b"PonsPump", b"Pons\xffPump"), "not UTF-8"),
        (lambda: body(OVER_LIMIT), "expected an object"),  # the 400 page, if it ever came with 200
        (lambda: b"[]", "expected an object"),
        (lambda: b"null", "expected an object"),
    ],
)
def test_broken_bodies_are_refused(raw: Callable[[], bytes], message: str) -> None:
    data = raw()
    with pytest.raises(DexScreenerFormatError, match=message):
        parse(data)


@pytest.mark.parametrize(
    ("hdrs", "message"),
    [
        ([(k, v) for k, v in headers(BATCH) if k != "date"], "no Date header"),
        ([*headers(BATCH), ("date", "yesterday")], "bad Date header"),
        ([*headers(BATCH), ("date", "Mon, 12 Oct 2026 21:22:29 -0000")], "time zone"),
        ([*headers(BATCH), ("age", "-3")], "bad Age header"),
        ([*headers(BATCH), ("age", "4.5")], "bad Age header"),
        ([*headers(BATCH), ("cache-control", "public, max-age=thirty")], "Cache-Control"),
        ([*headers(BATCH), ("cache-control", "max-age=-1")], "Cache-Control"),
        ([*headers(BATCH), ("cache-control", "s-maxage=")], "Cache-Control"),
        ([(k, v) for k, v in headers(BATCH) if k != "content-type"], "application/json"),
        ([*headers(BATCH), ("content-type", "text/html")], "application/json"),
    ],
)
def test_bad_headers_are_refused(hdrs: list[tuple[str, str]], message: str) -> None:
    with pytest.raises(DexScreenerFormatError, match=message):
        parse(body(BATCH), hdrs)


def test_server_date_far_from_our_clock_is_refused() -> None:
    with pytest.raises(DexScreenerFormatError, match="clock"):
        parse(body(BATCH), fetched=FETCHED + timedelta(hours=1))
    with pytest.raises(DexScreenerFormatError, match="clock"):
        parse(body(BATCH), fetched=FETCHED - timedelta(minutes=6))


def test_wrong_content_type_or_status_is_refused() -> None:
    page = Raw(200, b"<html>maintenance</html>", [("Content-Type", "text/html"), ("Date", "x")])
    with pytest.raises(DexScreenerFormatError, match="application/json"):
        source(Replay(page)).pairs(REQUESTED_30)
    with pytest.raises(DexScreenerFormatError, match="HTTP 200"):
        source(Replay(Raw(204, b""))).pairs(REQUESTED_30)


# ----------------------------------------------------------- untrusted content
def test_untrusted_text_is_sanitized_and_links_are_never_kept() -> None:
    def hostile(doc: dict[str, Any]) -> None:
        pair = doc["pairs"][0]
        pair["labels"] = ["DYN2\x1b[31m" + RIGHT_TO_LEFT + "evil" + "x" * 100, CYRILLIC]
        pair["baseToken"]["name"] = "Free \x07money https://scam.example"
        pair["info"] = {
            "imageUrl": "https://scam.example/i.png",
            "websites": [{"url": "https://scam.example"}],
            "socials": [{"platform": "x", "handle": "scam"}],
            "openGraph": "https://scam.example/og",
        }
        pair["boosts"] = {"active": 3}

    snap = parse(mutated(hostile)).found[METEORA]
    assert snap.labels == ("DYN2[31mevil" + "x" * 28, "")
    plain = repr(dataclasses.asdict(snap))
    assert "scam" not in plain and "http" not in plain and "money" not in plain
    assert plain.isascii()


def test_clean_text_keeps_printable_ascii_only() -> None:
    assert clean_text("  PONS\tPUMP\r\n ") == "PONSPUMP"
    assert clean_text(CYRILLIC + " SOL " + ROCKET) == "SOL"
    assert clean_text(RIGHT_TO_LEFT + "abc") == "abc"
    assert clean_text("A" * 100) == "A" * 40
    assert clean_text("") == ""


def test_an_answer_read_after_the_pc_slept_is_old_not_a_clock_problem() -> None:
    late = FETCHED + timedelta(minutes=40)
    with pytest.raises(DexScreenerFormatError, match="clock"):
        parse(body(BATCH), fetched=late)
    sent = FETCHED - timedelta(seconds=1)
    batch = parse_pairs(body(BATCH), dict(headers(BATCH)), REQUESTED_30, late, sent_at=sent)
    assert batch.fetched_at == late and set(batch.found) == set(IN_FIXTURE)
    with pytest.raises(DexScreenerFormatError, match="clock"):
        parse_pairs(
            body(BATCH), dict(headers(BATCH)), REQUESTED_30, late, sent_at=late - timedelta(seconds=1)
        )
