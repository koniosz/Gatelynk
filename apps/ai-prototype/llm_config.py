"""
Dynamic LLM config — czyta z Edge `/ai-engine` REST endpoint zamiast env.

FAZA 8.h.11 (2026-06-09) — zjednoczenie konfiguracji LLM dla iOS Assistant
(ai-prototype) z Vision Summarizer (Edge Node). Integrator zmienia model
w Cloud Integrator UI → tunel push do Edge `ai_engines` table → Edge REST
endpoint `/ai-engine` zwraca świeży config → ai-prototype czyta przy każdym
30-sekundowym oknie cache.

Bez tego module: zmiana modelu w Cloud UI wpływa TYLKO na VisionLlmSummarizer
(Edge Node), ale iOS Assistant przez ai-prototype dalej używał env-var
hardcoded (qwen2.5:14b).

Z tym module: 1 zmiana w Cloud UI → wszyscy korzystają z Bielika.

Fallback: gdy Edge REST nieosiągalny (rare — local HTTP), używamy CONFIG.ollama_*
z env vars (backwards compat).
"""
from __future__ import annotations

import logging
import time
from typing import NamedTuple

import httpx

from config import CONFIG

log = logging.getLogger(__name__)


class LlmConfig(NamedTuple):
    url: str
    model: str
    enabled: bool
    source: str  # 'edge_db' | 'env_fallback'


_EDGE_AI_ENGINE_URL = "http://localhost:4000/ai-engine"
_CACHE_TTL_SEC = 30.0
_CACHE: dict[str, object] = {"ts": 0.0, "config": None}


def _fetch_from_edge() -> LlmConfig | None:
    """Single fetch z Edge REST. Returns None on any error — caller falls back."""
    try:
        with httpx.Client(timeout=2.0) as client:
            r = client.get(_EDGE_AI_ENGINE_URL)
            if r.status_code != 200:
                return None
            data = r.json()
            # FAZA 8.h.7 response shape: { ..., llmUrl, llmModel, llmEnabled, llmSource, ... }
            url = data.get("llmUrl") or data.get("llmEnvFallbackUrl") or CONFIG.ollama_url
            model = data.get("llmModel") or CONFIG.ollama_model
            enabled = bool(data.get("llmEnabled", True))
            # Strip trailing slash defensively (Cloud may or may not).
            url = url.rstrip("/") if isinstance(url, str) else CONFIG.ollama_url
            return LlmConfig(url=url, model=model, enabled=enabled, source="edge_db")
    except (httpx.RequestError, httpx.HTTPError, ValueError, KeyError) as e:
        log.debug("LLM config fetch from Edge failed (%s) — using env fallback", e)
        return None


def get_active_llm() -> LlmConfig:
    """
    Zwraca aktywny LLM config. Cache 30s żeby nie pollu-ować Edge REST
    przy każdym /ask request (typowy bursy 5-10 req/s w peak).

    Priority:
      1. Edge `/ai-engine` REST (FAZA 8.h.7 — config kontrolowany z Cloud Integrator UI)
      2. Env vars (CONFIG.ollama_url + CONFIG.ollama_model) — backwards compat
    """
    now = time.time()
    cached = _CACHE.get("config")
    cached_ts = _CACHE.get("ts", 0.0)
    if cached and (now - cached_ts) < _CACHE_TTL_SEC:
        return cached  # type: ignore[return-value]

    fresh = _fetch_from_edge()
    if fresh is None:
        # Fallback do env (ale dalej cachujemy żeby uniknąć retry-storm).
        fresh = LlmConfig(
            url=CONFIG.ollama_url,
            model=CONFIG.ollama_model,
            enabled=True,
            source="env_fallback",
        )

    _CACHE["config"] = fresh
    _CACHE["ts"] = now
    return fresh
