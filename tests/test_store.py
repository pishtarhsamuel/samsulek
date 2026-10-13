"""The point-in-time Parquet store: versions, as-of queries, revisions, and DuckDB lockdown."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import duckdb
import pytest

from samsulek.data.store import Column, VersionedTable, connect, from_us, to_us

T1 = datetime(2026, 10, 12, 18, 0, tzinfo=UTC)
T2 = T1 + timedelta(days=1)
T3 = T2 + timedelta(days=1)

KEYS = [Column("source", "VARCHAR"), Column("symbol", "VARCHAR"), Column("session", "DATE")]
VALUES = [Column("close", "DOUBLE"), Column("volume", "DOUBLE")]


def table(root: Path) -> VersionedTable:
    return VersionedTable(root, "bars", KEYS, VALUES)


def row(day: int, close: float, volume: float | None = 100.0, symbol: str = "ETF") -> dict[str, object]:
    return {
        "source": "test",
        "symbol": symbol,
        "session": date(2026, 10, day),
        "close": close,
        "volume": volume,
    }


def test_microsecond_timestamps_round_trip() -> None:
    for ts in (T1, datetime(1999, 1, 4, tzinfo=UTC), datetime(2026, 3, 29, 1, 59, 59, 999_999, tzinfo=UTC)):
        assert from_us(to_us(ts)) == ts
    with pytest.raises(ValueError, match="timezone"):
        to_us(datetime(2026, 1, 1))  # noqa: DTZ001


def test_only_new_or_changed_rows_are_written(tmp_path: Path) -> None:
    con, t = connect(tmp_path), table(tmp_path)
    first = t.write(con, [row(5, 10.0), row(6, 11.0)], T1)
    assert (first.new, len(first.revised), first.unchanged) == (2, 0, 0)
    again = t.write(con, [row(5, 10.0), row(6, 11.0)], T2)
    assert again.file is None and again.unchanged == 2, "an identical re-download writes nothing"
    more = t.write(con, [row(6, 11.0), row(7, 12.0)], T2)
    assert (more.new, more.unchanged) == (1, 1)
    assert len(t.files()) == 2
    latest = t.latest(con)
    assert [(r["session"], r["close"]) for r in latest] == [
        (date(2026, 10, 5), 10.0),
        (date(2026, 10, 6), 11.0),
        (date(2026, 10, 7), 12.0),
    ]


def test_revisions_are_kept_and_point_in_time_reads_see_the_old_value(tmp_path: Path) -> None:
    con, t = connect(tmp_path), table(tmp_path)
    t.write(con, [row(5, 10.0), row(6, 11.0)], T1)
    result = t.write(con, [row(5, 10.0), row(6, 11.5)], T2)  # the source corrected the 6th
    assert result.new == 0 and len(result.revised) == 1
    key, old, new = result.revised[0]
    assert key == ("test", "ETF", date(2026, 10, 6)) and old["close"] == 11.0 and new["close"] == 11.5
    assert [r["close"] for r in t.latest(con)] == [10.0, 11.5]
    assert [r["close"] for r in t.latest(con, known_at=T1 + timedelta(hours=1))] == [10.0, 11.0]
    assert t.latest(con, known_at=T1 - timedelta(seconds=1)) == [], "nothing was known before the first fetch"
    history = t.history(con, {"symbol": "ETF", "session": date(2026, 10, 6)})
    assert [h["close"] for h in history] == [11.0, 11.5]
    assert [h["fetched_us"] for h in history] == [to_us(T1), to_us(T2)]


def test_as_known_never_uses_a_later_correction_and_falls_back_to_the_first_version(tmp_path: Path) -> None:
    con, t = connect(tmp_path), table(tmp_path)
    t.write(con, [row(5, 10.0), row(6, 11.0)], T1)
    t.write(con, [row(6, 11.5), row(7, 12.0)], T2)  # a correction of the 6th, and a new day

    def closes(known_at: datetime) -> list[tuple[int, float]]:
        return [(r["session"].day, r["close"]) for r in t.as_known(con, {"symbol": "ETF"}, known_at)]

    assert closes(T1 + timedelta(seconds=1)) == [(5, 10.0), (6, 11.0), (7, 12.0)], (
        "the 6th as known then; the 7th wasn't stored yet, so its first version stands in"
    )
    assert closes(T2) == [(5, 10.0), (6, 11.5), (7, 12.0)], "the correction, once stored"
    assert closes(T1 - timedelta(days=1)) == [(5, 10.0), (6, 11.0), (7, 12.0)], (
        "before anything was stored: the OLDEST version of each key, never the correction"
    )


def test_none_and_nan_compare_as_unchanged_but_none_to_value_is_a_revision(tmp_path: Path) -> None:
    con, t = connect(tmp_path), table(tmp_path)
    t.write(con, [row(5, 10.0, None), row(6, 11.0, float("nan"))], T1)
    same = t.write(con, [row(5, 10.0, None), row(6, 11.0, float("nan"))], T2)
    assert same.unchanged == 2
    changed = t.write(con, [row(5, 10.0, 50.0)], T3)
    assert len(changed.revised) == 1


def test_scope_filters_and_symbols_stay_separate(tmp_path: Path) -> None:
    con, t = connect(tmp_path), table(tmp_path)
    t.write(con, [row(5, 10.0, symbol="A"), row(5, 20.0, symbol="B")], T1)
    t.write(con, [row(5, 10.5, symbol="A")], T2, scope={"symbol": "A"})
    assert [r["close"] for r in t.latest(con, where={"symbol": "A"})] == [10.5]
    assert [r["close"] for r in t.latest(con, where={"symbol": "B"})] == [20.0]
    with pytest.raises(ValueError, match="key columns"):
        t.latest(con, where={"close": 10.0})


def test_bad_writes_are_refused(tmp_path: Path) -> None:
    con, t = connect(tmp_path), table(tmp_path)
    with pytest.raises(ValueError, match="duplicate key"):
        t.write(con, [row(5, 10.0), row(5, 10.1)], T1)
    with pytest.raises(ValueError, match="unknown columns"):
        t.write(con, [{**row(5, 10.0), "extra": 1}], T1)
    t.write(con, [row(5, 10.0)], T2)
    with pytest.raises(ValueError, match="older than the stored one"):
        t.write(con, [row(5, 9.0)], T1)


def test_identifiers_and_types_are_checked() -> None:
    for bad in ('x"; DROP TABLE y; --', "Upper", "1abc"):
        with pytest.raises(ValueError, match="bad column name"):
            Column(bad, "VARCHAR")
    with pytest.raises(ValueError, match="unsupported column type"):
        Column("x", "VARCHAR); DROP TABLE y; --")
    with pytest.raises(ValueError, match="bad table name"):
        VersionedTable(Path("."), "bars; DROP", KEYS, VALUES)
    with pytest.raises(ValueError, match="reserved"):
        VersionedTable(Path("."), "bars", KEYS, [Column("fetched_us", "BIGINT")])


def test_paths_with_quotes_and_spaces_work(tmp_path: Path) -> None:
    root = tmp_path / "Samuel's data folder"
    con, t = connect(root), table(root)
    t.write(con, [row(5, 10.0)], T1)
    assert [r["close"] for r in t.latest(con)] == [10.0]


def test_duckdb_is_locked_down(tmp_path: Path) -> None:
    inside = tmp_path / "data"
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "secret.csv").write_text("a\n1\n", encoding="utf-8")
    con = connect(inside)
    with pytest.raises(duckdb.Error):
        con.execute(f"SELECT * FROM read_csv('{(outside / 'secret.csv').as_posix()}')").fetchall()
    with pytest.raises(duckdb.Error):
        con.execute(f"COPY (SELECT 1) TO '{(outside / 'x.parquet').as_posix()}' (FORMAT parquet)")
    with pytest.raises(duckdb.Error):
        con.execute("SELECT * FROM read_csv('https://example.com/x.csv')").fetchall()
    with pytest.raises(duckdb.Error):
        con.execute("INSTALL httpfs")
    with pytest.raises(duckdb.Error):
        con.execute("SET enable_external_access = true")
    assert not (outside / "x.parquet").exists()
