"""Match Whoop workouts to Strava activities by time overlap + sport.

Primary signal is time overlap (intersection / union of the two intervals).
Sport compatibility is a tiebreaker — same-sport gets a small bonus, mismatched
sport (e.g. weights vs ride) drops the score.
"""

from rich.console import Console
from rich.table import Table

from fitness_metrics.storage.schema import connect, init_schema

console = Console()

# Whoop sport_name -> Strava sport_type families.
# Not exhaustive; anything not listed is treated as "unknown" and neither
# boosted nor penalized on the sport axis.
SPORT_FAMILIES: dict[str, set[str]] = {
    "cycling": {"Ride", "VirtualRide", "EBikeRide", "MountainBikeRide", "EMountainBikeRide"},
    "mountain-biking": {"MountainBikeRide", "EMountainBikeRide", "Ride"},
    "spin": {"VirtualRide", "Ride"},
    "running": {"Run", "TrailRun", "VirtualRun"},
    "walking": {"Walk", "Hike"},
    "hiking-rucking": {"Hike", "Walk"},
    "weightlifting": {"WeightTraining", "Workout"},
    "solidcore": {"Workout", "WeightTraining"},
    "snow-shoveling": set(),
    "volleyball": {"Workout"},
    "swimming": {"Swim"},
}

# Minimum overlap (seconds) to even consider a pair.
MIN_OVERLAP_SECONDS = 60

# IoU threshold above which we accept the link.
MIN_MATCH_SCORE = 0.3


def _overlap_seconds(a_start, a_end, b_start, b_end) -> float:
    start = max(a_start, b_start)
    end = min(a_end, b_end)
    if end <= start:
        return 0.0
    return (end - start).total_seconds()


def _union_seconds(a_start, a_end, b_start, b_end) -> float:
    start = min(a_start, b_start)
    end = max(a_end, b_end)
    return (end - start).total_seconds()


def _sport_adjustment(whoop_sport: str | None, strava_sport: str | None) -> float:
    """Return a score delta in [-0.1, +0.1] based on sport compatibility."""
    if not whoop_sport or not strava_sport:
        return 0.0
    fam = SPORT_FAMILIES.get(whoop_sport.lower())
    if fam is None:
        return 0.0
    if strava_sport in fam:
        return 0.1
    # Actively incompatible (e.g. weightlifting ↔ Ride)
    return -0.1


def compute_links() -> list[tuple[int, str, float]]:
    """Produce (strava_activity_id, whoop_workout_id, match_score) tuples.

    Scoring: intersection / union (IoU) of time intervals, plus sport adjustment.
    Each Strava activity links to at most one Whoop workout (best match), and vice versa.
    """
    with connect() as con:
        whoop_rows = con.execute("""
            SELECT id, start, "end", sport_name
            FROM whoop_workouts
            WHERE "end" IS NOT NULL
            ORDER BY start
        """).fetchall()
        strava_rows = con.execute("""
            SELECT id, start_date,
                   start_date + INTERVAL (COALESCE(elapsed_time, 0)) SECOND AS end_ts,
                   sport_type
            FROM strava_activities
            WHERE start_date >= (SELECT MIN(start) FROM whoop_workouts)
            ORDER BY start_date
        """).fetchall()

    # Candidate pairs: Strava activities whose interval overlaps each Whoop workout.
    # Naive O(W*S) is fine at these sizes (hundreds of each).
    candidates: list[tuple[float, int, str]] = []  # (score, strava_id, whoop_id)
    for w_id, w_start, w_end, w_sport in whoop_rows:
        for s_id, s_start, s_end, s_sport in strava_rows:
            overlap = _overlap_seconds(w_start, w_end, s_start, s_end)
            if overlap < MIN_OVERLAP_SECONDS:
                continue
            union = _union_seconds(w_start, w_end, s_start, s_end)
            iou = overlap / union if union > 0 else 0.0
            score = max(0.0, min(1.0, iou + _sport_adjustment(w_sport, s_sport)))
            if score >= MIN_MATCH_SCORE:
                candidates.append((score, s_id, w_id))

    # Greedy one-to-one matching, highest score first.
    candidates.sort(reverse=True)
    strava_taken: set[int] = set()
    whoop_taken: set[str] = set()
    results: list[tuple[int, str, float]] = []
    for score, s_id, w_id in candidates:
        if s_id in strava_taken or w_id in whoop_taken:
            continue
        strava_taken.add(s_id)
        whoop_taken.add(w_id)
        results.append((s_id, w_id, score))
    return results


def run(*, verbose: bool = True) -> None:
    init_schema()
    links = compute_links()

    with connect() as con:
        con.execute("DELETE FROM activity_links")
        for s_id, w_id, score in links:
            con.execute(
                "INSERT INTO activity_links (strava_activity_id, whoop_workout_id, match_score) "
                "VALUES (?, ?, ?)",
                [s_id, w_id, score],
            )

        if verbose:
            n_whoop = con.execute("SELECT COUNT(*) FROM whoop_workouts").fetchone()[0]
            n_strava_eligible = con.execute("""
                SELECT COUNT(*) FROM strava_activities
                WHERE start_date >= (SELECT MIN(start) FROM whoop_workouts)
            """).fetchone()[0]
            console.print(
                f"[green]Linked {len(links)} pairs.[/green]  "
                f"Whoop workouts: {n_whoop}, Strava activities in window: {n_strava_eligible}"
            )

            table = Table(title="Sample matches (top 10 by score)")
            table.add_column("strava_id")
            table.add_column("sport_type")
            table.add_column("strava start (UTC)")
            table.add_column("whoop_id")
            table.add_column("whoop sport")
            table.add_column("score", justify="right")
            rows = con.execute("""
                SELECT l.strava_activity_id, s.sport_type, s.start_date,
                       l.whoop_workout_id, w.sport_name, l.match_score
                FROM activity_links l
                JOIN strava_activities s ON s.id = l.strava_activity_id
                JOIN whoop_workouts w ON w.id = l.whoop_workout_id
                ORDER BY l.match_score DESC
                LIMIT 10
            """).fetchall()
            for r in rows:
                table.add_row(
                    str(r[0]), r[1], str(r[2]), str(r[3])[:8] + "…", str(r[4]), f"{r[5]:.3f}"
                )
            console.print(table)
