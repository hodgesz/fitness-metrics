# fitness-metrics

A personal analytics pipeline that pulls your **WHOOP** recovery/sleep/strain data
and your **Strava** activities into a single local [DuckDB](https://duckdb.org)
warehouse, links the two together, derives training-load metrics, and serves it
all through a [Streamlit](https://streamlit.io) dashboard.

Everything runs on your own machine. Your health data — heart rate, GPS, power,
HRV, sleep — never leaves your laptop, and the warehouse and OAuth tokens are
git-ignored.

---

## What it does

- **Authorizes** WHOOP and Strava once via OAuth; tokens are cached locally and
  refreshed automatically.
- **Backfills** your full history from both providers, then keeps it current with
  **incremental syncs** that only pull records newer than what's already stored.
- **Links** each WHOOP workout to its matching Strava activity by time overlap
  (intersection-over-union) plus sport compatibility, so a single ride shows both
  its GPS/power data and its WHOOP strain.
- **Derives training-load metrics** as SQL views on the raw data:
  - **TRIMP** (Training Impulse) per activity using a Banister-style formula from
    heart rate, with a WHOOP-strain fallback when HR is missing or implausible.
  - **CTL** (42-day load average → *fitness*), **ATL** (7-day → *fatigue*), and
    **Form** (CTL − ATL) over a gap-filled daily calendar.
  - **Daily readiness features** joining WHOOP recovery score, HRV, resting HR,
    SpO₂, skin temp, and sleep metrics against each day's and the prior day's load.
- **Visualizes** it in a Streamlit dashboard: today's recovery badge, training-load
  curves, a recovery-vs-prior-day-load scatter with trend line, and a recent-activity
  table.

## Architecture

```
WHOOP API  ─┐
            ├─►  sync / backfill  ──►  DuckDB warehouse  ──►  analytics views  ──►  Streamlit dashboard
Strava API ─┘     (incremental)        (data/warehouse.duckdb)   (v_* views)
                                              ▲
                                         link (IoU + sport)
```

| Layer | Where |
|-------|-------|
| Provider clients & OAuth | `src/fitness_metrics/whoop/`, `src/fitness_metrics/strava/`, `auth/` |
| Incremental sync | `src/fitness_metrics/sync.py` |
| WHOOP↔Strava linking | `src/fitness_metrics/link.py` |
| Warehouse schema | `src/fitness_metrics/storage/schema.py` |
| Analytics views (TRIMP, CTL/ATL/Form, readiness) | `src/fitness_metrics/storage/views.py` |
| Dashboard | `src/fitness_metrics/dashboard.py` |
| CLI | `src/fitness_metrics/cli.py` |
| Scheduled sync (macOS launchd) | `scripts/launchd/` |

Raw API payloads are preserved in a `raw` JSON column on every table, so views can
be re-derived without re-fetching.

## Requirements

- Python ≥ 3.12
- [uv](https://docs.astral.sh/uv/) for dependency and environment management
- A Strava API application — https://www.strava.com/settings/api
- A WHOOP developer application — https://developer.whoop.com/

## Setup

```bash
# 1. Install dependencies into a local virtualenv
uv sync

# 2. Configure credentials
cp .env.example .env
#   then edit .env and fill in your Strava + WHOOP client id/secret

# 3. Create the warehouse tables and analytics views
uv run fm init-db

# 4. Authorize each provider (opens a browser; tokens cached locally)
uv run fm auth strava
uv run fm auth whoop

# 5. Pull your full history (one-time)
uv run fm backfill strava
uv run fm backfill whoop

# 6. Link workouts to activities
uv run fm link
```

### Configuration

Settings come from `.env` (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` | Strava API app credentials |
| `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` | WHOOP API app credentials |
| `OAUTH_CALLBACK_PORT` | Local port both providers redirect to during auth (default `8765`) |

Data and token locations:

- Warehouse: `data/warehouse.duckdb`
- Raw cache: `data/raw/`
- OAuth tokens: platform config dir (e.g. `~/Library/Application Support/fitness-metrics/tokens.json`)

Run `uv run fm info` to print the resolved paths and confirm which credentials are set.

## Usage

### Keep data current

```bash
uv run fm sync                  # incremental sync of both providers, then re-link
uv run fm sync --skip-strava    # WHOOP only
uv run fm sync --skip-if-within 60   # no-op if both synced OK within the last 60 min
```

`sync` is idempotent: it reads each table's high-water mark and pulls only newer
records (with a small lookback overlap so WHOOP's overnight recalculations still
upsert). Every run is recorded in the `sync_runs` table.

### View the dashboard

```bash
uv run fm dashboard             # serves at http://localhost:8501
uv run fm dashboard --port 8502 # alternate port
```

Then open **http://localhost:8501** in your browser. The dashboard reads the
warehouse read-only and caches queries for 60s.

### CLI reference

| Command | Description |
|---------|-------------|
| `fm info` | Show resolved data/token paths and credential status |
| `fm init-db` | Create warehouse tables and install analytics views |
| `fm refresh-views` | Re-create all views (`CREATE OR REPLACE`); safe to rerun |
| `fm auth strava` / `fm auth whoop` | One-time OAuth authorization |
| `fm backfill strava [--limit N]` | One-time historical pull from Strava |
| `fm backfill whoop` | One-time historical pull from WHOOP |
| `fm link` | Match WHOOP workouts to Strava activities |
| `fm sync [--skip-whoop] [--skip-strava] [--skip-link] [--skip-if-within MIN]` | Incremental sync of both providers, then re-link |
| `fm dashboard [--port N]` | Launch the Streamlit dashboard |

## Scheduled sync (macOS)

A launchd agent runs `fm sync` daily at 05:00 local time.

```bash
scripts/launchd/install.sh      # install / reinstall the agent (idempotent)
scripts/launchd/uninstall.sh    # remove it

# Trigger a run immediately:
launchctl kickstart gui/$(id -u)/com.hodgesz.fitness-metrics-sync
```

Logs are written to `~/Library/Logs/fitness-metrics/sync.log` (stdout) and
`sync.err` (stderr). The agent uses `--skip-if-within` so a wake-from-sleep
catch-up fire won't double-sync.

> The dashboard is **not** auto-started on login — after a reboot, start it with
> `uv run fm dashboard`.

## Metrics glossary

- **TRIMP** — Training Impulse. Per-activity load from duration × heart-rate
  reserve fraction, weighted exponentially (Banister). Uses conservative defaults
  (HR_rest 50, HR_max 190) since the APIs don't expose thresholds; falls back to
  `12.36 × WHOOP strain` when HR is missing or implausibly low.
- **CTL** — Chronic Training Load: 42-day rolling average of daily TRIMP. A proxy
  for *fitness*.
- **ATL** — Acute Training Load: 7-day rolling average of daily TRIMP. A proxy for
  *fatigue*.
- **Form (TSB)** — CTL − ATL. Positive = fresh, negative = fatigued.
- **Recovery / HRV / RHR / Sleep performance** — taken directly from WHOOP.

## Data model

Raw tables: `whoop_cycles`, `whoop_recoveries`, `whoop_sleeps`, `whoop_workouts`,
`strava_activities`, `strava_streams`, `activity_links`, `sync_runs`.

Analytics views:

- `v_activity_combined` — one row per Strava activity with linked WHOOP fields and TRIMP.
- `v_daily_load` — daily TRIMP with rolling CTL/ATL/Form over a gap-filled calendar.
- `v_daily_features` — daily readiness features (recovery, sleep, HRV) joined to load.

## Development

```bash
uv run pytest        # tests
uv run ruff check    # lint
uv run ruff format   # format
```

## Notes & limitations

- The WHOOP API does **not** expose continuous heart-rate streams, so per-activity
  HR-based TRIMP comes from Strava; WHOOP strain is the fallback.
- WHOOP API v2 is used for recovery/sleep/workout endpoints (v1 returns 404), and
  sleep/workout IDs are UUIDs.
- This is a single-user personal tool; there's no multi-user auth or hosting story.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
