"""Streamlit dashboard for the fitness-metrics warehouse.

Run via: `uv run fm dashboard` (launches `streamlit run` under the hood)
or:     `uv run streamlit run src/fitness_metrics/dashboard.py`
"""

from __future__ import annotations

import altair as alt
import duckdb
import pandas as pd
import streamlit as st

from fitness_metrics.config import WAREHOUSE_PATH


@st.cache_data(ttl=60)
def load_daily_features() -> pd.DataFrame:
    with duckdb.connect(str(WAREHOUSE_PATH), read_only=True) as con:
        return con.execute("SELECT * FROM v_daily_features ORDER BY d").fetchdf()


@st.cache_data(ttl=60)
def load_daily_load() -> pd.DataFrame:
    with duckdb.connect(str(WAREHOUSE_PATH), read_only=True) as con:
        return con.execute("SELECT * FROM v_daily_load ORDER BY activity_date").fetchdf()


@st.cache_data(ttl=60)
def load_recent_activities(n: int = 25) -> pd.DataFrame:
    with duckdb.connect(str(WAREHOUSE_PATH), read_only=True) as con:
        return con.execute(
            """
            SELECT activity_date, strava_sport, title,
                   ROUND(distance_m/1000.0, 1) AS km,
                   moving_s / 60 AS minutes,
                   ROUND(elevation_m, 0) AS elev_m,
                   avg_hr, avg_watts,
                   ROUND(trimp_estimate, 0) AS trimp,
                   trimp_source,
                   whoop_sport,
                   ROUND(whoop_strain, 1) AS strain,
                   ROUND(match_score, 2) AS match
            FROM v_activity_combined
            ORDER BY start_utc DESC
            LIMIT ?
            """,
            [n],
        ).fetchdf()


def _readiness_badge(recovery: float | None) -> tuple[str, str]:
    if recovery is None:
        return ("—", "gray")
    if recovery >= 67:
        return ("GREEN", "#16a34a")
    if recovery >= 34:
        return ("YELLOW", "#eab308")
    return ("RED", "#dc2626")


def _render_today(feats: pd.DataFrame) -> None:
    if feats.empty:
        st.info("No data yet — run `fm sync`.")
        return
    latest = feats.iloc[-1]
    badge_text, badge_color = _readiness_badge(latest.get("recovery_score"))

    st.markdown(
        f"<div style='display:inline-block;padding:4px 12px;border-radius:6px;"
        f"background:{badge_color};color:white;font-weight:700;'>"
        f"{badge_text} — {latest['d']}</div>",
        unsafe_allow_html=True,
    )
    st.markdown("<br>", unsafe_allow_html=True)

    def _fmt(col: str, spec: str = ".0f") -> str:
        v = latest.get(col)
        return f"{v:{spec}}" if pd.notna(v) else "—"

    cols = st.columns(6)
    cols[0].metric("Recovery", _fmt("recovery_score"))
    cols[1].metric("HRV (ms)", _fmt("hrv_rmssd_ms"))
    cols[2].metric("RHR", _fmt("resting_heart_rate"))
    cols[3].metric("Sleep perf", _fmt("sleep_performance"))
    cols[4].metric("Form", _fmt("form", "+.1f"))
    cols[5].metric("CTL", _fmt("ctl_42d"))


def _render_load(load: pd.DataFrame) -> None:
    if load.empty:
        return
    window_days = st.slider("Window (days)", min_value=30, max_value=365, value=180, step=30)
    df = load.tail(window_days).copy()
    df["activity_date"] = pd.to_datetime(df["activity_date"])

    bars = (
        alt.Chart(df)
        .mark_bar(opacity=0.4)
        .encode(
            x=alt.X("activity_date:T", title=None),
            y=alt.Y("day_trimp:Q", title="TRIMP"),
            tooltip=["activity_date:T", "day_trimp:Q", "n_activities:Q"],
        )
    )
    ctl = alt.Chart(df).mark_line(color="#2563eb", strokeWidth=2).encode(
        x="activity_date:T", y=alt.Y("ctl_42d:Q", title="CTL (42d)"),
    )
    atl = alt.Chart(df).mark_line(color="#dc2626", strokeWidth=1.5).encode(
        x="activity_date:T", y="atl_7d:Q",
    )
    form_area = (
        alt.Chart(df)
        .mark_area(opacity=0.25)
        .encode(
            x="activity_date:T",
            y=alt.Y("form:Q", title="Form"),
            color=alt.condition(
                alt.datum.form < 0,
                alt.value("#dc2626"),
                alt.value("#16a34a"),
            ),
        )
    )
    st.altair_chart(
        alt.layer(bars, ctl, atl).resolve_scale(y="independent").properties(height=260),
        use_container_width=True,
    )
    st.caption("Blue line = CTL (42d fitness). Red line = ATL (7d fatigue). Bars = daily TRIMP.")
    st.altair_chart(form_area.properties(height=120), use_container_width=True)
    st.caption("Form = CTL − ATL. Red = fatigued, green = fresh.")


def _render_recovery_vs_load(feats: pd.DataFrame) -> None:
    df = feats.dropna(subset=["recovery_score", "prev_day_trimp"]).copy()
    if df.empty:
        st.info("Not enough paired data yet.")
        return
    df["d"] = pd.to_datetime(df["d"])
    chart = (
        alt.Chart(df)
        .mark_circle(size=70, opacity=0.7)
        .encode(
            x=alt.X("prev_day_trimp:Q", title="Prior day TRIMP"),
            y=alt.Y("recovery_score:Q", title="Recovery score", scale=alt.Scale(domain=[0, 100])),
            color=alt.Color("d:T", title="Date"),
            tooltip=["d:T", "prev_day_trimp:Q", "recovery_score:Q", "hrv_rmssd_ms:Q"],
        )
        .properties(height=320)
    )
    trend = chart.transform_regression(
        "prev_day_trimp", "recovery_score"
    ).mark_line(color="#64748b")
    st.altair_chart(chart + trend, use_container_width=True)


def main() -> None:
    st.set_page_config(page_title="fitness-metrics", layout="wide")
    st.title("fitness-metrics")

    feats = load_daily_features()
    load = load_daily_load()

    st.subheader("Today")
    _render_today(feats)

    st.subheader("Training load over time")
    _render_load(load)

    st.subheader("Recovery vs. prior-day load")
    _render_recovery_vs_load(feats)

    st.subheader("Recent activities")
    st.dataframe(load_recent_activities(25), use_container_width=True, hide_index=True)


if __name__ == "__main__":
    main()
