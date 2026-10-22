"""P3: the in-memory parts behave exactly like the bot's disk parts, and touch no file.

Hypothesis state machines drive ``RiskStateStore`` on a temporary folder and
``MemoryRiskStateStore`` side by side (and ``Ledger`` against ``MemoryLedger``) with the
same random operations, damaged contents included: every return value (by ``repr``) and
every exception type must match, and so must the stored texts and the audit history.
``MemoryDecisionLog`` keeps the same records as ``DecisionLog`` (after the JSON round trip
the disk file applies), and ``RecordingAlerter`` the same alerts as ``ConsoleAlerter``,
without printing. The memory classes create nothing, and any write that reaches their
``_NOWHERE`` path (under the module's own file) raises ``OSError`` instead of creating a
file (spec C21 as amended by A8).
"""

from __future__ import annotations

import dataclasses
import gzip
import json
import logging
import shutil
import tempfile
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule

from samsulek.alerts import ConsoleAlerter
from samsulek.backtest import inmemory
from samsulek.backtest.inmemory import (
    _NOWHERE,
    MemoryDecisionLog,
    MemoryLedger,
    MemoryRiskStateStore,
    RecordingAlerter,
)
from samsulek.clock import FixedClock
from samsulek.logging_setup import DecisionLog
from samsulek.portfolio.ledger import Ledger
from samsulek.risk.state import DayState, RiskStateStore, StateCorruptError
from samsulek.types import (
    AccountSnapshot,
    BrokerOrder,
    Fill,
    Market,
    OrderRequest,
    OrderStatus,
    OrderType,
    Position,
    Side,
)

T0 = datetime(2026, 10, 12, 8, 0, tzinfo=UTC)
FILE_NAMES = ("halt.json", "kill.json", "risk_day.json", "equity_peak.json")


def outcome(fn: Callable[[], Any]) -> str:
    try:
        return "ok " + repr(fn())
    except Exception as exc:  # the type must match; messages may name a different place
        return f"raised {type(exc).__name__}"


# ============================================================ risk store
reasons = st.sampled_from(["daily loss 3.10%", "drawdown 15%", "API_KEY=abcdef1234567890 leaked", "x"])
times = st.integers(0, 10_000).map(lambda m: T0 + timedelta(minutes=m))
decimals = st.one_of(
    st.decimals(min_value=-5, max_value=500, places=4),
    st.sampled_from([Decimal("NaN"), Decimal("Infinity"), Decimal(0)]),
)
damage = st.sampled_from(
    [
        "",
        "{",
        "[]",
        "null",
        '"text"',
        '{"active": "yes"}',
        '{"active": true, "reasons": "x"}',
        '{"active": true, "reasons": ["a"], "since": "not a date"}',
        '{"peak_equity": []}',
        '{"peak_equity": "-1"}',
        '{"day": "2026-10-12", "day_start_equity": "1", "last_equity": "1", "trades": {"total": -1}}',
        '{"day": "2026-13-12", "day_start_equity": "1", "last_equity": "1", "trades": {}}',
        '{"active": false, "reasons": [], "since": null}',
    ]
)


class StoreMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.tmp = Path(tempfile.mkdtemp(prefix="samsulek-p3-"))
        self.disk = RiskStateStore(self.tmp / "store")
        self.mem = MemoryRiskStateStore()

    def both(self, call: Callable[[RiskStateStore], Any]) -> None:
        a, b = outcome(lambda: call(self.disk)), outcome(lambda: call(self.mem))
        assert a == b

    @rule(reason=reasons, ts=times, which=st.sampled_from(["halt", "kill"]))
    def set_flag(self, reason: str, ts: datetime, which: str) -> None:
        self.both(lambda s: getattr(s, f"set_{which}")(reason, ts))

    @rule(
        ts=times,
        which=st.sampled_from(["halt", "kill"]),
        by=st.sampled_from(["owner", "backtest", "owner API_KEY=abcdef1234567890"]),  # history redacts `by`
    )
    def clear_flag(self, ts: datetime, which: str, by: str) -> None:
        self.both(lambda s: getattr(s, f"clear_{which}")(ts, by))

    @rule(
        day=st.dates(min_value=date(2026, 1, 1), max_value=date(2026, 12, 31)),
        start=decimals,
        last=decimals,
        trades=st.dictionaries(st.sampled_from(["total", "stocks"]), st.integers(0, 9), max_size=2),
    )
    def write_day(self, day: date, start: Decimal, last: Decimal, trades: dict[str, int]) -> None:
        self.both(lambda s: s.write_day(DayState(day, start, last, dict(trades))))

    @rule(peak=decimals)
    def write_peak(self, peak: Decimal) -> None:
        self.both(lambda s: s.write_peak(peak))

    @rule(name=st.sampled_from(FILE_NAMES), text=damage)
    def damage_a_file(self, name: str, text: str) -> None:
        (self.disk.dir / name).write_text(text, encoding="utf-8")
        self.mem.files[name] = text

    @invariant()
    def reads_agree(self) -> None:
        for read in (RiskStateStore.read_halt, RiskStateStore.read_kill, RiskStateStore.read_day):
            self.both(read)
        self.both(RiskStateStore.read_peak)

    @invariant()
    def stored_texts_and_history_agree(self) -> None:
        on_disk = {
            p.name: p.read_text(encoding="utf-8") for p in self.disk.dir.iterdir() if p.suffix == ".json"
        }
        assert on_disk == self.mem.files
        history = self.disk.dir / "state_history.jsonl"
        lines = history.read_text(encoding="utf-8").splitlines() if history.exists() else []
        assert [json.loads(line) for line in lines] == self.mem.history

    def teardown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


TestStoreParity = StoreMachine.TestCase
TestStoreParity.settings = settings(max_examples=60, stateful_step_count=25, deadline=None)


def test_memory_store_damage_raises_state_corrupt_error() -> None:
    mem = MemoryRiskStateStore()
    mem.files["halt.json"] = "{"
    with pytest.raises(StateCorruptError, match=r"in-memory halt\.json is not valid JSON"):
        mem.read_halt()
    mem.files["equity_peak.json"] = "[1]"
    with pytest.raises(StateCorruptError, match="must contain a JSON object"):
        mem.read_peak()


# ============================================================ ledger
def _fill(fid: str, cid: str, side: Side, qty: Decimal, price: Decimal, fee: Decimal) -> Fill:
    return Fill(fid, cid, Market.STOCKS, "AAA", side, qty, price, fee, T0)


quantities = st.decimals(min_value=Decimal("0.001"), max_value=Decimal(5), places=3)


class LedgerMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.tmp = Path(tempfile.mkdtemp(prefix="samsulek-p3-"))
        self.disk = Ledger(self.tmp)
        self.mem = MemoryLedger()
        self.n = 0

    def both(self, call: Callable[[Ledger], Any]) -> None:
        a, b = outcome(lambda: call(self.disk)), outcome(lambda: call(self.mem))
        assert a == b

    @rule(
        cash=st.decimals(min_value=0, max_value=100, places=2),
        held=st.sampled_from([None, "1.5"]),
        busy=st.booleans(),
    )
    def initialize(self, cash: Decimal, held: str | None, busy: bool) -> None:
        positions = {"AAA": Position("AAA", Market.STOCKS, Decimal(held), Decimal(10))} if held else {}
        req = OrderRequest("open-1", Market.STOCKS, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(1))
        opened = (BrokerOrder("SIM-1", req, OrderStatus.OPEN, Decimal(0), T0),) if busy else ()
        snap = AccountSnapshot(cash, positions, opened, T0)
        self.both(lambda led: led.initialize_from(snap, "F-0"))

    @rule(cid=st.sampled_from(["c1", "c2", "c3"]), side=st.sampled_from(Side), qty=quantities)
    def remember(self, cid: str, side: Side, qty: Decimal) -> None:
        req = OrderRequest(cid, Market.STOCKS, "AAA", side, qty, OrderType.LIMIT, Decimal(1))
        self.both(lambda led: led.remember_order(req))

    @rule(
        cid=st.sampled_from(["c1", "c2", "c3", "never-sent"]),
        side=st.sampled_from(Side),
        qty=quantities,
        price=st.decimals(min_value=Decimal("0.5"), max_value=Decimal(50), places=2),
        fee=st.sampled_from([Decimal(0), Decimal("0.1")]),
    )
    def apply_fill(self, cid: str, side: Side, qty: Decimal, price: Decimal, fee: Decimal) -> None:
        self.n += 1
        f = _fill(f"F-{self.n}", cid, side, qty, price, fee)
        self.both(lambda led: led.apply_fills([f]))

    @invariant()
    def views_agree(self) -> None:
        self.both(lambda led: led.snapshot(T0))
        self.both(lambda led: led.save())
        fields = ("initialized", "cash", "positions", "last_fill_id", "known_client_ids", "ordered", "filled")
        assert [repr(getattr(self.disk, f)) for f in fields] == [repr(getattr(self.mem, f)) for f in fields]

    def teardown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


TestLedgerParity = LedgerMachine.TestCase
TestLedgerParity.settings = settings(max_examples=60, stateful_step_count=25, deadline=None)


def test_an_unreadable_memory_ledger_fails_like_the_disk_one(tmp_path: Path) -> None:
    disk = Ledger.unreadable(tmp_path, "planted damage")
    mem = MemoryLedger.unreadable(_NOWHERE, "planted damage")
    assert isinstance(mem, MemoryLedger)
    snap = AccountSnapshot(Decimal(1), {}, (), T0)
    for call in (
        lambda led: led.save(),
        lambda led: led.snapshot(T0),
        lambda led: led.initialize_from(snap, None),
        lambda led: led.apply_fills([]),
    ):
        assert outcome(lambda c=call: c(disk)) == outcome(lambda c=call: c(mem)) == "raised LedgerError"


# ============================================================ decision log
class Colour(StrEnum):
    RED = "red"


@dataclasses.dataclass(frozen=True)
class Thing:
    name: str
    amount: Decimal


leaves = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(-(10**20), 10**20),
    st.floats(allow_nan=False),
    st.text(max_size=12),
    st.sampled_from(["API_KEY=abcdef1234567890", "euro €", "Athens Αθήνα"]),
    st.decimals(allow_nan=False, allow_infinity=False, places=4),
    st.sampled_from([Colour.RED, date(2026, 10, 12), T0, Thing("x", Decimal("1.5")), Path("data") / "x"]),
)
values = st.recursive(
    leaves,
    lambda inner: st.one_of(
        st.lists(inner, max_size=3),
        st.lists(inner, max_size=3).map(tuple),
        st.dictionaries(st.text(max_size=5), inner, max_size=3),
    ),
    max_leaves=8,
)
records = st.lists(
    st.tuples(
        st.integers(0, 600),  # minutes after the previous record: crosses midnight sometimes
        st.sampled_from(["cycle_start", "targets", "risk_decision", "alert"]),
        st.dictionaries(
            st.one_of(st.just("ts"), st.from_regex(r"[a-z]{1,8}", fullmatch=True)).filter(
                lambda k: k != "kind"  # write()'s own parameter; a "ts" field overwrites the stamp
            ),
            values,
            max_size=4,
        ),
    ),
    max_size=12,
)


@settings(max_examples=150)
@given(stream=records)
def test_memory_log_records_equal_the_disk_log_records(stream: list[tuple[int, str, dict[str, Any]]]) -> None:
    clock = FixedClock(T0)
    with tempfile.TemporaryDirectory() as tmp:
        disk = DecisionLog(Path(tmp) / "logs", clock)
        mem = MemoryDecisionLog(clock, keep_all=True)
        written: list[dict[str, Any]] = []
        days: set[date] = set()
        for minutes, kind, fields in stream:
            clock.advance(timedelta(minutes=minutes))
            days.add(clock.now().date())
            a = disk.write(kind, **fields)
            b = mem.write(kind, **fields)
            assert a == b
            written.append(b)
        assert mem.drain_cycle() == written
        assert mem.drain_cycle() == []  # drained
        for day in days | {date(2020, 1, 1)}:
            assert disk.read_day(day) == mem.read_day(day)
        on_disk = sorted(Path(tmp, "logs").glob("*.jsonl"))
        disk_lines = [line for p in on_disk for line in p.read_text(encoding="utf-8").splitlines()]
        gz = mem.gz_bytes()
        assert gz is not None
        assert gzip.decompress(gz).decode("ascii").splitlines() == disk_lines


def test_read_day_returns_copies() -> None:
    clock = FixedClock(T0)
    mem = MemoryDecisionLog(clock, keep_all=True)
    mem.write("targets", weights={"AAA": 0.3})
    got = mem.read_day(T0.date())
    got[0]["weights"]["AAA"] = 99
    assert mem.read_day(T0.date())[0]["weights"] == {"AAA": 0.3}


def test_editing_a_drained_record_changes_nothing_kept() -> None:
    # The disk file cannot be edited through a record a caller holds; neither can the memory log.
    clock = FixedClock(T0)
    mem = MemoryDecisionLog(clock, keep_all=True)
    mem.write("targets", weights={"AAA": 0.3})
    gz_before = mem.gz_bytes()
    (drained,) = mem.drain_cycle()
    drained["weights"]["AAA"] = 99
    drained["kind"] = "edited"
    assert mem.read_day(T0.date()) == [{"ts": T0.isoformat(), "kind": "targets", "weights": {"AAA": 0.3}}]
    assert mem.gz_bytes() == gz_before


def test_a_value_the_disk_log_cannot_write_fails_in_memory_too(tmp_path: Path) -> None:
    clock = FixedClock(T0)
    disk = DecisionLog(tmp_path, clock)
    for mem in (MemoryDecisionLog(clock, keep_all=True), MemoryDecisionLog(clock, keep_all=False)):
        with pytest.raises(TypeError):
            disk.write("x", thing=object())
        with pytest.raises(TypeError):
            mem.write("x", thing=object())
        assert mem.drain_cycle() == []  # nothing half-recorded
        assert mem.all_records == []


def test_keep_all_false_keeps_only_the_cycle() -> None:
    clock = FixedClock(T0)
    mem = MemoryDecisionLog(clock, keep_all=False)
    record = mem.write("cycle_start", n=1)
    assert record == {"ts": T0.isoformat(), "kind": "cycle_start", "n": 1}
    assert mem.all_records == []
    assert mem.gz_bytes() is None
    with pytest.raises(RuntimeError, match="keep_all=False"):
        mem.read_day(T0.date())
    assert mem.drain_cycle() == [record]
    assert mem.drain_cycle() == []


def test_gz_bytes_are_deterministic() -> None:
    def run() -> bytes:
        clock = FixedClock(T0)
        mem = MemoryDecisionLog(clock, keep_all=True)
        for i in range(5):
            clock.advance(timedelta(hours=7))
            mem.write("fill", i=i, price=Decimal("10.01"), note="euro €")
        gz = mem.gz_bytes()
        assert gz is not None
        return gz

    first = run()
    assert first == run()
    assert first[4:8] == b"\x00\x00\x00\x00"  # gzip mtime field: 0, not the wall clock
    assert gzip.decompress(first).isascii()


# ============================================================ alerts
def test_recording_alerter_matches_console_alerter_without_output(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    clock = FixedClock(T0)
    disk_log = DecisionLog(tmp_path, clock)
    console = ConsoleAlerter(disk_log)
    mem_log = MemoryDecisionLog(clock, keep_all=True)
    recording = RecordingAlerter(mem_log)
    alerts = [
        ("critical", "HALTED: daily loss 3.10%", "API_KEY=abcdef1234567890"),
        ("warning", "Stale or missing data", ""),
        ("info", "token=supersecretvalue1234 in a title", "body\nline two"),
    ]
    for level, title, body in alerts:
        console.alert(level, title, body)
    caplog.clear()
    capsys.readouterr()
    with caplog.at_level(logging.DEBUG):
        for level, title, body in alerts:
            recording.alert(level, title, body)
    assert caplog.records == []
    assert capsys.readouterr() == ("", "")
    assert recording.sent == console.sent
    assert "abcdef1234567890" not in repr(recording.sent)
    assert mem_log.read_day(T0.date()) == disk_log.read_day(T0.date())
    assert [r["kind"] for r in mem_log.drain_cycle()] == ["alert"] * 3


def test_an_alert_that_cannot_be_recorded_raises() -> None:
    class BrokenClock:
        def now(self) -> datetime:
            raise RuntimeError("clock gone")

    recording = RecordingAlerter(MemoryDecisionLog(BrokenClock(), keep_all=False))
    with pytest.raises(RuntimeError, match="clock gone"):
        recording.alert("critical", "HALTED", "")


# ============================================================ nothing touches the disk
def test_every_memory_part_is_marked_in_memory() -> None:
    assert MemoryRiskStateStore.in_memory is True
    assert MemoryLedger.in_memory is True
    assert MemoryDecisionLog.in_memory is True
    assert RecordingAlerter.in_memory is True
    assert getattr(RiskStateStore, "in_memory", False) is False
    assert getattr(Ledger, "in_memory", False) is False
    assert getattr(DecisionLog, "in_memory", False) is False


def test_the_memory_parts_create_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    clock = FixedClock(T0)
    store = MemoryRiskStateStore()
    store.set_halt("daily loss", T0)
    store.clear_halt(T0, "backtest")
    store.write_day(DayState(T0.date(), Decimal(50), Decimal(49), {"total": 1}))
    store.write_peak(Decimal(50))
    assert store.read_peak() == Decimal(50)
    ledger = MemoryLedger()
    ledger.initialize_from(AccountSnapshot(Decimal(50), {}, (), T0), None)
    ledger.remember_order(
        OrderRequest("c1", Market.STOCKS, "AAA", Side.BUY, Decimal(1), OrderType.LIMIT, Decimal(10))
    )
    ledger.apply_fills([_fill("F1", "c1", Side.BUY, Decimal(1), Decimal(10), Decimal(0))])
    log = MemoryDecisionLog(clock, keep_all=True)
    RecordingAlerter(log).alert("warning", "x", "y")
    log.write("targets", weights={"AAA": 0.2})
    assert log.gz_bytes()
    assert list(tmp_path.iterdir()) == []
    assert not _NOWHERE.exists()


def _os_error(fn: Callable[[], object]) -> OSError:
    """The OSError ``fn`` raises (its text differs between operating systems)."""
    try:
        fn()
    except OSError as exc:
        return exc
    pytest.fail("expected an OSError: something was written")


def test_a_write_that_reaches_nowhere_raises_instead_of_creating_a_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Amendment A8: _NOWHERE sits under this module's own FILE, so on every OS opening a file
    # there fails and mkdir(parents=True) stops at the existing file (FileExistsError or
    # NotADirectoryError). Run from an empty folder, and list the module's folder before and
    # after, so a write that did create something fails this test instead of littering.
    monkeypatch.chdir(tmp_path)
    module_file = Path(inmemory.__file__).resolve()
    assert _NOWHERE.is_absolute()
    assert _NOWHERE.parent == module_file
    assert module_file.is_file()
    before = sorted(p.name for p in module_file.parent.iterdir())
    clock = FixedClock(T0)
    _os_error(lambda: (_NOWHERE / "halt.json").write_text("{}", encoding="utf-8"))
    _os_error(lambda: (_NOWHERE / "decisions.jsonl").open("a", encoding="utf-8"))
    _os_error(lambda: _NOWHERE.mkdir(parents=True, exist_ok=True))
    # The disk classes' own file methods, run on the memory objects, fail the same way.
    _os_error(lambda: RiskStateStore.__init__(MemoryRiskStateStore(), _NOWHERE))  # its mkdir
    _os_error(lambda: RiskStateStore._write_json(MemoryRiskStateStore(), "halt.json", {"active": True}))
    _os_error(lambda: Ledger.save(MemoryLedger()))
    _os_error(lambda: DecisionLog.write(MemoryDecisionLog(clock, keep_all=False), "x"))
    # Best-effort disk hooks swallow the error, and still create nothing.
    RiskStateStore._history(MemoryRiskStateStore(), "set:halt.json", T0, reason="x")
    DecisionLog.__init__(MemoryDecisionLog(clock, keep_all=False), _NOWHERE, clock)
    assert not _NOWHERE.exists()
    assert sorted(p.name for p in module_file.parent.iterdir()) == before
    assert list(tmp_path.iterdir()) == []


def test_a_field_named_ts_does_not_move_a_record_to_another_day(tmp_path: Path) -> None:
    # The disk log picks its file by the clock's date; a field may overwrite the "ts" stamp.
    clock = FixedClock(T0)
    disk = DecisionLog(tmp_path, clock)
    mem = MemoryDecisionLog(clock, keep_all=True)
    for log in (disk, mem):
        log.write("note", ts="not a timestamp")
    clock.advance(timedelta(days=1))
    for log in (disk, mem):
        log.write("note", ts=(T0 - timedelta(days=5)).isoformat())
    for day in (T0.date(), T0.date() + timedelta(days=1), T0.date() - timedelta(days=5)):
        assert mem.read_day(day) == disk.read_day(day)
    assert [r["ts"] for r in mem.read_day(T0.date())] == ["not a timestamp"]
