"""
Waste Calendar — structured per-day events z harmonogramu śmieci (FAZA 8.h.28).

PROBLEM (zgłoszenie usera): karta „GateLynk AI → Co dziś się wydarzy" zna
harmonogram odbioru śmieci (Bielik czyta KB i podaje „Najbliżej: 16 czerwca
odbiór zmieszanych…"), ale widok Kalendarz w iOS pokazywał „Brak danych
z harmonogramu" dla każdego dnia poza dzisiejszym. CalendarView fetchował tylko
`/day-summary` (wolny tekst dla dziś), bez strukturalnego źródła per-dzień.

ŹRÓDŁO PRAWDY: harmonogram śmieci jest uploadowany przez admina jako dokument
bazy wiedzy (type=INNE, np. „harmonogram_smieci_strukturalny_llm"). Jego
`parsedText` zawiera frakcje + listy dat ISO (YYYY-MM-DD), np.:

    ZMIESZANE: 2026-06-16, 2026-06-30, 2026-07-28
    BIO: 2026-06-19, 2026-06-26
    ZIELONE: 2026-06-25, ...
    PAPIER: 2026-06-12, 2026-08-07
    SZKŁO: 2026-07-30
    METALE_I_TWORZYWA_SZTUCZNE: 2026-06-12

To te SAME daty, które Bielik cytuje w day-summary (8.h.14/8.h.16). Tu czytamy
je DETERMINISTYCZNIE (regex), bez LLM — fragile parsing tekstu Bielika był
świadomie odrzucony w CalendarView (patrz komentarz w pliku). Reużywamy realne
źródło dat (KB doc), nie hardkodujemy ani nie duplikujemy harmonogramu.

NIE per-budynek w prototypie: ai-prototype działa na konkretnym Edge (1 budynek
per Mac Mini), więc KB sqlite zawiera tylko dokumenty tego budynku. Konfigurowal-
ność = treść uploadowanego dokumentu (admin zmienia harmonogram → zmienia się
output). Zero hardkodów dat.
"""
from __future__ import annotations

import logging
import os
import re
from datetime import date, datetime
from typing import Any

import httpx

log = logging.getLogger("waste-calendar")

# Edge HTTP endpoint (ten sam pattern co app.py). Prototype i Edge żyją na tej
# samej maszynie (Mac Mini) — defaultowo localhost.
EDGE_URL = os.environ.get("EDGE_URL", "http://localhost:4000")

# Frakcje rozpoznawane w harmonogramie. Klucz = kanoniczny token (UPPER, jak
# w KB doc), wartość = (tytuł PL do UI, ikona/emoji kategorii). Warianty pisowni
# (ZIELONE vs ODPADY_ZIELONE, SZKŁO vs SZKLO) rozwiązane w `_CATEGORY_ALIASES`.
WASTE_CATEGORIES: dict[str, dict[str, str]] = {
    "ZMIESZANE":   {"title": "Odbiór zmieszanych", "icon": "🗑️"},
    "BIO":         {"title": "Odbiór bio",         "icon": "🍂"},
    "ZIELONE":     {"title": "Odbiór zielonych",   "icon": "🌿"},
    "PAPIER":      {"title": "Odbiór papieru",     "icon": "📄"},
    "SZKLO":       {"title": "Odbiór szkła",       "icon": "🍾"},
    "METAL_TWORZYWA": {"title": "Odbiór metali i tworzyw", "icon": "♻️"},
}

# Normalizacja nagłówków z dokumentu → kanoniczny token z WASTE_CATEGORIES.
# Dokument może użyć różnej pisowni; mapujemy wszystkie warianty na 1 token.
_CATEGORY_ALIASES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"zmieszan",                re.I), "ZMIESZANE"),
    (re.compile(r"\bbio\b|biodegrad",       re.I), "BIO"),
    (re.compile(r"zielon",                  re.I), "ZIELONE"),
    (re.compile(r"papier|tektur",           re.I), "PAPIER"),
    (re.compile(r"szk[łl]o",                re.I), "SZKLO"),
    (re.compile(r"metal|tworzyw|plastik",   re.I), "METAL_TWORZYWA"),
]

_ISO_DATE_RE = re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b")

# Typy dokumentów do przeszukania pod kątem harmonogramu. Admin uploaduje
# harmonogram śmieci jako INNE (patrz building-knowledge.service.ts: file upload
# tylko UCHWALA/REGULAMIN/INNE). Tytuł zwykle zawiera „harmonogram".
_SCHEDULE_DOC_TYPE = "INNE"
_SCHEDULE_TITLE_HINTS = ("harmonogram", "odbi", "smieci", "śmieci", "odpad")


def _canonical_category(line_head: str) -> str | None:
    """Mapuj fragment linii (nagłówek frakcji) na kanoniczny token albo None."""
    for pattern, token in _CATEGORY_ALIASES:
        if pattern.search(line_head):
            return token
    return None


def _looks_like_schedule(title: str, text: str) -> bool:
    """
    Heurystyka: czy ten dokument to harmonogram śmieci? Tytuł z hintem ALBO
    treść zawiera nazwę frakcji + ISO datę. Świadomie liberalna — fałszywy
    pozytyw na innym dokumencie z frakcją+datą jest nieszkodliwy (parser i tak
    wyciągnie tylko realne pary frakcja↔data).
    """
    t = title.lower()
    if any(h in t for h in _SCHEDULE_TITLE_HINTS):
        return True
    has_category = any(p.search(text) for p, _ in _CATEGORY_ALIASES)
    return has_category and bool(_ISO_DATE_RE.search(text))


def _parse_schedule_text(text: str) -> dict[str, set[str]]:
    """
    Wyciągnij {kanoniczna_kategoria: {ISO_date, ...}} z tekstu harmonogramu.

    Strategia per-linia: w każdej linii szukamy nazwy frakcji oraz wszystkich
    dat ISO w tej samej linii. Obsługuje oba popularne formaty:
        „ZMIESZANE: 2026-06-16, 2026-06-30"            (frakcja + daty inline)
        „ZMIESZANE\\n- 2026-06-16\\n- 2026-06-30"      (frakcja jako nagłówek,
                                                         daty w kolejnych liniach)
    W drugim wariancie „sticky" kategoria: ostatnio rozpoznana frakcja obejmuje
    następne linie zawierające tylko daty (aż do nowego nagłówka frakcji).
    """
    result: dict[str, set[str]] = {}
    sticky: str | None = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        cat_in_line = _canonical_category(line)
        dates_in_line = _ISO_DATE_RE.findall(line)

        if cat_in_line:
            sticky = cat_in_line
            target = cat_in_line
        elif dates_in_line and sticky:
            target = sticky
        else:
            # Linia z datą bez kontekstu frakcji — pomijamy (nie wiemy czego dotyczy).
            continue

        if not dates_in_line:
            # Sam nagłówek frakcji bez dat w tej linii — czekamy na kolejne linie.
            continue

        bucket = result.setdefault(target, set())
        for y, m, d in dates_in_line:
            try:
                # Walidacja kalendarzowa (odrzuca 2026-13-40 itp.)
                iso = date(int(y), int(m), int(d)).isoformat()
            except ValueError:
                continue
            bucket.add(iso)

    return result


async def _fetch_schedule_docs() -> list[dict[str, Any]]:
    """Pobierz pełne teksty dokumentów INNE z Edge. [] przy błędzie."""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                f"{EDGE_URL}/knowledge/docs", params={"type": _SCHEDULE_DOC_TYPE}
            )
            r.raise_for_status()
            return r.json().get("docs", []) or []
    except Exception as e:  # noqa: BLE001
        log.warning("waste-calendar: fetch docs failed: %r", e)
        return []


def build_events(schedule: dict[str, set[str]], days: int, today: date) -> list[dict[str, Any]]:
    """
    Z {kategoria: {ISO}} zbuduj posortowaną listę eventów w oknie [today, today+days).

    Każdy event: {date, type, category, title, icon}. `type='waste'` (zostawia
    miejsce na inne źródła — scheduled tickets jako 'ticket' w przyszłości).
    """
    horizon = days - 1 if days > 0 else 0
    events: list[dict[str, Any]] = []
    for category, iso_dates in schedule.items():
        meta = WASTE_CATEGORIES.get(category, {"title": f"Odbiór ({category})", "icon": "🗑️"})
        for iso in iso_dates:
            try:
                d = datetime.strptime(iso, "%Y-%m-%d").date()
            except ValueError:
                continue
            delta = (d - today).days
            if 0 <= delta <= horizon:
                events.append(
                    {
                        "date": iso,
                        "type": "waste",
                        "category": category,
                        "title": meta["title"],
                        "icon": meta["icon"],
                    }
                )
    # Sort: data rosnąco, potem tytuł (stabilny porządek dla tego samego dnia).
    events.sort(key=lambda e: (e["date"], e["title"]))
    return events


async def get_calendar(days: int = 7, today: date | None = None) -> dict[str, Any]:
    """
    Główne API modułu. Zwraca strukturalny kalendarz na najbliższe `days` dni.

    Response:
      {
        "days": 7,
        "from": "2026-06-15",
        "to": "2026-06-21",
        "events": [{date, type, category, title, icon}, ...],
        "source": "kb-waste-schedule",
        "scheduledTickets": []   # TODO: dołączyć scheduled tickets (patrz docstring)
      }
    """
    days = max(1, min(days, 31))  # sanity clamp 1..31
    today = today or date.today()

    docs = await _fetch_schedule_docs()

    # Scal harmonogram ze WSZYSTKICH dokumentów-harmonogramów (zwykle 1, ale
    # gdyby admin uploadował osobny doc per frakcja — łączymy).
    merged: dict[str, set[str]] = {}
    for doc in docs:
        title = str(doc.get("title") or "")
        text = str(doc.get("parsedText") or "")
        if not text or not _looks_like_schedule(title, text):
            continue
        for category, iso_dates in _parse_schedule_text(text).items():
            merged.setdefault(category, set()).update(iso_dates)

    events = build_events(merged, days, today)

    from datetime import timedelta

    return {
        "days": days,
        "from": today.isoformat(),
        "to": (today + timedelta(days=days - 1)).isoformat(),
        "events": events,
        "source": "kb-waste-schedule",
        # TODO (8.h.28 follow-up): scheduled tickets. Obecnie tickety NIE mają
        # pola scheduledFor — komentarz CalendarView wspomina o nich jako
        # „przyszłe", ale w schemacie (Ticket: type/status/replies) brak daty
        # planowanej. Dołączenie wymaga migracji `tickets.scheduledFor` + sync
        # do Edge. Zostawione jako TODO — zgłoszony problem to harmonogram śmieci.
        "scheduledTickets": [],
    }
