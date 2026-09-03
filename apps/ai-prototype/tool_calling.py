"""
Tool-calling fallback — Bielik jako router intentów (ETAP 3, 2026-06-11).

Gdy classify_regex nie matchnie, zamiast (lub przed) single-shot JSON
classification (classify_llm), wysyłamy do Ollama `/api/chat` definicje
tools wygenerowane z `intents_registry.yaml`:

    name        = intent
    description = description z rejestru
    parameters  = JSON schema z params (enum-y rozwiązywane ze słowników
                  intent_classifier: BRAND_KEYWORD_MAP / VALID_COLORS / …)

Bezpieczeństwo:
  • tool name MUSI być w VALID_INTENTS — inaczej odrzucamy,
  • argumenty przechodzą przez istniejący intent_classifier.validate()
    (canonical form + enum whitelisty) — LLM NIGDY nie pisze SQL,
    tylko wybiera template z sql_templates.py,
  • każdy błąd (HTTP / brak tool_call / nieznany tool) → None,
    caller (classify) leci dalej fallback chainem: classify_llm → unknown.

Feature flag: TOOL_CALLING_ENABLED (env, default FALSE — opt-in).
Nie każdy model w Ollama wspiera tool calling (wymaga template z sekcją
tools); Bielik 11B v2.3 NIE ma jej w oficjalnym template SpeakLeash —
patrz wynik testu w raporcie sprintu. Włączenie: TOOL_CALLING_ENABLED=true
w env uvicorna na Edge.

Python 3.9-compatible (Optional[X], bez PEP 604 w runtime).
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

import httpx

from config import CONFIG

log = logging.getLogger(__name__)

TOOL_CALLING_ENABLED = os.environ.get("TOOL_CALLING_ENABLED", "false").strip().lower() in (
    "1", "true", "yes", "on",
)

# 2026-09-01 — model DEDYKOWANY do tool-callingu, niezależny od aktywnego LLM
# odpowiedzi (Bielik NIE wspiera tools — template SpeakLeash bez sekcji).
# Router = qwen3:30b-a3b na Mac Studio (MoE, szybki, tools OK); odpowiedzi
# dalej pisze Bielik. Pusty env = model z get_active_llm() (stare zachowanie).
TOOL_CALLING_MODEL = os.environ.get("TOOL_CALLING_MODEL", "").strip() or None

# Router na ciepło odpowiada w 1-3 s, ale ZIMNY load qwen3:30b (18 GB) to
# ~30-60 s — domyślny CONFIG.ollama_timeout_s (15 s) ucinał pierwszy strzał
# po restarcie Ollamy. keep_alive=24h w payloadzie trzyma model rezydentnie.
TOOL_CALLING_TIMEOUT_S = float(os.environ.get("TOOL_CALLING_TIMEOUT_S", "75"))

_TOOLS_CACHE: Optional[list] = None


def _resolve_enum(spec: dict) -> Optional[list]:
    """`values:` wprost z YAML albo `source:` = nazwa słownika/setu
    w intent_classifier (dict → .values(), set/list → elementy)."""
    if spec.get("values"):
        return [str(v) for v in spec["values"]]
    source = spec.get("source")
    if not source:
        return None
    import intent_classifier  # lazy — unika cyklicznego importu
    obj = getattr(intent_classifier, source, None)
    if obj is None:
        log.warning("tool_calling: nieznane source=%r w rejestrze", source)
        return None
    values = obj.values() if isinstance(obj, dict) else obj
    return sorted({str(v) for v in values})


def _param_schema(name: str, spec: dict) -> dict:
    spec = spec or {}
    ptype = spec.get("type", "string")
    if ptype == "int":
        schema: dict = {"type": "integer"}
        if "default" in spec:
            schema["default"] = int(spec["default"])
    elif ptype == "enum":
        schema = {"type": "string"}
        enum_values = _resolve_enum(spec)
        if enum_values:
            schema["enum"] = enum_values
    else:
        schema = {"type": "string"}
    return schema


def build_tools() -> list:
    """Generuje definicje tools (Ollama/OpenAI format) z intents_registry.yaml.

    Jeden tool per intent (kilka reguł tego samego intentu → unia parametrów,
    parametr required tylko gdy required we WSZYSTKICH regułach). Intenty
    z `tool: false` (unknown) pomijane. Wynik cache'owany (rejestr jest
    statyczny per-process).
    """
    global _TOOLS_CACHE
    if _TOOLS_CACHE is not None:
        return _TOOLS_CACHE

    from intent_registry import load_registry, rules_by_intent
    tools: list = []
    for intent, rules in rules_by_intent(load_registry()).items():
        if not any(r.tool for r in rules):
            continue
        properties: dict = {}
        required_votes: dict = {}
        description = ""
        examples: list = []
        for rule in rules:
            if rule.description and not description:
                description = rule.description
            examples.extend(rule.examples)
            for pname, spec in rule.params.items():
                spec = spec or {}
                if pname not in properties:
                    properties[pname] = _param_schema(pname, spec)
                required_votes.setdefault(pname, True)
                required_votes[pname] = required_votes[pname] and bool(spec.get("required"))
        if examples:
            shots = "; ".join(f"„{e}”" for e in examples[:3])
            description = f"{description} Przykłady: {shots}".strip()
        tools.append({
            "type": "function",
            "function": {
                "name": intent,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": [p for p, req in required_votes.items() if req],
                },
            },
        })

    _TOOLS_CACHE = tools
    return tools


_SYSTEM_PROMPT = """Jesteś routerem pytań dla asystenta osiedlowego GateLynk.
Wybierz DOKŁADNIE JEDEN tool który odpowiada pytaniu użytkownika i wypełnij
jego parametry. Wartości parametrów podawaj w formie canonical (enum z definicji
toola). NIGDY nie zgaduj wartości parametru którego nie ma w pytaniu —
w szczególności search_by_brand_today wybieraj TYLKO gdy pytanie wymienia
konkretną markę (test 2026-06-11: model halucynował brand=INPOST dla
"czy ktoś dostarczył zakupy" — wtedy poprawny jest courier_today).
Jeśli ŻADEN tool nie pasuje (pogoda, small-talk, wiedza ogólna) —
nie wywołuj żadnego toola."""


async def classify_tool_calling(question: str) -> Optional[dict]:
    """Próba klasyfikacji przez Ollama tool calling.

    Returns:
      {'intent': ..., 'parameters': {...}} — surowy wybór modelu
        (caller MUSI przepuścić przez intent_classifier.validate()),
      None — model nie wybrał toola / błąd / nieznany tool
        (caller idzie dalej: classify_llm → unknown).
    """
    from llm_config import get_active_llm
    llm = get_active_llm()
    payload = {
        "model": TOOL_CALLING_MODEL or llm.model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": question},
        ],
        "stream": False,
        "tools": build_tools(),
        # qwen3 domyślnie „myśli" przed odpowiedzią — dla routera to czysty
        # koszt latencji; think=false wyłącza (starsze Ollamy ignorują pole).
        "think": False,
        "keep_alive": "24h",
        "options": {"temperature": 0.0},
    }
    try:
        async with httpx.AsyncClient(timeout=TOOL_CALLING_TIMEOUT_S) as client:
            r = await client.post(f"{llm.url}/api/chat", json=payload)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        # %r — httpx.ReadTimeout ma puste str() (lekcja z 8.h.20)
        log.warning("tool_calling: Ollama call failed: %r", e)
        return None

    tool_calls = (data.get("message") or {}).get("tool_calls") or []
    if not tool_calls:
        log.info("tool_calling: model nie zwrócił tool_call → fallback")
        return None

    call = tool_calls[0].get("function") or {}
    name = call.get("name")
    args = call.get("arguments")
    if isinstance(args, str):  # niektóre modele zwracają JSON-string
        try:
            args = json.loads(args)
        except (ValueError, TypeError):
            args = {}
    if not isinstance(args, dict):
        args = {}

    from intent_classifier import VALID_INTENTS
    if name not in VALID_INTENTS:
        log.warning("tool_calling: nieznany tool %r → fallback", name)
        return None

    # search_knowledge_base: query MUSI być pełnym pytaniem (bge-m3 potrzebuje
    # kontekstu) — model często skraca, więc nadpisujemy defensywnie.
    if name == "search_knowledge_base":
        args["query"] = question.strip()

    log.info("tool_calling: %s(%s)", name, args)
    return {"intent": name, "parameters": args}
