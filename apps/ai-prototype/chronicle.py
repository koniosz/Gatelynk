"""
Kronika dnia (2026-08-26) — wieczorny digest zdarzeń sytuacyjnych + statystyk.

Źródła (Edge sqlite, read-only):
  • situation_events  — zdarzenia z SituationCorrelatorService (Edge Node):
    TAILGATING / VEHICLE_LOITERING / NIGHT_PERSON / VEHICLE_WAITING /
    COURIER_VISIT / FALL_CONFIRMED
  • lpr_reads         — statystyka ruchu dnia (wjazdy/wyjazdy/spoza rejestru)

Zasada żelazna (lekcje 8.h.16/8.h.19): FAKTY liczy Python deterministycznie,
LLM (Bielik) może je tylko ubrać w narrację. Guard cyfr: każda liczba
w narracji MUSI występować w faktach — inaczej narracja odrzucona i zostaje
deterministyczny tekst. Pusta odpowiedź LLM = fallback (guard z 2026-08-24).

Konsumenci: Cloud cron 21:00 (push „Kronika dnia" do budynku — tylko gdy są
zdarzenia; cisza > spam) + endpoint preview.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any

import httpx

from config import CONFIG
from db import execute_safe

log = logging.getLogger("gatelynk-ai.chronicle")

# Kolejność = priorytet w pushu (najpoważniejsze pierwsze).
_TYPE_META: list[tuple[str, str]] = [
    ("FALL_CONFIRMED", "⚠️"),
    ("TAILGATING", "🚧"),
    ("VEHICLE_LOITERING", "🕵️"),
    ("NIGHT_PERSON", "🌙"),
    ("VEHICLE_WAITING", "⏳"),
    ("COURIER_VISIT", "📦"),
]
_TYPE_PRIORITY = {t: i for i, (t, _) in enumerate(_TYPE_META)}
_TYPE_ICON = dict(_TYPE_META)

_SITUATIONS_SQL = """
SELECT type, started_ts AS startedTs, ended_ts AS endedTs, confidence, title
  FROM situation_events
 WHERE started_ts >= ? AND started_ts < ?
 ORDER BY started_ts ASC
 LIMIT 200
"""

_TRAFFIC_SQL = """
SELECT
  SUM(CASE WHEN direction IN ('in','IN','forward')  THEN 1 ELSE 0 END) AS ins,
  SUM(CASE WHEN direction IN ('out','OUT','reverse') THEN 1 ELSE 0 END) AS outs,
  SUM(CASE WHEN matched = 0 THEN 1 ELSE 0 END) AS unmatched,
  COUNT(*) AS total
  FROM lpr_reads
 WHERE ts >= ? AND ts < ?
"""


def _day_window_ms() -> tuple[int, int, str]:
    now = datetime.now()
    sod = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(sod.timestamp() * 1000), int(now.timestamp() * 1000), sod.strftime("%Y-%m-%d")


def _digit_tokens(text: str) -> set[str]:
    return set(re.findall(r"\d+", text))


async def _narrative(facts: str) -> str | None:
    """Bielik ubiera deterministyczne fakty w 2-3 zdania kroniki.

    Guard: narracja nie może zawierać ŻADNEJ liczby spoza faktów (zapobiega
    przekłamaniom „82→92"; słowne liczebniki są dozwolone). Pusta / za długa /
    z obcymi cyframi → None (caller używa deterministycznych linii).
    """
    from llm_config import get_active_llm

    llm = get_active_llm()
    payload = {
        "model": llm.model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Jesteś kronikarzem osiedla. Z podanych FAKTÓW ułóż zwięzłą, "
                    "naturalną kronikę dnia po polsku: 2-4 zdania, ciepły ale "
                    "rzeczowy ton. ZAKAZ dodawania liczb, godzin i zdarzeń "
                    "spoza faktów. ZAKAZ spekulacji. Bez nagłówka, bez emoji."
                ),
            },
            {"role": "user", "content": f"FAKTY:\n{facts}"},
        ],
        "stream": False,
        "options": {"temperature": 0.3, "num_predict": 320},
    }
    try:
        async with httpx.AsyncClient(timeout=CONFIG.ollama_timeout_s * 2) as client:
            r = await client.post(f"{llm.url}/api/chat", json=payload)
            r.raise_for_status()
            text = (r.json().get("message", {}).get("content") or "").strip()
    except Exception as e:
        log.warning("chronicle narrative failed: %r", e)
        return None
    if not text or len(text) > 1200:
        return None
    # Ucięta generacja (limit tokenów) — przytnij do ostatniego pełnego zdania.
    if text[-1] not in ".!?":
        cut = max(text.rfind("."), text.rfind("!"), text.rfind("?"))
        if cut < 40:
            return None
        text = text[: cut + 1]
    foreign = _digit_tokens(text) - _digit_tokens(facts)
    if foreign:
        log.warning("chronicle narrative odrzucona — obce liczby: %s", sorted(foreign))
        return None
    return text


async def build_chronicle(smart: bool = True) -> dict[str, Any]:
    since_ms, until_ms, day = _day_window_ms()

    try:
        events = await execute_safe(_SITUATIONS_SQL, [since_ms, until_ms])
    except Exception as e:
        # Starszy Edge bez tabeli situation_events (schemat tworzy Edge Node
        # przy starcie) — kronika działa wtedy w trybie samych statystyk.
        log.warning("situation_events unavailable: %r", e)
        events = []
    traffic_rows = await execute_safe(_TRAFFIC_SQL, [since_ms, until_ms])
    traffic = traffic_rows[0] if traffic_rows else {}
    ins = int(traffic.get("ins") or 0)
    outs = int(traffic.get("outs") or 0)
    unmatched = int(traffic.get("unmatched") or 0)
    total = int(traffic.get("total") or 0)

    lines: list[str] = []
    if total > 0:
        lines.append(
            f"🚗 Ruch przy bramach: {ins} wjazdów, {outs} wyjazdów"
            + (f" ({unmatched} przejazdów pojazdów spoza rejestru)." if unmatched else ".")
        )

    # Zdarzenia posortowane po priorytecie typu, w typie chronologicznie.
    ordered = sorted(
        events,
        key=lambda e: (_TYPE_PRIORITY.get(e["type"], 99), e["startedTs"]),
    )
    for e in ordered:
        icon = _TYPE_ICON.get(e["type"], "•")
        suffix = " [interpretacja]" if e.get("confidence") == "INFERRED" else ""
        lines.append(f"{icon} {e['title']}{suffix}")

    # Push tylko gdy jest COŚ sytuacyjnego (sama statystyka = spam).
    push_text: str | None = None
    if events:
        push_lines = lines[:4] if total > 0 else lines[:3]
        push_text = "\n".join(push_lines)
        if len(push_text) > 400:
            push_text = push_text[:397] + "…"

    narrative: str | None = None
    if smart and lines:
        # Do narracji tylko czołówka faktów — z 13+ linii Bielik produkuje
        # wyliczankę uciętą limitem tokenów zamiast 2-4 zdań kroniki.
        narrative = await _narrative("\n".join(lines[:7]))

    return {
        "date": day,
        "lines": lines,
        "narrative": narrative,
        "push_text": push_text,
        "events": [
            {
                "type": e["type"],
                "startedTs": e["startedTs"],
                "endedTs": e["endedTs"],
                "confidence": e["confidence"],
                "title": e["title"],
            }
            for e in ordered
        ],
        "traffic": {"ins": ins, "outs": outs, "unmatched": unmatched, "total": total},
    }
