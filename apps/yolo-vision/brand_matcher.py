"""
Brand matcher — maps OCR text strings to canonical courier/service brand.

Why regex-based and not LLM/embeddings:
  • OCR output for delivery vans is short — typically 1-3 tokens per box.
    Embedding distance is noisy at that scale; regex with explicit aliases is
    both faster (<1ms) and easier to audit when a match looks wrong.
  • Reference set during POC showed near-zero ambiguity once we restrict to
    "real" candidates (≥4 chars, alphabetic-leading). Pure-digit tokens like
    plate fragments are ignored at the call site.

The patterns are intentionally conservative: each brand has 1-3 short regexes
that match the canonical wordmark plus an obvious slogan/tagline (e.g. DHL's
"Excellence" — the POC consistently picked it up alongside "DHL" on the side).

Confidence comes straight from the OCR — we never invent it. When multiple
OCR strings match the same brand, the caller picks the highest confidence;
when several brands match, the highest-confidence per-brand match wins.

Importable surface:
  • BRAND_PATTERNS — dict[brand, list[regex]] for callers that want to know
    which brands the matcher knows about (e.g. the assistant intent classifier
    re-uses the keys as a keyword whitelist).
  • match_brand(ocr) — runs the patterns against an OCR result list.

POC notes (2026-05-19):
  • DHL: 0.974 conf on test van side, 4 boxes total (DHL/EXCELLENCE/EXPRESS/…)
  • DPD: 0.93 conf on side panel, 2 boxes (DPD + EXPERTS)
  • FedEx: 0.91 conf on side door, 1 box (FEDEX)
  • Glovo/Wolt: only matched on backpack-cropped frames (not bus/car bbox).
    Plan to revisit when we have real edge-frame samples — pattern stays in.
"""
from __future__ import annotations

import re
from typing import Iterable


# Each entry: canonical brand → list of regexes. Order within a list doesn't
# matter — we pick the highest-confidence OCR string that matches ANY pattern.
# All patterns are compiled with re.IGNORECASE at match time (cached).
BRAND_PATTERNS: dict[str, list[str]] = {
    # Couriers (PL + EU mainstream).
    "DHL":     [r"\bDHL\b", r"deutsche\s*post", r"\bexcellence\b"],
    # `geo\s*post` — „NETWORK MEMBER OF GEOPOST" jest na burcie każdego auta
    # DPD, a samo logo „dpd" ma tak stylizowany krój, że OCR czyta je jako
    # „Pclp" (zmierzone na obiekcie VN 2026-08-09). GEOPOST jest więc
    # w praktyce PEWNIEJSZYM sygnałem tej marki niż jej własne logo.
    "DPD":     [r"\bdpd\b", r"your\s+delivery\s+experts", r"geo\s*post"],
    "INPOST":  [r"\binpost\b", r"paczkomat", r"in\s*post"],
    "FEDEX":   [r"\bfedex\b", r"fed\s*ex"],
    "GLS":     [r"\bGLS\b", r"general\s+logistics"],
    "UPS":     [r"\bUPS\b", r"united\s+parcel"],
    "POCZTA":  [r"poczta\s+polska", r"\bpocztex\b", r"\bpoczta\b"],
    "ALLEGRO": [r"allegro\s+one", r"allegro\s+paczka", r"\ballegro\b"],
    "DACHSER": [r"\bdachser\b"],   # B2B logistics — bonus, sometimes shows up

    # Food delivery (riders or cars).
    "GLOVO":   [r"\bglovo\b"],
    "WOLT":    [r"\bwolt\b"],
    "UBER":    [r"\buber\s*eats\b", r"\buber\b"],
    "BOLT":    [r"\bbolt\s*food\b", r"\bbolt\b"],
    "PYSZNE":  [r"\bpyszne\b", r"pyszne\.pl"],

    # Catering dietetyczny / meal box (PL). Vany z dietą pudełkową jeżdżą
    # na osiedlach 4:30-7:00 — typowy ruch przed innymi kurierami. Często
    # mają charakterystyczne 4-literowe akronimy (NTFY, NSF) i pełną nazwę
    # firmy obok. Dodane 2026-05-25 po zgłoszeniu, że NTFY (Nice To Fit You)
    # przyjeżdżał o 05:17 i OCR go nie zarejestrował. Wzorce uwzględniają
    # zarówno akronim widoczny z dalej, jak i pełną nazwę z bliska.
    # NTFY: napis na boku vana często ma sufiks "pl", ".pl" lub "24" — EasyOCR
    # zwraca go jako jedno słowo (np. "NTFYpl"), więc samo `\bntfy\b` nie
    # matchuje. Pattern obejmuje suffixy.
    "NTFY":       [r"\bntfy(?:[.\s]?pl)?(?:[.\s]?24)?", r"nice\s+to\s+fit\s+you"],
    "MACZFIT":    [r"\bmaczfit\b", r"macz\s*fit"],
    "LIGHTBOX":   [r"\blight\s*box\b", r"\blightbox\b"],
    "BODYCHIEF":  [r"\bbody\s*chief\b", r"\bbodychief\b"],
    "BEDIET":     [r"\bbe\s*diet\b", r"\bbediet\b"],
    "DIETLY":     [r"\bdietly\b"],
    "FITME":      [r"\bfit\s*me\b", r"\bfitme\b", r"fitme24"],
    "DIETBOX":    [r"\bdiet\s*box\b", r"\bdietbox\b"],
    "PALEOPOWER": [r"\bpaleo\s*power\b", r"\bpaleopower\b"],
    "SMARTFOOD":  [r"\bsmart\s*food\b", r"\bsmartfood\b"],
    "FITWAY":     [r"\bfit\s*way\b", r"\bfitway\b"],

    # Polskie sieci retail/AGD/RTV — vany dostawcze. Dodane 2026-06-05 po
    # zgłoszeniu Konrada że Media Expert van GM8149M przejechał Villa Natura
    # o 20:17. Snapshot zapisany do `vision_detections` (id 12969,
    # {"car":8,"truck":1}) ale brand_detected zostało NULL — pattern nie istniał.
    # Logo na vanach AGD/RTV bywa wyraźne na białym tle, EasyOCR sobie radzi
    # gdy frame jest dobrej jakości.
    "MEDIA_EXPERT":  [r"\bmedia\s*expert\b", r"\bmediaexpert\b"],
    "MEDIA_MARKT":   [r"\bmedia\s*markt\b", r"\bmediamarkt\b"],
    "RTV_EURO_AGD":  [r"\brtv\s*euro\s*agd\b", r"\beuro\s*agd\b", r"\brtveuroagd\b"],
    "X_KOM":         [r"\bx[-\s]?kom\b", r"\bxkom\b"],
    "KOMPUTRONIK":   [r"\bkomputronik\b"],
    "NEONET":        [r"\bneonet\b"],
    "AVANS":         [r"\bavans\b"],

    # DIY / dom — kurierzy własni (IKEA Trasporto, OBI Marketplace).
    "IKEA":          [r"\bikea\b"],
    "OBI":           [r"\bobi\b"],
    "LEROY_MERLIN":  [r"\bleroy\s*merlin\b", r"\bleroymerlin\b"],
    "CASTORAMA":     [r"\bcastorama\b"],
    "JYSK":          [r"\bjysk\b"],

    # Spożywka online / dyskonty z dostawą.
    "FRISCO":        [r"\bfrisco\b", r"frisco\.pl"],
    "BARBORA":       [r"\bbarbora\b"],
    "BIEDRONKA":     [r"\bbiedronka\b"],
    "LIDL":          [r"\blidl\b"],
    "AUCHAN":        [r"\bauchan\b"],
    "CARREFOUR":     [r"\bcarrefour\b"],

    # Apteki — dostawa do domu (rzadko, ale jeżdżą po osiedlach).
    "DOZ":           [r"\bdoz\b", r"doz\.pl"],
    "GEMINI":        [r"\bgemini\s*apteka\b", r"\bgeminiapteka\b"],
}


# Compile each pattern once and cache. Tuple of (brand, compiled-re) — order
# doesn't matter because we score by OCR confidence, not pattern priority.
_COMPILED: list[tuple[str, re.Pattern[str]]] = [
    (brand, re.compile(pat, re.IGNORECASE))
    for brand, pats in BRAND_PATTERNS.items()
    for pat in pats
]


def known_brands() -> list[str]:
    """Sorted list of canonical brand names — used by assistant intent code."""
    return sorted(BRAND_PATTERNS.keys())


def match_brand(
    ocr_results: Iterable[tuple[str, float]],
) -> tuple[str | None, float | None]:
    """
    Pick the best (brand, confidence) match across all OCR tokens.

    Args:
      ocr_results: iterable of (text, conf) from EasyOCR. `conf` is 0..1.

    Returns:
      (brand, conf)  on hit — `brand` is canonical UPPERCASE.
      (None, None)   when no token matched any brand pattern.

    Tie-breaking is by raw OCR confidence (higher wins). If two brands match
    distinct tokens with equal confidence, the caller-side iteration order is
    preserved (deterministic given EasyOCR's left-to-right reading) — fine
    because real ambiguity at the same confidence threshold is vanishingly
    rare in practice.
    """
    best_brand: str | None = None
    best_conf: float = -1.0
    for text, conf in ocr_results:
        if not text or len(text) < 2:
            # Single-letter OCR tokens are noise — skip without trying patterns.
            continue
        for brand, regex in _COMPILED:
            if regex.search(text):
                if conf > best_conf:
                    best_brand = brand
                    best_conf = float(conf)
                # Don't break — another pattern could match the same token at
                # the same brand, no harm; cost is negligible (~50 regex tries).
    if best_brand is None:
        return (None, None)
    return (best_brand, round(best_conf, 3))
