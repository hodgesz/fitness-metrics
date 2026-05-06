import json
import time
from pathlib import Path

import httpx
from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)

from fitness_metrics.config import RAW_DIR
from fitness_metrics.ratelimit import DailyUtcWindow, RateLimiter, RollingWindow
from fitness_metrics.storage.schema import connect, init_schema
from fitness_metrics.strava.client import client

console = Console()

STRAVA_RAW = RAW_DIR / "strava"
ACTIVITIES_DIR = STRAVA_RAW / "activities_pages"
DETAIL_DIR = STRAVA_RAW / "activity_detail"
STREAMS_DIR = STRAVA_RAW / "streams"

STREAM_KEYS = [
    "time",
    "distance",
    "latlng",
    "altitude",
    "velocity_smooth",
    "heartrate",
    "cadence",
    "watts",
    "grade_smooth",
    "moving",
    "temp",
]

# Strava: 200/15min overall, 2000/day overall, 100/15min non-upload read, 1000/day read.
# Daily limit resets at 00:00 UTC; 15-min is rolling.
RATE = RateLimiter([
    RollingWindow(limit=100, seconds=15 * 60),
    DailyUtcWindow(limit=1000),
])


def _get(
    c: httpx.Client,
    path: str,
    params: dict | None = None,
    *,
    allow_statuses: tuple[int, ...] = (),
) -> httpx.Response:
    for attempt in range(6):
        RATE.acquire()
        r = c.get(path, params=params)
        if r.status_code == 429:
            retry_after = int(r.headers.get("Retry-After", 60))
            console.print(f"[yellow]429 from Strava, sleeping {retry_after}s[/yellow]")
            time.sleep(retry_after)
            continue
        if r.status_code >= 500:
            time.sleep(2**attempt)
            continue
        if r.status_code in allow_statuses:
            return r
        r.raise_for_status()
        return r
    raise RuntimeError(f"Strava GET {path} failed after retries")


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))


def list_all_activities(c: httpx.Client) -> list[dict]:
    ACTIVITIES_DIR.mkdir(parents=True, exist_ok=True)
    page = 1
    per_page = 200
    all_activities: list[dict] = []
    while True:
        r = _get(c, "/athlete/activities", params={"page": page, "per_page": per_page})
        batch = r.json()
        _write_json(ACTIVITIES_DIR / f"page_{page:04d}.json", batch)
        if not batch:
            break
        all_activities.extend(batch)
        total = len(all_activities)
        console.print(f"  page {page}: {len(batch)} activities (running total {total})")
        if len(batch) < per_page:
            break
        page += 1
    return all_activities


def fetch_detail(c: httpx.Client, activity_id: int) -> dict | None:
    path = DETAIL_DIR / f"{activity_id}.json"
    if path.exists():
        return json.loads(path.read_text()) or None
    r = _get(
        c,
        f"/activities/{activity_id}",
        params={"include_all_efforts": "false"},
        allow_statuses=(404,),
    )
    if r.status_code == 404:
        _write_json(path, {})  # sentinel so we don't retry
        return None
    data = r.json()
    _write_json(path, data)
    return data


def fetch_streams(c: httpx.Client, activity_id: int) -> dict:
    path = STREAMS_DIR / f"{activity_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    r = _get(
        c,
        f"/activities/{activity_id}/streams",
        params={"keys": ",".join(STREAM_KEYS), "key_by_type": "true"},
        allow_statuses=(404,),
    )
    if r.status_code == 404:
        _write_json(path, {})
        return {}
    data = r.json()
    _write_json(path, data)
    return data


def _activity_row(a: dict) -> tuple:
    return (
        a["id"],
        (a.get("athlete") or {}).get("id"),
        a.get("name"),
        a.get("type"),
        a.get("sport_type"),
        a.get("start_date"),
        a.get("start_date_local"),
        a.get("timezone"),
        a.get("elapsed_time"),
        a.get("moving_time"),
        a.get("distance"),
        a.get("total_elevation_gain"),
        a.get("average_speed"),
        a.get("max_speed"),
        a.get("average_heartrate"),
        a.get("max_heartrate"),
        a.get("average_watts"),
        a.get("weighted_average_watts"),
        a.get("kilojoules"),
        a.get("device_watts"),
        a.get("trainer"),
        a.get("has_heartrate"),
        json.dumps(a),
    )


def _upsert_activity(con, detail: dict) -> None:
    con.execute("DELETE FROM strava_activities WHERE id = ?", [detail["id"]])
    con.execute(
        """INSERT INTO strava_activities VALUES
           (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        _activity_row(detail),
    )


def _upsert_streams(con, activity_id: int, streams: dict) -> None:
    con.execute("DELETE FROM strava_streams WHERE activity_id = ?", [activity_id])
    for stream_type, payload in (streams or {}).items():
        con.execute(
            """INSERT INTO strava_streams VALUES (?,?,?,?,?,?)""",
            [
                activity_id,
                stream_type,
                payload.get("resolution"),
                payload.get("series_type"),
                payload.get("original_size"),
                json.dumps(payload.get("data")),
            ],
        )


def run(limit: int | None = None) -> None:
    init_schema()
    with client() as c:
        console.print("[bold]Listing activities…[/bold]")
        summaries = list_all_activities(c)
        total = len(summaries)
        if limit is not None:
            summaries = summaries[:limit]
            console.print(
                f"[bold]Found {total} activities. Hydrating first {len(summaries)} (pilot)…[/bold]"
            )
        else:
            console.print(f"[bold]Found {total} activities. Hydrating…[/bold]")

        with connect() as con, Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            TimeRemainingColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("hydrate", total=len(summaries))
            skipped = 0
            for s in summaries:
                aid = s["id"]
                detail = fetch_detail(c, aid)
                if detail is None:
                    skipped += 1
                    progress.advance(task)
                    continue
                streams = fetch_streams(c, aid)
                _upsert_activity(con, detail)
                _upsert_streams(con, aid, streams)
                progress.advance(task)
            if skipped:
                console.print(f"[yellow]Skipped {skipped} activity(ies) with 404 detail.[/yellow]")
    console.print("[green]Strava backfill complete.[/green]")
