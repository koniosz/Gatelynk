"""
Brand detector — wraps EasyOCR for text extraction inside YOLO bboxes.

Design (per spec + POC findings):
  • Singleton EasyOCR Reader. First init takes 2-4s on M1 Max (downloads
    detection + recognition models on first run, then cached locally). After
    init each inference is 200-500ms on a typical 256×256 crop.
  • Lazy load — we do NOT instantiate at module import. The FastAPI startup
    hook calls `get_reader()` once to pre-warm; subsequent calls are O(1).
  • English + Polish. Brand wordmarks (DHL/DPD/InPost) are pure ASCII so PL
    wouldn't help courier detection alone — but the same Reader is reused by
    `detect_waste` for SZKŁO / ZIELONE / ZMIESZANE etc. which carry diacritics
    (Ł, Ź, Ż, Ę). Reading PL costs ~2× the recognition time per crop (extra
    50MB CRAFT-PL model + bilingual decoder), still well within the 60s Edge
    polling budget. POC 2026-05-19: switching `['en']`→`['en','pl']` raised
    OCR latency on a 256×256 truck crop from ~280ms → ~520ms on M1 Max GPU.
  • Skip OCR for tiny crops. The POC measured <60px bboxes returning 0 hits at
    100% of frames — text was unreadable. We refuse anything under MIN_CROP_PX
    on either axis (default 100 — per spec).

Why GPU (mps) when available:
  • EasyOCR's recognition step is the slow part (~70% of total). MPS gives a
    2-3× speed-up on M1 Max vs CPU for a single batch.
  • If MPS init fails (rare — usually torchvision version drift) we fall back
    to CPU. The detector logs once at startup so the operator notices.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

import numpy as np
from PIL import Image

import apple_ocr
from brand_matcher import match_brand
from config import CONFIG
from waste_matcher import match_waste
from plate_matcher import match_plates

log = logging.getLogger(__name__)


# ── Wybór silnika OCR (2026-07-23) ──────────────────────────────────────────
# Apple Vision (accurate, ANE) >> EasyOCR na scene-text z kamer — patrz
# apple_ocr.py. `auto` bierze Vision gdy dostępny; EasyOCR zostaje jako
# fallback runtime'owy (błąd pojedynczego żądania Vision NIE wyłącza OCR).
def _use_apple() -> bool:
    eng = CONFIG.ocr_engine.lower()
    if eng == "easyocr":
        return False
    if eng == "apple":
        return apple_ocr.available()
    return apple_ocr.available()  # auto


def ocr_engine_name() -> str:
    """'apple-vision' | 'easyocr' — do /health i logów operatora."""
    return "apple-vision" if _use_apple() else "easyocr"


def _ocr_readtext(img: np.ndarray, aggressive: bool = False) -> list[Any]:
    """
    Jedno wejście dla wszystkich wywołań OCR w pipeline. Zwraca listę
    (bbox|None, text, conf) — kształt EasyOCR detail=1.

    aggressive=True (retry na upscale) obniża progi EasyOCR; Vision nie ma
    odpowiednika progów — accurate zawsze robi pełny pass, więc flaga jest
    dla niego neutralna.
    """
    if _use_apple():
        try:
            out = apple_ocr.readtext(img)
            # Pusta lista to legalny wynik (brak tekstu w kadrze) — fallback
            # do EasyOCR robimy tylko przy twardym wyjątku, nie przy braku hitów.
            return out
        except Exception as e:
            log.warning("Apple Vision OCR error (%s) — EasyOCR fallback for this frame", e)
    reader = get_reader()
    if aggressive:
        return reader.readtext(
            img, detail=1, paragraph=False,
            text_threshold=0.35,
            low_text=0.25,
            link_threshold=OCR_LINK_THRESHOLD,
            decoder=OCR_DECODER,
        )
    return reader.readtext(
        img, detail=1, paragraph=False,
        text_threshold=OCR_TEXT_THRESHOLD,
        low_text=OCR_LOW_TEXT,
        link_threshold=OCR_LINK_THRESHOLD,
        decoder=OCR_DECODER,
    )


# Crops smaller than this on either side are too low-res for reliable OCR —
# 100px is the empirical floor from the POC. Saves ~300-500ms per skipped
# crop, no observed accuracy loss (the skipped crops produced zero hits).
MIN_CROP_PX = 100

# Tuning EasyOCR — 2026-05-25, po fiasku z NTFY o 05:17:32 (yellow van,
# Nice To Fit You meal box). Default progi EasyOCR są skrojone pod dokumenty
# w wysokim kontraście; nasze klatki to:
#   • noc / przed świtem → low contrast, more noise
#   • boczne loga vana → small text (~30-60px) na barwionym tle
#   • krótkie akronimy bez samogłosek (NTFY, NSF, DPD, DHL) — language model
#     EasyOCR faworyzuje słownikowe słowa, więc skraca akronimy / odrzuca je
#
# Zmiany vs default:
#   • text_threshold 0.7 → 0.5 — detector przyjmuje słabsze region scores
#   • low_text 0.4 → 0.3 — agresywniejsze rozszerzanie text region (ratuje
#     przerwane krótkie napisy)
#   • decoder 'greedy' → 'beamsearch' — ~2× wolniejszy ale o ~30% lepszy
#     w recognition krótkich tokenów bez vowels
#
# Koszt: ~+200ms per crop (450ms→650ms). Przy 8 crops to ~5s — acceptable
# bo Edge polling jest co 60s.
OCR_TEXT_THRESHOLD = 0.5
OCR_LOW_TEXT = 0.3
OCR_LINK_THRESHOLD = 0.4   # default — sterylne dla nas
OCR_DECODER = "beamsearch"  # better for short OOV tokens (NTFY, NSF)

# Multi-scale OCR retry — jeśli pierwsza tura nie znalazła znanego brandu,
# spróbuj na 2× upscaled crop. Pomaga dla małych bocznych logów (text height
# 20-40px) gdzie EasyOCR's CRAFT detector zwraca słabsze regiony. Cost: tylko
# gdy brand_matcher zwrócił None — ~+400ms na klatkę, ~5% klatek dziennie.
RETRY_UPSCALE_FACTOR = 3.0   # 2.0 ratował zbyt mało — 3.0 z paragraph mode

# YOLO classes worth OCR-ing. Couriers ride trucks, vans, cars, buses; food
# delivery riders are 'person' with a 'backpack' nearby. We OCR both, the
# matcher decides if there's brand text in the crop.
OCR_CLASSES: frozenset[str] = frozenset({"truck", "bus", "car", "person"})

# Waste-truck OCR is gated to `truck` only. YOLO COCO labels municipal
# garbage trucks as plain 'truck' (no dedicated class). Cars/buses/people
# are never waste collection vehicles, so we skip them and save 200-500ms
# per crop. Also avoids false-positives like a passing bus with "GREEN"
# on an ad panel being mis-classified as BIO waste.
WASTE_OCR_CLASSES: frozenset[str] = frozenset({"truck"})


# ── Singleton reader ────────────────────────────────────────────────────────
_reader_lock = threading.Lock()
_reader = None  # type: Any
_reader_device = "unknown"


def get_reader(prefer_gpu: bool = True):
    """
    Lazy-init and return the EasyOCR Reader singleton. Thread-safe via lock —
    matters because FastAPI runs detect() in a thread pool, and a slow first
    request could otherwise spawn two concurrent EasyOCR init calls (each
    allocating ~500MB of model weights).

    `prefer_gpu` is honored on first call only. Subsequent calls return the
    already-initialized reader regardless of the flag.
    """
    global _reader, _reader_device
    if _reader is not None:
        return _reader
    with _reader_lock:
        if _reader is not None:
            return _reader
        import easyocr  # heavy import — defer until we actually need OCR

        # Decide GPU eligibility. EasyOCR uses `gpu=True` to enable CUDA;
        # for Apple Silicon (MPS) we still pass True — the underlying torch
        # call falls back to CPU if MPS isn't reachable, which is the right
        # behavior. We log what we got so operators can verify post-deploy.
        gpu = bool(prefer_gpu)
        t0 = time.perf_counter()
        # Languages: en + pl. Polish was added 2026-05-19 to OCR waste-truck
        # signage (SZKŁO, ZMIESZANE, ZIELONE, BIO) which uses Ł/Ż/Ę. EasyOCR
        # handles the bilingual reader by sharing one CRAFT detector and
        # picking the recognizer head per latin script — Polish is fully
        # compatible with English in one Reader instance (no model fork).
        try:
            _reader = easyocr.Reader(["en", "pl"], gpu=gpu, verbose=False)
            _reader_device = "gpu" if gpu else "cpu"
        except Exception as e:
            log.warning("EasyOCR GPU init failed (%s) — falling back to CPU", e)
            _reader = easyocr.Reader(["en", "pl"], gpu=False, verbose=False)
            _reader_device = "cpu"
        log.info(
            "EasyOCR ready: device=%s init=%.1fs",
            _reader_device, time.perf_counter() - t0,
        )
    return _reader


def reader_device() -> str:
    """Reports 'gpu'/'cpu'/'unknown' — surfaced in /health for ops visibility."""
    return _reader_device


def _crop_array(img_arr: np.ndarray, bbox: list[float]) -> np.ndarray | None:
    """
    Clip + crop image to `bbox = [x, y, w, h]` (top-left + size, pixels).
    Returns None when the resulting crop is too small for OCR (saves ~300ms
    per skip and avoids EasyOCR-internal warnings about tiny inputs).
    """
    h_img, w_img = img_arr.shape[:2]
    x = max(0, int(round(bbox[0])))
    y = max(0, int(round(bbox[1])))
    w = int(round(bbox[2]))
    h = int(round(bbox[3]))
    # Clamp to image bounds (YOLO sometimes emits boxes that exceed by 1-2px).
    x2 = min(w_img, x + w)
    y2 = min(h_img, y + h)
    if (x2 - x) < MIN_CROP_PX or (y2 - y) < MIN_CROP_PX:
        return None
    return img_arr[y:y2, x:x2]


def detect_brand_for_detections(
    img_arr: np.ndarray,
    detections: list[dict[str, Any]],
    conf_threshold: float = 0.5,
) -> dict[str, Any]:
    """
    For each YOLO detection whose class is in OCR_CLASSES and confidence is
    above `conf_threshold`, run EasyOCR on the crop and try to match a brand
    AND (for trucks only) a waste-collection category + operator.

    Returns:
      {
        "brand_detected": str | None,       # best brand across all crops
        "brand_conf":     float | None,     # 0..1, EasyOCR confidence
        "waste_category": str | None,       # GLASS/PAPER/PLASTIC/BIO/MIXED
        "waste_conf":     float | None,     # OCR confidence of matched token
        "waste_operator": str | None,       # REMONDIS/STENA/… or None
        "text_raw":       list[str],        # all OCR strings (deduped, ordered)
        "ocr_ms":         float,            # wall-clock time spent in OCR
        "ocr_crops":      int,              # number of crops we actually OCR'd
        "ocr_skipped":    int,              # crops we skipped (too small / wrong class)
      }

    Design notes:
      • Single reader.readtext() pass per crop — we share OCR output between
        `match_brand` and `match_waste`. No double-OCR cost.
      • Waste matching gated to YOLO class `truck` only (WASTE_OCR_CLASSES).
        Couriers (DHL/InPost) come on vans which YOLO also calls `truck`, so
        we still try `match_brand` on the same crop — a single truck crop can
        produce a brand hit OR a waste hit, never both in practice (operators
        don't ship parcels and garbage in the same vehicle).
      • Why return all OCR text: useful for debug / spotting new operator
        wordmarks we don't yet match. Cost is low — usually <10 short strings
        per frame.
    """
    if not detections:
        return _empty_result()

    best_brand: str | None = None
    best_brand_conf: float = -1.0
    best_waste: str | None = None
    best_waste_conf: float = -1.0
    best_waste_op: str | None = None
    text_raw: list[str] = []
    # 2026-06-02 — akumulujemy wszystkie OCR pairs (text, conf) ze wszystkich
    # crops + full-frame retry. Po wszystkich pętlach przepuszczamy razem
    # przez `match_plates` — jeden plate może pojawić się w jednym crop ze
    # słabą conf, a w innym z lepszą; bierzemy max per plate.
    all_ocr_pairs: list[tuple[str, float]] = []
    ocr_crops = 0
    ocr_skipped = 0
    t0 = time.perf_counter()

    for det in detections:
        cls = det.get("class")
        conf = float(det.get("conf", 0.0))
        if cls not in OCR_CLASSES or conf < conf_threshold:
            continue
        bbox = det.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        crop = _crop_array(img_arr, bbox)
        if crop is None:
            ocr_skipped += 1
            continue

        try:
            # Silnik wg configu — Apple Vision (accurate) albo EasyOCR z
            # tuningiem 2026-05-25 (beamsearch dla akronimów NTFY/NSF).
            raw = _ocr_readtext(crop)
        except Exception as e:
            log.warning("OCR failed for crop %s: %s", bbox, e)
            continue
        ocr_crops += 1

        # raw is a list of (bbox_quad, text, conf). We only need text+conf.
        ocr_pairs = _extract_pairs(raw, text_raw)
        all_ocr_pairs.extend(ocr_pairs)

        # Brand matching — runs on every eligible crop (truck/bus/car/person).
        brand, brand_conf = match_brand(ocr_pairs)

        # Multi-scale retry — gdy żadna marka nie wpadła (najczęstszy case dla
        # małych bocznych logów), spróbuj na upscaled crop. Tylko raz per crop
        # żeby nie eksplodować latencji.
        if brand is None and crop.shape[0] * crop.shape[1] >= MIN_CROP_PX * MIN_CROP_PX:
            try:
                up = _upscale(crop, RETRY_UPSCALE_FACTOR)
                # Aggressive retry: dla EasyOCR niższe progi (0.35/0.25);
                # dla Apple Vision upscale sam w sobie ratuje małe napisy.
                raw2 = _ocr_readtext(up, aggressive=True)
                pairs2 = _extract_pairs(raw2, text_raw)
                brand2, conf2 = match_brand(pairs2)
                if brand2 and conf2 is not None:
                    brand, brand_conf = brand2, conf2
                # Też domeszaj OCR pairs z upscale do brand+waste matching
                # (waste check niżej) + plate post-process na końcu.
                ocr_pairs = ocr_pairs + pairs2
                all_ocr_pairs.extend(pairs2)
            except Exception as e:
                log.debug("EasyOCR upscale retry failed: %s", e)

        if brand and brand_conf is not None and brand_conf > best_brand_conf:
            best_brand = brand
            best_brand_conf = brand_conf

        # Waste matching — trucks only. Cheap (regex over already-extracted
        # text), so the gate is purely to suppress false-positives from
        # passing buses / cars with ads, not to save CPU.
        if cls in WASTE_OCR_CLASSES:
            waste_cat, waste_conf, waste_op = match_waste(ocr_pairs)
            if (
                waste_cat
                and waste_conf is not None
                and waste_conf > best_waste_conf
            ):
                best_waste = waste_cat
                best_waste_conf = waste_conf
            # Operator is tracked independently — a truck can show just the
            # operator wordmark on the cab even when the bin-category sign
            # is occluded.
            if waste_op and best_waste_op is None:
                best_waste_op = waste_op

    # Full-frame fallback — gdy żaden crop nie złapał brandu, a w klatce
    # YOLO widzi truck/bus/van, uruchom OCR na CAŁEJ klatce. Przypadek z
    # 2026-05-25 (NTFY van pod kątem) pokazał, że YOLO truck bbox bywa
    # zbyt ciasny — np. obcina napis boczny będący poza obrysem karoserii.
    # EasyOCR na całej klatce ma CRAFT detector który sam znajduje text
    # regions niezależnie od YOLO. Cost: +500-1000ms na full HD (1520×2688),
    # ale tylko gdy mamy notable vehicle bez brand match — typowo <10%
    # klatek z wykrytymi pojazdami.
    has_courier_candidate = any(
        d.get("class") in ("truck", "bus") for d in detections
    )
    if best_brand is None and has_courier_candidate and img_arr is not None:
        try:
            raw_full = _ocr_readtext(img_arr)
            pairs_full = _extract_pairs(raw_full, text_raw)
            all_ocr_pairs.extend(pairs_full)
            brand_full, conf_full = match_brand(pairs_full)
            if brand_full and conf_full is not None:
                best_brand = brand_full
                best_brand_conf = conf_full
                log.info(
                    "Brand fallback HIT on full-frame OCR: %s (conf=%.2f)",
                    brand_full, conf_full,
                )
            # Też try waste na full-frame (czasem garbage truck logo jest tylko
            # na dachu / dalej od kadru YOLO)
            waste_cat_f, waste_conf_f, waste_op_f = match_waste(pairs_full)
            if (
                waste_cat_f
                and waste_conf_f is not None
                and waste_conf_f > best_waste_conf
            ):
                best_waste = waste_cat_f
                best_waste_conf = waste_conf_f
            if waste_op_f and best_waste_op is None:
                best_waste_op = waste_op_f
        except Exception as e:
            log.warning("Full-frame OCR fallback failed: %s", e)

    # 2026-06-02 — plate detection na ZAKKUMULOWANYCH OCR pairs ze wszystkich
    # crops + full-frame. Niezależnie od typu kamery (CAMERA/LPR_CAMERA) —
    # dla każdej klatki z YOLO truck/car/bus/person crop dostajemy listę
    # kandydatów na polską tablicę. Caller (Edge VisionDetectService) może
    # zapisać top kandydata jako tag, lub te z conf >0.6 jako pseudo-LPR
    # event (w przyszłości — MVP zwraca tylko listę).
    plate_candidates = match_plates(all_ocr_pairs)

    ocr_ms = (time.perf_counter() - t0) * 1000

    return {
        "brand_detected": best_brand,
        "brand_conf": round(best_brand_conf, 3) if best_brand else None,
        "waste_category": best_waste,
        "waste_conf": round(best_waste_conf, 3) if best_waste else None,
        "waste_operator": best_waste_op,
        "text_raw": text_raw,
        # Plate candidates: lista [{plate, conf}] po post-process (polski regex
        # + blacklist). Top-3 wystarcza dla MVP — większość klatek zwraca 0-2.
        "plate_candidates": [
            {"plate": p, "conf": c} for p, c in plate_candidates[:3]
        ],
        "ocr_ms": round(ocr_ms, 1),
        "ocr_crops": ocr_crops,
        "ocr_skipped": ocr_skipped,
    }


def _empty_result() -> dict[str, Any]:
    return {
        "brand_detected": None,
        "brand_conf": None,
        "plate_candidates": [],
        "waste_category": None,
        "waste_conf": None,
        "waste_operator": None,
        "text_raw": [],
        "ocr_ms": 0.0,
        "ocr_crops": 0,
        "ocr_skipped": 0,
    }


def _extract_pairs(
    raw: list[Any],
    text_raw_acc: list[str],
) -> list[tuple[str, float]]:
    """
    Wycina (text, conf) pary z surowego EasyOCR result + dorzuca unikatowe
    text-y do `text_raw_acc` (mutuje listę). Reużywane dla single-scale
    i upscale retry żeby nie powielać parsowania.
    """
    out: list[tuple[str, float]] = []
    for entry in raw:
        try:
            _, text, c = entry
        except Exception:
            continue
        if not isinstance(text, str):
            continue
        text = text.strip()
        if not text:
            continue
        out.append((text, float(c)))
        if text not in text_raw_acc:
            text_raw_acc.append(text)
    return out


def _upscale(crop: np.ndarray, factor: float) -> np.ndarray:
    """
    Skaluje crop bez OpenCV-dependency (PIL bilinear). Działa wystarczająco
    dobrze dla 2× upscale; dla wyższych użylibyśmy OpenCV INTER_LANCZOS4,
    ale to dodatkowa zależność której nie chcemy w yolo-vision.
    """
    h, w = crop.shape[:2]
    new_size = (int(w * factor), int(h * factor))
    img = Image.fromarray(crop)
    img = img.resize(new_size, Image.BILINEAR)
    return np.array(img)
