#!/usr/bin/env bash
set -euo pipefail

# Xcode 26.5 is installed here on this workstation. Callers can override it.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Users/konradsz/Downloads/Xcode.app/Contents/Developer}"
test_source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/gatelynk-black-logic.XXXXXX")"
trap 'rm -rf -- "$test_build_dir"' EXIT

xcrun swiftc \
  -parse-as-library \
  -module-cache-path "$test_build_dir/module-cache" \
  "$test_source_dir/../GateLynkBlack/BlackAccessState.swift" \
  "$test_source_dir/main.swift" \
  -o "$test_build_dir/black-logic-tests"
"$test_build_dir/black-logic-tests"
