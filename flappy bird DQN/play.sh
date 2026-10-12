#!/usr/bin/env bash
# ============================================================================
# play.sh —— 一键用训练好的权重播一局，导出 play.gif（自动使用项目里的 venv）
#
#   ./play.sh                      # 默认：贪心策略、自动挑一局高分的、16 秒
#   ./play.sh --max-seconds 30     # 透传任意 render_demo.py 参数
#   ./play.sh --seed 7             # 指定随机种子
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
    # 兼容 Windows 的 venv 布局
    if [ -x ".venv/Scripts/python.exe" ]; then
        PY=".venv/Scripts/python.exe"
    else
        echo "✗ 没找到虚拟环境 .venv" >&2
        echo "  先执行：" >&2
        echo "    uv venv --python 3.12 .venv && uv pip install -r requirements.txt" >&2
        echo "  （或：python3 -m venv .venv && .venv/bin/pip install -r requirements.txt）" >&2
        exit 1
    fi
fi

exec "$PY" render_demo.py --ckpt runs/main/best.pt --out play.gif "$@"
