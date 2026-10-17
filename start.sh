#!/bin/bash
# 墨读 · Linux 启动脚本
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "需要 python3，请先安装：sudo apt install python3"
  exit 1
fi
python3 server.py
