"""
ANPR własnymi siłami — odczyt tablicy z klatki, gdy kamera go nie oddaje.

Po co to istnieje (VN, 2026-08-05): kamery Hikvision DS-2CD4A26FWD-IZS/P
(DeepinView 4A, fw V5.4.5) rozpoznają tablice wyłącznie na własny użytek —
porównują z listą w pamięci i zwierają swój przekaźnik. Na zewnątrz publikują
jedynie gołe zdarzenie „wykryto pojazd", bez numeru; dane ANPR wychodzą tylko
przez zamknięte SDK producenta, a linia jest wycofana z produkcji. Zamiast
uzależniać się od tego, co producent raczy wystawić, czytamy tablicę sami:
kamera daje wyzwalacz, my dajemy odczyt.

Ta sama ścieżka działa dla DOWOLNEJ kamery dającej obraz — także zwykłej
obserwacyjnej. To celowe: uniezależnia platformę od modelu i firmware'u.

Strategia dokładności — trzy dźwignie, bo pojedyncza klatka bywa zbyt słaba:

  1. **Wiele klatek na przejazd.** Kamera ANPR robi kilkadziesiąt ujęć i
     wybiera najlepsze; my dostajemy zrzuty, więc bierzemy ich kilka i głosujemy.
     Ta sama tablica odczytana z 2+ klatek jest znacznie pewniejsza niż z jednej.
  2. **Powiększanie.** Tablica bywa mała w kadrze; OCR na powiększonym wycinku
     łapie znaki, które w oryginale się zlewają. Robimy drugie podejście,
     gdy pierwsze nic nie dało.
  3. **Wiedza o formacie.** `plate_matcher` zna kształt polskiej tablicy i
     odsiewa śmieci (nazwy marek, napisy reklamowe). To odróżnia „OCR, który
     czyta wszystko" od „czytnika tablic".

Świadome ograniczenie: NIE dorównamy dedykowanej kamerze ANPR w warunkach
trudnych (noc, duża prędkość, brudna tablica, oślepiające światła). Kamera
ANPR ma migawkę i doświetlenie IR zsynchronizowane pod tablicę — my pracujemy
na zwykłej klatce. Dlatego wynik ZAWSZE wraca z pewnością (`confidence`),
a decyzję o progu podejmuje warstwa wyżej.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import numpy as np

import brand_detector
from plate_matcher import match_plates

log = logging.getLogger("anpr")

# Poniżej tej pewności traktujemy odczyt jako niepewny. Dobrane pod polskie
# tablice: `plate_matcher` już karze znaki mylone (O↔0, I↔1, S↔5, Z↔2), więc
# 0.55 przepuszcza sensowne odczyty, a odsiewa zgadywanie.
DEFAULT_MIN_CONF = 0.55

# Powtórzenie tej samej tablicy na kolejnej klatce to najsilniejszy sygnał, że
# odczyt jest prawdziwy — losowy błąd OCR rzadko powtarza się identycznie.
AGREEMENT_BONUS = 0.15


# Klasy YOLO, w których szukamy tablicy. Motocykl i autobus też mają tablice.
VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle"}

# Tablica siedzi w dolnej części pojazdu. Obcięcie górnych ~45 % wycinka usuwa
# szybę, dach i tło — czyli większość napisów, które OCR myli z tablicą.
LOWER_PART = 0.55


def _ocr_pairs(img: np.ndarray, text_raw: list[str], aggressive: bool = False):
    raw = brand_detector._ocr_readtext(img, aggressive=aggressive)
    return brand_detector._extract_pairs(raw, text_raw)


def _plates_from_frame(
    img: np.ndarray,
    vehicles: list[dict[str, Any]] | None = None,
) -> tuple[list[tuple[str, float]], list[str]]:
    """
    Kandydaci na tablicę z jednej klatki + surowe tokeny OCR (do diagnostyki).

    `vehicles` to detekcje YOLO (bbox pojazdów). Jeśli są, czytamy WYCINKI z
    pojazdami zamiast całej klatki — to najważniejsza dźwignia jakości.
    Pomiar na obiekcie VN (2026-08-05) pokazał, dlaczego: OCR na pełnej klatce
    zwracał głównie nakładkę OSD z datą i godziną, bo napis na nakładce jest
    duży i ostry, a tablica mała. Kamera ANPR działa dokładnie tak samo —
    najpierw lokalizuje pojazd, potem czyta tablicę.
    """
    text_raw: list[str] = []
    plates: list[tuple[str, float]] = []

    for det in vehicles or []:
        if det.get("class") not in VEHICLE_CLASSES:
            continue
        crop = brand_detector._crop_array(img, det.get("bbox") or [])
        if crop is None:
            continue

        # Dolna część pojazdu — tam jest tablica.
        h = crop.shape[0]
        lower = crop[int(h * LOWER_PART):, :]
        if lower.size == 0:
            lower = crop

        # Powiększamy od razu: tablica w kadrze bramowym ma zwykle kilkadziesiąt
        # pikseli wysokości, a to za mało dla OCR bez skalowania.
        try:
            lower = brand_detector._upscale(lower, 2.0)
        except Exception:
            pass

        plates.extend(match_plates(_ocr_pairs(lower, text_raw, aggressive=True)))

    # Awaryjnie pełna klatka — gdy YOLO nic nie znalazło (pojazd ucięty przy
    # krawędzi, nietypowy kąt) albo wycinki nic nie dały.
    if not plates:
        plates = match_plates(_ocr_pairs(img, text_raw))
        if not plates:
            try:
                plates = match_plates(
                    _ocr_pairs(brand_detector._upscale(img, 2.0), text_raw, aggressive=True)
                )
            except Exception as e:
                log.warning("upscale retry failed: %r", e)

    return plates, text_raw


def read_plates(
    frames: list[np.ndarray],
    min_conf: float = DEFAULT_MIN_CONF,
    vehicles_per_frame: list[list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """
    Czyta tablicę z jednego przejazdu (jedna lub wiele klatek).

    Zwraca najlepszego kandydata + pełną listę, żeby operator mógł zobaczyć,
    co jeszcze było brane pod uwagę. `agreed_frames` mówi, na ilu klatkach
    ta sama tablica wystąpiła — to najuczciwsza miara zaufania do odczytu.
    """
    t0 = time.time()
    per_frame: list[list[tuple[str, float]]] = []
    text_raw_all: list[str] = []

    for i, img in enumerate(frames):
        vehicles = (vehicles_per_frame or [])[i] if vehicles_per_frame and i < len(vehicles_per_frame) else None
        try:
            plates, text_raw = _plates_from_frame(img, vehicles)
        except Exception as e:
            log.warning("frame %d OCR failed: %r", i, e)
            plates, text_raw = [], []
        per_frame.append(plates)
        for t in text_raw:
            if t not in text_raw_all:
                text_raw_all.append(t)

    # Głosowanie: najlepsza pewność dla tablicy + premia za każdą kolejną
    # klatkę, która ją potwierdza (pewność nigdy nie przekracza 1.0).
    best_conf: dict[str, float] = {}
    seen_in: dict[str, int] = {}
    for plates in per_frame:
        for plate, conf in plates:
            best_conf[plate] = max(best_conf.get(plate, 0.0), float(conf))
            seen_in[plate] = seen_in.get(plate, 0) + 1

    scored = [
        (plate, min(1.0, conf + AGREEMENT_BONUS * (seen_in[plate] - 1)), seen_in[plate])
        for plate, conf in best_conf.items()
    ]
    scored.sort(key=lambda x: (-x[1], -x[2], x[0]))

    top = scored[0] if scored else None
    return {
        "plate": top[0] if top and top[1] >= min_conf else None,
        "confidence": round(top[1], 3) if top else 0.0,
        "agreed_frames": top[2] if top else 0,
        "frames_analyzed": len(frames),
        "below_threshold": bool(top and top[1] < min_conf),
        "candidates": [
            {"plate": p, "confidence": round(c, 3), "frames": n} for p, c, n in scored[:5]
        ],
        "text_raw": text_raw_all[:20],
        "engine": brand_detector.ocr_engine_name(),
        "ms": int((time.time() - t0) * 1000),
    }
