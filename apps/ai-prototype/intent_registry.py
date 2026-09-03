"""
Loader deklaratywnego rejestru intentów (`intents_registry.yaml`).

ETAP 2 sprintu "schemat na wiele pytań" (2026-06-11). Rejestr zastępuje
ręcznie pilnowaną kolejność if-ów w classify_regex():

  • kolejność checków = pole `priority` (niższy = wcześniej),
  • proste reguły (patterns / patterns_all / not_patterns + extractory)
    obsługuje generic matcher w intent_classifier,
  • logika która się nie generalizuje (knowledge triggers, waste keywords,
    vision objects, courier guards) zostaje w Pythonie jako CUSTOM matchery —
    rejestr wskazuje je po nazwie (`matcher:`).

Ten moduł NIE importuje intent_classifier (unika cyklicznego importu —
intent_classifier importuje nas). Jest czystym parserem YAML → IntentRule.

Python 3.9 na Edge — bez PEP 604 w runtime (Optional[X], List[X] z typing
albo `from __future__ import annotations`).

Zależność: PyYAML (`pip install pyyaml` — patrz requirements.txt).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Optional

try:
    import yaml
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "intent_registry wymaga PyYAML: pip install pyyaml "
        "(na Edge: ~/gatelynk-ai-prototype/.venv/bin/pip install pyyaml)"
    ) from e

REGISTRY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "intents_registry.yaml")

# Matchowanie identyczne z dotychczasowym classify_regex: pytanie jest już
# lowercase, ale flaga IGNORECASE zostaje dla bezpieczeństwa (np. wielkie
# litery w tablicach rejestracyjnych nie przechodzą przez te patterny).
_RE_FLAGS = re.IGNORECASE


@dataclass(frozen=True)
class IntentRule:
    """Jedna reguła kaskady. Może być kilka reguł na ten sam intent
    (np. courier_today + courier_today_b — różne pozycje w kaskadzie)."""
    key: str                      # klucz w YAML (unikalny)
    intent: str                   # docelowy intent (default = key)
    description: str
    priority: int
    matcher: str                  # 'generic' | nazwa custom | 'none'
    patterns: list                # list[re.Pattern] — OR (jeden wystarczy)
    patterns_all: list            # list[re.Pattern] — AND (wszystkie)
    not_patterns: list            # list[re.Pattern] — żaden nie może
    guard: Optional[str]          # nazwa predykatu z _GUARDS
    params: dict                  # param_name -> spec dict (type/extractor/…)
    examples: list                # few-shot dla LLM fallback / tool-calling
    tool: bool = True             # False → pomijany przy generowaniu tools

    def __repr__(self) -> str:  # czytelne logi
        return f"IntentRule({self.key} p={self.priority} → {self.intent})"


def _compile(patterns: Optional[list]) -> list:
    if not patterns:
        return []
    return [re.compile(p, _RE_FLAGS) for p in patterns]


def load_registry(path: str = REGISTRY_PATH) -> list:
    """Czyta YAML → list[IntentRule] posortowana po priority (rosnąco).

    Walidacja jest minimalna celowo — twardą walidację intentów robi
    intent_classifier przy budowaniu kaskady (intent musi być w
    VALID_INTENTS, matcher/guard/extractor muszą istnieć w rejestrach
    funkcji — fail-fast przy imporcie, nie w runtime per-request).
    """
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    if not isinstance(raw, dict) or not raw:
        raise ValueError(f"{path}: oczekiwany niepusty mapping intent → definicja")

    rules: list = []
    seen_priorities: dict = {}
    for key, spec in raw.items():
        if not isinstance(spec, dict):
            raise ValueError(f"{path}: wpis {key!r} nie jest mappingiem")
        if "priority" not in spec:
            raise ValueError(f"{path}: wpis {key!r} bez priority")
        priority = int(spec["priority"])
        if priority in seen_priorities:
            raise ValueError(
                f"{path}: duplikat priority={priority} ({key!r} vs "
                f"{seen_priorities[priority]!r}) — kolejność byłaby niedeterministyczna"
            )
        seen_priorities[priority] = key
        rules.append(IntentRule(
            key=key,
            intent=spec.get("intent", key),
            description=str(spec.get("description", "")).strip(),
            priority=priority,
            matcher=spec.get("matcher", "generic"),
            patterns=_compile(spec.get("patterns")),
            patterns_all=_compile(spec.get("patterns_all")),
            not_patterns=_compile(spec.get("not_patterns")),
            guard=spec.get("guard"),
            params=spec.get("params") or {},
            examples=spec.get("examples") or [],
            tool=bool(spec.get("tool", True)),
        ))

    rules.sort(key=lambda r: r.priority)
    return rules


def rules_by_intent(rules: list) -> dict:
    """Grupuje reguły po docelowym intencie — {intent: [IntentRule, ...]}.
    Używane przy generowaniu definicji tools (Etap 3): jeden tool per intent,
    parametry z unii wszystkich jego reguł."""
    out: dict = {}
    for rule in rules:
        out.setdefault(rule.intent, []).append(rule)
    return out
