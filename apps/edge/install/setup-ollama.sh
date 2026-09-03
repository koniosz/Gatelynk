#!/usr/bin/env bash
#
# setup-ollama.sh — instalacja lokalnego LLM-a dla Edge AI Assistant.
#
# Cel: zapewnić instalatorowi możliwość zadawania pytań NL nad audytem Edge
# („Czy był dziś kurier?", „Pokaż nieznane tablice z ostatniej godziny").
# Wszystko działa lokalnie na Mac Mini — żadne dane nie wychodzą poza LAN.
#
# Sposób instalacji: direct download .app z GitHub releases, wypakowanie binarki
# do `~/bin/ollama`. NIE używamy Homebrew bo Mac Mini z `shc_development` userem
# nie ma uprawnień admin do /opt/homebrew, a Homebrew bez admin = pain.
#
# Pinned version 0.5.13 — ostatnia stabilna z wsparciem macOS 13.x (Ventura).
# Nowsze (0.6+) crashują z `GGML_ASSERT(buf_dst) failed` w Metal init na 13.x.
# Po upgrade systemu do 14+ można podnieść GLE_OLLAMA_VERSION.
#
# Idempotent — można puszczać wielokrotnie.
#
# Wymagania:
#  • macOS 13+ (testowane na 13.4 z M2)
#  • ~3 GB miejsca na dysku (binarka 175 MB + model ~2 GB)
#  • ~1.5 GB wolnej RAM na peak inference
#
# Override:
#   GLE_LLM_MODEL=llama3.2:1b ./setup-ollama.sh
#   GLE_OLLAMA_VERSION=0.6.0   ./setup-ollama.sh   (po upgrade macOS!)
#
set -euo pipefail

MODEL="${GLE_LLM_MODEL:-qwen2.5:3b}"
OLLAMA_VERSION="${GLE_OLLAMA_VERSION:-0.5.13}"
INSTALL_DIR="$HOME/bin"

cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }

cyan "=== GateLynk Edge — Ollama setup ==="
cyan "Ollama version: $OLLAMA_VERSION"
cyan "Model:          $MODEL"
cyan "Install dir:    $INSTALL_DIR"
echo

mkdir -p "$INSTALL_DIR"

# ── 1. Sanity ──────────────────────────────────────────────────────────────
ARCH=$(uname -m)
[ "$ARCH" = "arm64" ] || { red "Expected arm64 (Apple Silicon), got $ARCH"; exit 1; }
green "✓ Arch arm64 (Apple Silicon)"

# ── 2. Download + extract Ollama binary ────────────────────────────────────
if [ -x "$INSTALL_DIR/ollama" ] && "$INSTALL_DIR/ollama" --version 2>&1 | grep -q "$OLLAMA_VERSION"; then
  green "✓ Ollama $OLLAMA_VERSION już zainstalowany"
else
  cyan "→ Pobieram Ollama-darwin.zip ($OLLAMA_VERSION, ~175 MB)…"
  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT
  curl -fsSL -o "$TMPDIR/Ollama-darwin.zip" \
    "https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION/Ollama-darwin.zip"
  cyan "→ Wypakowuję .app i kopiuję binarkę do $INSTALL_DIR/ollama…"
  unzip -q -o "$TMPDIR/Ollama-darwin.zip" -d "$TMPDIR/extracted/"
  BIN=$(find "$TMPDIR/extracted" -name "ollama" -type f -not -name "*.png" | head -1)
  [ -n "$BIN" ] || { red "Nie znaleziono binarki ollama w archiwum"; exit 1; }
  cp "$BIN" "$INSTALL_DIR/ollama"
  chmod +x "$INSTALL_DIR/ollama"
  green "✓ Ollama $($INSTALL_DIR/ollama --version 2>&1 | grep -o 'client version is.*' || echo $OLLAMA_VERSION)"
fi

# ── 3. Start Ollama serve (background, auto-restart przez launchd) ─────────
if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  green "✓ Ollama serve już działa (port 11434)"
else
  cyan "→ Uruchamiam ollama serve w tle…"
  nohup "$INSTALL_DIR/ollama" serve > "$HOME/ollama.log" 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
      green "✓ Ollama HTTP API gotowe (PID $(pgrep -f 'ollama serve' | head -1))"
      break
    fi
    [ "$i" -eq 10 ] && { red "Ollama nie odpowiada po 10s. Sprawdź ~/ollama.log"; exit 1; }
    sleep 1
  done
  yellow "  ⚠ Persystencja przez reboot — zainstaluj launchd plist:"
  yellow "    apps/edge/install/com.gatelynk.ollama.plist → ~/Library/LaunchAgents/"
fi

# ── 4. Pull model ──────────────────────────────────────────────────────────
if "$INSTALL_DIR/ollama" list 2>&1 | grep -q "^$MODEL"; then
  green "✓ Model $MODEL już pobrany"
else
  cyan "→ Pobieram model $MODEL (~2 GB, jednorazowo)…"
  "$INSTALL_DIR/ollama" pull "$MODEL"
  green "✓ Model $MODEL gotowy"
fi

# ── 5. Smoke test ──────────────────────────────────────────────────────────
cyan "→ Smoke test inference (cold start ~10s)…"
RESP_JSON=$(curl -sS -X POST http://localhost:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"prompt\":\"Reply with: hello world\",\"stream\":false,\"keep_alive\":\"5m\"}")
RESP=$(echo "$RESP_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("response","").strip()[:80])')
TOK_SEC=$(echo "$RESP_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); ec=d.get("eval_count",0); ed=d.get("eval_duration",1); print(f"{ec*1_000_000_000/ed:.1f}")')

if [ -n "$RESP" ]; then
  green "✓ Inference: \"$RESP\""
  green "✓ Throughput: $TOK_SEC tokens/sec"
else
  red "Inference nie zwróciła nic. Patrz ~/ollama.log"
  exit 1
fi

echo
green "════════════════════════════════════════════════════════════════"
green "  Ollama + $MODEL gotowe na http://localhost:11434"
green "  Edge AI Assistant może teraz dispatchować zapytania."
green "════════════════════════════════════════════════════════════════"
echo
yellow "Po reboot Mac Mini musisz puścić ten skrypt ponownie albo zainstalować"
yellow "launchd plist (com.gatelynk.ollama.plist) dla auto-startu."
