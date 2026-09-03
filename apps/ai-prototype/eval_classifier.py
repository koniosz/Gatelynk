#!/usr/bin/env python3
"""
Eval runner dla intent_classifier — siatka bezpieczeństwa przed regresjami.

Ładuje `questions_catalog.yaml` (golden set 130+ pytań) i sprawdza
`classify_regex()` (BEZ LLM — deterministyczne, milisekundy). Każda łatka
w intent_classifier.py MUSI przechodzić ten eval na 100% — inaczej cicho
psuje wcześniej naprawione pytania (lekcja z tygodnia ręcznych łatek
Uber/FRISCO/śmieciarka/planowany odbiór).

Użycie:
    cd apps/ai-prototype && python3 eval_classifier.py
    python3 eval_classifier.py -v            # pokaż też PASS-y
    python3 eval_classifier.py --llm         # dodatkowo pytania needs_llm
                                             # przez pełen classify() (Ollama!)

Exit code: 0 gdy wszystko zielone, 1 gdy cokolwiek FAIL.

Zależności: pip install pyyaml httpx pydantic
(httpx/pydantic ciągnie import intent_classifier; na Edge są w venv,
na laptopie deweloperskim zwykle w systemowym site-packages).

Semantyka porównania:
  • intent — dokładny match. Oczekiwany "unknown" pasuje też gdy
    classify_regex zwraca None (regex miss → w produkcji LLM fallback).
  • params — SUBSET match: porównywane są tylko klucze wymienione
    w katalogu. Classifier może dokładać defaulty (range_hours itp.).
  • absent — wymienione klucze NIE mogą wystąpić w parametrach.
  • history — wpis multi-turn: q NAJPIERW przechodzi przez
    conversation.deterministic_rewrite (carry-over marki/koloru/tablicy
    z historii, BEZ LLM — deterministyczne), potem classify_regex.
    Dokładnie produkcyjna ścieżka /ask dla follow-upów (8.h.33/23/32).
Porównujemy wynik PO validate() — czyli dokładnie to co dostaje
sql_templates/response_builder w produkcji.
"""
from __future__ import annotations

import argparse
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

try:
    import yaml
except ImportError:
    sys.exit(
        "Brak PyYAML. Zainstaluj: pip install pyyaml\n"
        "(eval działa z systemowym python3 — nie potrzebuje venv Edge)"
    )

try:
    from intent_classifier import classify_regex, validate
except ImportError as e:  # httpx/pydantic missing on bare interpreter
    sys.exit(
        f"Import intent_classifier nie powiódł się: {e}\n"
        "Zainstaluj zależności: pip install httpx pydantic pyyaml"
    )

CATALOG_PATH = os.path.join(_HERE, "questions_catalog.yaml")

GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[2m"
RESET = "\033[0m"


def load_catalog(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, list) or not data:
        sys.exit(f"Katalog {path} pusty albo zły format (oczekiwana lista)")
    for i, entry in enumerate(data):
        if not isinstance(entry, dict) or "q" not in entry or "intent" not in entry:
            sys.exit(f"Wpis #{i} w katalogu bez 'q'/'intent': {entry!r}")
    return data


def check_entry(entry: dict, got: dict) -> list[str]:
    """Zwraca listę błędów (pusta = PASS)."""
    errors: list[str] = []
    expected_intent = entry["intent"]
    got_intent = got.get("intent")
    got_params = got.get("parameters") or {}

    if got_intent != expected_intent:
        errors.append(f"intent: expected={expected_intent} got={got_intent}")
        return errors  # parametry bez sensu przy złym intencie

    for key, expected_val in (entry.get("params") or {}).items():
        if key not in got_params:
            errors.append(f"param {key}: expected={expected_val!r} got=<missing>")
        elif got_params[key] != expected_val:
            errors.append(f"param {key}: expected={expected_val!r} got={got_params[key]!r}")

    for key in entry.get("absent") or []:
        if key in got_params:
            errors.append(f"param {key}: expected ABSENT, got={got_params[key]!r}")

    return errors


def run_regex_entry(entry: dict) -> dict:
    question = entry["q"]
    history = entry.get("history")
    if history:
        # Multi-turn golden: przepuść przez deterministyczny carry-over
        # z conversation.py (8.h.33/23/32) — dokładnie produkcyjna ścieżka
        # /ask PRZED classify. Bez LLM, więc dalej milisekundy.
        from conversation import Turn, deterministic_rewrite
        turns = [Turn(role=t["role"], content=t["content"]) for t in history]
        rewritten = deterministic_rewrite(question, turns)
        if rewritten is not None:
            question = rewritten
    raw = classify_regex(question)
    if raw is None:
        # Regex miss — w produkcji poszłoby do LLM fallbacku. Dla eval
        # traktujemy jako 'unknown' (pasuje do wpisów intent: unknown).
        return {"intent": "unknown", "parameters": {}}
    return validate(raw)


async def run_llm_entry(question: str) -> dict:
    from intent_classifier import classify
    return await classify(question)


def main() -> int:
    parser = argparse.ArgumentParser(description="Eval intent_classifier vs questions_catalog.yaml")
    parser.add_argument("--llm", action="store_true",
                        help="testuj też wpisy needs_llm przez pełen classify() (wymaga Ollama)")
    parser.add_argument("-v", "--verbose", action="store_true", help="pokaż też PASS-y")
    parser.add_argument("--catalog", default=CATALOG_PATH, help="ścieżka do katalogu YAML")
    args = parser.parse_args()

    catalog = load_catalog(args.catalog)

    passed = 0
    failed = 0
    skipped = 0
    failures: list[tuple[str, list[str], dict]] = []

    # ── Stage 1: regex-only (deterministyczne) ──────────────────────────────
    for entry in catalog:
        if entry.get("needs_llm"):
            skipped += 1
            continue
        got = run_regex_entry(entry)
        errors = check_entry(entry, got)
        if errors:
            failed += 1
            failures.append((entry["q"], errors, got))
            print(f"{RED}FAIL{RESET} {entry['q']}")
            for err in errors:
                print(f"     {RED}{err}{RESET}")
            print(f"     {DIM}got: {got}{RESET}")
        else:
            passed += 1
            if args.verbose:
                print(f"{GREEN}PASS{RESET} {entry['q']} {DIM}→ {got['intent']}{RESET}")

    # ── Stage 2 (opt-in): needs_llm przez pełen classify() ──────────────────
    if args.llm:
        import asyncio

        async def _run_llm() -> None:
            nonlocal passed, failed, skipped
            for entry in catalog:
                if not entry.get("needs_llm"):
                    continue
                skipped -= 1
                got = await run_llm_entry(entry["q"])
                errors = check_entry(entry, got)
                if errors:
                    failed += 1
                    failures.append((entry["q"], errors, got))
                    print(f"{RED}FAIL{RESET} [LLM] {entry['q']}")
                    for err in errors:
                        print(f"     {RED}{err}{RESET}")
                    print(f"     {DIM}got: {got}{RESET}")
                else:
                    passed += 1
                    if args.verbose:
                        print(f"{GREEN}PASS{RESET} [LLM] {entry['q']} {DIM}→ {got['intent']}{RESET}")

        asyncio.run(_run_llm())

    # ── Summary ──────────────────────────────────────────────────────────────
    total = passed + failed
    print()
    print("─" * 60)
    color = GREEN if failed == 0 else RED
    print(f"{color}{passed}/{total} passed{RESET}"
          + (f", {skipped} skipped (needs_llm — uruchom z --llm)" if skipped else ""))
    if failed:
        print(f"{RED}{failed} FAILED:{RESET}")
        for q, errors, _ in failures:
            print(f"  • {q} — {'; '.join(errors)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
