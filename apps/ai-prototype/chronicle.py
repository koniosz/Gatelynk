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
SELECT type, started_ts AS startedTs, ended_ts AS endedTs, confidence, title,
       details_json AS details
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


# 2026-10-08 — dostawy z rejestru (pojazd DELIVERY z tagiem marki) wjeżdżające
# dziś. Uzupełnia COURIER_VISIT z wizji: van z rejestru bywa odczytany przez
# LPR, a napis na boku nie trafia w kadr kamer wizji (i odwrotnie).
_DELIVERY_SQL = """
SELECT ts, vehicle_tags AS tags
  FROM lpr_reads
 WHERE ts >= ? AND ts < ?
   AND vehicle_kind = 'DELIVERY'
   AND direction IN ('in','IN','forward')
 ORDER BY ts ASC
"""

_TAXI_BRANDS = {"UBER", "BOLT", "FREENOW", "FREE_NOW"}
# Etykiety marek dla mieszkańca (kanoniczne nazwy z brand_matcher są UPPER_SNAKE).
_BRAND_LABELS = {
    "INPOST": "InPost", "DHL": "DHL", "DPD": "DPD", "UPS": "UPS", "GLS": "GLS",
    "FEDEX": "FedEx", "POCZTA_POLSKA": "Poczta Polska", "POCZTA": "Poczta Polska",
    "ALLEGRO": "Allegro",
    "ORLEN_PACZKA": "Orlen Paczka", "FRISCO": "Frisco", "BARBORA": "Barbora",
    "MEDIA_EXPERT": "Media Expert", "MEDIA_MARKT": "MediaMarkt",
    "RTV_EURO_AGD": "RTV Euro AGD", "X_KOM": "x-kom", "IKEA": "IKEA",
    "LEROY_MERLIN": "Leroy Merlin", "CASTORAMA": "Castorama", "OBI": "OBI",
    "LIDL": "Lidl", "BIEDRONKA": "Biedronka", "AUCHAN": "Auchan",
    "CARREFOUR": "Carrefour", "UBER": "Uber", "BOLT": "Bolt", "GLOVO": "Glovo",
    "WOLT": "Wolt", "PYSZNE": "Pyszne.pl",
}


def _brand_label(brand: str) -> str:
    b = str(brand or "").upper()
    if b in _BRAND_LABELS:
        return _BRAND_LABELS[b]
    words = b.replace("_", " ").split()
    return " ".join(w if len(w) <= 3 else w.capitalize() for w in words) or "Dostawa"


def _tag_brand(tags_json: str | None) -> str | None:
    """Kanoniczna marka z tagów pojazdu z rejestru (np. ["InPost","van"])."""
    import json

    from intent_classifier import BRAND_KEYWORD_MAP

    try:
        tags = json.loads(tags_json or "[]")
    except (TypeError, ValueError):
        return None
    canon = set(BRAND_KEYWORD_MAP.values())
    for t in tags if isinstance(tags, list) else []:
        key = str(t).strip().lower()
        if key in BRAND_KEYWORD_MAP:
            return BRAND_KEYWORD_MAP[key]
        up = key.upper().replace(" ", "_")
        if up in canon:
            return up
    return None


def _today_block(events: list[dict], deliveries: list[dict]) -> dict[str, Any]:
    """Zestawienie dnia dla karty „Najnowsze na osiedlu" (iOS przez Cloud).

    Kurierzy per marka = wjazdy vanów z rejestru (LPR) + wizyty z wizji,
    których LPR nie tłumaczy (start 5 min przed – 40 min po wjeździe tej
    marki = ten sam van; dłuższy postój daje w wizji dwa skupiska klatek).
    Taksówki osobno (to nie dostawy).
    """
    import json

    vision: dict[str, list[int]] = {}
    taxis = 0
    waste: list[int] = []
    for e in events:
        if e["type"] == "WASTE_TRUCK":
            waste.append(int(e["startedTs"]))
            continue
        if e["type"] != "COURIER_VISIT":
            continue
        try:
            brand = str((json.loads(e.get("details") or "{}") or {}).get("brand") or "")
        except (TypeError, ValueError):
            brand = ""
        if not brand:
            continue
        if brand.upper() in _TAXI_BRANDS:
            taxis += 1
            continue
        vision.setdefault(brand.upper(), []).append(int(e["startedTs"]))

    lpr: dict[str, list[int]] = {}
    for d in deliveries:
        brand = _tag_brand(d.get("tags"))
        if brand and brand.upper() not in _TAXI_BRANDS:
            lpr.setdefault(brand.upper(), []).append(int(d["ts"]))

    couriers = []
    for brand in sorted(set(vision) | set(lpr)):
        v, l = vision.get(brand, []), lpr.get(brand, [])
        unexplained = [
            ts for ts in v
            if not any(entry - 5 * 60_000 <= ts <= entry + 40 * 60_000 for entry in l)
        ]
        couriers.append({
            "brand": brand,
            "label": _brand_label(brand),
            "visits": len(l) + len(unexplained),
            "lastTs": max(v + l),
        })
    couriers.sort(key=lambda c: (-c["visits"], -c["lastTs"]))
    return {
        "couriers": couriers,
        "taxis": taxis,
        "wasteTruck": {"visits": len(waste), "lastTs": max(waste)} if waste else None,
    }


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
    try:
        deliveries = await execute_safe(_DELIVERY_SQL, [since_ms, until_ms])
    except Exception as e:
        log.warning("delivery reads unavailable: %r", e)
        deliveries = []
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
        "today": _today_block(events, deliveries),
    }
