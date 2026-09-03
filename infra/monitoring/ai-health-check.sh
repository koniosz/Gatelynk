#!/bin/bash
# Strażnik Edge AI (2026-07-30) — launchd com.gatelynk.aihealth, co 5 min.
# Sprawdza łańcuch AI i przy ZMIANIE stanu wysyła alert do Cloud
# (POST /api/monitoring/ai-health-alert → e-mail Resend do właściciela).
#
# Logika: 2× fail z rzędu → DOWN (odporność na pojedynczy czkawkę sieci);
# pierwszy sukces po DOWN → UP. Stan w ~/gatelynk-ai-health/state/.
#
# TOKEN wstawiany przy instalacji (HMAC z JWT_SECRET — patrz
# MonitoringService.tokenFor()). Skrypt celowo NIE dotyka procesów —
# tylko czyta i raportuje.

set -u
STATE_DIR="$HOME/gatelynk-ai-health/state"
LOG="$HOME/gatelynk-ai-health/aihealth.log"
CLOUD_URL="https://api.gatelynk.com/api/monitoring/ai-health-alert"
TOKEN="__MONITOR_TOKEN__"
mkdir -p "$STATE_DIR"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# check <component> <detail-gdy-DOWN> <curl-args...>
check() {
  local comp="$1"; shift
  local detail="$1"; shift
  local fail_f="$STATE_DIR/$comp.fails"
  local down_f="$STATE_DIR/$comp.down"

  if curl -s -o /dev/null --max-time 10 "$@"; then
    echo 0 > "$fail_f"
    if [ -f "$down_f" ]; then
      rm -f "$down_f"
      log "$comp UP (wróciło)"
      alert "$comp" UP "Usługa znów odpowiada."
    fi
  else
    local fails
    fails=$(( $(cat "$fail_f" 2>/dev/null || echo 0) + 1 ))
    echo "$fails" > "$fail_f"
    if [ "$fails" -ge 2 ] && [ ! -f "$down_f" ]; then
      touch "$down_f"
      log "$comp DOWN po $fails próbach"
      alert "$comp" DOWN "$detail"
    fi
  fi
}

alert() {
  local comp="$1" status="$2" detail="$3"
  curl -s --max-time 15 -X POST "$CLOUD_URL" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$TOKEN\",\"component\":\"$comp\",\"status\":\"$status\",\"detail\":\"$detail\"}" \
    >> "$LOG" 2>&1
  echo >> "$LOG"
}

# Ollama przez adres TAILNETOWY — łapie też znany tryb awarii „GUI apka
# binduje 127.0.0.1" (wtedy TS-adres nie odpowiada mimo działającego procesu).
check ollama "Mac Studio niedostępny albo Ollama binduje 127.0.0.1 (GUI app). Playbook: CLAUDE.md / reference_mac_studio_ai." \
  "http://100.99.26.17:11434/api/tags"
check yolo-vision "yolo-vision :11500 nie odpowiada (Mac Studio offline albo launchd com.gatelynk.yolo padł)." \
  "http://100.99.26.17:11500/health"
check ai-prototype "ai-prototype :8000 na Edge nie odpowiada (uvicorn padł?)." \
  "http://localhost:8000/health"
check edge-node "Edge Node :4000 nie odpowiada — UWAGA: to też domofon/LPR, nie tylko AI." \
  "http://localhost:4000/ai-engine"
