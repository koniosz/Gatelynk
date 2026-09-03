#!/usr/bin/env bash
#
# backup-before-macos-upgrade.sh
#
# Tworzy archiwum krytycznych danych Edge przed major macOS upgrade.
# Zapisuje do `~/gatelynk-backup-<timestamp>.tar.gz` na local home dir oraz
# (opcjonalnie) kopiuje na zdalny serwer/zewnętrzny dysk.
#
# Co backupujemy:
#  • sqlite store.db    — activation token + JWT + device configs + LPR plates + event log
#  • lpr-snapshots/     — historyczne zdjęcia LPR (30 dni TTL, ale jednak)
#  • launchd plist       — auto-start Ollama
#  • pm2 dump            — proces list dla auto-resume
#  • ollama models       — opcjonalnie (4.7 GB modelu, skip-able)
#
# Czego NIE backupujemy:
#  • node_modules        — npm install po upgrade odtwarza
#  • Edge dist           — z repo
#  • node/nvm            — reinstall jeśli potrzeba
#
# Użycie:
#   ssh shc_development@100.90.244.90 'bash -s' < backup-before-macos-upgrade.sh
#
# Albo bezpośrednio na hoście:
#   ./backup-before-macos-upgrade.sh
#
# Z opcjonalnym kopiowaniem na laptop:
#   ./backup-before-macos-upgrade.sh
#   scp ~/gatelynk-backup-*.tar.gz user@laptop:~/backups/
#
set -euo pipefail

cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

STAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_DIR="$HOME/gatelynk-backup-$STAMP"
mkdir -p "$BACKUP_DIR"

cyan "=== GateLynk Edge — backup before macOS upgrade ==="
cyan "Backup dir: $BACKUP_DIR"
echo

# ── 1. sqlite store ────────────────────────────────────────────────────────
if [ -f "$HOME/gatelynk-edge/data/store.db" ]; then
  cyan "→ sqlite store.db (activation, devices, LPR plates, event log)…"
  # Online backup via sqlite3 .backup żeby uniknąć korupcji jeśli Edge pisze
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$HOME/gatelynk-edge/data/store.db" ".backup '$BACKUP_DIR/store.db'"
  else
    # Fallback: file copy (mało prawdopodobne że Edge pisze właśnie w tej milisekundzie)
    cp "$HOME/gatelynk-edge/data/store.db" "$BACKUP_DIR/store.db"
  fi
  green "  ✓ $(du -h "$BACKUP_DIR/store.db" | cut -f1) $BACKUP_DIR/store.db"
else
  yellow "  ⚠ Brak ~/gatelynk-edge/data/store.db"
fi

# ── 2. LPR snapshots (zdjęcia, JPEG, 30-day retention) ─────────────────────
if [ -d "$HOME/gatelynk-edge/data/lpr-snapshots" ]; then
  COUNT=$(find "$HOME/gatelynk-edge/data/lpr-snapshots" -type f -name '*.jpg' 2>/dev/null | wc -l | tr -d ' ')
  cyan "→ LPR snapshots ($COUNT files)…"
  cp -R "$HOME/gatelynk-edge/data/lpr-snapshots" "$BACKUP_DIR/lpr-snapshots"
  green "  ✓ $(du -sh "$BACKUP_DIR/lpr-snapshots" | cut -f1) $BACKUP_DIR/lpr-snapshots"
fi

# ── 3. launchd plist (Ollama auto-start) ───────────────────────────────────
if [ -f "$HOME/Library/LaunchAgents/com.gatelynk.ollama.plist" ]; then
  cyan "→ launchd plist (Ollama auto-start)…"
  cp "$HOME/Library/LaunchAgents/com.gatelynk.ollama.plist" "$BACKUP_DIR/"
  green "  ✓ com.gatelynk.ollama.plist"
fi

# ── 4. pm2 dump (auto-resume po reboot) ────────────────────────────────────
if [ -d "$HOME/.pm2" ]; then
  cyan "→ pm2 ecosystem + module env (pomijam logs)…"
  tar czf "$BACKUP_DIR/pm2-state.tar.gz" \
    -C "$HOME" \
    --exclude='.pm2/logs' \
    --exclude='.pm2/pids' \
    .pm2 2>/dev/null || true
  green "  ✓ $(du -h "$BACKUP_DIR/pm2-state.tar.gz" | cut -f1) pm2-state.tar.gz"
fi

# ── 5. Ollama models — OPTIONAL (skip-able, można pobrać po upgrade) ───────
if [ -d "$HOME/.ollama/models" ] && [ "${SKIP_LLM_MODELS:-0}" != "1" ]; then
  SIZE=$(du -sm "$HOME/.ollama/models" | cut -f1)
  if [ "$SIZE" -gt 100 ]; then
    yellow "→ Ollama models (~${SIZE} MB) — pomiń przez SKIP_LLM_MODELS=1 jeśli nie chcesz"
    cp -R "$HOME/.ollama/models" "$BACKUP_DIR/ollama-models" 2>/dev/null || true
    if [ -d "$BACKUP_DIR/ollama-models" ]; then
      green "  ✓ $(du -sh "$BACKUP_DIR/ollama-models" | cut -f1) ollama-models"
    fi
  fi
fi

# ── 6. Manifest — co wzięliśmy i kiedy ─────────────────────────────────────
cat > "$BACKUP_DIR/MANIFEST.txt" <<EOF
GateLynk Edge — pre-upgrade backup
==================================
Created:    $(date)
Hostname:   $(hostname)
macOS:      $(sw_vers -productVersion)
Edge user:  $(whoami)
Node:       $(command -v node && node --version || echo "(no node)")
pm2:        $($HOME/.nvm/versions/node/*/bin/pm2 --version 2>/dev/null | head -1 || echo "(no pm2)")
Ollama:     $($HOME/bin/ollama --version 2>&1 | head -1 || echo "(no ollama)")

Contents:
$(ls -la "$BACKUP_DIR" | tail -n +2)
EOF

# ── 7. Pakowanie do single tarball ─────────────────────────────────────────
cyan "→ Pakuję wszystko do $HOME/gatelynk-backup-$STAMP.tar.gz…"
cd "$HOME"
tar czf "gatelynk-backup-$STAMP.tar.gz" "$(basename "$BACKUP_DIR")"
FINAL_SIZE=$(du -h "gatelynk-backup-$STAMP.tar.gz" | cut -f1)
green "✓ Backup ready: $HOME/gatelynk-backup-$STAMP.tar.gz ($FINAL_SIZE)"
echo
yellow "Skopiuj na laptop ZANIM puścisz macOS upgrade:"
yellow "  scp shc_development@100.90.244.90:~/gatelynk-backup-$STAMP.tar.gz ~/backups/"
echo
green "OK — możesz teraz robić upgrade macOS."
