#!/bin/bash
# 墨读 · PDF 解析层纯逻辑测试（不依赖浏览器）
# 用法：bash tests/run.sh
# 原理：把 js/parse.js 复制成 _parse.mjs，让 node 按 ES module 加载（直接 node --check .js 会当 CJS）。
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js"; exit 1
fi

python3 -c "import shutil; shutil.copyfile('../js/parse.js', '_parse.mjs')" || exit 1

fail=0
node parse.test.mjs || fail=1

# 本机 rm 被沙箱接管，用 python 清理
python3 -c "import os; os.path.exists('_parse.mjs') and os.remove('_parse.mjs')"
exit $fail
