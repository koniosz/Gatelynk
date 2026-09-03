"""
yolo-vision config — environment-driven, no .env file mandatory.

Sensible defaults so the service starts cleanly with `uvicorn app:app` even
without a .env (model auto-downloads, port 11500, MPS auto-detect).
"""
from __future__ import annotations

import os
from dataclasses import dataclass


def _env_str(key: str, default: str) -> str:
    v = os.environ.get(key)
    return v if v and v.strip() else default


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_class_conf_map(key: str) -> dict[str, float]:
    """Parse per-class conf overrides: "person:0.35,truck:0.5" → dict.

    Nieparsowalne segmenty pomijamy (defensive — literówka w plist env nie
    może wywrócić startu serwisu)."""
    raw = os.environ.get(key, "")
    out: dict[str, float] = {}
    for seg in raw.split(","):
        seg = seg.strip()
        if not seg or ":" not in seg:
            continue
        name, _, val = seg.partition(":")
        try:
            out[name.strip().lower()] = float(val)
        except ValueError:
            continue
    return out


def _env_class_set(key: str, default: str) -> frozenset[str]:
    raw = _env_str(key, default)
    return frozenset(c.strip().lower() for c in raw.split(",") if c.strip())


# 2026-07-05 — klasy sensowne dla osiedla mieszkaniowego. COCO przy niskim
# confidence produkuje horse/train/umbrella/boat na klatkach z autami i
# pieszymi — whitelist + wysoki próg „unusual" domykają problem u źródła
# (Edge ma swój filtr conf/bbox, ale klasy spoza whitelisty przechodziły).
_DEFAULT_WHITELIST = "person,car,truck,bus,motorcycle,bicycle,cat,dog"


@dataclass(frozen=True)
class Config:
    # 2026-07-23: default yolov8s → yolo11l. Serwer AI to Mac Studio M4 Max
    # 64 GB (migracja z M1) — yolo11l @ MPS liczy klatkę w ~50-120 ms, a
    # daje wyraźnie lepszą precyzję (mAP 53.4 vs 44.9 yolov8s) — mniej
    # duchów, lepsze małe obiekty. Produkcja i tak nadpisuje MODEL_PATH
    # z Cloud/env; default ma być dobry dla świeżej instalacji.
    model_path: str = _env_str("MODEL_PATH", "yolo11l.pt")
    host: str = _env_str("HOST", "0.0.0.0")
    port: int = _env_int("PORT", 11500)
    # 2026-07-05: default 0.25 → 0.40. Przy 0.25 COCO zwracało false-positives
    # (2× horse / train / umbrella na osiedlu). Realny próg predict() to
    # min(conf_threshold, per-class overrides) — patrz Detector._effective_min_conf.
    conf_threshold: float = _env_float("CONF_THRESHOLD", 0.40)
    # 2026-07-23: 640 → 960. Kamery dają 2688×1520; przy 640 px małe obiekty
    # (osoba przy horyzoncie, kot, tablica) tracą detale. 960 na M4 Max to
    # dalej <150 ms/klatkę przy event-driven wywołaniach.
    img_size: int = _env_int("IMG_SIZE", 960)
    # 2026-07-23: silnik OCR. "auto" = Apple Vision gdy dostępny (macOS +
    # pyobjc), inaczej EasyOCR. "apple" wymusza Vision, "easyocr" wymusza
    # stary silnik (np. do porównań A/B).
    ocr_engine: str = _env_str("OCR_ENGINE", "auto")
    # 'auto' → detector auto-picks (mps → cuda → cpu).
    device: str = _env_str("DEVICE", "auto")
    snapshot_timeout: int = _env_int("SNAPSHOT_TIMEOUT", 8)
    # 2026-07-03 — max równoległych inference (YOLO+OCR) w /detect.
    # M1 dzieli budżet obliczeniowy z Ollama (Bielik 11B); event-driven Edge
    # może triggerować kilka kamer blisko siebie — serializujemy inference
    # żeby nie zagłodzić LLM ani nie stackować MPS kerneli.
    max_concurrent_inference: int = _env_int("MAX_CONCURRENT_INFERENCE", 1)

    # ── Whitelista klas (2026-07-05) ────────────────────────────────────────
    # Klasy spoza whitelisty są odrzucane, CHYBA że conf >= unusual_conf —
    # wtedy zostają w detections z flagą "unusual": true (loguje je serwis,
    # Edge/panel mogą oznaczyć jako nietypowe zamiast po cichu gubić).
    class_whitelist: frozenset[str] = _env_class_set("CLASS_WHITELIST", _DEFAULT_WHITELIST)
    unusual_conf: float = _env_float("UNUSUAL_CONF_THRESHOLD", 0.80)

    # ── Fall detection (2026-07-05, hardening) ──────────────────────────────
    # 2026-07-23: default yolov8s-pose → yolo11s-pose (lepsze keypointy,
    # ta sama klasa rozmiaru; pose i tak liczy się na CPU — patrz niżej).
    pose_model_path: str = _env_str("POSE_MODEL_PATH", "yolo11s-pose.pt")
    # 2026-07-05: ultralytics ma ZNANY bug Pose na Apple MPS (issue #4031 —
    # potrafi zwracać błędne keypointy) → default CPU. Na M4 pose na CPU to
    # ~30-60ms i liczy się tylko gdy person w kadrze. "" = użyj devices
    # detektora COCO (mps).
    pose_device: str = _env_str("POSE_DEVICE", "cpu")
    # Próg likelihood per-frame żeby uznać klatkę za KANDYDATA upadku.
    # 0.5 (2/4 indykatorów) generowało fałszywki — kucanie/praca przy ziemi
    # łapie head_below_hips + low_in_frame. Default 0.75 = 3/4 indykatory.
    fall_likelihood_threshold: float = _env_float("FALL_LIKELIHOOD_THRESHOLD", 0.75)
    # Min confidence detekcji person (pose model) — poniżej nie analizujemy.
    fall_min_person_conf: float = _env_float("FALL_MIN_PERSON_CONF", 0.50)
    # Min powierzchnia bboxa osoby jako % kadru — odległe mikro-detekcje
    # (osoba 40px przy horyzoncie) nie mają wiarygodnych keypointów.
    fall_min_bbox_area_pct: float = _env_float("FALL_MIN_BBOX_AREA_PCT", 1.0)
    # PERSYSTENCJA: upadek POTWIERDZONY dopiero gdy >= N klatek-kandydatów
    # w oknie W sekund (per kamera). Edge po kandydacie robi szybki re-check
    # (~6s), więc potwierdzenie zwykle w kilkanaście sekund; okno 90s
    # pokrywa też fallback 60s keepalive gdy re-check nie przeszedł budżetu.
    fall_min_persist: int = _env_int("FALL_MIN_PERSIST", 2)
    fall_persist_window_s: int = _env_int("FALL_PERSIST_WINDOW_S", 90)


CONFIG = Config()

# Per-klasa progi confidence, np. CLASS_CONF_OVERRIDES="truck:0.45,bus:0.45".
# Poza frozen dataclass (dict jest mutable) — moduł-level, czytane raz.
CLASS_CONF_OVERRIDES: dict[str, float] = _env_class_conf_map("CLASS_CONF_OVERRIDES")
