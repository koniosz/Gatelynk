"""
Fall detection — geometric heuristic on YOLOv8-pose keypoints.

Architektura: po YOLO COCO detection (która zwraca bbox-y wszystkich klas),
gdy w summary jest `person`, OPCJONALNIE uruchamiamy DRUGI model `yolov8s-pose`
który zwraca 17 keypoint-ów per person (COCO-pose schema):

  0: nose            5: left_shoulder    11: left_hip
  1: left_eye        6: right_shoulder   12: right_hip
  2: right_eye       7: left_elbow       13: left_knee
  3: left_ear        8: right_elbow      14: right_knee
  4: right_ear       9: left_wrist       15: left_ankle
                    10: right_wrist     16: right_ankle

Heurystyka (per person, w sumie 4 indikatory):
  1. Bbox aspect ratio   — pionowy bbox (>1.5) = stojąca, poziomy (<0.7) = leżąca
  2. Głowa nisko vs biodra — głowa Y >= hip Y - 30px = osoba na ziemi
  3. Pion ramion          — vertical shoulder alignment = leżenie na boku
  4. Pozycja na klatce    — głowa w dolnej 1/3 frame = na ziemi/podłodze

Każdy indikator dodaje punkt. score = liczba_indikatorów / 4 (zakres 0-1).

False-positive cases (ŚWIADOME):
  • Dziecko bawi się na ziemi → high score, ale nie upadek
  • Ktoś robi pompki/jogę → poziomy bbox
  • Praca przy ziemi (sadzenie kwiatów) → niska głowa

Mitigation: temporal stability — sprawdzić czy pose pozostała stała przez
3 consecutive frames (przy 60s polling = 3 min nieruchomy upadek). To eliminuje
false-positive od chwilowych pozycji.

Performance: yolov8s-pose ~50-80ms na M1 Max. Plus tylko gdy person detected
(jak `with_brand` flag). Suma latency: COCO YOLO + pose YOLO = ~150-200ms.

Limitations:
  • COCO-pose treningowane głównie na dorosłych — dzieci/seniorzy nieco gorsza
    accuracy bo mniej reprezentowani w datasecie
  • Brak person tracking między klatkami — nie wykryje "ten sam człowiek leży
    od 10 min" cross-frame (do tego potrzeba ByteTrack/Re-ID)
  • Frame snapshot co 60s nie złapie samego upadku, tylko stan leżenia post-fall
"""
from __future__ import annotations

import base64
import io
import logging
import threading
import time
from collections import deque
from typing import Any

import numpy as np

from config import CONFIG

log = logging.getLogger(__name__)

# Singleton — lazy loaded jak _reader w brand_detector.py.
_pose_model = None

# ── Persystencja kandydatów upadku (2026-07-05) ──────────────────────────
# Per-camera deque timestampów klatek-kandydatów (likelihood >= threshold).
# Upadek POTWIERDZONY dopiero gdy >= FALL_MIN_PERSIST kandydatów w oknie
# FALL_PERSIST_WINDOW_S. Eliminuje jednoklatkowe fałszywki (kucanie,
# pochylenie po paczkę, dziecko na trawie widoczne w jednej klatce).
# In-memory — restart serwisu resetuje stan (OK: potwierdzenie wymaga
# ponownie 2 klatek, koszt = +1 cykl analizy).
_fall_history: dict[str, deque] = {}
_fall_history_lock = threading.Lock()


def _fall_streak(camera_id: str, ts: float, register: bool) -> int:
    """Streak kandydatów w oknie; `register=True` dokłada bieżącą klatkę."""
    window = CONFIG.fall_persist_window_s
    with _fall_history_lock:
        dq = _fall_history.setdefault(camera_id, deque(maxlen=32))
        if register:
            dq.append(ts)
        while dq and ts - dq[0] > window:
            dq.popleft()
        return len(dq)


def get_pose_model(model_path: str | None = None, device: str = "mps"):
    """Lazy load. Heavy import (ultralytics+torch) skipped until first call."""
    global _pose_model
    if _pose_model is None:
        from ultralytics import YOLO

        model_path = model_path or CONFIG.pose_model_path
        t0 = time.perf_counter()
        log.info("Loading pose model: %s (device=%s)", model_path, device)
        m = YOLO(model_path)
        try:
            m.to(device)
        except Exception as e:
            log.warning("Failed to move pose model to %s: %s — falling back to CPU", device, e)
            m.to("cpu")
        log.info("Pose model loaded in %.1fs", time.perf_counter() - t0)
        _pose_model = m
    return _pose_model


# COCO-pose keypoint names — order matches model output indices 0-16.
KEYPOINT_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]

# Confidence threshold per keypoint — punkty poniżej są ignorowane
# (occluded body parts). YOLOv8-pose zwykle daje 0.5-0.95 dla widocznych
# części, ~0.0-0.3 dla zasłoniętych.
KEYPOINT_CONF_THRESHOLD = 0.30


def _kp(kps: np.ndarray, name: str) -> tuple[float, float, float] | None:
    """Bezpieczny lookup keypoint po nazwie. Zwraca (x, y, conf) lub None gdy
    keypoint nie został wykryty z odpowiednią confidencją."""
    if name not in KEYPOINT_NAMES:
        return None
    idx = KEYPOINT_NAMES.index(name)
    if idx >= len(kps):
        return None
    x, y, c = float(kps[idx][0]), float(kps[idx][1]), float(kps[idx][2])
    if c < KEYPOINT_CONF_THRESHOLD:
        return None
    return (x, y, c)


def analyze_pose_for_fall(
    keypoints: np.ndarray,
    bbox: list[float],
    image_size: tuple[int, int],
) -> dict[str, Any]:
    """
    Geometryczna heurystyka per-person.

    Args:
      keypoints: ndarray shape (17, 3) — [x, y, conf] per keypoint
      bbox: [x, y, w, h] top-left + size (px)
      image_size: (width, height) całej klatki (px)

    Returns:
      {
        "fall_likelihood": 0.0-1.0,
        "indicators": ["horizontal_bbox", "head_below_hips", ...],
        "details": {...debugowe pola dla audytu}
      }
    """
    indicators: list[str] = []
    details: dict[str, Any] = {}
    _, _, bw, bh = bbox
    img_w, img_h = image_size

    # ── 1. Bbox aspect ratio ─────────────────────────────────────────────
    # Stojąca osoba: bbox pionowy, ratio (h/w) ~1.5-3.0
    # Leżąca osoba: bbox poziomy, ratio <1.0 (zwykle 0.3-0.7)
    if bw > 0:
        bbox_ratio = bh / bw
        details["bbox_ratio"] = round(bbox_ratio, 2)
        if bbox_ratio < 0.75:
            indicators.append("horizontal_bbox")

    # ── 2. Głowa nisko vs biodra ─────────────────────────────────────────
    # Stojąca osoba: nose.y << hip.y (głowa wysoko)
    # Leżąca: nose.y ≈ hip.y (± stroke) — głowa na poziomie bioder lub niżej
    nose = _kp(keypoints, "nose")
    lhip = _kp(keypoints, "left_hip")
    rhip = _kp(keypoints, "right_hip")
    if nose is not None and (lhip is not None or rhip is not None):
        hip_y = (
            ((lhip[1] if lhip else 0) + (rhip[1] if rhip else 0))
            / (int(lhip is not None) + int(rhip is not None))
        )
        head_below_threshold = hip_y - 30
        details["nose_y"] = round(nose[1], 1)
        details["hip_y"] = round(hip_y, 1)
        if nose[1] > head_below_threshold:
            indicators.append("head_below_hips")

    # ── 3. Pion ramion (leżenie na boku) ─────────────────────────────────
    # Stojąca: left_shoulder.y ≈ right_shoulder.y (poziome ramiona)
    # Leżąca na boku: shoulders pionowo ułożone (jeden nad drugim)
    ls = _kp(keypoints, "left_shoulder")
    rs = _kp(keypoints, "right_shoulder")
    if ls and rs:
        shoulder_dy = abs(ls[1] - rs[1])
        shoulder_dx = abs(ls[0] - rs[0])
        details["shoulder_dy"] = round(shoulder_dy, 1)
        details["shoulder_dx"] = round(shoulder_dx, 1)
        # Vertical alignment ratio — >0.6 = ramiona bardziej pionowe niż poziome
        if shoulder_dx > 5 and shoulder_dy / shoulder_dx > 0.6:
            indicators.append("vertical_shoulders")
        elif shoulder_dx <= 5:
            # Edge case: shoulders zlepione (extreme close-up) — skip
            pass

    # ── 4. Pozycja na klatce ─────────────────────────────────────────────
    # Głowa w dolnej 1/3 klatki = osoba na ziemi (z perspektywy kamery
    # zamontowanej wyżej niż osoby standing).
    # UWAGA: zależne od pozycji kamery — kamery wjazdowe LPR przy bramie
    # widzą osoby na poziomie wzroku, więc head w dolnej 1/3 nie zawsze
    # = leżąca. Mitigation: weight tego indykatora niżej.
    if nose is not None and img_h > 0:
        nose_y_rel = nose[1] / img_h
        details["nose_y_rel"] = round(nose_y_rel, 2)
        if nose_y_rel > 0.7:
            indicators.append("low_in_frame")

    # ── Score ────────────────────────────────────────────────────────────
    # 4 indikatory — likelihood = liczba / 4 (zakres 0-1). Threshold dla
    # alarmu (np. >= 0.5) jest decyzją UI/notify pipeline, nie tutaj.
    likelihood = round(len(indicators) / 4.0, 2)

    return {
        "fall_likelihood": likelihood,
        "indicators": indicators,
        "details": details,
    }


def detect_falls_in_frame(
    image_arr: np.ndarray,
    device: str = "mps",
    conf: float = 0.30,
    camera_id: str | None = None,
) -> dict[str, Any]:
    """
    High-level entry — run pose model + analyze każdą wykrytą osobę.

    2026-07-05 hardening:
      • osoby z conf < FALL_MIN_PERSON_CONF pomijane (mgliste detekcje),
      • bbox < FALL_MIN_BBOX_AREA_PCT % kadru pomijany (mikro-detekcje na
        horyzoncie nie mają wiarygodnych keypointów),
      • klatka jest KANDYDATEM gdy max_likelihood >= FALL_LIKELIHOOD_THRESHOLD
        (default 0.75 = 3/4 indykatory; wcześniej alarmowało już 0.5),
      • fall_detected=True dopiero przy >= FALL_MIN_PERSIST kandydatach
        w oknie FALL_PERSIST_WINDOW_S per kamera (persystencja).

    Returns:
      {
        "persons":        int,     # liczba osób PO filtrach conf/bbox
        "max_likelihood": float,   # max(fall_likelihood) per person
        "fall_candidate": bool,    # ta klatka wygląda na upadek
        "fall_streak":    int,     # ile kandydatów w bieżącym oknie
        "fall_detected":  bool,    # POTWIERDZONY (persystencja spełniona)
        "details":        [...],   # per-person analiza (bbox/conf/indicators)
        "pose_inference_ms": float,
      }

    Side effect: lazy loads pose model przy pierwszym wywołaniu; aktualizuje
    per-camera fall history (camera_id fallback "_global" gdy Edge nie
    przekazał identyfikatora — starszy build).
    """
    h, w = image_arr.shape[:2]
    frame_area = float(w * h)
    # POSE_DEVICE=cpu default (znany bug Pose na MPS, ultralytics #4031).
    device = (CONFIG.pose_device or device).strip() or device
    model = get_pose_model(device=device)

    t0 = time.perf_counter()
    results = model.predict(
        image_arr,
        conf=max(conf, CONFIG.fall_min_person_conf),
        device=device,
        verbose=False,
    )
    inference_ms = (time.perf_counter() - t0) * 1000

    persons: list[dict[str, Any]] = []
    skipped_small = 0
    skipped_lowconf = 0
    if results and len(results) > 0:
        res = results[0]
        # res.keypoints.data shape: [N_persons, 17, 3]
        if res.keypoints is not None and res.keypoints.data is not None:
            kps_all = res.keypoints.data.cpu().numpy()
            xywh = res.boxes.xywh.cpu().numpy() if res.boxes is not None else []
            confs = res.boxes.conf.cpu().numpy() if res.boxes is not None else []

            for i, (kps, box, c) in enumerate(zip(kps_all, xywh, confs)):
                if float(c) < CONFIG.fall_min_person_conf:
                    skipped_lowconf += 1
                    continue
                xc, yc, bw, bh = float(box[0]), float(box[1]), float(box[2]), float(box[3])
                if frame_area > 0 and (bw * bh) / frame_area * 100 < CONFIG.fall_min_bbox_area_pct:
                    skipped_small += 1
                    continue
                bbox_xywh = [xc - bw / 2, yc - bh / 2, bw, bh]
                analysis = analyze_pose_for_fall(kps, bbox_xywh, (w, h))
                analysis["bbox"] = [round(v, 1) for v in bbox_xywh]
                analysis["conf"] = round(float(c), 3)
                persons.append(analysis)

    max_likelihood = max((p["fall_likelihood"] for p in persons), default=0.0)
    fall_candidate = max_likelihood >= CONFIG.fall_likelihood_threshold

    cam_key = camera_id or "_global"
    now = time.time()
    streak = _fall_streak(cam_key, now, register=fall_candidate)
    fall_detected = fall_candidate and streak >= CONFIG.fall_min_persist

    if fall_candidate:
        log.warning(
            "Fall candidate cam=%s likelihood=%.2f streak=%d/%d (window=%ds) %s",
            cam_key[:8], max_likelihood, streak, CONFIG.fall_min_persist,
            CONFIG.fall_persist_window_s,
            "→ CONFIRMED FALL" if fall_detected else "→ awaiting persistence",
        )
    if skipped_small or skipped_lowconf:
        log.debug(
            "Pose filter: skipped %d small-bbox, %d low-conf persons",
            skipped_small, skipped_lowconf,
        )

    return {
        "persons":        len(persons),
        "max_likelihood": max_likelihood,
        "fall_candidate": fall_candidate,
        "fall_streak":    streak,
        "fall_detected":  fall_detected,
        "details":        persons,
        "pose_inference_ms": round(inference_ms, 1),
    }


# ── Ramka „UPADEK" na snapshocie (2026-07-05) ─────────────────────────────

def annotate_fall_image(
    image_arr: np.ndarray,
    persons: list[dict[str, Any]],
    quality: int = 88,
) -> str | None:
    """Narysuj grubą czerwoną ramkę + label „UPADEK" wokół leżących osób.

    Args:
      image_arr: RGB ndarray (H, W, 3) — ta sama tablica co do inference.
      persons: lista z `detect_falls_in_frame()["details"]` — ramkujemy
               osoby z fall_likelihood >= FALL_LIKELIHOOD_THRESHOLD
               (fallback: osoba z najwyższym likelihood, żeby potwierdzony
               upadek nigdy nie wyszedł bez ramki).

    Returns: JPEG jako base64 str (bez data: prefix) albo None przy błędzie —
    caller (Edge) wtedy zapisze surowy snapshot jak dotąd. Fail-safe: adnotacja
    nigdy nie może wywrócić /detect.
    """
    try:
        from PIL import Image, ImageDraw, ImageFont

        img = Image.fromarray(image_arr).convert("RGB")
        draw = ImageDraw.Draw(img)
        w, h = img.size

        targets = [
            p for p in persons
            if p.get("fall_likelihood", 0) >= CONFIG.fall_likelihood_threshold
        ]
        if not targets and persons:
            targets = [max(persons, key=lambda p: p.get("fall_likelihood", 0))]
        if not targets:
            return None

        # Grubość/rozmiar skalowane do rozdzielczości (czytelne na miniaturze
        # 320px ORAZ w pełnym kadrze 2688px).
        border = max(4, round(w / 220))
        font_px = max(22, round(w / 34))
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_px)
        except Exception:
            font = ImageFont.load_default()

        label = "UPADEK"
        red = (220, 20, 20)
        for p in targets:
            x, y, bw, bh = p["bbox"]
            x0, y0 = max(0, x), max(0, y)
            x1, y1 = min(w - 1, x + bw), min(h - 1, y + bh)
            draw.rectangle([x0, y0, x1, y1], outline=red, width=border)
            # Label na czerwonej plakietce nad ramką (pod ramką gdy brak
            # miejsca u góry).
            tb = draw.textbbox((0, 0), label, font=font)
            tw, th = tb[2] - tb[0], tb[3] - tb[1]
            pad = round(font_px * 0.35)
            ly0 = y0 - th - 2 * pad - border
            if ly0 < 0:
                ly0 = y1 + border
            draw.rectangle(
                [x0, ly0, x0 + tw + 2 * pad, ly0 + th + 2 * pad],
                fill=red,
            )
            draw.text(
                (x0 + pad, ly0 + pad - tb[1]),
                label, font=font, fill=(255, 255, 255),
            )

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as e:  # pragma: no cover — fail-safe
        log.warning("Fall annotation failed (raw snapshot will be used): %s", e)
        return None
