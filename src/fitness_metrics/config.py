from pathlib import Path

from platformdirs import user_config_dir
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
WAREHOUSE_PATH = DATA_DIR / "warehouse.duckdb"

TOKENS_DIR = Path(user_config_dir("fitness-metrics"))
TOKENS_PATH = TOKENS_DIR / "tokens.json"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    strava_client_id: str = Field(default="")
    strava_client_secret: str = Field(default="")
    whoop_client_id: str = Field(default="")
    whoop_client_secret: str = Field(default="")
    oauth_callback_port: int = 8765


settings = Settings()
