"""
Multi-turn conversation support — coreference & ellipsis resolution.

Problem: prototype is stateless. Pytania typu "A jego telefon?" / "A mail?" /
"I co z tym?" są niezrozumiałe w izolacji — pronouns ("jego/ten/to") i
elipsy ("A X?") nie mają antecedentu.

Rozwiązanie: gdy iOS dostarcza historię rozmowy (last N user/assistant
turns), wywołujemy LLM rewrite step PRZED intent classify. LLM dostaje
historię + ostatnie pytanie, zwraca samowystarczalną wersję pytania:

    history: [user="Kto jest administratorem?", assistant="To Janusz Aszklar"]
    question: "Czy masz jego mail?"
    rewritten: "Czy masz mail Janusza Aszklara?"

Następnie classify(rewritten) idzie normalną ścieżką. Knowledge search query
też używa rewritten — bge-m3 dostaje pełen kontekst zamiast zaimka.

Optymalizacja: nie wołamy LLM dla każdego pytania — heurystyka
`looks_like_followup()` filtruje (krótkie + pronoun/prefix). Większość
pełnych pytań ("Ile dziś białych aut?") pomija rewrite.

Bezpieczeństwo: LLM nie wymyśla danych — jeśli historia nie zawiera
antecedentu, zwraca pytanie bez zmian. Plus sanity check (max length,
fallback do originału przy błędzie).
"""
from __future__ import annotations

import logging
import re
from typing import Any

import httpx
from pydantic import BaseModel

from config import CONFIG

log = logging.getLogger(__name__)


class Turn(BaseModel):
    """Single conversation turn — role + treść. Dopuszczamy 'user' i 'assistant'."""

    role: str  # "user" | "assistant"
    content: str


# ── Heurystyki follow-up ─────────────────────────────────────────────────────
# Pronouns które zwykle wymagają antecedentu z poprzedniej tury.
# Ograniczone do popularnych form osobowych/wskazujących — nie chcemy
# false-trigger na "ten" w zdaniu "Ten kierowca przyjechał wczoraj".
_FOLLOWUP_PRONOUN_RE = re.compile(
    r"\b(jego|jej|ich|im|tym|tych|tego|tej|tamten|tamta|tamto|tamtego|tamtej)\b",
    re.IGNORECASE,
)

# Prefixy typowych follow-upów ("A X?", "Albo Y?", "A co z Z?").
# Match tylko gdy są na początku pytania.
_FOLLOWUP_PREFIX_RE = re.compile(
    r"^(a\s+(?!by)|albo\s+|czy\s+te[zż]\s+|a\s+co\s+z\s+|daj\s+jeszcze|i\s+co\s+(z|jeszcze))",
    re.IGNORECASE,
)

# Pytania zaczynające się od standardowego question-word są zwykle
# samowystarczalne (mają własny subject/topic). Wyjątek: jeśli mimo to
# zawierają pronoun ("Czy masz JEGO mail?") → follow-up.
_QUESTION_STARTER_RE = re.compile(
    r"^(czy|ile|jak|jakie|jakim|jakich|kto|kiedy|gdzie|czemu|czego|który|która|które|co\s|poka[zż]|wymie[nń]|wy[sś]wietl)\b",
    re.IGNORECASE,
)


def looks_like_followup(question: str) -> bool:
    """
    Heurystyka: czy pytanie prawdopodobnie wymaga kontekstu poprzedniej tury?

    Decision tree:
      1. Empty → False
      2. Zaczyna się od question-word (Czy/Ile/Jak/Kto/Kiedy/Pokaż/itd.) →
         True tylko gdy ma pronoun w treści. Czyste pytania (bez zaimków)
         są samowystarczalne, mimo długości.
      3. Bardzo krótkie (≤30 chars I ≤4 wyrazy) → True. "A mail?",
         "Numer telefonu", "I co?" — prawie na pewno follow-up.
      4. Długie (>100 chars) → False, ma swój kontekst.
      5. Pronoun w treści LUB prefix follow-up ("A ", "Albo ") → True.

    Akceptujemy umiarkowane false-positive rate (rewrite zwraca origin
    gdy LLM uzna pytanie za samowystarczalne; koszt: +~200ms warm).
    False-negative jest gorszy — nieprzepisane „A jego mail?" daje błąd.
    """
    q = question.strip()
    if not q:
        return False
    word_count = len(q.split())
    has_pronoun = bool(_FOLLOWUP_PRONOUN_RE.search(q))

    # Question-word start — samowystarczalne CHYBA że pronoun w treści.
    if _QUESTION_STARTER_RE.match(q):
        return has_pronoun

    # Bardzo krótkie pytanie bez własnego question-word — niemal pewny follow-up.
    if len(q) <= 30 and word_count <= 4:
        return True

    # Długie pytanie — raczej samowystarczalne (ma swój temat).
    if len(q) > 100:
        return False

    return has_pronoun or bool(_FOLLOWUP_PREFIX_RE.match(q))


# ── LLM rewrite ──────────────────────────────────────────────────────────────

SYSTEM_PROMPT_REWRITE = """Jesteś ekspertem rozumienia kontekstu rozmów po polsku.

Zadanie: na podstawie historii rozmowy przepisz OSTATNIE pytanie użytkownika jako PEŁNE, samowystarczalne pytanie — z rozwiązanymi zaimkami (jego/jej/ten/tamten/itp.) i uzupełnionymi elipsami ("A X?" → "Pełne pytanie o X").

ZASADY:
- WYŁĄCZNIE polski. Tylko polskie litery: a-z, A-Z, ą ć ę ł ń ó ś ż ź.
- ZAKAZ używania chińskich, japońskich, cyrylicy, arabskich, greckich znaków.
- Zachowaj DOKŁADNIE sens oryginału. NIE dodawaj informacji której nie ma w historii.
- Jeśli pytanie jest już samowystarczalne (ma własny temat), zwróć je BEZ ZMIAN.
- Brak prefiksu typu "Pytanie:" / "PRZEPISANE:" — tylko czysty tekst.
- Max 1 zdanie, max 200 znaków.
- Bez markdown, code-fences, JSON.

PRZYKŁADY:

HISTORIA:
  USER: Kto jest administratorem osiedla?
  ASSISTANT: Administratorem osiedla jest Pan Janusz Aszklar.
PYTANIE: Czy masz jego numer telefonu?
WYNIK: Czy masz numer telefonu Janusza Aszklara?

HISTORIA:
  USER: Kto jest administratorem osiedla?
  ASSISTANT: Administratorem osiedla jest Pan Janusz Aszklar.
PYTANIE: A Adres mail?
WYNIK: Jaki jest adres email Janusza Aszklara?

HISTORIA:
  USER: Czy był dzisiaj DHL?
  ASSISTANT: Dzisiaj o 09:40 obserwowano furgonetkę DHL.
PYTANIE: A InPost?
WYNIK: Czy był dzisiaj InPost?

HISTORIA:
  USER: Ile białych aut dziś wjechało?
  ASSISTANT: Dziś wjechało 5 białych aut.
PYTANIE: A czarnych?
WYNIK: Ile czarnych aut dziś wjechało?

HISTORIA:
  USER: Kiedy ostatnio widziałeś samochód WD5005P?
  ASSISTANT: Ostatnio widziano samochód WD5005P 11 czerwca o 18:11.
PYTANIE: Do kogo należy pojazd?
WYNIK: Do kogo należy pojazd WD5005P?

HISTORIA:
  USER: Pokaż mi historię tablicy WE12345.
  ASSISTANT: Tablica WE12345 była tu 3 razy.
PYTANIE: Jaka jest pogoda?
WYNIK: Jaka jest pogoda?

HISTORIA:
  USER: Co ciekawego działo się w ostatnich 4 godzinach?
  ASSISTANT: Wjechało 36 aut, kurierów 3, brama otwierała się 11 razy.
PYTANIE: A w godzinie?
WYNIK: Co ciekawego działo się w ostatniej godzinie?

# FAZA 8.h.15 (2026-06-09) — kontekst harmonogramu/odbioru śmieci.
# Krytyczne żeby zachować "planowany"/"kiedy"/"harmonogram" przy follow-up,
# bo bez tego classify_regex zobaczy tylko "zmieszane" → wpadnie w
# search_by_waste_today (vision history) zamiast search_knowledge_base
# (harmonogram = przyszłość, KB doc).

HISTORIA:
  USER: Kiedy jest planowany odbiór śmieci?
  ASSISTANT: Planowany odbiór śmieci: BIO 22 maja, ZIELONE 28 maja, ...
PYTANIE: A Zmieszane?
WYNIK: Kiedy jest planowany odbiór zmieszanych?

HISTORIA:
  USER: Kiedy następny odbiór szkła?
  ASSISTANT: Najbliższy odbiór szkła to 5 czerwca, następnie 30 lipca.
PYTANIE: A papier?
WYNIK: Kiedy następny odbiór papieru?

HISTORIA:
  USER: Jak wygląda harmonogram odbioru odpadów?
  ASSISTANT: 2026-05-22 → BIO, 2026-05-28 → ZIELONE, ...
PYTANIE: A papier?
WYNIK: Kiedy w harmonogramie jest planowany odbiór papieru?

HISTORIA:
  USER: Podsumuj 24 godziny
  ASSISTANT: Wjechało 100 aut, wyjechało 95.
PYTANIE: A 4h?
WYNIK: Podsumuj ostatnie 4 godziny

# FAZA 8.h.29 (2026-07-03) — HISTORIA detekcji wizyjnych (klasy YOLO /
# taksówka / śmieciarka). Follow-up musi zachować phrasing "czy widziałeś" /
# "kiedy ostatnio", bo to on routuje do last_seen_object / search_taxi_recent
# / search_by_waste_today z długim oknem.

HISTORIA:
  USER: Czy widziałeś kota?
  ASSISTANT: Nie widziałem kota w ostatnich 30 dniach.
PYTANIE: A psa?
WYNIK: Czy widziałeś psa?

HISTORIA:
  USER: Kiedy ostatnio była taksówka?
  ASSISTANT: Taksówka ostatnio była 30 czerwca o 14:12.
PYTANIE: A śmieciarka?
WYNIK: Kiedy ostatnio była śmieciarka?

# FAZA 8.h.30 (2026-07-03) — "inny X" po pytaniu o konkretną markę.
# WAŻNE: w WYNIKU NIE wolno wymieniać poprzedniej marki (np. "niż DHL") —
# nazwa marki w pytaniu kieruje je z powrotem do wyszukiwania TEJ marki,
# a user pyta o WSZYSTKICH innych. Przepisz jako generyczne pytanie
# o kuriera/markę.

HISTORIA:
  USER: Kiedy ostatnio był DHL?
  ASSISTANT: Kamery nie zarejestrowały marki DHL w ostatnich 30 dniach.
PYTANIE: A jakiegoś innego kuriera?
WYNIK: Czy był ostatnio jakiś inny kurier?

HISTORIA:
  USER: Czy widziałeś dziś DPD?
  ASSISTANT: Nie, dzisiaj nie było DPD.
PYTANIE: A ktoś inny przyjeżdżał?
WYNIK: Jaki kurier ostatnio przyjeżdżał?

# FAZA 8.h.32 (2026-07-05) — marki fabryczne samochodów. Follow-up zmieniający
# TYLKO okno czasowe ("A wcześniej?", "W ciągu 24 godzin?") MUSI zachować
# markę z historii. Bug produkcyjny: po "A czy widziałeś jakąś Toyotę?"
# follow-up "A wcześniej? W ciągu 24 godzin?" został przepisany na generyczne
# "Ile aut wjechało w 24h" → odpowiedź "816 samochodów" zamiast o Toyocie.

HISTORIA:
  USER: A czy widziałeś jakąś Toyotę?
  ASSISTANT: Dziś nie zarejestrowałem pojazdu marki Toyota.
PYTANIE: A wcześniej? W ciągu 24 godzin?
WYNIK: Czy widziałeś jakąś Toyotę w ciągu ostatnich 24 godzin?

HISTORIA:
  USER: Ile Mercedesów widziałeś w ostatnich 12 godzinach?
  ASSISTANT: W ostatnich 12 godzinach nie było Mercedesów.
PYTANIE: A w całym tygodniu?
WYNIK: Ile Mercedesów widziałeś w ostatnim tygodniu?

HISTORIA:
  USER: Ile aut wjechało w ciągu 24 godzin?
  ASSISTANT: W ciągu 24 godzin wjechało 816 samochodów.
PYTANIE: Ale konkretnie szukam samochodu marki Toyota.
WYNIK: Czy widziałeś samochód marki Toyota?

# FAZA 8.h.33 (2026-07-05) — follow-up o TABLICE po liście pojazdów.
# Główna ścieżka to deterministyczny carry-over
# (_inject_plates_subject_from_history — marka/kolor z historii); przykład
# dla LLM na wypadek innych podmiotów. Przepisane pytanie MUSI zachować
# temat z historii, nie może pytać o tablice „w ogóle".

HISTORIA:
  USER: A czy widziałeś jakąś Toyotę?
  ASSISTANT: Tak, dziś zarejestrowałem 2 pojazdy marki Toyota: WD5005P (wjazd 08:12) i WE387YT (wjazd 09:40).
PYTANIE: Jakie miały numery rejestracyjne?
WYNIK: Jakie numery rejestracyjne miały pojazdy marki Toyota widziane ostatnio?

HISTORIA:
  USER: Jakie czerwone auta były dziś?
  ASSISTANT: Dziś były 2 czerwone auta.
PYTANIE: Jakie miały tablice?
WYNIK: Jakie numery rejestracyjne miały czerwone auta dziś?
"""


def _format_history(history: list[Turn], max_turns: int) -> str:
    """Tail-trim historii do `max_turns` ostatnich wpisów + truncate per-wpis."""
    recent = history[-max_turns:]
    lines: list[str] = []
    for t in recent:
        role = t.role.upper()
        # Tnijmy każdą turę do 300 chars — assistant answers bywają długie,
        # a do coreference resolution wystarczy początek.
        content = t.content.strip().replace("\n", " ")[:300]
        lines.append(f"  {role}: {content}")
    return "\n".join(lines)


# Polska tablica rejestracyjna w tekście: 1-3 litery prefiksu powiatu +
# 4-5 znaków (cyfry/litery, min 1 cyfra). Łapie WD5005P, WE12345, PO6MM84.
_PLATE_IN_TEXT_RE = re.compile(r"\b[A-Z]{1,3}\d[A-Z0-9]{3,5}\b")
# Pytanie odnosi się do pojazdu bez podania tablicy.
_VEHICLE_REF_RE = re.compile(r"pojazd\w*|auto\b|aut[ao]\b|samoch[oó]d\w*|tablic\w*", re.IGNORECASE)


# ── FAZA 8.h.32 (2026-07-05) — deterministyczny carry-over MARKI ─────────────
# Wzór plate-injection 8.h.23 (deterministyka > LLM). Follow-up który zmienia
# TYLKO okno czasowe („A wcześniej?", „W ciągu 24 godzin?", „A wczoraj?")
# po pytaniu o markę (Toyota/Mercedes/… albo brand DHL/FRISCO/…) jest
# przepisywany BEZ LLM z zachowaniem marki. Bielik w rewrite potrafił
# przepisać taki follow-up na generyczne „ile aut w 24h" (bug produkcyjny:
# odpowiedź „816 samochodów" zamiast o Toyocie).

# Follow-up „tylko okno czasowe": wcześniej/później/wczoraj/N godzin/doba/…
_WINDOW_FOLLOWUP_RE = re.compile(
    r"wcze[śs]niej|p[óo][źz]niej|wczoraj|przedwczoraj|w\s+ci[aą]gu"
    r"|ostatni\w*|\b\d+\s*(?:godzin\w*|h\b)|\bdob[aęy]\w*"
    r"|tydzie[nń]|tygodni\w*|miesi[aą]c\w*",
    re.IGNORECASE,
)

# Pytanie ma WŁASNY temat (kurier/taxi/śmieciarka/auta/osoby/zwierzęta…) —
# wtedy NIE wstrzykujemy marki z historii (user zmienił temat).
_MAKE_CARRY_BLOCKERS_RE = re.compile(
    r"kurier|courier|dostaw|taks[oó]wk|\btaxi\b|śmieciar|smieciar|odbi[óo]r"
    r"|\baut\w*|samoch\w*|pojazd\w*|osob|os[óo]b|ludzi|piesz"
    r"|\bpsa\b|\bpies\b|psy\b|kot[ay]?\b|rower|zwierz|tablic|błąd|błęd|awari"
    r"|harmonogram|uchwa[lł]|regulamin|czynsz|op[lł]at",
    re.IGNORECASE,
)


def _inject_make_from_history(question: str, history: list[Turn]) -> str | None:
    """
    Deterministic rewrite: follow-up zmieniający tylko okno czasowe
    („A wcześniej? W ciągu 24 godzin?") + marka (fabryczna lub brand)
    w historii → przepisz zachowując markę. None gdy nie dotyczy.
    """
    from intent_classifier import (
        _EXPLICIT_WINDOW_RE,
        _extract_brand_keyword,
        _extract_range_hours,
        _match_car_make,
    )
    q = question.strip()
    # Długie pytanie = własny kontekst; brak sygnału okna = to nie jest
    # window-change follow-up.
    if not q or len(q) > 80 or not _WINDOW_FOLLOWUP_RE.search(q):
        return None
    ql = q.lower()
    # Pytanie już ma markę/brand/tablicę/własny temat → nic nie wstrzykujemy.
    if _match_car_make(ql) or _extract_brand_keyword(ql):
        return None
    if _PLATE_IN_TEXT_RE.search(q.upper()):
        return None
    if _MAKE_CARRY_BLOCKERS_RE.search(ql):
        return None
    # Najświeższa marka z historii (user LUB assistant — odpowiedź też ją niesie).
    subject: tuple[str, str] | None = None
    for turn in reversed(history):
        tl = turn.content.lower()
        make = _match_car_make(tl)
        if make:
            subject = ("make", make)
            break
        brand = _extract_brand_keyword(tl)
        if brand:
            subject = ("brand", brand)
            break
    if subject is None:
        return None
    kind, name = subject
    if _EXPLICIT_WINDOW_RE.search(ql):
        hours = _extract_range_hours(ql, default=24)
        window = f"w ciągu ostatnich {hours} godzin"
    else:
        # „A wcześniej?" bez explicit okna → „ostatnio" (rare-event 720h).
        window = "ostatnio"
    if kind == "make":
        return f"Czy widziałeś {window} samochód marki {name}?"
    return f"Czy widziałeś {window} {name}?"


# ── FAZA 8.h.33 (2026-07-05) — carry-over tematu dla pytań o TABLICE ─────────
# Bug produkcyjny (assistant_query_logs b9): po odpowiedzi listującej pojazdy
# (search_by_vehicle_make / list_vehicles_by_color) follow-up „Jakie miały
# numery rejestracyjne ?" szedł SUROWY do classify → intent=unknown.
# looks_like_followup zwraca False (pytanie zaczyna się od „Jakie" i nie ma
# zaimka z _FOLLOWUP_PRONOUN_RE), więc nawet LLM rewrite nie był wołany.
# Deterministyka > LLM (lekcje 8.h.16/23/32): przepisujemy na pytanie o
# pojazdy tematu z historii — odpowiedzi make/color-intentów i tak zawierają
# tablice (oba templaty SELECT-ują plate).

_PLATES_FOLLOWUP_RE = re.compile(
    r"numer\w*\s+rejestracyjn\w*|rejestracyjn\w*|tablic\w*",
    re.IGNORECASE,
)
# Pytanie o tablice z WŁASNYM tematem — nie dotykamy (nieznane tablice,
# historia tablicy, czyja tablica, tablice gości/kurierów, mój pojazd…).
_PLATES_OWN_TOPIC_RE = re.compile(
    r"nieznan\w*|spoza|histori\w*|nale[żz]\w*|czyj\w*|bia[lł]\w*\s+li[sś]\w*"
    r"|whitelist|kurier\w*|courier|dostaw\w*|taks[oó]wk\w*|\btaxi\b"
    r"|śmieciar\w*|smieciar\w*|go[sś]c\w*|\bm[oó]j\b|moje\w*|\bmoim\b",
    re.IGNORECASE,
)
# Elipsa: czasownik „mieć/być" bez podmiotu („Jakie MIAŁY numery…") albo
# zaimek ich/one — sygnał że podmiot został w poprzedniej turze.
_PLATES_ELLIPSIS_RE = re.compile(
    r"mia[lł]\w*|by[lł]y\b|\bich\b|\bone\b", re.IGNORECASE
)

# Kolor canonical EN → polska forma do rewrite (mnoga niemęskoosobowa —
# „czerwone auta"); musi re-matchować COLOR_PATTERNS w klasyfikatorze.
_COLOR_PL_FORM = {
    "white": "białe", "black": "czarne", "red": "czerwone",
    "blue": "niebieskie", "green": "zielone", "yellow": "żółte",
    "silver": "srebrne", "gray": "szare", "brown": "brązowe",
    "orange": "pomarańczowe",
}


def _inject_plates_subject_from_history(question: str, history: list[Turn]) -> str | None:
    """
    Deterministic rewrite: „Jakie miały numery rejestracyjne?" po liście
    pojazdów → pełne pytanie o pojazdy tematu z historii (marka fabryczna
    lub kolor) — odpowiedź tych intentów zawiera tablice. None gdy nie
    dotyczy. Brand (DHL/FRISCO) celowo pominięty: vision_detections nie
    mają tablic, rewrite na brand-intent nie odpowiedziałby na pytanie.
    """
    from intent_classifier import (
        _EXPLICIT_WINDOW_RE,
        _extract_range_hours,
        _match_car_make,
        _match_color,
    )
    q = question.strip()
    if not q or len(q) > 80 or not _PLATES_FOLLOWUP_RE.search(q):
        return None
    ql = q.lower()
    if _PLATES_OWN_TOPIC_RE.search(ql):
        return None
    if _PLATE_IN_TEXT_RE.search(q.upper()):
        return None  # pyta o konkretną tablicę — samowystarczalne
    if _match_car_make(ql) or _match_color(ql):
        return None  # ma własny temat — classify poradzi sobie bez historii
    # Wymagamy elipsy („miały/ich") ALBO bardzo krótkiego pytania
    # („Jakie tablice?") — dłuższe pytania bez elipsy mają własny kontekst.
    if not _PLATES_ELLIPSIS_RE.search(ql) and len(ql.split()) > 4:
        return None
    # Temat: najświeższa marka (user LUB assistant — odpowiedź też ją niesie)
    # albo kolor (TYLKO user — odpowiedzi asystenta wymieniają kolory
    # pojedynczych aut i robiłyby false-match).
    subject: tuple[str, str] | None = None
    window_src: str | None = None
    for i in range(len(history) - 1, -1, -1):
        turn = history[i]
        tl = turn.content.lower()
        make = _match_car_make(tl)
        if make:
            subject = ("make", make)
            if turn.role == "user":
                window_src = tl
            elif i > 0 and history[i - 1].role == "user":
                # Okno czasowe z pytania które wywołało tę odpowiedź.
                window_src = history[i - 1].content.lower()
            break
        if turn.role == "user":
            color = _match_color(tl)
            if color:
                subject = ("color", color)
                break
    if subject is None:
        return None
    kind, name = subject
    if kind == "color":
        # list_vehicles_by_color_today jest zawsze „dziś" — okna nie niesiemy.
        return f"Jakie numery rejestracyjne miały {_COLOR_PL_FORM[name]} auta dziś?"
    if window_src and _EXPLICIT_WINDOW_RE.search(window_src):
        hours = _extract_range_hours(window_src, default=24)
        return (
            f"Jakie numery rejestracyjne miały pojazdy marki {name}"
            f" w ciągu ostatnich {hours} godzin?"
        )
    # Bez explicit okna → „ostatnio" (range_hours_rare podniesie do 720h).
    return f"Jakie numery rejestracyjne miały pojazdy marki {name} widziane ostatnio?"


def _inject_plate_from_history(question: str, history: list[Turn]) -> str | None:
    """
    Deterministic rewrite: pytanie o pojazd bez tablicy + tablica w historii
    → doklej ostatnią tablicę. None gdy nie dotyczy (caller idzie do LLM).
    """
    if not _VEHICLE_REF_RE.search(question):
        return None
    if _PLATE_IN_TEXT_RE.search(question.upper()):
        return None  # pytanie już ma tablicę — samowystarczalne
    for turn in reversed(history):
        m = _PLATE_IN_TEXT_RE.search(turn.content.upper())
        if m:
            base = question.rstrip().rstrip("?").rstrip()
            return f"{base} {m.group(0)}?"
    return None


def deterministic_rewrite(question: str, history: list[Turn]) -> str | None:
    """
    Deterministyczne carry-overy z historii — BEZ LLM (lekcja 8.h.16/23/32:
    deterministyka > LLM). Zwraca przepisane pytanie albo None gdy żaden
    wzorzec nie pasuje (caller decyduje o LLM rewrite / passthrough).

    Używane przez rewrite_question_with_context (produkcja) ORAZ
    eval_classifier.py (goldeny z `history:` w questions_catalog.yaml) —
    jedno źródło prawdy, eval testuje dokładnie produkcyjną ścieżkę.

    KOLEJNOŚĆ MA ZNACZENIE:
      1. 8.h.33 plates-subject — MUSI być PRZED plate-injection: wariant
         „Jakie miały tablice?" matchuje _VEHICLE_REF_RE i plate-injection
         dokleiłby JEDNĄ tablicę z historii, a user pyta o WSZYSTKIE
         wymienione pojazdy.
      2. 8.h.23 plate-injection — „Do kogo należy pojazd?" po tablicy.
      3. 8.h.32 make/brand carry-over — „A wcześniej? W ciągu 24 godzin?"
         po pytaniu o markę (Bielik gubił markę w LLM rewrite).
    """
    if not history:
        return None
    for injector in (
        _inject_plates_subject_from_history,  # 8.h.33
        _inject_plate_from_history,           # 8.h.23
        _inject_make_from_history,            # 8.h.32
    ):
        rewritten = injector(question, history)
        if rewritten is not None:
            return rewritten
    return None


async def rewrite_question_with_context(
    question: str,
    history: list[Turn],
    max_turns: int = 4,
) -> str:
    """
    Wywołuje LLM żeby przepisał `question` w kontekście `history`.

    Zwraca rewritten question (gdy LLM zwróci coś sensownego) lub
    `question` bez zmian (gdy: brak historii, nie follow-up, LLM fail,
    output podejrzanie długi/pusty).

    Args:
      max_turns: ile ostatnich tur dostarczyć LLM-owi. Domyślnie 4
                 (zwykle 2 user + 2 assistant — najnowszy kontekst).
    """
    if not history:
        return question

    # Deterministyczne carry-overy (8.h.33 → 8.h.23 → 8.h.32) PRZED LLM —
    # kolejność i uzasadnienia w docstringu deterministic_rewrite().
    deterministic = deterministic_rewrite(question, history)
    if deterministic is not None:
        return deterministic

    # FAZA 8.h.30 (2026-07-03) — deterministic skip dla "inny kurier/
    # taksówka/śmieciarka". Bug produkcyjny: "A jakiegoś innego kuriera ?"
    # po pytaniu o DHL — LLM rewrite potrafił wstrzyknąć markę z historii
    # ("...inny kurier niż DHL?"), a nazwa marki w pytaniu kieruje
    # classify_regex z powrotem do search_by_brand_today(DHL) zamiast
    # agregatu kurierskiego. Surowe pytanie JUŻ matchuje regułę
    # search_courier_recent (inn* + kurier), więc rewrite jest zbędny
    # i tylko szkodzi. Lekcja 8.h.16/8.h.23: deterministyka > LLM.
    if re.search(r"\binn\w*", question, re.IGNORECASE) and re.search(
        r"kurier\w*|courier|dostaw\w*|taks[oó]wk\w*|\btaxi\b|śmieciar\w*|smieciar\w*",
        question,
        re.IGNORECASE,
    ):
        return question

    if not looks_like_followup(question):
        # Pytanie wygląda samowystarczalnie — oszczędzamy LLM call.
        return question

    history_text = _format_history(history, max_turns)
    user_msg = f"HISTORIA:\n{history_text}\nPYTANIE: {question}\nWYNIK:"

    # FAZA 8.h.11 — dynamic LLM config z Edge (Bielik / Qwen3 / etc.)
    from llm_config import get_active_llm
    llm = get_active_llm()
    payload: dict[str, Any] = {
        "model": llm.model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT_REWRITE},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "options": {
            "temperature": 0.0,
            "num_predict": 80,  # rewrite to 1 krótkie zdanie
        },
    }

    try:
        async with httpx.AsyncClient(timeout=CONFIG.ollama_timeout_s) as client:
            r = await client.post(
                f"{llm.url}/api/chat",
                json=payload,
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        log.warning("Rewrite LLM call failed (%s) — fallback to original", e)
        return question

    rewritten = (data.get("message", {}) or {}).get("content", "")
    if not isinstance(rewritten, str):
        return question

    rewritten = rewritten.strip()
    # Strip popularne LLM-prefiksy, gdyby model je dorzucił mimo instrukcji.
    rewritten = re.sub(
        r"^(WYNIK:|PRZEPISANE:|Pytanie:|Pełne pytanie:)\s*",
        "",
        rewritten,
        flags=re.IGNORECASE,
    ).strip()
    # Usuń ewentualne otaczające cudzysłowy.
    if rewritten.startswith(("\"", "“", "„")) and rewritten.endswith(("\"", "”")):
        rewritten = rewritten[1:-1].strip()

    # Sanity guard: pusty / zbyt długi / wieloliniowy output → fallback.
    if not rewritten or len(rewritten) > 250 or "\n" in rewritten:
        log.warning("Rewrite output invalid (%r) — fallback to original", rewritten[:120])
        return question

    return rewritten
