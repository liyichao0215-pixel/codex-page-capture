#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${CODEX_PAGE_CAPTURE_NODE:-}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  print -u2 "Codex Page Capture: Node.js 20+ 未安装或不在 PATH 中"
  print -u2 "请先安装 Node.js，然后重新运行此脚本。"
  exit 1
fi

exec "$NODE_BIN" "$ROOT_DIR/scripts/install.mjs" "$@"
