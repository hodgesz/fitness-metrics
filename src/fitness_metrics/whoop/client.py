from datetime import UTC, datetime, timedelta

import httpx

from fitness_metrics.auth import tokens as token_store
from fitness_metrics.auth.oauth import refresh_token, run_auth_code_flow
from fitness_metrics.config import settings

AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
API_BASE = "https://api.prod.whoop.com/developer"

CYCLE_PATH = "/v2/cycle"
RECOVERY_PATH = "/v2/recovery"
SLEEP_PATH = "/v2/activity/sleep"
WORKOUT_PATH = "/v2/activity/workout"

SCOPES = [
    "read:recovery",
    "read:cycles",
    "read:workout",
    "read:sleep",
    "read:profile",
    "read:body_measurement",
    "offline",
]

REFRESH_LEEWAY = timedelta(minutes=2)


def authorize() -> None:
    redirect_uri = f"http://localhost:{settings.oauth_callback_port}/whoop/callback"
    ts = run_auth_code_flow(
        authorize_url=AUTHORIZE_URL,
        token_url=TOKEN_URL,
        client_id=settings.whoop_client_id,
        client_secret=settings.whoop_client_secret,
        redirect_uri=redirect_uri,
        scope=" ".join(SCOPES),
    )
    token_store.save("whoop", ts)


def _current_access_token() -> str:
    ts = token_store.load("whoop")
    if ts is None:
        raise RuntimeError("No Whoop tokens — run `fm auth whoop` first.")
    if ts.expires_at and ts.expires_at - REFRESH_LEEWAY <= datetime.now(UTC):
        if not ts.refresh_token:
            raise RuntimeError("Whoop access token expired and no refresh token available.")
        ts = refresh_token(
            token_url=TOKEN_URL,
            client_id=settings.whoop_client_id,
            client_secret=settings.whoop_client_secret,
            refresh_token=ts.refresh_token,
        )
        token_store.save("whoop", ts)
    return ts.access_token


class _TokenRefreshingAuth(httpx.Auth):
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
