#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_demo.py —— 让训练好的 DQN 玩一局《小鸟过管道》，渲染成 GIF

用的是与真机游戏逐帧一致的 ScalarBirdEnv，画面按原版 js/main.js 的配色和几何
（天空 #4DB8E8、云、五种管道+管口、地面、小鸟+翅膀+眼睛+喙）复刻，
右侧叠加 AI 决策面板（Q(不跳) / Q(跳) 与最终选择的动作）。

用法：
    python render_demo.py --ckpt runs/main/best.pt --out docs/ai_play.gif
    python render_demo.py --ckpt runs/main/best.pt --mode heuristic --out docs/heuristic.gif
    python render_demo.py --ckpt runs/main/best.pt --bird 2 --stars 3 3 3 --max-seconds 25
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dqn_bird import (  # noqa: E402
    BGAP, BH, BPS, BW, BX, DESIGN_H, DESIGN_W, DT, GH, PW, PIPE_TYPES, PSM,
    DQNAgent, GameConfig, ScalarBirdEnv, scalar_heuristic_action, vec_heuristic_actions,
)

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
import pygame  # noqa: E402
from PIL import Image  # noqa: E402

CJK_FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
SKY = (0x4D, 0xB8, 0xE8)
GROUND_TOP = (0x4C, 0xAF, 0x50)
GROUND_BODY = (0x8B, 0x69, 0x14)
GROUND_BUSH = (0x38, 0x8E, 0x3C)
BIRD_COLORS = [((0xFF, 0xD7, 0x00), (0xFF, 0xA5, 0x00)),
               ((0xFF, 0x52, 0x52), (0xD3, 0x2F, 0x2F)),
               ((0xFF, 0x80, 0xAB), (0xE9, 0x1E, 0x63))]


def hex2rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def draw_scene(surf, env: ScalarBirdEnv, frame: int, font_big, font_small,
               qvals=None, action=None, title="", note=""):
    surf.fill(SKY)
    # 云
    for i in range(3):
        cx = int((i * 150 + frame * 0.3) % (DESIGN_W + 100) - 50)
        cy = int(45 + i * 45)
        w, h = int(40 + i * 6), int(16 + i * 2)
        cloud = pygame.Surface((w, h), pygame.SRCALPHA)
        cloud.fill((255, 255, 255, 115))
        surf.blit(cloud, (cx, cy))
    # 管道
    for p in env.pipes:
        d = PIPE_TYPES[p.type]
        c, cc = hex2rgb(d["c"]), hex2rgb(d["cc"])
        xi, yh, gap = int(p.x), int(p.top_h), int(p.gap)
        by = yh + gap
        bh = int(DESIGN_H - GH - by)
        pygame.draw.rect(surf, c, (xi, 0, int(PW), yh))
        pygame.draw.rect(surf, cc, (xi - 3, yh - 18, int(PW) + 6, 18))
        pygame.draw.rect(surf, c, (xi, by, int(PW), bh))
        pygame.draw.rect(surf, cc, (xi - 3, by, int(PW) + 6, 18))
        if d["pts"] >= 3:
            pygame.draw.rect(surf, (0xFF, 0xE0, 0x82), (xi + int(PW) // 2 - 3, yh - 26, 6, 6))
    # 地面
    gy = int(DESIGN_H - GH)
    pygame.draw.rect(surf, GROUND_TOP, (0, gy, int(DESIGN_W), GH))
    pygame.draw.rect(surf, GROUND_BODY, (0, gy + 14, int(DESIGN_W), int(GH) - 14))
    off = int(-30 + getattr(env, "ground_off", 0.0))
    for i in range(0, int(DESIGN_W) + 120, 12):
        x = i - 2 + off + 30
        if -6 <= x <= DESIGN_W:
            pygame.draw.rect(surf, GROUND_BUSH, (x, gy, 4, 8))
    # 小鸟
    if env.invincible <= 0 or int(env.invincible * 10) % 2 == 0:
        body_c, wing_c = BIRD_COLORS[env.cfg.bird]
        y = int(env.bird_y)
        wf = int(np.sin(frame * 0.24) * 4)
        pygame.draw.circle(surf, body_c, (int(BX + BW / 2), y + int(BH / 2) - 1), int(BW / 2) - 1)
        pygame.draw.circle(surf, wing_c, (int(BX + BW / 2) - 2, y + int(BH / 2) + wf), int(BW / 3))
        pygame.draw.circle(surf, (255, 255, 255), (int(BX + BW) - 8, y + 9), 6)
        pygame.draw.circle(surf, (0, 0, 0), (int(BX + BW) - 6, y + 8), 3)
        pygame.draw.polygon(surf, (0xFF, 0x66, 0x00),
                            [(int(BX + BW), y + 12), (int(BX + BW) + 8, y + 16), (int(BX + BW), y + 20)])
    # HUD
    score_txt = font_big.render(str(int(env.score)), True, (255, 255, 255))
    shadow = font_big.render(str(int(env.score)), True, (0, 0, 0))
    surf.blit(shadow, (DESIGN_W / 2 - score_txt.get_width() / 2 + 1, 40))
    surf.blit(score_txt, (DESIGN_W / 2 - score_txt.get_width() / 2, 39))
    info = font_small.render(f"LV {env.level}   x{env.cfg.describe()}", True, (255, 255, 255))
    surf.blit(info, (8, 8))
    # 生命（心）
    for k in range(int(np.ceil(env.lives))):
        cx = 10 + k * 20
        full = env.lives - k >= 1
        col = (0xE5, 0x39, 0x35) if full else (0xE5, 0x39, 0x35)
        pygame.draw.circle(surf, col, (cx + 4, 34), 4)
        pygame.draw.circle(surf, col, (cx + 11, 34), 4)
        pygame.draw.polygon(surf, col, [(cx, 36), (cx + 15, 36), (cx + 7, 46)])
        if not full:
            ov = pygame.Surface((16, 16), pygame.SRCALPHA)
            ov.fill((0, 0, 0, 120))
            surf.blit(ov, (cx - 1, 30))
    # 连击进度
    req = env.cfg.req_combo
    for ci in range(5):
        prog = min(env.pipe_counts[ci], req) / req
        bx0, by0 = 22, 58 + ci * 13
        pygame.draw.rect(surf, hex2rgb(PIPE_TYPES[ci]["c"]), (bx0 - 12, by0, 9, 9))
        pygame.draw.rect(surf, (255, 255, 255), (bx0, by0, 44, 9))
        pygame.draw.rect(surf, hex2rgb(PIPE_TYPES[ci]["c"]), (bx0, by0, max(1, int(44 * prog)), 9))
    # AI 决策面板
    if qvals is not None:
        panel = pygame.Surface((156, 116), pygame.SRCALPHA)
        panel.fill((0, 0, 0, 130))
        surf.blit(panel, (DESIGN_W - 164, DESIGN_H - GH - 126))
        px = DESIGN_W - 156
        t = font_small.render(title or "DQN 决策", True, (255, 255, 255))
        surf.blit(t, (px, DESIGN_H - GH - 122))
        labels = ["不跳", "跳"]
        mx = max(abs(float(qvals[0])), abs(float(qvals[1])), 1e-6)
        for j in range(2):
            yy = DESIGN_H - GH - 96 + j * 36
            chosen = (action == j)
            col = (0x6C, 0xFF, 0x6C) if chosen else (0xD8, 0xD8, 0xD8)
            t = font_small.render(f"{labels[j]}  Q={qvals[j]:+.2f}", True, col)
            surf.blit(t, (px, yy))
            w = int(128 * abs(float(qvals[j])) / mx)
            pygame.draw.rect(surf, (90, 90, 90), (px, yy + 18, 128, 7))
            pygame.draw.rect(surf, col, (px, yy + 18, w, 7))
        if note:
            t = font_small.render(note, True, (255, 255, 255))
            surf.blit(t, (px, DESIGN_H - GH - 16))


def play_episode(agent, cfg, seed, mode, max_frames, record_every, fps, scale,
                 panel=True, title="DQN 决策"):
    env = ScalarBirdEnv(cfg, seed=seed)
    obs = env.obs()
    surf = pygame.Surface((int(DESIGN_W), int(DESIGN_H)))
    big = pygame.font.Font(CJK_FONT, 34)
    small = pygame.font.Font(CJK_FONT, 15)
    frames = []
    step = 0
    while step < max_frames and not env.dead:
        qv = None
        if mode == "greedy" and agent is not None:
            qv = agent.q_values(obs[None, :])[0]
            action = int(np.argmax(qv))
        elif mode == "heuristic":
            action = scalar_heuristic_action(env)
        else:
            action = int(np.random.default_rng(seed + step).integers(0, 2))
        if step % record_every == 0:
            draw_scene(surf, env, env.frame, big, small,
                       qvals=qv if panel else None, action=action,
                       title=title, note=f"step {step}")
            rgb = pygame.surfarray.array3d(surf).transpose(1, 0, 2)
            frames.append(Image.fromarray(rgb).resize(
                (int(DESIGN_W * scale), int(DESIGN_H * scale)), Image.LANCZOS))
        obs, r, done, info = env.step(action)
        step += 1
    return frames, env


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default=None)
    ap.add_argument("--out", default="docs/ai_play.gif")
    ap.add_argument("--mode", choices=["greedy", "heuristic", "random"], default="greedy")
    ap.add_argument("--seed", type=int, default=None, help="不指定则自动挑一局高分的")
    ap.add_argument("--pick-seeds", type=int, default=40, help="自动挑种子的候选数")
    ap.add_argument("--bird", type=int, default=None)
    ap.add_argument("--stars", type=int, nargs=3, default=None)
    ap.add_argument("--wings", action="store_true", default=None)
    ap.add_argument("--fps", type=int, default=20)
    ap.add_argument("--max-seconds", type=float, default=15.0)
    ap.add_argument("--scale", type=float, default=0.75)
    ap.add_argument("--colors", type=int, default=128)
    ap.add_argument("--no-panel", action="store_true")
    ap.add_argument("--title", default="DQN 决策")
    a = ap.parse_args()

    pygame.init()
    pygame.display.set_mode((1, 1))

    agent = None
    cfg_kw = {}
    if a.ckpt:
        probe = DQNAgent()
        meta = probe.load(a.ckpt)
        agent = DQNAgent(hidden=int(meta.get("hidden", 256)),
                         dueling=bool(meta.get("dueling", True)))
        meta = agent.load(a.ckpt)
        cfg_kw = {"bird": int(meta.get("bird", 0)), "stars": tuple(meta.get("stars", [1, 1, 1])),
                  "wings": bool(meta.get("wings", False))}
        print(f"[权重] {a.ckpt}  梯度更新 {agent.learn_steps}")
    cfg = GameConfig(bird=a.bird if a.bird is not None else cfg_kw.get("bird", 0),
                     stars=tuple(a.stars) if a.stars is not None else cfg_kw.get("stars", (1, 1, 1)),
                     wings=a.wings if a.wings is not None else cfg_kw.get("wings", False))
    print(f"[玩法] {cfg.describe()}")

    # 自动挑一个能打出高分的种子，让 GIF 好看
    seed = a.seed
    if seed is None:
        best_seed, best_score = 0, -1
        for s in range(a.pick_seeds):
            env = ScalarBirdEnv(cfg, seed=s)
            obs = env.obs()
            for _ in range(int(a.max_seconds * 60) + 600):
                if env.dead:
                    break
                act = (int(np.argmax(agent.q_values(obs[None, :])[0]))
                       if a.mode == "greedy" and agent is not None
                       else (scalar_heuristic_action(env) if a.mode == "heuristic"
                             else int(np.random.default_rng(s).integers(0, 2))))
                obs, _, _, _ = env.step(act)
            if env.score > best_score:
                best_seed, best_score = s, env.score
        seed = best_seed
        print(f"[选种子] seed={seed}（该局得分 {best_score:.0f}）")

    record_every = max(1, round(60 / a.fps))
    frames, env = play_episode(agent, cfg, seed, a.mode,
                               int(a.max_seconds * 60), record_every, a.fps, a.scale,
                               panel=not a.no_panel, title=a.title)
    print(f"[回放] {env.frame} 帧游戏（{env.frame / 60:.1f}s）  得分 {env.score:.0f}  "
          f"等级 {env.level}  剩余命 {env.lives:g}  录制 {len(frames)} 帧")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    if a.out.endswith(".gif"):
        pal = frames[0].convert("P", palette=Image.ADAPTIVE, colors=a.colors)
        pil = [pal] + [f.quantize(palette=pal, dither=Image.FLOYDSTEINBERG) for f in frames[1:]]
        pil[0].save(a.out, save_all=True, append_images=pil[1:],
                    duration=int(1000 / a.fps), loop=0, optimize=True)
    else:
        frames[0].save(a.out, save_all=True, append_images=frames[1:])
    size = os.path.getsize(a.out) / 1e6
    print(f"[输出] {a.out}  ({size:.1f} MB, {len(frames)} 帧 @ {a.fps}fps)")


if __name__ == "__main__":
    main()
