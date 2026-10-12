"""The shared HTTPS client: allow-list, retries, rate limits, size caps. No real network."""

from __future__ import annotations

import gzip
import http.client
import io
import json
import socket
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest

from samsulek.net.http import HttpClient, HttpError, RateLimitedError, RateLimiter

NOW = datetime(2026, 10, 12, 18, 0, tzinfo=UTC)
HOST = "api.example.org"
URL = f"https://{HOST}/v1/thing"


@dataclass
class FakeRaw:
    status: int = 200
    body: bytes = b"{}"
    headers: list[tuple[str, str]] = field(default_factory=list)
    url: str = URL
    closed: bool = False

    def getheaders(self) -> list[tuple[str, str]]:
        return self.headers

    def read(self, amt: int | None = None) -> bytes:
        return self.body if amt is None else self.body[:amt]

    def close(self) -> None:
        self.closed = True


def http_error(code: int, body: bytes = b"", headers: dict[str, str] | None = None) -> urllib.error.HTTPError:
    msg = http.client.HTTPMessage()
    for k, v in (headers or {}).items():
        msg[k] = v
    return urllib.error.HTTPError(URL, code, "error", msg, io.BytesIO(body))


class Script:
    """An opener that plays back a list of outcomes and records the requests it saw."""

    def __init__(self, *outcomes: object) -> None:
        self.outcomes = list(outcomes)
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> FakeRaw:
        self.requests.append(request)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        assert isinstance(outcome, FakeRaw)
        return outcome


def client(script: Script, sleeps: list[float], **kw: object) -> HttpClient:
    return HttpClient(
        user_agent="samsulek-test/0",
        allowed_hosts=frozenset({HOST}),
        opener=script,
        sleep=sleeps.append,
        now=lambda: NOW,
        **kw,  # type: ignore[arg-type]
    )


def test_only_https_to_allowed_hosts_without_credentials() -> None:
    c = client(Script(), [])
    for bad in [
        f"http://{HOST}/x",
        "https://evil.example.com/x",
        f"https://user:pw@{HOST}/x",
        "file:///etc/passwd",
    ]:
        with pytest.raises(HttpError):
            c.get(bad)
    with pytest.raises(HttpError) as err:
        c.get(f"https://user:secretpw@{HOST}/x")
    assert "secretpw" not in str(err.value) and "secretpw" not in err.value.url


def test_success_returns_body_headers_and_arrival_time() -> None:
    script = Script(FakeRaw(body=b'{"a": 1}', headers=[("Content-Type", "application/json")]))
    r = client(script, []).get(URL, params={"page": 2, "q": "a b"}, headers={"Accept": "application/json"})
    assert r.json() == {"a": 1}
    assert r.headers["content-type"] == "application/json"
    assert r.received_at == NOW
    sent = script.requests[0]
    assert sent.full_url == URL + "?page=2&q=a+b"
    assert sent.get_header("User-agent") == "samsulek-test/0"
    assert sent.get_header("Accept") == "application/json"


def test_server_errors_are_retried_with_backoff() -> None:
    sleeps: list[float] = []
    script = Script(http_error(503), http_error(502), FakeRaw(body=b"ok"))
    assert client(script, sleeps).get(URL).body == b"ok"
    assert sleeps == [2.0, 4.0]


def test_retry_after_is_honoured_and_too_long_waits_raise() -> None:
    sleeps: list[float] = []
    script = Script(http_error(429, headers={"Retry-After": "7"}), FakeRaw())
    client(script, sleeps).get(URL)
    assert sleeps == [7.0]
    with pytest.raises(RateLimitedError, match="more than"):
        client(Script(http_error(429, headers={"Retry-After": "3600"})), []).get(URL)
    http_date = "Mon, 12 Oct 2026 18:00:30 GMT"  # 30 s after NOW
    sleeps2: list[float] = []
    client(Script(http_error(503, headers={"Retry-After": http_date}), FakeRaw()), sleeps2).get(URL)
    assert sleeps2 == [30.0]


def test_gives_up_after_the_retry_budget() -> None:
    script = Script(*[http_error(429) for _ in range(4)])
    with pytest.raises(RateLimitedError, match="gave up after 4 attempts") as err:
        client(script, []).get(URL)
    assert err.value.status == 429
    net = Script(*[urllib.error.URLError(ConnectionResetError("reset")) for _ in range(4)])
    with pytest.raises(HttpError, match="network error") as err2:
        client(net, []).get(URL)
    assert err2.value.status is None and len(net.requests) == 4


def test_client_errors_redirects_and_bad_certificates_are_not_retried() -> None:
    for outcome, pattern in [
        (http_error(404, b"<html>not found</html>"), "HTTP 404"),
        (http_error(302, headers={"Location": "http://elsewhere.example/"}), "redirect .* not followed"),
        (urllib.error.URLError(ssl.SSLCertVerificationError("bad cert")), "certificate"),
    ]:
        script = Script(outcome, FakeRaw())
        with pytest.raises(HttpError, match=pattern):
            client(script, []).get(URL)
        assert len(script.requests) == 1


def test_size_cap_and_gzip() -> None:
    with pytest.raises(HttpError, match="larger than"):
        client(Script(FakeRaw(body=b"x" * 101)), [], max_bytes=100).get(URL)
    packed = gzip.compress(b'{"ok": true}')
    r = client(Script(FakeRaw(body=packed, headers=[("Content-Encoding", "gzip")])), []).get(URL)
    assert r.json() == {"ok": True}
    bomb = gzip.compress(b"0" * 10_000)
    with pytest.raises(HttpError, match="decompressed"):
        client(Script(FakeRaw(body=bomb, headers=[("Content-Encoding", "gzip")])), [], max_bytes=1000).get(
            URL
        )


def test_post_json_and_bad_json() -> None:
    script = Script(FakeRaw(body=b"not json"))
    r = client(script, []).post_json(URL, {"jsonrpc": "2.0", "id": 1, "method": "getSlot"})
    sent = script.requests[0]
    assert sent.get_method() == "POST"
    assert json.loads(sent.data) == {"jsonrpc": "2.0", "id": 1, "method": "getSlot"}  # type: ignore[arg-type]
    assert sent.get_header("Content-type") == "application/json"
    with pytest.raises(HttpError, match="not valid JSON"):
        r.json()


def test_rate_limiter_spaces_requests_and_penalizes_after_429() -> None:
    t = [0.0]
    slept: list[float] = []

    def sleep(s: float) -> None:
        slept.append(round(s, 6))
        t[0] += s

    limiter = RateLimiter(2, 1.0, burst=1, monotonic=lambda: t[0], sleep=sleep)
    limiter.acquire()
    limiter.acquire()
    assert slept == [0.5]
    limiter.penalize(3.0)
    limiter.acquire()
    assert sum(slept[1:]) == pytest.approx(3.5)


def test_limiters_must_be_for_allowed_hosts() -> None:
    with pytest.raises(ValueError, match="not allowed"):
        HttpClient(
            user_agent="x", allowed_hosts=frozenset({HOST}), limiters={"other.example": RateLimiter(1, 1)}
        )


def test_the_test_suite_cannot_reach_the_internet() -> None:
    with pytest.raises(RuntimeError, match="must not use the network"):
        socket.create_connection(("example.com", 443), timeout=1)
    with pytest.raises(RuntimeError, match="must not use the network"):
        urllib.request.urlopen("https://example.com/", timeout=1)
