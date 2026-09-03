"""
yolo-vision FastAPI service — object detection for GateLynk cameras.

Endpoints:
  GET  /health
       → {"status":"ok","model":"yolov8s","device":"mps"}

  POST /detect
       Body (one of):
         {"image_url": "http://...", "login": "admin", "password": "..."}
         {"image_base64": "..."}
         {"image_base64": "data:image/jpeg;base64,..."}  ← also accepted
       Optional: {"conf": 0.25, "imgsz": 640}
       → {detections, summary, inference_ms, image_size}

Run:
  uvicorn app:app --host 0.0.0.0 --port 11500

In production (LaunchAgent on MacBook):
  com.gatelynk.yolo.plist → uvicorn launched at boot

Design:
  • Edge does the snapshot fetch (it already speaks Hikvision digest for
    LPR). We accept base64 from Edge so MacBook doesn't need LAN reach to
    cameras — sidesteps macOS Tahoe TCC local-network prompt.
  • /detect with image_url is provided for smoke tests / dev. Same code
    path, just runs the fetch ourselves.
"""
from __future__ import annotations

import base64
import io
import logging
import time
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

import anpr
from config import CONFIG
from detector import Detector
from snapshot import fetch_image

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("yolo-vision")

app = FastAPI(
    title="GateLynk yolo-vision",
    version="0.1.0",
    description=(
        "YOLOv8 object detection (COCO 80 classes). Pulls snapshots from "
        "Hikvision IP cameras (digest auth) or accepts base64-encoded images "
        "from Edge. Backend: Apple Metal (MPS) on M1/M2/M3."
    ),
)

# Singleton — created at startup, reused for every request.
detector: Detector | None = None

# 2026-07-03 — limiter równoległości inference. Tworzony w startup hooku
# (anyio.CapacityLimiter wymaga działającego event loopa). Default 1 =
# pełna serializacja YOLO+OCR — Edge event-driven może wysłać kilka klatek
# blisko siebie, a M1 dzieli GPU/CPU z Ollama (Bielik).
_infer_limiter = None  # type: ignore[var-annotated]


@app.on_event("startup")
async def on_startup() -> None:
    """Pre-load weights + warmup so the first /detect call is fast.

    EasyOCR is pre-warmed too (lazy import + first init takes 2-4s on M1).
    We do it eagerly during startup rather than on the first /detect call so
    the operator's 60s polling cycle on Edge isn't penalized by an OCR cold
    start. Failure is non-fatal — `/detect` without `with_brand` still works.
    """
    global detector, _infer_limiter
    import anyio
    _infer_limiter = anyio.CapacityLimiter(max(1, CONFIG.max_concurrent_inference))
    detector = Detector(
        model_path=CONFIG.model_path,
        device=CONFIG.device,
        imgsz=CONFIG.img_size,
    )
    t0 = time.perf_counter()
    detector.warmup()
    log.info(
        "Ready: model=%s device=%s warm_total=%.0fms",
        CONFIG.model_path, detector.device,
        (time.perf_counter() - t0) * 1000,
    )
    # Pre-warm OCR — Apple Vision (natywny, 2026-07-23) albo EasyOCR.
    # Gdy aktywny jest Vision, NIE inicjalizujemy EasyOCR (oszczędza ~500 MB
    # RAM i 2-4 s startu) — EasyOCR doładuje się lazy tylko przy fallbacku.
    try:
        from brand_detector import get_reader, ocr_engine_name, reader_device
        import apple_ocr
        if ocr_engine_name() == "apple-vision":
            ms = apple_ocr.warmup()
            log.info("Apple Vision OCR ready: warmup=%.0fms", ms)
        else:
            t1 = time.perf_counter()
            get_reader(prefer_gpu=(detector.device != "cpu"))
            log.info(
                "EasyOCR ready: device=%s init=%.1fs",
                reader_device(), time.perf_counter() - t1,
            )
    except Exception as e:
        log.warning("OCR pre-warm failed (will retry on first /detect): %s", e)


class DetectRequest(BaseModel):
    """
    One of image_url / image_base64 is required. login/password apply only
    to image_url and are passed straight through to the digest-auth fetcher.
    Credentials are NEVER logged or persisted by this service.

    `with_brand=True` runs EasyOCR on truck/bus/car/person crops after YOLO
    (~300-500ms per crop, skipped for crops <100×100px). Returns top-level
    `brand_detected`/`brand_conf` plus waste-truck fields
    `waste_category`/`waste_conf`/`waste_operator` (populated only when YOLO
    class is `truck`), and shared `text_raw`/`ocr_ms`. Default False — caller
    opts in per request (Edge polling sets it; raw smoke tests don't have to).

    Naming note: the flag stays `with_brand` for backwards-compat with the
    Edge service that POST's it. Waste detection rides the same OCR pass,
    no extra flag — the cost is negligible (one extra regex sweep over
    already-extracted OCR strings).
    """
    image_url: Optional[str] = Field(default=None, max_length=2000)
    image_base64: Optional[str] = Field(default=None)
    login: Optional[str] = Field(default=None, max_length=128)
    password: Optional[str] = Field(default=None, max_length=256)
    conf: float = Field(default=CONFIG.conf_threshold, ge=0.0, le=1.0)
    imgsz: Optional[int] = Field(default=None, ge=128, le=2048)
    with_brand: bool = Field(default=False)
    # 2026-05-23: fall detection via YOLOv8-pose. Opt-in (~50-80ms extra
    # na M1 Max gdy person w klatce; skip gdy brak person). Edge polluje
    # z `with_pose=True` zawsze gdy `with_brand=True` — koszt mały.
    with_pose: bool = Field(default=False)
    # 2026-07-05: identyfikator kamery (Edge deviceId). Używany do
    # per-camera PERSYSTENCJI fall-detection (>= N kandydatów w oknie).
    # Opcjonalny — brak = wspólny bucket "_global" (starszy Edge build).
    camera_id: Optional[str] = Field(default=None, max_length=128)


@app.get("/health")
async def health() -> dict:
    """Reports model + actual chosen device. No DB access, no inference.

    The `ocr` block tells the operator whether EasyOCR is loaded and on what
    device — useful when investigating a sudden latency change on Edge."""
    d = detector
    # Defer imports — /health must not pull in EasyOCR weights.
    ocr_loaded = False
    ocr_device = "not-loaded"
    ocr_engine = "unknown"
    try:
        from brand_detector import ocr_engine_name, reader_device, _reader  # type: ignore
        ocr_engine = ocr_engine_name()
        if ocr_engine == "apple-vision":
            ocr_loaded = True
            ocr_device = "ane"
        else:
            ocr_loaded = _reader is not None
            ocr_device = reader_device()
    except Exception:
        pass
    return {
        "status": "ok",
        "model": CONFIG.model_path,
        "device": d.device if d is not None else "loading",
        "imgsz": CONFIG.img_size,
        "conf_default": CONFIG.conf_threshold,
        "loaded": bool(d and d._model is not None),
        "ocr": {"engine": ocr_engine, "loaded": ocr_loaded, "device": ocr_device},
        # 2026-07-05 — konfiguracja jakości detekcji widoczna dla operatora.
        "class_whitelist": sorted(CONFIG.class_whitelist),
        "unusual_conf": CONFIG.unusual_conf,
        "fall": {
            "pose_model": CONFIG.pose_model_path,
            "likelihood_threshold": CONFIG.fall_likelihood_threshold,
            "min_person_conf": CONFIG.fall_min_person_conf,
            "min_bbox_area_pct": CONFIG.fall_min_bbox_area_pct,
            "min_persist": CONFIG.fall_min_persist,
            "persist_window_s": CONFIG.fall_persist_window_s,
        },
    }


class AnprRequest(BaseModel):
    """
    Odczyt tablicy z jednego przejazdu. `images_base64` / `image_urls` to
    KLATKI TEGO SAMEGO ZDARZENIA — im więcej, tym pewniejszy wynik, bo
    zgodność między klatkami jest najsilniejszym sygnałem poprawności.
    Dane logowania dotyczą wyłącznie `image_urls` i nigdy nie są logowane.
    """
    images_base64: list[str] = Field(default_factory=list)
    image_urls: list[str] = Field(default_factory=list)
    login: Optional[str] = None
    password: Optional[str] = None
    min_conf: float = Field(default=anpr.DEFAULT_MIN_CONF, ge=0.0, le=1.0)


@app.post("/anpr")
async def anpr_read(req: AnprRequest) -> dict:
    """
    Czyta tablicę rejestracyjną z klatek — dla kamer, które nie oddają
    odczytu własnym API (patrz `anpr.py`).

    Zwraca `plate=null` gdy nic nie przekroczyło progu; `below_threshold`
    odróżnia „nic nie widać" od „coś widać, ale za słabo" — to rozróżnienie
    jest istotne przy strojeniu progu na obiekcie.
    """
    frames: list[Any] = []
    frame_bytes: list[bytes] = []   # oryginalne bajty — detektor dekoduje sam
    errors: list[str] = []

    def _add(data: bytes) -> None:
        frames.append(np.array(Image.open(io.BytesIO(data)).convert("RGB")))
        frame_bytes.append(data)

    for b64 in req.images_base64:
        try:
            if b64.startswith("data:"):
                _, _, b64 = b64.partition(",")
            data = base64.b64decode(b64, validate=False)
            if len(data) < 500:
                errors.append(f"image too small ({len(data)}B)")
                continue
            _add(data)
        except Exception as e:
            errors.append(f"base64: {e}")

    for url in req.image_urls:
        try:
            _add(await fetch_image(
                url=url, login=req.login, password=req.password,
                timeout_s=CONFIG.snapshot_timeout,
            ))
        except Exception as e:
            errors.append(f"fetch: {e}")

    if not frames:
        raise HTTPException(400, f"no usable frames ({'; '.join(errors) or 'none provided'})")

    # Najpierw znajdź pojazd, potem czytaj tablicę — bez tego OCR odczytuje
    # głównie nakładkę OSD z datą, bo jest większa i ostrzejsza niż tablica
    # (zmierzone na obiekcie VN). YOLO jest opcjonalne: gdy detektor nie
    # wstał, `anpr` sam zejdzie do trybu pełnoklatkowego.
    vehicles_per_frame: list[list[dict]] = []
    if detector is not None:
        for raw_bytes in frame_bytes:
            try:
                det = detector.detect(raw_bytes, conf=0.3)
                vehicles_per_frame.append(det.get("detections") or [])
            except Exception as e:
                log.warning("ANPR: YOLO pass failed (%r) — pełna klatka", e)
                vehicles_per_frame.append([])

    result = anpr.read_plates(
        frames, min_conf=req.min_conf,
        vehicles_per_frame=vehicles_per_frame or None,
    )
    if errors:
        result["errors"] = errors
    return result


class SceneQuestionRequest(BaseModel):
    """Pytanie VLM o pełny kadr (2026-09-01) — patrz scene_question.py.

    `mode`: night_person | vehicle_waiting | fall_confirm | describe
    (describe wymaga `question`). Obraz TYLKO base64 — kadry dowodowe
    Edge ma już na dysku, nie ma po co przepuszczać creds do kamer.
    """
    image_base64: str
    mode: str
    question: Optional[str] = Field(default=None, max_length=600)


@app.post("/scene-question")
async def scene_question_endpoint(req: SceneQuestionRequest) -> dict:
    """
    Celowane pytanie VLM o scenę — dla korelatora zdarzeń na Edge
    (opis „co się dzieje" przy NIGHT_PERSON/VEHICLE_WAITING) i jako
    bramka potwierdzenia upadku przed pushem krytycznym (fall_confirm).
    Błąd Ollamy → 502; Edge traktuje to fail-silent (zdarzenie zostaje
    bez notki / upadek bez potwierdzenia = bez pusha).
    """
    import scene_question as sq
    b64 = req.image_base64
    if b64.startswith("data:"):
        _, _, b64 = b64.partition(",")
    try:
        return sq.ask_scene(b64, req.mode, req.question)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # Ollama down / timeout
        raise HTTPException(502, f"scene VLM failed: {e}")


@app.post("/detect")
async def detect(req: DetectRequest) -> dict:
    """
    Run YOLO on an image and return detections. Either `image_url` (we
    fetch) or `image_base64` (already on hand) must be provided.

    On error we return HTTP 400/500 with a short reason string — the
    fetcher's failed-attempts list is folded into the message so Edge logs
    show which auth/URL combos failed.
    """
    if not (req.image_url or req.image_base64):
        raise HTTPException(400, "either image_url or image_base64 is required")

    if detector is None:
        raise HTTPException(503, "detector not ready (startup not complete)")

    # ── Acquire image bytes ────────────────────────────────────────────────
    if req.image_base64:
        try:
            b64 = req.image_base64
            # Tolerate data: URLs (data:image/jpeg;base64,...)
            if b64.startswith("data:"):
                _, _, b64 = b64.partition(",")
            image_bytes = base64.b64decode(b64, validate=False)
        except Exception as e:
            raise HTTPException(400, f"invalid base64: {e}")
        if len(image_bytes) < 500:
            raise HTTPException(400, f"image too small ({len(image_bytes)}B)")
    else:
        try:
            image_bytes = await fetch_image(
                url=req.image_url or "",
                login=req.login,
                password=req.password,
                timeout_s=CONFIG.snapshot_timeout,
            )
        except RuntimeError as e:
            raise HTTPException(502, str(e))

    # ── Inference ──────────────────────────────────────────────────────────
    try:
        # Run synchronous inference in a thread so we don't block the loop —
        # important when Edge starts hitting us concurrently for 3+ cameras.
        # When `with_brand` is on the call also runs EasyOCR (still in the
        # same thread — sequential is fine because EasyOCR keeps GPU state).
        # 2026-07-03: `limiter` serializuje inference (MAX_CONCURRENT_INFERENCE,
        # default 1) — równoległe klatki czekają w kolejce zamiast walczyć
        # o MPS z Ollama. Edge ma własny min-gap, to jest druga linia obrony.
        import anyio
        result = await anyio.to_thread.run_sync(
            lambda: detector.detect(
                image_bytes,
                conf=req.conf,
                imgsz=req.imgsz,
                with_brand=req.with_brand,
                with_pose=req.with_pose,
                camera_id=req.camera_id,
            ),
            limiter=_infer_limiter,
        )
    except Exception as e:
        log.exception("Inference failed")
        raise HTTPException(500, f"inference error: {e}")

    return result


if __name__ == "__main__":  # pragma: no cover
    # Allows `python app.py` for ad-hoc runs; production uses uvicorn directly.
    import uvicorn
    uvicorn.run(
        "app:app",
        host=CONFIG.host,
        port=CONFIG.port,
        log_level="info",
    )
