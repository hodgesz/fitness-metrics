import duckdb

from fitness_metrics.config import WAREHOUSE_PATH

DDL = """
CREATE TABLE IF NOT EXISTS whoop_cycles (
    id            BIGINT PRIMARY KEY,
    user_id       BIGINT,
    start         TIMESTAMP,
    "end"         TIMESTAMP,
    timezone_offset TEXT,
    score_state   TEXT,
    strain        DOUBLE,
    kilojoule     DOUBLE,
    average_hr    INTEGER,
    max_hr        INTEGER,
    raw           JSON
);

CREATE TABLE IF NOT EXISTS whoop_recoveries (
    cycle_id      BIGINT PRIMARY KEY,
    sleep_id      TEXT,
    user_id       BIGINT,
    created_at    TIMESTAMP,
    updated_at    TIMESTAMP,
    score_state   TEXT,
    recovery_score DOUBLE,
    resting_heart_rate DOUBLE,
    hrv_rmssd_ms  DOUBLE,
    spo2_percentage DOUBLE,
    skin_temp_celsius DOUBLE,
    raw           JSON
);

CREATE TABLE IF NOT EXISTS whoop_sleeps (
    id            TEXT PRIMARY KEY,
    user_id       BIGINT,
    start         TIMESTAMP,
    "end"         TIMESTAMP,
    timezone_offset TEXT,
    nap           BOOLEAN,
    score_state   TEXT,
    sleep_performance DOUBLE,
    sleep_consistency DOUBLE,
    sleep_efficiency DOUBLE,
    respiratory_rate DOUBLE,
    raw           JSON
);

CREATE TABLE IF NOT EXISTS whoop_workouts (
    id            TEXT PRIMARY KEY,
    user_id       BIGINT,
    start         TIMESTAMP,
    "end"         TIMESTAMP,
    timezone_offset TEXT,
    sport_id      INTEGER,
    sport_name    TEXT,
    score_state   TEXT,
    strain        DOUBLE,
    average_hr    INTEGER,
    max_hr        INTEGER,
    kilojoule     DOUBLE,
    distance_meter DOUBLE,
    altitude_gain_meter DOUBLE,
    raw           JSON
);

CREATE TABLE IF NOT EXISTS strava_activities (
    id            BIGINT PRIMARY KEY,
    athlete_id    BIGINT,
    name          TEXT,
    type          TEXT,
    sport_type    TEXT,
    start_date    TIMESTAMP,
    start_date_local TIMESTAMP,
    timezone      TEXT,
    elapsed_time  INTEGER,
    moving_time   INTEGER,
    distance      DOUBLE,
    total_elevation_gain DOUBLE,
    average_speed DOUBLE,
    max_speed     DOUBLE,
    average_heartrate DOUBLE,
    max_heartrate DOUBLE,
    average_watts DOUBLE,
    weighted_average_watts DOUBLE,
    kilojoules    DOUBLE,
    device_watts  BOOLEAN,
    trainer       BOOLEAN,
    has_heartrate BOOLEAN,
    raw           JSON
);

CREATE TABLE IF NOT EXISTS strava_streams (
    activity_id   BIGINT,
    stream_type   TEXT,
    resolution    TEXT,
    series_type   TEXT,
    original_size INTEGER,
    data          JSON,
    PRIMARY KEY (activity_id, stream_type)
);

CREATE TABLE IF NOT EXISTS activity_links (
    strava_activity_id BIGINT,
    whoop_workout_id   TEXT,
    match_score        DOUBLE,
    linked_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (strava_activity_id, whoop_workout_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
    id            BIGINT PRIMARY KEY,
    provider      TEXT,
    started_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at   TIMESTAMP,
    status        TEXT,
    notes         TEXT
);
"""


def connect() -> duckdb.DuckDBPyConnection:
    WAREHOUSE_PATH.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(WAREHOUSE_PATH))


def init_schema() -> None:
    with connect() as con:
        con.execute(DDL)
