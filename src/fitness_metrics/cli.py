import click
from rich.console import Console

from fitness_metrics.config import RAW_DIR, TOKENS_PATH, WAREHOUSE_PATH, settings
from fitness_metrics.storage.schema import init_schema

console = Console()


@click.group()
def cli() -> None:
    """fitness-metrics CLI."""


@cli.command()
def info() -> None:
    """Show where this project reads and writes."""
    console.print(f"[bold]Warehouse:[/bold] {WAREHOUSE_PATH}")
    console.print(f"[bold]Raw dir:[/bold]   {RAW_DIR}")
    console.print(f"[bold]Tokens:[/bold]    {TOKENS_PATH}")
    console.print(f"[bold]Callback port:[/bold] {settings.oauth_callback_port}")
    console.print(
        f"[bold]Strava client id set:[/bold] {bool(settings.strava_client_id)}  "
        f"[bold]Whoop client id set:[/bold] {bool(settings.whoop_client_id)}"
    )


@cli.command("init-db")
def init_db() -> None:
    """Create the DuckDB warehouse tables and analytics views."""
    from fitness_metrics.storage.views import install_views

    init_schema()
    install_views()
    console.print(f"[green]Initialized warehouse at {WAREHOUSE_PATH}[/green]")


@cli.command("refresh-views")
def refresh_views() -> None:
    """Re-create all analytics views (CREATE OR REPLACE). Safe to rerun."""
    from fitness_metrics.storage.views import install_views

    install_views()
    console.print("[green]Views refreshed.[/green]")


@cli.command()
@click.option("--port", type=int, default=8501, show_default=True)
def dashboard(port: int) -> None:
    """Launch the Streamlit dashboard at http://localhost:<port>."""
    import subprocess
    import sys
    from pathlib import Path

    script = Path(__file__).parent / "dashboard.py"
    subprocess.run(
        [sys.executable, "-m", "streamlit", "run", str(script), "--server.port", str(port)],
        check=True,
    )


@cli.group()
def auth() -> None:
    """OAuth: authorize providers once; tokens are cached locally."""


@auth.command("whoop")
def auth_whoop() -> None:
    from fitness_metrics.whoop.client import authorize

    authorize()
    console.print("[green]Whoop authorized.[/green]")


@auth.command("strava")
def auth_strava() -> None:
    from fitness_metrics.strava.client import authorize

    authorize()
    console.print("[green]Strava authorized.[/green]")


@cli.group()
def backfill() -> None:
    """One-time historical pulls from provider APIs."""


@backfill.command("whoop")
def backfill_whoop() -> None:
    from fitness_metrics.whoop.backfill import run

    run()


@backfill.command("strava")
@click.option("--limit", type=int, default=None, help="Hydrate only the first N activities.")
def backfill_strava(limit: int | None) -> None:
    from fitness_metrics.strava.backfill import run

    run(limit=limit)


@cli.command()
def link() -> None:
    """Match Whoop workouts to Strava activities by time overlap + sport."""
    from fitness_metrics.link import run

    run()


@cli.command()
@click.option("--skip-whoop", is_flag=True)
@click.option("--skip-strava", is_flag=True)
@click.option("--skip-link", is_flag=True)
@click.option(
    "--skip-if-within",
    type=int,
    default=None,
    metavar="MINUTES",
    help="Exit early if both providers were synced successfully within this window.",
)
def sync(
    skip_whoop: bool, skip_strava: bool, skip_link: bool, skip_if_within: int | None
) -> None:
    """Incremental sync from both providers, then re-link."""
    from fitness_metrics.sync import run

    run(
        skip_whoop=skip_whoop,
        skip_strava=skip_strava,
        skip_link=skip_link,
        skip_if_within_minutes=skip_if_within,
    )


if __name__ == "__main__":
    cli()
