#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-ffmpeg-tahoe.sh — naprawa ffmpeg-static po macOS Tahoe (26.x) upgrade.
#
# Tło:
# Tahoe wprowadził strict TCC Local Network enforcement + per-binary
# Responsible Process scoping. ffmpeg-static (bundled w node_modules) jest
# unsigned binary, więc po Tahoe upgrade jego TCP connect do RFC1918 (np. kamery
# Hikvision na 192.168.x.x) zwraca natychmiastowy `EHOSTUNREACH errno=-65`,
# bez próby SYN. To dotyczy procesów child Edge (Node spawn ffmpeg) — bezpośredni
# ffmpeg z Terminal.app działa (Terminal ma TCC grant), ale Edge subprocess nie
# dziedziczy grantu.
#
# Fix:
# Podpisujemy ffmpeg-static ad-hoc z entitlement `com.apple.security.network.client`.
# Wtedy binary ma **własne** entitlement do outbound network — niezależne od TCC
# grantu od user-a. Działa pod każdym parent process (launchd, pm2, node spawn).
#
# Pre-Tahoe ten krok jest niepotrzebny (ffmpeg-static działał out-of-the-box).
# Po `pnpm install` / `npm install` które nadpisuje binary — trzeba uruchomić
# ten skrypt ponownie.
#
# Usage:
#   bash apps/edge/install/setup-ffmpeg-tahoe.sh
#   # lub w pełnej deploy procedure:
#   ssh shc_development@192.168.1.127 'bash ~/gatelynk-edge/install/setup-ffmpeg-tahoe.sh'
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

FFMPEG_PATH="$HOME/gatelynk-edge/node_modules/ffmpeg-static/ffmpeg"
ENTITLEMENTS_FILE="/tmp/ffmpeg.entitlements.plist"

if [[ ! -x "$FFMPEG_PATH" ]]; then
  echo "✗ ffmpeg not found at $FFMPEG_PATH"
  echo "  Run \`pnpm install\` in apps/edge first."
  exit 1
fi

# Sprawdź wersję macOS — pre-Tahoe (13.x, 14.x, 15.x) ten fix nie jest potrzebny
# ale nie szkodzi.
MAJOR=$(sw_vers -productVersion | cut -d. -f1)
if [[ "$MAJOR" -lt 26 ]]; then
  echo "⚠ macOS $MAJOR.x — Tahoe fix nie wymagany pre-26.x, ale można aplikować idempotentnie."
fi

cat > "$ENTITLEMENTS_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
</dict>
</plist>
EOF

echo "→ Signing ffmpeg with network entitlements…"
codesign \
  -s - \
  --force \
  --identifier=ffmpeg \
  --entitlements "$ENTITLEMENTS_FILE" \
  --options=runtime \
  "$FFMPEG_PATH"

echo
echo "✓ Done. Verification:"
codesign --display --verbose --entitlements - "$FFMPEG_PATH" 2>&1 | grep -E "Identifier|Signature|network\.client" | head

echo
echo "Test RTSP outbound now (po reboot Edge):"
echo "  curl -s -o /dev/null -w \"HTTP %{http_code} size=%{size_download}\\n\" \\"
echo "    -m 5 \"http://localhost:4000/devices/\$DEVICE_ID/stream\""
