# yolo-vision

YOLOv8 object detection service for GateLynk Hikvision IP cameras.
Runs on MacBook Pro M1 Max (192.168.1.109) alongside Ollama. Apple Metal
(MPS) backend, ~50ms per snapshot, COCO 80 classes.

Edge polls every 60s: snapshot → POST /detect → store summary in
`vision_detections`. Assistant queries that table via dedicated intents.

## Quick start (LAN MacBook)

```bash
ssh ai_mac@192.168.1.109
mkdir -p ~/yolo-vision && cd ~/yolo-vision
# rsync apps/yolo-vision/ into ~/yolo-vision/ (see install section below)
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --host 0.0.0.0 --port 11500
```

## Smoke test

```bash
# Health (no GPU work)
curl -s http://192.168.1.109:11500/health | jq

# Detection on a public image
curl -s -X POST http://192.168.1.109:11500/detect \
  -H 'content-type: application/json' \
  -d '{"image_url":"https://ultralytics.com/images/bus.jpg"}' | jq .summary
# Expected: {"bus":1,"person":4}

# Detection on a Hikvision snapshot URL (digest auth)
curl -s -X POST http://192.168.1.109:11500/detect \
  -H 'content-type: application/json' \
  -d '{
    "image_url":"http://192.168.1.50/ISAPI/Streaming/channels/101/picture",
    "login":"admin","password":"<password>"
  }' | jq .
```

## API

### `GET /health`
```json
{"status":"ok","model":"yolov8s.pt","device":"mps","imgsz":640,
 "conf_default":0.25,"loaded":true}
```

### `POST /detect`

One of `image_url` / `image_base64` is required. Login/password are
forwarded to the digest-auth fetcher and never logged or persisted.

```json
{
  "image_url":     "http://camera/snapshot",   // optional
  "image_base64":  "...",                      // optional
  "login":         "admin",                    // optional
  "password":      "...",                      // optional
  "conf":          0.25,                       // optional, 0..1
  "imgsz":         640                         // optional, 128..2048
}
```

Response:
```json
{
  "detections": [
    {"class":"person", "conf":0.94, "bbox":[120.5, 200.0, 80.0, 240.0]},
    {"class":"car",    "conf":0.88, "bbox":[400.0, 350.0, 240.0, 180.0]}
  ],
  "summary":      {"person":1, "car":1},
  "inference_ms": 48.3,
  "image_size":   [1920, 1080]
}
```

`bbox` is `[x, y, w, h]` in pixels — `(x, y)` is the top-left corner.

## LaunchAgent (auto-start at login)

```bash
# On the MacBook:
cp ~/yolo-vision/com.gatelynk.yolo.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.gatelynk.yolo.plist 2>/dev/null || true
launchctl load   ~/Library/LaunchAgents/com.gatelynk.yolo.plist
launchctl list | grep gatelynk
```

Logs:
- `~/Library/Logs/yolo.out.log`
- `~/Library/Logs/yolo.err.log`

## Performance

| Stage | M1 Max (MPS) |
|-------|-------------:|
| Cold model load | 2–3 s |
| First inference (after warmup) | 60–80 ms |
| Steady-state inference | 40–55 ms |
| 60s × 3 cameras → CPU load | < 3 % |

## Out of scope

- Live RTSP processing (Edge pulls a JPEG snapshot once per minute).
- Custom class training (we use pretrained COCO 80).
- Per-class confidence thresholds (single global `conf` for now).
- TLS / mutual auth (LAN only; behind the building firewall).

## Upgrade jakości 2026-07-23 (Mac Studio M4 Max)

Zmiany (repo gotowe, deploy wymaga WŁĄCZONEGO Mac Studio):

1. **OCR: Apple Vision zamiast EasyOCR** (`apple_ocr.py`) — natywny
   `VNRecognizeTextRequest` (accurate, Neural Engine, pl+en, bez korekty
   językowej — surowe tokeny dla matcherów). EasyOCR zostaje jako fallback
   (`OCR_ENGINE=easyocr` wymusza stary silnik do porównań A/B).
2. **Detekcja**: default `MODEL_PATH=yolo11l.pt` (mAP 53.4 vs 44.9 yolov8s),
   `IMG_SIZE=960` (małe obiekty z kamer 2688×1520).
3. **Pose**: default `yolo11s-pose.pt` (fall detection, nadal CPU).

Deploy na Mac Studio — ZAWSZE przez Tailscale `lynx1@100.99.26.17`
(LAN IP jest z DHCP i zmienia się po restarcie — 2026-07-23 było .163→.141).
Gdy laptop nie ma Tailscale, Edge jako bastion (`-J shc_development@100.90.244.90`).
Python env: miniforge `/Users/lynx1/miniforge3/envs/yolo/bin` (NIE .venv):

```bash
rsync -avz --exclude='.venv' --exclude='__pycache__' \
  -e "ssh -J shc_development@100.90.244.90" \
  apps/yolo-vision/ lynx1@100.99.26.17:~/yolo-vision/

ssh -J shc_development@100.90.244.90 lynx1@100.99.26.17 '
  /Users/lynx1/miniforge3/envs/yolo/bin/pip install \
    "pyobjc-framework-Vision>=10.0" "pyobjc-framework-Quartz>=10.0" &&
  launchctl unload ~/Library/LaunchAgents/com.gatelynk.yolo.plist &&
  launchctl load ~/Library/LaunchAgents/com.gatelynk.yolo.plist'

# Weryfikacja: /health ma zwrócić "ocr":{"engine":"apple-vision",...}
curl -s http://100.99.26.17:11500/health | python3 -m json.tool
```

Uwaga: jeśli w plist są env `MODEL_PATH`/`IMG_SIZE`, nadpisują nowe
defaulty — przy deployu ustawić `IMG_SIZE=960` (lub usunąć wpis, żeby
działał default) i zostawić `MODEL_PATH=yolo11l.pt`.
