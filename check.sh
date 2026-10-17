#!/bin/bash
# 墨读 · 一键语法校验（无需任何 npm 依赖，只用到 node）
# 用法：在项目根目录执行   bash check.sh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js（仅用于语法校验）：https://nodejs.org"
  exit 1
fi

fail=0
for f in js/*.js sw.js; do
  [ -e "$f" ] || continue
  if node --input-type=module --check < "$f"; then
    echo "OK   $f"
  else
    echo "FAIL $f"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "全部通过（语法无误）"
else
  echo "存在语法错误，请修复后再发布"
fi
exit $fail