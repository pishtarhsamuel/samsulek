from __future__ import annotations

import socket
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, settings

from helpers import T0, UNIVERSE, make_risk_config
from samsulek.clock import FixedClock
from samsulek.logging_setup import DecisionLog
from samsulek.risk.engine import RiskEngine
from samsulek.risk.state import RiskStateStore

settings.register_profile(
    "default", deadline=None, max_examples=300, suppress_health_check=[HealthCheck.too_slow]
)
settings.load_profile("default")

# ---------------------------------------------------------------- no network in tests
# Tests use recorded real responses (tests/fixtures), never live sites: results must not
# depend on someone else's server, and a test must never hit a rate limit. Loopback stays
# allowed (Windows uses it internally, e.g. for socketpair).
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex
_real_getaddrinfo = socket.getaddrinfo


class NetworkBlockedError(RuntimeError):
    pass


def _check(sock: socket.socket, address: Any) -> None:
    if sock.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in _LOCAL_HOSTS:
        raise NetworkBlockedError(f"tests must not use the network (tried to connect to {address!r})")


def _guarded_connect(self: socket.socket, address: Any) -> None:
    _check(self, address)
    _real_connect(self, address)


def _guarded_connect_ex(self: socket.socket, address: Any) -> int:
    _check(self, address)
    return _real_connect_ex(self, address)


def _guarded_getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
    if host not in _LOCAL_HOSTS and host is not None:
        raise NetworkBlockedError(f"tests must not use the network (tried to look up {host!r})")
    return _real_getaddrinfo(host, *args, **kwargs)


_PROXY_VARS = ("http_proxy", "https_proxy", "all_proxy", "ftp_proxy")
_NO_PROXY_FOR_ANY_HOST = "*"


@pytest.fixture(autouse=True, scope="session")
def _no_network() -> Iterator[None]:
    with pytest.MonkeyPatch.context() as mp:
        # No proxies either: a local proxy would turn every connection into a "loopback" one.
        for name in _PROXY_VARS:
            mp.delenv(name, raising=False)
            mp.delenv(name.upper(), raising=False)
        mp.setenv("no_proxy", _NO_PROXY_FOR_ANY_HOST)
        mp.setenv("NO_PROXY", _NO_PROXY_FOR_ANY_HOST)
        mp.setattr(socket.socket, "connect", _guarded_connect)
        mp.setattr(socket.socket, "connect_ex", _guarded_connect_ex)
        mp.setattr(socket, "getaddrinfo", _guarded_getaddrinfo)
        yield


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock(T0)


@pytest.fixture
def state_dir(tmp_path: Path) -> Path:
    return tmp_path / "state"


@pytest.fixture
def store(state_dir: Path) -> RiskStateStore:
    return RiskStateStore(state_dir)


@pytest.fixture
def decision_log(tmp_path: Path, clock: FixedClock) -> DecisionLog:
    return DecisionLog(tmp_path / "logs", clock)


@pytest.fixture
def engine(store: RiskStateStore, clock: FixedClock, decision_log: DecisionLog) -> RiskEngine:
    return RiskEngine(make_risk_config(), store, clock, UNIVERSE, decision_log)
