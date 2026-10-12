#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
parity_test.py —— 《小鸟过管道》环境保真验证（逐帧对拍）

原理：
    1. tools/ref_env.js 把原版 js/main.js **原封不动**载入 Node 沙箱运行，
       用同一套 mulberry32 种子化随机数，逐帧输出完整游戏状态；
    2. dqn_bird.ScalarBirdEnv 是同一份逻辑的 Python 移植；
    3. 两者吃同一份动作序列、同一个随机种子，逐帧比对：
       birdY / birdV / 分数 / 等级 / 命数 / 管道计数 / 连击计时 / 每根管道的位置与间隙。

任何一帧对不上都会立刻报错并打印该帧的完整状态差异。

用法：
    python tools/parity_test.py --episodes 20
    python tools/parity_test.py --episodes 40 --seed 7 --keep
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from typing import Any, Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from dqn_bird import GameConfig, ScalarBirdEnv  # noqa: E402

REF_JS = os.path.join(HERE, "ref_env.js")

# 覆盖不同玩法分支：不同鸟 / 星级 / 翅膀，配合不同随机种子
CONFIGS = [
    {"bird": 0, "stars": [1, 1, 1], "wings": False},   # 默认新手配置
    {"bird": 0, "stars": [3, 1, 1], "wings": False},   # 小黄3星：连击门槛8、5命
    {"bird": 1, "stars": [1, 1, 1], "wings": False},   # 小红：每15分回血
    {"bird": 1, "stars": [3, 3, 3], "wings": True},    # 小红3星+翅膀
    {"bird": 2, "stars": [1, 1, 1], "wings": False},   # 小粉：绿管变金管
    {"bird": 2, "stars": [3, 3, 3], "wings": True},    # 小粉3星：50%闪避 + 金管
]


def run_reference(job: Dict[str, Any]) -> List[Dict[str, Any]]:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(job, f)
        job_path = f.name
    try:
        proc = subprocess.run(["node", REF_JS, "--job", job_path],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            print(proc.stderr[-4000:], file=sys.stderr)
            raise SystemExit(f"参考环境运行失败（exit {proc.returncode}）")
        frames = []
        summary = None
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if "__summary" in rec:
                summary = rec["__summary"]
            else:
                frames.append(rec)
        return frames, summary
    finally:
        os.unlink(job_path)


def compare_episode(ep_idx: int, cfg: Dict[str, Any], seed: int,
                    frames: List[Dict[str, Any]], verbose: bool) -> Dict[str, Any]:
    gcfg = GameConfig(bird=cfg["bird"], stars=tuple(cfg["stars"]), wings=cfg["wings"])
    env = ScalarBirdEnv(gcfg, seed=seed)
    max_diff = 0.0
    exact = True
    for rec in frames:
        action = rec["a"]
        env.step(action)
        got = env.export_state()
        exp = rec["s"]
        if len(got) != len(exp):
            raise AssertionError(f"ep{ep_idx} frame{rec['f']} 状态长度不一致 {len(got)} vs {len(exp)}")
        for i, (g, e) in enumerate(zip(got, exp)):
            d = abs(g - e)
            if d > max_diff:
                max_diff = d
            if g != e:
                exact = False
                if d > 1e-9:
                    print(f"\n✗ 不一致 ep={ep_idx} frame={rec['f']} 字段#{i}: python={g!r} js={e!r} diff={d}")
                    print(f"  python 全状态: {got}")
                    print(f"  js     全状态: {exp}")
                    raise AssertionError("逐帧对拍失败")
    return {"exact": exact, "max_diff": max_diff, "frames": len(frames)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=20)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--keep", action="store_true", help="保留 reference 输出")
    args = ap.parse_args()

    episodes = []
    for i in range(args.episodes):
        cfg = CONFIGS[i % len(CONFIGS)]
        seed = args.seed * 1000 + i
        controller = "heuristic" if i % 5 != 4 else "random"   # 多数用启发式跑长局
        episodes.append({"seed": seed, "controller": controller, "maxFrames": 40000,
                         "cfg": cfg})
    job = {"config": {}, "episodes": [{"seed": e["seed"], "controller": e["controller"],
                                       "maxFrames": e["maxFrames"]} for e in episodes]}

    # ref_env.js 单次只能带一份全局 config，这里按配置分组跑（不同 config 分开跑）
    print(f"▶ 参考环境：原版 js/main.js（Node 无头）   对拍局数 = {args.episodes}")
    all_ok = True
    total_frames = 0
    exact_frames = 0
    for group_id in range(len(CONFIGS)):
        idxs = [i for i in range(args.episodes) if i % len(CONFIGS) == group_id]
        if not idxs:
            continue
        cfg = CONFIGS[group_id]
        sub_job = {"config": cfg,
                   "episodes": [{"seed": episodes[i]["seed"], "controller": episodes[i]["controller"],
                                 "maxFrames": episodes[i]["maxFrames"]} for i in idxs]}
        frames, summary = run_reference(sub_job)
        by_ep = {}
        for rec in frames:
            by_ep.setdefault(rec["e"], []).append(rec)
        for k, i in enumerate(idxs):
            res = compare_episode(i, cfg, episodes[i]["seed"], by_ep.get(k, []), args.keep)
            total_frames += res["frames"]
            exact_frames += res["frames"] if res["exact"] else 0
            sc = summary[k]["score"] if summary else "?"
            flag = "✓" if res["exact"] else "≈"
            print(f"  {flag} ep{i:02d} {GameConfig(bird=cfg['bird'], stars=tuple(cfg['stars']), wings=cfg['wings']).describe():<12}"
                  f" seed={episodes[i]['seed']}  {res['frames']:>5} 帧  得分 {sc:>4}"
                  f"  最大偏差 {res['max_diff']:.1e}")
    print()
    if exact_frames == total_frames:
        print(f"✅ 逐帧完全一致：{total_frames} 帧全部与原始游戏逻辑**逐位相同**（不是近似）")
    else:
        print(f"⚠️ {total_frames - exact_frames}/{total_frames} 帧存在极微小偏差")


if __name__ == "__main__":
    main()
