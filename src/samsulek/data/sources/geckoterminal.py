"""GeckoTerminal public API v2: the Solana "new pools" discovery feed. Free, no key.

Research/simulation only. This is a cross-check feed, NOT a complete record of every
new pool: only pages 1-10 exist (200 pools, a few minutes of launches) and there is no
time-range query, so anything not fetched in time is lost from this feed for good.

Facts this adapter relies on (checked 2026-10-12 against the official OpenAPI spec
https://api.geckoterminal.com/docs/v2/swagger.json ("GeckoTerminal API V2", v2-beta) and
22 live requests; the API guide at apiguide.geckoterminal.com redirects to
docs.coingecko.com, which the build environment could not reach):
- Base URL https://api.geckoterminal.com/api/v2. Version pinned with the header
  ``Accept: application/json;version=20230203`` (spec: "current version is 20230203";
  without it the latest version is used). The API is beta and "subject to frequent
  changes", so every surprise below stops parsing instead of guessing.
- Rate limit "approximately 10 calls/minute, which may fluctuate" (spec). Live: two
  429s at no more than 4 calls/min (the build environment's outbound IP is probably
  shared: UNVERIFIED), with ``Retry-After: 0`` and no X-RateLimit headers. 429 body:
  {"status":{"error_code":429,"error_message":...}}. The source refuses an HTTP client
  without a rate limiter for this host: an unthrottled burst of 10 pages means 429s,
  and every 429 can mean pools lost for good.
- GET /networks/solana/new_pools?page=N&include=base_token,quote_token,dex. Spec: page
  "maximum: 10". Live: page 11 returns 401 {"errors":[{"status":"401","title":"Your
  request exceeds the allowed max number for page (10)..."}],"meta":{"ref_id":...}}.
  The request was verified with literal commas in ``include``, so the URL is built
  exactly like that (no percent-encoding).
- Live: every page had exactly 20 pools; the document has only "data" and "included"
  (no links/meta pagination). data[] items: type "pool", id "solana_<pool address>";
  attributes are strings or null (prices, fdv_usd, reserve_in_usd, volume_usd.*;
  up to ~76 characters of plain decimal, parsed as Decimal), JSON integers for
  transactions.*.buys/sells, pool_created_at in ISO 8601 UTC "Z" with whole seconds.
  reserve_in_usd is null or "0.0" for brand-new pools. relationships base_token and
  quote_token point to {"type":"token","id":"solana_<mint>"}, dex to {"type":"dex",
  "id":"<dex id>"}. included[] holds each referenced token/dex exactly once and
  nothing else (all 10 recorded pages).
- Spec: "All endpoints listed below are cached for 1 minute". Live: Cloudflare,
  ``Cache-Control: ... s-maxage=60``, ``Age`` up to 58 s, and some cache HITs had no
  Age header. The snapshot describes the moment the server built it, so
  ``as_of = Date - Age``; without Age it is ``Date - 60 s`` (the documented cache
  time). Then ``as_of`` is a LOWER bound: the data may be up to 60 s newer. Use
  ``fetched_at`` as the point-in-time "known at" stamp; ``as_of`` is for staleness and
  for the end of the rolling m5/h1 windows. The origin has a cache of its own
  (``x-rack-cache: fresh``); whether its time is counted in Age is UNVERIFIED.
- Chosen here, not documented (fail closed): a server Date more than 5 minutes from our
  clock (a clock problem; the DexScreener adapter uses the same bound), an Age over
  300 s (5x the documented cache: a stale copy), or a pool created more than 5 minutes
  after the server's Date (a time-zone bug; block times are only "estimated", hence the
  slack) stops parsing. So do duplicate JSON keys (``json`` would silently keep the
  last one) and NaN/Infinity.
- Pages are cached separately (page 2 was sometimes newer than page 1), so pages are not
  one snapshot: callers de-duplicate across pages by pool address.
- Live: a pool shows up 10-126 s after creation (indexing lag), plus up to 60 s cache.
- Solana addresses are 32 bytes shown as base58
  (https://solana.com/docs/core/accounts/account-structure, read from the docs source).
- Names and symbols are attacker-chosen text: a real page contained U+202E
  (RIGHT-TO-LEFT OVERRIDE) and emoji, and copycat names are common. They are reduced to
  printable ASCII (other characters become "?"), cut to 40 characters, and must never
  be used as keys. URLs, images, socials and descriptions are not kept.
- UNVERIFIED (docs host blocked): terms of use and attribution. The owner must read
  https://www.coingecko.com/en/api_terms before relying on this source.
"""

from __future__ import annotations

import email.utils
import json
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from samsulek.data.sources.base58 import is_pubkey
from samsulek.net.http import HttpClient, RateLimiter
from samsulek.types import require_aware

HOST = "api.geckoterminal.com"
BASE = f"https://{HOST}/api/v2"
SOURCE = "geckoterminal"
ACCEPT = "application/json;version=20230203"
NETWORK = "solana"
INCLUDE = "base_token,quote_token,dex"
MAX_PAGE = 10  # documented maximum; page 11 returns 401
PAGE_SIZE = 20  # observed on every recorded page; more than this is a surprise
CACHE_SECONDS = 60  # documented cache time: the assumed Age when the header is missing
MAX_AGE_SECONDS = 300  # sanity bound (5x the documented cache): older is a stale copy
MAX_CLOCK_SKEW = timedelta(minutes=5)  # server Date vs our clock; more is a clock problem
MAX_BODY_BYTES = 1_000_000  # a real 20-pool page is ~37 KB
MAX_TEXT_CHARS = 40  # names and symbols are cut to this length
MAX_ERROR_CHARS = 200

_ID_PREFIX = f"{NETWORK}_"
_DEX_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
_DECIMAL_RE = re.compile(r"[0-9]{1,40}(?:\.[0-9]{1,100})?")
_TIMESTAMP_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z")
_AGE_RE = re.compile(r"[0-9]{1,9}")
_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
_RELATIONSHIPS = (("base_token", "token"), ("quote_token", "token"), ("dex", "dex"))


class GeckoTerminalFormatError(ValueError):
    """The response doesn't look like what the adapter was written for: stop, don't guess."""


@dataclass(frozen=True, slots=True)
class NewPool:
    pool_address: str  # base58; the key to use (names are not unique)
    dex_id: str  # GeckoTerminal dex id, e.g. "pump-fun", "pumpswap", "meteora-dbc"
    base_mint: str
    quote_mint: str
    pool_created_at: datetime  # UTC, as reported by GeckoTerminal
    name: str  # sanitized, e.g. "HOLDOUT / SOL"
    base_symbol: str | None  # sanitized; None if the token wasn't included or is blank
    price_usd: Decimal | None  # base token price in USD at the page's as_of
    fdv_usd: Decimal | None
    reserve_usd: Decimal | None  # pool liquidity in USD; null/"0.0" for brand-new pools
    buys_m5: int | None
    sells_m5: int | None
    volume_m5_usd: Decimal | None
    volume_h1_usd: Decimal | None


@dataclass(frozen=True, slots=True)
class NewPoolsPage:
    page: int
    pools: tuple[NewPool, ...]  # in the API's order (roughly newest first)
    as_of: datetime  # UTC: server Date minus Age (minus 60 s if Age is missing)
    fetched_at: datetime  # UTC: when we received the response ("known at")


def limiter() -> RateLimiter:
    """6 calls per minute, no bursts: below the documented ~10/min, which fluctuates."""
    return RateLimiter(6, 60.0, burst=1)


def clean_text(value: str, limit: int = MAX_TEXT_CHARS) -> str:
    """Untrusted text -> printable ASCII. Whitespace runs become one space; any other
    character outside printable ASCII (controls, bidi overrides, emoji) becomes "?"."""
    text = unicodedata.normalize("NFKC", value[: limit * 5])
    out = "".join(ch if " " <= ch <= "~" else (" " if ch.isspace() else "?") for ch in text)
    return " ".join(out.split())[:limit].rstrip()


def error_message(body: bytes | str) -> str:
    """The message of a GeckoTerminal error body. Both envelopes are handled:
    429 {"status":{"error_code":..,"error_message":..}} and
    401/404 {"errors":[{"status":..,"title":..}],"meta":{...}}. URLs are removed."""
    doc = _load_json(body)
    parts: list[str] = []
    if isinstance(doc, dict) and isinstance(doc.get("status"), dict):
        status = doc["status"]
        code, message = status.get("error_code"), status.get("error_message")
        if type(code) is int and isinstance(message, str):
            parts.append(f"{code}: {message}")
    elif isinstance(doc, dict) and isinstance(doc.get("errors"), list) and doc["errors"]:
        for item in doc["errors"]:
            if not (isinstance(item, dict) and isinstance(item.get("title"), str)):
                parts = []
                break
            code = item.get("status")
            parts.append(f"{code}: {item['title']}" if isinstance(code, str | int) else item["title"])
    if not parts:
        raise GeckoTerminalFormatError("not a GeckoTerminal error body")
    # Normalise first, so a full-width "https://" can't survive as a link after cleaning.
    text = clean_text("; ".join(parts), MAX_ERROR_CHARS * 5)
    return _URL_RE.sub("<url>", text)[:MAX_ERROR_CHARS].rstrip()


def check_page(page: int) -> None:
    if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= MAX_PAGE:
        raise ValueError(f"page must be an integer from 1 to {MAX_PAGE}, got {page!r}")


def parse_new_pools(
    body: bytes,
    headers: Mapping[str, str],
    fetched_at: datetime,
    page: int = 1,
    *,
    sent_at: datetime | None = None,
) -> NewPoolsPage:
    """Parse one new_pools response (body + its HTTP headers). ``page`` is only a label.
    ``sent_at`` (when the request went out) widens the clock check backwards: an answer
    read after the PC slept is old, not proof of a wrong clock."""
    require_aware(fetched_at, "fetched_at")
    fetched_at = fetched_at.astimezone(UTC)
    if sent_at is not None:
        require_aware(sent_at, "sent_at")
    check_page(page)
    lowered = _lower_headers(headers)
    content_type = lowered.get("content-type", "")
    if not content_type.lower().startswith("application/json"):
        raise GeckoTerminalFormatError(f"expected application/json, got {_show(content_type)}")
    if len(body) > MAX_BODY_BYTES:
        raise GeckoTerminalFormatError(f"response is {len(body)} bytes, more than {MAX_BODY_BYTES}")
    server_date, as_of = _server_times(lowered, fetched_at, sent_at)
    doc = _load_json(body)
    if not isinstance(doc, dict):
        raise GeckoTerminalFormatError(f"expected a JSON object, got {type(doc).__name__}")
    if "errors" in doc or "status" in doc:
        try:
            reason = error_message(body)
        except GeckoTerminalFormatError:
            reason = "unrecognised error body"
        raise GeckoTerminalFormatError(f"error body in a successful response: {reason}")
    if set(doc) != {"data", "included"}:
        raise GeckoTerminalFormatError(f"expected top-level keys data and included, got {sorted(doc)}")
    data, included = doc["data"], doc["included"]
    if not isinstance(data, list) or not isinstance(included, list):
        raise GeckoTerminalFormatError("data and included must be arrays")
    if len(data) > PAGE_SIZE:
        raise GeckoTerminalFormatError(f"{len(data)} pools on one page, more than {PAGE_SIZE}")
    resources = _included(included)
    referenced: set[tuple[str, str]] = set()
    pools: list[NewPool] = []
    seen: set[str] = set()
    latest_created = server_date + MAX_CLOCK_SKEW
    for n, item in enumerate(data):
        pool, refs = _pool(item, f"data[{n}]", resources)
        if pool.pool_address in seen:
            raise GeckoTerminalFormatError(f"data[{n}]: duplicate pool {pool.pool_address}")
        if pool.pool_created_at > latest_created:
            raise GeckoTerminalFormatError(
                f"data[{n}]: pool_created_at {pool.pool_created_at.isoformat()} is after the response "
                f"was made ({server_date.isoformat()}): wrong time zone or clock in the feed"
            )
        seen.add(pool.pool_address)
        referenced |= refs
        pools.append(pool)
    unused = sorted(set(resources) - referenced)
    if unused:
        raise GeckoTerminalFormatError(f"included records no pool refers to: {unused[:3]}")
    return NewPoolsPage(page, tuple(pools), as_of, fetched_at)


class GeckoTerminalSource:
    def __init__(self, http: HttpClient) -> None:
        if HOST not in http.allowed_hosts:
            raise ValueError(f"the HTTP client must allow {HOST}")
        if HOST not in http.limiters:
            raise ValueError(f"the HTTP client needs a rate limiter for {HOST} (use limiter())")
        self._http = http

    def new_pools(self, page: int) -> NewPoolsPage:
        """One page (1-10) of the newest Solana pools.

        HTTP failures raise ``HttpError`` / ``RateLimitedError`` from the client; for a
        4xx, ``error_message(exc.body)`` gives the provider's reason."""
        check_page(page)
        url = f"{BASE}/networks/{NETWORK}/new_pools?page={page}&include={INCLUDE}"
        response = self._http.get(url, headers={"Accept": ACCEPT})
        if response.status != 200:
            raise GeckoTerminalFormatError(f"expected HTTP 200, got {response.status}")
        return parse_new_pools(
            response.body, response.headers, response.received_at, page, sent_at=response.sent_at
        )


# ---------------------------------------------------------------------------- helpers
def _lower_headers(headers: Mapping[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in headers.items():
        key = name.lower()
        if key in out and out[key] != value:
            raise GeckoTerminalFormatError(f"conflicting {key!r} headers")
        out[key] = value
    return out


def _server_times(
    headers: Mapping[str, str], fetched_at: datetime, sent_at: datetime | None = None
) -> tuple[datetime, datetime]:
    """(server Date, as_of = Date - Age), both UTC, checked against our own clock."""
    raw_date = headers.get("date")
    if raw_date is None:
        raise GeckoTerminalFormatError("no Date header: can't tell when the data was generated")
    try:
        server_date = email.utils.parsedate_to_datetime(raw_date)
    except (TypeError, ValueError) as exc:
        raise GeckoTerminalFormatError(f"bad Date header {_show(raw_date)}") from exc
    if server_date.tzinfo is None:
        raise GeckoTerminalFormatError(f"Date header without a time zone: {_show(raw_date)}")
    server_date = server_date.astimezone(UTC)
    earliest = (sent_at if sent_at is not None else fetched_at).astimezone(UTC) - MAX_CLOCK_SKEW
    if not earliest <= server_date <= fetched_at + MAX_CLOCK_SKEW:
        raise GeckoTerminalFormatError(
            f"server Date {server_date.isoformat()} is more than {MAX_CLOCK_SKEW} away from our clock "
            f"{fetched_at.isoformat()}: check this computer's clock"
        )
    raw_age = headers.get("age")
    if raw_age is None:
        age = CACHE_SECONDS
    elif _AGE_RE.fullmatch(raw_age.strip()):
        age = int(raw_age.strip())
    else:
        raise GeckoTerminalFormatError(f"bad Age header {_show(raw_age)}")
    if age > MAX_AGE_SECONDS:
        raise GeckoTerminalFormatError(f"Age {age} s is more than {MAX_AGE_SECONDS} s: a stale cached copy")
    return server_date, server_date - timedelta(seconds=age)


def _load_json(body: bytes | str) -> Any:
    """Strict JSON: UTF-8, no NaN/Infinity, no duplicate keys (``json`` keeps the last)."""
    try:
        text = body if isinstance(body, str) else body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GeckoTerminalFormatError(f"response is not UTF-8: {exc}") from exc
    try:
        return json.loads(text, parse_constant=_no_constant, object_pairs_hook=_no_duplicate_keys)
    except GeckoTerminalFormatError:
        raise
    except (ValueError, RecursionError) as exc:
        raise GeckoTerminalFormatError(f"response is not valid JSON: {exc}") from exc


def _no_constant(name: str) -> Any:
    raise GeckoTerminalFormatError(f"non-finite number {name} in the response")


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise GeckoTerminalFormatError(f"duplicate JSON key {_show(key)}")
        out[key] = value
    return out


def _included(items: list[Any]) -> dict[tuple[str, str], dict[str, Any]]:
    """Index included[] by (type, id). Only tokens and dexes, each once."""
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for n, item in enumerate(items):
        where = f"included[{n}]"
        obj = _obj(item, where)
        kind, rid = _str(_get(obj, "type", where), where), _str(_get(obj, "id", where), where)
        attrs = _obj(_get(obj, "attributes", where), f"{where}.attributes")
        if kind == "token":
            address = _address(_str(_get(attrs, "address", where), where), where)
            if rid != _ID_PREFIX + address:
                raise GeckoTerminalFormatError(f"{where}: id {_show(rid)} doesn't match its address")
        elif kind == "dex":
            _dex_id(rid, where)
        else:
            raise GeckoTerminalFormatError(f"{where}: unexpected record type {_show(kind)}")
        if (kind, rid) in out:
            raise GeckoTerminalFormatError(f"{where}: duplicate {kind} {_show(rid)}")
        out[(kind, rid)] = attrs
    return out


def _pool(
    item: Any, where: str, resources: Mapping[tuple[str, str], Mapping[str, Any]]
) -> tuple[NewPool, set[tuple[str, str]]]:
    obj = _obj(item, where)
    kind = _get(obj, "type", where)
    if kind != "pool":
        raise GeckoTerminalFormatError(f"{where}: not a pool (type {_show(kind)})")
    rid = _str(_get(obj, "id", where), where)
    if not rid.startswith(_ID_PREFIX):
        raise GeckoTerminalFormatError(f"{where}: not a Solana pool (id {_show(rid)})")
    attrs = _obj(_get(obj, "attributes", where), f"{where}.attributes")
    a_where = f"{where}.attributes"
    address = _address(_str(_get(attrs, "address", a_where), a_where), f"{a_where}.address")
    if rid != _ID_PREFIX + address:
        raise GeckoTerminalFormatError(f"{where}: id {_show(rid)} doesn't match address {address}")
    rels = _obj(_get(obj, "relationships", where), f"{where}.relationships")
    linked: dict[str, str] = {}
    refs: set[tuple[str, str]] = set()
    for rel, rel_type in _RELATIONSHIPS:
        r_where = f"{where}.relationships.{rel}"
        relationship = _obj(_get(rels, rel, f"{where}.relationships"), r_where)
        target = _obj(_get(relationship, "data", r_where), f"{r_where}.data")
        if _get(target, "type", r_where) != rel_type:
            raise GeckoTerminalFormatError(f"{r_where}: expected type {rel_type!r}")
        target_id = _str(_get(target, "id", r_where), r_where)
        refs.add((rel_type, target_id))
        if rel_type == "dex":
            linked[rel] = _dex_id(target_id, r_where)
        elif target_id.startswith(_ID_PREFIX):
            linked[rel] = _address(target_id.removeprefix(_ID_PREFIX), r_where)
        else:
            raise GeckoTerminalFormatError(f"{r_where}: not a Solana token (id {_show(target_id)})")
    if linked["base_token"] == linked["quote_token"]:
        raise GeckoTerminalFormatError(f"{where}: base and quote are the same token")
    transactions = _obj(_get(attrs, "transactions", a_where), f"{a_where}.transactions")
    tx_m5 = _obj(_get(transactions, "m5", f"{a_where}.transactions"), f"{a_where}.transactions.m5")
    volume = _obj(_get(attrs, "volume_usd", a_where), f"{a_where}.volume_usd")
    pool = NewPool(
        pool_address=address,
        dex_id=linked["dex"],
        base_mint=linked["base_token"],
        quote_mint=linked["quote_token"],
        pool_created_at=_timestamp(_get(attrs, "pool_created_at", a_where), f"{a_where}.pool_created_at"),
        name=clean_text(_str(_get(attrs, "name", a_where), f"{a_where}.name")),
        base_symbol=_symbol(resources.get(("token", _ID_PREFIX + linked["base_token"])), where),
        price_usd=_decimal(_get(attrs, "base_token_price_usd", a_where), f"{a_where}.base_token_price_usd"),
        fdv_usd=_decimal(_get(attrs, "fdv_usd", a_where), f"{a_where}.fdv_usd"),
        reserve_usd=_decimal(_get(attrs, "reserve_in_usd", a_where), f"{a_where}.reserve_in_usd"),
        buys_m5=_count(_get(tx_m5, "buys", f"{a_where}.transactions.m5"), f"{a_where}.transactions.m5.buys"),
        sells_m5=_count(
            _get(tx_m5, "sells", f"{a_where}.transactions.m5"), f"{a_where}.transactions.m5.sells"
        ),
        volume_m5_usd=_decimal(_get(volume, "m5", f"{a_where}.volume_usd"), f"{a_where}.volume_usd.m5"),
        volume_h1_usd=_decimal(_get(volume, "h1", f"{a_where}.volume_usd"), f"{a_where}.volume_usd.h1"),
    )
    return pool, refs


def _symbol(token: Mapping[str, Any] | None, where: str) -> str | None:
    if token is None or token.get("symbol") is None:
        return None
    symbol = token["symbol"]
    if not isinstance(symbol, str):
        raise GeckoTerminalFormatError(f"{where}: base token symbol is {type(symbol).__name__}")
    return clean_text(symbol) or None


def _obj(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GeckoTerminalFormatError(f"{where}: expected an object, got {type(value).__name__}")
    return value


def _get(obj: Mapping[str, Any], key: str, where: str) -> Any:
    if key not in obj:
        raise GeckoTerminalFormatError(f"{where}: missing {key!r}")
    return obj[key]


def _str(value: Any, where: str) -> str:
    if not isinstance(value, str):
        raise GeckoTerminalFormatError(f"{where}: expected a string, got {type(value).__name__}")
    return value


def _address(text: str, where: str) -> str:
    """A base58 string that decodes to exactly 32 bytes (a Solana public key)."""
    if is_pubkey(text):
        return text
    raise GeckoTerminalFormatError(f"{where}: not a Solana address: {_show(text)}")


def _dex_id(text: str, where: str) -> str:
    if not _DEX_RE.fullmatch(text):
        raise GeckoTerminalFormatError(f"{where}: unexpected dex id {_show(text)}")
    return text


def _timestamp(value: Any, where: str) -> datetime:
    if not isinstance(value, str) or not _TIMESTAMP_RE.fullmatch(value):
        raise GeckoTerminalFormatError(f"{where}: expected an ISO 8601 UTC time, got {_show(value)}")
    try:
        return datetime.fromisoformat(value).astimezone(UTC)
    except ValueError as exc:
        raise GeckoTerminalFormatError(f"{where}: {exc}") from exc


def _decimal(value: Any, where: str) -> Decimal | None:
    """A non-negative decimal sent as a string, or null. JSON numbers are refused: they
    would arrive as floats, and the API has always sent strings."""
    if value is None:
        return None
    if not isinstance(value, str) or not _DECIMAL_RE.fullmatch(value):
        raise GeckoTerminalFormatError(f"{where}: expected a decimal string or null, got {_show(value)}")
    try:
        return Decimal(value)
    except InvalidOperation as exc:  # pragma: no cover - the pattern already guarantees it
        raise GeckoTerminalFormatError(f"{where}: {exc}") from exc


def _count(value: Any, where: str) -> int | None:
    if value is None:
        return None
    if type(value) is not int or value < 0:
        raise GeckoTerminalFormatError(f"{where}: expected a count >= 0 or null, got {_show(value)}")
    return value


def _show(value: Any) -> str:
    """A short, safe rendering of an untrusted value for error messages."""
    return clean_text(repr(value), 60)
