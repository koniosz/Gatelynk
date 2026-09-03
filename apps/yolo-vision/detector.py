"""
YOLO inference wrapper — wraps `ultralytics.YOLO` so the FastAPI app only
talks to a small, mock-friendly surface.

Why a wrapper:
  • Lazy model load. We don't want `import detector` to download weights
    or spin up Metal/CUDA — the FastAPI startup hook does that explicitly.
  • Device auto-detect with a transparent override. `DEVICE=auto` picks
    Apple Metal on M1/M2/M3, CUDA on Linux, CPU otherwise. Setting it
    to a string forces that backend (e.g. `cpu` for debugging without
    GPU contention with Ollama on the same MacBook).
  • Warm-up. First inference is 3-5× slower than steady-state because
    of MPS kernel compilation. We do a one-shot dummy detect at startup
    so the user-visible `/detect` calls all hit the warm path.
  • Clean detection schema. ultralytics returns a tensor blob; we
    convert to `{class, conf, bbox: [x, y, w, h]}` with cls names from
    `model.names`. bbox is xywh in pixels (top-left corner + size).
"""
from __future__ import annotations

import io
import logging
import time
from typing import Any

import numpy as np
from PIL import Image, ImageFile

# Kasety Akuvox (picture.jpg) oddają JPEG-i z uciętą końcówką (brak kilku
# ostatnich bajtów strumienia). Domyślnie PIL odrzuca taki plik wyjątkiem
# „image file is truncated" i cały /detect zwraca 500 (VN, 2026-08-07).
# Tolerancja uciętych plików: PIL dopełnia brakujący fragment — przy stracie
# rzędu bajtów wpływ na detekcję jest zerowy, a pipeline przestaje się wywracać
# na źródle, którego nie kontrolujemy.
ImageFile.LOAD_TRUNCATED_IMAGES = True

from config import CONFIG, CLASS_CONF_OVERRIDES

log = logging.getLogger(__name__)


def _effective_min_conf(request_conf: float) -> float:
    """Najniższy próg jaki MUSI przejść przez model.predict().

    Whitelist/per-class filtering robimy post-hoc, więc predict() musi
    zwrócić wszystko od najniższego interesującego progu:
      min(conf z requestu, wszystkie CLASS_CONF_OVERRIDES).
    Podłoga 0.10 — niżej to czysty szum i niepotrzebny narzut NMS."""
    candidates = [request_conf, *CLASS_CONF_OVERRIDES.values()]
    return max(0.10, min(candidates))


def _apply_class_filter(
    detections: list[dict[str, Any]],
    request_conf: float,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Whitelista klas + progi per-klasa (2026-07-05).

    Reguły per detekcja:
      • klasa na whitelist  → wymagany conf >= max(request_conf, override)
      • klasa POZA whitelist → wymagany conf >= unusual_conf (default 0.80);
        jeśli przechodzi, detekcja dostaje "unusual": true (nietypowa dla
        osiedla, ale na tyle pewna że warto ją pokazać/zalogować).

    Returns: (przefiltrowane detekcje, {klasa: ile odrzucono}).
    """
    kept: list[dict[str, Any]] = []
    dropped: dict[str, int] = {}
    for d in detections:
        name = d["class"]
        conf = d["conf"]
        if name in CONFIG.class_whitelist:
            thr = max(request_conf, CLASS_CONF_OVERRIDES.get(name, 0.0))
            if conf >= thr:
                kept.append(d)
            else:
                dropped[name] = dropped.get(name, 0) + 1
        else:
            if conf >= CONFIG.unusual_conf:
                d = {**d, "unusual": True}
                kept.append(d)
            else:
                dropped[name] = dropped.get(name, 0) + 1
    return kept, dropped


def _resolve_device(pref: str) -> str:
    """Map 'auto' → best available backend. Anything else passes through."""
    if pref != "auto":
        return pref
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception as e:  # pragma: no cover — torch always installed
        log.warning("Torch device probe failed: %s", e)
    return "cpu"


class Detector:
    """
    YOLOv8 detector. Single-instance per process (model holds GPU memory).

    Usage:
      d = Detector("yolov8s.pt")
      d.warmup()
      out = d.detect(image_bytes, conf=0.25, imgsz=640)
    """

    def __init__(self, model_path: str, device: str = "auto", imgsz: int = 640):
        self.model_path = model_path
        self.device = _resolve_device(device)
        self.imgsz = imgsz
        self._model = None  # lazy

    @property
    def model(self):
        if self._model is None:
            # Import locally so module import doesn't pull in 200MB of torch.
            from ultralytics import YOLO

            log.info("Loading YOLO model: %s (device=%s)", self.model_path, self.device)
            t0 = time.perf_counter()
            self._model = YOLO(self.model_path)
            # ultralytics decides device at first predict() unless we pin it.
            # We pin it explicitly so /health doesn't lie about backend.
            try:
                self._model.to(self.device)
            except Exception as e:
                log.warning(
                    "Failed to move model to %s: %s — falling back to CPU",
                    self.device, e,
                )
                self.device = "cpu"
                self._model.to("cpu")
            log.info("Model loaded in %.1fs", time.perf_counter() - t0)
        return self._model

    def warmup(self) -> None:
        """Run a single dummy inference so the first real /detect is fast."""
        try:
            dummy = np.zeros((self.imgsz, self.imgsz, 3), dtype=np.uint8)
            t0 = time.perf_counter()
            self.model.predict(
                dummy, imgsz=self.imgsz, conf=0.5,
                device=self.device, verbose=False,
            )
            log.info("Warmup inference: %.0fms", (time.perf_counter() - t0) * 1000)
        except Exception as e:
            log.warning("Warmup failed (will retry on first request): %s", e)

    def detect(
        self,
        image_bytes: bytes,
        conf: float = 0.25,
        imgsz: int | None = None,
        with_brand: bool = False,
        with_pose: bool = False,
        camera_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Run detection on a JPEG/PNG byte string. Returns:
          {
            "detections": [{class, conf, bbox: [x, y, w, h]}],
            "summary": {class_name: count},
            "inference_ms": float,
            "image_size": [w, h],
          }
        bbox is xywh in pixels: x/y = top-left corner, w/h = box size.

        When `with_brand=True`, after YOLO we run EasyOCR on each notable crop
        (truck/bus/car/person with conf≥0.5, bbox≥100×100). Adds the fields:
          brand_detected, brand_conf,
          waste_category, waste_conf, waste_operator,  (truck-only)
          text_raw, ocr_ms

        Note: waste_* fields are populated only when YOLO labels the bbox as
        `truck`. Couriers and waste trucks both come as `truck` in COCO so the
        same OCR pass yields brand OR waste OR neither — never both, in
        practice (parcels and garbage don't share vehicles).

        Image is decoded once and the numpy array is reused for both passes —
        avoids a second JPEG-decode round-trip (~10-30ms saved).
        """
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = img.size
        arr = np.asarray(img)

        t0 = time.perf_counter()
        results = self.model.predict(
            arr,
            imgsz=imgsz or self.imgsz,
            # Whitelist/per-class progi robimy post-hoc — predict() dostaje
            # najniższy interesujący próg (patrz _effective_min_conf).
            conf=_effective_min_conf(conf),
            device=self.device,
            verbose=False,
        )
        inference_ms = (time.perf_counter() - t0) * 1000

        detections: list[dict[str, Any]] = []
        summary: dict[str, int] = {}

        # ultralytics returns a list with one Results obj for a single image.
        if results:
            res = results[0]
            names = res.names  # {int: 'person'} mapping
            if res.boxes is not None and len(res.boxes) > 0:
                # .xywh → tensor of [x_center, y_center, w, h]; we want
                # top-left corner so we subtract w/2, h/2.
                xywh = res.boxes.xywh.cpu().numpy()
                cls_arr = res.boxes.cls.cpu().numpy().astype(int)
                conf_arr = res.boxes.conf.cpu().numpy()

                for (xc, yc, bw, bh), cid, c in zip(xywh, cls_arr, conf_arr):
                    name = names.get(int(cid), str(int(cid)))
                    x = float(xc - bw / 2)
                    y = float(yc - bh / 2)
                    detections.append({
                        "class": name,
                        "conf": round(float(c), 3),
                        "bbox": [
                            round(x, 1),
                            round(y, 1),
                            round(float(bw), 1),
                            round(float(bh), 1),
                        ],
                    })
                    summary[name] = summary.get(name, 0) + 1

        # ── Whitelista + progi per-klasa (2026-07-05) ────────────────────
        detections, dropped = _apply_class_filter(detections, conf)
        summary = {}
        for d in detections:
            summary[d["class"]] = summary.get(d["class"], 0) + 1
        if dropped:
            log.info(
                "Class filter dropped: %s (whitelist=%d classes, unusual>=%.2f)",
                dropped, len(CONFIG.class_whitelist), CONFIG.unusual_conf,
            )
        unusual = [d["class"] for d in detections if d.get("unusual")]
        if unusual:
            log.warning("UNUSUAL detections kept (conf>=%.2f): %s", CONFIG.unusual_conf, unusual)

        out: dict[str, Any] = {
            "detections": detections,
            "summary": summary,
            "inference_ms": round(inference_ms, 1),
            "image_size": [w, h],
            # Diagnostyka filtra — Edge/panel ignorują nieznane pola.
            "dropped": dropped,
        }

        if with_brand:
            # Import locally so /detect without brand stays light (no EasyOCR
            # cold-start when nobody asked for it).
            from brand_detector import detect_brand_for_detections
            brand_res = detect_brand_for_detections(arr, detections)
            # Merge — top-level fields per spec. Brand fields always present
            # for compatibility; waste_* fields only meaningful when a truck
            # was OCR'd, otherwise all three are None.
            out["brand_detected"] = brand_res["brand_detected"]
            out["brand_conf"] = brand_res["brand_conf"]
            out["waste_category"] = brand_res["waste_category"]
            out["waste_conf"] = brand_res["waste_conf"]
            out["waste_operator"] = brand_res["waste_operator"]
            out["text_raw"] = brand_res["text_raw"]
            # 2026-06-02 — plate detection niezależne od typu kamery.
            # `plate_candidates`: lista [{plate, conf}] z post-process OCR.
            out["plate_candidates"] = brand_res.get("plate_candidates", [])
            out["ocr_ms"] = brand_res["ocr_ms"]
            out["ocr_crops"] = brand_res["ocr_crops"]
            out["ocr_skipped"] = brand_res["ocr_skipped"]

            # ── Atrybuty pojazdu z VLM (2026-08-14) ──────────────────────
            # Typ (osobowy/dostawczy/ciezarowka/bus/maszyna) + marka + kolor
            # dla NAJWIĘKSZEGO pojazdu w klatce. COCO myli vany z busami
            # i SUV-y z ciężarówkami — VLM na cropie rozstrzyga. Jedzie w tym
            # samym with_brand passie co OCR (te same gwarancje serializacji).
            from vehicle_attrs import classify_vehicle
            attrs = classify_vehicle(arr, detections)
            if attrs is not None:
                out["vehicle_attrs"] = attrs

        # ── Pose analysis (fall detection) — 2026-05-23 ─────────────────
        # Tylko gdy person wykryty w klatce. yolov8s-pose to ~50-80ms extra
        # na M1 Max — skip jeśli nie ma osoby (oszczędność średnio 150ms
        # per klatkę bez osoby).
        if with_pose and summary.get("person", 0) > 0:
            from fall_detector import detect_falls_in_frame
            pose_res = detect_falls_in_frame(
                arr, device=self.device, conf=conf, camera_id=camera_id,
            )
            out["pose"] = {
                "persons":          pose_res["persons"],
                "max_likelihood":   pose_res["max_likelihood"],
                # 2026-07-05: fall_detected = POTWIERDZONY (persystencja
                # >= FALL_MIN_PERSIST kandydatów w oknie). fall_candidate =
                # ta klatka wygląda na upadek, ale czekamy na potwierdzenie —
                # Edge robi wtedy szybki re-check kamery.
                "fall_detected":    pose_res["fall_detected"],
                "fall_candidate":   pose_res["fall_candidate"],
                "fall_streak":      pose_res["fall_streak"],
                "details":          pose_res["details"],
                "inference_ms":     pose_res["pose_inference_ms"],
            }
            # Ramka „UPADEK" — tylko dla potwierdzonego upadku. Edge zapisze
            # ten obraz zamiast surowego snapshotu (panel/push widzi ramkę).
            if pose_res["fall_detected"]:
                from fall_detector import annotate_fall_image
                annotated = annotate_fall_image(arr, pose_res["details"])
                if annotated is not None:
                    out["pose"]["annotated_image_b64"] = annotated

        return out
