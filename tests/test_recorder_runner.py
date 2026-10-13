"""The recorder wired to the real adapters, against recorded provider responses (no network).

The fake server replays real response bodies. Two harness liberties, both deliberate:
the Date header is set to the test clock (the recordings were made minutes apart and
the adapters refuse clock skew), and requests that no recording answers (mints that
"don't exist", "no newer signatures") get an answer in the recorded shape with empty
values.
"""

from __future__ import annotations

import json
import shutil
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from pathlib import Path
from typing import Any

import pytest

from samsulek import cli
from samsulek.clock import FixedClock
from samsulek.config import RecorderConfig
from samsulek.data.recorder import maintenance, runner
from samsulek.data.recorder.journal import Journal, read_stream
from samsulek.data.sources import dexscreener, geckoterminal, solana_rpc
from samsulek.net.http import RateLimiter
from withheld import read_fixture

ROOT = Path(__file__).resolve().parents[1]
FIX = Path(__file__).parent / "fixtures"
RPC_URL = "https://api.mainnet.solana.com"
T0 = datetime(2026, 10, 12, 21, 30, tzinfo=UTC)  # after every recording
GT_PAGE = "geckoterminal/solana_new_pools_p1_r2.json"
GT_POOLS = {
    "BgG9uP5e8kqN6xLFABcr8yphhRsJEm5QSVMQpzRqem8r",
    "6mLnRNKDNVyvhwmNg4rpZ2pRRJfiuyzvP2KdZAN9aSbW",
    "EYAdcxGGoaZENpVdKavjaBbx2DemxGEPUA3jqLSWVFom",
    "H3bXauze6hugFCyX9Wd98M5BkkojwQV7jiGYhLafufZg",
}


def recorded_headers(source: str, name: str) -> list[tuple[str, str]]:
    """The final response's headers from a curl dump (a proxy's CONNECT answer comes first;
    the dumps have LF or CRLF line endings)."""
    out: list[tuple[str, str]] = []
    for line in (FIX / source / f"{name}.headers.txt").read_text(encoding="ascii").splitlines():
        if line.startswith("HTTP/"):
            out = []
        elif ":" in line:
            key, value = line.split(":", 1)
            if key.strip().lower() != "content-length":  # it measured the untrimmed original
                out.append((key.strip(), value.strip()))
    return out


@dataclass
class Raw:
    status: int
    body: bytes
    headers: list[tuple[str, str]]

    def getheaders(self) -> list[tuple[str, str]]:
        return self.headers

    def read(self, amt: int | None = None) -> bytes:
        return self.body

    def close(self) -> None:
        pass


class Providers:
    def __init__(self, clock: FixedClock) -> None:
        self.clock = clock
        self.calls: list[tuple[str, str]] = []
        rpc = FIX / "solana_rpc"
        sigs = json.loads((rpc / "getSignaturesForAddress_pump_mintauth_pda_limit20.json").read_bytes())
        self.signatures: list[dict[str, Any]] = sigs["result"]  # newest first
        accounts = json.loads(
            (rpc / "getMultipleAccounts_mixed_jsonParsed_trimmed_curve_null.json").read_bytes()
        )
        self.context = accounts["result"]["context"]
        self.curve = accounts["result"]["value"][0]  # a real pump.fun bonding-curve account
        self.slot = (rpc / "getSlot_confirmed.json").read_bytes()
        self.holders = (rpc / "getProgramAccounts_token2022_memcmp_mint_holders.json").read_bytes()

    def __call__(self, request: urllib.request.Request, timeout: float) -> Raw:
        host = urllib.parse.urlsplit(request.full_url).hostname
        date = ("date", format_datetime(self.clock.now(), usegmt=True))
        if host == geckoterminal.HOST:
            self.calls.append(("gt", request.full_url))
            hdrs = recorded_headers("geckoterminal", "solana_new_pools_p1_r2")
            body = read_fixture(GT_PAGE)
        elif host == dexscreener.HOST:
            self.calls.append(("ds", request.full_url))
            hdrs = recorded_headers("dexscreener", "pairs_solana_not_a_pair")
            body = (FIX / "dexscreener" / "pairs_solana_not_a_pair.json").read_bytes()
        else:
            assert host == solana_rpc.HOST
            assert isinstance(request.data, bytes)
            call = json.loads(request.data)
            self.calls.append(("rpc", call["method"]))
            hdrs = [("content-type", "application/json; charset=utf-8")]
            body = self.rpc(call["method"], call["params"])
        hdrs = [(k, v) for k, v in hdrs if k.lower() != "date"] + [date]
        return Raw(200, body, hdrs)

    def rpc(self, method: str, params: list[Any]) -> bytes:
        if method == "getSignaturesForAddress":
            until = params[1].get("until")  # like the node: only signatures newer than `until`
            known = [x["signature"] for x in self.signatures]
            return _rpc(self.signatures[: known.index(until)] if until in known else self.signatures)
        if method == "getMultipleAccounts":
            keys, options = params
            entry = self.curve if options["encoding"] == "base64" else None
            return _rpc({"context": self.context, "value": [entry] * len(keys)})
        if method == "getSlot":
            return self.slot
        if method == "getProgramAccounts":
            return self.holders
        raise AssertionError(f"unexpected RPC method {method}")


def _rpc(result: object) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "result": result, "id": 1}).encode()


@pytest.fixture
def fast_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Real rate limiters would make this test sleep for real; the limits have their own tests."""

    def fast(*args: object, **kw: object) -> RateLimiter:
        return RateLimiter(1000, 1.0, burst=1000)

    for module in (geckoterminal, dexscreener, solana_rpc):
        monkeypatch.setattr(module, "limiter", fast)
    monkeypatch.setattr(solana_rpc, "RateLimiter", fast)


def setup(tmp_path: Path, clock: FixedClock | None = None) -> tuple[FixedClock, Providers, Journal, Any]:
    clock = clock or FixedClock(T0)
    server = Providers(clock)
    cfg = RecorderConfig(
        solana_rpc_url=RPC_URL, discovery_pages=1, snapshot_per_mille=1000, holders_per_mille=1000
    )
    http = runner.build_http("samsulek-test/0", RPC_URL, opener=server, sleep=lambda s: None, now=clock.now)
    journal = Journal(tmp_path, clock)
    rec = runner.build_recorder(tmp_path, cfg, http, journal, clock)
    return clock, server, journal, rec


def sleeper(clock: FixedClock) -> Any:
    return lambda seconds: clock.advance(timedelta(seconds=seconds))


def stream(root: Path, name: str) -> list[dict[str, Any]]:
    return list(read_stream(root, name))


@pytest.mark.usefixtures("fast_limits")
def test_twenty_minutes_of_recording_through_the_real_adapters(tmp_path: Path) -> None:
    read_fixture(GT_PAGE)  # skip up front if withheld, not halfway through a run
    clock, server, journal, rec = setup(tmp_path)
    said: list[str] = []
    with journal:
        runner.run_recorder(tmp_path, rec, clock, said.append, minutes=20, sleep=sleeper(clock))
    assert rec.disabled == {}, f"nothing may be switched off: {rec.disabled}"
    assert said[0] == "Starting fresh."
    assert any("tracking 4 pools" in line for line in said)

    assert {p["pool_address"] for p in stream(tmp_path, "pools")} == GT_POOLS
    assert len(stream(tmp_path, "pools")) == 4, "later rounds see the same page: nothing re-recorded"
    pages = stream(tmp_path, "gt_pages")
    assert len([p for p in pages if "page" in p]) == 8, "a round every 150 s"
    assert len([p for p in pages if p.get("round_complete")]) == 8, "each round marked complete"
    creations = stream(tmp_path, "pump_creations")
    assert creations[0]["baseline"] is True and creations[0]["count"] == 20
    assert all(c["count"] == 0 for c in creations[1:]) and len(creations) == 20
    assert {m["mint"] for m in stream(tmp_path, "mint_facts")} == {
        p["base_mint"] for p in stream(tmp_path, "pools")
    }
    # Pools from 21:13-21:14: the 5-minute snapshot is long past (skipped, said so), the
    # 15-minute one is due right away; DexScreener doesn't list them (missing, not rugged).
    skipped = stream(tmp_path, "snapshot_skipped")
    assert {(s["pool"], s["target_age_minutes"], s["reason"]) for s in skipped} == {
        (p, 5.0, "late") for p in GT_POOLS
    }
    assert {(m["pool"], m["target_age_minutes"]) for m in stream(tmp_path, "pair_missing")} == {
        (p, 15.0) for p in GT_POOLS
    }
    curves = stream(tmp_path, "curve_states")
    assert len(curves) == 2 and all(c["state"]["complete"] is False for c in curves), "pump.fun pools only"
    holders = stream(tmp_path, "holders")
    assert {h["pool"] for h in holders} == GT_POOLS, "the 15-minute holder lists"
    assert all(h["error"] == "token program unknown" for h in holders), "said, not guessed"

    coverage = [c["event"] for c in stream(tmp_path, "coverage")]
    assert coverage[0] == "start" and coverage[-1] == "stop" and "gap" not in coverage
    h = maintenance.health(tmp_path, clock.now())
    assert h.last_beat == clock.now() and h.disabled == [] and h.open_outages == []
    assert h.pump_launches == 0, "the baseline is not counted as launches"
    assert {c[0] for c in server.calls} == {"gt", "ds", "rpc"}


@pytest.mark.usefixtures("fast_limits")
def test_a_restart_resumes_the_schedule_without_repeating_it(tmp_path: Path) -> None:
    read_fixture(GT_PAGE)
    clock, _, journal, rec = setup(tmp_path)
    with journal:
        runner.run_recorder(tmp_path, rec, clock, lambda _: None, minutes=1, sleep=sleeper(clock))
    clock.advance(timedelta(minutes=40))  # down for 40 minutes; back at 22:11
    _, _, journal2, rec2 = setup(tmp_path, clock)
    said: list[str] = []
    with journal2:
        runner.run_recorder(tmp_path, rec2, clock, said.append, minutes=5, sleep=sleeper(clock))
    assert said[0] == "Resumed 4 pools with snapshots still due."
    assert len(stream(tmp_path, "pools")) == 4, "known pools are not recorded again"
    by_age: dict[float, int] = {}
    for name in runner.SNAPSHOT_STREAMS:
        for r in stream(tmp_path, name):
            by_age[r["target_age_minutes"]] = by_age.get(r["target_age_minutes"], 0) + 1
    assert by_age == {5.0: 4, 15.0: 4, 60.0: 4}, "each age once per pool; the 60-minute one after restart"
    gaps = [c for c in stream(tmp_path, "coverage") if c.get("event") == "gap"]
    assert [g["kind"] for g in gaps] == ["not_running"]
    assert gaps[0]["seconds"] == pytest.approx(40 * 60, abs=10)


def test_the_raw_journal_outlives_the_restore_window(tmp_path: Path) -> None:
    clock = FixedClock(T0)
    with Journal(tmp_path, clock) as journal:
        rec = runner.build_recorder(
            tmp_path, RecorderConfig(), runner.build_http("ua-test/0", RPC_URL), journal, clock
        )
    assert rec.restore_window < maintenance.RAW_KEEP


def test_build_http_allows_exactly_the_three_providers() -> None:
    http = runner.build_http("ua-test/0", "https://my-rpc.example.org/key123/")
    assert http.allowed_hosts == {geckoterminal.HOST, dexscreener.HOST, "my-rpc.example.org"}
    assert set(http.limiters) == http.allowed_hosts


# ------------------------------------------------------------------- the CLI


@pytest.fixture
def project(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "ops", tmp_path / "ops")
    return tmp_path


def test_record_status_and_compact_before_any_recording(
    project: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["--root", str(project), "record", "status"]) == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "never ran" in out and out.isascii()
    assert cli.main(["--root", str(project), "record", "compact"]) == cli.EXIT_OK
    assert "Compacted 0 stream-days" in capsys.readouterr().out


def test_record_solana_runs_the_wired_recorder(
    project: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    seen: dict[str, Any] = {}

    def fake_run(root: Path, rec: Any, clock: Any, say: Any, *, minutes: float | None = None) -> None:
        seen.update(root=root, rec=rec, minutes=minutes)
        say("pretend recording")

    monkeypatch.setattr(runner, "run_recorder", fake_run)
    code = cli.main(["--root", str(project), "record", "solana", "--minutes", "2.5"])
    assert code == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "nothing is traded" in out and "pretend recording" in out and "Recorder stopped" in out
    assert seen["root"] == project / "data" / "solana" and seen["minutes"] == 2.5
    assert isinstance(seen["rec"]._discovery, geckoterminal.GeckoTerminalSource)
    assert isinstance(seen["rec"]._chain, solana_rpc.SolanaRpc)


def test_one_recorder_at_a_time(project: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from samsulek.runlock import RunLock

    with RunLock(project / "data" / "solana", FixedClock(T0)):
        assert cli.main(["--root", str(project), "record", "solana"]) == cli.EXIT_HALTED
        assert "already running" in capsys.readouterr().out
        assert cli.main(["--root", str(project), "record", "compact"]) == cli.EXIT_HALTED


@pytest.mark.parametrize("bad", ["0", "-5", "abc"])
def test_minutes_must_be_positive(project: Path, bad: str) -> None:
    with pytest.raises(SystemExit):
        cli.main(["--root", str(project), "record", "solana", "--minutes", bad])
