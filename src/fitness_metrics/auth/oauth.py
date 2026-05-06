import secrets
import threading
import webbrowser
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from fitness_metrics.auth.tokens import TokenSet
from fitness_metrics.config import settings


class _CallbackHandler(BaseHTTPRequestHandler):
    result: dict = {}

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        _CallbackHandler.result = params
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            b"<h2>Authorized.</h2><p>You can close this tab and return to the terminal.</p>"
        )

    def log_message(self, *_):  # silence stderr access logs
        return


def _wait_for_callback(path_prefix: str) -> dict:
    server = HTTPServer(("127.0.0.1", settings.oauth_callback_port), _CallbackHandler)
    _CallbackHandler.result = {}
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    thread.join(timeout=300)
    server.server_close()
    if not _CallbackHandler.result:
        raise RuntimeError(f"OAuth callback timed out waiting on {path_prefix}")
    return _CallbackHandler.result


def run_auth_code_flow(
    *,
    authorize_url: str,
    token_url: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    scope: str,
    extra_authorize_params: dict | None = None,
) -> TokenSet:
    state = secrets.token_urlsafe(16)
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state,
        **(extra_authorize_params or {}),
    }
    url = f"{authorize_url}?{urlencode(params)}"
    webbrowser.open(url)
    print(f"If the browser didn't open, visit:\n  {url}")

    callback = _wait_for_callback(redirect_uri)
    if callback.get("state") != state:
        raise RuntimeError("OAuth state mismatch — possible CSRF, aborting.")
    if "error" in callback:
        err = callback["error"]
        desc = callback.get("error_description", "")
        raise RuntimeError(f"OAuth error: {err} {desc}")
    code = callback["code"]

    resp = httpx.post(
        token_url,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
        },
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()
    return _token_from_response(payload)


def refresh_token(
    *,
    token_url: str,
    client_id: str,
    client_secret: str,
    refresh_token: str,
) -> TokenSet:
    resp = httpx.post(
        token_url,
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return _token_from_response(resp.json())


def _token_from_response(payload: dict) -> TokenSet:
    expires_at = None
    if "expires_at" in payload:
        expires_at = datetime.fromtimestamp(int(payload["expires_at"]), tz=UTC)
    elif "expires_in" in payload:
        expires_at = datetime.now(UTC) + timedelta(seconds=int(payload["expires_in"]))
    return TokenSet(
        access_token=payload["access_token"],
        refresh_token=payload.get("refresh_token"),
        expires_at=expires_at,
        scope=payload.get("scope"),
        token_type=payload.get("token_type", "Bearer"),
    )
