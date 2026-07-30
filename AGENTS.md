# Notes for agents working in this repo

Read this before running anything. It exists because `codex exec review` cannot be re-prompted
(`--base` refuses a prompt argument), so this file is the only steering a reviewer gets.

## What this is

A single-user local analytics pipeline: OAuth into WHOOP and Strava, backfill then incrementally sync
both into one local DuckDB warehouse, link WHOOP workouts to Strava activities by time overlap and
sport family, derive training-load metrics as SQL views (TRIMP, CTL/ATL/Form, readiness features), and
serve a Streamlit dashboard. Everything runs on this machine; a launchd agent runs `fm sync` daily.

## Running things

- **The interpreter is Python 3.12 via `uv`.** Always `uv run`, never bare `python`/`pytest` — the
  `fm` console script only resolves inside the project venv.
- Install: `uv sync` (CI: `uv sync --locked`).
- Lint: `uv run ruff check .` Format check: `uv run ruff format --check .` Test: `uv run pytest`.
  CI runs exactly those.
- Entry points: `uv run fm init-db`, `fm auth whoop|strava`, `fm backfill whoop|strava`, `fm link`,
  `fm sync`, `fm refresh-views`, `fm dashboard`, `fm info`.
- Ruff is both linter and formatter (`line-length = 100`, `select = ["E","F","I","UP","B","SIM"]`).
  **There is no type checker in CI**, despite heavy pydantic use — so type errors are the reviewer's
  job, not a tool's.

## Things that look like bugs and are not

- **CI deliberately swallows pytest exit code 5** ("no tests collected") with an inline comment
  saying to treat it as success until the suite exists. Do not report it as a trick — but note that
  deleting the only test file would still leave CI green.
- **`REPO_ROOT = Path(__file__).resolve().parents[2]`** is correct for the `src/fitness_metrics/`
  layout. It means data is written into the *repo* (`data/`) while tokens go to the OS config dir.
  That split is deliberate.
- **`12.36` in `storage/views.py` is a documented domain constant** — the WHOOP-strain→TRIMP fallback
  scaling, with hardcoded HR_rest 50 / HR_max 190 defaults because the APIs do not expose thresholds.
  Not a magic number to refactor away.
- **Every raw table carries a `raw JSON` column** duplicating parsed fields on purpose, so views can
  be re-derived without re-fetching the APIs. Not redundant storage to normalize away.
- **`WHOOP_LOOKBACK = timedelta(days=3)`** re-pulls a 3-day overlap past the high-water mark because
  WHOOP recalculates overnight scores. Combined with upserts this is intentional, not a
  duplicate-fetch bug.
- **WHOOP v2 API paths are mandatory** (`/v2/cycle`, `/v2/recovery`, `/v2/activity/*`); v1 returns 404.
  Sleep and workout ids are **UUIDs, not ints** — do not "fix" the types.
- **All views are `CREATE OR REPLACE VIEW`** and `fm refresh-views` is documented as safe to rerun.
  Idempotence is a design contract, not an accident.
- **`ratelimit.py` mixes two clocks deliberately**: `RollingWindow` uses `time.monotonic()` (immune to
  clock jumps) while `DailyUtcWindow` uses wall-clock UTC (must align to calendar midnight). The bare
  `print(...)` for long sleeps is intentional stall visibility, not stray debug output.
- **`link.py` scoring is `clamp(iou + sport_adjustment, 0, 1)`** — an additive heuristic on top of
  intersection-over-union, deliberately fuzzy.
- **The dashboard opens DuckDB `read_only=True`** and caches every query with a TTL, so it never locks
  a concurrent `fm sync`. Removing either would be the actual bug.

## Invariants worth knowing before judging a change

- **OAuth tokens live outside the repo**, in the platform config dir, written then `chmod 0o600`.
  Note the chmod happens *after* the write, so there is a brief default-umask window — a legitimate
  nit. Client credentials come from a gitignored `.env` at the repo root.
- **CSRF state is verified** in the OAuth flow (`secrets.token_urlsafe(16)`, compared on callback,
  raising on mismatch). A change that drops that comparison is a real security regression.
- **Leak surfaces to watch**: `fm info` prints credential *status* and must never print values;
  `_save_all` serializes token objects with `default=str`, so any future log or `repr` of a `TokenSet`
  would print secrets; launchd logs capture tracebacks, and an `httpx` traceback can carry auth
  headers.
- `data/`, `reports/` and the local `.env` are gitignored working-tree artifacts holding **personal
  health data** (heart rate, GPS, power) and secrets. They are not source — do not review, print, or
  quote their contents.

## Where the risk actually is

One test file (`tests/test_ratelimit.py`, 5 functions) covers pure rate-limit logic. OAuth, sync,
link, views and the dashboard — roughly 1,800 lines — have **no** coverage, no HTTP mocking, and no
`conftest.py`. One test pokes `w.day` directly to simulate a day rollover; that is a deliberate
white-box test, not a mistake.

Weight review attention toward: token handling and the OAuth flow, the sync high-water-mark and upsert
logic, and the linking heuristic. The bug class to watch hardest is **fail-open** — an error or
absence read as success, e.g. a failed fetch that advances a watermark, or an empty response treated
as "nothing new."
