"""
vehicle_attrs.py — atrybuty pojazdu z modelu wizyjnego (VLM przez Ollama).

Powód (2026-08-14, zgłoszenie VN): klasy COCO w YOLO są za grube dla osiedla —
van dostawczy wychodzi jako "bus"/"truck", SUV pod kątem jako "truck",
koparko-ładowarka jako "truck". Zamiast heurystyk na bbox-ach pytamy VLM
(qwen2.5vl) o crop NAJWIĘKSZEGO pojazdu w klatce: typ / marka / kolor.

Kontrakt:
    attrs = classify_vehicle(arr, detections)
    → {"kind": "osobowy|dostawczy|ciezarowka|bus|maszyna|inny",
       "make": "Mercedes"|None, "color": "bialy"|None,
       "yolo_class": "truck", "vlm_ms": 1234.5}  albo None

None gdy: wyłączone, brak pojazdu, box za mały, Ollama padła albo
odpowiedź nieparsowalna — pipeline YOLO działa wtedy jak dotychczas.

Koszt: ~1-3 s na M4 Max per klatka Z pojazdem (klatki bez pojazdu nie
kosztują nic). Wołane z detect() w tym samym wątku co OCR — te same
gwarancje serializacji (MAX_CONCURRENT_INFERENCE).
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
from typing import Any, Optional

import numpy as np
from PIL import Image

log = logging.getLogger(__name__)

VLM_ENABLED = os.environ.get("VEHICLE_VLM_ENABLED", "1") not in ("0", "false", "no")
VLM_URL = os.environ.get("VEHICLE_VLM_URL", "http://127.0.0.1:11434")
VLM_MODEL = os.environ.get("VEHICLE_VLM_MODEL", "qwen2.5vl:7b")
VLM_TIMEOUT_S = float(os.environ.get("VEHICLE_VLM_TIMEOUT_S", "25"))
# Minimalny krótszy bok bboxa — mniejsze cropy to zgadywanie, nie klasyfikacja.
VLM_MIN_BOX_PX = int(os.environ.get("VEHICLE_VLM_MIN_BOX", "110"))

VEHICLE_CLASSES = {"car", "truck", "bus"}
VALID_KINDS = {"osobowy", "dostawczy", "ciezarowka", "bus", "maszyna", "inny"}

_PROMPT = (
    "Na zdjęciu jest pojazd. Odpowiedz WYŁĄCZNIE poprawnym JSON-em o polach:\n"
    '"kind" — dokładnie jedna z wartości: "osobowy" (samochód osobowy, SUV, kombi, '
    'hatchback), "dostawczy" (van / bus dostawczy typu Sprinter, Crafter, Transit), '
    '"ciezarowka" (ciężarówka, wywrotka, TIR, śmieciarka, betoniarka), '
    '"bus" (autobus do przewozu osób), "maszyna" (koparka, ładowarka, walec, '
    'dźwig, maszyna budowlana), "inny";\n'
    '"make" — marka pojazdu (np. "Mercedes", "BMW", "Toyota", "Volvo") albo null, '
    "gdy nie widać logo ani charakterystycznego przodu/tyłu — NIE zgaduj;\n"
    '"color" — dominujący kolor nadwozia po polsku, jedno słowo (np. "bialy", '
    '"czarny", "srebrny", "szary", "czerwony", "niebieski", "zielony", "zolty", '
    '"pomaranczowy", "brazowy") albo null.\n'
    "Bez komentarzy, bez markdown — sam JSON."
)


def _pick_primary_vehicle(detections: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Największy bbox spośród klas pojazdów, o ile nie jest znaczkiem w tle."""
    best = None
    best_area = 0.0
    for d in detections:
        if d.get("class") not in VEHICLE_CLASSES:
            continue
        x, y, w, h = d["bbox"]
        if min(w, h) < VLM_MIN_BOX_PX:
            continue
        if w * h > best_area:
            best_area = w * h
            best = d
    return best


def _crop_b64(arr: np.ndarray, bbox: list[float]) -> str:
    """Crop z 8% marginesem, dłuższy bok ≤ 640 px, JPEG q85 → base64."""
    ih, iw = arr.shape[:2]
    x, y, w, h = bbox
    mx, my = w * 0.08, h * 0.08
    x0 = max(0, int(x - mx))
    y0 = max(0, int(y - my))
    x1 = min(iw, int(x + w + mx))
    y1 = min(ih, int(y + h + my))
    img = Image.fromarray(arr[y0:y1, x0:x1])
    if max(img.size) > 640:
        img.thumbnail((640, 640))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _normalize(raw: dict[str, Any]) -> Optional[dict[str, Any]]:
    kind = str(raw.get("kind") or "").strip().lower()
    # Bielikowate literówki / odmiany — mapuj na kanon zanim odrzucisz.
    aliases = {
        "ciężarówka": "ciezarowka", "truck": "ciezarowka",
        "van": "dostawczy", "autobus": "bus",
        "maszyna_budowlana": "maszyna", "maszyna budowlana": "maszyna",
        "samochod osobowy": "osobowy", "samochód osobowy": "osobowy", "car": "osobowy",
    }
    kind = aliases.get(kind, kind)
    if kind not in VALID_KINDS:
        return None
    make = raw.get("make")
    make = str(make).strip() if make and str(make).strip().lower() not in ("null", "none", "brak") else None
    if make and len(make) > 40:
        make = None
    color = raw.get("color")
    color = str(color).strip().lower() if color and str(color).strip().lower() not in ("null", "none", "brak") else None
    if color and len(color) > 20:
        color = None
    return {"kind": kind, "make": make, "color": color}


def classify_vehicle(arr: np.ndarray, detections: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not VLM_ENABLED:
        return None
    primary = _pick_primary_vehicle(detections)
    if primary is None:
        return None

    t0 = time.perf_counter()
    try:
        import httpx
        payload = {
            "model": VLM_MODEL,
            "messages": [{
                "role": "user",
                "content": _PROMPT,
                "images": [_crop_b64(arr, primary["bbox"])],
            }],
            "format": "json",
            "stream": False,
            "options": {"temperature": 0},
        }
        r = httpx.post(f"{VLM_URL}/api/chat", json=payload, timeout=VLM_TIMEOUT_S)
        r.raise_for_status()
        content = (r.json().get("message") or {}).get("content") or ""
        parsed = _normalize(json.loads(content))
        if parsed is None:
            log.warning("vehicle-vlm: nieparsowalna odpowiedź: %.200s", content)
            return None
        vlm_ms = (time.perf_counter() - t0) * 1000
        out = {**parsed, "yolo_class": primary["class"], "vlm_ms": round(vlm_ms, 1)}
        log.info(
            "vehicle-vlm: yolo=%s → kind=%s make=%s color=%s (%.0fms)",
            primary["class"], out["kind"], out["make"], out["color"], vlm_ms,
        )
        return out
    except Exception as e:  # noqa: BLE001 — VLM jest opcjonalnym wzbogaceniem
        log.warning("vehicle-vlm failed (non-fatal): %r", e)
        return None
