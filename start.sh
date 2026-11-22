#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 Node.js (v18+): https://nodejs.org/"
  exit 1
fi

if ! command -v agy >/dev/null 2>&1; then
  echo "[错误] 未检测到 agy 命令，请先安装并登录 Antigravity CLI。"
  exit 1
fi

if [ -n "$1" ]; then
  exec node server.js --open --cwd "$1"
else
  exec node server.js --open
fi
