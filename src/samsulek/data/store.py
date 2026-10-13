"""Point-in-time (bitemporal) storage on Parquet files, queried with DuckDB.

Every fetch writes ONE new Parquet file holding only the rows that are new or whose
values changed, each stamped with ``fetched_us`` (when we received it). Nothing is ever
overwritten. So we can always answer both "what is the latest value?" and "what did we
know at time T?" - including the original value of something the source later revised.

Timestamps are stored as integer microseconds since the Unix epoch, UTC (``*_us``
columns): unambiguous, and it avoids DuckDB's timezone-aware type, whose conversion to
Python needs the undeclared ``pytz`` package.

DuckDB connections are locked down: no automatic extension downloads, no network, no
file access outside the data folder, and the settings can't be changed afterwards.
"""

from __future__ import annotations

import itertools
import math
import os
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb

from samsulek.types import require_aware

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_counter = itertools.count()


def to_us(ts: datetime) -> int:
    require_aware(ts, "timestamp")
    delta = ts.astimezone(UTC) - _EPOCH
    return (delta.days * 86_400 + delta.seconds) * 1_000_000 + delta.microseconds


def from_us(us: int) -> datetime:
    return _EPOCH + timedelta(microseconds=us)


def _sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def connect(data_root: Path) -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB that may only touch files under ``data_root``."""
    root = data_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(
        ":memory:",
        config={"autoinstall_known_extensions": False, "autoload_known_extensions": False},
    )
    con.execute("SET TimeZone = 'UTC'")
    con.execute(f"SET allowed_directories = [{_sql_str(str(root))}]")
    con.execute("SET enable_external_access = false")
    con.execute("SET lock_configuration = true")
    return con


# SQL text is only ever built from these checked identifiers and types, plus file paths
# escaped by _sql_str. Every data value is passed as a query parameter.
_IDENT_RE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
_SQL_TYPES = frozenset({"VARCHAR", "DATE", "DOUBLE", "BIGINT", "BOOLEAN"})


@dataclass(frozen=True, slots=True)
class Column:
    name: str
    sql_type: str  # one of _SQL_TYPES

    def __post_init__(self) -> None:
        if not _IDENT_RE.match(self.name):
            raise ValueError(f"bad column name {self.name!r}")
        if self.sql_type not in _SQL_TYPES:
            raise ValueError(f"unsupported column type {self.sql_type!r}")


@dataclass(frozen=True, slots=True)
class WriteResult:
    file: Path | None
    new: int
    revised: list[tuple[tuple[Any, ...], dict[str, Any], dict[str, Any]]]  # (key, old, new)
    unchanged: int

    @property
    def written(self) -> int:
        return self.new + len(self.revised)


class VersionedTable:
    """A set of Parquet files under ``<root>/<name>/`` holding versions of keyed rows."""

    def __init__(self, root: Path, name: str, keys: Sequence[Column], values: Sequence[Column]) -> None:
        if not _IDENT_RE.match(name):
            raise ValueError(f"bad table name {name!r}")
        cols = [*keys, *values]
        if len({c.name for c in cols}) != len(cols) or "fetched_us" in {c.name for c in cols}:
            raise ValueError("duplicate or reserved column names")
        self.root = root
        self.dir = root / name
        self.name = name
        self.keys = list(keys)
        self.values = list(values)

    @property
    def columns(self) -> list[Column]:
        return [*self.keys, *self.values, Column("fetched_us", "BIGINT")]

    def files(self) -> list[Path]:
        if not self.dir.is_dir():
            return []
        return sorted(p for p in self.dir.glob("*.parquet") if p.is_file())

    # ------------------------------------------------------------------ read
    def latest(
        self,
        con: duckdb.DuckDBPyConnection,
        where: Mapping[str, Any] | None = None,
        known_at: datetime | None = None,
    ) -> list[dict[str, Any]]:
        """The newest version of every key (as known at ``known_at``, if given), sorted by key."""
        files = self.files()
        if not files:
            return []
        conditions, params = [], []
        for col, value in (where or {}).items():
            if col not in {c.name for c in self.keys}:
                raise ValueError(f"can only filter on key columns, not {col!r}")
            conditions.append(f'"{col}" = ?')
            params.append(value)
        if known_at is not None:
            conditions.append("fetched_us <= ?")
            params.append(to_us(known_at))
        key_list = ", ".join(f'"{c.name}"' for c in self.keys)
        select = ", ".join(f'"{c.name}"' for c in self.columns)
        source = f"read_parquet([{', '.join(_sql_str(str(p)) for p in files)}], union_by_name = true)"
        sql = (  # identifiers checked by _IDENT_RE, paths escaped, values are parameters
            f"SELECT {select} FROM {source}"  # noqa: S608
            + (f" WHERE {' AND '.join(conditions)}" if conditions else "")
            + f" QUALIFY row_number() OVER (PARTITION BY {key_list} ORDER BY fetched_us DESC) = 1"
            + f" ORDER BY {key_list}"
        )
        cursor = con.execute(sql, params)
        names = [d[0] for d in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]

    def as_known(
        self, con: duckdb.DuckDBPyConnection, where: Mapping[str, Any], known_at: datetime
    ) -> list[dict[str, Any]]:
        """Every key as research may use it at ``known_at``: the newest version stored by
        then; for a key first stored later (history backfilled after the fact) its OLDEST
        version, the best stand-in for what was public at the time. Never a correction
        stored after ``known_at`` when an earlier version exists."""
        files = self.files()
        if not files:
            return []
        conditions, params = [], []
        for col, value in where.items():
            if col not in {c.name for c in self.keys}:
                raise ValueError(f"can only filter on key columns, not {col!r}")
            conditions.append(f'"{col}" = ?')
            params.append(value)
        cutoff = to_us(known_at)
        key_list = ", ".join(f'"{c.name}"' for c in self.keys)
        select = ", ".join(f'"{c.name}"' for c in self.columns)
        source = f"read_parquet([{', '.join(_sql_str(str(p)) for p in files)}], union_by_name = true)"
        sql = (  # identifiers checked by _IDENT_RE, paths escaped, values are parameters
            f"SELECT {select} FROM {source}"  # noqa: S608
            + (f" WHERE {' AND '.join(conditions)}" if conditions else "")
            + f" QUALIFY row_number() OVER (PARTITION BY {key_list} ORDER BY (fetched_us <= ?) DESC,"
            + " CASE WHEN fetched_us <= ? THEN -fetched_us ELSE fetched_us END) = 1"
            + f" ORDER BY {key_list}"
        )
        cursor = con.execute(sql, [*params, cutoff, cutoff])
        names = [d[0] for d in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]

    def history(self, con: duckdb.DuckDBPyConnection, where: Mapping[str, Any]) -> list[dict[str, Any]]:
        """Every stored version of the matching keys, oldest first (for audits)."""
        files = self.files()
        if not files:
            return []
        conditions = " AND ".join(f'"{c}" = ?' for c in where)
        source = f"read_parquet([{', '.join(_sql_str(str(p)) for p in files)}], union_by_name = true)"
        key_list = ", ".join(f'"{c.name}"' for c in self.keys)
        cursor = con.execute(
            f"SELECT * FROM {source} WHERE {conditions} ORDER BY {key_list}, fetched_us",  # noqa: S608
            list(where.values()),
        )
        names = [d[0] for d in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]

    # ----------------------------------------------------------------- write
    def write(
        self,
        con: duckdb.DuckDBPyConnection,
        rows: Iterable[Mapping[str, Any]],
        fetched_at: datetime,
        scope: Mapping[str, Any] | None = None,
    ) -> WriteResult:
        """Store the rows that are new or changed versus the latest stored version.

        ``scope`` (key column -> value) limits the comparison read to e.g. one symbol.
        Rows that repeat a key within one call are an error (the source is inconsistent).
        """
        fetched_us = to_us(fetched_at)
        key_names = [c.name for c in self.keys]
        value_names = [c.name for c in self.values]
        incoming: dict[tuple[Any, ...], dict[str, Any]] = {}
        for row in rows:
            unknown = set(row) - {*key_names, *value_names}
            if unknown:
                raise ValueError(f"unknown columns {sorted(unknown)}")
            key = tuple(row[k] for k in key_names)
            if key in incoming:
                raise ValueError(f"duplicate key {key} in one write")
            incoming[key] = {c: row.get(c) for c in value_names}
        stored = self.latest(con, where=scope) if incoming else []
        current = {tuple(r[k] for k in key_names): r for r in stored}
        to_write: list[tuple[Any, ...]] = []
        revised: list[tuple[tuple[Any, ...], dict[str, Any], dict[str, Any]]] = []
        new = unchanged = 0
        for key, vals in incoming.items():
            old = current.get(key)
            if old is None:
                new += 1
            elif all(_same(old[c], vals[c]) for c in value_names):
                unchanged += 1
                continue
            else:
                if old["fetched_us"] > fetched_us:
                    raise ValueError(f"{self.name}: refusing to write a version older than the stored one")
                revised.append((key, {c: old[c] for c in value_names}, vals))
            to_write.append((*key, *(vals[c] for c in value_names), fetched_us))
        if not to_write:
            return WriteResult(None, new, revised, unchanged)
        path = self._write_file(con, to_write, fetched_us)
        return WriteResult(path, new, revised, unchanged)

    def _write_file(
        self, con: duckdb.DuckDBPyConnection, rows: list[tuple[Any, ...]], fetched_us: int
    ) -> Path:
        self.dir.mkdir(parents=True, exist_ok=True)
        stamp = from_us(fetched_us).strftime("%Y%m%dT%H%M%S%fZ")
        final = self.dir / f"{stamp}_{os.getpid()}_{next(_counter)}.parquet"
        tmp = final.with_name("." + final.name + ".tmp")
        tmp_table = f"_w_{self.name}"
        cols_sql = ", ".join(f'"{c.name}" {c.sql_type}' for c in self.columns)
        con.execute(f"CREATE OR REPLACE TEMP TABLE {tmp_table} ({cols_sql})")
        try:
            placeholders = ", ".join("?" for _ in self.columns)
            con.executemany(f"INSERT INTO {tmp_table} VALUES ({placeholders})", rows)  # noqa: S608
            con.execute(f"COPY {tmp_table} TO {_sql_str(str(tmp))} (FORMAT parquet, COMPRESSION zstd)")
        finally:
            con.execute(f"DROP TABLE IF EXISTS {tmp_table}")
        with tmp.open("r+b") as fh:  # Windows needs write access to flush a file to disk
            os.fsync(fh.fileno())
        os.replace(tmp, final)
        return final


def _same(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
        return True
    return bool(a == b)
