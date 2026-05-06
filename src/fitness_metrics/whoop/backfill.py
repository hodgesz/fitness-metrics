import json
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, TimeElapsedColumn

from fitness_metrics.config import RAW_DIR
from fitness_metrics.ratelimit import RateLimiter, RollingWindow
from fitness_metrics.storage.schema import connect, init_schema
from fitness_metrics.whoop.client import (
    CYCLE_PATH,
    RECOVERY_PATH,
    SLEEP_PATH,
    WORKOUT_PATH,
    client,
)

console = Console()

WHOOP_RAW = RAW_DIR / "whoop"

# Whoop: 100 req/min, 10k/day.
RATE = RateLimiter([
    RollingWindow(limit=100, seconds=60),
    RollingWindow(limit=10_000, seconds=24 * 60 * 60),
])

# Start date for backfill — user confirmed ~1 year of data; we over-pull to be safe.
EARLIEST = datetime(2024, 1, 1, tzinfo=UTC)


def _get(c: httpx.Client, path: str, params: dict | None = None) -> httpx.Response:
    for attempt in range(6):
        RATE.acquire()
        r = c.get(path, params=params)
        if r.status_code == 429:
            retry_after = int(r.headers.get("Retry-After", 30))
            console.print(f"[yellow]429 from Whoop, sleeping {retry_after}s[/yellow]")
            time.sleep(retry_after)
            continue
        if r.status_code >= 500:
            time.sleep(2**attempt)
            continue
        r.raise_for_status()
        return r
    raise RuntimeError(f"Whoop GET {path} failed after retries")


def _paginate(c: httpx.Client, path: str, *, start: datetime, end: datetime) -> Iterator[dict]:
    params = {
        "start": start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "end": end.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "limit": 25,
    }
    while True:
        r = _get(c, path, params=params)
        body = r.json()
        yield from body.get("records", [])
        next_token = body.get("next_token")
        if not next_token:
            return
        params = {"nextToken": next_token, "limit": 25}


def _dump(subdir: str, records: list[dict]) -> Path:
    d = WHOOP_RAW / subdir
    d.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = d / f"backfill_{ts}.json"
    path.write_text(json.dumps(records, separators=(",", ":")))
    return path


def _parse_ts(s: str | None):
    """Whoop returns ISO-8601 UTC strings. DuckDB TIMESTAMP is naive; strip tz
    so all timestamps in the warehouse are comparable (all naive UTC)."""
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)


def _cycle_row(r: dict) -> tuple:
    score = r.get("score") or {}
    return (
        r["id"],
        r.get("user_id"),
        _parse_ts(r.get("start")),
        _parse_ts(r.get("end")),
        r.get("timezone_offset"),
        r.get("score_state"),
        score.get("strain"),
        score.get("kilojoule"),
        score.get("average_heart_rate"),
        score.get("max_heart_rate"),
        json.dumps(r),
    )


def _recovery_row(r: dict) -> tuple:
    score = r.get("score") or {}
    return (
        r.get("cycle_id"),
        r.get("sleep_id"),
        r.get("user_id"),
        _parse_ts(r.get("created_at")),
        _parse_ts(r.get("updated_at")),
        r.get("score_state"),
        score.get("recovery_score"),
        score.get("resting_heart_rate"),
        score.get("hrv_rmssd_milli"),
        score.get("spo2_percentage"),
        score.get("skin_temp_celsius"),
        json.dumps(r),
    )


def _sleep_row(r: dict) -> tuple:
    score = r.get("score") or {}
    return (
        r["id"],
        r.get("user_id"),
        _parse_ts(r.get("start")),
        _parse_ts(r.get("end")),
        r.get("timezone_offset"),
        r.get("nap"),
        r.get("score_state"),
        score.get("sleep_performance_percentage"),
        score.get("sleep_consistency_percentage"),
        score.get("sleep_efficiency_percentage"),
        score.get("respiratory_rate"),
        json.dumps(r),
    )


def _workout_row(r: dict) -> tuple:
    score = r.get("score") or {}
    return (
        r["id"],
        r.get("user_id"),
        _parse_ts(r.get("start")),
        _parse_ts(r.get("end")),
        r.get("timezone_offset"),
        r.get("sport_id"),
        r.get("sport_name"),
        r.get("score_state"),
        score.get("strain"),
        score.get("average_heart_rate"),
        score.get("max_heart_rate"),
        score.get("kilojoule"),
        score.get("distance_meter"),
        score.get("altitude_gain_meter"),
        json.dumps(r),
    )


def _load(con, table: str, cols: int, rows: list[tuple], pk_cols: list[str]) -> None:
    if not rows:
        return
    placeholders = ",".join(["?"] * cols)
    pk_clause = " AND ".join(f"{c}=?" for c in pk_cols)
    for row in rows:
        pk_vals = row[: len(pk_cols)]
        con.execute(f"DELETE FROM {table} WHERE {pk_clause}", list(pk_vals))
        con.execute(f"INSERT INTO {table} VALUES ({placeholders})", list(row))


def run() -> None:
    init_schema()
    start = EARLIEST
    end = datetime.now(UTC) + timedelta(days=1)

    with client() as c, Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress, connect() as con:
        for label, path, extractor, table, cols, pk in [
            ("cycles", CYCLE_PATH, _cycle_row, "whoop_cycles", 11, ["id"]),
            ("recoveries", RECOVERY_PATH, _recovery_row, "whoop_recoveries", 12, ["cycle_id"]),
            ("sleeps", SLEEP_PATH, _sleep_row, "whoop_sleeps", 12, ["id"]),
            ("workouts", WORKOUT_PATH, _workout_row, "whoop_workouts", 15, ["id"]),
        ]:
            task = progress.add_task(f"fetching {label}", total=None)
            records: list[dict] = []
            for rec in _paginate(c, path, start=start, end=end):
                records.append(rec)
                progress.update(task, description=f"fetching {label} ({len(records)})")
            _dump(label, records)
            rows = [extractor(r) for r in records]
            _load(con, table, cols, rows, pk)
            progress.update(task, description=f"[green]{label}: {len(records)} records[/green]")
            progress.stop_task(task)

    console.print("[green]Whoop backfill complete.[/green]")
