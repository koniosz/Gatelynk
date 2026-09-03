"""Generate synthetic positive samples for OCR brand-detection POC.

Real Edge frames (in /tmp/gatelynk-poc-frames/*.jpg) currently contain
only civilian cars / no couriers — they give us a real-world FP rate
baseline but no TP. We render synthetic 1920x1080 frames with crude
'van + brand text' so we can measure recall under controlled conditions.

This is intentionally *not* photo-realistic: it tests the upper bound of
OCR (text is clean, high-contrast, frontal). Real-world recall will be
lower; that gap is part of the recommendation in the report.
"""
from __future__ import annotations
import os, random
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = "/tmp/gatelynk-poc-frames/synthetic"
os.makedirs(OUT_DIR, exist_ok=True)

# Brand spec: (filename_stem, brand text, body_color, text_color)
SAMPLES = [
    ("dhl_van",     "DHL",      (255, 204, 0),   (220, 0, 0)),
    ("inpost_van",  "InPost",   (255, 240, 0),   (60, 60, 60)),
    ("glovo_bag",   "Glovo",    (255, 196, 0),   (10, 10, 10)),
    ("ups_van",     "UPS",      (110, 70, 30),   (255, 196, 0)),
    ("frisco_van",  "Frisco",   (40, 120, 200),  (255, 255, 255)),
    ("uber_car",    "UBER",     (20, 20, 20),    (255, 255, 255)),
    ("civilian",    "",         (60, 60, 70),    (0, 0, 0)),  # no text → expect 0 matches
]

# Common system font on macOS
FONT_PATHS = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]

def _find_font(size: int) -> ImageFont.ImageFont:
    for p in FONT_PATHS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def make_frame(stem: str, brand: str, body: tuple, text: tuple) -> str:
    """Render a 1920x1080 'street scene' with a colored van + brand text."""
    W, H = 1920, 1080
    img = Image.new("RGB", (W, H), (190, 200, 210))  # sky-ish bg
    draw = ImageDraw.Draw(img)

    # asphalt
    draw.rectangle([0, 700, W, H], fill=(80, 80, 85))
    # building hint
    draw.rectangle([0, 200, 700, 700], fill=(160, 140, 110))
    draw.rectangle([1300, 250, W, 700], fill=(140, 130, 120))

    # The "van" body — large rectangle on right half (similar size to
    # a vehicle in a Hikvision 1920x1080 frame at ~5m distance)
    vx, vy, vw, vh = 700, 360, 700, 380
    draw.rectangle([vx, vy, vx + vw, vy + vh], fill=body)
    # window
    draw.rectangle([vx + 30, vy + 30, vx + 250, vy + 180], fill=(40, 50, 70))
    # wheels
    draw.ellipse([vx + 80, vy + vh - 60, vx + 180, vy + vh + 40], fill=(20, 20, 20))
    draw.ellipse([vx + vw - 200, vy + vh - 60, vx + vw - 100, vy + vh + 40], fill=(20, 20, 20))

    # Brand text on side of van — typical size: ~80-120px tall for a
    # van filling ~30% of frame width.
    if brand:
        font_size = 120
        font = _find_font(font_size)
        # measure
        bbox = draw.textbbox((0, 0), brand, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        tx = vx + (vw - tw) // 2
        ty = vy + (vh - th) // 2 + 20
        draw.text((tx, ty), brand, fill=text, font=font)

    # CCTV-ish timestamp overlay (looks like Hikvision)
    ts_font = _find_font(28)
    draw.text((20, 20), "05-19-2026 Tue 14:21:39", fill=(255, 255, 255), font=ts_font)
    draw.text((W - 200, H - 50), "Camera 01", fill=(255, 255, 255), font=ts_font)

    path = os.path.join(OUT_DIR, f"{stem}.jpg")
    img.save(path, "JPEG", quality=88)
    return path

if __name__ == "__main__":
    print(f"Writing to {OUT_DIR}")
    for stem, brand, body, text in SAMPLES:
        p = make_frame(stem, brand, body, text)
        print(f"  {os.path.basename(p):<20} brand={brand!r:<10} bytes={os.path.getsize(p)}")
    print("Done.")
