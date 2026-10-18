#!/bin/bash
# 墨读 · macOS 启动脚本（双击运行）
cd "$(dirname "$0")" || exit 1

clear
echo ""
echo "  ┌──────────────────────────────────────────┐"
echo "  │   墨 读  ·  MODU READER                  │"
echo "  │   正在启动本地服务…                      │"
echo "  └──────────────────────────────────────────┘"
echo ""

if ! command -v python3 >/dev/null 2>&1; then
  echo "  没有找到 python3。"
  echo "  macOS 请先安装 Python：https://www.python.org/downloads/"
  echo ""
  read -n 1 -s -r -p "  按任意键退出…"
  exit 1
fi

python3 server.py
