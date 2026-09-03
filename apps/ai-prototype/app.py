"""
GateLynk AI backend — FastAPI entry point.

Deployment context:
  • Mac Mini (Edge, 192.168.1.127): hostuje ten serwis na porcie 8000
  • MacBook Pro (192.168.1.109): Ollama z qwen2.5:14b
  • Database: sqlite Edge (/Users/shc_development/gatelynk-edge/data/store.db, read-only)

Endpoint: POST /ask
Body:  {"question": "Ile białych samochodów dziś wjechało?"}

Flow per request:
  1. POST /ask                                         (user)
  2. intent_classifier.classify(question)              (regex → LLM → validate)
  3. sql_templates.get_template(intent)                (whitelist lookup)
  4. map params (direction in/out → forward/reverse, duplicate dla `IS NULL` checks)
  5. db.execute_safe(sql, positional_params)           (sqlite read-only)
  6. response_builder.build(intent, params, rows)      (deterministic format)
  7. JSON response                                     (user)
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from config import CONFIG
from conversation import Turn, rewrite_question_with_context
from db import execute_safe
from intent_classifier import classify
from response_builder import (
    UNKNOWN_MSG,
    build,
    build_activity_summary,
    build_knowledge_response,
    build_waste_pickup_status,
)
from smart_responder import (
    generate_activity_natural_answer,
    generate_knowledge_natural_answer,
    generate_natural_answer,
    suggest_follow_ups,
)
from sql_templates import get_template

# Edge HTTP endpoint dla knowledge search. Prototype i Edge żyją na tej samej
# maszynie (Mac Mini) — defaultowo localhost. Override w env (np. dev na laptopie).
EDGE_URL = os.environ.get("EDGE_URL", "http://localhost:4000")

logging.basicConfig(
    level=CONFIG.log_level,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("gatelynk-ai")

app = FastAPI(
    title="GateLynk AI Backend",
    version="0.1.0",
    description=(
        "Intent-routed AI dla danych GateLynk. LLM klasyfikuje intencję, "
        "backend wykonuje gotowy whitelisted SQL na sqlite Edge. "
        "Bez halucynacji, bez dowolnego SQL od LLM."
    ),
)


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=CONFIG.max_question_chars)
    # Smart mode: LLM sumarize raw data into natural Polish answer + suggest
    # 1-3 follow-up questions. Default True (user wybrał LLM-enhanced mode).
    # False → zwraca template f-string (5-15ms vs 1-3s LLM).
    smart: bool = True
    # Multi-turn context: ostatnie N (zwykle ≤6) tur user/assistant.
    # Gdy obecne i pytanie wygląda na follow-up, robimy LLM rewrite żeby
    # rozwiązać zaimki/elipsy ("A jego mail?" → "Adres email Janusza").
    # Brak / pusta lista = stateless mode (zachowanie pre-2026-05-20).
    history: Optional[list[Turn]] = None


class AskResponse(BaseModel):
    intent: str
    parameters: dict
    answer: str
    # Optional zamiast `dict | None` — pydantic v2 wymaga runtime-evaluable
    # annotations dla BaseModel (Python 3.9 nie obsługuje PEP 604 `X | Y` at runtime).
    data: Optional[dict] = None
    # Smart mode: 1-3 sugestie dalszych pytań (LLM-generated). [] gdy off.
    follow_ups: Optional[list] = None
    # Multi-turn debug: gdy rewrite zaszedł, oryginał vs wynik. UI/badge.
    rewritten_question: Optional[str] = None


# ── Direction mapping: intent canonical → Edge DB value ──────────────────────
# intent classifier zwraca 'in'/'out' (per spec), Edge lpr_reads.direction
# używa 'forward'/'reverse' (stare wiersze) LUB 'IN'/'OUT' (semantyczny
# kierunek, od 2026-08-14). Normalizacja jest w SQL (DIRECTION_NORM w
# sql_templates.py) — tu przekazujemy intent-level 'in'/'out' wprost.
INTENT_TO_DB_DIRECTION = {"in": "in", "out": "out"}


def _resolve_param(name: str, intent_params: dict) -> Any:
    """
    Mapping intent param name → wartość do bindowania w SQL.

    Specjalna obsługa:
      • 'direction' — 'in'/'out' wprost (SQL normalizuje kolumnę przez
        DIRECTION_NORM — obsługuje forward/reverse ORAZ IN/OUT).
      • Inne — bezpośrednio z intent_params, None gdy brak (optional).
    """
    if name == "direction":
        v = intent_params.get("direction")
        return INTENT_TO_DB_DIRECTION.get(v) if v else None
    return intent_params.get(name)


# ── Day Summary — background pre-generation (FAZA 8.h.20) ───────────────────
# Pętla generuje podsumowanie co 20 min; endpoint zwraca cache natychmiast.
import day_summary as _day_summary


@app.on_event("startup")
async def _start_day_summary() -> None:
    # Day Summary v2 (2026-08-17): smart przekazywalny per sekcja — recap idzie
    # z smart=False (deterministyczny template; Bielik przekłamywał liczby:
    # „wjechało 7 aut, z czego 9 spoza listy").
    async def _ask(question: str, smart: bool = True) -> dict:
        return await ask(AskRequest(question=question, smart=smart))
    _day_summary.start(_ask)


@app.get("/day-summary")
async def day_summary_cached() -> dict:
    """
    Cache z background loop — NIE odpala LLM. ~5ms response.
    Sekcja = None gdy jeszcze nie wygenerowana (np. pierwsze 60s po boot).
    """
    return _day_summary.get_cached()


# ── Structured Calendar — harmonogram śmieci jako per-dzień eventy (8.h.28) ──
import waste_calendar as _waste_calendar


# ── Kronika dnia — digest zdarzeń sytuacyjnych (2026-08-26) ─────────────────
import chronicle as _chronicle


@app.get("/chronicle")
async def chronicle_endpoint(smart: int = 1) -> dict:
    """
    Digest dnia: statystyka ruchu + zdarzenia sytuacyjne (situation_events
    z korelatora Edge) + opcjonalna narracja Bielika (guard cyfr — liczby
    tylko z faktów). Cloud woła przez Edge `/assistant/chronicle` o 21:00
    (push do budynku) i w preview.
    """
    return await _chronicle.build_chronicle(smart=bool(smart))


@app.get("/calendar")
async def calendar(days: int = 7) -> dict:
    """
    Strukturalny kalendarz na najbliższe `days` dni — per-dzień eventy odbioru
    śmieci wyciągnięte DETERMINISTYCZNIE z KB harmonogramu (bez LLM).

    Używane przez iOS CalendarView (przez Cloud `/resident/assistant/calendar`
    → Edge `/assistant/calendar` → tutaj). Zwraca listę
    `events: [{date, type, category, title, icon}]` którą iOS grupuje po dacie
    i renderuje na właściwych kartach dni. Zastępuje placeholder „Brak danych
    z harmonogramu".
    """
    return await _waste_calendar.get_calendar(days=days)


@app.get("/health")
async def health() -> dict:
    """Health check. Sprawdza tylko czy proces żyje, nie DB ani LLM."""
    # FAZA 8.h.11 — dynamic LLM (Bielik / Qwen3 / etc. z Edge `/ai-engine`).
    from llm_config import get_active_llm
    llm = get_active_llm()
    return {
        "status": "ok",
        "model": llm.model,
        "ollama_url": llm.url,
        "llm_source": llm.source,  # 'edge_db' lub 'env_fallback'
        "sqlite_path": CONFIG.sqlite_path,
    }


@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest) -> dict:
    """
    Klasyfikuje pytanie → SQL → format response.

    Kontrakty:
      • intent zwracany jest TYLKO z listy VALID_INTENTS
      • SQL pochodzi TYLKO z TEMPLATES whitelisty
      • answer pochodzi TYLKO z response_builder (deterministyczne)
    """
    # ── Multi-turn rewrite ────────────────────────────────────────────────
    # Gdy iOS dostarczył historię i pytanie wygląda na follow-up, rozwiązujemy
    # zaimki/elipsy przez LLM PRZED intent classify. To kluczowe dla bge-m3
    # knowledge search — embedding "jego" nie powie nam o kim mowa, ale
    # "telefon Janusza Aszklara" już tak.
    history = req.history or []
    effective_q = await rewrite_question_with_context(req.question, history)
    rewritten = effective_q if effective_q != req.question else None
    if rewritten:
        log.info(
            "Rewrite: %r → %r (history=%d turns)",
            req.question[:120],
            rewritten[:120],
            len(history),
        )

    classified = await classify(effective_q)
    intent = classified["intent"]
    params = classified["parameters"]
    log.info(
        "Q=%r → intent=%s params=%s",
        effective_q[:120],
        intent,
        params,
    )

    def _attach(d: dict) -> dict:
        """Wzbogać response o rewritten_question (gdy rewrite zaszedł)."""
        if rewritten:
            return {**d, "rewritten_question": rewritten}
        return d

    # Unknown — bez DB call, fixed message.
    if intent == "unknown":
        return _attach({
            "intent": "unknown",
            "parameters": {},
            "answer": UNKNOWN_MSG,
            "data": None,
        })

    # ── KNOWLEDGE BASE: bypass SQL templates, call Edge HTTP endpoint ──
    # Knowledge search nie używa sqlite SELECT — Edge KnowledgeService robi
    # bge-m3 embedding + cosine similarity nad indeksowanymi chunkami. Prototype
    # tylko proxy-uje request i opcjonalnie pakuje wynik w LLM smart layer.
    if intent == "search_knowledge_base":
        return _attach(await _handle_knowledge_search(req, params))

    # ── ACTIVITY SUMMARY: multi-aggregate raport ────────────────────────────
    # Łączy 2 queries: LPR (in/out, matched/unmatched, kurierzy, brama)
    # + vision (osoby, psy, koty, etc.). Nie pasuje do "1 template = 1 SELECT"
    # patternu — custom handler.
    if intent == "recent_activity_summary":
        return _attach(await _handle_activity_summary(req, params))

    # ── WASTE PICKUP STATUS (Event Intelligence §8): harmonogram + obserwacje.
    # Composite: waste_calendar (KB doc) + vision_detections z dziś. Odpowiedź
    # ZAWSZE deterministyczna (bez LLM rewrap) — hedging „najprawdopodobniej /
    # wjazd nie przesądza wykonania" ma przetrwać dosłownie (lekcja 8.h.23).
    if intent == "waste_pickup_status":
        return _attach(await _handle_waste_pickup_status(req, params))

    # Lookup template (defense-in-depth — intent powinno być w whiteliście).
    template = get_template(intent)
    if template is None:
        log.error("Intent %s nie ma template-u — bug?", intent)
        return _attach({
            "intent": "unknown",
            "parameters": {},
            "answer": UNKNOWN_MSG,
            "data": None,
        })

    # Build positional args wg template["params"]. Direction mapped do
    # DB-form (in→forward, out→reverse). Brakujące = None (template ma
    # `(? IS NULL OR ...)` short-circuit).
    sql_args = [_resolve_param(name, params) for name in template["params"]]

    try:
        rows = await execute_safe(template["sql"], sql_args)
    except ValueError as e:
        # Naruszenie invariantu (SQL nie zaczyna się od SELECT) — bug w templates.
        log.error("Template invariant violation: %s", e)
        raise HTTPException(500, "Internal template error")
    except Exception as e:
        log.exception("DB query failed")
        raise HTTPException(500, f"DB error: {e!s}")

    # Template answer — fallback dla smart-mode + payload data.
    base = build(intent, params, rows)

    # FAZA 8.h.23 (2026-06-12) — intenty z polityką prywatności pomijają
    # smart naturalization. Template answer jest finalny i precyzyjny
    # ("nie mogę podać danych właściciela, lokal X") — Bielik przy rewrap
    # potrafił dopowiadać dane z rows/tagów (live test: ujawnił "Taxi Uber"
    # mimo intencji ukrycia). Deterministyczny tekst > kreatywny LLM.
    # 2026-08-24 — list_vehicles_recent: lista tablic z godzinami jest już
    # finalna; Bielik przy rewrap gubi/przekręca tablice rejestracyjne.
    NO_SMART_INTENTS = {"vehicle_owner_by_plate", "list_vehicles_recent"}

    if not req.smart or intent in NO_SMART_INTENTS:
        # Strict template mode: deterministic, 5-15ms.
        return _attach(base)

    # FAZA 8.h.32 — search_by_vehicle_make: rows z LEFT JOIN zawierają też
    # pojazdy z whitelisty BEZ przejazdu w oknie (time=NULL). Live test
    # 2026-07-05: Bielik zinterpretował 7 takich wierszy jako „widziałem
    # 7 Mercedesów" mimo ZERO przejazdów. Fix (lekcja 8.h.16 — deterministyka):
    #   • zero przejazdów → template answer jest finalny (bez LLM),
    #   • są przejazdy → LLM dostaje TYLKO wiersze z time (odczyty LPR).
    if intent == "search_by_vehicle_make":
        rows = [r for r in rows if r.get("time")]
        if not rows:
            # Marka jest na whitelistcie, ale bez przejazdu w zadanym oknie —
            # dopisz OSTATNIE znane wykrycie z 30 dni (deterministycznie,
            # 2. wykonanie tego samego template z range=720). User dostaje
            # „kiedy była", nie gołe „brak danych" (wymóg transkryptu).
            whitelisted = int((base.get("data") or {}).get("whitelisted_plates") or 0)
            if whitelisted > 0 and int(params.get("range_hours", 24)) < 720:
                try:
                    wide_rows = await execute_safe(
                        template["sql"],
                        [params["sql_make_a"], params["sql_make_b"], 720],
                    )
                    wide_reads = [r for r in wide_rows if r.get("time")]
                    if wide_reads:
                        lastr = wide_reads[0]
                        base["answer"] += (
                            f" Ostatni zarejestrowany przejazd pojazdu marki "
                            f"{params.get('make', '?')}: {lastr['time']} "
                            f"({lastr['plate']})."
                        )
                        base["data"]["last_seen"] = {
                            "time": lastr["time"],
                            "plate": lastr["plate"],
                            "unitLabel": lastr.get("unit_label") or None,
                        }
                except Exception:
                    log.warning("make wide-window lookup failed", exc_info=True)
            return _attach(base)

    # Smart mode: LLM sumarize + follow-up suggestions.
    # Robimy obie operacje równolegle — ~2× speed-up gdy LLM cold.
    # Używamy `effective_q` (po rewrite) — LLM dostaje pełen kontekst zamiast
    # zaimków typu „jego" i może lepiej skomponować odpowiedź.
    natural_answer, follow_ups = await asyncio.gather(
        generate_natural_answer(
            effective_q,
            intent,
            params,
            rows,
            template_answer=base["answer"],
        ),
        suggest_follow_ups(
            effective_q,
            intent,
            params,
            answer=base["answer"],
        ),
    )

    log.info(
        "Smart mode: template=%r → natural=%r (%d follow-ups)",
        base["answer"][:80],
        natural_answer[:80],
        len(follow_ups),
    )

    return _attach({
        **base,
        # 2026-08-24 — Bielik potrafi zwrócić PUSTY string przy krótkich
        # szablonach ("Dziś wjechało 82 auta.") → panel dostawał pusty dymek.
        # Pusta naturalizacja = zostaje deterministyczny szablon.
        "answer": natural_answer.strip() or base["answer"],
        "follow_ups": follow_ups,
    })


# ─────────────────────────────────────────────────────────────────────────────
# Knowledge base search — bypass SQL flow, proxy do Edge KnowledgeService
# ─────────────────────────────────────────────────────────────────────────────

async def _handle_knowledge_search(req: AskRequest, params: dict) -> dict:
    """
    Wykonaj semantic search w bazie wiedzy przez Edge HTTP endpoint.
    Zwraca template answer (fast mode) lub LLM-composed natural answer (smart).

    Timeout 10s — Edge KnowledgeService robi 1 Ollama embed call (bge-m3 ~150ms)
    + brute-force cosine N×1024 (~20ms dla <1000 chunków). 10s daje margines
    na cold Ollama.
    """
    query = params["query"]
    body: dict[str, Any] = {"query": query, "limit": 5, "minScore": 0.4}
    if "type" in params:
        body["type"] = params["type"]

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(f"{EDGE_URL}/knowledge/search", json=body)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        log.warning("Knowledge search failed: %s", e)
        return {
            "intent": "search_knowledge_base",
            "parameters": params,
            "answer": "Nie udało się przeszukać bazy wiedzy.",
            "data": None,
        }

    hits = data.get("hits", [])
    type_filter = params.get("type")
    base = build_knowledge_response(query, type_filter, hits)

    if not req.smart or not hits:
        return base

    # FAZA 8.h.18 (2026-06-09) — daj LLM-owi pre-deduped hits żeby nie
    # widział dwukrotnie tego samego dokumentu (np. harmonogram_smieci).
    # `build_knowledge_response` już zrobił dedup po (docId, title) i
    # zapisał wynik w `data.dedupedHits`. Fallback do `hits` gdyby kontrakt
    # się zmienił.
    deduped_hits = base.get("data", {}).get("dedupedHits") or hits

    # Smart mode: LLM composes natural Polish answer + follow-ups (równolegle).
    natural, follow_ups = await asyncio.gather(
        generate_knowledge_natural_answer(query, deduped_hits, base["answer"]),
        suggest_follow_ups(query, "search_knowledge_base", params, base["answer"]),
    )
    return {**base, "answer": (natural or "").strip() or base["answer"], "follow_ups": follow_ups}


# ─────────────────────────────────────────────────────────────────────────────
# Activity summary — multi-aggregate report (LPR + vision)
# ─────────────────────────────────────────────────────────────────────────────

# LPR aggregate query — jeden wiersz z 7 kolumnami.
# Wszystko z jednego SELECT na lpr_reads w oknie czasowym `?` godzin.
# SUM(CASE WHEN ...) zamiast COUNT(WHERE ...) bo musimy mieć 7 metryk z jednego skanu.
_LPR_SUMMARY_SQL = """
    SELECT
      COUNT(*)                                                  AS total,
      SUM(CASE WHEN direction IN ('forward','IN') THEN 1 ELSE 0 END)   AS in_count,
      SUM(CASE WHEN direction IN ('reverse','OUT') THEN 1 ELSE 0 END)  AS out_count,
      SUM(CASE WHEN matched = 1 THEN 1 ELSE 0 END)              AS matched_count,
      SUM(CASE WHEN matched = 0 THEN 1 ELSE 0 END)              AS unmatched_count,
      SUM(CASE WHEN gate_opened = 1 THEN 1 ELSE 0 END)          AS gate_opens,
      SUM(
        CASE
          -- FIX 8.h.30: bez 'SERVICE' (SERVICE = opiekunka/ogrodnik/serwisant,
          -- nie kurier); tagi przez LIKE (łapie "Kurier InPost") — sync
          -- z courier_today i search_courier_recent w sql_templates.py.
          WHEN vehicle_kind = 'DELIVERY' THEN 1
          WHEN EXISTS (
                 SELECT 1 FROM json_each(COALESCE(vehicle_tags, '[]'))
                  WHERE LOWER(value) LIKE '%kurier%'
                     OR LOWER(value) LIKE '%dostaw%'
                     OR LOWER(value) LIKE '%courier%'
               ) THEN 1
          ELSE 0
        END
      )                                                         AS courier_count
      FROM lpr_reads
     WHERE ts >= (strftime('%s','now') - ? * 3600) * 1000
"""

# Vision aggregate — sumujemy frames-with-class (NIE detection count) jako
# proxy „obecności": każdy notable frame = ~1 zdarzenie obecności obiektu.
# Sumowanie raw detection count daje 5-10x inflację (osoba w polu widzenia
# przez 30s = 60 detekcji w 0.5fps stream).
_VISION_SUMMARY_SQL = """
    SELECT
      COUNT(*)                                                    AS frame_count,
      SUM(CASE WHEN COALESCE(json_extract(summary,'$.person'), 0)  > 0 THEN 1 ELSE 0 END) AS person_frames,
      SUM(CASE WHEN COALESCE(json_extract(summary,'$.dog'),    0)  > 0 THEN 1 ELSE 0 END) AS dog_frames,
      SUM(CASE WHEN COALESCE(json_extract(summary,'$.cat'),    0)  > 0 THEN 1 ELSE 0 END) AS cat_frames,
      SUM(CASE WHEN COALESCE(json_extract(summary,'$.truck'),  0)  > 0 THEN 1 ELSE 0 END) AS truck_frames,
      SUM(CASE WHEN COALESCE(json_extract(summary,'$.bicycle'),0)  > 0 THEN 1 ELSE 0 END) AS bicycle_frames,
      -- Notable events: distinct image_path (Edge zapisuje tylko klatki
      -- z person|dog dla audytu — to lepszy proxy unikalnych „zdarzeń").
      COUNT(DISTINCT image_path)                                  AS notable_events
      FROM vision_detections
     WHERE ts >= (strftime('%s','now') - ? * 3600) * 1000
"""

# Wszystkie klatki z osobą — używane do temporal clustering (liczenie
# „wizyt osób" zamiast „klatek z osobą"). YOLO nie ma person-tracker'a,
# więc nie zna unikalnych osób — to BEST EFFORT proxy:
#
#   • sesja = ciągłe klatki z person>0 z gap'em ≤30s
#   • liczba sesji = liczba wizyt (każda sesja to inne pojawienie się
#     w polu widzenia kamery)
#   • sum(max(person) per session) = szacunkowa liczba unikalnych osób
#     (ta sama osoba w jednej sesji = liczona 1 raz; ta sama osoba dwie
#     osobne wizyty = liczona 2 razy — to inherent w tym proxy)
#
# Per-camera bo cross-camera tracking wymaga embedding Re-ID model
# (out of scope dla YOLOv8 + temporal clustering wystarcza dla MVP).
_VISION_PERSON_FRAMES_SQL = """
    SELECT
      ts,
      camera_device_id                              AS camera,
      COALESCE(json_extract(summary, '$.person'), 0) AS person_count
      FROM vision_detections
     WHERE ts >= (strftime('%s','now') - ? * 3600) * 1000
       AND COALESCE(json_extract(summary, '$.person'), 0) > 0
     ORDER BY camera_device_id, ts
"""

# Marki rozpoznane przez Hikvision LPR (kolumna `vehicle_brand`). Filtrujemy
# raw `#NNNN` kody (niezmapowane w `hikvision-vehicle-brands.ts`) — pokazujemy
# tylko ludzko-czytelne nazwy (np. "DPD" po naszym mapping-u `1044 → DPD`).
_LPR_BRANDS_SQL = """
    SELECT
      vehicle_brand                                AS brand,
      COUNT(*)                                     AS hits,
      MAX(ts)                                      AS last_ts
      FROM lpr_reads
     WHERE ts >= (strftime('%s','now') - ? * 3600) * 1000
       AND vehicle_brand IS NOT NULL
       AND vehicle_brand != ''
       AND vehicle_brand NOT LIKE '#%'
     GROUP BY vehicle_brand
     ORDER BY hits DESC, last_ts DESC
     LIMIT 12
"""

# Marki rozpoznane przez EasyOCR na bocie pojazdu (vision pipeline).
# Niezależne źródło od `vehicle_brand` — tu mamy DHL/DPD/InPost znalezione
# w napisach z OCR. `COUNT(DISTINCT image_path)` jako proxy unikalnych
# zdarzeń (jedno auto = jedna klatka archive = 1 wizyta).
_VISION_BRANDS_SQL = """
    SELECT
      brand_detected                               AS brand,
      COUNT(DISTINCT COALESCE(image_path, id))     AS hits,
      MAX(ts)                                      AS last_ts
      FROM vision_detections
     WHERE ts >= (strftime('%s','now') - ? * 3600) * 1000
       AND brand_detected IS NOT NULL
     GROUP BY brand_detected
     ORDER BY hits DESC
     LIMIT 12
"""

# Keyword-match w `owner` (whitelist match) — łapie taksówki/kurierów/restauracje
# które mają nazwę w polu owner z Cloud whitelist (np. "Bolt - Taxi", "Glovo",
# "Kimi Sushi"). Substring lowercase match — większość owner-ów to plain text.
_LPR_KEYWORDS_SQL = """
    SELECT
      owner                                        AS owner,
      COUNT(*)                                     AS hits,
      MAX(ts)                                      AS last_ts
      FROM lpr_reads
     WHERE ts >= (strftime('%s','now') - ? * 3600) * 1000
       AND owner IS NOT NULL
       AND owner != ''
       AND (
            LOWER(owner) LIKE '%bolt%'
         OR LOWER(owner) LIKE '%uber%'
         OR LOWER(owner) LIKE '%taxi%'
         OR LOWER(owner) LIKE '%free now%'
         OR LOWER(owner) LIKE '%mytaxi%'
         OR LOWER(owner) LIKE '%glovo%'
         OR LOWER(owner) LIKE '%wolt%'
         OR LOWER(owner) LIKE '%pyszne%'
         OR LOWER(owner) LIKE '%frisco%'
         OR LOWER(owner) LIKE '%lisek%'
         OR LOWER(owner) LIKE '%dhl%'
         OR LOWER(owner) LIKE '%dpd%'
         OR LOWER(owner) LIKE '%inpost%'
         OR LOWER(owner) LIKE '%fedex%'
         OR LOWER(owner) LIKE '%gls%'
         OR LOWER(owner) LIKE '%ups%'
         OR LOWER(owner) LIKE '%poczt%'
         OR LOWER(owner) LIKE '%dachser%'
         OR LOWER(owner) LIKE '%sushi%'
         OR LOWER(owner) LIKE '%pizza%'
         OR LOWER(owner) LIKE '%mcdonald%'
         OR LOWER(owner) LIKE '%kfc%'
       )
     GROUP BY owner
     ORDER BY hits DESC
     LIMIT 12
"""

# Śmieciarki (vision EasyOCR — `waste_category` z napisu na boku). Grupujemy
# po (category, operator) bo SZKŁO/PAPIER/etc często z różnymi operatorami.
_WASTE_SQL = """
    SELECT
      waste_category                               AS category,
      waste_operator                               AS operator,
      COUNT(DISTINCT COALESCE(image_path, id))     AS hits,
      strftime('%H:%M',
               datetime(MAX(ts)/1000, 'unixepoch', 'localtime')) AS last_time
      FROM vision_detections
     WHERE ts >= (strftime('%s','now') - ? * 3600) * 1000
       AND waste_category IS NOT NULL
     GROUP BY waste_category, waste_operator
     ORDER BY hits DESC
"""


def _compute_person_visits(
    rows: list[dict],
    gap_ms: int = 120_000,
) -> dict:
    """
    Temporal clustering klatek z osobą w sesje (wizyty).

    Args:
      rows: lista wierszy z `_VISION_PERSON_FRAMES_SQL` (ts, camera, person_count)
             posortowana po (camera, ts) — gwarantowane SQL ORDER BY.
      gap_ms: max przerwa między klatkami tej samej sesji (default 120s = 2×
             vision poll interval). Vision polluje co 60s, więc 30s threshold
             oznaczałby że każda klatka = nowa sesja (po 60s gap). 120s pokrywa
             cykliczny poll + 1 occasional miss → osoba widoczna przez >60s
             na 2 consecutive klatkach trafia do tej samej sesji.

    Returns:
      {
        "visits":           int,  # liczba sesji per-camera (suma)
        "est_persons":      int,  # SUM(max_per_session) — szacowane unikalne
        "max_concurrent":   int,  # MAX person count w pojedynczej klatce
        "frames_with_person": int  # raw count klatek dla porównania
      }

    Honest about uncertainty: ta sama osoba przychodząca 2× w odstępie > gap_ms
    jest liczona 2 razy. To **proxy**, nie ground truth.
    """
    if not rows:
        return {"visits": 0, "est_persons": 0, "max_concurrent": 0, "frames_with_person": 0}

    visits = 0
    est_persons = 0
    max_concurrent = 0
    frames = len(rows)

    # Per-camera state — gap reset gdy zmienia się kamera.
    current_camera = None
    current_session_max = 0
    last_ts = 0

    for r in rows:
        cam = r.get("camera")
        ts = int(r.get("ts") or 0)
        count = int(r.get("person_count") or 0)
        max_concurrent = max(max_concurrent, count)

        if cam != current_camera or (ts - last_ts) > gap_ms:
            # Zamknij poprzednią sesję (jeśli istnieje)
            if current_session_max > 0:
                visits += 1
                est_persons += current_session_max
            # Nowa sesja
            current_camera = cam
            current_session_max = count
        else:
            current_session_max = max(current_session_max, count)
        last_ts = ts

    # Domknij ostatnią sesję
    if current_session_max > 0:
        visits += 1
        est_persons += current_session_max

    return {
        "visits": visits,
        "est_persons": est_persons,
        "max_concurrent": max_concurrent,
        "frames_with_person": frames,
    }


def _merge_special_guests(
    lpr_brand_rows: list[dict],
    vision_brand_rows: list[dict],
    lpr_keyword_rows: list[dict],
) -> list[dict]:
    """
    Złącz 3 źródła nazwanych marek/usług w jednolitą listę z licznikami.

    Priorytet źródeł (gdy duplikat, bierzemy max hits z każdego źródła):
      1. Vision brand_detected (EasyOCR na boku pojazdu) — najsilniejszy
         sygnał, OCR daje wprost UPPERCASE brand (DPD, DHL, INPOST).
      2. LPR vehicle_brand (Hikvision native, np. „DPD" po mapping #1044).
      3. LPR owner keyword (Bolt/Taxi/Glovo z whitelist owner-a).

    Dedup case-insensitive po brand/owner. Zwracana lista uszeregowana po
    `hits DESC`, z polem `kind` (kurier/taksówka/jedzenie/inne) — używanym
    przez response builder do prefix-owania emoji.
    """
    by_key: dict[str, dict] = {}

    def classify_kind(name: str) -> str:
        n = name.lower()
        if any(k in n for k in ("bolt", "uber", "taxi", "free now", "mytaxi")):
            return "taksówka"
        if any(k in n for k in ("dhl", "dpd", "inpost", "fedex", "gls", "ups",
                                "poczt", "dachser", "geopost", "allegro")):
            return "kurier"
        if any(k in n for k in ("glovo", "wolt", "pyszne", "frisco", "lisek",
                                "sushi", "pizza", "mcdonald", "kfc")):
            return "jedzenie"
        return "inne"

    def upsert(name: str | None, hits: int, source: str) -> None:
        if not name:
            return
        clean = str(name).strip()
        if not clean:
            return
        key = clean.lower()
        if key in by_key:
            existing = by_key[key]
            if hits > existing["hits"]:
                existing["hits"] = hits
                existing["source"] = source
        else:
            by_key[key] = {
                "name": clean,
                "hits": hits,
                "kind": classify_kind(clean),
                "source": source,
            }

    for r in vision_brand_rows:
        upsert(r.get("brand"), int(r.get("hits") or 0), "vision")
    for r in lpr_brand_rows:
        upsert(r.get("brand"), int(r.get("hits") or 0), "lpr_brand")
    for r in lpr_keyword_rows:
        upsert(r.get("owner"), int(r.get("hits") or 0), "lpr_owner")

    return sorted(by_key.values(), key=lambda x: (-x["hits"], x["name"]))


# ── waste_pickup_status (Event Intelligence §8, 2026-08-15) ──────────────────

# Mapowanie frakcji KB (waste_calendar, tokeny harmonogramu) → kategorie vision
# (waste_matcher zapisuje GLASS/PAPER/PLASTIC/BIO/MIXED do vision_detections).
_WASTE_KB2VISION = {
    "ZMIESZANE": "MIXED",
    "BIO": "BIO",
    "ZIELONE": "BIO",
    "PAPIER": "PAPER",
    "SZKLO": "GLASS",
    "METAL_TWORZYWA": "PLASTIC",
}

_WASTE_VISION_LABEL_PL = {
    "MIXED": "śmieciarka (zmieszane)",
    "GLASS": "śmieciarka (szkło)",
    "PAPER": "śmieciarka (papier)",
    "PLASTIC": "śmieciarka (metale i tworzywa)",
    "BIO": "śmieciarka (bio)",
}

_WASTE_OBS_TODAY_SQL = """
    SELECT strftime('%H:%M', datetime(v.ts/1000,'unixepoch','localtime')) AS time,
           v.waste_category AS category,
           v.waste_operator AS operator,
           COALESCE(json_extract(dc.config,'$.name'), v.camera_device_id) AS camera
      FROM vision_detections v
      LEFT JOIN device_config dc ON dc.device_id = v.camera_device_id
     WHERE v.ts >= unixepoch('now','localtime','start of day','utc') * 1000
       AND v.waste_category IS NOT NULL
       AND (? IS NULL OR v.waste_category = ?)
     ORDER BY v.ts ASC
     LIMIT 20
"""


async def _handle_waste_pickup_status(req: AskRequest, params: dict) -> dict:
    """
    „Czy śmieci już zabrali?" — SCHEDULE_VS_OBSERVED: harmonogram z KB
    (waste_calendar parser) + dzisiejsze obserwacje kamer (waste_category).
    Odpowiedź składa response_builder.build_waste_pickup_status —
    deterministycznie, z zachowaniem poziomów pewności (spec §6/§18).
    """
    from datetime import date

    category = params.get("category")  # vision-side (MIXED/GLASS/…) albo None
    today = date.today()
    iso_today = today.isoformat()

    # Harmonogram: scal wszystkie dokumenty-harmonogramy (jak get_calendar,
    # ale potrzebujemy też PRZESZŁYCH dat — wykrycie nieaktualnego dokumentu).
    docs = await _waste_calendar._fetch_schedule_docs()
    merged: dict[str, set[str]] = {}
    for doc in docs:
        title = str(doc.get("title") or "")
        text = str(doc.get("parsedText") or "")
        if not text or not _waste_calendar._looks_like_schedule(title, text):
            continue
        for kb_cat, iso_dates in _waste_calendar._parse_schedule_text(text).items():
            merged.setdefault(kb_cat, set()).update(iso_dates)

    all_dates: set[str] = set()
    scheduled_today: list[dict] = []
    for kb_cat, iso_dates in merged.items():
        all_dates |= iso_dates
        if iso_today in iso_dates:
            vis = _WASTE_KB2VISION.get(kb_cat)
            if category is None or vis == category:
                meta = _waste_calendar.WASTE_CATEGORIES.get(
                    kb_cat, {"title": f"Odbiór ({kb_cat})", "icon": "🗑️"},
                )
                scheduled_today.append({
                    "category": kb_cat,
                    "category_valid": vis,
                    "title": meta["title"],
                    "date": iso_today,
                })

    # Najbliższy PRZYSZŁY odbiór (dla pytanej frakcji, albo dowolny).
    next_event = None
    for e in _waste_calendar.build_events(merged, 92, today):
        if e["date"] <= iso_today:
            continue
        if category is not None and _WASTE_KB2VISION.get(e["category"]) != category:
            continue
        next_event = e
        break

    # Harmonogram nieaktualny — wszystkie daty w przeszłości (lekcja b9).
    schedule_stale_date = None
    if all_dates and max(all_dates) < iso_today:
        schedule_stale_date = max(all_dates)

    try:
        rows = await execute_safe(_WASTE_OBS_TODAY_SQL, [category, category])
    except Exception as e:
        log.exception("waste_pickup_status query failed")
        raise HTTPException(500, f"DB error: {e!s}")

    observations = [
        {
            "time": r.get("time"),
            "operator": r.get("operator"),
            "category": r.get("category"),
            "category_label": _WASTE_VISION_LABEL_PL.get(
                str(r.get("category") or ""), "śmieciarka",
            ),
            "camera": r.get("camera"),
        }
        for r in rows
    ]

    # Deterministycznie — bez LLM rewrap (hedging ma przetrwać dosłownie).
    return build_waste_pickup_status(
        category, scheduled_today, observations, next_event, schedule_stale_date,
    )


async def _handle_activity_summary(req: AskRequest, params: dict) -> dict:
    """
    Wykonuje równolegle 2 zapytania (LPR + vision) i komponuje multi-section
    raport. Smart mode: LLM rewrap dla naturalnego brzmienia.

    Timeout: każdy SQL ~10-30ms na 24h windows, więc 60s ogólny limit aiosqlite
    z `execute_safe` jest mocno z zapasem.
    """
    range_hours = int(params.get("range_hours", 4))

    # asyncio.gather z 6 osobnymi sqlite connections — równolegle. sqlite WAL
    # mode supports concurrent readers without lock contention. Każde z 6
    # query zwykle 5-30ms na 24h windows; równoległe = ~max(5...30)ms.
    try:
        (
            lpr_rows,
            vision_rows,
            lpr_brand_rows,
            vision_brand_rows,
            lpr_keyword_rows,
            waste_rows,
            person_frame_rows,
        ) = await asyncio.gather(
            execute_safe(_LPR_SUMMARY_SQL, [range_hours]),
            execute_safe(_VISION_SUMMARY_SQL, [range_hours]),
            execute_safe(_LPR_BRANDS_SQL, [range_hours]),
            execute_safe(_VISION_BRANDS_SQL, [range_hours]),
            execute_safe(_LPR_KEYWORDS_SQL, [range_hours]),
            execute_safe(_WASTE_SQL, [range_hours]),
            execute_safe(_VISION_PERSON_FRAMES_SQL, [range_hours]),
        )
    except Exception as e:
        log.exception("Activity summary queries failed")
        raise HTTPException(500, f"DB error: {e!s}")

    # Pojedynczy wiersz z aggregates (COUNT/SUM zawsze zwraca 1 row).
    lpr_stats = lpr_rows[0] if lpr_rows else {}
    vision_stats = vision_rows[0] if vision_rows else {}

    # Special guests — łączymy 3 źródła: LPR brand (Hikvision native),
    # vision brand (EasyOCR na boku), LPR owner keyword. Dedup po brand/owner.
    special_guests = _merge_special_guests(
        lpr_brand_rows, vision_brand_rows, lpr_keyword_rows,
    )

    # Waste pickup — zachowujemy jako lista (category, operator, hits).
    waste_pickups = [
        {
            "category": r.get("category"),
            "operator": r.get("operator"),
            "hits": int(r.get("hits") or 0),
            "last_time": r.get("last_time"),
        }
        for r in waste_rows
        if r.get("category")
    ]

    # Person visits — temporal clustering klatek z osobą w sesje. Daje 2
    # przybliżone liczby: wizyt (pojawień w polu kamery) i unikalnych osób.
    person_visits = _compute_person_visits(person_frame_rows)

    base = build_activity_summary(
        range_hours, lpr_stats, vision_stats,
        special_guests=special_guests, waste_pickups=waste_pickups,
        person_visits=person_visits,
    )

    if not req.smart:
        return base

    # Smart mode: LLM rewrap suchych statsów w naturalne zdanie + follow-ups.
    natural, follow_ups = await asyncio.gather(
        generate_activity_natural_answer(
            range_hours,
            lpr_stats,
            vision_stats,
            template_answer=base["answer"],
            special_guests=special_guests,
            waste_pickups=waste_pickups,
            person_visits=person_visits,
        ),
        suggest_follow_ups(
            req.question,
            "recent_activity_summary",
            params,
            answer=base["answer"],
        ),
    )

    return {**base, "answer": (natural or "").strip() or base["answer"], "follow_ups": follow_ups}
