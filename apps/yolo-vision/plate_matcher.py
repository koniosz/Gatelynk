"""
Polski plate matcher — wyciąga tablice rejestracyjne z OCR text-u
**niezależnie od typu kamery** (Hikvision LPR, generic CAMERA z YOLO+EasyOCR).

Po co osobno od Hikvision DeepinView ANPR:
  • Hikvision LPR ma dedykowany hardware ANPR z 99% accuracy ale tylko dla
    kamer LPR ($$$). Tej samej ramki z kamery CAMERA (zwykła obserwacja
    podwórka) nie umie odczytać tablic.
  • EasyOCR + YOLO action już mamy — `brand_detector` przepuszcza każdy
    truck/bus/car crop przez EasyOCR. Dane są — trzeba tylko post-process
    odpowiednim regexem.
  • Use case: Villa Natura ma kamerę 9a7ae69e CAMERA (Hikvision ColorVu) na
    podwórku, która widzi auta zaparkowane przy bramie. Plate detection bez
    drugiego dedykowanego LPR-a daje audit „kto stał pod furtką o 14:00".

Format polskiej tablicy (od 2000):
  • 1-3 znaki kod regionu (litery) + spacja + 4-6 znaków (litery + cyfry)
  • Razem 5-8 znaków alphanum bez spacji po normalizacji
  • Pierwsza litera: A-Z (region: W=Warszawa, GD=Gdańsk, WGA=Pruszków...)
  • Kontynuacja: mix [A-Z][0-9], na ogół zaczyna się od cyfr ale są wyjątki
    (motocykle, zielone EV, dyplomatyczne — pomijamy w MVP)

Strategia matchu:
  1. Normalizuj OCR token: upper(), strip non-alphanumeric ([→[, !→nothing).
  2. Sprawdź length 5-8 (większość polskich plate).
  3. Sprawdź pattern: ≥1 litera na początku + ≥1 cyfra w środku.
  4. Filter false-positive: blacklista typowych „śmieci" (SCANIA, VOLVO, CAMERAS).
  5. Confidence: zwracamy raw EasyOCR conf z postprocess penalty za:
     - znaki które typowo są confused (O↔0, I↔1, S↔5, Z↔2)
     - brakujące diacritics (PL plate nie ma diacritics, więc OK)

Zwracamy listę candidate plates z confidence — caller decyduje czy zapisać
do `lpr_reads` (high conf >0.7) czy tylko jako tag w `vision_detections.text_raw`.
"""
from __future__ import annotations

import re
from typing import Iterable


# Lista znanych słów które OCR widzi i które wyglądają jak plate ale to NIE
# tablice rejestracyjne. Producenci aut + slowa-blacklista. Rozszerzaj
# przy false-positives — `_is_blacklist_word` może być iteracyjnie dopolerowane.
_BLACKLIST = {
    # marki samochodów (jak ktoś sfotgraf nazwę modela na tylnej szybie)
    "SCANIA", "VOLVO", "RENAULT", "PEUGEOT", "TOYOTA", "FORD", "OPEL",
    "HYUNDAI", "DACIA", "FIAT", "VOLKSWAGEN", "MERCEDES", "AUDI", "BMW",
    "SKODA", "MAZDA", "NISSAN", "TESLA", "JAGUAR",
    # OSD overlay z kamer (Hikvision dodaje na obraz)
    "CAMERA", "CAMERAS", "CAMERA01", "CAMERA02",
    # Etykiety widzów spod kamer
    "DPD", "DHL", "INPOST", "FEDEX", "GLS", "UPS", "NTFY", "NTFYPL",
    "ZGOK", "MPO", "MPGK", "REMONDIS", "STENA",
    # Inne typowe OCR garbage
    "WWW", "COM", "PL", "EU", "UE", "ID", "OK", "NO", "EN",
}


# Polski plate regex po normalizacji:
#   - 2-3 znaki: kod regionu (litery)
#   - 4-5 znaków: serial (alfanumeryczne, ≥1 cyfra)
#   - Min total 5, max 8
# Przykład: WGM2171M, WO34567, WGA1234A, GDA12345, WG12345
_PLATE_RE = re.compile(
    r"^[A-Z]{1,3}[A-Z0-9]{4,6}$"
)
# Dodatkowy filter: musi zawierać CO NAJMNIEJ jedną cyfrę (bez tego matchuje
# czyste słowa typu „ZIELONE" które przez OCR mogą wpaść do _PLATE_RE).
_HAS_DIGIT = re.compile(r"[0-9]")


def _normalize(token: str) -> str:
    """Stripuje wszystkie non-alphanumeric i daje upper-case.

    2026-06-02: OCR często widzi `[` zamiast `W` lub `K` (pionowe kreski),
    `O` jako `0`, `1` jako `I/L`. Aplikujemy substytucje na poziomie
    plate-shape detection — `_PLATE_RE` jest tolerant, ale normalizator
    robi pierwszy run czyszczenia OCR-confuables które są dominujące w
    klatce z Hikvision LPR (gdy plate widoczna pod kątem).
    """
    t = re.sub(r"[^A-Za-z0-9\[\]]", "", token).upper()
    # OCR-confusables substitution — typowe wzorce z Villa Natura LPR camera
    # gdy plate widoczna pod kątem 30-45°:
    #   [ → W lub K (jedna z pionowych kresek brakuje w OCR)
    #   ] → I lub L
    # Nie aplikujemy jeśli token NIE zaczyna się od [ (false-positive risk).
    if t.startswith("["):
        t = "W" + t[1:]  # WO/WZ/WX/WGM dominujące dla Mazowsza
    return re.sub(r"[\[\]]", "", t)


def _is_plate_shape(normalized: str) -> bool:
    if not (5 <= len(normalized) <= 8):
        return False
    if not _PLATE_RE.match(normalized):
        return False
    if not _HAS_DIGIT.search(normalized):
        return False
    # Pierwsza grupa = litery; rozsądnie wymagamy że pierwszy znak to litera
    if not normalized[0].isalpha():
        return False
    return True


def _confidence_penalty(normalized: str, raw_conf: float) -> float:
    """
    Stosuje confidence-penalty dla typowych OCR confuables. Wraca skorygowane
    confidence ∈ [0.0, raw_conf].

    OCR często myli:
      O ↔ 0, I ↔ 1, S ↔ 5, Z ↔ 2, B ↔ 8
    Tablica która zawiera wiele takich znaków = ryzyko że jest źle przeczytana
    → obniżamy confidence o ~5% per problematyczny znak.
    """
    confusables = sum(1 for ch in normalized if ch in "OISZB01528")
    penalty = min(0.3, confusables * 0.04)
    return max(0.0, raw_conf - penalty)


def match_plates(
    ocr_results: Iterable[tuple[str, float]],
) -> list[tuple[str, float]]:
    """
    Wyciąga prawdopodobne polskie tablice z OCR results.

    Args:
      ocr_results: lista (text, conf) z EasyOCR.

    Returns:
      Lista (normalized_plate, confidence) posortowana DESC po confidence.
      Pusta lista gdy nic nie znaleziono.

    Tie-break: stable (preserving input order). Caller może wziąć top-N albo
    filtrować po threshold (np. confidence > 0.6).
    """
    candidates: list[tuple[str, float]] = []
    seen: set[str] = set()
    for text, conf in ocr_results:
        if not isinstance(text, str) or not text:
            continue
        normalized = _normalize(text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        if normalized in _BLACKLIST:
            continue
        if not _is_plate_shape(normalized):
            continue
        # OCR często rozdziela długi plate na 2 tokeny — np. „WGM" + „2171M"
        # → po _normalize nadal mamy fragmenty. _is_plate_shape przepuści
        # tylko sklejone formy ≥5 znaków, więc fragmenty zostaną odrzucone.
        # Joining tokenów byłby fajny enhancement ale wymaga box-coords —
        # MVP zostaje per-token.
        adjusted = _confidence_penalty(normalized, float(conf))
        candidates.append((normalized, round(adjusted, 3)))

    # Sort DESC po conf — caller bierze top-N.
    candidates.sort(key=lambda x: -x[1])
    return candidates
