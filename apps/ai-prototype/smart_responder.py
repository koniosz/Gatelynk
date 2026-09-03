"""
Smart response builder — LLM sumarize raw data into natural Polish answer.

Architektura zachowuje invariant bezpieczeństwa: LLM nadal **nie generuje SQL**
i **nie wymyśla danych** — dostaje już wyciągnięte rows z whitelisted query
i ma tylko ułożyć je w naturalny język polski.

Mitigation halucynacji:
  • Strict prompt — explicit "TYLKO fakty z danych", brak wymyślania
  • Walidacja post-hoc: liczby z LLM-output sprawdzamy przeciwko rows
  • Max num_predict 300 tokens — kontrolowana długość
  • temperature=0 — deterministic
  • Fallback do template_answer gdy LLM zawiedzie

Czas: ~1-3s na zapytanie dla qwen2.5:14b warm. Cold ~5s.
Dla użytkownika to **dużo** vs 5ms template, ale user explicit chciał LLM mode.

Multi-step: niepełny, ale wsparcie dla **follow-up suggestion** — LLM proponuje
kolejne sensowne pytania (returned w `follow_ups[]`) które user może wybrać.
Klasyczny multi-step (LLM koordynuje N SQL calls) — out of scope, wymagałby
zmian w intent classifier loop.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

from config import CONFIG
from llm_config import get_active_llm  # FAZA 8.h.11 — dynamic Bielik/Qwen3

log = logging.getLogger(__name__)


SYSTEM_PROMPT_NATURAL = """Jesteś GateLynk AI — generujesz zwięzłą polską odpowiedź na podstawie WYŁĄCZNIE dostarczonych danych.

JĘZYK:
- WYŁĄCZNIE polski. Tylko polskie litery: a-z, A-Z, ą ć ę ł ń ó ś ż ź.
- ZAKAZ używania chińskich znaków (汉字), japońskich (かな), cyrylicy (русский), arabskich (عربي), greckich (ελληνικά).
- Jeśli nie wiesz polskiego odpowiednika — użyj angielskiego ALE TYLKO dla nazw własnych (Mercedes, DHL).
- "direction=in" → "wjazd"; "direction=out"/"reverse" → "wyjazd" (NIE "odwrotna kolejność", NIE rosyjski).

ZASADY:
- TYLKO fakty z sekcji DANE. Nie wymyślaj liczb, tablic, nazw, czasów.
- Wiersze DANE to OBSERWACJE kamery (wykrycia), NIE działania. Nie opisuj
  czynności, których nie ma w danych — nic nie zostało "zabrane", "odebrane",
  "dostarczone" ani "obsłużone", jeśli dane tego wprost nie mówią.
- Pole "summary" (jeśli występuje) = inne obiekty widoczne w kadrze w tym
  samym momencie (tło sceny). NIE łącz ich przyczynowo z głównym obiektem
  i NIE wliczaj do odpowiedzi.
- Po polsku, naturalnie (nie surowa lista bullet gdy < 5 elementów).
- Maks 4 zdania albo 5 linii listy.
- Możesz zauważyć trend ("głównie rano", "tylko jeden kurier", "najczęściej Mercedes") TYLKO jeśli wprost wynika z danych.
- NIE używaj markdown bullet-points (•), używaj natural inline lub krótka lista z myślnikiem.
- NIE zaczynaj od "Oto", "Według danych", "Na podstawie" — od razu odpowiedź.
- Brak liczb, dat lub plate-y które nie są w DANE = halucynacja. NIE ROBIĆ.

Format: pure text Polish, bez prefix-u, bez JSON, bez code-fences.
"""

# FAZA 8.h.31 (2026-07-07) — semantyka danych per intent (anty-halucynacja).
# Zgłoszenie: "Kiedy ostatnio była śmieciarka?" → Bielik dostał rows z SQL
# (w tym kolumnę `summary` = WSZYSTKIE obiekty w kadrze: "2× truck, 1× car")
# i zinterpretował je jako ładunek: "śmieciarka zabrała 3 pojazdy (2 ciężarówki
# i 1 samochód)". Walidacja liczb tego nie łapie (małe liczby 1-9 dozwolone
# w prozie). Fix: dla intentów wizyjnych doklejamy do user_msg jawne
# ZNACZENIE DANYCH — wiersz = WYKRYCIE kamery, summary = tło sceny do pominięcia.
INTENT_DATA_SEMANTICS: dict[str, str] = {
    "search_by_waste_today": (
        "Każdy wiersz = jedno WYKRYCIE śmieciarki przez kamerę "
        "(time=moment wykrycia, category=frakcja odpadów, operator=firma). "
        "Dane NIE mówią nic o tym, co śmieciarka zabrała — NIE pisz ile "
        "'zabrała' ani 'odebrała'. Liczba wierszy = liczba wykryć; jedna "
        "śmieciarka może być wykryta kilka razy. Pole summary = inne obiekty "
        "w kadrze (tło) — pomiń je."
    ),
    "search_by_brand_today": (
        "Każdy wiersz = jedno WYKRYCIE pojazdu tej marki/firmy przez kamerę. "
        "Liczba wierszy = liczba wykryć, NIE liczba różnych pojazdów. "
        "Pole summary = inne obiekty w kadrze — pomiń."
    ),
    "search_taxi_recent": (
        "Każdy wiersz = jedno WYKRYCIE taksówki przez kamerę. Liczba wierszy "
        "= liczba wykryć. Pole summary = inne obiekty w kadrze — pomiń."
    ),
    "last_seen_object": (
        "Każdy wiersz = jedno WYKRYCIE obiektu przez kamerę (obserwacja). "
        "Pole summary = inne obiekty w kadrze — pomiń."
    ),
    # FAZA 8.h.32 — marki fabryczne (Toyota/Mercedes/…) z whitelisty + LPR.
    "search_by_vehicle_make": (
        "Każdy wiersz z polem time = jeden PRZEJAZD (odczyt LPR) pojazdu tej "
        "marki z białej listy osiedla (direction: forward=wjazd, "
        "reverse=wyjazd; unit_label=przypisany lokal). Wiersz BEZ time = "
        "pojazd jest na białej liście, ale NIE przejeżdżał w zadanym oknie. "
        "Liczba wierszy z time = liczba przejazdów, NIE liczba różnych aut "
        "(ten sam pojazd wjeżdża i wyjeżdża wielokrotnie). PRYWATNOŚĆ: NIGDY "
        "nie podawaj właściciela ani nazw osób/firm — wolno wskazać tylko "
        "lokal (unit_label) i tablicę."
    ),
}

# Prompt template dla "follow-up suggestion" — LLM proponuje 1-2 dalsze pytania.
SYSTEM_PROMPT_FOLLOWUP = """Jesteś GateLynk AI. Na podstawie zadanego pytania i wyniku zaproponuj 1-3 SENSOWNE pytania uzupełniające, które user mógłby zadać dalej. Tylko JSON.

Dostępne intencje:
- count_vehicles_today, count_vehicles_by_color_today, count_vehicles_by_tag_today
- count_gate_openings_today, count_visits_by_plate
- list_vehicles_by_color_today, list_unmatched_plates
- vehicle_history_by_plate, last_seen_plate
- courier_today, search_vehicles_today
- list_errors_recent, count_errors_recent, list_devices

Sugestie MUSZĄ pasować do tych intencji. Krótkie pytania po polsku.

Format (tylko JSON, bez markdown):
{"follow_ups": ["pytanie 1", "pytanie 2", "pytanie 3"]}

Przykład: jeśli user pytał "Ile białych dziś?", a wynik=28, możesz zaproponować:
{"follow_ups":["Pokaż białe samochody","Ile białych wczoraj","Jakie czarne dziś"]}
"""


async def generate_natural_answer(
    question: str,
    intent: str,
    parameters: dict,
    rows: list[dict],
    template_answer: str,
) -> str:
    """
    Asks LLM to rewrite template answer + raw rows into natural Polish.

    Returns LLM output (validated) or template_answer (fallback).
    """
    if intent == "unknown":
        return template_answer  # nie ma sensu robić smart-mode

    # Compact JSON — limit do 15 rows + 200 chars per row (LLM przepychanie)
    compact_rows = _compact_rows(rows[:15])

    # FAZA 8.h.31 — jawna semantyka danych dla intentów wizyjnych.
    semantics = INTENT_DATA_SEMANTICS.get(intent)
    semantics_block = f"ZNACZENIE DANYCH: {semantics}\n\n" if semantics else ""

    user_msg = (
        f"PYTANIE UŻYTKOWNIKA: {question}\n\n"
        f"INTENT: {intent}\n"
        f"PARAMETRY: {json.dumps(parameters, ensure_ascii=False)}\n\n"
        + semantics_block
        + f"DANE z bazy ({len(rows)} rekordów"
        + (", pokazuję 15)" if len(rows) > 15 else ")")
        + f":\n{compact_rows}\n\n"
        f"Sformułuj odpowiedź na pytanie:"
    )

    # FAZA 8.h.11 — dynamic LLM config z Edge (Bielik / Qwen3 / etc.)
    from llm_config import get_active_llm
    llm = get_active_llm()
    payload = {
        "model": llm.model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT_NATURAL},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "options": {
            "temperature": 0.0,
            "num_predict": 350,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=CONFIG.ollama_timeout_s * 2) as client:
            r = await client.post(f"{llm.url}/api/chat", json=payload)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        log.warning("Smart answer LLM failed, falling back to template: %s", e)
        return template_answer

    content = data.get("message", {}).get("content", "").strip()
    if not content or len(content) < 5:
        return template_answer

    # Strip żadnych przypadkowych code-fences czy "Oto:" intros
    content = _strip_intros(content)

    # Sanity check: jeśli LLM zacytował liczbę spoza data → fallback
    if not _validate_numbers(content, rows, parameters):
        log.warning(
            "Smart answer halucynacja (numbers not in data): %r — fallback",
            content[:120],
        )
        return template_answer

    # Token glitch check: qwen2.5 czasami leakuje rosyjski/chiński/japoński
    # — np. "kierunku отвротном" lub "请提供". Fallback do template.
    if not _validate_polish_only(content):
        log.warning(
            "Smart answer non-Polish chars (token glitch): %r — fallback",
            content[:120],
        )
        return template_answer

    return content


async def suggest_follow_ups(
    question: str,
    intent: str,
    parameters: dict,
    answer: str,
) -> list[str]:
    """
    LLM proponuje 1-3 dalsze pytania (multi-step lite). Returns [] przy błędzie.
    """
    if intent == "unknown":
        return []

    user_msg = (
        f"Pytanie: {question}\n"
        f"Intent: {intent}\n"
        f"Parametry: {json.dumps(parameters, ensure_ascii=False)}\n"
        f"Odpowiedź: {answer[:300]}\n\n"
        "Zaproponuj 1-3 dalsze pytania."
    )
    payload = {
        "model": get_active_llm().model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT_FOLLOWUP},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.0, "num_predict": 150},
    }
    try:
        async with httpx.AsyncClient(timeout=CONFIG.ollama_timeout_s) as client:
            r = await client.post(f"{get_active_llm().url}/api/chat", json=payload)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        log.warning("Follow-up LLM failed: %s", e)
        return []

    content = data.get("message", {}).get("content", "").strip()
    try:
        parsed = json.loads(content)
        ups = parsed.get("follow_ups", [])
        return [str(u)[:120] for u in ups if isinstance(u, str)][:3]
    except (json.JSONDecodeError, AttributeError):
        return []


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _compact_rows(rows: list[dict]) -> str:
    """Compact JSON rendering — limit char count per row."""
    out_lines = []
    for r in rows:
        # Strip null fields + truncate long strings
        compacted = {
            k: (v[:80] if isinstance(v, str) and len(v) > 80 else v)
            for k, v in r.items()
            if v is not None and v != "" and v != "[]"
        }
        out_lines.append(json.dumps(compacted, ensure_ascii=False, default=str))
    return "\n".join(out_lines)


def _strip_intros(text: str) -> str:
    """Usuwa "Oto", "Według danych", code-fences, prefix-y które LLM mógł dodać."""
    text = re.sub(r"^```\w*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    text = re.sub(
        r"^(Oto|Według|Na podstawie|Z danych)[^.]*[:.]?\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return text.strip()


def _validate_polish_only(text: str) -> bool:
    """
    Reject jeśli wykryje cyrillic/CJK/japoński. qwen2.5 czasem leakuje
    tokeny z multilingual training set (model był trenowany m.in. na chińskim
    i rosyjskim). Mitigation: detect + fallback.

    Allowed: ASCII (a-zA-Z0-9 + punctuation), Polish chars (ąćęłńóśżź),
    common symbols (— • · …).
    """
    for c in text:
        code = ord(c)
        # Cyrillic
        if 0x0400 <= code <= 0x04FF:
            return False
        # CJK Unified Ideographs
        if 0x4E00 <= code <= 0x9FFF:
            return False
        # Japanese Hiragana + Katakana
        if 0x3040 <= code <= 0x30FF:
            return False
        # Arabic
        if 0x0600 <= code <= 0x06FF:
            return False
        # Greek
        if 0x0370 <= code <= 0x03FF:
            return False
        # Hangul (Korean)
        if 0xAC00 <= code <= 0xD7AF:
            return False
        # Hebrew
        if 0x0590 <= code <= 0x05FF:
            return False
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Knowledge base (RAG) — LLM composes natural answer from search hits
# ─────────────────────────────────────────────────────────────────────────────

# ─── Activity summary (multi-aggregate raport) ──────────────────────────────

SYSTEM_PROMPT_ACTIVITY = """Jesteś GateLynk AI. Przekształć suche statystyki z bazy w naturalny polski raport o aktywności osiedla.

ZASADY:
- WYŁĄCZNIE polski (a-z, A-Z, ąćęłńóśżź). ZAKAZ znaków chińskich/cyrylicy/arabskich.
- TYLKO liczby z DANE. Nie wymyślaj statystyk.
- Zachowaj WSZYSTKIE sekcje gdy mają wartości > 0: pojazdy (wjazd/wyjazd/whitelist), kurierzy, brama, ludzie, zwierzęta.
- Pomijaj sekcje gdzie wartość = 0 (nie pisz „wjechało 0 aut" — pomiń).
- Format: 3-6 zdań/linii, naturalny język, możesz użyć emoji jak w danych.
- Bez wstępu typu „Według danych" / „Oto raport".
- Vision (psy/koty/rowery/ciężarówki) — to liczba KLATEK gdzie wykryto obiekt (proxy obecności). NIE „weszło X osób" bo bez person-tracker'a system tego nie zna.

OSOBY (sekcja person_visits — 2026-05-23):
- `visits` = liczba SESJI (pojawień się w polu widzenia kamery; sesja = ciągłe klatki z gap'em ≤30s).
- `est_persons` = SUMA(max(person) per session) — SZACUNKOWE unikalne osoby (proxy).
- Format: gdy est > visits → „około X osób w Y wizytach" (więcej osób per sesja).
  Gdy est == visits → „X wizyt osób" (1 osoba per pojawienie).
- NIGDY nie pisz „w X klatkach" o osobach — to mylące. Używaj „wizyt"/„pojawień"/„osób".

KLUCZOWE (2026-05-23): SPECJALNI GOŚCIE.
- Gdy w DANE jest sekcja SPECJALNI GOŚCIE (lista marek typu DPD/Bolt/InPost/DHL/Glovo/...), MUSISZ je wymienić W NATURALNEJ FORMIE w raporcie.
- Format: "Była taksówka Bolt", "Kurier DPD przywiózł paczkę", "Dostawa jedzenia Wolt".
- NIE zastępuj kategorią ("kurierów: 3") — wymień konkretne nazwy.
- Liczniki: gdy hits=1, pisz pojedynczo („zauważono DPD"); gdy hits>1, dodaj liczbę („DPD dwukrotnie", „InPost 3 razy").

ŚMIECIARKA:
- Gdy DANE zawiera ŚMIECIARKA section, wymień kategorię i operatora po polsku.
- Format: "Odebrano szkło (REMONDIS)", "Śmieciarka SUEZ zabrała papier".

DATY (FAZA 8.h.19, 2026-06-10):
- W user message dostajesz "BIEŻĄCA DATA: YYYY-MM-DD".
- ZAKAZ zgadywania konkretnej daty. Jeśli musisz wspomnieć datę:
  • Używaj relatywnych form: "dzisiaj", "w ciągu ostatniej doby", "w ciągu ostatnich N godzin".
  • Albo dosłownie cytuj BIEŻĄCĄ DATĘ podaną wyżej.
- NIGDY nie pisz konkretnej daty z głowy ("23 maja", "5 czerwca") — to halucynacja.

Format: pure text Polish, bez prefix-u, bez JSON, bez code-fences.
"""


async def generate_activity_natural_answer(
    range_hours: int,
    lpr_stats: dict,
    vision_stats: dict,
    template_answer: str,
    special_guests: list[dict] | None = None,
    waste_pickups: list[dict] | None = None,
    person_visits: dict | None = None,
) -> str:
    """
    LLM rewrap dla recent_activity_summary. Bierze surowe stats + template
    odpowiedź i komponuje naturalny polski raport.

    Args (2026-05-23 — extended):
      special_guests: lista {name, hits, kind} — konkretne marki widziane
                      przez LPR/vision (DPD, Bolt, DHL etc). LLM MUSI je
                      wymienić w odpowiedzi (system prompt enforce).
      waste_pickups:  lista {category, operator, hits} — śmieciarki + frakcje.

    Fallback: gdy LLM zawiedzie (timeout, non-polish, pustka) → template.
    """
    guests_str = (
        json.dumps(special_guests, ensure_ascii=False)
        if special_guests else "(brak)"
    )
    waste_str = (
        json.dumps(waste_pickups, ensure_ascii=False)
        if waste_pickups else "(brak)"
    )
    visits_str = (
        json.dumps(person_visits, ensure_ascii=False)
        if person_visits else "(brak)"
    )
    # FAZA 8.h.19 (2026-06-10) — inject bieżącej daty żeby Bielik nie
    # halucynował konkretnych dat ("23 maja 2026" mimo że dziś 9 czerwca).
    from datetime import date
    today = date.today().isoformat()
    user_msg = (
        f"BIEŻĄCA DATA: {today}\n"
        f"OKNO CZASOWE: ostatnie {range_hours} godzin\n\n"
        f"DANE LPR (pojazdy):\n{json.dumps(dict(lpr_stats), ensure_ascii=False)}\n\n"
        f"DANE VISION (kamera YOLO):\n{json.dumps(dict(vision_stats), ensure_ascii=False)}\n\n"
        f"PERSON_VISITS (temporal clustering — wizyty/szacunkowe osoby):\n{visits_str}\n\n"
        f"SPECJALNI GOŚCIE (KONKRETNE marki — wymień w raporcie):\n{guests_str}\n\n"
        f"ŚMIECIARKA (jeśli dziś przyjechała):\n{waste_str}\n\n"
        f"SUROWY RAPORT (template, do przekształcenia w naturalny język):\n{template_answer}\n\n"
        f"Naturalna odpowiedź:"
    )
    payload = {
        "model": get_active_llm().model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT_ACTIVITY},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "options": {"temperature": 0.0, "num_predict": 350},
    }
    try:
        async with httpx.AsyncClient(timeout=CONFIG.ollama_timeout_s * 2) as client:
            r = await client.post(f"{get_active_llm().url}/api/chat", json=payload)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        log.warning("Activity natural answer failed: %s — fallback to template", e)
        return template_answer

    content = (data.get("message", {}) or {}).get("content", "").strip()
    if not content or len(content) < 10:
        return template_answer
    content = _strip_intros(content)
    if not _validate_polish_only(content):
        log.warning(
            "Activity answer non-Polish chars (token glitch): %r — fallback",
            content[:120],
        )
        return template_answer
    return content


SYSTEM_PROMPT_KNOWLEDGE = """Jesteś asystentem GateLynk. Odpowiadasz na pytanie użytkownika WYŁĄCZNIE na podstawie dostarczonych fragmentów z bazy wiedzy.

ZASADY:
- TYLKO fakty z DANE (fragmenty wyżej). Nie wymyślaj liczb, dat, nazwisk, numerów telefonu.
- ZAKAZ wymyślania WYDARZEŃ: jeśli pytanie wymienia typ wydarzenia (np. "przerwa
  w wodzie", "przerwa w prądzie", "przegląd"), a fragmenty go NIE zawierają —
  NIE twórz takiej pozycji. Pytanie to NIE jest źródło faktów; źródłem są
  wyłącznie fragmenty. (Incydent 2026-08-14: zmyślona "przerwa w dostawie wody".)
- WYŁĄCZNIE polski (a-z, A-Z, ąćęłńóśżź). ZAKAZ chińskich/rosyjskich znaków.
- Cytuj fragment dosłownie gdy podajesz konkretną informację (np. § uchwały, godzinę odbioru, numer telefonu).
- Wskaż źródło: "Według [tytuł] (typ)" lub "Z [tytuł]:" gdy referujesz.
- Maks 4 zdania. Bez wstępu typu "Według danych".
- Jeśli pytanie nie ma odpowiedzi w fragmentach: "W bazie wiedzy nie ma informacji na ten temat."

DATY i TERMINY PRZYSZŁE (FAZA 8.h.16):
- W user message dostajesz "BIEŻĄCA DATA: YYYY-MM-DD".
- KAŻDA data oznaczona "(MINĘŁA)" obok = data PRZESZŁA. NIGDY jej nie umieszczaj
  w odpowiedzi gdy user pyta o "planowany"/"następny"/"kiedy"/"najbliższy"
  termin. Jest tam tylko jako kontekst dla Ciebie — pomijaj.
- Gdy pytanie dotyczy "planowanego" / "następnego" / "kiedy" odbioru / terminu / wydarzenia:
  • Pokaż TYLKO daty BEZ oznaczenia "(MINĘŁA)" — to są przyszłe lub dzisiejsze.
  • Sortuj rosnąco (najbliższa pierwsza).
  • Jeśli wszystkie daty z fragmentów są w przeszłości, odpowiedz:
    "Na podstawie harmonogramu nie ma już planowanego terminu — wszystkie podane daty już minęły. Sprawdź aktualny harmonogram."
- Gdy pytanie dotyczy "ostatniego" / "kiedy ostatnio" / "kiedy odbył się":
  • Pokaż TYLKO daty <= BIEŻĄCEJ DATY (przeszłe lub dzisiejsze).

PRZYKŁADY:
  BIEŻĄCA DATA: 2026-06-09
  PYTANIE: Kiedy planowany odbiór zmieszanych?
  FRAGMENTY: ZMIESZANE: 2026-06-02, 2026-06-16, 2026-07-30
  ODPOWIEDŹ: Planowany odbiór zmieszanych odpadów: 16 czerwca i 30 lipca 2026.
  (2026-06-02 pominięte — w przeszłości)

  BIEŻĄCA DATA: 2026-06-09
  PYTANIE: Kiedy następny odbiór szkła?
  FRAGMENTY: SZKŁO: 2026-06-05, 2026-07-30
  ODPOWIEDŹ: Najbliższy planowany odbiór szkła to 30 lipca 2026.
  (2026-06-05 pominięte — już minęło)

Format: pure text Polish, bez prefix-u, bez JSON, bez code-fences.
"""


async def generate_knowledge_natural_answer(
    query: str,
    hits: list[dict],
    template_answer: str,
) -> str:
    """
    Składa naturalną polską odpowiedź na podstawie top-K chunków z bazy wiedzy.

    hits[i] = {docId, type, title, chunkIdx, text, score} — payload z Edge
    /knowledge/search.

    Mitigation halucynacji:
      • System prompt explicit "TYLKO fakty z fragmentów"
      • temperature=0 — deterministic
      • _validate_polish_only — fallback gdy token glitch (rosyjski/CJK)
      • Fallback do template_answer gdy LLM zawiedzie

    UWAGA: NIE robimy _validate_numbers — knowledge answer MUSI móc cytować
    liczby z fragmentów (godziny odbioru, numery telefonu, paragrafy uchwał).
    Zamiast tego polegamy na system prompt-cie i temperature=0.
    """
    if not hits:
        return template_answer

    # FAZA 8.h.16 — pre-mark przeszłe daty `(MINĘŁA)`. Bielik nie filtrował
    # niezawodnie po instrukcji w prompcie (przy dłuższej liście dat pokazywał
    # wszystkie). Deterministic Python pass dodaje sygnał obok każdej daty
    # która < dziś — LLM po prostu czyta i pomija oznaczone.
    from datetime import date
    today = date.today()
    iso_re = re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b")

    def _annotate_dates(text: str) -> str:
        def _repl(m: re.Match[str]) -> str:
            try:
                d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                return m.group(0)
            if d < today:
                return f"{m.group(0)} (MINĘŁA)"
            return m.group(0)
        return iso_re.sub(_repl, text)

    # Compact hits: title, type, text (max 400 chars per hit).
    snippets: list[str] = []
    for h in hits[:5]:
        text = h.get("text") or ""
        if len(text) > 400:
            text = text[:400] + "…"
        text = _annotate_dates(text)
        title = h.get("title", "?")
        doc_type = h.get("type", "?")
        snippets.append(f"[{doc_type} | {title}] {text}")
    snippets_str = "\n\n".join(snippets)

    # FAZA 8.h.16 (2026-06-09) — wstrzykuj bieżącą datę żeby Bielik mógł
    # filtrować przeszłe terminy. Bez tego harmonogram odbioru śmieci
    # zawierający daty 2026-05-22..2026-08-07 wszystkie wyglądały dla LLM
    # jako "planowane" mimo że część była już 7 dni temu (>= today).
    from datetime import date
    today = date.today().isoformat()  # 2026-06-09
    user_msg = (
        f"BIEŻĄCA DATA: {today}\n"
        f"PYTANIE: {query}\n\n"
        f"FRAGMENTY z bazy wiedzy ({len(hits)}):\n\n{snippets_str}\n\n"
        f"Odpowiedź:"
    )
    payload = {
        "model": get_active_llm().model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT_KNOWLEDGE},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "options": {"temperature": 0.0, "num_predict": 400},
    }
    try:
        # FAZA 8.h.20 — *4 (60s przy default 15s). Bielik 11B na M1 z długim
        # KB context (harmonogram + ogłoszenia) przekraczał *2=30s →
        # httpx.ReadTimeout → fallback do raw template (ściana cytatów).
        # Interaktywne /ask to przeżyje (worst case user czeka), a background
        # day-summary loop i tak generuje w tle gdzie latency nie boli.
        async with httpx.AsyncClient(timeout=CONFIG.ollama_timeout_s * 4) as client:
            r = await client.post(f"{get_active_llm().url}/api/chat", json=payload)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        # repr(e) — httpx.ReadTimeout ma puste str(e), co dawało nieczytelne
        # "failed: " w logach (diagnoza 2026-06-11 trwała dłużej niż powinna).
        log.warning("Knowledge natural answer failed: %r", e)
        return template_answer

    content = data.get("message", {}).get("content", "").strip()
    if not content or len(content) < 5:
        return template_answer
    content = _strip_intros(content)
    if not _validate_polish_only(content):
        log.warning(
            "Knowledge answer non-Polish chars (token glitch): %r — fallback",
            content[:120],
        )
        return template_answer
    # NIE robimy _validate_numbers tutaj — knowledge answer może legalnie
    # cytować godziny / numery telefonu / § z fragmentów (system prompt + temp=0
    # zapewniają że LLM nie wymyśla liczb spoza fragmentów).
    return content


def _validate_numbers(text: str, rows: list[dict], parameters: dict) -> bool:
    """
    Sprawdź czy liczby w LLM-output istnieją w danych albo w params.
    Jeśli LLM mówi "5 aut" ale w danych jest 28 → halucynacja → fallback.

    Heuristyka:
      • Wyciągamy wszystkie liczby z text-a
      • Każda > 1 musi pojawić się w rows ALBO być len(rows) ALBO param-em
      • Małe liczby (1, 2, 3) ignorujemy bo mogą być "1 zdanie", "2 typy" itp.
    """
    nums_in_text = {int(m) for m in re.findall(r"\b(\d+)\b", text)}
    if not nums_in_text:
        return True  # brak liczb = nic do walidacji

    # Allowed numbers: 1-9 (mogą być w prozie), oraz wszystkie liczby z danych
    allowed: set[int] = {n for n in range(0, 10)}
    # len(rows) jako count
    allowed.add(len(rows))
    # liczby w parametrach (np. limit, range_hours)
    for v in parameters.values():
        if isinstance(v, (int, float)):
            allowed.add(int(v))
    # liczby z rows (count column, czas, etc.)
    for r in rows:
        for v in r.values():
            if isinstance(v, (int, float)):
                allowed.add(int(v))
            elif isinstance(v, str):
                for m in re.findall(r"\b(\d+)\b", v):
                    allowed.add(int(m))

    bad = nums_in_text - allowed
    return not bad
