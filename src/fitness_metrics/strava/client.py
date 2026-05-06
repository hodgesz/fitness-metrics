from datetime import UTC, datetime, timedelta

import httpx

from fitness_metrics.auth import tokens as token_store
from fitness_metrics.auth.oauth import refresh_token, run_auth_code_flow
from fitness_metrics.config import settings

AUTHORIZE_URL = "https://www.strava.com/oauth/authorize"
TOKEN_URL = "https://www.strava.com/oauth/token"
API_BASE = "https://www.strava.com/api/v3"
SCOPES = ["read", "activity:read_all", "profile:read_all"]

# Refresh slightly before actual expiry to avoid races.
REFRESH_LEEWAY = timedelta(minutes=2)


def authorize() -> None:
    redirect_uri = f"http://localhost:{settings.oauth_callback_port}/strava/callback"
    ts = run_auth_code_flow(
        authorize_url=AUTHORIZE_URL,
        token_url=TOKEN_URL,
        client_id=settings.strava_client_id,
        client_secret=settings.strava_client_secret,
        redirect_uri=redirect_uri,
        scope=",".join(SCOPES),
        extra_authorize_params={"approval_prompt": "auto"},
    )
    token_store.save("strava", ts)


def _current_access_token() -> str:
    ts = token_store.load("strava")
    if ts is None:
        raise RuntimeError("No Strava tokens — run `fm auth strava` first.")
    if ts.expires_at and ts.expires_at - REFRESH_LEEWAY <= datetime.now(UTC):
        if not ts.refresh_token:
            raise RuntimeError("Strava access token expired and no refresh token available.")
        ts = refresh_token(
            token_url=TOKEN_URL,
            client_id=settings.strava_client_id,
            client_secret=settings.strava_client_secret,
            refresh_token=ts.refresh_token,
        )
        token_store.save("strava", ts)
    return ts.access_token


class _TokenRefreshingAuth(httpx.Auth):
    """Attaches a fresh bearer token on every request, refreshing if needed."""

    requires_response_body = False

    def auth_flow(self, request):
        request.headers["Authorization"] = f"Bearer {_current_access_token()}"
        yield request


def client() -> httpx.Client:
    return httpx.Client(
        base_url=API_BASE,
        auth=_TokenRefreshingAuth(),
        timeout=30,
    )
