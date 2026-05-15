from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="VS_ENGINE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    log_level: str = "info"
    spacy_model: str = "en_core_web_lg"
    default_language: str = "en"
    # Phase 2 default per BUILD_PLAN; gateway may set lower per-tenant limits.
    max_request_bytes: int = 256 * 1024
    # Bind only on the loopback in non-container runs; Docker overrides to 0.0.0.0.
    host: str = "127.0.0.1"
    port: int = 8000


def load_settings() -> Settings:
    return Settings()
