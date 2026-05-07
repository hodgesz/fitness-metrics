"""Analytics views on top of the raw warehouse tables.

All views are non-materialized — fast enough at thousands of rows, and a simple
CREATE OR REPLACE on schema changes.
"""

VIEWS = r"""
-- One row per Strava activity, with linked Whoop workout fields and a TRIMP estimate.
-- TRIMP here is the Banister-style formula: duration_min * avg_hr_fraction * exp(1.92 * frac).
-- avg_hr_fraction is (avg_hr - HR_rest) / (HR_max - HR_rest). We use conservative defaults
-- (HR_rest=50, HR_max=190) since the API doesn't give us thresholds.
CREATE OR REPLACE VIEW v_activity_combined AS
WITH hr_model AS (
    -- HR_min is the "looks like a real reading" threshold. Strava occasionally
    -- reports bogus values like 1.0 when an HR sensor drops, and we'd rather
    -- fall back to Whoop strain than trust those.
    SELECT 50.0 AS hr_rest, 190.0 AS hr_max, 40.0 AS hr_min
)
SELECT
    s.id                              AS strava_id,
    s.start_date                      AS start_utc,
    s.start_date_local                AS start_local,
    s.start_date_local::DATE          AS activity_date,
    s.sport_type                      AS strava_sport,
    s.name                            AS title,
    s.distance                        AS distance_m,
    s.moving_time                     AS moving_s,
    s.elapsed_time                    AS elapsed_s,
    s.total_elevation_gain            AS elevation_m,
    s.average_heartrate               AS avg_hr,
    s.max_heartrate                   AS max_hr,
    s.average_watts                   AS avg_watts,
    s.weighted_average_watts          AS np_watts,
    s.kilojoules                      AS kilojoules,
    s.device_watts                    AS has_device_power,
    s.trainer                         AS is_trainer,
    -- TRIMP, only where HR is known AND looks plausible (> hr_min).
    CASE WHEN s.average_heartrate > (SELECT hr_min FROM hr_model) AND s.moving_time > 0 THEN
        (s.moving_time / 60.0)
        * GREATEST(0, (s.average_heartrate - (SELECT hr_rest FROM hr_model))
            / ((SELECT hr_max FROM hr_model) - (SELECT hr_rest FROM hr_model)))
        * EXP(1.92 * GREATEST(0, (s.average_heartrate - (SELECT hr_rest FROM hr_model))
            / ((SELECT hr_max FROM hr_model) - (SELECT hr_rest FROM hr_model))))
    END AS trimp,
    -- Link + Whoop fields (NULL if not linked)
    l.match_score,
    w.id                              AS whoop_workout_id,
    w.sport_name                      AS whoop_sport,
    w.strain                          AS whoop_strain,
    w.average_hr                      AS whoop_avg_hr,
    w.max_hr                          AS whoop_max_hr,
    w.kilojoule                       AS whoop_kilojoules,
    w.distance_meter                  AS whoop_distance_m,
    -- TRIMP with Whoop strain fallback. 12.36 is the best-fit scaling from
    -- paired sessions (see analysis in commit adding this column).
    CASE
        WHEN s.average_heartrate > (SELECT hr_min FROM hr_model) AND s.moving_time > 0 THEN
            (s.moving_time / 60.0)
            * GREATEST(0, (s.average_heartrate - (SELECT hr_rest FROM hr_model))
                / ((SELECT hr_max FROM hr_model) - (SELECT hr_rest FROM hr_model)))
            * EXP(1.92 * GREATEST(0, (s.average_heartrate - (SELECT hr_rest FROM hr_model))
                / ((SELECT hr_max FROM hr_model) - (SELECT hr_rest FROM hr_model))))
        WHEN w.strain IS NOT NULL THEN 12.36 * w.strain
    END AS trimp_estimate,
    CASE
        WHEN s.average_heartrate > (SELECT hr_min FROM hr_model) THEN 'hr'
        WHEN w.strain IS NOT NULL THEN 'whoop_strain'
        ELSE NULL
    END AS trimp_source
FROM strava_activities s
LEFT JOIN activity_links l ON l.strava_activity_id = s.id
LEFT JOIN whoop_workouts w ON w.id = l.whoop_workout_id;


-- Per-activity training load with rolling CTL/ATL/form.
-- CTL = 42-day exponentially weighted average of daily TRIMP (fitness).
-- ATL = 7-day  EWM of daily TRIMP (fatigue).
-- form = CTL - ATL.
-- DuckDB doesn't have EWM windows natively, so we approximate with simple rolling sums.
CREATE OR REPLACE VIEW v_daily_load AS
WITH daily AS (
    SELECT
        activity_date,
        SUM(COALESCE(trimp_estimate, 0)) AS day_trimp,
        SUM(COALESCE(whoop_strain, 0))  AS day_whoop_strain,
        SUM(distance_m)                 AS day_distance_m,
        SUM(moving_s)                   AS day_moving_s,
        SUM(elevation_m)                AS day_elevation_m,
        COUNT(*)                        AS n_activities
    FROM v_activity_combined
    GROUP BY activity_date
),
dense AS (
    -- Fill gap days with 0 so rolling windows are calendar-day correct.
    SELECT gs::DATE AS d
    FROM generate_series(
        (SELECT MIN(activity_date) FROM daily),
        (SELECT MAX(activity_date) FROM daily),
        INTERVAL 1 DAY
    ) AS t(gs)
)
SELECT
    dense.d AS activity_date,
    COALESCE(daily.day_trimp, 0)        AS day_trimp,
    COALESCE(daily.day_whoop_strain, 0) AS day_whoop_strain,
    COALESCE(daily.day_distance_m, 0)   AS day_distance_m,
    COALESCE(daily.day_moving_s, 0)     AS day_moving_s,
    COALESCE(daily.day_elevation_m, 0)  AS day_elevation_m,
    COALESCE(daily.n_activities, 0)     AS n_activities,
    AVG(COALESCE(daily.day_trimp, 0))
        OVER (ORDER BY dense.d ROWS BETWEEN 41 PRECEDING AND CURRENT ROW)   AS ctl_42d,
    AVG(COALESCE(daily.day_trimp, 0))
        OVER (ORDER BY dense.d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)    AS atl_7d,
    AVG(COALESCE(daily.day_trimp, 0))
        OVER (ORDER BY dense.d ROWS BETWEEN 41 PRECEDING AND CURRENT ROW)
      - AVG(COALESCE(daily.day_trimp, 0))
        OVER (ORDER BY dense.d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)    AS form
FROM dense
LEFT JOIN daily ON daily.activity_date = dense.d;


-- Daily readiness features: Whoop recovery context + prior-day load.
CREATE OR REPLACE VIEW v_daily_features AS
WITH recovery AS (
    SELECT
        DATE_TRUNC('day', created_at)::DATE AS d,
        recovery_score,
        resting_heart_rate,
        hrv_rmssd_ms,
        spo2_percentage,
        skin_temp_celsius
    FROM whoop_recoveries
),
sleep AS (
    -- A "sleep" night is assigned to the wake-up date (end).
    SELECT
        DATE_TRUNC('day', "end")::DATE AS d,
        sleep_performance,
        sleep_efficiency,
        sleep_consistency,
        respiratory_rate,
        EXTRACT(EPOCH FROM ("end" - start)) / 3600.0 AS hours_in_bed
    FROM whoop_sleeps
    WHERE NOT COALESCE(nap, FALSE)
),
cycle_strain AS (
    SELECT
        DATE_TRUNC('day', start)::DATE AS d,
        strain AS day_cycle_strain
    FROM whoop_cycles
),
load AS (SELECT * FROM v_daily_load)
SELECT
    l.activity_date                                     AS d,
    r.recovery_score,
    r.resting_heart_rate,
    r.hrv_rmssd_ms,
    r.spo2_percentage,
    r.skin_temp_celsius,
    s.sleep_performance,
    s.sleep_efficiency,
    s.sleep_consistency,
    s.respiratory_rate,
    s.hours_in_bed,
    cs.day_cycle_strain,
    l.day_trimp,
    l.day_whoop_strain,
    l.day_distance_m,
    l.day_moving_s,
    l.day_elevation_m,
    l.n_activities,
    l.ctl_42d,
    l.atl_7d,
    l.form,
    -- Prior day's load drives today's recovery
    LAG(l.day_trimp)        OVER (ORDER BY l.activity_date) AS prev_day_trimp,
    LAG(l.day_whoop_strain) OVER (ORDER BY l.activity_date) AS prev_day_whoop_strain
FROM load l
LEFT JOIN recovery r     ON r.d = l.activity_date
LEFT JOIN sleep s        ON s.d = l.activity_date
LEFT JOIN cycle_strain cs ON cs.d = l.activity_date;
"""


def install_views() -> None:
    from fitness_metrics.storage.schema import connect
    with connect() as con:
        con.execute(VIEWS)
