from __future__ import annotations

from pathlib import Path

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
