import json
import os
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from fitness_metrics.config import TOKENS_DIR, TOKENS_PATH

Provider = Literal["whoop", "strava"]


class TokenSet(BaseModel):
    access_token: str
    refresh_token: str | None = None
    expires_at: datetime | None = None
    scope: str | None = None
    token_type: str = "Bearer"


def _load_all() -> dict[str, dict]:
    if not TOKENS_PATH.exists():
        return {}
    return json.loads(TOKENS_PATH.read_text())


def _save_all(data: dict[str, dict]) -> None:
    TOKENS_DIR.mkdir(parents=True, exist_ok=True)
    TOKENS_PATH.write_text(json.dumps(data, default=str, indent=2))
    os.chmod(TOKENS_PATH, 0o600)


def load(provider: Provider) -> TokenSet | None:
    data = _load_all().get(provider)
    return TokenSet.model_validate(data) if data else None


def save(provider: Provider, tokens: TokenSet) -> None:
    data = _load_all()
    data[provider] = tokens.model_dump(mode="json")
    _save_all(data)
