@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 墨读 · MODU READER
cls
echo.
echo   ============================================
echo      墨读 · MODU READER
echo      正在启动本地服务...
echo   ============================================
echo.

where python >nul 2>nul
if %errorlevel% neq 0 (
  echo   没有找到 Python。
  echo   请先安装 Python 3：https://www.python.org/downloads/
  echo   安装时请勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

python server.py
pause
