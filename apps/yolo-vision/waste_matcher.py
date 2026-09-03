"""
Waste-truck matcher — maps OCR text strings to (waste_category, operator).

Why a separate matcher from brand_matcher:
  • Different vocabulary. Brand_matcher uses courier wordmarks (DHL/DPD/…)
    which are mostly ASCII and 3-4 chars. Waste-truck signage is longer,
    diacritic-heavy Polish (SZKŁO, ZMIESZANE, TWORZYWA SZTUCZNE) plus the
    truck operator written in a separate place on the cab.
  • Different downstream semantics. Brand → courier event (assistant "czy
    DHL"). Waste → municipal pickup event ("czy szkło dzisiaj"). Different
    intent, different SQL table column, different assistant phrasing.

Stays regex-only for the same reasons as brand_matcher:
  • OCR output for a truck side is short (1-3 lines per crop); embeddings
    are overkill, regex is <1ms and easy to audit.
  • The Polish waste-categorization vocabulary is small and government-
    standardised (krajowy system od 2018, 5 frakcji). Variation is mostly
    plural endings and the alternative-spelling for plastic (PLASTIK vs
    "TWORZYWA SZTUCZNE / METALE" — same bin colour, same fraction).

POC plan (2026-05-19, awaiting first real frame from edge):
  • Sample image: Wikimedia Commons "Remondis śmieciarka SZKŁO"
  • Expected matches: SZKŁO → GLASS, REMONDIS → REMONDIS operator
  • Cross-check that "ZIELONE" doesn't false-positive on COLOR_PATTERNS in
    the assistant (asystent must check waste FIRST — see intent_classifier).
"""
from __future__ import annotations

import re
from typing import Iterable


# Canonical waste-fraction codes. Same 5 buckets as the Polish municipal
# system (5-fraction collection mandated nationwide from 2018) — colour-coded
# bin lids that residents recognise:
#   GLASS   — szkło       — green/white bin
#   PAPER   — papier      — blue bin
#   PLASTIC — plastik     — yellow bin (incl. "metale i tworzywa sztuczne")
#   BIO     — bio         — brown bin (incl. trawa/liście "zielone")
#   MIXED   — zmieszane   — black bin
WASTE_PATTERNS: dict[str, list[str]] = {
    # ŁL alt-class because OCR sometimes flips Ł→L when the diacritic is
    # blurred/oblique on a moving truck. SZKŁO is the most common signage.
    #
    # OCR-noise-tolerant alternates added 2026-05-19 after POC:
    #   SZKŁO often comes out as "SZK[ŁL]O" or "SZK[ŁL]A" + sometimes
    #   "SZK[lŁł]?[OAo]" when the first vowel is botched. We keep the strict
    #   form first so clean text scores highest confidence.
    "GLASS":   [
        r"\bSZK[ŁLł]O\b", r"\bSZK[ŁLł]A\b", r"\bGLASS\b",
        r"szk[łlŁL][oa]", r"\bSZKL\w*",  # SZKL[ANE/IK] etc.
    ],
    "PAPER":   [
        r"\bPAPIER\b", r"\bPAPIERU?\b", r"\bPAPER\b",
        r"\btektura\b", r"\bmakulatura\b", r"\bpapier\w*",
        r"\bPAPIE[RЯ]\b",  # OCR sometimes flips R→Я (cyrillic confusable)
        r"\bpap[a-z]{2,4}\b",  # paper / papir / papie + suffix tolerance
    ],
    # PLASTIC also covers the longer official label "METALE I TWORZYWA SZTUCZNE"
    # — same yellow bin in PL system. We match either keyword independently
    # because OCR often picks up just one of them per frame.
    "PLASTIC": [
        r"\bPLASTIK\b", r"\bPLASTIKU?\b", r"\bPLASTIC\b",
        r"\bTWORZYW\w*", r"\btworzyw\w*\s+sztuczn\w*",
        r"\bMETALE\b", r"\bmetal\w*\s+i\s+tworzyw\w*",
    ],
    # BIO truck signage uses either "BIO" (short) or "ZIELONE" (PL slang for
    # green/garden waste). Order matters slightly less here — both go to the
    # same brown bin. CAUTION: "ZIELONE" must be checked BEFORE COLOR_PATTERNS
    # in the assistant (it'd otherwise be misread as the colour green).
    "BIO":     [
        r"\bBIO\b", r"\bZIELONE\b", r"\bGREEN\b",
        r"\bodpady\s+bio\w*", r"\bbiodegrad\w*",
        r"\bbio[-\s]?odpad\w*",
    ],
    # MIXED covers the residual / "komunalne" fraction (black bin). Common
    # signage: "ZMIESZANE", "ODPADY ZMIESZANE", "KOMUNALNE".
    # OCR-noise alternates: "ZMIESZAN*" often loses the leading "ZM" or
    # gets "Z"→"3"/"S" confusion. POC sample 'tomaszow.jpg' returned the
    # token 'wiESZAIE' — clearly trying to be "ZMIESZANE". We add a loose
    # fallback that matches "ESZAN" infix (very PL-specific, no English
    # word contains it) so real-world OCR noise doesn't lose the match.
    "MIXED":   [
        r"\bZMIESZANE\b", r"\bZMIESZAN\w*",
        r"\bKOMUNALNE\b", r"\bKOMUNAL\w*",
        r"\bMIXED\b",
        # Loose match: 'ESZA' + one of NIH (N=correct, I/H=common OCR
        # mis-reads when the vertical bar of N is blurry). POC sample
        # 'tomaszow.jpg' returned 'wiESZAIE' — captured by 'ESZA[NIH]'.
        r"ESZA[NIH][EI]?",
        # 2026-06-02: Villa Natura 10:04 śmieciarka MPO Warszawa miała
        # frontowy napis „ODPADY". OCR przeczytał „Odpady !", „odpady",
        # „odpady [" 3× ale samo „ODPADY" jako default → MIXED (generyczne
        # odpady komunalne). BIO/PLASTIC mają specyficzne keyword-y wyżej,
        # więc gdy OCR wykryje np. „BIO odpady" — MIXED dopasuje też, ale
        # caller (detect_brand_for_detections) bierze najwyższą-confidence
        # match per crop. BIO ma wyższą szansę gdy stoi obok „odpady".
        r"\bODPADY\b", r"\bodpady\b",
        # OCR często dorzuca interpunkcję — "OdPady !", "odpady [" — \b się
        # nie matchuje przed `!` lub `[`. Dodajemy luźniejszą formę.
        r"odpady\s*[!\[\]]?",
        # 2026-06-05 — Villa Natura 08:11 śmieciarka MPO Warszawa, OCR
        # zniekształcił "odpady" 3-krotnie: "odrxdy", "odpdy", "odpaby".
        # Tolerancja: zaczyna się o-d-, ma 4-7 znaków, kończy y lub u.
        # False-positive na "odluty"/"odlot" możliwy, ale te rzadko jako napis
        # na samochodzie. Per logbook: śmieciarka MPO 1×/tydzień jest częstsze.
        r"\bo[dt][a-z]{2,5}[yu]\b",
    ],
}


# Operator (firma wywożąca) — independent from category. A REMONDIS truck
# can collect SZKŁO today and ZMIESZANE tomorrow; the assistant query
# "kiedy ostatnio śmieciarka REMONDIS" is logged by operator regardless of
# fraction. PL market is fragmented — keep the top 6 + escape-hatch MIEJSKIE
# (city utility, label e.g. "MPGK"/"MPO" varies by city).
WASTE_OPERATORS: dict[str, list[str]] = {
    # REMONDIS — POC 2026-05-19 observed OCR output 'RMONDS'/'REMONDS' on a
    # real Łódź photo (compressed JPEG, motion). The 'I' is the most fragile
    # letter (thin glyph). We add tolerant alternates so a missed I (or both
    # E and I) still resolves to the canonical operator.
    "REMONDIS":  [r"\bREMONDIS\b", r"\bR[EO]?MONDIS?\b", r"\bREMOND[SI]+\b"],
    "STENA":     [r"\bSTENA\b"],
    "ZGOK":      [r"\bZGOK\b"],
    "AMEST":     [r"\bAMEST\b"],
    "FBSERWIS":  [r"\bFBSERWIS\b", r"\bFB\s*SERWIS\b"],
    # MPGK = Miejskie Przedsiębiorstwo Gospodarki Komunalnej (varies by city).
    # MPO  = Miejskie Przedsiębiorstwo Oczyszczania (Warszawa). Both bucket
    # into a generic "MIEJSKIE" operator — assistant can refine later when
    # we know which city the building is in.
    # MPO Warszawa w klatce 10:04 (Villa Natura) OCR przeczytał jako „MFO" —
    # litera P została pomylona z F (środkowa pętla w P bywa cienka, zlewa
    # się z F po kompresji JPEG). „MFD" też obserwowane sporadycznie.
    # `umwarszawapl`/`um.warszawa.pl` to URL na bok śmieciarki — silny sygnał
    # warszawski operator.
    "MIEJSKIE":  [
        r"\bMPGK\b", r"\bMPO\b", r"\bZUO\b",
        r"\bM[PF][OD]\b",                  # MPO/MFO/MPD/MFD tolerance
        r"um\.?\s*warszawa\.?\s*pl",       # URL.warszawa.pl
        r"segr[eg]gu(?:j(?:em|emy)?)?",    # „segregujemy"/"segeguemy" — slogan miejskie
        # 2026-06-05 — Villa Natura 08:11 śmieciarka MPO Warszawa (plate WN1764J).
        # OCR text_raw zwrócił 3 warianty:
        #   "sgregujnosumworszowapl" (s-greg-ujnos-um-worszow-apl)
        #   "sgegujnobumworszawapl"  (s-egujnob-um-worszaw-apl)
        #   "sgregunosumworszowap]"  (s-greg-unos-um-worszow-ap])
        # Plus warianty "MPO": NFo, mE, MEE.
        # Bardziej tolerantne wzorce poniżej — vowel-fuzz (a↔o) i pattern-prefix.
        r"s\w*gr?eg[a-z]*",                # sgreg, segreg, sgegu, segregu, sgegujn
        r"[wm][ao]rsz[ao]w[ao]\s*\.?\s*pl",  # warszawapl/worszowapl/worszawapl + URL
        r"\b[MN][PF][OoDd0]\b",            # MPO/MFO/NFO/NPO/MED tolerance (N↔M, P↔F, O↔0)
        r"\b[MN][EeF][EeO]\b",             # MEE/NFE/MFE — silnie zniekształcony MPO
    ],

    # Polski rynek 2026-06-05 — dorzucone po zgłoszeniu Konrada że żadna
    # śmieciarka nie była dotąd wykryta. Większość mid-tier operatorów PL.
    "SUEZ":      [r"\bSUEZ\b", r"\bSITA\b"],            # SITA = stara nazwa SUEZ Polska
    "VEOLIA":    [r"\bVEOLIA\b"],
    "TONSMEIER": [r"\bT[ÖO]NSMEIER\b", r"\bTONSMEIER\b"],
    "ENERIS":    [r"\bENERIS\b"],
    "BYS":       [r"\bBY[ŚSŚZ]\b", r"\bBY\.?S\b"],      # BYŚ Warszawa
    "FCC":       [r"\bFCC\b", r"FCC\s+\w+"],            # FCC Środa / FCC Lublin / FCC ENVIRO
    "LEMAR":     [r"\bLEMAR\b"],
    "EKOSYSTEM": [r"\bEKO\s*SYSTEM\b", r"\bEKOSYSTEM\b"],
    "PARTNER":   [r"\bPARTNER\b\s*GOSPODAR", r"\bPARTNER\s+S[\s.]*A\b"],
    "ZGK":       [r"\bZGK\b", r"\bZGKiM\b"],            # Zakład Gospodarki Komunalnej (małe miasta)
    "PUK":       [r"\bPUK\b", r"\bP\.U\.K\b"],          # Przedsiębiorstwo Usług Komunalnych
    "ZUK":       [r"\bZUK\b", r"\bZ\.U\.K\b"],          # Zakład Usług Komunalnych
}
# Uwaga: "GENERIC_WASTE" które wcześniej było tu — przeniesione do
# WASTE_PATTERNS["MIXED"] gdzie należy semantycznie (kategoria, nie operator).


# Compile once at import — small static set, cost is negligible. Pattern
# lists kept in WASTE_PATTERNS dict for callers that want to enumerate
# categories without touching internals.
_COMPILED_CATEGORY: list[tuple[str, re.Pattern[str]]] = [
    (cat, re.compile(pat, re.IGNORECASE))
    for cat, pats in WASTE_PATTERNS.items()
    for pat in pats
]
_COMPILED_OPERATOR: list[tuple[str, re.Pattern[str]]] = [
    (op, re.compile(pat, re.IGNORECASE))
    for op, pats in WASTE_OPERATORS.items()
    for pat in pats
]


def known_categories() -> list[str]:
    """Sorted canonical category codes — used by assistant intent validator."""
    return sorted(WASTE_PATTERNS.keys())


def known_operators() -> list[str]:
    """Sorted canonical operator codes — re-exported for assistant validation."""
    return sorted(WASTE_OPERATORS.keys())


def match_waste(
    ocr_results: Iterable[tuple[str, float]],
) -> tuple[str | None, float | None, str | None]:
    """
    Pick the best (waste_category, confidence, operator) match across all
    OCR tokens for one image / one crop.

    Args:
      ocr_results: iterable of (text, conf) from EasyOCR. `conf` is 0..1.

    Returns:
      (category, conf, operator)
        category: canonical UPPERCASE ('GLASS'/'PAPER'/'PLASTIC'/'BIO'/'MIXED')
                  or None when no category-pattern matched any token.
        conf:     the OCR confidence of the highest-conf matching token,
                  None when no category matched.
        operator: canonical UPPERCASE ('REMONDIS'/'STENA'/…) or None.
                  Independent from category — a truck can show only the
                  operator name, no category, and vice-versa.

    Tie-break is by raw OCR confidence (higher wins). Sibling matches on
    different categories at the same confidence are deterministic given
    EasyOCR's left-to-right reading order.
    """
    best_cat: str | None = None
    best_conf: float = -1.0
    best_op: str | None = None
    best_op_conf: float = -1.0

    for text, conf in ocr_results:
        if not text or len(text) < 2:
            # Skip 1-char OCR tokens — noise.
            continue
        for cat, regex in _COMPILED_CATEGORY:
            if regex.search(text):
                if conf > best_conf:
                    best_cat = cat
                    best_conf = float(conf)
        for op, regex in _COMPILED_OPERATOR:
            if regex.search(text):
                # Operator score tracked separately so a strong category
                # match doesn't drown out a weaker but still-real operator.
                if conf > best_op_conf:
                    best_op = op
                    best_op_conf = float(conf)

    if best_cat is None and best_op is None:
        return (None, None, None)
    cat_conf = round(best_conf, 3) if best_cat is not None else None
    return (best_cat, cat_conf, best_op)
