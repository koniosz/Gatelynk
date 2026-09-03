"""
Intent classification — two-stage pipeline.

Stage 1: regex/keyword matching.
  Większość codziennych pytań ("ile białych dziś?", "kurier?", "tablica X")
  matchuje prosty regex w < 1 ms. Pełna determinizm, żadnej halucynacji.

Stage 2: LLM fallback (Ollama, temperature=0, JSON mode).
  Tylko gdy Stage 1 nie matchnął. LLM zwraca striktly JSON z intencją +
  parametrami. Output jest WALIDOWANY przeciwko zamkniętej liście intencji
  i enum-ach parametrów — jeśli model wymyśli coś spoza, redukujemy do
  intent='unknown'.

Stage 3: validate().
  Wymusza canonical form parametrów (kolor PL → EN canonical, tablica UPPER).
  Zapewnia że wartości pasują do typów oczekiwanych przez SQL templates.
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

# ─────────────────────────────────────────────────────────────────────────────
# Vocabularies — canonical English values, PL aliases mapowane na te canonical
# ─────────────────────────────────────────────────────────────────────────────

# Canonical color set — DB storage uses these lowercase values.
VALID_COLORS = {
    "white", "black", "red", "blue", "green",
    "yellow", "silver", "gray", "brown", "orange",
}

# Stem-based PL patterns — łapie wszystkie odmiany przypadków/liczb.
# Każdy regex matchuje od dowolnej formy: "biały" / "białych" / "białą" itd.
# Przyporządkowanie do EN canonical: pierwszy match wygrywa.
COLOR_PATTERNS: list[tuple[str, str]] = [
    # (canonical, regex)
    ("white",  r"bia[lł]\w*|white"),
    ("black",  r"czarn\w*|black"),
    ("red",    r"czerwon\w*|red"),
    ("blue",   r"niebiesk\w*|blue"),
    ("green",  r"zielon\w*|green"),
    ("yellow", r"[żz][oó][lł]t\w*|yellow"),
    ("silver", r"srebrn\w*|silver"),
    ("gray",   r"szar\w*|gr[ae]y"),
    ("brown",  r"br[aą]zow\w*|brown"),
    ("orange", r"pomara[nń]czow\w*|orange"),
]

# Dla walidacji LLM-output: input → canonical (case-insensitive).
# Akceptowane formy: EN canonical + popularne PL leksykony bazowe.
COLOR_ALIASES: dict[str, str] = {}
for canon, _ in COLOR_PATTERNS:
    COLOR_ALIASES[canon] = canon  # EN samo-mapowanie

_PL_COLOR_BASE: dict[str, str] = {
    "biały": "white", "biała": "white", "białe": "white",
    "czarny": "black", "czarna": "black", "czarne": "black",
    "czerwony": "red", "czerwona": "red", "czerwone": "red",
    "niebieski": "blue", "niebieska": "blue", "niebieskie": "blue",
    "zielony": "green", "zielona": "green", "zielone": "green",
    "żółty": "yellow", "żółta": "yellow", "żółte": "yellow",
    "srebrny": "silver", "srebrna": "silver", "srebrne": "silver",
    "szary": "gray", "szara": "gray", "szare": "gray",
    "brązowy": "brown", "brązowa": "brown",
    "pomarańczowy": "orange", "pomarańczowa": "orange",
}
COLOR_ALIASES.update(_PL_COLOR_BASE)

# Canonical tags
VALID_TAGS = {"dostawa", "kurier", "mieszkaniec", "gosc", "serwis"}

# Stem patterns dla tagów (dla regex classifier).
TAG_PATTERNS: list[tuple[str, str]] = [
    ("kurier",      r"kurier\w*|courier"),
    ("dostawa",     r"dostaw\w*|delivery"),
    ("mieszkaniec", r"mieszka(n|ń)\w*|resident"),
    ("gosc",        r"go[sś][cć]\w*|guest"),
    ("serwis",      r"serwis\w*|service"),
]

# Dla walidacji LLM-output (canonical → canonical).
TAG_ALIASES: dict[str, str] = {
    "dostawa": "dostawa", "delivery": "dostawa",
    "kurier": "kurier", "courier": "kurier",
    "mieszkaniec": "mieszkaniec", "resident": "mieszkaniec",
    "gość": "gosc", "gosc": "gosc", "guest": "gosc",
    "serwis": "serwis", "service": "serwis",
}

VALID_DIRECTIONS = {"in", "out"}

VALID_INTENTS = {
    # 2026-08-15 — Event Intelligence §8 (SCHEDULE_VS_OBSERVED): „czy śmieci
    # już zabrali?" — porównanie harmonogramu z KB z obserwacjami kamer.
    # Composite handler w app.py (jak recent_activity_summary), bez template.
    "waste_pickup_status",
    # 2026-08-15 — Event Intelligence §9: para wjazd/wyjazd → czas pobytu.
    "visit_duration_by_plate",
    # 2026-08-15 — Event Intelligence §5 AGGREGATION: typowa godzina śmieciarki.
    "waste_typical_time",
    # 2026-08-15 — Event Intelligence §16: pojazdy uprzywilejowane po OCR —
    # „czy była dziś karetka?", „czy widziałeś radiowóz?". Deterministyczne
    # aliasy w SQL (AMBULANS/POGOTOWIE/POLICJA/STRAŻ), odpowiedź hedged
    # („pojazd z oznaczeniem…" — klasyfikacja wyłącznie z OCR).
    "search_emergency_recent",
    # 2026-08-19 — „czy widziałeś dziś biały bus?": opis pojazdu (kolor+typ)
    # po kolumnach VLM vision_detections (vehicle_kind/vehicle_color) —
    # to samo wnioskowanie co wyszukiwarka panelu Wizji.
    "search_vehicle_desc",
    "count_vehicles_today",
    # 2026-08-24 — „jakie samochody pojawiły się między 1 a 6 rano?": lista
    # odczytów LPR w oknie czasowym (nie licznik, bez filtra koloru/tagu).
    "list_vehicles_recent",
    "count_vehicles_by_color_today",
    "count_vehicles_by_tag_today",
    "courier_today",
    "search_by_text_today",
    "vehicle_history_by_plate",
    "last_seen_plate",
    # FAZA 8.h.23 (2026-06-12) — "do kogo należy pojazd X". PRIVACY: odpowiedź
    # zwraca TYLKO przypisany lokal (unit_label), NIGDY właściciela — SQL
    # template celowo nie selectuje kolumny `owner` (Bielik nie może wygadać
    # czego nie dostał w rows).
    "vehicle_owner_by_plate",
    # Nowe (2026-05-19):
    "count_gate_openings_today",      # "ile dziś otwarć bram"
    "list_vehicles_by_color_today",   # "jakie czerwone auta" (lista, nie count)
    "count_visits_by_plate",          # "ile razy był X" + plate
    "search_vehicles_today",          # "czy taxi/sushi/uber" (free-form keyword)
    "list_unmatched_plates",          # "ostatnie nieznane tablice" (matched=0)
    "list_errors_recent",             # "jakieś błędy w godzinie?"
    "count_errors_recent",            # "ile błędów"
    "list_devices",                   # "jakie urządzenia są podłączone?"
    # YOLO vision intents (2026-05-19):
    "count_objects_today",            # "ile osób dziś", "ile psów w godzinie"
    "list_recent_detections",         # "co widziała kamera ostatnio"
    # Brand detection (2026-05-19, vision-side): zapytania o widziane logo
    # kurierów/usług ("czy widziałeś dziś DHL", "pokaż wszystkie InPost").
    # NIE myli się z search_vehicles_today (LPR-side): brand=widzialna
    # nazwa firmy na pojeździe, search_vehicles=tag/owner z whitelist.
    "search_by_brand_today",
    # Waste-truck detection (2026-05-19, vision-side): „czy dziś odebrali
    # szkło", „kiedy ostatnio papier". Czyta vision_detections.waste_category
    # zapisaną przez YOLO+EasyOCR pipeline (waste_matcher.py na MacBooku).
    # Kategoria opcjonalna — pytanie „czy była dziś śmieciarka" zwraca każdy
    # waste_category != NULL.
    "search_by_waste_today",
    # FAZA 8.h.29 (2026-07-03) — HISTORIA klas obiektów YOLO: „czy widziałeś
    # kota?", „kiedy ostatnio był pies?". Odpowiedź = OSTATNIE wystąpienie
    # (data+godzina) + liczba klatek w długim oknie. Pseudo-klasa `animal`
    # agreguje cat+dog („czy widziałeś jakieś zwierzę?").
    "last_seen_object",
    # FAZA 8.h.29 (2026-07-03) — „kiedy ostatnio była taksówka?". Pseudo-
    # kategoria TAXI po stronie vision: brand_detected IN (UBER, BOLT)
    # OR text_raw LIKE '%taxi%'/'%free now%'. NIE używa lpr_reads.vehicle_brand
    # (numeryczne Hikvision IDs — pułapka projektu #7).
    "search_taxi_recent",
    # FAZA 8.h.30 (2026-07-03) — agregat KURIER: „czy był dziś jakiś kurier?",
    # „jaki kurier ostatnio?", „a jakiegoś innego kuriera?". UNION dwóch
    # źródeł: vision brand_detected z marek kurierskich + lpr_reads z tagiem
    # kurier/dostawa lub vehicle_kind='DELIVERY'. NIGDY samo kind='SERVICE'
    # (bug produkcyjny: „Opiekunka Pani Halinka" [SERVICE z whitelisty]
    # przedstawiona jako kurier).
    "search_courier_recent",
    # FAZA 8.h.32 (2026-07-05) — marki FABRYCZNE samochodów (Toyota/Mercedes/
    # BMW…): tablice z whitelisty lpr_plates po tagu marki → przejazdy z
    # lpr_reads w oknie. Odpowiedź: czasy wjazdów/wyjazdów + liczba; gdy brak
    # marki na whitelistcie — mówi to wprost. PRIVACY jak 8.h.23: SQL nie
    # selectuje owner ani tags; wolno podać lokal (unit_label).
    "search_by_vehicle_make",
    # Knowledge base RAG search (2026-05-20):
    "search_knowledge_base",          # "co mówi uchwała X", "kiedy odbierają plastik"
    # Activity summary (2026-05-22):
    #   „co ciekawego działo się w ostatniej godzinie", „raport z 4 godzin"
    #   — multi-aggregate LPR + vision w jednej odpowiedzi.
    "recent_activity_summary",
    "unknown",
}

# ─── Knowledge base (RAG) — keyword triggers ──────────────────────────────────
# Pytania o dokumenty wgrane do bge-m3 indeksu (uchwały, regulaminy, harmonogramy,
# kontakty, messenger chats). Routing → Edge HTTP POST /knowledge/search.
#
# UWAGA: knowledge check MUSI być pierwsza w classify_regex (przed
# search_vehicles_today, list_*) — bo „kontakt" jest też w SEARCH_KEYWORDS,
# „harmonogram" mogłoby wpaść w błędną intencję, „§"/„paragraf" nigdzie indziej
# nie występuje.

# Catch-all triggers — match którykolwiek z poniższych → intent=search_knowledge_base
#
# UWAGA dot. rzeczownik vs czasownik (2026-05-20):
#   • "kiedy odbier"  ⇒ czasownik "odbierać/odbierają" (kiedy odbier*ają*)
#   • "kiedy odbiór"  ⇒ rzeczownik "odbiór" (kiedy *odbiór* odpadów)
#   Te dwie formy mają RÓŻNE litery (e vs ó) i regex/substring NIE łączy ich
#   automatycznie. Musimy oba mieć na liście, inaczej pytanie o rzeczownik
#   spada do WASTE_KEYWORDS (gdzie "odbiór" → vision-side search_by_waste_today)
#   zamiast knowledge base (harmonogram odbioru śmieci w INNE).
KNOWLEDGE_TRIGGER_KEYWORDS: tuple[str, ...] = (
    "uchwała", "uchwal", "uchwałę", "uchwały", "uchwale",
    "regulamin",
    "harmonogram",
    "numer telefonu", "telefon do",
    "kiedy odbier", "kiedy wywoz", "kiedy wywoż", "kiedy przyjeżdż", "kiedy przyjezdz",
    # Rzeczownikowe formy odbioru (harmonogram śmieci):
    "kiedy odbiór", "kiedy odbioru", "termin odbioru", "harmonogram odbioru",
    # FAZA 8.h.14 (2026-06-09) — formy z czasem przyszłym / planowanym.
    # "Kiedy jest planowany odbiór" / "kiedy będzie wywóz" itp. mieszczą
    # `odbiór` ale z dalszymi słowami w środku, więc poprzednie literalne
    # triggery nie matchują. Te 8 wzorców pokrywa typowe formy PL.
    "planowany odbiór", "planowany wywóz", "planowany wywoz",
    "kiedy jest odbiór", "kiedy jest odbioru",
    "kiedy będzie odbiór", "kiedy bedzie odbior",
    "następny odbiór", "nastepny odbior", "najbliższy odbiór", "najblizszy odbior",
    "kolejny odbiór", "kolejny odbior",
    "kiedy śmieciarka będzie", "kiedy smieciarka bedzie",
    "kiedy zabiorą śmieci", "kiedy zabiora smieci",
    # FAZA 8.h.17 (2026-06-09) — Day Summary card / iOS HomeView.
    # Day-summary endpoint w Cloud zadaje pytanie "Co dziś jest zaplanowane
    # na osiedlu?" i Bielik łączy harmonogramy + ogłoszenia w 1-3 zdaniach.
    # Sam "harmonogram" zwykle wystarcza (już wyżej), ale dodajemy
    # bezpieczniki dla wariantów typu "co dziś zaplanowane / planowane
    # wydarzenia / planowane przerwy" które mogą paść standalone.
    "co dziś zaplanowane", "co dzis zaplanowane",
    "co jest zaplanowane", "co zaplanowane",
    # EVAL 2026-06-11: Cloud day-summary pyta dokładnie "Co dziś jest
    # zaplanowane na osiedlu?" — słowo "jest" w środku omijało poprzednie
    # literalne triggery ("co dziś zaplanowane" / "co jest zaplanowane").
    "jest zaplanowane", "zaplanowane na osiedlu",
    "planowane wydarzenia", "planowane przerwy",
    "przerwa w dostawie", "przerwa wody", "przerwa prądu",
    "przerwa pradu", "wyłączenie wody", "wylaczenie wody",
    "wyłączenie prądu", "wylaczenie pradu",
    "co mówi", "co pisze", "co pisał", "co pisali", "co mowi",
    "według", "wedle", "wedlug",
    "§", "paragraf",
    "sąsiedzi", "sasiedzi", "messenger",
    "zasady", "wytyczne",
    # Kontakty / zarządzanie osiedlem (KONTAKT type):
    # "administracj" łapie "numer do administracji" / "kontakt z administracją"
    # (EVAL 2026-06-11 — "administrator" nie jest substringiem "administracji").
    "administrator", "administracj", "zarządca", "zarzadca", "zarządcy", "zarzadcy",
    "kontakt do", "dane kontaktowe", "skontaktować się", "skontaktowac sie",
    # Email — zarówno standalone jak "adres email/mail" (po rewrite z follow-up'a):
    "email", "e-mail", "e mail", "adres mail", "adres email", "adres e-mail",
)

# FAZA 8.h.31 (2026-07-03) — rodzina „kontakt/serwis/naprawa/awaria" jako
# REGEXY (substring-triggery wyżej nie łapią fleksji/szyku). Zgłoszenie:
# „Czy masz namiar do kogoś kto może naprawić piec gazowy ?" → unknown,
# mimo że KB ma dokumenty KONTAKT z usługodawcami. Pytania z tej rodziny
# NIGDY nie idą w unknown — zawsze próbują KB (uczciwe „nie znalazłem
# w bazie wiedzy — zapytaj zarządcę" > „nie potrafię odpowiedzieć").
#
# UWAGA kolizje: „brama/domofon/winda" występują też w licznikach („ile
# otwarć bram" → count_gate_openings) i list_devices — dlatego obiekt
# infrastruktury NIGDY nie triggeruje sam, tylko w parze z awaria/usterka/
# naprawa (proximity ≤3 słowa) albo frazą „kto naprawi/zajmuje się".
# „Domofon nie działa" (bez naprawy/awarii) zostaje w list_errors_recent
# — golden testy na obie strony kolizji w questions_catalog.yaml.
_KB_INFRA_OBJECT = (
    r"(?:piec\w*|ogrzewan\w*|kot[lł]\w*|kaloryfer\w*|grzejnik\w*"
    r"|hydraulicz\w*|instalacj\w*|pr[aą]d\w*|elektrycz\w*"
    r"|wind\w*|bram\w*|domofon\w*|klimatyzac\w*|gaz\w*|wod\w*|kanalizac\w*)"
)

KNOWLEDGE_TRIGGER_REGEXES: tuple = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # „namiar do/na X" — potoczne „daj kontakt"
        r"\bnamiar\w*",
        # „kto (może) (to) naprawi(ć)/naprawia"
        r"\bkto\s+(?:mo[żz]e\s+)?(?:to\s+)?napraw\w*",
        # „kto zajmuje się X"
        r"\bkto\s+zajmuje\s+si[eę]",
        # „gdzie (mogę) zgłosić…" / „zgłosić awarię/usterkę"
        r"\bgdzie\s+(?:mog[eę]\s+)?zg[lł]osi[cć]",
        r"zg[lł]osi[cć]\s+(?:awari\w*|usterk\w*)",
        # awaria/usterka/naprawa + obiekt infrastruktury (≤3 słowa odstępu,
        # oba szyki): „awaria ogrzewania", „usterka bramy", „naprawa pieca
        # gazowego", „piec gazowy — naprawa"
        rf"(?:awari\w*|usterk\w*|napraw\w*)(?:\W+\w+){{0,3}}?\W+{_KB_INFRA_OBJECT}",
        rf"{_KB_INFRA_OBJECT}(?:\W+\w+){{0,3}}?\W+(?:awari\w*|usterk\w*|napraw\w*)",
        # Specjaliści — „potrzebuję hydraulika", „szukam elektryka"
        r"\bhydraulik\w*|\belektryk\w*|\bserwisant\w*|z[lł]ot\w+\s+r[aą]czk\w*",
    )
)

# Mapping regex pattern (PL stem) → canonical doc type filter.
# Pierwszy match wygrywa. None = brak filtra (każdy typ).
KNOWLEDGE_TYPE_HINTS: list[tuple[str, str]] = [
    (r"\buchwa[lł]\w*\b",                               "UCHWALA"),
    (r"\bregulamin\w*\b",                               "REGULAMIN"),
    # KONTAKT: telefon/kontakt/email + osoby zarządzające osiedlem
    # (administrator, zarządca) — dla pytań typu "kto jest administratorem"
    # albo "Jaki jest adres email Janusza Aszklara?" (po rewrite).
    # Email: `(?:e[-\s]?)?` żeby pasowało zarówno "email", "e-mail", "e mail"
    # jak i samo "mail" (np. "adres mail").
    # `administra\w*` (nie `administrator\w*`) — łapie też "administracji"
    # ("Jaki jest numer do administracji?", EVAL 2026-06-11).
    # 8.h.31: + namiar/specjaliści (hydraulik/elektryk/serwisant/złota rączka)
    # — pytania stricte kontaktowe. „kto naprawi X"/„awaria X" celowo BEZ
    # hintu (szeroki search — kontakt do serwisu może być w dokumencie INNE).
    (r"\bnumer\s+telefon\w*|\btelefon\s+do\b|\bkontakt\w*\b|\badministra\w*|\bzarz[ąa]dc\w*|\b(?:e[-\s]?)?mail\w*\b|\bnamiar\w*|\bhydraulik\w*|\belektryk\w*|\bserwisant\w*|z[lł]ot\w+\s+r[aą]czk\w*", "KONTAKT"),
    (r"\bs[aą]siedz\w*|\bmessenger\w*|\bgrupa\b",       "MESSENGER_CHAT"),
    (r"\bharmonogram\w*|\bodbi[óo]r\w*|\bplastik\w*|\bszk[lł]\w*|\bpapier\w*|\bs[lł]ownik\w*", "INNE"),
]


def _detect_knowledge_type(q: str) -> str | None:
    """Zwraca canonical doc type (UCHWALA/REGULAMIN/...) lub None gdy brak hintu."""
    for pattern, doc_type in KNOWLEDGE_TYPE_HINTS:
        if re.search(pattern, q, re.IGNORECASE):
            return doc_type
    return None

# Brand keywords known to the vision pipeline (must mirror
# yolo-vision/brand_matcher.py BRAND_PATTERNS keys, lowercase). When the user
# mentions a brand AND uses camera-phrasing ("widziałeś"/"kamera"), we route
# to the vision intent; otherwise we fall back to LPR-side search_vehicles_today.
BRAND_KEYWORDS: tuple[str, ...] = (
    "dhl", "dpd", "inpost", "fedex", "gls", "ups", "poczta", "pocztex",
    "allegro", "dachser",
    "glovo", "wolt", "uber", "bolt", "pyszne",
)

# FAZA 8.h.13 (2026-06-09) — full mapping lowercase keyword → canonical
# `vision_detections.brand_detected` value. Musi być w sync z BRAND_PATTERNS
# w `apps/yolo-vision/brand_matcher.py` (40+ marek po fazie 8.h.5).
#
# Wcześniej intent_classifier znał tylko 15 keywords (kurierzy), brakowało
# retail/AGD/spożywki/aptek mimo że YOLO rozpoznawał ich napisy. Pytanie
# "Kiedy ostatnio był FRISCO?" miało wpis w `vision_detections.brand_detected`
# = 'FRISCO' ale `_extract_brand_keyword` zwracał None → fallback do złego
# intent.
#
# Multi-word brands ("media expert" / "rtv euro agd") mają warianty z/bez
# spacji. Kolejność (sort by len desc w extractor) zapewnia że dłuższe matche
# wygrywają (np. "media expert" przed "media").
BRAND_KEYWORD_MAP: dict[str, str] = {
    # ── Kurierzy ───────────────────────────────────────────────────────
    "dhl": "DHL", "dpd": "DPD", "inpost": "INPOST", "fedex": "FEDEX",
    "gls": "GLS", "ups": "UPS", "poczta": "POCZTA", "pocztex": "POCZTEX",
    "allegro": "ALLEGRO", "dachser": "DACHSER",
    # ── Food delivery ──────────────────────────────────────────────────
    "glovo": "GLOVO", "wolt": "WOLT", "uber": "UBER", "bolt": "BOLT", "pyszne": "PYSZNE",
    # ── Diet box (catering dietetyczny) ────────────────────────────────
    "ntfy": "NTFY", "maczfit": "MACZFIT", "lightbox": "LIGHTBOX",
    "bodychief": "BODYCHIEF", "bediet": "BEDIET", "dietly": "DIETLY",
    "fitme": "FITME", "dietbox": "DIETBOX", "paleopower": "PALEOPOWER",
    "smartfood": "SMARTFOOD", "fitway": "FITWAY",
    # ── AGD/RTV (8.h.5) ────────────────────────────────────────────────
    "media expert": "MEDIA_EXPERT", "mediaexpert": "MEDIA_EXPERT",
    "media markt": "MEDIA_MARKT", "mediamarkt": "MEDIA_MARKT",
    "rtv euro agd": "RTV_EURO_AGD", "euro agd": "RTV_EURO_AGD",
    "rtveuroagd": "RTV_EURO_AGD",
    "x-kom": "X_KOM", "xkom": "X_KOM", "x kom": "X_KOM",
    "komputronik": "KOMPUTRONIK", "neonet": "NEONET", "avans": "AVANS",
    # ── DIY / dom ──────────────────────────────────────────────────────
    "ikea": "IKEA", "obi": "OBI",
    "leroy merlin": "LEROY_MERLIN", "leroymerlin": "LEROY_MERLIN",
    "castorama": "CASTORAMA", "jysk": "JYSK",
    # ── Spożywka online ────────────────────────────────────────────────
    "frisco": "FRISCO", "barbora": "BARBORA",
    "biedronka": "BIEDRONKA", "lidl": "LIDL",
    "auchan": "AUCHAN", "carrefour": "CARREFOUR",
    # ── Apteki ─────────────────────────────────────────────────────────
    "doz": "DOZ", "gemini": "GEMINI",
}

# ── FAZA 8.h.32 (2026-07-05) — marki FABRYCZNE samochodów ────────────────────
# Zgłoszenie (transkrypt właściciela): „Ile Mercedesów widziałeś w ostatnich
# 12 godzinach?" / „A czy widziałeś jakąś Toyotę?" → search_vehicles_today
# (okno TYLKO dziś, LIKE po owner/brand/tags) → „nie zarejestrowano niczego"
# mimo że Toyota mieszkańca jest na białej liście (tag "Toyota") i ma wjazdy.
#
# Nowy intent `search_by_vehicle_make`: marka → tablice z whitelisty
# `lpr_plates.vehicle_tags` (8.h.25 — tagi zawierają markę/model/kolor) →
# przejazdy z `lpr_reads` w zadanym oknie. NIGDY `lpr_reads.vehicle_brand`
# (numeryczne Hikvision IDs, pułapka projektu #7).
#
# Stem-regexy łapią polskie odmiany („toyotę", „mercedesów", „oplem").
# Pierwszy match wygrywa — multi-word marki (Land Rover) na początku listy.
# RÓŻNICA od BRAND_KEYWORD_MAP: tam operatorzy/kurierzy/retail (vision OCR),
# tu marki fabryczne (LPR whitelist). Zbiory keywords są rozłączne; przy
# frazingu „kurier/dostawa" reguła make jest wyłączona (not_patterns w YAML).
CAR_MAKE_PATTERNS: list[tuple[str, str]] = [
    # (canonical — jak w tagach whitelisty, regex)
    ("Land Rover",  r"\bland\s*rover\w*|\brange\s*rover\w*|\blandrover\w*"),
    ("Volkswagen",  r"\bvolkswagen\w*|\bvw\b"),
    ("Mercedes",    r"\bmercedes\w*|\bmerc\b"),
    ("Toyota",      r"\btoyot\w*"),
    ("BMW",         r"\bbmw\b"),
    ("Audi",        r"\baudi\b"),
    ("Skoda",       r"\bskod\w*|\bškod\w*"),
    ("Ford",        r"\bford\w*"),
    ("Opel",        r"\bopel\w*|\bopl[aeu]\w*"),
    ("Kia",         r"\bkia\b|\bki[ąęi]\b"),
    ("Hyundai",     r"\bhyundai\w*|\bhundai\w*"),
    ("Renault",     r"\brenault\w*|\breno\b"),
    ("Peugeot",     r"\bpeugeot\w*|\bpe[żz]o\b"),
    ("Citroen",     r"\bcitro[eë]n\w*"),
    ("Mazda",       r"\bmazd\w*"),
    ("Honda",       r"\bhond\w*"),
    ("Nissan",      r"\bnissan\w*"),
    ("Volvo",       r"\bvolv\w*"),
    ("Seat",        r"\bseat\w*"),
    ("Fiat",        r"\bfiat\w*"),
    ("Dacia",       r"\bdaci\w*"),
    ("Tesla",       r"\btesl\w*"),
    ("Lexus",       r"\blexus\w*"),
    ("Suzuki",      r"\bsuzuki\w*"),
    ("Mitsubishi",  r"\bmitsubishi\w*"),
    ("Jeep",        r"\bjeep\w*"),
    ("Porsche",     r"\bporsch\w*"),
    ("Mini",        r"\bmini\b"),
    ("Smart",       r"\bsmart\b"),   # NIE koliduje z brandem "smartfood" (\b)
    ("Iveco",       r"\biveco\b"),
    ("MAN",         r"\bman\b|\bmanem\b"),
    ("Scania",      r"\bscani\w*"),
]

VALID_CAR_MAKES = {canon for canon, _ in CAR_MAKE_PATTERNS}

# Aliasy do SQL pad-token match (' '||REPLACE(LOWER(value),'-',' ')||' ' LIKE
# '% token %'). Dwa placeholdery per query — marki z 1 tokenem mają 2× to samo.
CAR_MAKE_SQL_ALIASES: dict[str, tuple[str, str]] = {
    "Volkswagen": ("volkswagen", "vw"),
    "Mercedes":   ("mercedes", "mercedes benz"),
    "Land Rover": ("land rover", "range rover"),
}


def _match_car_make(q: str) -> str | None:
    """Zwraca canonical markę (Toyota/Mercedes/…) albo None. Stem-based —
    łapie polskie odmiany. Case-insensitive."""
    for canon, pattern in CAR_MAKE_PATTERNS:
        if re.search(pattern, q, re.IGNORECASE):
            return canon
    return None

# ── Waste-truck keywords (2026-05-19) ─────────────────────────────────────
# Mapowanie PL keyword (lowercase, base form) → canonical category w
# vision_detections.waste_category. value=None oznacza "generic śmieciarka
# bez konkretnej kategorii" — w tym przypadku intent jest nadal
# search_by_waste_today, ale `category` parametr jest pominięty
# i SQL template zwraca wszystkie waste-trucks (NULL→IS NULL gate).
#
# Pokrywa odmiany (genitive/locative/plural — PL flexed nouns).
# Kolejność tutaj nie ma znaczenia bo to dict-lookup, ale kolejność
# w klasyfikatorze regex MUSI być przed COLOR_PATTERNS (bo „ZIELONE"
# tutaj = BIO, w COLOR_PATTERNS = green) i przed BRAND_KEYWORDS
# (semantycznie waste > brand dla pytań o odbiór odpadów).
WASTE_KEYWORDS: dict[str, str | None] = {
    # GLASS (zielony/biały kontener)
    "szkło": "GLASS", "szkla": "GLASS", "szkła": "GLASS", "szklane": "GLASS",
    # PAPER (niebieski)
    "papier": "PAPER", "papieru": "PAPER", "papiery": "PAPER",
    "makulatura": "PAPER", "makulatury": "PAPER", "tektura": "PAPER",
    # PLASTIC (żółty) — synonimy z "metale i tworzywa sztuczne"
    "plastik": "PLASTIC", "plastiku": "PLASTIC", "plastiki": "PLASTIC",
    "tworzywa": "PLASTIC", "tworzyw": "PLASTIC",
    "metale": "PLASTIC", "metali": "PLASTIC",
    # BIO (brązowy) — w PL slangu „zielone" = ogród/trawa = bio
    "bio": "BIO", "biodegradowalne": "BIO", "biodegradowalnych": "BIO",
    "zielone": "BIO", "zielony": "BIO",
    # MIXED (czarny) — komunalne = zmieszane w PL nomenklaturze
    "zmieszane": "MIXED", "zmieszanych": "MIXED",
    "komunalne": "MIXED", "komunalnych": "MIXED",
    # Generic — śmieciarka/odbiór bez kategorii. category=None → SQL bez filtra.
    "śmieciarka": None, "smieciarka": None, "śmieciarki": None, "smieciarki": None,
    # FAZA 8.h.29 (2026-07-03) — pełna fleksja + warianty bez diakrytyków.
    # Zgłoszenie: „czy ostatnio widziałeś jakąś śmieciarką ?" (narzędnik /
    # literówka celownika) spadało do unknown, bo _extract_waste_keyword
    # matchuje CAŁE tokeny — każda odmiana musi być w słowniku explicit.
    "śmieciarką": None, "smieciarką": None, "smieciarkę": None,
    "śmieciarkę": None, "smieciarke": None,
    "śmieciarce": None, "smieciarce": None,
    "śmieciarek": None, "smieciarek": None,
    "śmieciara": None, "smieciara": None, "śmieciary": None, "smieciary": None,
    "śmieci": None, "smieci": None,
    "odbiór": None, "odbioru": None, "odbiory": None,
}

# Canonical category set — używane do walidacji LLM-classified output.
VALID_WASTE_CATEGORIES = {"GLASS", "PAPER", "PLASTIC", "BIO", "MIXED"}

# Polish keyword → COCO class name (canonical, used as DB filter).
# Stem-based regex — łapie wszystkie odmiany przypadków/liczb.
# Pierwszy match wygrywa (najbardziej specyficzne — dog/cat — pierwsze;
# rower/motocykl przed catch-all "vehicle"; "torba"/"paczka" mapują na
# backpack jako primary — handbag/suitcase są niżej w summary i builder
# je przedstawia per row).
VISION_OBJECT_PATTERNS: list[tuple[str, str]] = [
    # `os[oó]b\w*` jest celowo szersze niż `osob\w*` bo `\w` w default-mode
    # nie traktuje `ó` jak word-char w kontekście liter sąsiednich — patrz
    # `osób` (genitive plural). Każdy pattern dla PL musi explicit obsługiwać
    # ó/ś/ź/ć/ż w środku słowa.
    # `piesz\w*` (FAZA 8.h.29) — "pieszy/pieszych" → person. Nie koliduje
    # z dog (`pies\b` wymaga boundary po "pies", a "pieszy" go nie ma).
    ("person",      r"os[oó]b\w*|ludz[ią]\w*|ludzie|cz[lł]owiek\w*|piesz\w*|person\w*|people"),
    ("dog",         r"psy\b|ps[ay]\w*|pies\b|ps[oó]w\b|dog\w*"),
    ("cat",         r"kot[ay]?\b|kot\w*|kocur\w*|cat\w*"),
    ("bicycle",     r"rower\w*|bicycl\w*|bike\b"),
    ("motorcycle",  r"motocykl\w*|motor\w*|moto\b|motorbike"),
    ("bus",         r"autobus\w*|bus\b"),
    ("truck",       r"ci[eę][zż]ar[oóa]\w*|truck\w*"),
    ("backpack",    r"plecak\w*|paczk\w*|backpack"),
    ("handbag",     r"torb\w*|torebk\w*|handbag"),
    ("suitcase",    r"walizk\w*|suitcase"),
    ("umbrella",    r"parasol\w*|umbrella"),
    # `car` na samym końcu — "auto/samochód" zwykle jest LPR (lpr_reads),
    # ale dla "ile aut widziała kamera Y" YOLO też pasuje. Specyficzny
    # marker: jeśli user mówi "kamera" / "widzia*" odmiana, mapujemy na car.
    ("car",         r"\bauto\b|aut\w*|samoch[oó]d\w*|\bcar\b|cars\b"),
]

VALID_VISION_OBJECTS = {p[0] for p in VISION_OBJECT_PATTERNS}

# COCO canonical (case-sensitive) — used as canonical from LLM output.
VISION_OBJECT_ALIASES: dict[str, str] = {c: c for c in VALID_VISION_OBJECTS}
# Common Polish singletons → canonical (for LLM output validation).
_PL_VISION_BASE: dict[str, str] = {
    "osoba": "person", "osoby": "person", "ludzie": "person", "person": "person",
    "pies": "dog", "psy": "dog", "dog": "dog",
    "kot": "cat", "koty": "cat", "cat": "cat",
    "rower": "bicycle", "rowery": "bicycle",
    "motor": "motorcycle", "motocykl": "motorcycle",
    "autobus": "bus",
    "ciężarówka": "truck", "ciezarowka": "truck",
    "plecak": "backpack", "paczka": "backpack",
    "torba": "handbag", "torebka": "handbag",
    "walizka": "suitcase",
    "parasol": "umbrella",
    "auto": "car", "samochód": "car", "samochod": "car",
}
VISION_OBJECT_ALIASES.update(_PL_VISION_BASE)

# PL tablica rejestracyjna: 2-3 litery + 4-5 znaków alfanumerycznych
# (np. WE12345, WA1234X, PO6MM84). Liberalna — accept różne formaty.
PLATE_RE = re.compile(r"\b([A-Z]{2,3}[0-9][0-9A-Z]{3,5})\b", re.IGNORECASE)


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — regex/keyword classifier
# ─────────────────────────────────────────────────────────────────────────────

def _extract_direction(q: str) -> str | None:
    """'in' jeśli 'wjech*' / 'entered', 'out' jeśli 'wyjech*' / 'exited', else None."""
    if re.search(r"\bwjech\w*|\bwjazd\w*|\bentered\b|\bweszł\w*", q):
        return "in"
    if re.search(r"\bwyjech\w*|\bwyjazd\w*|\bexited\b|\bopu[sś]ci\w*", q):
        return "out"
    return None


def _has_today(q: str) -> bool:
    return bool(re.search(r"\b(dzi[sś]|today|dzisiaj)\b", q))


def _extract_range_hours(q: str, default: int = 1) -> int:
    """
    Parse okno czasowe z pytania → liczba godzin.
    "ostatnia godzina" / "godzina" → 1
    "ostatnie 6 godzin" → 6
    "dzisiaj" / "dziś" / "dobie" / "dzień" → 24
    "wczoraj" → 48
    "ostatni tydzień" → 168
    Default — to czego oczekuje caller (1h dla errors, 24h dla unmatched).
    """
    # Explicit number — "ostatnich 4 godzin", "ostatnie 12h", "4 godzin", "12 h"
    m = re.search(r"(?:ostatni\w*\s+)?(\d+)\s*(godzin\w*|h\b)", q)
    if m:
        return max(1, min(int(m.group(1)), 720))
    # Named windows
    if re.search(r"tydzie[nń]|tygodni\w*|week", q):
        return 168
    if re.search(r"wczoraj|yesterday", q):
        return 48
    # FAZA 8.h.12 — "kiedy ostatnio" / "ostatni raz" — user nie wie kiedy,
    # default 7 dni żeby nie pominąć rzadkich wizyt (np. Uber raz w tygodniu).
    if re.search(r"\bostatni\w*\s+raz\b|kiedy\s+ostatni\w*|kiedy\s+by[lł]\w*", q, re.IGNORECASE):
        return 168
    # "ostatniej dobie", "ostatnia doba", "w dobie", "doba", "dzień", "dnia"
    if re.search(r"\bdob[aieęy]\w*|\bdzie[nń]\w*|\bdnia\b|\b24h\b", q):
        return 24
    if _has_today(q):
        return 24
    if re.search(r"godzin\w*|hour|hr\b", q):
        return 1
    return default


def _match_color(q: str) -> str | None:
    """Zwraca canonical EN albo None. Stem-based, łapie wszystkie odmiany PL."""
    for canon, pattern in COLOR_PATTERNS:
        if re.search(pattern, q, re.IGNORECASE):
            return canon
    return None


def _match_vision_object(q: str) -> str | None:
    """Zwraca canonical COCO class albo None. Stem-based."""
    for canon, pattern in VISION_OBJECT_PATTERNS:
        if re.search(pattern, q, re.IGNORECASE):
            return canon
    return None


def _match_tag(q: str) -> str | None:
    """Zwraca canonical tag albo None."""
    for canon, pattern in TAG_PATTERNS:
        if re.search(pattern, q, re.IGNORECASE):
            return canon
    return None


# NOTE (ETAP 2, 2026-06-11): kaskada if-ów z classify_regex została
# zastąpiona pętlą po deklaratywnym rejestrze — patrz `intents_registry.yaml`
# (kolejność = priority) + sekcja "Registry-driven classifier" niżej.
# Helpery/ekstraktory zostają tutaj — rejestr odwołuje się do nich po nazwie.


# ── Rare-event window (FAZA 8.h.29, 2026-07-03) ──────────────────────────────
# „ostatnio" / „czy widziałeś" / „kiedy był(a)" = pytanie o OSTATNIE
# wystąpienie, nie o dziś. Dla rzadkich zdarzeń (śmieciarka co 2-4 tygodnie,
# taksówka, kot) 24h/168h to za mało → rozszerzamy do `floor` (default 720h
# = 30 dni), ALE tylko gdy user NIE podał explicit okna (dziś/wczoraj/
# N godzin/tydzień — wtedy jego okno wygrywa).

_EXPLICIT_WINDOW_RE = re.compile(
    r"godzin\w*|\bhour\w*|\bhr\b|\d+\s*h\b"
    r"|tydzie[nń]|tygodni\w*|week"
    r"|wczoraj|yesterday"
    r"|\bdob[aieęy]\w*|\bdzie[nń]\w*|\bdnia\b|\b24h\b"
    r"|\b(?:dzi[sś]|dzisiaj|today)\b",
    re.IGNORECASE,
)

_RECENT_TRIGGER_RE = re.compile(
    # `\binn\w*` (8.h.30) — „a jakiegoś INNEGO kuriera?" to follow-up po
    # pytaniu o historię — user chce długiego okna, nie „dziś".
    # `szuka\w*` (8.h.32) — „ale konkretnie szukam samochodu marki Toyota"
    # bez explicit okna = user chce znaleźć rzadkie zdarzenie → długie okno.
    r"ostatni\w*|widzia[lł]\w*|kiedy\s+by[lł]\w*|czy\s+by[lł]\w*|\binn\w*|szuka\w*",
    re.IGNORECASE,
)


def _rare_event_range_hours(q: str, default: int = 24, floor: int = 720) -> int:
    """range_hours dla rzadkich zdarzeń — explicit okno wygrywa, inaczej
    trigger „ostatnio/widziałeś/czy był(a)" podnosi do `floor`."""
    hours = _extract_range_hours(q, default=default)
    if _EXPLICIT_WINDOW_RE.search(q):
        return hours
    if _RECENT_TRIGGER_RE.search(q):
        return max(hours, floor)
    return hours


def _extract_waste_keyword(q: str) -> tuple[str, str | None] | None:
    """Match the first WASTE_KEYWORDS entry appearing in `q`.

    Returns:
      (matched_keyword, canonical_category) — category is None when the
                                              matched keyword is generic
                                              (śmieciarka / odbiór / śmieci).
      None when no waste-keyword matched.

    Uses Unicode-aware lookahead/behind: `\b` is unreliable around PL
    diacritics (ł/ś/ź/ć), so we anchor on non-letter chars or string
    boundaries. Conservative — matches as a whole token, not a substring
    (e.g. „papierowy" nie matchnie „papier", „makulaturze" matchnie
    „makulatury" tylko jeśli explicit w słowniku).

    Order in WASTE_KEYWORDS dict iteration is insertion-order (Python 3.7+);
    we walk it once and return the first match. Categories (GLASS/PAPER/…)
    appear before generic terms (śmieciarka), so a query mixing both
    („śmieciarka ze szkłem") prefers the specific category. Good.
    """
    for kw, category in WASTE_KEYWORDS.items():
        # Build a Unicode-friendly word boundary: non-letter or start/end.
        # Avoids \b which mis-handles diacritics in re's default mode.
        pattern = rf"(?:^|[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]){re.escape(kw)}(?:$|[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])"
        if re.search(pattern, q, re.IGNORECASE):
            return (kw, category)
    return None


# ── Activity summary triggers (2026-05-22) ──────────────────────────────────
#
# Heurystyka która oznacza pytanie typu „co ciekawego się działo".
# Pojedynczy keyword nie wystarczy bo „raport" może oznaczać też zgłoszenie
# błędu, „co się stało" — pojedyncze zdarzenie. Wymagamy kombinacji
# trigger + sygnał czasowy ALBO mocno explicit phrase.
_ACTIVITY_STRONG_TRIGGERS: tuple[str, ...] = (
    "co ciekawego", "co sie dzialo", "co się działo", "co sie dzieje",
    "co się dzieje", "co nowego",
    "co sie stalo", "co się stało",
    # `podsum` stem łapie wszystko: podsumowanie / podsumuj / podsumuje /
    # podsumować / podsumował.
    "podsum",
    "raport",
    "co tam slychac", "co tam słychać", "co tam",
)


def _looks_like_activity_summary(q: str) -> bool:
    """
    True gdy pytanie wygląda na prośbę o multi-aggregate report.

    Strong phrases ("co ciekawego", "raport", "podsumowanie") wystarczają same.
    „Co się stało" / „co nowego" wymagają sygnału czasowego (godzin/dziś/dobie)
    żeby uniknąć false-positive na pojedynczo-incydentalnych pytaniach.
    """
    for kw in _ACTIVITY_STRONG_TRIGGERS:
        if kw in q:
            # Strong: te z "ciekawego"/"podsumowan"/"raport" — wystarczą same.
            if any(s in kw for s in ("ciekaw", "podsum", "raport", "słychać", "slychac")):
                return True
            # Słabsze ("co nowego/stało") — wymagają sygnału czasowego.
            # `dzisiaj` explicit — `dzi[sś]\b` NIE matchuje "dzisiaj"
            # (boundary po "dziś" wymaga końca słowa; EVAL 2026-06-11).
            if re.search(r"godzin\w*|dob[aieęy]\w*|dzie[nń]\w*|dni\w*|dzi[sś]\b|dzisiaj|wczoraj|\b\d+h\b|24h", q):
                return True
    return False


def _extract_brand_keyword(q: str) -> str | None:
    """Match the first BRAND_KEYWORD_MAP entry appearing in `q`.

    FAZA 8.h.13 (2026-06-09): zwraca CANONICAL UPPERCASE (matching
    `vision_detections.brand_detected`), nie raw keyword jak wcześniej.
    Multi-word keywords ("media expert") sortowane wg długości malejąco
    żeby dłuższe matche wygrywały nad krótszymi prefiksami.

    Uses word boundaries — "inpost" must be a whole token, not a substring of
    something else. Case-insensitive ('q' is already lowercased by caller).
    """
    # Sort by length descending — "media expert" before "media" etc.
    keys_sorted = sorted(BRAND_KEYWORD_MAP.keys(), key=len, reverse=True)
    for kw in keys_sorted:
        # \b doesn't work well for diacritics in re; keyword set is ASCII so
        # plain regex word boundary is fine. re.escape needed dla "x-kom" etc.
        if re.search(rf"\b{re.escape(kw)}\b", q):
            return BRAND_KEYWORD_MAP[kw]  # already UPPER canonical
    return None


# Lista keywords które LPR Edge zna (z Cloud whitelist + Hikvision ANPR brands).
# Match przez substring — "sushi" matchuje "Kimi Sushi", "taxi" matchuje "Taxi Uber".
SEARCH_KEYWORDS = {
    "taxi", "uber", "bolt", "free now",
    "sushi", "kimi", "sakana", "patata",
    "frisco", "glovo", "pyszne", "wolt",
    "kashmir", "ogrodnicy", "rowerow", "kurier inpost",
    "dhl", "dpd", "inpost", "ups", "fedex", "pocztex",
    "mercedes", "bmw", "audi", "toyota", "ford",
    "volkswagen", "skoda", "fiat", "opel", "renault",
    "range rover", "porsche", "tesla",
}


def _extract_search_keyword(q: str) -> str | None:
    """Zwraca pierwsze matching keyword z SEARCH_KEYWORDS w pytaniu."""
    for kw in SEARCH_KEYWORDS:
        if kw in q:
            return kw
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Registry-driven classifier (ETAP 2, 2026-06-11)
#
# Kolejność checków NIE jest już kaskadą if-ów — wynika z pola `priority`
# w `intents_registry.yaml`. Reguły dzielą się na:
#   • generic — patterns / patterns_all / not_patterns + extractory parametrów
#     (deklaratywne w YAML),
#   • custom  — logika która się nie generalizuje (knowledge triggers,
#     waste keywords, vision objects, courier guards) — funkcje niżej,
#     rejestrowane w _MATCHERS i wskazywane w YAML przez `matcher:`.
#
# Po KAŻDEJ zmianie (YAML albo matchery): python3 eval_classifier.py
# musi przechodzić 100% (questions_catalog.yaml — golden set 140 pytań).
# ─────────────────────────────────────────────────────────────────────────────

# ── Extractory parametrów — sygnatura (q, question, spec) → value | None ─────
# `q` = lowercase pytanie, `question` = oryginalny case (plate/KB query),
# `spec` = dict parametru z YAML (default / max).

def _ext_range_hours(q: str, question: str, spec: dict) -> int:
    return _extract_range_hours(q, default=int(spec.get("default", 1)))


def _ext_range_hours_brand(q: str, question: str, spec: dict) -> int:
    """range_hours dla brand-intentu.

    Historia: 8.h.12 wprowadził min tydzień dla "ostatnio/kiedy był"
    (default 24h pomijał rzadkie wizyty, np. Uber raz w tyg.). FAZA 8.h.30
    wyrównuje brandy do reguły rare-event (spójnie z waste/taxi/klasami
    YOLO): "ostatnio"/"czy widziałeś"/"kiedy był" BEZ explicit okna → 720h
    (30 dni). Explicit "dziś"/"wczoraj"/"w tym tygodniu" dalej wygrywa."""
    return _rare_event_range_hours(
        q,
        default=int(spec.get("default", 24)),
        floor=int(spec.get("floor", 720)),
    )


def _ext_range_hours_rare(q: str, question: str, spec: dict) -> int:
    """range_hours dla rzadkich zdarzeń (taksówka/śmieciarka/zwierzęta) —
    FAZA 8.h.29: „ostatnio"/„czy widziałeś"/„czy była" bez explicit okna
    → floor (default 720h = 30 dni)."""
    return _rare_event_range_hours(
        q,
        default=int(spec.get("default", 24)),
        floor=int(spec.get("floor", 720)),
    )


def _ext_direction(q: str, question: str, spec: dict) -> str | None:
    return _extract_direction(q)


def _ext_color(q: str, question: str, spec: dict) -> str | None:
    return _match_color(q)


def _ext_plate(q: str, question: str, spec: dict) -> str | None:
    m = PLATE_RE.search(question)
    return m.group(1).upper() if m else None


def _ext_brand(q: str, question: str, spec: dict) -> str | None:
    return _extract_brand_keyword(q)  # już canonical UPPER (8.h.13)


def _ext_search_kw(q: str, question: str, spec: dict) -> str | None:
    return _extract_search_keyword(q)


def _ext_ocr_text(q: str, question: str, spec: dict) -> str | None:
    """Fraza do wyszukania w napisach OCR wizji (2026-08-15).

    Źródła (w kolejności): tekst w cudzysłowie, potem 1-3 słowa po
    „napis(em/ie)"/„logo". Ogonek miejsca („na koszulce", „na aucie")
    ucinamy — to opis sceny, nie treść napisu. Bierzemy ORYGINALNE
    pytanie: LIKE i tak ignoruje wielkość liter, a echo w odpowiedzi
    ładniej wygląda z zachowanym zapisem usera („SOLID", nie „solid")."""
    m = re.search(r'["„\'»]([^"”\'«»]{2,40})["”\'«»]', question)
    if m:
        return m.group(1).strip() or None
    m = re.search(
        r"(?:napis\w*|logo|logiem)\s+(?:z\s+)?"
        r"([A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż\-]{2,25}"
        r"(?:\s+[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż\-]{2,25}){0,2})",
        question,
    )
    if not m:
        return None
    text = m.group(1).strip().rstrip("?.!,")
    text = re.sub(r"\s+(?:na|w|przy|obok)\s+\S+$", "", text).strip()
    return text or None


def _ext_car_make(q: str, question: str, spec: dict) -> str | None:
    return _match_car_make(q)  # canonical (Toyota/Mercedes/…) albo None


def _ext_limit(q: str, question: str, spec: dict) -> int:
    m = re.search(r"\b(\d+)\b", q)
    default = int(spec.get("default", 10))
    cap = int(spec.get("max", 50))
    return max(1, min(int(m.group(1)), cap)) if m else default


# 2026-08-19 — opis pojazdu (kolor+typ) po VLM. Mapowanie potoczne jak
# w wyszukiwarce panelu Wizji (store.service.ts): „bus" = też van dostawczy.
# Klucz = stem (dopasowanie prefiksem — łapie odmiany: busa, ciężarówki),
# wartość = (kind_a, kind_b) do SQL IN (?, ?) — pojedynczy kind zdublowany.
_VLM_KIND_STEMS: list[tuple[str, tuple[str, str]]] = [
    ("autobus",  ("bus", "bus")),
    ("bus",      ("bus", "dostawczy")),
    ("van",      ("dostawczy", "bus")),
    ("dostawcz", ("dostawczy", "dostawczy")),
    ("ciezarowk", ("ciezarowka", "ciezarowka")),
    ("tir",      ("ciezarowka", "ciezarowka")),
    ("maszyn",   ("maszyna", "maszyna")),
    ("kopark",   ("maszyna", "maszyna")),
    ("traktor",  ("maszyna", "maszyna")),
]
# Dla tool-callingu / source w registry: keyword → kanoniczny kind.
VLM_KIND_MAP: dict[str, str] = {stem: kinds[0] for stem, kinds in _VLM_KIND_STEMS}

# Kolor VLM: kanoniczny (bez diakrytyków) → (prefiks_a, prefiks_b) do
# LIKE 'x%' — VLM zapisuje zwykle „bialy", ale bywa „biały".
_VLM_COLOR_PREFIXES: dict[str, tuple[str, str]] = {
    "bialy": ("bial", "biał"), "czarny": ("czarn", "czarn"),
    "czerwony": ("czerwon", "czerwon"), "niebieski": ("niebiesk", "niebiesk"),
    "zielony": ("zielon", "zielon"), "zolty": ("zolt", "żółt"),
    "szary": ("szar", "szar"), "srebrny": ("srebrn", "srebrn"),
    "brazowy": ("brazow", "brązow"), "granatowy": ("granatow", "granatow"),
    "bezowy": ("bezow", "beżow"), "pomaranczowy": ("pomarancz", "pomarańcz"),
    "fioletowy": ("fioletow", "fioletow"), "zloty": ("zlot", "złot"),
    "bordowy": ("bordow", "bordow"),
}
VLM_COLORS = set(_VLM_COLOR_PREFIXES)

_VLM_DEACCENT = str.maketrans("ąćęłńóśżź", "acelnoszz")


def _ext_vlm_kind(q: str, question: str, spec: dict) -> str | None:
    plain = q.translate(_VLM_DEACCENT)
    for stem, kinds in _VLM_KIND_STEMS:
        if re.search(rf"\b{stem}", plain):
            return kinds[0]
    return None


def _ext_vlm_color(q: str, question: str, spec: dict) -> str | None:
    plain = q.translate(_VLM_DEACCENT)
    for canon, (prefix_a, _b) in _VLM_COLOR_PREFIXES.items():
        if prefix_a in plain:
            return canon
    return None


def _ext_waste_category(q: str, question: str, spec: dict) -> str | None:
    """waste_pickup_status — opcjonalna frakcja („czy zabrali już PAPIER?")."""
    m = _extract_waste_keyword(q)
    return m[1] if m else None


# 2026-08-15 — Event Intelligence §16: słowa-klucze pojazdów uprzywilejowanych.
# Klucz = kind do SQL (grupy aliasów OCR w template), wartość = regex pytania.
_EMERGENCY_KIND_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("ambulans", re.compile(r"karetk\w*|ambulans\w*|pogotowi\w*|ratownic\w*")),
    ("policja",  re.compile(r"policj\w*|radiow[oó]z\w*|radiowoz\w*")),
    ("straz",    re.compile(r"stra[żz]\w*\s*po[żz]arn\w*|stra[żz]ack\w*|wóz\s+stra[żz]\w*|woz\s+straz\w*")),
]


def _ext_emergency_kind(q: str, question: str, spec: dict) -> str | None:
    for kind, rx in _EMERGENCY_KIND_PATTERNS:
        if rx.search(q):
            return kind
    return None


# ── Temporal Query Engine (Event Intelligence §4, 2026-08-15) ────────────────
# Normalizacja wyrażeń czasowych PL do okna [since_ms, until_ms) w epoce ms,
# liczonego w CZASIE LOKALNYM Edge (ta sama strefa co 'localtime' w sqlite).
# Zwraca też etykietę PL do odpowiedzi („wczoraj wieczorem" zamiast
# „w ostatnich 48 godzinach"). Brak wyrażenia → (None, None, None) i template
# używa swojego okna domyślnego (COALESCE w SQL).

_WEEKDAYS_PL = {
    "poniedzia": 0, "wtorku": 1, "wtorek": 1, "srody": 2, "środy": 2,
    "czwartku": 3, "czwartek": 3, "piatku": 4, "piątku": 4, "piatek": 4,
    "piątek": 4, "soboty": 5, "sobote": 5, "sobotę": 5, "niedzieli": 6,
    "niedziele": 6, "niedzielę": 6,
}

# Pory dnia: (start_h, end_h, label). end_h > 24 = przechodzi przez północ.
_DAYPARTS: list[tuple[re.Pattern[str], int, int, str]] = [
    (re.compile(r"\brano\b|\bz\s+rana\b|porann\w*|przed\s+po[lł]udniem"), 5, 12, "rano"),
    (re.compile(r"po\s+po[lł]udniu|popo[lł]udni\w*"), 12, 18, "po południu"),
    (re.compile(r"wieczor\w*|wiecz[oó]r"), 17, 24, "wieczorem"),
    (re.compile(r"w\s+nocy|\bnoc[aą]\b"), 21, 30, "w nocy"),  # 21:00 → 06:00
]


# Daty kalendarzowe (2026-08-20, zgłoszenie: „podaj dokładne godziny dla
# frisco 17 sierpnia" → 0 wyników, bo okno spadało do domyślnego „dziś").
# Miesiące po stemie dopełniacza — „17 sierpnia", „3 maja" itd.
_MONTH_STEMS_PL: list[tuple[str, int]] = [
    ("styczni", 1), ("luteg", 2), ("lutym", 2), ("marc", 3), ("kwietni", 4),
    ("maj", 5), ("czerwc", 6), ("lipc", 7), ("sierpni", 8), ("wrzesni", 9),
    ("wrześni", 9), ("pazdziernik", 10), ("październik", 10),
    ("listopad", 11), ("grudni", 12),
]
_DATE_WORDS_RE = re.compile(
    r"\b(\d{1,2})\s+(styczni\w*|luteg\w*|lutym|marc\w*|kwietni\w*|maja?\b|"
    r"czerwc\w*|lipc\w*|sierpni\w*|wrze[sś]ni\w*|pa[zź]dziernik\w*|"
    r"listopad\w*|grudni\w*)(?:\s+(\d{4}))?",
)
_DATE_NUMERIC_RE = re.compile(r"\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b")

# Zakresy godzin liczbowe (2026-08-24, zgłoszenie BA VN: „między 1 a 6 rano"
# spadało do pory dnia „rano" 5–12 albo całego dnia). Formy: „między/od 1 a/i/
# do 6", opcjonalne „godziną/godz.", minuty po : lub ., kwalifikator pory dnia
# („między 5 a 7 wieczorem" = 17–19). Jednostronne „po/przed" wymagają słowa
# „godz…" ALBO pory dnia zaraz po liczbie — inaczej łapałyby daty i ilości.
_MONTH_STEM_TAIL_RE = re.compile(
    r"\s*(?:styczni|luteg|lutym|marc|kwietni|maj|czerwc|lipc|sierpni|"
    r"wrze[sś]ni|pa[zź]dziernik|listopad|grudni|dni\b|dnia\b|tygod|miesi|minut|lat\b)"
)
_HOUR_RANGE_RE = re.compile(
    r"(?:mi[eę]dzy|pomi[eę]dzy|od)\s+(?:godz(?:in\w*)?\.?\s*)?"
    r"(\d{1,2})(?:[:.](\d{2}))?"
    r"(?:\s+(?:a|i|do)\s+|\s*[-–]\s*)(?:godz(?:in\w*)?\.?\s*)?"
    r"(\d{1,2})(?:[:.](\d{2}))?"
)
_HOUR_AFTER_RE = re.compile(
    r"po\s+godz(?:in\w*)?\.?\s*(\d{1,2})(?:[:.](\d{2}))?"
    r"|po\s+(\d{1,2})(?:[:.](\d{2}))?\s*(?:rano|wieczorem|w\s+nocy)"
)
_HOUR_BEFORE_RE = re.compile(
    r"przed\s+godz(?:in\w*)?\.?\s*(\d{1,2})(?:[:.](\d{2}))?"
    r"|przed\s+(\d{1,2})(?:[:.](\d{2}))?\s*(?:rano|wieczorem|w\s+nocy)"
)


def compute_time_window(q: str) -> tuple[int | None, int | None, str | None]:
    from datetime import datetime, timedelta

    now = datetime.now()
    sod = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_start: Any = None
    day_end: Any = None
    label: str | None = None

    def _calendar_day(day: int, month: int, year: int | None) -> None:
        nonlocal day_start, day_end, label
        y = year if year and year > 100 else (2000 + year if year else now.year)
        try:
            d = datetime(y, month, day)
        except ValueError:
            return
        # Bez roku i data w przyszłości → chodziło o poprzedni rok.
        if year is None and d > now:
            d = datetime(y - 1, month, day)
        day_start, day_end = d, d + timedelta(days=1)
        label = d.strftime("%-d.%m") if d.year == now.year else d.strftime("%-d.%m.%Y")

    if m := _DATE_WORDS_RE.search(q):
        month_word = m.group(2)
        month = next((num for stem, num in _MONTH_STEMS_PL if month_word.startswith(stem)), None)
        if month:
            _calendar_day(int(m.group(1)), month, int(m.group(3)) if m.group(3) else None)
    if day_start is None and (m := _DATE_NUMERIC_RE.search(q)):
        mo = int(m.group(2))
        if 1 <= mo <= 12:
            _calendar_day(int(m.group(1)), mo, int(m.group(3)) if m.group(3) else None)

    if day_start is not None:
        pass  # data kalendarzowa wygrywa z wczoraj/tygodniem
    elif re.search(r"\bprzedwczoraj", q):
        day_start, day_end, label = sod - timedelta(days=2), sod - timedelta(days=1), "przedwczoraj"
    elif re.search(r"\bwczoraj", q):
        day_start, day_end, label = sod - timedelta(days=1), sod, "wczoraj"
    elif re.search(r"w\s+(?:zesz[lł]|ubieg[lł]|poprzedni)\w*\s+tygodni", q):
        prev_mon = sod - timedelta(days=sod.weekday() + 7)
        day_start, day_end, label = prev_mon, prev_mon + timedelta(days=7), "w zeszłym tygodniu"
    elif re.search(r"w\s+tym\s+tygodniu", q):
        day_start, label = sod - timedelta(days=sod.weekday()), "w tym tygodniu"
    elif m := re.search(
        r"\bod\s+(poniedzia[lł]\w*|wtorku|[sś]rody|czwartku|pi[aą]tku|soboty|niedzieli)", q,
    ):
        name = m.group(1).replace("ł", "l").replace("ś", "s").replace("ą", "a")
        target = next((v for k, v in _WEEKDAYS_PL.items()
                       if name.startswith(k.replace("ł", "l").replace("ś", "s").replace("ą", "a"))), None)
        if target is not None:
            back = (sod.weekday() - target) % 7 or 7  # ostatni MINIONY taki dzień
            day_start, label = sod - timedelta(days=back), f"od {m.group(1)}"
    elif m := re.search(r"(?:w\s+ci[aą]gu\s+)?ostatnich?\s+(\d{1,2})\s+dni", q):
        n = max(1, min(int(m.group(1)), 90))
        day_start, label = sod - timedelta(days=n - 1), f"w ostatnich {n} dniach"

    # Zakres godzin liczbowy — wygrywa z porą dnia („między 1 a 6 rano" =
    # 01:00–06:00, NIE 5–12). Pomijany przy oknach otwartych (tydzień).
    hour_range: tuple[int, int, int, int, str] | None = None
    if not (day_start is not None and day_end is None):
        evening = bool(re.search(r"wieczor|po\s+po[lł]udniu|popo[lł]udni", q))

        def _pm(h: int) -> int:
            return h + 12 if evening and 1 <= h < 12 else h

        if m := _HOUR_RANGE_RE.search(q):
            # „między 1 a 6 sierpnia" / „od 2 do 5 dni" = NIE godziny.
            if not _MONTH_STEM_TAIL_RE.match(q[m.end():]):
                h1, m1 = _pm(int(m.group(1))), int(m.group(2) or 0)
                h2, m2 = _pm(int(m.group(3))), int(m.group(4) or 0)
                if h1 <= 23 and h2 <= 24 and m1 <= 59 and m2 <= 59:
                    hour_range = (h1, m1, h2, m2,
                                  f"między {h1 % 24:02d}:{m1:02d} a {h2 % 24:02d}:{m2:02d}")
        elif m := _HOUR_AFTER_RE.search(q):
            if not _MONTH_STEM_TAIL_RE.match(q[m.end():]):
                h1 = _pm(int(m.group(1) or m.group(3)))
                m1 = int(m.group(2) or m.group(4) or 0)
                if h1 <= 23 and m1 <= 59:
                    hour_range = (h1, m1, 24, 0, f"po {h1:02d}:{m1:02d}")
        elif m := _HOUR_BEFORE_RE.search(q):
            if not _MONTH_STEM_TAIL_RE.match(q[m.end():]):
                h2 = _pm(int(m.group(1) or m.group(3)))
                m2 = int(m.group(2) or m.group(4) or 0)
                if h2 <= 24 and m2 <= 59:
                    hour_range = (0, 0, h2, m2, f"przed {h2 % 24:02d}:{m2:02d}")

    if hour_range is not None:
        h1, m1, h2, m2, rng = hour_range
        base = day_start if day_start is not None else sod
        start = base + timedelta(hours=h1, minutes=m1)
        end = base + timedelta(hours=h2, minutes=m2)
        if end <= start:
            end += timedelta(days=1)  # „między 22 a 6" przechodzi przez północ
            # Bez jawnego dnia i start w przyszłości → chodziło o ostatnią noc.
            if day_start is None and start > now:
                start -= timedelta(days=1)
                end -= timedelta(days=1)
                label = f"wczoraj {rng}"
            else:
                label = f"{label} {rng}" if label else f"dziś {rng}"
        else:
            label = f"{label} {rng}" if label else f"dziś {rng}"
        since_ms = int(start.timestamp() * 1000)
        until_ms = int(end.timestamp() * 1000)
        return (since_ms, until_ms, label)

    # Pora dnia — zawęża okno dnia (default: dziś; „w nocy" bez dnia = ostatnia
    # noc, czyli baza wczoraj). Pomijana przy oknach wielodniowych (tydzień).
    for rx, h1, h2, plabel in _DAYPARTS:
        if rx.search(q):
            if day_start is not None and day_end is None:
                break  # okno otwarte (tydzień/od poniedziałku) — pory nie łączymy
            base = day_start if day_start is not None else (
                sod - timedelta(days=1) if h2 > 24 else sod
            )
            day_start = base + timedelta(hours=h1)
            day_end = base + timedelta(hours=h2)
            label = f"{label} {plabel}" if label else (
                plabel if h2 <= 24 else "ostatniej nocy"
            )
            break

    if day_start is None:
        return (None, None, None)
    since_ms = int(day_start.timestamp() * 1000)
    until_ms = int(day_end.timestamp() * 1000) if day_end is not None else None
    return (since_ms, until_ms, label)


# Intenty których template honoruje since_ms/until_ms (COALESCE w SQL).
WINDOWED_INTENTS = {
    "count_vehicles_today", "list_vehicles_recent", "count_vehicles_by_color_today",
    "count_vehicles_by_tag_today", "courier_today", "count_gate_openings_today",
    "list_vehicles_by_color_today", "search_vehicles_today",
    "count_objects_today", "list_recent_detections", "search_by_brand_today",
    "search_by_text_today", "search_by_waste_today", "search_emergency_recent",
    "last_seen_object", "search_taxi_recent", "search_courier_recent",
}


# ── Kanonizacja OCR (Event Intelligence §15) ─────────────────────────────────
# JEDNA forma kanoniczna po OBU stronach porównania: małe litery bez polskich
# znaków, cyfry-sobowtóry → litery (0→o, 1→i, 5→s, 8→b), bez spacji i
# interpunkcji. Dzięki temu „REM0NDIS", „D H L", „inp0st." znajdują się
# deterministycznie, bez LLM. Lustro SQL-owe: sql_templates.CANON_TEXT_SQL.
_OCR_DIACRITICS = str.maketrans("ąćęłńóśżźĄĆĘŁŃÓŚŻŹ", "acelnoszzacelnoszz")
_OCR_DIGIT_SUBS = str.maketrans({"0": "o", "1": "i", "5": "s", "8": "b"})


def canonical_ocr(text: str) -> str:
    t = text.translate(_OCR_DIACRITICS).lower().translate(_OCR_DIGIT_SUBS)
    return re.sub(r"[ .\-_,:]", "", t)


_EXTRACTORS: dict[str, Any] = {
    "range_hours": _ext_range_hours,
    "range_hours_brand": _ext_range_hours_brand,
    "range_hours_rare": _ext_range_hours_rare,
    "direction": _ext_direction,
    "color": _ext_color,
    "plate": _ext_plate,
    "brand": _ext_brand,
    "search_keyword": _ext_search_kw,
    "ocr_text": _ext_ocr_text,
    "car_make": _ext_car_make,
    "limit": _ext_limit,
    "waste_category": _ext_waste_category,
    "emergency_kind": _ext_emergency_kind,
    "vlm_kind": _ext_vlm_kind,
    "vlm_color": _ext_vlm_color,
}

# ── Guardy — predykat (q, question) → bool; False = reguła pominięta ─────────

_GUARDS: dict[str, Any] = {
    # Pytanie z tablicą rejestracyjną NIE jest brand-query — user pyta
    # o konkretny pojazd → przepuszczamy do plate-intents niżej w kaskadzie.
    "no_plate": lambda q, question: not PLATE_RE.search(question),
    # 8.h.30: pytanie z KONKRETNĄ marką ("kurier z DHL") → search_by_brand_today
    # niżej w kaskadzie, nie generyczny agregat kurierski.
    "no_brand": lambda q, question: _extract_brand_keyword(q) is None,
}

# ── Custom matchery — sygnatura (q, question, rule) → result dict | None ─────

def _match_knowledge_rule(q: str, question: str, rule: Any) -> dict | None:
    """search_knowledge_base — substring triggers + opcjonalny type hint.

    WAŻNE: query = `question` (oryginalny case), NIE `q` — bge-m3 lepiej
    trafia w polskie nazwy własne / paragrafy z capitalization.

    8.h.31: obok substring-triggerów też KNOWLEDGE_TRIGGER_REGEXES —
    rodzina „kontakt/serwis/naprawa/awaria" („namiar do…", „kto naprawi
    piec gazowy", „awaria ogrzewania")."""
    triggered = any(kw in q for kw in KNOWLEDGE_TRIGGER_KEYWORDS) or any(
        rx.search(q) for rx in KNOWLEDGE_TRIGGER_REGEXES
    )
    if not triggered:
        return None
    kb_params: dict[str, Any] = {"query": question.strip()}
    kb_type = _detect_knowledge_type(q)
    if kb_type:
        kb_params["type"] = kb_type
    return {"intent": rule.intent, "parameters": kb_params}


def _match_activity_rule(q: str, question: str, rule: Any) -> dict | None:
    """recent_activity_summary — strong triggers ("ciekaw"/"podsum"/"raport")
    same; słabsze ("co się działo") wymagają sygnału czasowego."""
    if not _looks_like_activity_summary(q):
        return None
    default = int((rule.params.get("range_hours") or {}).get("default", 4))
    return {
        "intent": rule.intent,
        "parameters": {"range_hours": _extract_range_hours(q, default=default)},
    }


def _match_count_objects_rule(q: str, question: str, rule: Any) -> dict | None:
    """count_objects_today — YOLO vision count. Guardy:
      • plate w pytaniu → user pyta o konkretną tablicę (LPR) — skip,
      • klasa "car" bez "kamera/widzia*" → LPR-side count_vehicles — skip."""
    vision_class = _match_vision_object(q)
    if not vision_class:
        return None
    if not re.search(r"\b(ile|how many|czy|by[lł]\w*|were there)\b", q):
        return None
    # 8.h.32: „Ilu mieszkańców / ile osób MIESZKA na osiedlu" to pytanie
    # o dane Cloud (Postgres), nie o licznik person z kamer — Edge NIE może
    # go połknąć (Cloud odpowiada w cloud-local, tu ma wyjść unknown).
    # Celowo NIE matchuje „mieszkaniu/mieszkanie" (lokal w innych pytaniach).
    if re.search(r"\bmieszka\b|\bmieszkaj[aą]\w*|\bmieszka[nń]c\w*|\bzamieszk\w*", q):
        return None
    if PLATE_RE.search(question):
        return None
    # 8.h.32: pytanie o markę fabryczną („ile samochodów marki Toyota")
    # → search_by_vehicle_make (LPR whitelist), nie licznik klasy `car`.
    if _match_car_make(q):
        return None
    has_camera_phrasing = bool(re.search(r"kamer\w*|widzia[lł]\w*|monitoring", q))
    if vision_class == "car" and not has_camera_phrasing:
        return None
    return {
        "intent": rule.intent,
        "parameters": {
            "object_class": vision_class,
            "range_hours": _extract_range_hours(q, default=24),
        },
    }


def _match_waste_rule(q: str, question: str, rule: Any) -> dict | None:
    """search_by_waste_today — HISTORIA odbiorów (vision). MUSI być przed
    kolorami („ZIELONE"=BIO) i brandem („papier" > brand) — patrz priority
    w YAML. Generic match (śmieciarka/odbiór) = bez category.

    FAZA 8.h.29 — okno: odbiory frakcji zdarzają się co 2-4 tygodnie
    (harmonogram: papier ~miesięcznie), więc „kiedy ostatnio…" bez explicit
    okna dostaje 720h (30 dni), nie 168h — inaczej „nie było" byłoby
    fałszywe dla frakcji odbieranej 3 tygodnie temu."""
    waste_match = _extract_waste_keyword(q)
    if waste_match is None:
        return None
    _kw, category = waste_match
    params: dict[str, Any] = {
        "range_hours": _rare_event_range_hours(q, default=24, floor=720),
    }
    if category is not None:
        params["category"] = category
    return {"intent": rule.intent, "parameters": params}


def _match_object_sighting_rule(q: str, question: str, rule: Any) -> dict | None:
    """last_seen_object (FAZA 8.h.29) — „czy widziałeś kota?", „kiedy
    ostatnio był pies?". Rodzina HISTORIA klas YOLO: odpowiedź = ostatnie
    wystąpienie + liczba klatek w długim oknie (720h default).

    Guardy:
      • „ile/how many" → count_objects_today (licznik, priorytet niżej),
      • brand keyword (DHL/Uber/…) → search_by_brand_today (to nie klasa COCO),
      • tablica w pytaniu → plate-intents (guard no_plate w YAML),
      • klasa "car" bez camera-phrasing → LPR-side (spójnie z count_objects).
    Pseudo-klasa `animal` („zwierzę/zwierzak") agreguje cat+dog — rozwijana
    w validate() na 2 placeholdery SQL."""
    if re.search(r"\b(?:ile|how many)\b", q):
        return None
    if not re.search(r"widzia[lł]\w*|kiedy\s+ostatnio|\bostatnio\b|kiedy\s+by[lł]\w*", q):
        return None
    if _extract_brand_keyword(q):
        return None
    # 8.h.32: „samochód MARKI Toyota" to pytanie o markę fabryczną (LPR
    # whitelist), nie o klasę COCO `car` z kamer → search_by_vehicle_make.
    if _match_car_make(q):
        return None
    if re.search(r"zwierz\w*", q):
        vision_class = "animal"
    else:
        vision_class = _match_vision_object(q)
    if not vision_class:
        return None
    if vision_class == "car" and not re.search(r"kamer\w*|widzia[lł]\w*|monitoring", q):
        return None
    return {
        "intent": rule.intent,
        "parameters": {
            "object_class": vision_class,
            "range_hours": _rare_event_range_hours(q, default=168, floor=720),
        },
    }


def _match_tag_count_rule(q: str, question: str, rule: Any) -> dict | None:
    """count_vehicles_by_tag_today — "ile aut z tagiem X". Special-case:
    tag dostawa/kurier → courier_today (Edge ma vehicle_kind=DELIVERY/SERVICE,
    nie tag="dostawa")."""
    if not re.search(r"\b(ile|how many)\b", q):
        return None
    if not re.search(r"tag\w*|z tagiem|with tag", q):
        return None
    tag_canon = _match_tag(q)
    if not tag_canon:
        return None
    params: dict[str, Any] = {}
    if tag_canon not in ("dostawa", "kurier"):
        params["tag"] = tag_canon
    direction = _extract_direction(q)
    if direction:
        params["direction"] = direction
    intent = "courier_today" if tag_canon in ("dostawa", "kurier") else rule.intent
    return {"intent": intent, "parameters": params}


def _match_courier_rule(q: str, question: str, rule: Any) -> dict | None:
    """courier_today — "dostawa/kurier" + question-word. Guardy:
      • "tag" w pytaniu → count_vehicles_by_tag_today (wyżej w kaskadzie),
      • SEARCH_KEYWORD w pytaniu ("dostawa sushi") → search_vehicles_today
        (EVAL 2026-06-11 — spójnie z przykładem w LLM_SYSTEM_PROMPT),
      • brandy (DHL/Allegro) złapał już brand-check wyżej."""
    if not (
        re.search(r"dostaw\w*|kurier\w*|courier|delivery", q)
        and re.search(r"czy|by[lł]\w*|jak\w*|\?", q)
    ):
        return None
    if re.search(r"tag\w*", q):
        return None
    if _extract_search_keyword(q):
        return None
    params: dict[str, Any] = {}
    direction = _extract_direction(q)
    if direction:
        params["direction"] = direction
    return {"intent": rule.intent, "parameters": params}


_MATCHERS: dict[str, Any] = {
    "knowledge_base": _match_knowledge_rule,
    "activity_summary": _match_activity_rule,
    "count_objects": _match_count_objects_rule,
    "object_sighting": _match_object_sighting_rule,
    "waste": _match_waste_rule,
    "tag_count": _match_tag_count_rule,
    "courier_question": _match_courier_rule,
}


def _generic_match(q: str, question: str, rule: Any) -> dict | None:
    """Deklaratywna reguła: patterns (OR) / patterns_all (AND) /
    not_patterns (NONE) + parametry przez extractory. Required param
    bez wartości = reguła nie matchuje (np. color/plate/keyword)."""
    if rule.patterns and not any(p.search(q) for p in rule.patterns):
        return None
    for pattern in rule.patterns_all:
        if not pattern.search(q):
            return None
    for pattern in rule.not_patterns:
        if pattern.search(q):
            return None
    params: dict[str, Any] = {}
    for name, spec in rule.params.items():
        spec = spec or {}
        extractor_name = spec.get("extractor")
        if not extractor_name:
            if spec.get("required"):
                # Generic matcher nie umie wyprodukować wartości bez
                # extractora — taki param obsługuje custom matcher.
                return None
            continue
        value = _EXTRACTORS[extractor_name](q, question, spec)
        if value is None:
            if spec.get("required"):
                return None
            continue
        params[name] = value
    return {"intent": rule.intent, "parameters": params}


def _build_rules() -> list:
    """Ładuje rejestr + fail-fast walidacja referencji (import-time, nie
    per-request): intent w VALID_INTENTS, matcher/guard/extractor istnieją."""
    from intent_registry import load_registry
    rules = load_registry()
    for rule in rules:
        if rule.intent not in VALID_INTENTS:
            raise ValueError(f"intents_registry: {rule.key} → nieznany intent {rule.intent!r}")
        if rule.matcher not in ("generic", "none") and rule.matcher not in _MATCHERS:
            raise ValueError(f"intents_registry: {rule.key} → nieznany matcher {rule.matcher!r}")
        if rule.guard and rule.guard not in _GUARDS:
            raise ValueError(f"intents_registry: {rule.key} → nieznany guard {rule.guard!r}")
        for pname, spec in rule.params.items():
            extractor_name = (spec or {}).get("extractor")
            if extractor_name and extractor_name not in _EXTRACTORS:
                raise ValueError(
                    f"intents_registry: {rule.key}.{pname} → nieznany extractor {extractor_name!r}"
                )
    return rules


_RULES = _build_rules()


def classify_regex(question: str) -> dict | None:
    """Zwraca dict z intencją albo None gdy nic nie matchnęło (→ LLM fallback).

    Pętla po regułach z `intents_registry.yaml` posortowanych po priority
    (niższy = wcześniej). Pierwszy match wygrywa — dokładnie jak dawna
    kaskada if-ów, ale kolejność jest deklaratywna zamiast pozycyjnej."""
    q = question.lower().strip()
    for rule in _RULES:
        if rule.matcher == "none":
            continue
        if rule.guard and not _GUARDS[rule.guard](q, question):
            continue
        if rule.matcher == "generic":
            result = _generic_match(q, question, rule)
        else:
            result = _MATCHERS[rule.matcher](q, question, rule)
        if result is not None:
            # §4 (temporal engine, 2026-08-15): explicit okno czasowe z pytania
            # („wczoraj", „w tym tygodniu", „rano") dokładane do KAŻDEGO
            # trafienia. validate() przepuszcza je tylko dla WINDOWED_INTENTS.
            since_ms, until_ms, window_label = compute_time_window(q)
            if since_ms is not None:
                params = result.setdefault("parameters", {})
                params.setdefault("since_ms", since_ms)
                params.setdefault("until_ms", until_ms)
                params.setdefault("window_label", window_label)
            return result
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — LLM fallback (Ollama JSON mode, temperature=0)
# ─────────────────────────────────────────────────────────────────────────────

LLM_SYSTEM_PROMPT = """Jesteś klasyfikatorem intencji dla GateLynk AI.
Zwracasz WYŁĄCZNIE JSON. Bez wstępu, komentarza, markdown, code-fences.

Dozwolone intencje:
- count_vehicles_today              parametry: direction (opcjonalny)
- list_vehicles_recent              parametry: direction (opcjonalny) — gdy "jakie/które
                                     samochody wjechały/pojawiły się" (lista aut, nie licznik,
                                     bez koloru/tagu/marki)
- count_vehicles_by_color_today     parametry: color (wymagany), direction (opcjonalny)
- count_vehicles_by_tag_today       parametry: tag (wymagany), direction (opcjonalny)
- courier_today                     parametry: direction (opcjonalny)
- vehicle_history_by_plate          parametry: plate (wymagany)
- last_seen_plate                   parametry: plate (wymagany)
- vehicle_owner_by_plate            parametry: plate (wymagany) — "do kogo należy X", "czyj jest X", "kto jest właścicielem X"
- count_gate_openings_today         parametry: direction (opcjonalny) — gdy pytanie o "ile bram", "ile otwarć"
- list_vehicles_by_color_today      parametry: color (wymagany), direction (opcjonalny) — gdy "jakie/które X kolor", lista zamiast count
- count_visits_by_plate             parametry: plate (wymagany) — "ile razy był X"
- search_vehicles_today             parametry: keyword (string, wymagany), direction (opcjonalny) —
                                     gdy pyta o firmę/usługę nie pasującą do tag enum: taxi, sushi,
                                     uber, glovo, kimi, frisco, dhl, dpd, restauracja, ogrodnicy itp.
                                     KEYWORD = pojedyncze słowo dotyczące nazwy firmy.
- list_unmatched_plates             parametry: limit (int, 1-20, default 5), range_hours (int, default 24) —
                                     "pokaż nieznane tablice" / "ostatnie unmatched"
- list_errors_recent                parametry: range_hours (int, default 1) — "jakieś błędy / co się zepsuło"
- count_errors_recent               parametry: range_hours (int, default 1) — "ile błędów"
- list_devices                      parametry: {} — "jakie urządzenia podłączone"
- count_objects_today               parametry: object_class (wymagany, COCO), range_hours (int, default 24) —
                                     "ile osób / psów / kotów / rowerów … dziś / w godzinie"
                                     (YOLO vision count, niezależne od LPR)
- list_recent_detections            parametry: range_hours (int, default 1), limit (int, default 10) —
                                     "co widziała kamera ostatnio / w godzinie"
- search_by_brand_today             parametry: brand (wymagany, UPPERCASE z whitelisty),
                                     range_hours (int, default 24) — gdy user pyta
                                     o widziane na kamerze logo kuriera/usługi:
                                     "czy widziałeś dziś DHL", "pokaż wszystkie InPost dzisiaj",
                                     "kiedy ostatnio kamera widziała DPD".
                                     UWAGA: tylko gdy phrasing kamerowy ("widzia*", "kamera",
                                     "rozpoznał"). Inaczej → search_vehicles_today (LPR-side).
                                     brand z listy: DHL | DPD | INPOST | FEDEX | GLS | UPS |
                                     POCZTA | POCZTEX | ALLEGRO | DACHSER | GLOVO | WOLT |
                                     UBER | BOLT | PYSZNE.
- search_by_waste_today             parametry: category (OPCJONALNY: GLASS|PAPER|PLASTIC|BIO|MIXED),
                                     range_hours (int, default 24) — gdy user pyta
                                     o odbiór odpadów / śmieciarkę / konkretną frakcję:
                                     "czy odebrali dziś szkło?", "kiedy ostatnio papier?",
                                     "ile razy w tygodniu śmieciarka?", "była dziś śmieciarka?".
                                     Mapowanie PL → category:
                                       szkło/szkła                       → GLASS
                                       papier/makulatura/tektura         → PAPER
                                       plastik/tworzywa/metale           → PLASTIC
                                       bio/biodegradowalne/zielone       → BIO
                                       zmieszane/komunalne               → MIXED
                                       śmieciarka/odbiór (bez frakcji)   → pomiń category
                                     „ostatnio"/„czy widziałeś śmieciarkę" bez
                                     okna → range_hours=720 (odbiory są rzadkie).
- last_seen_object                  parametry: object_class (wymagany: COCO albo
                                     "animal" = kot|pies), range_hours (int,
                                     default 168; "ostatnio"/"czy widziałeś" → 720) —
                                     HISTORIA klasy obiektów z kamer: "czy
                                     widziałeś kota?", "kiedy ostatnio był pies?",
                                     "czy widziałeś jakieś zwierzę?" (→ animal).
                                     Odpowiedź = ostatnie wystąpienie + liczba
                                     klatek. RÓŻNICA od count_objects_today:
                                     tam "ile X?" (licznik), tu "czy/kiedy
                                     widziałeś X?" (ostatnie wystąpienie).
- search_taxi_recent                parametry: range_hours (int, default 24;
                                     "ostatnio" → 720) — pytania o taksówkę
                                     (taksówka/taxi/taryfa): agregat detekcji
                                     UBER/BOLT/napisu TAXI z kamer.
                                     "Kiedy ostatnio była taksówka?".
- search_courier_recent             parametry: range_hours (int, default 168;
                                     "dziś" → 24, "ostatnio"/"inny" → 720) —
                                     GENERYCZNE pytania o kuriera BEZ konkretnej
                                     marki: "czy był dziś jakiś kurier?",
                                     "jaki kurier ostatnio przyjeżdżał?",
                                     "a jakiegoś innego kuriera?". Agregat
                                     marek kurierskich (DHL/DPD/GLS/UPS/InPost/
                                     FedEx/Poczta) z kamer + kurierzy z białej
                                     listy LPR. RÓŻNICA: konkretna marka
                                     ("kurier z DHL") → search_by_brand_today;
                                     proste "czy był dziś kurier" → courier_today.
- recent_activity_summary           parametry: range_hours (int, default 4) —
                                     gdy user pyta o multi-aggregate raport
                                     z ostatnich N godzin: „co ciekawego",
                                     „co się działo w ostatniej godzinie",
                                     „podsumowanie ostatnich 4 godzin",
                                     „raport za dobę".
                                     range_hours: 1 (godzina), 4 (4h), 12 (12h),
                                     24 (doba/dziś/dzień), 168 (tydzień).
                                     ROZRÓŻNIENIE od list_recent_detections:
                                     activity_summary = wszystko (LPR+vision),
                                     list_recent_detections = tylko vision YOLO.
- search_by_vehicle_make            parametry: make (wymagany, canonical:
                                     Toyota | Mercedes | BMW | Audi | Volkswagen |
                                     Skoda | Ford | Opel | Kia | Hyundai | Renault |
                                     Peugeot | Citroen | Mazda | Honda | Nissan |
                                     Volvo | Seat | Fiat | Dacia | Tesla | Lexus |
                                     Suzuki | Mitsubishi | Jeep | Porsche |
                                     Land Rover | Mini | Smart | Iveco | MAN | Scania),
                                     range_hours (int, default 24; "czy widziałeś"
                                     bez okna → 720) — pytania o MARKĘ FABRYCZNĄ
                                     samochodu: "Ile Mercedesów widziałeś w 12
                                     godzinach?", "Czy widziałeś jakąś Toyotę?",
                                     "Czy wjechało dziś BMW?". Źródło: biała
                                     lista (tagi zawierają markę) + odczyty LPR.
                                     RÓŻNICA od search_by_brand_today: tam firmy/
                                     kurierzy (DHL/FRISCO — napisy z kamer),
                                     tu marki fabryczne pojazdów.
- search_knowledge_base             parametry: query (wymagany, FULL pełna treść
                                     pytania użytkownika), type (opcjonalny:
                                     MESSENGER_CHAT | UCHWALA | REGULAMIN | KONTAKT | INNE) —
                                     gdy user pyta o treść dokumentów wgranych
                                     w bazie wiedzy budynku (uchwały, regulaminy,
                                     harmonogramy odbioru śmieci, kontakty do
                                     dostawców/hydraulika/serwisantów, archiwum
                                     Messenger chats sąsiedzkich).
                                     Mapping triggers:
                                       "co mówi uchwała o X"           → type=UCHWALA
                                       "co pisze regulamin o Y"        → type=REGULAMIN
                                       "kiedy odbierają plastik"       → type=INNE
                                       "numer do hydraulika"           → type=KONTAKT
                                       "namiar do/na X"                → type=KONTAKT
                                       "potrzebuję hydraulika/elektryka" → type=KONTAKT
                                       "kto naprawi piec/bramę/windę"  → BEZ type
                                       "awaria ogrzewania, gdzie zgłosić" → BEZ type
                                       "co pisali sąsiedzi"            → type=MESSENGER_CHAT
                                       "§ 12"                          → type=UCHWALA lub REGULAMIN
                                       "harmonogram"                   → type=INNE
                                     query MUSI być pełną oryginalną treścią
                                     pytania użytkownika — semantic search bge-m3
                                     potrzebuje kontekstu, NIE pojedynczych słów.
- unknown                           parametry: {} (gdy żadna powyższa nie pasuje)

Wartości parametrów (case-sensitive, canonical):
- color: white | black | red | blue | green | yellow | silver | gray | brown | orange
- tag: dostawa | kurier | mieszkaniec | gosc | serwis
- direction: in | out
- plate: tylko WIELKIE litery i cyfry, format ABC1234 (2-3 litery + 4-5 znaków)
- object_class (COCO): person | dog | cat | bicycle | motorcycle | bus | truck |
                       backpack | handbag | suitcase | umbrella | car
  PL → object_class: "osoba/osoby/ludzi"→person, "pies/psy"→dog, "kot/koty"→cat,
  "rower"→bicycle, "motor/motocykl"→motorcycle, "autobus"→bus, "ciężarówka"→truck,
  "plecak/paczka"→backpack, "torba/torebka"→handbag, "walizka"→suitcase.

Wartości w pytaniu po polsku tłumaczysz na canonical:
"biały"→"white", "czarny"→"black", "wjechał"→"in", "wyjechał"→"out", itd.

Format odpowiedzi (zawsze ten sam):
{"intent":"<nazwa>","parameters":{...}}

Przykłady:
P: Ile białych aut dziś wjechało?
O: {"intent":"count_vehicles_by_color_today","parameters":{"color":"white","direction":"in"}}

P: Czy był dziś kurier?
O: {"intent":"courier_today","parameters":{}}

P: Kiedy ostatnio była tablica WE12345?
O: {"intent":"last_seen_plate","parameters":{"plate":"WE12345"}}

P: Ile aut z tagiem dostawa wjechało dzisiaj?
O: {"intent":"count_vehicles_by_tag_today","parameters":{"tag":"dostawa","direction":"in"}}

P: Pokaż historię tablicy WA1234X
O: {"intent":"vehicle_history_by_plate","parameters":{"plate":"WA1234X"}}

P: Ile dziś otworzyło się bram?
O: {"intent":"count_gate_openings_today","parameters":{}}

P: Jakie czerwone samochody były dziś?
O: {"intent":"list_vehicles_by_color_today","parameters":{"color":"red"}}

P: Pokaż białe samochody
O: {"intent":"list_vehicles_by_color_today","parameters":{"color":"white"}}

P: Ile razy był samochód z rejestracją WD5005P?
O: {"intent":"count_visits_by_plate","parameters":{"plate":"WD5005P"}}

P: Czy było jakieś taxi?
O: {"intent":"search_vehicles_today","parameters":{"keyword":"taxi"}}

P: Czy była dostawa sushi?
O: {"intent":"search_vehicles_today","parameters":{"keyword":"sushi"}}

P: Frisco?
O: {"intent":"search_vehicles_today","parameters":{"keyword":"frisco"}}

P: Pokaż 5 ostatnich nieznanych tablic
O: {"intent":"list_unmatched_plates","parameters":{"limit":5,"range_hours":24}}

P: Jakieś błędy w ostatniej godzinie?
O: {"intent":"list_errors_recent","parameters":{"range_hours":1}}

P: Ile błędów dzisiaj?
O: {"intent":"count_errors_recent","parameters":{"range_hours":24}}

P: Jakie urządzenia są podłączone?
O: {"intent":"list_devices","parameters":{}}

P: Ile osób dziś przeszło przez bramę?
O: {"intent":"count_objects_today","parameters":{"object_class":"person","range_hours":24}}

P: Były jakieś psy w ostatniej godzinie?
O: {"intent":"count_objects_today","parameters":{"object_class":"dog","range_hours":1}}

P: Ile rowerów widziała kamera dzisiaj?
O: {"intent":"count_objects_today","parameters":{"object_class":"bicycle","range_hours":24}}

P: Co widziała kamera ostatnio?
O: {"intent":"list_recent_detections","parameters":{"range_hours":1,"limit":10}}

P: Pokaż 5 ostatnich detekcji
O: {"intent":"list_recent_detections","parameters":{"range_hours":24,"limit":5}}

P: Czy widziałeś dziś DHL?
O: {"intent":"search_by_brand_today","parameters":{"brand":"DHL","range_hours":24}}

P: Pokaż wszystkie InPost dzisiaj
O: {"intent":"search_by_brand_today","parameters":{"brand":"INPOST","range_hours":24}}

P: Kiedy ostatnio kamera widziała DPD?
O: {"intent":"search_by_brand_today","parameters":{"brand":"DPD","range_hours":24}}

P: Czy odebrali dziś szkło?
O: {"intent":"search_by_waste_today","parameters":{"category":"GLASS","range_hours":24}}

P: Kiedy ostatnio papier?
O: {"intent":"search_by_waste_today","parameters":{"category":"PAPER","range_hours":168}}

P: Czy była dziś śmieciarka?
O: {"intent":"search_by_waste_today","parameters":{"range_hours":24}}

P: Ile razy w tygodniu odebrali plastik?
O: {"intent":"search_by_waste_today","parameters":{"category":"PLASTIC","range_hours":168}}

P: Czy ostatnio widziałeś jakąś śmieciarkę?
O: {"intent":"search_by_waste_today","parameters":{"range_hours":720}}

P: Czy widziałeś kota?
O: {"intent":"last_seen_object","parameters":{"object_class":"cat","range_hours":720}}

P: Kiedy ostatnio był pies?
O: {"intent":"last_seen_object","parameters":{"object_class":"dog","range_hours":720}}

P: Czy widziałeś jakieś zwierzę?
O: {"intent":"last_seen_object","parameters":{"object_class":"animal","range_hours":720}}

P: Kiedy ostatnio była taksówka?
O: {"intent":"search_taxi_recent","parameters":{"range_hours":720}}

P: Czy była dziś jakaś taksówka?
O: {"intent":"search_taxi_recent","parameters":{"range_hours":24}}

P: Czy był dziś jakiś kurier?
O: {"intent":"search_courier_recent","parameters":{"range_hours":24}}

P: Jaki kurier ostatnio przyjeżdżał?
O: {"intent":"search_courier_recent","parameters":{"range_hours":720}}

P: Czy był jakiś inny kurier?
O: {"intent":"search_courier_recent","parameters":{"range_hours":720}}

P: Czy była dostawa DHL? (LPR-side — bez "kamera/widzia*")
O: {"intent":"search_vehicles_today","parameters":{"keyword":"dhl"}}

P: Ile Mercedesów widziałeś w ostatnich 12 godzinach?
O: {"intent":"search_by_vehicle_make","parameters":{"make":"Mercedes","range_hours":12}}

P: A czy widziałeś jakąś Toyotę?
O: {"intent":"search_by_vehicle_make","parameters":{"make":"Toyota","range_hours":720}}

P: Czy wjechało dziś jakieś BMW?
O: {"intent":"search_by_vehicle_make","parameters":{"make":"BMW","range_hours":24}}

P: A jakakolwiek dostawa?
O: {"intent":"courier_today","parameters":{}}

P: Kiedy odbierają plastik?
O: {"intent":"search_knowledge_base","parameters":{"query":"Kiedy odbierają plastik?","type":"INNE"}}

P: Co mówi uchwała o psach?
O: {"intent":"search_knowledge_base","parameters":{"query":"Co mówi uchwała o psach?","type":"UCHWALA"}}

P: Numer telefonu do hydraulika
O: {"intent":"search_knowledge_base","parameters":{"query":"Numer telefonu do hydraulika","type":"KONTAKT"}}

P: Czy masz namiar do kogoś kto może naprawić piec gazowy?
O: {"intent":"search_knowledge_base","parameters":{"query":"Czy masz namiar do kogoś kto może naprawić piec gazowy?","type":"KONTAKT"}}

P: Kto naprawi bramę?
O: {"intent":"search_knowledge_base","parameters":{"query":"Kto naprawi bramę?"}}

P: Gdzie zgłosić awarię windy?
O: {"intent":"search_knowledge_base","parameters":{"query":"Gdzie zgłosić awarię windy?"}}

P: Co pisali sąsiedzi o hałasie?
O: {"intent":"search_knowledge_base","parameters":{"query":"Co pisali sąsiedzi o hałasie?","type":"MESSENGER_CHAT"}}

P: Co mówi regulamin o gościach?
O: {"intent":"search_knowledge_base","parameters":{"query":"Co mówi regulamin o gościach?","type":"REGULAMIN"}}

P: § 12 uchwały
O: {"intent":"search_knowledge_base","parameters":{"query":"§ 12 uchwały","type":"UCHWALA"}}

P: Co ciekawego działo się w ostatniej godzinie?
O: {"intent":"recent_activity_summary","parameters":{"range_hours":1}}

P: Podsumuj 4 ostatnie godziny
O: {"intent":"recent_activity_summary","parameters":{"range_hours":4}}

P: Co się działo w dobie?
O: {"intent":"recent_activity_summary","parameters":{"range_hours":24}}

P: Raport z ostatnich 12 godzin
O: {"intent":"recent_activity_summary","parameters":{"range_hours":12}}

P: Jaka jest pogoda?
O: {"intent":"unknown","parameters":{}}
"""


async def classify_llm(question: str) -> dict:
    """
    Wywołuje Ollama /api/chat w trybie JSON (format='json') z temperature=0.
    Zwraca dict — przy błędzie JSON parse lub HTTP zwraca intent='unknown'
    (silent fallback, nie chcemy wywalać requestu z błędem dla niezrozumiałego
    pytania).
    """
    # FAZA 8.h.11 — dynamic LLM config z Edge (Bielik / Qwen3 / etc.)
    from llm_config import get_active_llm
    llm = get_active_llm()
    payload = {
        "model": llm.model,
        "messages": [
            {"role": "system", "content": LLM_SYSTEM_PROMPT},
            {"role": "user", "content": question},
        ],
        "stream": False,
        "format": "json",  # Ollama JSON mode — model dostaje grammar mask
        "options": {
            "temperature": 0.0,
            "num_predict": 200,  # JSON jest krótki, nie trzeba więcej
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
        log.warning("Ollama call failed: %s", e)
        return {"intent": "unknown", "parameters": {}}

    content = data.get("message", {}).get("content", "{}")
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        log.warning("LLM zwrócił nie-JSON: %r", content[:200])
        return {"intent": "unknown", "parameters": {}}


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — validate
# ─────────────────────────────────────────────────────────────────────────────

PLATE_VALIDATE_RE = re.compile(r"^[A-Z0-9]{4,10}$")


def validate(classified: dict) -> dict:
    """
    Walidacja + sanityzacja parametrów. Od 2026-08-15 (temporal engine §4)
    to wrapper nad _validate_core: po per-intent walidacji dokłada okno
    czasowe (since_ms/until_ms/window_label) dla WINDOWED_INTENTS — case'y
    w _validate_core budują świeże dict-y parametrów i nie muszą wiedzieć
    o oknie.
    """
    out = _validate_core(classified)
    if out.get("intent") in WINDOWED_INTENTS:
        raw = classified.get("parameters") or {}
        since = raw.get("since_ms")
        until = raw.get("until_ms")
        if isinstance(since, (int, float)):
            out["parameters"]["since_ms"] = int(since)
            out["parameters"]["until_ms"] = (
                int(until) if isinstance(until, (int, float)) else None
            )
            wl = raw.get("window_label")
            if isinstance(wl, str) and wl:
                out["parameters"]["window_label"] = wl[:40]
    return out


def _validate_core(classified: dict) -> dict:
    """
    Walidacja + canonicalization. Każda intencja ma sztywne reguły:
      • intent musi być w VALID_INTENTS, inaczej → unknown
      • parametry wymagane muszą być obecne, inaczej → unknown
      • wartości enum-owe (color/tag/direction) muszą być canonical
      • plate musi pasować do regex
    Wszystko co nie pasuje degraduje do {'intent': 'unknown', 'parameters': {}}.
    """
    intent = classified.get("intent", "unknown")
    if intent not in VALID_INTENTS:
        return {"intent": "unknown", "parameters": {}}

    params_raw = classified.get("parameters") or {}
    if not isinstance(params_raw, dict):
        return {"intent": "unknown", "parameters": {}}

    out: dict[str, Any] = {}

    def _canon_direction(d: Any) -> str | None:
        if isinstance(d, str) and d.lower() in VALID_DIRECTIONS:
            return d.lower()
        return None

    def _canon_color(c: Any) -> str | None:
        if not isinstance(c, str):
            return None
        c_low = c.lower().strip()
        return COLOR_ALIASES.get(c_low)  # zwraca canonical EN lub None

    def _canon_tag(t: Any) -> str | None:
        if not isinstance(t, str):
            return None
        return TAG_ALIASES.get(t.lower().strip())

    def _canon_plate(p: Any) -> str | None:
        if not isinstance(p, str):
            return None
        plate = re.sub(r"[^A-Z0-9]", "", p.upper())
        return plate if PLATE_VALIDATE_RE.match(plate) else None

    if intent in ("count_vehicles_today", "list_vehicles_recent"):
        d = _canon_direction(params_raw.get("direction"))
        if d:
            out["direction"] = d
        return {"intent": intent, "parameters": out}

    if intent == "count_vehicles_by_color_today":
        color = _canon_color(params_raw.get("color"))
        if not color:
            return {"intent": "unknown", "parameters": {}}
        out["color"] = color
        d = _canon_direction(params_raw.get("direction"))
        if d:
            out["direction"] = d
        return {"intent": intent, "parameters": out}

    if intent == "count_vehicles_by_tag_today":
        tag = _canon_tag(params_raw.get("tag"))
        if not tag:
            return {"intent": "unknown", "parameters": {}}
        out["tag"] = tag
        d = _canon_direction(params_raw.get("direction"))
        if d:
            out["direction"] = d
        return {"intent": intent, "parameters": out}

    if intent == "courier_today":
        d = _canon_direction(params_raw.get("direction"))
        if d:
            out["direction"] = d
        return {"intent": intent, "parameters": out}

    if intent == "waste_typical_time":
        return {"intent": intent, "parameters": {}}

    if intent in ("vehicle_history_by_plate", "last_seen_plate", "count_visits_by_plate", "vehicle_owner_by_plate", "visit_duration_by_plate"):
        plate = _canon_plate(params_raw.get("plate"))
        if not plate:
            return {"intent": "unknown", "parameters": {}}
        return {"intent": intent, "parameters": {"plate": plate}}

    if intent == "count_gate_openings_today":
        d = _canon_direction(params_raw.get("direction"))
        if d:
            out["direction"] = d
        return {"intent": intent, "parameters": out}

    if intent == "list_vehicles_by_color_today":
        color = _canon_color(params_raw.get("color"))
        if not color:
            return {"intent": "unknown", "parameters": {}}
        out["color"] = color
        d = _canon_direction(params_raw.get("direction"))
        if d:
            out["direction"] = d
        return {"intent": intent, "parameters": out}

    if intent == "search_vehicles_today":
        keyword = params_raw.get("keyword")
        if not isinstance(keyword, str) or not keyword.strip():
            return {"intent": "unknown", "parameters": {}}
        # Sanityzacja: lowercase, trim, max 50 chars, alphanumeric+space tylko
        keyword_clean = re.sub(r"[^a-ząćęłńóśżź0-9\s]+", "", keyword.lower().strip())[:50]
        if not keyword_clean:
            return {"intent": "unknown", "parameters": {}}
        out["keyword"] = keyword_clean
        d = _canon_direction(params_raw.get("direction"))
        if d:
            out["direction"] = d
        return {"intent": intent, "parameters": out}

    if intent == "list_unmatched_plates":
        limit_raw = params_raw.get("limit", 5)
        try:
            limit = max(1, min(int(limit_raw), 20))
        except (TypeError, ValueError):
            limit = 5
        hours_raw = params_raw.get("range_hours", 24)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 24
        return {
            "intent": intent,
            "parameters": {"limit": limit, "range_hours": range_hours},
        }

    if intent in ("list_errors_recent", "count_errors_recent"):
        hours_raw = params_raw.get("range_hours", 1)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 1
        return {"intent": intent, "parameters": {"range_hours": range_hours}}

    if intent == "list_devices":
        return {"intent": intent, "parameters": {}}

    if intent == "count_objects_today":
        raw = params_raw.get("object_class")
        if not isinstance(raw, str):
            return {"intent": "unknown", "parameters": {}}
        canon = VISION_OBJECT_ALIASES.get(raw.lower().strip())
        if not canon:
            return {"intent": "unknown", "parameters": {}}
        hours_raw = params_raw.get("range_hours", 24)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 24
        return {
            "intent": intent,
            "parameters": {"object_class": canon, "range_hours": range_hours},
        }

    if intent == "last_seen_object":
        # FAZA 8.h.29 — HISTORIA klasy YOLO. `object_class` z whitelisty
        # COCO + pseudo-klasa `animal` (cat|dog). Do SQL idą DWA placeholdery
        # (`sql_class_a`/`sql_class_b`) — dla animal to (cat, dog), dla
        # zwykłej klasy dwa razy ta sama wartość (nieszkodliwy OR).
        raw = params_raw.get("object_class")
        if not isinstance(raw, str):
            return {"intent": "unknown", "parameters": {}}
        raw_l = raw.lower().strip()
        if raw_l in ("animal", "zwierzę", "zwierze", "zwierzak", "zwierzęta", "zwierzeta"):
            canon = "animal"
        else:
            canon = VISION_OBJECT_ALIASES.get(raw_l)
        if not canon:
            return {"intent": "unknown", "parameters": {}}
        hours_raw = params_raw.get("range_hours", 168)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 168
        cls_a, cls_b = ("cat", "dog") if canon == "animal" else (canon, canon)
        return {
            "intent": intent,
            "parameters": {
                "object_class": canon,
                "sql_class_a": cls_a,
                "sql_class_b": cls_b,
                "range_hours": range_hours,
            },
        }

    if intent in ("search_taxi_recent", "search_courier_recent"):
        # FAZA 8.h.29/8.h.30 — agregaty TAXI (UBER/BOLT/napis taxi w OCR)
        # i KURIER (marki kurierskie + tag kurier/dostawa w LPR).
        # Jedyny parametr: okno czasowe.
        hours_raw = params_raw.get("range_hours", 24)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 24
        return {"intent": intent, "parameters": {"range_hours": range_hours}}

    if intent == "list_recent_detections":
        hours_raw = params_raw.get("range_hours", 1)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 1
        limit_raw = params_raw.get("limit", 10)
        try:
            limit = max(1, min(int(limit_raw), 50))
        except (TypeError, ValueError):
            limit = 10
        return {
            "intent": intent,
            "parameters": {"range_hours": range_hours, "limit": limit},
        }

    if intent == "search_by_brand_today":
        # `brand` must be a known canonical UPPERCASE name. Anything else →
        # unknown (LLM safety net — keeps SQL bind values constrained to the
        # set the YOLO service actually writes).
        brand_raw = params_raw.get("brand")
        if not isinstance(brand_raw, str):
            return {"intent": "unknown", "parameters": {}}
        brand = brand_raw.strip().upper()
        # FAZA 8.h.13 (2026-06-09) — używamy `BRAND_KEYWORD_MAP.values()`
        # (40+ canonical names) zamiast starego BRAND_KEYWORDS (15 kurierzy).
        # Wcześniej `validate` odrzucał FRISCO/MEDIA_EXPERT/IKEA/etc. mimo że
        # `_extract_brand_keyword` je rozpoznał — bo nie były w starej liście.
        valid_brands = set(BRAND_KEYWORD_MAP.values())
        if brand not in valid_brands:
            return {"intent": "unknown", "parameters": {}}
        hours_raw = params_raw.get("range_hours", 24)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 24
        return {
            "intent": intent,
            "parameters": {"brand": brand, "range_hours": range_hours},
        }

    if intent == "search_by_text_today":
        # 2026-08-15 — wolny tekst do LIKE po text_raw. Sanityzacja: trim,
        # max 40 znaków, bez znaków sterujących/procentów (LIKE wildcards
        # neutralizujemy — user szuka literalnego napisu, nie wzorca).
        query_raw = params_raw.get("query")
        if not isinstance(query_raw, str):
            return {"intent": "unknown", "parameters": {}}
        query = re.sub(r"[%_\x00-\x1f]", "", query_raw.strip())[:40]
        if len(query) < 2:
            return {"intent": "unknown", "parameters": {}}
        hours_raw = params_raw.get("range_hours", 24)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 24
        return {
            "intent": intent,
            "parameters": {
                "query": query,
                # §15: forma kanoniczna do fuzzy-LIKE po znormalizowanym
                # text_raw (cyfry-sobowtóry, spacje, diakrytyki).
                "query_canon": canonical_ocr(query),
                "range_hours": range_hours,
            },
        }

    if intent == "search_vehicle_desc":
        # kind: kanoniczny albo stem z pytania (LLM fallback może dać odmianę).
        kind_raw = str(params_raw.get("kind") or "").strip().lower()
        kinds: tuple[str, str] | None = None
        plain_kind = kind_raw.translate(_VLM_DEACCENT)
        for stem, pair in _VLM_KIND_STEMS:
            if plain_kind == pair[0] or plain_kind.startswith(stem):
                kinds = pair
                break
        color_raw = str(params_raw.get("color") or "").strip().lower()
        plain_color = color_raw.translate(_VLM_DEACCENT)
        prefixes = None
        for canon, pair in _VLM_COLOR_PREFIXES.items():
            if plain_color == canon or plain_color.startswith(pair[0]):
                prefixes = (canon, pair)
                break
        if kinds is None or prefixes is None:
            return {"intent": "unknown", "parameters": {}}
        hours_raw = params_raw.get("range_hours", 24)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 24
        return {
            "intent": intent,
            "parameters": {
                "kind": kinds[0],
                "color": prefixes[0],
                "sql_kind_a": kinds[0],
                "sql_kind_b": kinds[1],
                "sql_color_a": f"{prefixes[1][0]}%",
                "sql_color_b": f"{prefixes[1][1]}%",
                "range_hours": range_hours,
            },
        }

    if intent == "search_emergency_recent":
        kind_raw = params_raw.get("kind")
        kind = kind_raw if kind_raw in ("ambulans", "policja", "straz") else "any"
        hours_raw = params_raw.get("range_hours", 24)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 24
        return {
            "intent": intent,
            "parameters": {"kind": kind, "range_hours": range_hours},
        }

    if intent == "waste_pickup_status":
        # Composite handler (app.py) — harmonogram + obserwacje z DZIŚ.
        # `category` opcjonalna, jak w search_by_waste_today.
        out_params: dict[str, Any] = {}
        category_raw = params_raw.get("category")
        if isinstance(category_raw, str):
            cat = category_raw.strip().upper()
            if cat in VALID_WASTE_CATEGORIES:
                out_params["category"] = cat
        return {"intent": intent, "parameters": out_params}

    if intent == "search_by_vehicle_make":
        # FAZA 8.h.32 — marka musi być canonical z CAR_MAKE_PATTERNS.
        # LLM fallback może podać odmianę ("toyotę") — kanonizujemy przez
        # _match_car_make. Do SQL idą DWA pad-token aliasy (sql_make_a/b) —
        # np. Volkswagen = ('volkswagen', 'vw'); zwykła marka 2× to samo.
        make_raw = params_raw.get("make")
        if not isinstance(make_raw, str) or not make_raw.strip():
            return {"intent": "unknown", "parameters": {}}
        canon = None
        for c in VALID_CAR_MAKES:
            if c.lower() == make_raw.strip().lower():
                canon = c
                break
        if canon is None:
            canon = _match_car_make(make_raw.lower())
        if canon is None:
            return {"intent": "unknown", "parameters": {}}
        hours_raw = params_raw.get("range_hours", 24)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 24
        alias_a, alias_b = CAR_MAKE_SQL_ALIASES.get(
            canon, (canon.lower(), canon.lower()),
        )
        return {
            "intent": intent,
            "parameters": {
                "make": canon,
                "sql_make_a": alias_a,
                "sql_make_b": alias_b,
                "range_hours": range_hours,
            },
        }

    if intent == "search_knowledge_base":
        # query: wymagany, niepusty string. type: opcjonalny, z whitelisty.
        query_raw = params_raw.get("query")
        if not isinstance(query_raw, str) or not query_raw.strip():
            return {"intent": "unknown", "parameters": {}}
        out_params: dict[str, Any] = {"query": query_raw.strip()[:500]}
        type_raw = params_raw.get("type")
        if isinstance(type_raw, str) and type_raw in (
            "MESSENGER_CHAT", "UCHWALA", "REGULAMIN", "KONTAKT", "INNE",
        ):
            out_params["type"] = type_raw
        return {"intent": intent, "parameters": out_params}

    if intent == "recent_activity_summary":
        hours_raw = params_raw.get("range_hours", 4)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 4
        return {"intent": intent, "parameters": {"range_hours": range_hours}}

    if intent == "search_by_waste_today":
        # `category` opcjonalny. Gdy obecny — musi być canonical UPPERCASE z
        # whitelisty (matchuje set z waste_matcher.py). Cokolwiek innego →
        # ignore (NIE drop intent — generic „śmieciarka" jest legalnym
        # pytaniem bez category).
        out_params: dict[str, Any] = {}
        category_raw = params_raw.get("category")
        if isinstance(category_raw, str):
            cat = category_raw.strip().upper()
            if cat in VALID_WASTE_CATEGORIES:
                out_params["category"] = cat
        hours_raw = params_raw.get("range_hours", 24)
        try:
            range_hours = max(1, min(int(hours_raw), 720))
        except (TypeError, ValueError):
            range_hours = 24
        out_params["range_hours"] = range_hours
        return {"intent": intent, "parameters": out_params}

    return {"intent": "unknown", "parameters": {}}


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def _ground_llm_result(validated: dict, question: str) -> dict:
    """Uziemienie wyniku LLM-fallbacku w treści pytania (2026-08-24).

    Zgłoszenie BA VN: „jakie samochody pojawiły się między 1 a 6 rano?" →
    regex miss → Bielik zwrócił count_vehicles_by_color_today z color="white"
    (halucynacja; COLOR_ALIASES przepuszcza angielskie aliasy) → „Dziś nie
    pojawiło się żadne auto w kolorze white." Zasada: parametr słownikowy
    z LLM musi mieć pokrycie w pytaniu — ekstraktory słownikowe są czulsze
    niż wzorce intentów, więc brak trafienia = wartość zmyślona → unknown
    (uczciwe „nie zrozumiałem" zamiast fałszywego zera).

    Dodatkowo dolicza okno czasowe — compute_time_window działał dotąd tylko
    w classify_regex, więc „między 1 a 6" ginęło nawet przy trafnym intencie.
    """
    intent = validated.get("intent")
    # setdefault, NIE `get(...) or {}` — pusty dict jest falsy i mutacje
    # (doliczone okno) trafiałyby do obiektu-śmietnika.
    params = validated.setdefault("parameters", {})
    q = question.lower().strip()
    unknown = {"intent": "unknown", "parameters": {}}

    if "color" in params and intent != "search_vehicle_desc":
        if _match_color(q) != params["color"]:
            return unknown
    if "tag" in params and not any(
        alias in q for alias, canon in TAG_ALIASES.items() if canon == params["tag"]
    ):
        return unknown
    if "brand" in params and _extract_brand_keyword(q) != params["brand"]:
        return unknown
    if "make" in params and _match_car_make(q) is None:
        return unknown
    if "plate" in params:
        flat = re.sub(r"[^A-Z0-9]", "", question.upper())
        if str(params["plate"]) not in flat:
            return unknown
    if intent == "search_vehicle_desc" and (
        _ext_vlm_kind(q, question, {}) is None or _ext_vlm_color(q, question, {}) is None
    ):
        return unknown

    if intent in WINDOWED_INTENTS and "since_ms" not in params:
        since_ms, until_ms, window_label = compute_time_window(q)
        if since_ms is not None:
            params["since_ms"] = since_ms
            params["until_ms"] = until_ms
            if window_label:
                params["window_label"] = window_label[:40]
    return validated


async def classify(question: str) -> dict:
    """
    Główny entry point. Zwraca {'intent': str, 'parameters': dict}.
    Gwarantuje że intent jest w VALID_INTENTS i parameters pasują do schematu.

    Fallback chain (ETAP 3, 2026-06-11):
      1. classify_regex — rejestr deklaratywny, <1 ms, deterministyczne
      2. tool-calling (TYLKO gdy env TOOL_CALLING_ENABLED=true) — Ollama
         /api/chat z tools wygenerowanymi z intents_registry.yaml
      3. classify_llm — single-shot JSON classification (dotychczasowy)
      4. unknown
    Każdy stopień przechodzi przez validate() — LLM nigdy nie pisze SQL,
    tylko wybiera template; parametry są przycinane do enum whitelist.
    """
    fast = classify_regex(question)
    if fast is not None:
        log.info("regex matched → intent=%s", fast.get("intent"))
        return validate(fast)

    # ── Stage 1.5 (opt-in): Ollama tool calling ──
    import tool_calling  # lazy — moduł importuje nas (VALID_INTENTS)
    if tool_calling.TOOL_CALLING_ENABLED:
        tool_result = await tool_calling.classify_tool_calling(question)
        if tool_result is not None:
            validated = _ground_llm_result(validate(tool_result), question)
            if validated["intent"] != "unknown":
                log.info("tool_calling matched → intent=%s", validated["intent"])
                return validated
            log.info("tool_calling wynik odrzucony przez validate → classify_llm")

    log.info("regex miss → falling back to LLM (model=%s)", get_active_llm().model)
    llm_result = await classify_llm(question)
    validated = _ground_llm_result(validate(llm_result), question)
    if validated["intent"] == "unknown" and llm_result.get("intent") != "unknown":
        log.info("LLM wynik odrzucony przez grounding (intent=%s params=%s)",
                 llm_result.get("intent"), llm_result.get("parameters"))
    return validated
