"""DexScreener pair snapshots (public API, free tier, no key): research data only.

DexScreener is a SNAPSHOT source for pools discovered elsewhere (our on-chain recorder or
GeckoTerminal's new-pool feed). It is NEVER a discovery source: no endpoint lists all new
pairs, and its "latest" feeds are paid promotion or popularity-ranked, so a universe built
from them is survivorship-biased by construction.

Facts this adapter relies on (checked 2026-10-12 against the API reference
https://docs.dexscreener.com/api/reference, the API terms
https://docs.dexscreener.com/api/api-terms-and-conditions, and 14 live calls; the
responses used here are recorded in tests/fixtures/dexscreener):
- GET https://api.dexscreener.com/latest/dex/pairs/{chainId}/{pairId} returns "one or
  multiple pairs"; rate limit 300 requests/min. Pair addresses are comma-separated in the
  path. NO maximum is documented: live, 30 addresses returned all 30 and 31 returned
  HTTP 400 (an HTML "Bad request" page wrapped in a JSON string, content-type
  application/json). So MAX_PAIRS = 30, and a 400 splits the batch in case that changes.
- Body: {"schemaVersion": "1.0.0", "pairs": [Pair] | null, "pair": null}. The 'pair' key
  is undocumented and was null in every response seen.
- An unknown, removed or non-pair address returns HTTP 200 with "pairs": null. That means
  "not on DexScreener", never "rugged" or "zero liquidity": confirm death on-chain.
- Pair (documented types): priceNative and priceUsd (only priceUsd is documented as
  nullable) are decimal STRINGS; txns {window: {buys, sells}} are integers; volume,
  priceChange (nullable), liquidity {usd (nullable), base, quote} (nullable), fdv and
  marketCap (nullable) are JSON numbers; pairCreatedAt (nullable) is milliseconds since
  the Unix epoch (UTC). quoteToken.address is documented as nullable (never seen null).
  Windows seen live: m5, h1, h6, h24. priceChange is often {} or lacks m5 for new pools.
  UNITS ARE NOT DOCUMENTED. Inferred from the samples: volume, liquidity.usd, fdv and
  marketCap are USD (volume had the same magnitude as GeckoTerminal's volume_usd for the
  same pools; SOL would be ~100x smaller) and priceNative is quote tokens per base token
  (priceUsd / priceNative = the SOL price for SOL-quoted pools).
- liquidity is ABSENT for pump.fun bonding-curve (dexId "pumpfun") and Meteora DBC
  ("meteoradbc") pairs. That is normal, not an error; their liquidity must come from
  on-chain reserves.
- 'url' lowercases the case-sensitive Solana address (never parsed here). 'info' holds
  attacker-controlled links, socials and images (never stored). Token names and symbols
  are not stored either: the discovery source records them, sanitized.
- dexId naming differs from GeckoTerminal: pump-fun -> pumpfun, meteora-damm-v2 ->
  meteora with label DYN2, meteora-dbc -> meteoradbc, pumpswap -> pumpswap.
- Responses are CDN-cached and shared by everyone (cache-control: public, max-age=30 on
  this endpoint, 60 on others, where an 'age' header of up to 44 s was seen) and the body
  has no as-of time. The Date header is the time Cloudflare answered (it matched our
  request time in every recorded response, HIT or MISS). Age was absent on MISS and
  REVALIDATED answers and also on one cache HIT (the search endpoint), so a missing Age
  does NOT prove the data is fresh. So as_of = Date - Age, or, without Age, Date - max(30
  s, the max-age/s-maxage in Cache-Control), and never later than fetched_at (our clock
  may lag the server's): the OLDEST the data may be, for staleness checks. It is not a
  lookahead guard (without Age the data may be up to max-age NEWER than as_of): research
  must gate on fetched_at, the time we knew it.
  txns/volume/priceChange are rolling windows ending at DexScreener's "now", not bars:
  history can't be rebuilt or backfilled, and a recorder outage is permanent data loss.
- No rate-limit headers were seen and the over-limit status is undocumented (429
  presumed). The HTTP client retries 429/5xx a few times, then the call fails.
- Terms (last updated 2023-08-18): no reselling and no making the data available to
  third parties; access is revocable without notice; breaking-change notice is promised
  to paying customers only. Never publish recorded data. No attribution requirement was
  found; don't use their name or logo or imply endorsement.
"""

from __future__ import annotations

import email.utils
import json
import logging
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from samsulek.net.http import HttpClient, HttpError, RateLimiter

log = logging.getLogger(__name__)

HOST = "api.dexscreener.com"
BASE = f"https://{HOST}/latest/dex/pairs/"
SOURCE = "dexscreener"
SCHEMA_VERSION = "1.0.0"
MAX_PAIRS = 30  # 31 returned HTTP 400 live; no maximum is documented
MAX_SPLIT_DEPTH = 2  # on HTTP 400: halves, then quarters, then give up
DEFAULT_AGE = timedelta(seconds=30)  # cache-control max-age of this endpoint (2026-10-12)
MAX_CLOCK_SKEW = timedelta(minutes=5)  # server Date vs our clock; more means a clock problem
WINDOWS = ("m5", "h1", "h6", "h24")
TEXT_LIMIT = 40
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_OLDEST_PAIR = datetime(2015, 1, 1, tzinfo=UTC)  # sanity floor, older than any DEX pair
_BASE58_RE = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")
_CHAIN_RE = re.compile(r"[a-z][a-z0-9-]{0,31}")
_DEX_ID_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{0,39}")
_DECIMAL_RE = re.compile(r"[0-9]{1,40}(?:\.[0-9]{1,40})?(?:[eE][-+]?[0-9]{1,3})?")
_AGE_RE = re.compile(r"[0-9]{1,9}")  # delta-seconds, as in Age and Cache-Control max-age
_TOP_KEYS = frozenset({"schemaVersion", "pairs", "pair"})
_TOP_REQUIRED = frozenset({"schemaVersion", "pairs"})
_PAIR_REQUIRED = frozenset({"chainId", "dexId", "pairAddress", "baseToken", "quoteToken", "txns", "volume"})
_PAIR_OPTIONAL = frozenset(
    {"labels", "priceNative", "priceUsd", "priceChange", "liquidity", "fdv", "marketCap", "pairCreatedAt"}
)
# Allowed but never parsed or stored: 'url' lowercases addresses, 'info' is attacker-
# controlled links/socials/images, 'boosts' is paid promotion.
_PAIR_IGNORED = frozenset({"url", "info", "boosts"})
_PAIR_KEYS = _PAIR_REQUIRED | _PAIR_OPTIONAL | _PAIR_IGNORED
_TOKEN_KEYS = frozenset({"address", "name", "symbol"})
_TXN_KEYS = frozenset({"buys", "sells"})
_LIQUIDITY_KEYS = frozenset({"usd", "base", "quote"})
_LIQUIDITY_REQUIRED = frozenset({"base", "quote"})
_ZERO = Decimal(0)
_MINUS_100 = Decimal(-100)


class DexScreenerFormatError(ValueError):
    """The response doesn't look like what the adapter was written for: stop, don't guess."""


@dataclass(frozen=True, slots=True)
class PairSnapshot:
    """One pool as DexScreener reported it at its batch's ``as_of`` (rolling windows, not bars)."""

    pair_address: str  # case-sensitive base58, exactly as requested
    dex_id: str  # DexScreener's naming: pumpfun, pumpswap, meteora, meteoradbc, ...
    labels: tuple[str, ...]  # e.g. ("DYN2",) for Meteora DAMM v2 (sanitized text)
    base_mint: str
    quote_mint: str
    price_usd: Decimal | None
    price_native: Decimal | None  # in quote-token units (as the recorded samples show)
    txns: dict[str, tuple[int, int]]  # window -> (buys, sells); windows among m5/h1/h6/h24
    volume_usd: dict[str, Decimal]  # window -> USD volume
    price_change_pct: dict[str, Decimal]  # window -> percent; often empty for new pools
    liquidity_usd: Decimal | None  # None for pump.fun bonding curves and Meteora DBC: normal
    liquidity_base: Decimal | None
    liquidity_quote: Decimal | None
    fdv_usd: Decimal | None
    market_cap_usd: Decimal | None
    pair_created_at: datetime | None  # UTC


@dataclass(frozen=True, slots=True)
class PairsBatch:
    found: dict[str, PairSnapshot]  # pair address -> snapshot, in request order
    missing: tuple[str, ...]  # asked for but not returned: "not on DexScreener", NOT "rugged"
    as_of: datetime  # UTC: Date - Age (see module notes), <= fetched_at; the OLDEST part if split
    fetched_at: datetime  # UTC: when the response arrived; the LATEST part if split


def limiter() -> RateLimiter:
    """Documented limit: 300 requests/min for pairs. We make at most one call every 2 s."""
    return RateLimiter(1, 2.0)


# ------------------------------------------------------------------ parsing
def parse_pairs(
    body: bytes,
    headers: Mapping[str, str],
    requested: Sequence[str],
    fetched_at: datetime,
    *,
    chain: str = "solana",
    sent_at: datetime | None = None,
) -> PairsBatch:
    """Parse a /latest/dex/pairs response for the ``requested`` addresses (any header case).
    ``sent_at`` (when the request went out) widens the clock check backwards: an answer
    read after the PC slept is old, not proof of a wrong clock."""
    wanted = _check_request(requested, chain)
    if fetched_at.tzinfo is None:
        raise ValueError("fetched_at must be timezone-aware")
    if sent_at is not None and sent_at.tzinfo is None:
        raise ValueError("sent_at must be timezone-aware")
    fetched_at = fetched_at.astimezone(UTC)
    lower = {name.lower(): value for name, value in headers.items()}
    content_type = lower.get("content-type", "")
    if content_type.split(";", 1)[0].strip().lower() != "application/json":
        raise DexScreenerFormatError(f"expected application/json, got {_show(content_type)}")
    as_of = _as_of(lower, fetched_at, sent_at)
    doc = _object(_load_json(body), "response", _TOP_KEYS, _TOP_REQUIRED)
    if doc["schemaVersion"] != SCHEMA_VERSION:
        raise DexScreenerFormatError(f"unsupported schemaVersion {_show(doc['schemaVersion'])}")
    if doc.get("pair") is not None:
        raise DexScreenerFormatError("'pair' is not null: this adapter only knows the 'pairs' list")
    items = doc["pairs"]
    if items is None:  # none of the addresses is on DexScreener
        items = []
    if not isinstance(items, list):
        raise DexScreenerFormatError(f"'pairs' must be a list or null, got {_show(items)}")
    asked = frozenset(wanted)
    found: dict[str, PairSnapshot] = {}
    for n, item in enumerate(items):
        snap = _parse_pair(item, f"pairs[{n}]", asked, chain, fetched_at)
        if snap.pair_address in found:
            raise DexScreenerFormatError(f"pair {snap.pair_address} returned twice")
        found[snap.pair_address] = snap
    return PairsBatch(
        found={a: found[a] for a in wanted if a in found},
        missing=tuple(a for a in wanted if a not in found),
        as_of=as_of,
        fetched_at=fetched_at,
    )


def _check_request(addresses: Sequence[str], chain: str) -> tuple[str, ...]:
    if not isinstance(chain, str) or not _CHAIN_RE.fullmatch(chain):
        raise ValueError(f"invalid chain id {_show(chain)}")
    if isinstance(addresses, str):
        raise ValueError("pass a list of pair addresses, not a single string")
    wanted = tuple(addresses)
    if not wanted:
        raise ValueError("no pair addresses requested")
    if len(wanted) > MAX_PAIRS:
        raise ValueError(f"at most {MAX_PAIRS} pair addresses per request, got {len(wanted)}")
    bad = [a for a in wanted if not isinstance(a, str) or not _BASE58_RE.fullmatch(a)]
    if bad:
        raise ValueError(f"not plausible base58 addresses: {[_show(a) for a in bad[:3]]}")
    if len(set(wanted)) != len(wanted):
        dupes = sorted({a for a in wanted if wanted.count(a) > 1})
        raise ValueError(f"duplicate pair addresses: {dupes}")
    return wanted


def _as_of(headers: Mapping[str, str], fetched_at: datetime, sent_at: datetime | None = None) -> datetime:
    raw_date = headers.get("date")
    if raw_date is None:
        raise DexScreenerFormatError("no Date header: the snapshot can't be timestamped")
    try:
        server = email.utils.parsedate_to_datetime(raw_date)
    except (TypeError, ValueError) as exc:
        raise DexScreenerFormatError(f"bad Date header {_show(raw_date)}") from exc
    if server.tzinfo is None:
        raise DexScreenerFormatError(f"Date header without a time zone: {_show(raw_date)}")
    server = server.astimezone(UTC)
    earliest = (sent_at if sent_at is not None else fetched_at).astimezone(UTC) - MAX_CLOCK_SKEW
    if not earliest <= server <= fetched_at + MAX_CLOCK_SKEW:
        raise DexScreenerFormatError(
            f"server Date {server.isoformat()} is more than {MAX_CLOCK_SKEW} away from our clock "
            f"{fetched_at.isoformat()}: check this computer's clock (or a stale cached response)"
        )
    raw_age = headers.get("age")
    if raw_age is None:
        # Not proof of freshness (a cache HIT without Age was seen): assume the longest reuse.
        age = max(DEFAULT_AGE, _cache_max_age(headers.get("cache-control")))
    elif _AGE_RE.fullmatch(raw_age.strip()):
        age = timedelta(seconds=int(raw_age.strip()))
    else:
        raise DexScreenerFormatError(f"bad Age header {_show(raw_age)}")
    # Never later than the moment we had it, even when our clock lags the server's.
    return min(server - age, fetched_at)


def _cache_max_age(value: str | None) -> timedelta:
    """The longest max-age / s-maxage in a Cache-Control header (0 when there is none)."""
    longest = 0
    for directive in (value or "").split(","):
        name, _, arg = directive.partition("=")
        if name.strip().lower() not in ("max-age", "s-maxage"):
            continue
        seconds = arg.strip().strip('"')
        if not _AGE_RE.fullmatch(seconds):
            raise DexScreenerFormatError(f"bad Cache-Control header {_show(value)}")
        longest = max(longest, int(seconds))
    return timedelta(seconds=longest)


def _load_json(body: bytes) -> object:
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DexScreenerFormatError(f"response is not UTF-8: {exc}") from exc
    try:
        # parse_float=Decimal keeps the digits exactly as sent (no binary float rounding).
        return json.loads(
            text, parse_float=Decimal, parse_constant=_no_constant, object_pairs_hook=_no_duplicate_keys
        )
    except DexScreenerFormatError:
        raise
    except (ValueError, RecursionError) as exc:
        raise DexScreenerFormatError(f"response is not valid JSON: {exc}") from exc


def _no_constant(name: str) -> object:
    raise DexScreenerFormatError(f"non-finite number {name} in the response")


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    out: dict[str, object] = {}
    for key, value in pairs:
        if key in out:
            raise DexScreenerFormatError(f"duplicate key {_show(key)} in a JSON object")
        out[key] = value
    return out


def _parse_pair(
    value: object, where: str, asked: frozenset[str], chain: str, fetched_at: datetime
) -> PairSnapshot:
    pair = _object(value, where, _PAIR_KEYS, _PAIR_REQUIRED)
    address = pair["pairAddress"]
    # Exact, case-sensitive comparison: Solana addresses are case-sensitive.
    if not isinstance(address, str) or address not in asked:
        raise DexScreenerFormatError(f"{where}: pair {_show(address)} was not requested")
    where = f"pair {address}"
    if pair["chainId"] != chain:
        raise DexScreenerFormatError(f"{where}: chainId {_show(pair['chainId'])}, expected {chain!r}")
    dex_id = pair["dexId"]
    if not isinstance(dex_id, str) or not _DEX_ID_RE.fullmatch(dex_id):
        raise DexScreenerFormatError(f"{where}: bad dexId {_show(dex_id)}")
    liquidity = pair.get("liquidity")
    liq: tuple[Decimal | None, Decimal | None, Decimal | None] = (None, None, None)
    if liquidity is not None:
        lw = f"{where}.liquidity"
        lo = _object(liquidity, lw, _LIQUIDITY_KEYS, _LIQUIDITY_REQUIRED)
        liq = (
            _optional_number(lo, "usd", lw),
            _number(lo["base"], f"{lw}.base"),
            _number(lo["quote"], f"{lw}.quote"),
        )
    price_change = pair.get("priceChange")
    return PairSnapshot(
        pair_address=address,
        dex_id=dex_id,
        labels=_labels(pair.get("labels"), f"{where}.labels"),
        base_mint=_mint(pair["baseToken"], f"{where}.baseToken"),
        quote_mint=_mint(pair["quoteToken"], f"{where}.quoteToken"),
        price_usd=_price(pair.get("priceUsd"), f"{where}.priceUsd"),
        price_native=_price(pair.get("priceNative"), f"{where}.priceNative"),
        txns=_windows(pair["txns"], f"{where}.txns", _txn),
        volume_usd=_windows(pair["volume"], f"{where}.volume", _number),
        price_change_pct=(
            {} if price_change is None else _windows(price_change, f"{where}.priceChange", _percent_change)
        ),
        liquidity_usd=liq[0],
        liquidity_base=liq[1],
        liquidity_quote=liq[2],
        fdv_usd=_optional_number(pair, "fdv", where),
        market_cap_usd=_optional_number(pair, "marketCap", where),
        pair_created_at=_created_at(pair.get("pairCreatedAt"), f"{where}.pairCreatedAt", fetched_at),
    )


def _object(
    value: object, where: str, allowed: frozenset[str], required: frozenset[str] = frozenset()
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise DexScreenerFormatError(f"{where}: expected an object, got {_show(value)}")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise DexScreenerFormatError(f"{where}: unexpected keys {[_show(k) for k in unknown]}")
    absent = sorted(required - set(value))
    if absent:
        raise DexScreenerFormatError(f"{where}: missing {absent}")
    return value


def _mint(value: object, where: str) -> str:
    token = _object(value, where, _TOKEN_KEYS, frozenset({"address"}))
    for key in ("name", "symbol"):  # never stored, but must still have the documented type
        if token.get(key) is not None and not isinstance(token[key], str):
            raise DexScreenerFormatError(f"{where}.{key}: expected text, got {_show(token[key])}")
    address = token["address"]
    if not isinstance(address, str) or not _BASE58_RE.fullmatch(address):
        raise DexScreenerFormatError(f"{where}.address: not a base58 address: {_show(address)}")
    return address


def _labels(value: object, where: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise DexScreenerFormatError(f"{where}: expected a list of text, got {_show(value)}")
    return tuple(clean_text(v) for v in value)


def _windows[T](value: object, where: str, parse: Callable[[object, str], T]) -> dict[str, T]:
    windows = _object(value, where, frozenset(WINDOWS))  # an unknown window is a surprise
    return {w: parse(windows[w], f"{where}.{w}") for w in WINDOWS if w in windows}


def _txn(value: object, where: str) -> tuple[int, int]:
    counts = _object(value, where, _TXN_KEYS, _TXN_KEYS)
    return _count(counts["buys"], f"{where}.buys"), _count(counts["sells"], f"{where}.sells")


def _count(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DexScreenerFormatError(f"{where}: expected a count, got {_show(value)}")
    return value


def _number(value: object, where: str, minimum: Decimal = _ZERO) -> Decimal:
    # JSON numbers arrive as int or Decimal (see _load_json); bool is an int subclass.
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        raise DexScreenerFormatError(f"{where}: expected a number, got {_show(value)}")
    number = Decimal(value)
    if not number.is_finite() or number < minimum:
        raise DexScreenerFormatError(f"{where}: expected a number >= {minimum}, got {number}")
    return number


def _percent_change(value: object, where: str) -> Decimal:
    return _number(value, where, minimum=_MINUS_100)  # a price can't fall more than 100%


def _optional_number(obj: Mapping[str, object], key: str, where: str) -> Decimal | None:
    value = obj.get(key)
    return None if value is None else _number(value, f"{where}.{key}")


def _price(value: object, where: str) -> Decimal | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _DECIMAL_RE.fullmatch(value):
        raise DexScreenerFormatError(f"{where}: expected a non-negative decimal string, got {_show(value)}")
    return Decimal(value)


def _created_at(value: object, where: str, fetched_at: datetime) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise DexScreenerFormatError(f"{where}: expected epoch milliseconds, got {_show(value)}")
    try:
        when = _EPOCH + timedelta(milliseconds=value)
    except OverflowError as exc:
        raise DexScreenerFormatError(f"{where}: out of range: {value}") from exc
    if not _OLDEST_PAIR <= when <= fetched_at + MAX_CLOCK_SKEW:
        raise DexScreenerFormatError(f"{where}: implausible time {when.isoformat()}")
    return when


def clean_text(text: str) -> str:
    """Untrusted text from the API -> printable ASCII, at most TEXT_LIMIT characters."""
    return "".join(ch for ch in text if " " <= ch <= "~").strip()[:TEXT_LIMIT].strip()


def _show(value: object) -> str:
    """A short ASCII-only rendering of an untrusted value, for error messages."""
    if isinstance(value, dict | list):
        return type(value).__name__
    if isinstance(value, str):
        return ascii(value[:60])
    return ascii(value)[:60]


# ------------------------------------------------------------------- source
class DexScreenerSource:
    """Snapshots of pools discovered elsewhere. Never use it to discover pools (see above)."""

    def __init__(self, http: HttpClient) -> None:
        if HOST not in http.allowed_hosts:
            raise ValueError(f"the HTTP client must allow {HOST}")
        self._http = http

    def pairs(self, addresses: Sequence[str], chain: str = "solana") -> PairsBatch:
        """Snapshot up to MAX_PAIRS pools by pair address (base58, case-sensitive)."""
        return self._fetch(_check_request(addresses, chain), chain, 0)

    def _fetch(self, wanted: tuple[str, ...], chain: str, depth: int) -> PairsBatch:
        try:
            response = self._http.get(f"{BASE}{chain}/{','.join(wanted)}")
        except HttpError as exc:
            if exc.status != 400 or len(wanted) < 2 or depth >= MAX_SPLIT_DEPTH:
                raise
            # 400 is what an over-long batch gets: the undocumented maximum may have dropped.
            log.warning("DexScreener refused %d addresses (HTTP 400); retrying in halves", len(wanted))
            half = len(wanted) // 2
            first = self._fetch(wanted[:half], chain, depth + 1)
            second = self._fetch(wanted[half:], chain, depth + 1)
            return PairsBatch(
                found={**first.found, **second.found},
                missing=first.missing + second.missing,
                as_of=min(first.as_of, second.as_of),
                fetched_at=max(first.fetched_at, second.fetched_at),
            )
        if response.status != 200:
            raise DexScreenerFormatError(f"expected HTTP 200, got {response.status}")
        return parse_pairs(
            response.body,
            response.headers,
            wanted,
            response.received_at,
            chain=chain,
            sent_at=response.sent_at,
        )
