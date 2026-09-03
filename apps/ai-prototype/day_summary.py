"""
Day Summary — background pre-generation + cache.

FAZA 8.h.20 (2026-06-11). Dotąd Cloud `/resident/assistant/day-summary`
odpalał 2 pytania do Bielika ON-DEMAND (user czekał 10-60s przy zimnym
cache; Bielik 11B na M1 przy długim KB context potrafi przekroczyć timeout
→ pusta sekcja "Co dziś się wydarzy").

Teraz: pętla w tle generuje podsumowanie co 20 minut i trzyma w cache.
Endpoint `GET /day-summary` zwraca cache NATYCHMIAST (~5ms). Transient
timeouty LLM same się leczą przy następnym ticku — user nigdy nie widzi
pustki, najwyżej podsumowanie sprzed ≤20 min.

Predictions question ma fallback "najbliższe wydarzenia": gdy na dziś nic
nie ma w harmonogramie, Bielik podaje NAJBLIŻSZY nadchodzący termin (np.
odbiór śmieci za 2 dni) zamiast "nic nie zaplanowano".

Architektura:
  • `start(ask_fn)` — wołane z app.py na starcie FastAPI; ask_fn wstrzyknięte
    żeby uniknąć cyklicznego importu (app importuje day_summary, nie odwrotnie).
  • Cache: module-level dict; pierwsza generacja startuje od razu po boot.
  • Sekcje generowane SEKWENCYJNIE (nie parallel) — Ollama na M1 i tak
    serializuje inferencję; równoległe requesty tylko podbijają timeouty.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable

log = logging.getLogger("day-summary")

REFRESH_INTERVAL_S = 20 * 60  # 20 minut
RETRY_AFTER_FAILURE_S = 5 * 60  # po pełnym failu próbuj szybciej

# Pytania — phrasing musi trafiać w KNOWLEDGE_TRIGGER_KEYWORDS (predictions)
# i _looks_like_activity_summary (recap) w intent_classifier.py.
# UWAGA anty-halucynacja (incydent VN 2026-08-14): wcześniejsze phrasing
# wyliczało przykładowe kategorie („przerwy w wodzie lub prądzie") i Bielik
# WYMYŚLAŁ takie wydarzenie z datą, mimo że w bazie wiedzy go nie było.
# Nie podpowiadamy kategorii, których może nie być w dokumentach.
PREDICTIONS_QUESTION = (
    "Co dziś jest zaplanowane na osiedlu według harmonogramu? "
    "Wymień WYŁĄCZNIE wydarzenia zapisane w dokumentach — niczego nie dodawaj "
    "od siebie i nie twórz wydarzeń, których nie ma w źródle. "
    "Jeśli na dziś nie ma nic zaplanowanego, podaj NAJBLIŻSZE nadchodzące "
    "wydarzenia z dokumentów z konkretnymi datami — zacznij wtedy od "
    "'Na dziś brak wydarzeń. Najbliżej:'."
)
RECAP_QUESTION = "Co ciekawego działo się dzisiaj?"

_cache: dict[str, Any] = {
    "predictions": None,   # {text, intent, generatedAt}
    "recap": None,
    "generatedAt": None,   # ISO timestamp ostatniej PEŁNEJ generacji
    "generating": False,
}

AskFn = Callable[..., Awaitable[dict]]  # (question, smart=True)
_ask_fn: AskFn | None = None


def get_cached() -> dict:
    """Snapshot cache dla endpointu GET /day-summary."""
    return {
        "predictions": _cache["predictions"],
        "recap": _cache["recap"],
        "generatedAt": _cache["generatedAt"],
        "generating": _cache["generating"],
    }


async def _generate_section(question: str, label: str, smart: bool = True) -> dict | None:
    """Jedna sekcja przez wstrzyknięte ask_fn. None gdy fail/pusto."""
    if _ask_fn is None:
        return None
    try:
        res = await _ask_fn(question, smart)
        text = (res.get("answer") or "").strip()
        if not text:
            log.warning("%s: pusta odpowiedź", label)
            return None
        # Raw template fallback ("Znalazłem N fragmentów...") = smart LLM
        # zawiódł. Nie cache-ujemy ściany cytatów — zostawiamy poprzednią
        # dobrą wersję (None → merge w _generate_loop zachowa starą).
        if text.startswith("Znalazłem") and "fragment" in text[:40]:
            log.warning("%s: raw-template fallback — pomijam (retry za %ss)",
                        label, RETRY_AFTER_FAILURE_S)
            return None
        return {
            "text": text,
            "intent": res.get("intent"),
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
    except Exception as e:  # noqa: BLE001 — background loop nie może umrzeć
        log.warning("%s failed: %r", label, e)
        return None


_MONTHS_PL = [
    "stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca",
    "lipca", "sierpnia", "września", "października", "listopada", "grudnia",
]


def _fmt_date_pl(iso: str) -> str:
    _, m, d = iso.split("-")
    return f"{int(d)} {_MONTHS_PL[int(m) - 1]}"


async def _generate_predictions_calendar() -> dict | None:
    """
    Predictions ze strukturalnego kalendarza (waste_calendar, FAZA 8.h.28) —
    deterministycznie, BEZ LLM. Wprowadzone po incydencie 2026-08-14 (VN):
    Bielik z RAG-owych fragmentów WYMYŚLAŁ wydarzenia („przerwa w dostawie
    wody 25.08", „odbiór szkła 16.08") nieobecne w dokumencie, a dzisiejszy
    odbiór BIO pominął. Lekcja 8.h.16: fakty liczy Python, nie LLM.
    None TYLKO gdy w KB w ogóle nie ma harmonogramu (→ caller próbuje LLM).
    Gdy harmonogram JEST, ale wszystkie daty minęły (case b9 2026-08-14:
    dokument kończył się 7.08, a Bielik zmyślił „15.08 BIO, 17.08 ZIELONE"),
    zwracamy uczciwy komunikat o nieaktualnym dokumencie — bez LLM.
    """
    try:
        import waste_calendar as wc
        from datetime import date as _date
        docs = await wc._fetch_schedule_docs()
        scheds = [
            d for d in docs
            if wc._looks_like_schedule(d.get("title", ""), d.get("parsedText") or "")
        ]
        if not scheds:
            return None
        merged: dict[str, set[str]] = {}
        for d in scheds:
            for cat, dates in wc._parse_schedule_text(d.get("parsedText") or "").items():
                merged.setdefault(cat, set()).update(dates)
        all_dates = sorted({dt for v in merged.values() for dt in v})
        if not all_dates:
            return None
        events = wc.build_events(merged, days=31, today=_date.today())
    except Exception as e:  # noqa: BLE001
        log.warning("predictions-calendar failed: %r", e)
        return None

    today_iso = time.strftime("%Y-%m-%d")
    if not events:
        # Harmonogram istnieje, ale nie sięga w przyszłość — powiedz to wprost.
        text = (
            "Na dziś brak wydarzeń w harmonogramie. Uwaga: harmonogram w bazie "
            f"wiedzy kończy się {_fmt_date_pl(all_dates[-1])} — poproś "
            "administrację o wgranie aktualnego."
        )
        return {
            "text": text,
            "intent": "waste_calendar",
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
    by_date: dict[str, list[str]] = {}
    for ev in events:
        d = ev.get("date") or ""
        if d < today_iso:
            continue
        label = (ev.get("title") or "wydarzenie").strip()
        icon = (ev.get("icon") or "").strip()
        by_date.setdefault(d, []).append(f"{label.lower()} {icon}".strip())

    if not by_date:
        return None

    # Day Summary v2 (2026-08-17): akcjonalne podpowiedzi zamiast suchej listy —
    # dzisiejszy odbiór = „wystaw kubły", jutrzejszy = „wystaw dziś wieczorem".
    from datetime import date as _d, timedelta as _td
    tomorrow_iso = (_d.today() + _td(days=1)).isoformat()
    todays = by_date.pop(today_iso, None)
    tomorrows = by_date.pop(tomorrow_iso, None)
    upcoming = sorted(by_date.items())[:3]

    lines: list[str] = []
    if todays:
        lines.append(
            f"🗑️ Dziś odbiór: " + ", ".join(todays) + " — wystaw kubły, jeśli jeszcze stoją."
        )
    if tomorrows:
        lines.append(
            "🗑️ Jutro odbiór: " + ", ".join(tomorrows) + " — wystaw kubły dziś wieczorem."
        )
    if not todays and not tomorrows:
        lines.append("Dziś i jutro nie ma zaplanowanych odbiorów odpadów.")
    if upcoming:
        lines.append("Najbliżej:")
        for d, evs in upcoming:
            lines.append(f"• {_fmt_date_pl(d)} — " + ", ".join(evs))

    return {
        "text": "\n".join(lines),
        "intent": "waste_calendar",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


async def generate_once() -> bool:
    """
    Pełna generacja (predictions + recap, sekwencyjnie). Zwraca True gdy
    przynajmniej 1 sekcja się udała. Sekcje które się NIE udały zachowują
    poprzednią wartość w cache (stale-while-error).
    """
    _cache["generating"] = True
    try:
        ok = 0
        # Deterministyczny kalendarz przed LLM — patrz docstring wyżej.
        pred = await _generate_predictions_calendar()
        if pred is None:
            pred = await _generate_section(PREDICTIONS_QUESTION, "predictions")
        if pred:
            _cache["predictions"] = pred
            ok += 1
        # Day Summary v2 (2026-08-17): recap DETERMINISTYCZNY (smart=False —
        # template build_activity_summary). Bielik przy rewrapie przekłamywał
        # liczby („wjechało 7 aut, z czego 9 nie było na białej liście";
        # VN: 9+118 przy 53 wjazdach) — fakty liczy Python, nie LLM.
        recap = await _generate_section(RECAP_QUESTION, "recap", smart=False)
        if recap:
            _cache["recap"] = recap
            ok += 1
        if ok > 0:
            _cache["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        log.info("generate_once: %d/2 sekcji OK", ok)
        return ok > 0
    finally:
        _cache["generating"] = False


async def _loop() -> None:
    # Pierwsza generacja od razu (po 10s — daj FastAPI/Ollama dojść do siebie
    # po starcie, zwłaszcza po reboot Mac Mini gdy Ollama jeszcze cold).
    await asyncio.sleep(10)
    while True:
        try:
            ok = await generate_once()
        except Exception as e:  # noqa: BLE001
            log.error("day-summary loop tick failed: %r", e)
            ok = False
        await asyncio.sleep(REFRESH_INTERVAL_S if ok else RETRY_AFTER_FAILURE_S)


def start(ask_fn: AskFn) -> None:
    """Wire ask_fn + start background task. Wołane raz z app.py startup."""
    global _ask_fn
    _ask_fn = ask_fn
    asyncio.get_event_loop().create_task(_loop())
    log.info("day-summary background loop started (co %ss)", REFRESH_INTERVAL_S)
