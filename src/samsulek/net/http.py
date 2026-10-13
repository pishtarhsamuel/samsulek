"""A small, defensive HTTPS client on the standard library (no extra dependency).

Rules:
- HTTPS only, and only to hosts the caller allowed: a data source can't be steered to
  an arbitrary URL by a response it parsed.
- Every request has a timeout and a response size cap.
- Each host has its own rate limiter, set BELOW the provider's documented limit.
- Redirects are never followed (they could lead off the allow-list or to plain http).
- Retries only what is safe to retry: timeouts, connection errors (also a connection
  that drops mid-response, or a body shorter than its Content-Length), 429 and 5xx. A
  ``Retry-After`` header is honoured; one longer than ``max_retry_after`` raises at once
  (carrying the wait, capped at a day) instead of stalling the caller, and never leaves
  the rate limiter blocked for longer than ``max_retry_after``.
- Other 4xx answers are not retried: they mean our request is wrong.
- Errors never include response bodies longer than a short excerpt (they may be HTML
  pages), never include request headers (they may one day carry credentials), never
  include a URL's path or query (they can carry API keys), and contain printable ASCII
  only (a provider's text must not drive the owner's terminal).
"""

from __future__ import annotations

import email.utils
import gzip
import http.client
import io
import json
import logging
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

log = logging.getLogger(__name__)

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
DEFAULT_MAX_BYTES = 20 * 1024 * 1024
MAX_RETRY_AFTER_SECONDS = 86_400.0  # a longer Retry-After counts as a day
MAX_PENALTY_SECONDS = 3_600.0  # no header can block a rate limiter for longer
ERROR_BODY_BYTES = 2048


class HttpError(RuntimeError):
    """A request failed for good (after any retries). ``status`` is None for network errors."""

    def __init__(self, message: str, *, url: str, status: int | None = None, body: str = "") -> None:
        super().__init__(message)
        self.url = redact_url(url)  # scheme and host only: paths and queries can carry API keys
        self.status = status
        self.body = body  # first 2 KB of an error response, for callers that must read it


class RateLimitedError(HttpError):
    """The provider said "slow down" for longer than we are willing to wait.
    ``retry_after``: the wait it asked for in seconds (capped at a day), if it said."""

    def __init__(
        self,
        message: str,
        *,
        url: str,
        status: int | None = None,
        body: str = "",
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message, url=url, status=status, body=body)
        self.retry_after = retry_after


@dataclass(frozen=True, slots=True)
class Response:
    url: str
    status: int
    headers: Mapping[str, str]  # lower-case names
    body: bytes
    received_at: datetime  # UTC, when the response arrived (point-in-time "known at")

    def text(self, encoding: str = "utf-8") -> str:
        return self.body.decode(encoding)

    def json(self) -> Any:
        try:
            return json.loads(self.body)
        except ValueError as exc:
            raise HttpError(f"response is not valid JSON: {exc}", url=self.url, status=self.status) from exc


class _RawResponse(Protocol):
    status: int

    def getheaders(self) -> list[tuple[str, str]]: ...

    def read(self, amt: int | None = ...) -> bytes: ...

    def close(self) -> None: ...


Opener = Callable[[urllib.request.Request, float], _RawResponse]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects silently: they could lead off the allow-list or to plain http."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None  # urllib then raises HTTPError with the 3xx status


def _default_opener(request: urllib.request.Request, timeout: float) -> _RawResponse:
    # Built per request so current proxy settings (environment / Windows settings) apply.
    return urllib.request.build_opener(_NoRedirect).open(request, timeout=timeout)  # type: ignore[no-any-return]


class RateLimiter:
    """Token bucket: at most ``rate`` requests per ``per_seconds``, with bursts up to ``burst``."""

    def __init__(
        self,
        rate: float,
        per_seconds: float,
        burst: int = 1,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if rate <= 0 or per_seconds <= 0 or burst < 1:
            raise ValueError("rate, per_seconds and burst must be positive")
        self._interval = per_seconds / rate  # seconds per token
        self._burst = float(burst)
        self._tokens = float(burst)
        self._monotonic = monotonic
        self._sleep = sleep
        self._last = monotonic()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        with self._lock:
            while True:
                now = self._monotonic()
                self._tokens = min(self._burst, self._tokens + (now - self._last) / self._interval)
                self._last = now
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                self._sleep((1 - self._tokens) * self._interval)

    def penalize(self, seconds: float) -> None:
        """After a 429: empty the bucket so the next request waits at least ``seconds``
        (never more than MAX_PENALTY_SECONDS, whatever a server asked for)."""
        seconds = min(max(seconds, 0.0), MAX_PENALTY_SECONDS)
        with self._lock:
            self._tokens = min(self._tokens, 0.0) - seconds / self._interval


@dataclass
class HttpClient:
    user_agent: str
    allowed_hosts: frozenset[str]
    limiters: Mapping[str, RateLimiter] = field(default_factory=dict)
    timeout: float = 20.0
    max_bytes: int = DEFAULT_MAX_BYTES
    retries: int = 3
    backoff_seconds: float = 2.0
    max_retry_after: float = 120.0
    opener: Opener = _default_opener
    sleep: Callable[[float], None] = time.sleep
    now: Callable[[], datetime] = lambda: datetime.now(UTC)

    def __post_init__(self) -> None:
        if not self.user_agent.strip():
            raise ValueError("a descriptive User-Agent is required")
        missing = set(self.limiters) - set(self.allowed_hosts)
        if missing:
            raise ValueError(f"rate limiters for hosts that are not allowed: {sorted(missing)}")

    # ------------------------------------------------------------------ public
    def get(
        self,
        url: str,
        params: Mapping[str, str | int] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Response:
        if params:
            url = f"{url}{'&' if '?' in url else '?'}{urllib.parse.urlencode(params)}"
        return self._request("GET", url, None, headers or {})

    def post_json(self, url: str, payload: object, headers: Mapping[str, str] | None = None) -> Response:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return self._request("POST", url, body, {"Content-Type": "application/json", **(headers or {})})

    # ---------------------------------------------------------------- internals
    def _check_url(self, url: str) -> str:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https":
            raise HttpError("only https URLs are allowed", url=url)
        host = (parts.hostname or "").lower()
        if host not in self.allowed_hosts:
            raise HttpError(f"host {host!r} is not on this client's allow-list", url=url)
        if parts.username or parts.password:
            raise HttpError("credentials in URLs are not allowed", url=url)
        return host

    def _request(self, method: str, url: str, body: bytes | None, headers: Mapping[str, str]) -> Response:
        host = self._check_url(url)
        limiter = self.limiters.get(host)
        attempt = 0
        while True:
            attempt += 1
            if limiter is not None:
                limiter.acquire()
            request = urllib.request.Request(url, data=body, method=method)  # noqa: S310 (https checked)
            request.add_header("User-Agent", self.user_agent)
            request.add_header("Accept-Encoding", "gzip")
            for name, value in headers.items():
                request.add_header(name, value)
            try:
                response = self._send(request, url)
            except _Retryable as exc:
                # Never retry faster than our own backoff: some servers send "Retry-After: 0".
                wait = max(exc.retry_after or 0.0, self._backoff(attempt))
                if wait > self.max_retry_after:
                    # Refuse before touching the limiter: a long wait must not block the
                    # next call (and with it a single-threaded caller) for that long.
                    raise RateLimitedError(
                        f"{exc}; server asked to wait {wait:.0f}s, more than {self.max_retry_after:.0f}s",
                        url=url,
                        status=exc.status,
                        retry_after=wait,
                    ) from exc
                if exc.status == 429 and limiter is not None:
                    limiter.penalize(wait)
                if attempt > self.retries:
                    if exc.status == 429:
                        raise RateLimitedError(
                            f"{exc} (gave up after {attempt} attempts)",
                            url=url,
                            status=exc.status,
                            retry_after=wait,
                        ) from exc
                    raise HttpError(
                        f"{exc} (gave up after {attempt} attempts)", url=url, status=exc.status
                    ) from exc
                log.info("retrying %s %s in %.1fs: %s", method, redact_url(url), wait, exc)
                self.sleep(wait)
                continue
            return response

    def _backoff(self, attempt: int) -> float:
        return float(self.backoff_seconds * (2 ** (attempt - 1)))

    def _send(self, request: urllib.request.Request, url: str) -> Response:
        try:
            raw = self.opener(request, self.timeout)
        except urllib.error.HTTPError as exc:
            status = exc.code
            raw_body = _error_body(exc)
            excerpt = _excerpt(raw_body)
            retry_after = _retry_after(exc.headers.get("Retry-After") if exc.headers else None, self.now())
            exc.close()
            if status in RETRY_STATUSES:
                raise _Retryable(f"HTTP {status}", status=status, retry_after=retry_after) from exc
            if 300 <= status < 400:
                where = exc.headers.get("Location", "") if exc.headers else ""
                target = _clean(redact_url(where), 100) if where else "?"
                raise HttpError(
                    f"HTTP {status} redirect to {target} not followed", url=url, status=status
                ) from exc
            raise HttpError(
                f"HTTP {status}: {excerpt}",
                url=url,
                status=status,
                body=raw_body.decode("utf-8", "replace"),
            ) from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, ssl.SSLCertVerificationError):
                raise HttpError(f"TLS certificate check failed: {exc.reason}", url=url) from exc
            raise _Retryable(f"network error: {exc.reason}", status=None) from exc
        except (TimeoutError, ConnectionError, OSError) as exc:
            raise _Retryable(f"network error: {type(exc).__name__}: {exc}", status=None) from exc
        try:
            headers = {k.lower(): v for k, v in raw.getheaders()}
            data = raw.read(self.max_bytes + 1)
            if len(data) > self.max_bytes:
                raise HttpError(f"response larger than {self.max_bytes} bytes", url=url, status=raw.status)
            declared = headers.get("content-length", "")
            if declared.isascii() and declared.isdigit() and len(data) < int(declared):
                # http.client returns a short read without complaint when the server
                # closes early: a cut-off body must never be taken for the whole answer.
                raise _Retryable(
                    f"network error: response cut short ({len(data)} of {declared} bytes)", status=None
                )
            if headers.get("content-encoding", "").lower() == "gzip":
                data = _gunzip(data, self.max_bytes, url)
            return Response(url=url, status=raw.status, headers=headers, body=data, received_at=self.now())
        except (TimeoutError, OSError, http.client.HTTPException) as exc:
            # A connection dropped mid-body (IncompleteRead, a TLS error while reading,
            # a reset): the same kind of failure as one before the answer, so retryable.
            raise _Retryable(
                f"network error while reading: {type(exc).__name__}: {_clean(str(exc), 200)}", status=None
            ) from exc
        finally:
            raw.close()


class _Retryable(Exception):
    def __init__(self, message: str, *, status: int | None, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def _retry_after(value: str | None, now: datetime) -> float | None:
    """Seconds to wait from a Retry-After header (seconds or an HTTP date); None if absent/invalid."""
    if not value:
        return None
    value = value.strip()
    if value.isascii() and value.isdigit():  # some non-ASCII digits pass isdigit() but not float()
        return min(float(value), MAX_RETRY_AFTER_SECONDS)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if when.tzinfo is None:
        return None
    return min(max(0.0, (when - now).total_seconds()), MAX_RETRY_AFTER_SECONDS)


def _gunzip(data: bytes, max_bytes: int, url: str) -> bytes:
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as fh:
            out = fh.read(max_bytes + 1)
    except (OSError, EOFError) as exc:
        raise HttpError(f"bad gzip response: {exc}", url=url) from exc
    if len(out) > max_bytes:
        raise HttpError(f"decompressed response larger than {max_bytes} bytes", url=url)
    return out


def _error_body(exc: urllib.error.HTTPError) -> bytes:
    """The first bytes of an error answer, decompressed if gzip; never raises."""
    if getattr(exc, "fp", None) is None:  # typeshed says never None; urllib says otherwise
        return b""
    try:
        raw = exc.read(ERROR_BODY_BYTES)
    except (OSError, http.client.HTTPException):
        return b""
    encoding = exc.headers.get("Content-Encoding", "") if exc.headers else ""
    if encoding.lower() == "gzip":
        try:  # tolerates a cut-off stream: only the start of it was read
            return zlib.decompressobj(31).decompress(raw, ERROR_BODY_BYTES)
        except zlib.error:
            return b""
    return raw


def _clean(text: str, limit: int) -> str:
    """Printable ASCII only (anything else becomes "?"), whitespace runs as one space,
    at most ``limit`` characters: provider text must not reach a terminal raw."""
    flat = " ".join(text.split())
    out = "".join(ch if " " <= ch <= "~" else "?" for ch in flat)
    return out[:limit] + ("..." if len(out) > limit else "")


def _excerpt(body: bytes, limit: int = 200) -> str:
    return _clean(body.decode("utf-8", "replace"), limit)


def redact_url(url: str) -> str:
    """``https://host[:port]`` only. RPC providers put API keys in the path or the query
    string, so neither may reach a log line or an error message."""
    try:
        parts = urllib.parse.urlsplit(url)
        netloc = parts.hostname or ""
        if parts.port:
            netloc += f":{parts.port}"
    except ValueError:
        return "<unparseable url>"
    return f"{parts.scheme}://{netloc}"
