"""
GateLynk AI backend — configuration.

Wszystkie wartości można nadpisać przez env vars. Defaulty wskazują na
**lokalne środowisko GateLynk Edge na Mac Mini** + MacBook Pro Ollama LLM.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    # sqlite path — Edge production database na Mac Mini.
    # Read-only access (write blokowane w db.execute_safe).
    sqlite_path: str

    # Ollama HTTP — MacBook Pro przez LAN (existing setup).
    ollama_url: str
    ollama_model: str
    ollama_timeout_s: float

    # Logowanie.
    log_level: str

    # Hard limit na długość pytania, żeby ktoś nie wysłał 10 MB w body.
    max_question_chars: int

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            sqlite_path=os.environ.get(
                "SQLITE_PATH",
                "/Users/shc_development/gatelynk-edge/data/store.db",
            ),
            ollama_url=os.environ.get("OLLAMA_URL", "http://192.168.1.109:11434"),
            ollama_model=os.environ.get("OLLAMA_MODEL", "qwen2.5:14b"),
            ollama_timeout_s=float(os.environ.get("OLLAMA_TIMEOUT_S", "15")),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
            max_question_chars=int(os.environ.get("MAX_QUESTION_CHARS", "500")),
        )


CONFIG = Config.from_env()
