"""
apple_ocr — natywny OCR macOS (Vision framework, VNRecognizeTextRequest).

Dlaczego (2026-07-23): EasyOCR na klatkach z kamer osiedlowych produkował
głównie szum („(F7Gg", „[F769" zamiast tablic/logotypów). Apple Vision w
trybie `accurate` jest trenowany na scene-text (szyldy, napisy na pojazdach,
niskie kontrasty nocne), działa na Neural Engine (M4 Max: ~30-80 ms na crop,
bez 500 MB wag EasyOCR w RAM) i wspiera polski.

Kontrakt: `readtext(np.ndarray) -> list[(bbox_quad|None, text, conf)]` —
kształt zgodny z EasyOCR `Reader.readtext(detail=1)`, więc brand_detector
konsumuje wynik bez zmian (`_extract_pairs` czyta tylko text+conf).

Ustawienia:
  • recognitionLevel = accurate (ANE; fast jest ~2× szybszy ale gubi małe
    napisy boczne — dokładność ważniejsza, inference i tak serializowane).
  • usesLanguageCorrection = False — korekta językowa „poprawia" akronimy
    (NTFY → NIFTY, DPD → DID). Matchery (brand/waste/plate) są regex-strict,
    chcą surowych tokenów.
  • recognitionLanguages = [pl-PL, en-US] — SZKŁO/ZMIESZANE + DHL/InPost.

Import jest odroczony i failsafe: brak pyobjc / nie-macOS → `available()`
zwraca False, a brand_detector zostaje przy EasyOCR.
"""
from __future__ import annotations

import io
import logging
import threading
from typing import Any

import numpy as np

log = logging.getLogger(__name__)

_lock = threading.Lock()
_state: dict[str, Any] = {"checked": False, "ok": False, "err": None}


def available() -> bool:
    """Czy Apple Vision jest importowalne na tej maszynie (cache po 1. próbie)."""
    if _state["checked"]:
        return bool(_state["ok"])
    with _lock:
        if _state["checked"]:
            return bool(_state["ok"])
        try:
            import Vision  # noqa: F401  (pyobjc-framework-Vision)
            import Quartz  # noqa: F401  (pyobjc-framework-Quartz)
            from Foundation import NSData  # noqa: F401

            _state["ok"] = True
        except Exception as e:  # ImportError / non-darwin
            _state["ok"] = False
            _state["err"] = str(e)
            log.info("Apple Vision OCR unavailable (%s) — EasyOCR fallback", e)
        _state["checked"] = True
    return bool(_state["ok"])


def unavailable_reason() -> str | None:
    return _state.get("err")


def _cgimage_from_array(arr: np.ndarray):
    """numpy RGB → CGImage (przez PNG w pamięci — najprostsza pewna ścieżka;
    koszt enkodowania ~10-30 ms na typowym cropie, pomijalny vs inference)."""
    from Foundation import NSData
    import Quartz
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    raw = buf.getvalue()
    data = NSData.dataWithBytes_length_(raw, len(raw))
    src = Quartz.CGImageSourceCreateWithData(data, None)
    if src is None:
        return None
    return Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)


def readtext(
    img_arr: np.ndarray,
    min_conf: float = 0.0,
    languages: tuple[str, ...] = ("pl-PL", "en-US"),
) -> list[tuple[None, str, float]]:
    """
    OCR całego przekazanego obrazu (crop lub pełna klatka).

    Zwraca listę (None, text, conf) — bbox pomijamy (pipeline go nie używa),
    conf to confidence top-kandydata Vision (0..1). Przy błędzie zwraca []
    (caller loguje i ew. próbuje EasyOCR).
    """
    if not available():
        return []

    import Vision

    cgimg = _cgimage_from_array(img_arr)
    if cgimg is None:
        return []

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cgimg, None)
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(False)
    try:
        request.setRecognitionLanguages_(list(languages))
    except Exception:
        pass  # starsze macOS bez pl-PL — Vision użyje domyślnych

    ok, err = handler.performRequests_error_([request], None)
    if not ok:
        log.warning("Apple Vision OCR request failed: %s", err)
        return []

    out: list[tuple[None, str, float]] = []
    for obs in request.results() or []:
        try:
            candidates = obs.topCandidates_(1)
            if not candidates or candidates.count() == 0:
                continue
            cand = candidates.objectAtIndex_(0)
            text = str(cand.string()).strip()
            conf = float(cand.confidence())
        except Exception:
            continue
        if not text or conf < min_conf:
            continue
        out.append((None, text, conf))
    return out


def warmup() -> float:
    """Jednorazowy dry-run (mały szary obraz) — pierwsze żądanie Vision ładuje
    modele systemowe (~0.3-1 s). Zwraca czas w ms; -1 gdy niedostępne."""
    if not available():
        return -1.0
    import time

    t0 = time.perf_counter()
    dummy = np.full((64, 200, 3), 128, dtype=np.uint8)
    readtext(dummy)
    return (time.perf_counter() - t0) * 1000
