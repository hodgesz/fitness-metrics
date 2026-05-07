"""Incremental sync for both providers.

Strategy: read each table's high-water mark from DuckDB, pull anything newer.
Idempotent — rerunning right after a successful sync is cheap and a no-op.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta

from rich.console import Console

from fitness_metrics.storage.schema import connect, init_schema
from fitness_metrics.strava import backfill as strava_backfill
from fitness_metrics.strava.client import client as strava_client
from fitness_metrics.whoop import backfill as whoop_backfill
from fitness_metrics.whoop.client import (
    CYCLE_PATH,
    RECOVERY_PATH,
    SLEEP_PATH,
    WORKOUT_PATH,
)
from fitness_metrics.whoop.client import (
    client as whoop_client,
)

console = Console()

# Conservative pull window: if we've never synced, fall back to backfill defaults.
WHOOP_FALLBACK_START = datetime(2024, 1, 1, tzinfo=UTC)
# Overlap so any late-updated records (Whoop recalculates overnight) still upsert.
WHOOP_LOOKBACK = timedelta(days=3)


def _high_water(con, sql: str):
    row = con.execute(sql).fetchone()
    return row[0] if row else None


def _sync_whoop() -> dict:
    counts: dict[str, int] = {}
    with connect() as con, whoop_client() as c:
        for label, path, extractor, table, cols, pk, ts_col in [
            ("cycles", CYCLE_PATH, whoop_backfill._cycle_row, "whoop_cycles", 11, ["id"], "start"),
            ("recoveries", RECOVERY_PATH, whoop_backfill._recovery_row,
             "whoop_recoveries", 12, ["cycle_id"], "created_at"),
            ("sleeps", SLEEP_PATH, whoop_backfill._sleep_row,
             "whoop_sleeps", 12, ["id"], "start"),
            ("workouts", WORKOUT_PATH, whoop_backfill._workout_row,
             "whoop_workouts", 15, ["id"], "start"),
        ]:
            latest = _high_water(con, f'SELECT MAX("{ts_col}") FROM {table}')
            if latest is None:
                start = WHOOP_FALLBACK_START
            else:
                start = latest.replace(tzinfo=UTC) - WHOOP_LOOKBACK
            end = datetime.now(UTC) + timedelta(days=1)

            records = list(whoop_backfill._paginate(c, path, start=start, end=end))
            rows = [extractor(r) for r in records]
            whoop_backfill._load(con, table, cols, rows, pk)
            counts[label] = len(records)
            console.print(f"  whoop {label}: {len(records)} records from {start.date()}")
    return counts


def _sync_strava() -> dict:
    counts = {"activities_new": 0, "activities_updated": 0}
    with connect() as con, strava_client() as c:
        latest = _high_water(con, "SELECT MAX(start_date) FROM strava_activities")
        if latest is None:
            after = 0
        else:
            # Strava /athlete/activities?after= is a Unix timestamp (exclusive).
            # Subtract a day for safety against clock skew / late uploads.
            after = int((latest - timedelta(days=1)).replace(tzinfo=UTC).timestamp())

        page = 1
        per_page = 200
        summaries: list[dict] = []
        while True:
            r = strava_backfill._get(
                c, "/athlete/activities",
                params={"after": after, "page": page, "per_page": per_page},
            )
            batch = r.json()
            if not batch:
                break
            summaries.extend(batch)
            if len(batch) < per_page:
                break
            page += 1

        since = datetime.fromtimestamp(after, UTC).date()
        console.print(f"  strava activities since {since}: {len(summaries)}")
        for s in summaries:
            aid = s["id"]
            detail = strava_backfill.fetch_detail(c, aid)
            if detail is None:
                continue
            streams = strava_backfill.fetch_streams(c, aid)
            existing = con.execute(
                "SELECT 1 FROM strava_activities WHERE id = ?", [aid]
            ).fetchone()
            strava_backfill._upsert_activity(con, detail)
            strava_backfill._upsert_streams(con, aid, streams)
            if existing:
                counts["activities_updated"] += 1
            else:
                counts["activities_new"] += 1
    return counts


def _record_run(provider: str, status: str, notes: str) -> None:
    with connect() as con:
        # Generate an id from current timestamp (DuckDB has no SERIAL).
        run_id = int(time.time() * 1000)
        con.execute(
            "INSERT INTO sync_runs (id, provider, finished_at, status, notes) "
            "VALUES (?, ?, ?, ?, ?)",
            [run_id, provider, datetime.now(UTC).replace(tzinfo=None), status, notes],
        )


def _last_successful_sync(provider: str) -> datetime | None:
    with connect() as con:
        row = con.execute(
            "SELECT MAX(finished_at) FROM sync_runs WHERE provider = ? AND status = 'ok'",
            [provider],
        ).fetchone()
    return row[0] if row and row[0] else None


def run(
    *,
    skip_whoop: bool = False,
    skip_strava: bool = False,
    skip_link: bool = False,
    skip_if_within_minutes: int | None = None,
) -> None:
    init_schema()

    if skip_if_within_minutes:
        now = datetime.now(UTC).replace(tzinfo=None)
        cutoff = now - timedelta(minutes=skip_if_within_minutes)
        last_whoop = _last_successful_sync("whoop")
        last_strava = _last_successful_sync("strava")
        if last_whoop and last_strava and last_whoop >= cutoff and last_strava >= cutoff:
            console.print(
                f"[yellow]Last sync was within {skip_if_within_minutes} min "
                f"(whoop={last_whoop}, strava={last_strava}); skipping.[/yellow]"
            )
            return

    if not skip_whoop:
        console.print("[bold]Syncing Whoop…[/bold]")
        try:
            counts = _sync_whoop()
            _record_run("whoop", "ok", json.dumps(counts))
        except Exception as e:
            _record_run("whoop", "error", str(e)[:500])
            raise

    if not skip_strava:
        console.print("[bold]Syncing Strava…[/bold]")
        try:
            counts = _sync_strava()
            _record_run("strava", "ok", json.dumps(counts))
        except Exception as e:
            _record_run("strava", "error", str(e)[:500])
            raise

    if not skip_link:
        console.print("[bold]Re-linking…[/bold]")
        from fitness_metrics.link import run as link_run
        link_run(verbose=False)

    console.print("[green]Sync complete.[/green]")
