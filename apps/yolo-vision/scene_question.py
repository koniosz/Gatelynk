"""
scene_question.py — celowane pytania VLM o CAŁĄ scenę (2026-09-01).

Rozszerzenie vehicle_attrs.py: tam pytamy o crop pojazdu, tu o pełny kadr
oznaczony przez korelator zdarzeń na Edge (osoba w nocy, pojazd czekający,
kandydat na upadek). VLM (qwen2.5vl przez lokalną Ollamę) zwraca krótki
polski opis TEGO, CO WIDAĆ — bez spekulacji o tożsamości.

Tryby (`mode`):
  night_person    — co robi osoba na nocnym ujęciu (1 zdanie)
  vehicle_waiting — co robi pojazd stojący w kadrze (1 zdanie)
  fall_confirm    — STRUKTURALNE potwierdzenie upadku:
                    {"lezy": bool, "opis": "..."} — bramka przed pushem
                    krytycznym; heurystyka pose daje false positives
                    (schylanie się, cień, wózek), VLM patrzy na całość.
  describe        — pytanie własne (parametr `question`)

Kontrakt: ask_scene(image_b64, mode, question) → {"answer": str,
"confirmed": bool|None, "ms": float}  |  wyjątek przy błędzie Ollamy
(caller — endpoint — mapuje na HTTP 502; Edge traktuje fail-silent).
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Optional

import httpx

log = logging.getLogger(__name__)

VLM_URL = os.environ.get("VEHICLE_VLM_URL", "http://127.0.0.1:11434")
VLM_MODEL = os.environ.get("VEHICLE_VLM_MODEL", "qwen2.5vl:7b")
VLM_TIMEOUT_S = float(os.environ.get("SCENE_VLM_TIMEOUT_S", "30"))

_COMMON_RULES = (
    " Odpowiadaj po polsku, rzeczowo, bez spekulacji o tożsamości, wieku ani "
    "zamiarach osób. Opisuj tylko to, co faktycznie widać na obrazie."
)

_MODE_PROMPTS: dict[str, str] = {
    "night_person": (
        "To nocne ujęcie z kamery osiedlowej, na którym wykryto osobę. "
        "Opisz JEDNYM zdaniem co ta osoba robi (np. idzie chodnikiem, stoi "
        "przy bramie, prowadzi rower, zagląda w stronę samochodu)."
        + _COMMON_RULES
    ),
    "vehicle_waiting": (
        "To ujęcie z kamery osiedlowej, na którym pojazd stoi w kadrze od "
        "dłuższego czasu. Opisz JEDNYM zdaniem ten pojazd i co robi (np. "
        "biały van stoi przed bramą z włączonymi światłami, ktoś siedzi "
        "w środku)." + _COMMON_RULES
    ),
}

_FALL_PROMPT = (
    "To ujęcie z kamery osiedlowej. Automatyczna analiza sylwetki sugeruje, "
    "że widoczna osoba mogła UPAŚĆ. Oceń obraz i odpowiedz WYŁĄCZNIE "
    "poprawnym JSON-em o polach:\n"
    '"lezy" — true tylko, gdy osoba faktycznie leży na ziemi/podłożu '
    "(nie schyla się, nie kuca, nie siedzi na ławce, to nie cień ani "
    "przedmiot);\n"
    '"opis" — jedno zdanie po polsku co widać.\n'
    "Bez komentarzy, bez markdown — sam JSON."
)


def ask_scene(
    image_b64: str,
    mode: str,
    question: Optional[str] = None,
) -> dict[str, Any]:
    t0 = time.perf_counter()

    if mode == "fall_confirm":
        prompt = _FALL_PROMPT
        want_json = True
    elif mode in _MODE_PROMPTS:
        prompt = _MODE_PROMPTS[mode]
        want_json = False
    elif mode == "describe" and question:
        prompt = question.strip()[:600] + _COMMON_RULES
        want_json = False
    else:
        raise ValueError(f"unknown mode {mode!r} (or missing question for describe)")

    payload: dict[str, Any] = {
        "model": VLM_MODEL,
        "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
        "stream": False,
        "options": {"temperature": 0, "num_predict": 160},
    }
    if want_json:
        payload["format"] = "json"

    r = httpx.post(f"{VLM_URL}/api/chat", json=payload, timeout=VLM_TIMEOUT_S)
    r.raise_for_status()
    content = ((r.json().get("message") or {}).get("content") or "").strip()
    ms = round((time.perf_counter() - t0) * 1000, 1)

    confirmed: Optional[bool] = None
    answer = content
    if want_json:
        try:
            parsed = json.loads(content)
            confirmed = bool(parsed.get("lezy"))
            answer = str(parsed.get("opis") or "").strip() or content
        except (json.JSONDecodeError, AttributeError):
            log.warning("scene-vlm fall_confirm: nieparsowalny JSON: %.200s", content)
            confirmed = None  # brak werdyktu — caller decyduje (u nas: bez pusha)

    # Ucięta / rozwlekła generacja → przytnij do pierwszego zdania z kropką.
    if not want_json and len(answer) > 300:
        cut = answer.find(". ")
        if cut > 20:
            answer = answer[: cut + 1]

    log.info("scene-vlm mode=%s confirmed=%s %.0fms: %.120s", mode, confirmed, ms, answer)
    return {"answer": answer[:500], "confirmed": confirmed, "ms": ms}
