#!/usr/bin/env bash
#
# verify-after-macos-upgrade.sh
#
# Smoke test po upgrade macOS 13 → 14. Sprawdza po kolei wszystkie
# krytyczne komponenty Edge i raportuje OK / WARN / FAIL z hint-em jak
# naprawić każdy problem.
#
# Użycie:
#   ssh shc_development@100.90.244.90 'bash -s' < verify-after-macos-upgrade.sh
#
set +e  # NIE bail-out na pierwszym błędzie — chcemy zobaczyć wszystkie

pass()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn()  { printf '\033[33m⚠ %s\033[0m\n' "$*"; }
fail()  { printf '\033[31m✗ %s\033[0m\n' "$*"; }
cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }

cyan "=== GateLynk Edge — post-upgrade verification ==="
echo

# ── 1. macOS version ───────────────────────────────────────────────────────
MACOS=$(sw_vers -productVersion)
if [[ "$MACOS" == 14.* ]] || [[ "$MACOS" == 15.* ]]; then
  pass "macOS $MACOS (upgrade complete)"
else
  fail "macOS $MACOS — upgrade nie wszedł?"
fi

# ── 2. Node + nvm ──────────────────────────────────────────────────────────
NVM_NODE="$HOME/.nvm/versions/node/v22.22.2/bin/node"
if [ -x "$NVM_NODE" ]; then
  pass "Node v22 obecny: $($NVM_NODE --version)"
else
  fail "Brak Node v22 — sprawdź ~/.nvm/versions/node/"
fi

# ── 3. pm2 daemon ──────────────────────────────────────────────────────────
PM2="$HOME/.nvm/versions/node/v22.22.2/bin/pm2"
if [ -x "$PM2" ]; then
  if "$PM2" list 2>&1 | grep -q gatelynk-edge; then
    STATUS=$("$PM2" list 2>&1 | grep gatelynk-edge | awk -F'│' '{print $9}' | tr -d ' ')
    if [ "$STATUS" = "online" ]; then
      pass "pm2 → gatelynk-edge online"
    else
      warn "pm2 → gatelynk-edge status=$STATUS"
      warn "  Fix: $PM2 resurrect    (z ~/.pm2/dump.pm2)"
    fi
  else
    warn "pm2 nie zna procesu gatelynk-edge"
    warn "  Fix: $PM2 resurrect"
  fi
else
  fail "Brak pm2 — npm install -g pm2 + odtwórz proces"
fi

# ── 4. Edge HTTP API ───────────────────────────────────────────────────────
sleep 2
if curl -sf http://localhost:4000/api/system >/dev/null 2>&1; then
  RAM=$(curl -sS http://localhost:4000/api/system | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"ram\"][\"used\"]}/{d[\"ram\"][\"total\"]} MB')")
  pass "Edge HTTP API odpowiada — RAM: $RAM"
else
  fail "Edge HTTP API nie odpowiada na :4000"
  warn "  Fix: $PM2 logs gatelynk-edge --lines 30"
fi

# ── 5. Edge activation status ──────────────────────────────────────────────
ACT=$(curl -sf http://localhost:4000/activation/status 2>/dev/null)
if [ -n "$ACT" ]; then
  ACTIVATED=$(echo "$ACT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('activated', False))")
  if [ "$ACTIVATED" = "True" ]; then
    pass "Edge aktywowany (JWT zachowany z sqlite)"
  else
    warn "Edge NIE aktywowany — wymaga ponownej aktywacji z Cloud panelu"
  fi
fi

# ── 6. sqlite better-sqlite3 native module ─────────────────────────────────
if [ -d "$HOME/gatelynk-edge/node_modules/better-sqlite3" ]; then
  # Test czy bindings działają — jeśli OS-mismatch, Edge crashował-by przy starcie
  if curl -sf http://localhost:4000/devices >/dev/null 2>&1; then
    pass "better-sqlite3 OK (Edge może czytać/pisać)"
  else
    fail "better-sqlite3 prawdopodobnie sypie native bindings"
    warn "  Fix:  cd ~/gatelynk-edge && npm rebuild better-sqlite3"
    warn "        $PM2 restart gatelynk-edge"
  fi
fi

# ── 7. Ollama serve ────────────────────────────────────────────────────────
if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  MODELS=$(curl -sS http://localhost:11434/api/tags | python3 -c "import json,sys; print(', '.join(m['name'] for m in json.load(sys.stdin).get('models',[])))")
  pass "Ollama serve OK — modele: $MODELS"
else
  warn "Ollama serve nie odpowiada"
  if launchctl list 2>&1 | grep -q com.gatelynk.ollama; then
    warn "  launchd plist istnieje ale Ollama padło — sprawdź ~/ollama-launchd.log"
  else
    warn "  Fix: launchctl load ~/Library/LaunchAgents/com.gatelynk.ollama.plist"
  fi
fi

# ── 8. AI Assistant endpoint ───────────────────────────────────────────────
if curl -sf http://localhost:4000/assistant/status >/dev/null 2>&1; then
  ASSIST=$(curl -sS http://localhost:4000/assistant/status | python3 -m json.tool)
  pass "Assistant /status OK"
  echo "$ASSIST" | sed 's/^/    /'
fi

# ── 9. Cloud tunnel (WS) ───────────────────────────────────────────────────
CLOUD=$(curl -sf http://localhost:4000/api/settings/cloud 2>/dev/null)
if [ -n "$CLOUD" ]; then
  CONNECTED=$(echo "$CLOUD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('connected', False))")
  if [ "$CONNECTED" = "True" ]; then
    pass "Tunel Cloud WS połączony"
  else
    warn "Tunel Cloud rozłączony — sprawdź internet + token, reconnect za chwilę"
  fi
fi

# ── 10. LPR camera events ──────────────────────────────────────────────────
if curl -sf http://localhost:4000/lpr/reads?limit=1 >/dev/null 2>&1; then
  LATEST_TS=$(curl -sS http://localhost:4000/lpr/reads?limit=1 | python3 -c "import json,sys; r=json.load(sys.stdin).get('reads',[]); print(r[0]['ts']/1000 if r else 0)")
  if [ "$LATEST_TS" != "0" ]; then
    AGE=$(python3 -c "import time; print(int(time.time() - $LATEST_TS))")
    if [ "$AGE" -lt 7200 ]; then
      pass "LPR camera aktywny — ostatni odczyt $AGE sekund temu"
    else
      warn "LPR ostatni odczyt $AGE sekund temu (>2h)"
    fi
  fi
fi

echo
cyan "=== Verification complete ==="
echo "Jeśli wszystko ✓ — możesz dalej. Jeśli są ⚠/✗ — patrz fix hints."
