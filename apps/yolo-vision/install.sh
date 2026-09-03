#!/usr/bin/env bash
# install.sh — one-shot installer for yolo-vision on the MacBook (ai_mac).
#
# Run *on the MacBook itself* (192.168.1.109). Assumes the apps/yolo-vision/
# tree was already rsync'd to ~/yolo-vision (the rsync line is in the README).
#
# Steps:
#   1. Create a Python 3.11+ venv next to the source.
#   2. Install deps (large — torch is ~2 GB).
#   3. Warm-cache the YOLOv8s weights into ~/.cache/ultralytics/.
#   4. Smoke-test /health locally.
#   5. Install + load the LaunchAgent so the service survives reboots.
#
# Idempotent: re-running upgrades deps and re-loads the agent.

set -euo pipefail

SRC="${HOME}/yolo-vision"
VENV="${SRC}/.venv"
PLIST_SRC="${SRC}/com.gatelynk.yolo.plist"
PLIST_DEST="${HOME}/Library/LaunchAgents/com.gatelynk.yolo.plist"
LOG_OUT="${HOME}/Library/Logs/yolo.out.log"
LOG_ERR="${HOME}/Library/Logs/yolo.err.log"
PORT=11500

echo "==> yolo-vision installer (src=${SRC})"

if [[ ! -d "${SRC}" ]]; then
  echo "ERROR: ${SRC} not found. Rsync apps/yolo-vision/ from your laptop first:" >&2
  echo "    rsync -av apps/yolo-vision/ ai_mac@192.168.1.109:~/yolo-vision/" >&2
  exit 1
fi

# 1) Python venv
if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "==> Creating venv at ${VENV}"
  python3 -m venv "${VENV}"
fi
"${VENV}/bin/pip" install --upgrade pip wheel

# 2) Deps
echo "==> Installing dependencies (this may take 2-3 minutes)"
"${VENV}/bin/pip" install -r "${SRC}/requirements.txt"

# 3) Warm-cache YOLOv8s weights (first import downloads ~22 MB)
echo "==> Pre-loading YOLOv8s weights"
"${VENV}/bin/python" - <<'PY'
from ultralytics import YOLO
m = YOLO("yolov8s.pt")
print("model loaded:", m.model.__class__.__name__)
PY

# 4) Smoke test — run uvicorn in the background, hit /health, then kill it
echo "==> Local smoke test on port ${PORT}"
mkdir -p "$(dirname "${LOG_OUT}")"
"${VENV}/bin/uvicorn" \
  --app-dir "${SRC}" \
  app:app --host 127.0.0.1 --port "${PORT}" \
  > /tmp/yolo-smoke.out 2> /tmp/yolo-smoke.err &
UV_PID=$!
trap 'kill ${UV_PID} 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/health" > /tmp/yolo-health.json; then
    echo "==> /health response:"
    cat /tmp/yolo-health.json; echo
    break
  fi
  sleep 0.5
done

if ! curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null; then
  echo "ERROR: /health did not respond within 30s. Last stderr:" >&2
  tail -50 /tmp/yolo-smoke.err >&2
  exit 1
fi

# Optional: detection smoke test against ultralytics' public sample
echo "==> Detect smoke test (public bus.jpg)"
curl -sf -X POST "http://127.0.0.1:${PORT}/detect" \
  -H 'content-type: application/json' \
  -d '{"image_url":"https://ultralytics.com/images/bus.jpg"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('summary:', d.get('summary'), 'inference_ms:', d.get('inference_ms'))"

kill ${UV_PID} 2>/dev/null || true
wait ${UV_PID} 2>/dev/null || true
trap - EXIT

# 5) Install LaunchAgent
echo "==> Installing LaunchAgent → ${PLIST_DEST}"
mkdir -p "$(dirname "${PLIST_DEST}")"
cp "${PLIST_SRC}" "${PLIST_DEST}"
launchctl unload "${PLIST_DEST}" 2>/dev/null || true
launchctl load   "${PLIST_DEST}"

sleep 2
echo "==> LaunchAgent status:"
launchctl list | grep gatelynk.yolo || echo "  (not yet listed — first start can take 5-10s for MPS init)"

echo
echo "==> Done. Service should now be listening on http://0.0.0.0:${PORT}"
echo "    Logs:  tail -f ${LOG_OUT} ${LOG_ERR}"
echo "    Test:  curl http://192.168.1.109:${PORT}/health"
