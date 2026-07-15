#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${CODEX_PAGE_CAPTURE_NODE:-}"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  print -u2 "Codex Page Capture: Node.js not found"
  exit 1
fi

exec "$NODE_BIN" "$ROOT_DIR/native/native-host.mjs"
