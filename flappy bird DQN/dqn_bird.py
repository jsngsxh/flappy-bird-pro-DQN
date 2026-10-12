#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
 小鸟过管道 · DQN 强化学习 AI（单文件实现）
================================================================================
让 AI 自己学会玩微信小游戏《小鸟过管道》，分数越高越好。

本文件包含完整闭环（无需其它 Python 文件即可训练/评估/复现）：
    1. 游戏常量与规则（逐行对应原版 js/main.js）
    2. 种子化 PRNG（mulberry32，与 Node 参考环境逐位一致）
    3. ScalarBirdEnv  —— 原版游戏逻辑的逐行移植（含粒子/连击/命数，帧级保真）
    4. VectorBirdEnv  —— numpy 向量化环境（几百只鸟并行，训练用）
    5. 观测/奖励设计（34 维状态，真实游戏分数作为奖励主体）
    6. Dueling Double DQN + n-step + 优先经验回放(PER) （PyTorch）
    7. 训练 / 评估 / 基线 / 绘图 / 对拍 命令行

用法：
    python dqn_bird.py train  --steps 3000000 --n-envs 256 --device cuda
    python dqn_bird.py eval   --ckpt runs/main/best.pt --episodes 200
    python dqn_bird.py baselines --episodes 200
    python dqn_bird.py bench  --n-envs 512
    python dqn_bird.py parity --episodes 20      # 与原版 JS 逐帧对拍
    python dqn_bird.py plot   --csv runs/main/log.csv

自检：
    python dqn_bird.py self-test
================================================================================
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import subprocess
import sys
import time
from collections import deque
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

# ==============================================================================
# 0. 全局常量（严格对应原版 js/main.js 第 74-82 行）
# ==============================================================================
G = 1800.0          # 重力 px/s^2
JV = -480.0         # 跳跃瞬时速度 px/s
BPS = 180.0         # 管道基础速度 px/s
PW = 50.0           # 管道宽度
BGAP = 150.0        # 基础间隙高度
SPAWN = 200.0       # 管道生成间距
BW = 30.0           # 鸟宽
BH = 30.0           # 鸟高
BX = 100.0          # 鸟固定 x
GH = 55.0           # 地面高度
FAST_GAP = 75.0     # 红管生成时的额外前移
DESIGN_W = 400.0
DESIGN_H = 600.0
DT = 1.0 / 60.0     # 固定步长（真机 requestAnimationFrame ≈ 60fps）
PTCAP = 50          # 粒子上限（只影响随机数消耗，移植时需要保留）

# 五种管道：绿(普通) / 红(加速) / 蓝(浮动) / 紫(窄间隙) / 金(高分)
PIPE_TYPES = [
    {"name": "green", "c": "#228B22", "cc": "#1a6b1a", "sm": 1.0, "gm": 1.00, "pts": 1, "prob": 42, "fast": 0, "osc": 0.0},
    {"name": "red", "c": "#CC3333", "cc": "#991111", "sm": 1.5, "gm": 1.00, "pts": 1, "prob": 18, "fast": 1, "osc": 0.0},
    {"name": "blue", "c": "#3366CC", "cc": "#1a3388", "sm": 1.0, "gm": 1.00, "pts": 1, "prob": 18, "fast": 0, "osc": 40.0},
    {"name": "purple", "c": "#8B3DB5", "cc": "#5C1F80", "sm": 1.0, "gm": 0.80, "pts": 1, "prob": 12, "fast": 0, "osc": 0.0},
    {"name": "gold", "c": "#FFB800", "cc": "#CC8800", "sm": 1.0, "gm": 1.00, "pts": 3, "prob": 10, "fast": 0, "osc": 0.0},
]
TP_SUM = sum(p["prob"] for p in PIPE_TYPES)
PSM = np.array([p["sm"] for p in PIPE_TYPES], dtype=np.float64)
PGM = np.array([p["gm"] for p in PIPE_TYPES], dtype=np.float64)
PPTS = np.array([p["pts"] for p in PIPE_TYPES], dtype=np.float64)
PPROB = np.array([p["prob"] for p in PIPE_TYPES], dtype=np.float64)
CUM_PROB = np.cumsum(PPROB)
POSC = np.array([p["osc"] for p in PIPE_TYPES], dtype=np.float64)
PFAST = np.array([p["fast"] for p in PIPE_TYPES], dtype=np.int64)

OBS_DIM = 34        # 观测维度（见 obs() 注释）
N_ACTIONS = 2       # 0=不跳, 1=跳


# ==============================================================================
# 1. 种子化 PRNG：mulberry32（与 tools/ref_env.js 完全一致，逐位同流）
# ==============================================================================
class Mulberry32:
    """标量版 mulberry32，用于 ScalarBirdEnv 与 JS 参考环境对拍。"""

    __slots__ = ("s",)

    def __init__(self, seed: int):
        self.s = seed & 0xFFFFFFFF

    def random(self) -> float:
        s = (self.s + 0x6D2B79F5) & 0xFFFFFFFF
        self.s = s
        t = ((s ^ (s >> 15)) * (1 | s)) & 0xFFFFFFFF
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF)) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0


def mul_next(state: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """向量化 mulberry32：输入 uint32 状态数组，返回 (随机浮点数组, 新状态数组)。"""
    s = (state + np.uint32(0x6D2B79F5)).astype(np.uint32)
    t = ((s ^ (s >> np.uint32(15))) * (np.uint32(1) | s)).astype(np.uint32)
    t2 = ((t ^ (t >> np.uint32(7))) * (np.uint32(61) | t)).astype(np.uint32)
    t = ((t + t2).astype(np.uint32)) ^ t
    out = (t ^ (t >> np.uint32(14))).astype(np.float64) / 4294967296.0
    return out, s


# ==============================================================================
# 2. 配置
# ==============================================================================
@dataclass
class GameConfig:
    """一局游戏的玩法配置（对应游戏里的选鸟/升星/商店装备）。"""
    bird: int = 0                 # 0=小黄(普通) 1=小红(稀有) 2=小粉(史诗)
    stars: Tuple[int, int, int] = (1, 1, 1)
    wings: bool = False           # 闪避之翼（商店被动）

    @property
    def req_combo(self) -> int:
        """连击达标数：小黄3星=8，其余=10。"""
        return 8 if (self.bird == 0 and self.stars[0] >= 3) else 10

    @property
    def dodge_rate(self) -> float:
        """闪避概率：翅膀20%；小粉3星基础50%（翅膀乘算1.2）。"""
        if self.bird == 2 and self.stars[2] >= 3:
            return 0.5 * (1.2 if self.wings else 1.0)
        return 0.2 if self.wings else 0.0

    @property
    def init_lives(self) -> float:
        """开局命数（含升星加成）。"""
        base = 3 if self.bird == 0 else (1 if self.bird == 1 else 2)
        if self.bird == 0 and self.stars[0] >= 2:
            base += 2
        if self.bird == 1 and self.stars[1] >= 2:
            base += 1
        if self.bird == 2 and self.stars[2] >= 2:
            base += 1
        return float(base)

    @property
    def life_per_15(self) -> float:
        """小红回血：每15分+1命（3星+1.5）。"""
        return 1.5 if (self.bird == 1 and self.stars[1] >= 3) else 1.0

    def describe(self) -> str:
        names = ["小黄", "小红", "小粉"]
        return (f"{names[self.bird]}·{self.stars[self.bird]}星"
                f"{'+翅膀' if self.wings else ''}")


@dataclass
class RewardConfig:
    """奖励设计。

    真实奖励 r_true = score_scale × 本帧得分增量 + alive − life_lost × 掉命 − death × 死亡
    在此之上可选叠加 **基于势函数的奖励塑形 (Potential-Based Reward Shaping)**：
        r = r_true + γ·Φ(s') − Φ(s)
        Φ(s) = −w · clip(|鸟中心 − 最近管道间隙中心| / 300, 0, 1)     （Φ(终止态)=0）
    这是 Ng et al. 1999 的经典结论：塑形后的最优策略与原奖励**完全一致**，
    只是把"靠近间隙中心"这一密集信号教给网络，解决稀疏奖励下的学习退化。
    """
    score_scale: float = 1.0     # 真实得分增量权重（金管+3/+4、金连击×2 都算）
    alive: float = 0.0           # 每帧存活奖励
    life_lost: float = 1.0       # 掉一条命的惩罚
    death: float = 1.0           # 死亡惩罚（正数，实际按 −death 计入）
    shaping: float = 0.5         # 势函数塑形系数 w（0 = 关闭）
    gamma: float = 0.99          # 塑形用的折扣（需与智能体 γ 一致）


# ==============================================================================
# 3. ScalarBirdEnv —— 原版 js/main.js 的逐行移植（用于保真对拍 / 单局回放）
# ==============================================================================
class _Pipe:
    __slots__ = ("x", "top_h", "gap", "type", "scored", "base_th", "ph")

    def __init__(self, x, top_h, gap, ptype, base_th, ph):
        self.x = x
        self.top_h = top_h
        self.gap = gap
        self.type = ptype
        self.scored = False
        self.base_th = base_th
        self.ph = ph


class ScalarBirdEnv:
    """逐行移植版环境。

    - 随机数消耗顺序与 JS 完全一致（含 pfx 粒子系统，它虽然不影响物理，
      但会消耗 Math.random()，从而影响后续管道生成）
    - 供 tools/parity_test.py 做逐帧一致性验证
    - 供 render_demo.py 做 60fps 单局可视化回放
    """

    def __init__(self, config: Optional[GameConfig] = None, seed: int = 0,
                 reward_cfg: Optional[RewardConfig] = None,
                 pipe_seq: Optional[Sequence[Tuple[int, int, float]]] = None):
        self.cfg = config or GameConfig()
        self.rc = reward_cfg or RewardConfig()
        self.rng = Mulberry32(seed)
        self.pipe_seq = list(pipe_seq) if pipe_seq is not None else None
        self.pipe_seq_i = 0
        self._rand_calls = 0
        self.reset()

    # ------------------------------------------------------------------ 内部工具
    def _rand(self) -> float:
        self._rand_calls += 1
        return self.rng.random()

    def _pfx(self, n: int, life: float = 0.5) -> None:
        """移植 pfx()：只保留"消耗随机数"和粒子计数逻辑（视觉参数无关）。"""
        for _ in range(n):
            if len(self.pt_life) >= PTCAP:                   # 原版：ptN >= PTCAP 就停
                break
            self._rand()                                     # 角度
            self._rand()                                     # 速度
            self._rand()                                     # 尺寸 (x*3|0)
            self.pt_life.append(life)

    # ------------------------------------------------------------------ 生命周期
    def reset(self) -> np.ndarray:
        self.bird_y = float(int(DESIGN_H / 2))
        self.bird_v = 0.0
        self.pipes: List[_Pipe] = []
        self.score = 0.0
        self.level = 0
        self.frame = 0
        self.last_spawn_x = DESIGN_W
        self.lives = self.cfg.init_lives
        self.max_lives = self.lives
        self.invincible = 0.0
        self.pipes_passed = 0
        self.pipe_counts = [0, 0, 0, 0, 0]
        self.combo_timers = [0, 0, 0, 0, 0]
        self.last_life_score = 10.0
        self.pt_n = 0
        self.pt_life = []
        self.dead = False
        self.base_score = 0.0
        self.base_coins = 0
        self.pipe_seq_i = 0
        self.ep_score = 0.0
        self.ep_reward = 0.0
        self.ep_frames = 0
        self.ep_lives_lost = 0
        self.ground_off = 0.0
        return self.obs()

    # ------------------------------------------------------------------ 管道生成
    def _mk_pipe(self, at_x: Optional[float] = None) -> None:
        if self.pipe_seq is not None:                      # 脚本化序列（交叉验证用）
            ti, th, ph = self.pipe_seq[self.pipe_seq_i % len(self.pipe_seq)]
            self.pipe_seq_i += 1
            roll = None
        else:
            roll = self._rand() * TP_SUM
            ti = 0
            for i in range(5):
                roll -= PIPE_TYPES[i]["prob"]
                if roll <= 0:
                    ti = i
                    break
        if self.cfg.bird == 2 and ti == 0:                 # 小粉：绿管变金管
            ti = 4
        d = PIPE_TYPES[ti]
        gap = int(BGAP * d["gm"])
        if self.combo_timers[3] > 0:                       # 紫色连击：间隙翻倍
            gap *= 2
            self.combo_timers[3] -= 1
        if self.pipe_seq is None:
            th = int(self._rand() * (DESIGN_H - GH - gap - 120) + 60)
            ph = self._rand() * math.pi * 2
        sx = at_x if at_x is not None else DESIGN_W
        if d["fast"] and at_x is None:
            sx += FAST_GAP
        self.pipes.append(_Pipe(sx, th, gap, ti, th, ph))

    def _rm_x(self) -> float:
        m = 0.0
        for p in self.pipes:
            if p.x > m:
                m = p.x
        return m

    # ------------------------------------------------------------------ 奖励结算
    def _pipe_reward(self, p: _Pipe, pts: float) -> None:
        """移植 pipeReward()：得分 + 连击链式触发 + 小红回血。"""
        self.score += pts
        self.pipes_passed += 1
        # 局内金币检测（会触发 pfx，消耗随机数 → 保留）
        new_coins = int((self.base_score + self.score) / 100)
        if new_coins > self.base_coins:
            self.base_coins = new_coins
            self._pfx(6, 0.5)
        self.pipe_counts[p.type] += 1
        if self.cfg.bird == 2 and p.type == 4:
            self.pipe_counts[0] += 1
        req = self.cfg.req_combo
        while True:
            fired = False
            for ct in range(5):
                if self.pipe_counts[ct] >= req:
                    self.pipe_counts[ct] -= req
                    fired = True
                    # 每种连击都会喷粒子（消耗随机数，必须保留才能与 JS 随机流一致）
                    self._pfx(15 if ct == 4 else 12, 0.6)
                    if ct == 0:                            # 绿：其他计数+2
                        for ci in range(5):
                            if ci != 0:
                                self.pipe_counts[ci] += 2
                    elif ct == 1:                          # 红：+1命
                        self.lives += 1
                        self.max_lives = self.lives
                    elif ct == 2:                          # 蓝：难度-1
                        self.level = max(0, self.level - 1)
                    elif ct == 3:                          # 紫：下5管间隙翻倍
                        self.combo_timers[3] = 5
                    elif ct == 4:                          # 金：下5管得分翻倍
                        self.combo_timers[4] = 5
            if not fired:
                break
        # 小红：首次10分+1命，之后每15分+1命
        if self.cfg.bird == 1 and self.score >= self.last_life_score:
            add = self.cfg.life_per_15
            self.lives += add
            self.max_lives = self.lives
            self.last_life_score += 15
            self._pfx(int(add * 4), 0.4)
        if pts >= 3:
            self._pfx(12, 0.5)
        else:
            self._pfx(0)

    def _die(self) -> None:
        if self.dead:
            return
        self.dead = True
        self._pfx(20, 0.7)

    def potential(self) -> float:
        """Φ(s)：与最近管道间隙中心的接近程度（与向量环境同定义）。"""
        w = self.rc.shaping
        if w == 0:
            return 0.0
        by = self.bird_y + BH / 2
        target = 280.0
        best = None
        for p in self.pipes:
            if p.x + PW > BX and (best is None or p.x < best.x):
                best = p
        if best is not None:
            target = best.top_h + best.gap / 2
        return -w * min(abs(by - target) / 300.0, 1.0)

    # ------------------------------------------------------------------ 单步推进
    def step(self, action: int):
        r = self.rc
        phi0 = self.potential()
        s0 = self.score
        lives0 = self.lives
        if action:
            self.bird_v = JV
        dt = DT
        self.frame += 1
        if self.invincible > 0:
            self.invincible -= dt
        # 物理积分
        self.bird_v += G * dt
        self.bird_y += self.bird_v * dt
        if self.bird_y <= 0:
            self.bird_y = 0.0
            self.bird_v = 0.0
            self._die()
        elif self.bird_y + BH >= DESIGN_H - GH:
            self.bird_y = DESIGN_H - GH - BH
            self._die()
        # 难度
        nl = int(self.pipes_passed / 10)
        if nl > self.level:
            self.level = nl
        rm = self._rm_x()
        if len(self.pipes) == 0 or rm < self.last_spawn_x - SPAWN:
            self._mk_pipe()
            self.last_spawn_x = DESIGN_W
        sb = self.level * 8
        gs = min(self.level * 2, 16)
        # 管道（倒序遍历，与原版一致）
        for i in range(len(self.pipes) - 1, -1, -1):
            p = self.pipes[i]
            d = PIPE_TYPES[p.type]
            sp = BPS * d["sm"] + sb
            p.x -= sp * dt
            if d["osc"]:
                p.top_h = int(p.base_th + math.sin(self.frame * 0.04 + p.ph) * d["osc"])
            if p.x + PW < -10:
                self.pipes.pop(i)
                continue
            if (not p.scored) and p.x + PW < BX:
                p.scored = True
                pts = PPTS[p.type]
                if self.cfg.bird == 2 and pts >= 3:
                    pts = 4
                if self.combo_timers[4] > 0:               # 金色连击：得分翻倍
                    pts *= 2
                    self.combo_timers[4] -= 1
                self._pipe_reward(p, pts)
            ex = int(gs / 2)
            et = p.top_h + ex
            if BX + BW > int(p.x) and BX < int(p.x + PW):
                if self.bird_y < et or self.bird_y + BH > et + p.gap - gs:
                    if self.invincible > 0:
                        continue
                    dr = self.cfg.dodge_rate
                    if dr > 0 and self._rand() < dr:
                        self.pipes.pop(i)
                        self._pfx(10, 0.4)
                        continue
                    if self.lives > 1:
                        self.lives -= 1
                        self.invincible = 1.5
                        self._pfx(20, 0.6)     # 原版这里是两次 pfx：20×0.6 + 10×0.5
                        self._pfx(10, 0.5)
                        self.pipes.pop(i)
                    else:
                        self._die()
        # 粒子更新（只影响 pt_n，进而影响后续随机数消耗）
        i = 0
        while i < len(self.pt_life):
            self.pt_life[i] -= dt
            if self.pt_life[i] <= 0:
                self.pt_life[i] = self.pt_life[-1]
                self.pt_life.pop()
                continue
            i += 1
        self.pt_n = len(self.pt_life)
        self.ground_off = (self.ground_off + BPS * dt) % 30
        # 奖励
        reward = (r.score_scale * (self.score - s0) + r.alive
                  - r.life_lost * max(0.0, lives0 - self.lives)
                  - (r.death if self.dead else 0.0))
        if r.shaping:
            phi1 = self.potential()
            reward += (-phi0 if self.dead else r.gamma * phi1 - phi0)
        self.ep_reward += reward
        self.ep_score = self.score
        self.ep_frames += 1
        return self.obs(), reward, self.dead, self.info()

    # ------------------------------------------------------------------ 观测
    def obs(self) -> np.ndarray:
        """与 VectorBirdEnv 完全相同的 34 维观测（保证两个环境可对拍）。"""
        return build_obs_scalar(self)

    def info(self) -> Dict[str, Any]:
        return {"score": self.score, "level": self.level, "lives": self.lives,
                "pipes_passed": self.pipes_passed, "frames": self.ep_frames,
                "reward": self.ep_reward}

    # ------------------------------------------------------------------ 状态导出
    def export_state(self) -> List[float]:
        """导出与 ref_env.js snap() 完全同构的状态数组，用于逐帧对拍。"""
        s = [self.bird_y, self.bird_v, self.score, float(self.level), self.lives,
             float(self.pipes_passed), float(self.frame), self.invincible]
        s += [float(x) for x in self.pipe_counts]
        s += [float(x) for x in self.combo_timers]
        s.append(self.last_spawn_x)
        s.append(float(len(self.pipes)))
        for p in self.pipes:
            s += [p.x, float(p.top_h), float(p.gap), float(p.type), 1.0 if p.scored else 0.0]
        # 末三位：随机流内部状态 + 随机数调用次数 + 存活粒子数（与 ref_env.js 对齐）
        s.append(float(self.rng.s))
        s.append(float(self._rand_calls))
        s.append(float(self.pt_n))
        return s


def build_obs_scalar(env: ScalarBirdEnv) -> np.ndarray:
    """从标量环境构造观测（与向量化环境同一套特征定义）。"""
    obs = np.zeros(OBS_DIM, dtype=np.float32)
    by = env.bird_y + BH / 2
    obs[0] = env.bird_y / DESIGN_H
    obs[1] = env.bird_v / 900.0
    gs = min(env.level * 2, 16)
    rel = [p for p in env.pipes if p.x + PW > BX]
    rel.sort(key=lambda p: p.x)
    for k in range(2):
        base = 2 + k * 11
        if k < len(rel):
            p = rel[k]
            d = PIPE_TYPES[p.type]
            speed = BPS * d["sm"] + env.level * 8
            phase = env.frame * 0.04 + p.ph
            obs[base + 0] = (p.x - BX) / 500.0
            obs[base + 1] = (p.top_h + p.gap / 2 - by) / DESIGN_H
            obs[base + 2] = (p.gap - gs) / BGAP
            obs[base + 3] = speed / 600.0
            obs[base + 4 + p.type] = 1.0
            if d["osc"]:
                obs[base + 9] = math.sin(phase)
                obs[base + 10] = math.cos(phase)
        else:
            obs[base + 0] = 1.0
    obs[24] = env.level / 20.0
    obs[25] = env.lives / 6.0
    obs[26] = env.invincible / 1.5
    obs[27] = env.combo_timers[3] / 5.0
    obs[28] = env.combo_timers[4] / 5.0
    req = env.cfg.req_combo
    for c in range(5):
        obs[29 + c] = min(env.pipe_counts[c], req) / req
    return obs


# ==============================================================================
# 4. VectorBirdEnv —— numpy 向量化环境（训练用）
# ==============================================================================
MAX_PIPES = 8   # 同屏最多管道数（实测 ≤5，留足余量）


class VectorBirdEnv:
    """N 只鸟并行推进的向量化环境。

    - 物理/奖励规则与 ScalarBirdEnv 完全一致
    - 去掉纯视觉的粒子与弹字（不消耗 RNG），管道生成使用每只鸟独立的 RNG 流
    - 鸟死亡后自动 reset（同一步内开始新一局），episode 统计写入 info
    """

    def __init__(self, n_envs: int, config: Optional[GameConfig] = None, seed: int = 0,
                 reward_cfg: Optional[RewardConfig] = None,
                 pipe_seq: Optional[Sequence[Tuple[int, int, float]]] = None):
        self.n = n_envs
        self.cfg = config or GameConfig()
        self.rc = reward_cfg or RewardConfig()
        self.base_seed = seed
        self.pipe_seq = list(pipe_seq) if pipe_seq is not None else None
        self.pipe_seq_i = 0
        self._episode_counter = 0
        self._init_arrays()
        self.reset()

    def _init_arrays(self) -> None:
        n = self.n
        f, i32, b = np.float64, np.int32, np.bool_
        self.bird_y = np.zeros(n, dtype=f)
        self.bird_v = np.zeros(n, dtype=f)
        self.score = np.zeros(n, dtype=f)
        self.level = np.zeros(n, dtype=i32)
        self.frame = np.zeros(n, dtype=i32)
        self.lives = np.zeros(n, dtype=f)
        self.max_lives = np.zeros(n, dtype=f)
        self.invincible = np.zeros(n, dtype=f)
        self.pipes_passed = np.zeros(n, dtype=i32)
        self.last_spawn_x = np.full(n, DESIGN_W, dtype=f)
        self.pipe_counts = np.zeros((n, 5), dtype=i32)
        self.combo_timers = np.zeros((n, 5), dtype=i32)
        self.last_life_score = np.full(n, 10.0, dtype=f)
        self.dead = np.zeros(n, dtype=b)
        self.ep_score = np.zeros(n, dtype=f)
        self.ep_reward = np.zeros(n, dtype=f)
        self.ep_frames = np.zeros(n, dtype=i32)
        self.ep_lives_lost = np.zeros(n, dtype=f)
        # 管道槽位（空槽 x=-1e9）
        self.px = np.full((n, MAX_PIPES), -1e9, dtype=f)
        self.ptop = np.zeros((n, MAX_PIPES), dtype=f)
        self.pgap = np.zeros((n, MAX_PIPES), dtype=f)
        self.ptype = np.zeros((n, MAX_PIPES), dtype=i32)
        self.pscored = np.zeros((n, MAX_PIPES), dtype=b)
        self.pbase = np.zeros((n, MAX_PIPES), dtype=f)
        self.pph = np.zeros((n, MAX_PIPES), dtype=f)
        # RNG
        self.rng_state = np.zeros(n, dtype=np.uint32)
        self.next_lives_scale = np.ones(n, dtype=f)

    # ------------------------------------------------------------------ 重置
    def reset(self, seeds: Optional[Sequence[int]] = None) -> np.ndarray:
        n = self.n
        if seeds is None:
            seeds = [self.base_seed + self._episode_counter * 1000003 + i for i in range(n)]
            self._episode_counter += 1
        self.rng_state = (np.asarray(seeds, dtype=np.uint64) & 0xFFFFFFFF).astype(np.uint32)
        self.bird_y[:] = int(DESIGN_H / 2)
        self.bird_v[:] = 0.0
        self.score[:] = 0.0
        self.level[:] = 0
        self.frame[:] = 0
        self.lives[:] = self.cfg.init_lives
        self.max_lives[:] = self.cfg.init_lives
        self.invincible[:] = 0.0
        self.pipes_passed[:] = 0
        self.last_spawn_x[:] = DESIGN_W
        self.pipe_counts[:] = 0
        self.combo_timers[:] = 0
        self.last_life_score[:] = 10.0
        self.dead[:] = False
        self.ep_score[:] = 0.0
        self.ep_reward[:] = 0.0
        self.ep_frames[:] = 0
        self.ep_lives_lost[:] = 0.0
        self.px[:] = -1e9
        self.pscored[:] = False
        return self.obs()

    def _reset_masked(self, mask: np.ndarray, seeds: Optional[np.ndarray] = None) -> None:
        """只重置 mask 为 True 的那些鸟（自动开新局）。"""
        if seeds is None:
            seeds = (self.rng_state[mask].astype(np.uint64) * 6364136223846793005 +
                     np.uint64(self._episode_counter * 2654435761 + 12345)) & np.uint64(0xFFFFFFFF)
        self.rng_state[mask] = seeds.astype(np.uint32)
        b = mask
        self.bird_y[b] = int(DESIGN_H / 2)
        self.bird_v[b] = 0.0
        self.score[b] = 0.0
        self.level[b] = 0
        self.frame[b] = 0
        self.lives[b] = self.cfg.init_lives
        self.max_lives[b] = self.cfg.init_lives
        self.invincible[b] = 0.0
        self.pipes_passed[b] = 0
        self.last_spawn_x[b] = DESIGN_W
        self.pipe_counts[b] = 0
        self.combo_timers[b] = 0
        self.last_life_score[b] = 10.0
        self.dead[b] = False
        self.ep_score[b] = 0.0
        self.ep_reward[b] = 0.0
        self.ep_frames[b] = 0
        self.ep_lives_lost[b] = 0.0
        self.px[b] = -1e9
        self.pscored[b] = False
        self._episode_counter += 1

    # ------------------------------------------------------------------ 管道生成
    def _spawn_mask(self) -> np.ndarray:
        rm = np.max(self.px, axis=1)
        has = np.any(self.px > -1e8, axis=1)
        return (~has) | (rm < self.last_spawn_x - SPAWN)

    def _first_free_slot(self) -> np.ndarray:
        empty = self.px <= -1e8
        return np.argmax(empty, axis=1)

    def _mk_pipes(self, mask: np.ndarray) -> None:
        """对 mask 为 True 的鸟生成一根新管道（消耗各自 RNG 流）。"""
        idx = np.nonzero(mask)[0]
        if idx.size == 0:
            return
        if self.pipe_seq is not None:
            # 脚本化管道序列（仅用于标量/向量环境交叉验证）
            k = idx.size
            spec = [self.pipe_seq[(self.pipe_seq_i + j) % len(self.pipe_seq)] for j in range(k)]
            self.pipe_seq_i += k
            ti = np.array([s[0] for s in spec], dtype=np.int64)
            th = np.array([s[1] for s in spec], dtype=np.float64)
            ph = np.array([s[2] for s in spec], dtype=np.float64)
            gap = (BGAP * PGM[ti]).astype(np.int64)
            ct3 = self.combo_timers[idx, 3] > 0
            gap = np.where(ct3, gap * 2, gap)
            self.combo_timers[idx, 3] = np.where(ct3, self.combo_timers[idx, 3] - 1,
                                                 self.combo_timers[idx, 3])
            sx = np.full(idx.size, DESIGN_W)
            sx = np.where(PFAST[ti] == 1, sx + FAST_GAP, sx)
            slot = self._first_free_slot()[idx]
            self.px[idx, slot] = sx
            self.ptop[idx, slot] = th
            self.pgap[idx, slot] = gap
            self.ptype[idx, slot] = ti
            self.pscored[idx, slot] = False
            self.pbase[idx, slot] = th
            self.pph[idx, slot] = ph
            return
        st = self.rng_state[idx]
        u1, st = mul_next(st)
        u2, st = mul_next(st)
        u3, st = mul_next(st)
        self.rng_state[idx] = st
        # 等价于原版"roll 逐个减 prob、首次 <=0 即选中"的循环
        roll = u1 * TP_SUM
        ti = np.searchsorted(CUM_PROB, roll, side="left").astype(np.int64)
        if self.cfg.bird == 2:
            ti = np.where(ti == 0, 4, ti)
        gap = (BGAP * PGM[ti]).astype(np.int64)
        ct3 = self.combo_timers[idx, 3] > 0
        gap = np.where(ct3, gap * 2, gap)
        self.combo_timers[idx, 3] = np.where(ct3, self.combo_timers[idx, 3] - 1, self.combo_timers[idx, 3])
        th = (u2 * (DESIGN_H - GH - gap - 120) + 60).astype(np.int64)
        ph = u3 * math.pi * 2
        sx = np.full(idx.size, DESIGN_W)
        sx = np.where(PFAST[ti] == 1, sx + FAST_GAP, sx)
        slot = self._first_free_slot()[idx]
        self.px[idx, slot] = sx
        self.ptop[idx, slot] = th
        self.pgap[idx, slot] = gap
        self.ptype[idx, slot] = ti
        self.pscored[idx, slot] = False
        self.pbase[idx, slot] = th
        self.pph[idx, slot] = ph

    # ------------------------------------------------------------------ 计分与连击
    def _score_pipe(self, mask: np.ndarray, slot: int) -> None:
        """对 mask 为 True 的鸟，结算槽位 slot 上的管道得分（复刻 pipeReward）。"""
        idx = np.nonzero(mask)[0]
        if idx.size == 0:
            return
        ti = self.ptype[idx, slot]
        pts = PPTS[ti].copy()
        if self.cfg.bird == 2:
            pts = np.where(pts >= 3, 4.0, pts)
        gold = self.combo_timers[idx, 4] > 0
        pts = np.where(gold, pts * 2.0, pts)
        self.combo_timers[idx, 4] = np.where(gold, self.combo_timers[idx, 4] - 1, self.combo_timers[idx, 4])
        self.score[idx] += pts
        self.pipes_passed[idx] += 1
        # 连击计数
        self.pipe_counts[idx, ti] += 1
        if self.cfg.bird == 2:
            g = ti == 4
            self.pipe_counts[idx[g], 0] += 1
        # 链式连击检测
        req = self.cfg.req_combo
        while True:
            fired = np.zeros(idx.size, dtype=bool)
            for ct in range(5):
                hit = self.pipe_counts[idx, ct] >= req
                if not np.any(hit):
                    continue
                self.pipe_counts[idx[hit], ct] -= req
                fired |= hit
                h = idx[hit]
                if ct == 0:
                    for ci in range(5):
                        if ci != 0:
                            self.pipe_counts[h, ci] += 2
                elif ct == 1:
                    self.lives[h] += 1.0
                    self.max_lives[h] = self.lives[h]
                elif ct == 2:
                    self.level[h] = np.maximum(0, self.level[h] - 1)
                elif ct == 3:
                    self.combo_timers[h, 3] = 5
                elif ct == 4:
                    self.combo_timers[h, 4] = 5
            if not fired.any():
                break
        # 小红回血
        if self.cfg.bird == 1:
            heal = self.score[idx] >= self.last_life_score[idx]
            if np.any(heal):
                h = idx[heal]
                add = self.cfg.life_per_15
                self.lives[h] += add
                self.max_lives[h] = self.lives[h]
                self.last_life_score[h] += 15.0

    # ------------------------------------------------------------------ 势函数
    def potential(self) -> np.ndarray:
        """Φ(s)：与最近管道间隙中心的接近程度（0 最好，-w 最差）。"""
        w = self.rc.shaping
        if w == 0:
            return np.zeros(self.n, dtype=np.float64)
        by = self.bird_y + BH / 2
        active = (self.px > -1e8) & (self.px + PW > BX)
        big = np.where(active, self.px, np.inf)
        order = np.argmin(big, axis=1)
        rows = np.arange(self.n)
        has = active[rows, order]
        center = np.where(has, self.ptop[rows, order] + self.pgap[rows, order] / 2, 280.0)
        return -w * np.minimum(np.abs(by - center) / 300.0, 1.0)

    # ------------------------------------------------------------------ 单步
    def step(self, actions: np.ndarray):
        dt = DT
        phi0 = self.potential()
        act = np.asarray(actions).astype(bool)
        s0 = self.score.copy()
        lives0 = self.lives.copy()
        self.bird_v = np.where(act, JV, self.bird_v)
        self.frame += 1
        self.invincible = np.where(self.invincible > 0, self.invincible - dt, self.invincible)
        self.bird_v += G * dt
        self.bird_y += self.bird_v * dt
        # 撞顶 / 撞底
        top = self.bird_y <= 0
        self.bird_y = np.where(top, 0.0, self.bird_y)
        self.bird_v = np.where(top, 0.0, self.bird_v)
        bot = self.bird_y + BH >= DESIGN_H - GH
        self.bird_y = np.where(bot, DESIGN_H - GH - BH, self.bird_y)
        self.dead |= (top | bot)
        self.max_lives = np.maximum(self.max_lives, self.lives)
        # 难度
        nl = (self.pipes_passed // 10).astype(np.int32)
        self.level = np.where(nl > self.level, nl, self.level).astype(np.int32)
        # 生成
        self._mk_pipes(self._spawn_mask())
        sb = self.level * 8
        gs = np.minimum(self.level * 2, 16)
        # 管道推进 + 计分 + 碰撞
        occupied = self.px > -1e8
        for slot in range(MAX_PIPES):
            occ = occupied[:, slot]
            if not np.any(occ):
                continue
            ti = self.ptype[:, slot]
            sp = BPS * PSM[ti] + sb
            self.px[:, slot] -= sp * dt
            osc = (POSC[ti] != 0) & occ
            if np.any(osc):
                ph = self.frame * 0.04 + self.pph[:, slot]
                self.ptop[:, slot] = np.where(
                    osc, np.trunc(self.pbase[:, slot] + np.sin(ph) * POSC[ti]), self.ptop[:, slot])
            # 出屏移除
            gone = occ & (self.px[:, slot] + PW < -10)
            if np.any(gone):
                self.px[gone, slot] = -1e9
                self.pscored[gone, slot] = False
                occ = occ & ~gone
            # 计分（先计分后碰撞，与原版一致）
            sc = occ & (~self.pscored[:, slot]) & (self.px[:, slot] + PW < BX)
            if np.any(sc):
                self.pscored[sc, slot] = True
                self._score_pipe(sc, slot)
            # 碰撞
            ex = (gs // 2).astype(np.float64)
            et = self.ptop[:, slot] + ex
            x_overlap = (BX + BW > np.trunc(self.px[:, slot])) & (BX < np.trunc(self.px[:, slot] + PW))
            y_hit = (self.bird_y < et) | (self.bird_y + BH > et + self.pgap[:, slot] - gs)
            hit = occ & x_overlap & y_hit & (~self.dead) & (self.invincible <= 0)
            if not np.any(hit):
                continue
            h = np.nonzero(hit)[0]
            if self.cfg.dodge_rate > 0:
                u, st = mul_next(self.rng_state[h])
                self.rng_state[h] = st
                dodged = u < self.cfg.dodge_rate
                if np.any(dodged):
                    d = h[dodged]
                    self.px[d, slot] = -1e9
                    self.pscored[d, slot] = False
                    hit[d] = False
            if not np.any(hit):
                continue
            h = np.nonzero(hit)[0]
            survive = self.lives[h] > 1
            hs = h[survive]
            if hs.size:
                self.lives[hs] -= 1.0
                self.ep_lives_lost[hs] += 1.0
                self.invincible[hs] = 1.5
                self.px[hs, slot] = -1e9
                self.pscored[hs, slot] = False
            hd = h[~survive]
            if hd.size:
                self.dead[hd] = True
        # 奖励（真实奖励 + 可选势函数塑形）
        reward = (self.rc.score_scale * (self.score - s0) + self.rc.alive
                  - self.rc.life_lost * np.maximum(0.0, lives0 - self.lives)
                  - self.rc.death * self.dead.astype(np.float64))
        if self.rc.shaping:
            phi1 = self.potential()
            reward = reward + np.where(self.dead, -phi0, self.rc.gamma * phi1 - phi0)
        self.ep_reward += reward
        self.ep_score = self.score
        self.ep_frames += 1
        # 自动开新局
        done = self.dead.copy()
        info: Dict[str, Any] = {}
        if np.any(done):
            idx = np.nonzero(done)[0]
            info["episode_scores"] = self.ep_score[idx].copy()
            info["episode_rewards"] = self.ep_reward[idx].copy()
            info["episode_frames"] = self.ep_frames[idx].copy()
            info["episode_lives_lost"] = self.ep_lives_lost[idx].copy()
            info["episode_env_idx"] = idx.copy()
            self._reset_masked(done)
        return self.obs(), reward, done, info

    # ------------------------------------------------------------------ 观测
    def obs(self) -> np.ndarray:
        n = self.n
        obs = np.zeros((n, OBS_DIM), dtype=np.float32)
        by = self.bird_y + BH / 2
        gs = np.minimum(self.level * 2, 16)
        active = (self.px > -1e8) & (self.px + PW > BX)
        big = np.where(active, self.px, np.inf)
        order1 = np.argmin(big, axis=1)
        has1 = np.take_along_axis(active, order1[:, None], axis=1)[:, 0]
        v = np.take_along_axis(big, order1[:, None], axis=1)[:, 0]
        big2 = np.where(np.arange(MAX_PIPES)[None, :] == order1[:, None], np.inf, big)
        order2 = np.argmin(big2, axis=1)
        has2 = np.take_along_axis(active, order2[:, None], axis=1)[:, 0]
        obs[:, 0] = self.bird_y / DESIGN_H
        obs[:, 1] = self.bird_v / 900.0
        rows = np.arange(n)
        for k, (order, has) in enumerate(((order1, has1), (order2, has2))):
            base = 2 + k * 11
            ti = self.ptype[rows, order]
            x = self.px[rows, order]
            top = self.ptop[rows, order]
            gap = self.pgap[rows, order]
            ph_base = self.pph[rows, order]
            speed = BPS * PSM[ti] + self.level * 8
            phase = self.frame * 0.04 + ph_base
            obs[:, base + 0] = np.where(has, (x - BX) / 500.0, 1.0)
            obs[:, base + 1] = np.where(has, (top + gap / 2 - by) / DESIGN_H, 0.0)
            obs[:, base + 2] = np.where(has, (gap - gs) / BGAP, 0.0)
            obs[:, base + 3] = np.where(has, speed / 600.0, 0.0)
            for t in range(5):
                obs[:, base + 4 + t] = np.where(has & (ti == t), 1.0, 0.0)
            isosc = has & (POSC[ti] != 0)
            obs[:, base + 9] = np.where(isosc, np.sin(phase), 0.0)
            obs[:, base + 10] = np.where(isosc, np.cos(phase), 0.0)
        obs[:, 24] = self.level / 20.0
        obs[:, 25] = self.lives / 6.0
        obs[:, 26] = self.invincible / 1.5
        obs[:, 27] = self.combo_timers[:, 3] / 5.0
        obs[:, 28] = self.combo_timers[:, 4] / 5.0
        req = self.cfg.req_combo
        for c in range(5):
            obs[:, 29 + c] = np.minimum(self.pipe_counts[:, c], req) / req
        return obs


# ==============================================================================
# 5. 经验回放（均匀 / 优先 PER）
# ==============================================================================
class ReplayBuffer:
    """固定容量环形回放池。"""

    def __init__(self, capacity: int, obs_dim: int, seed: int = 0):
        self.cap = capacity
        self.obs = np.zeros((capacity, obs_dim), dtype=np.float32)
        self.next_obs = np.zeros((capacity, obs_dim), dtype=np.float32)
        self.act = np.zeros(capacity, dtype=np.int64)
        self.rew = np.zeros(capacity, dtype=np.float32)
        self.done = np.zeros(capacity, dtype=np.float32)
        self.ptr = 0
        self.size = 0
        self.rng = np.random.default_rng(seed)

    def add(self, obs, act, rew, next_obs, done) -> np.ndarray:
        n = obs.shape[0]
        idx = (self.ptr + np.arange(n)) % self.cap
        self.obs[idx] = obs
        self.act[idx] = act
        self.rew[idx] = rew
        self.next_obs[idx] = next_obs
        self.done[idx] = done
        self.ptr = (self.ptr + n) % self.cap
        self.size = min(self.size + n, self.cap)
        return idx

    def sample(self, batch: int):
        idx = self.rng.integers(0, self.size, size=batch)
        return (self.obs[idx], self.act[idx], self.rew[idx], self.next_obs[idx], self.done[idx], idx)

    def update_priorities(self, idx, prio) -> None:
        """均匀回放：没有优先级可更新（PER 子类会覆盖）。"""
        return


class SumTree:
    """数组实现的求和树（PER 采样用），支持批量采样与批量更新。"""

    def __init__(self, capacity: int):
        size = 1
        while size < capacity:
            size *= 2
        self.size = size
        self.cap = capacity
        self.levels = int(math.log2(size))
        self.tree = np.zeros(2 * size, dtype=np.float64)
        self.max_prio = 1.0

    def batch_update(self, idxs: np.ndarray, prios: np.ndarray) -> None:
        node = idxs.astype(np.int64) + self.size
        self.tree[node] = prios
        for _ in range(self.levels):
            node = node >> 1
            self.tree[node] = self.tree[2 * node] + self.tree[2 * node + 1]
        self.max_prio = max(self.max_prio, float(prios.max()))

    def total(self) -> float:
        return float(self.tree[1])

    def sample(self, batch: int, rng: np.random.Generator):
        total = self.tree[1]
        if total <= 0:
            idx = rng.integers(0, self.size, size=batch)
            return idx, np.ones(batch)
        targets = rng.random(batch) * total
        node = np.ones(batch, dtype=np.int64)
        for _ in range(self.levels):
            left = 2 * node
            go_right = targets >= self.tree[left]
            targets = np.where(go_right, targets - self.tree[left], targets)
            node = np.where(go_right, left + 1, left)
        leaf = np.minimum(node - self.size, self.cap - 1)
        return leaf, self.tree[node]


class PrioritizedReplayBuffer(ReplayBuffer):
    """比例优先经验回放：p_i = |TD|^alpha，重要性采样权重 beta 线性退火。"""

    def __init__(self, capacity: int, obs_dim: int, seed: int = 0,
                 alpha: float = 0.6, beta0: float = 0.4, beta_steps: int = 300000):
        super().__init__(capacity, obs_dim, seed)
        self.alpha = alpha
        self.beta0 = beta0
        self.beta_steps = beta_steps
        self.beta = beta0
        self.tree = SumTree(capacity)
        self.eps = 1e-6

    def add(self, obs, act, rew, next_obs, done):
        idx = super().add(obs, act, rew, next_obs, done)
        self.tree.batch_update(idx, np.full(idx.size, self.tree.max_prio, dtype=np.float64))
        return idx

    def sample(self, batch: int):
        idx, prio = self.tree.sample(batch, self.rng)
        w = (self.size * prio / max(self.tree.total(), 1e-12)) ** (-self.beta)
        w = w / w.max()
        return (self.obs[idx], self.act[idx], self.rew[idx], self.next_obs[idx],
                self.done[idx], idx, w.astype(np.float32))

    def update_priorities(self, idx, prio) -> None:
        p = np.abs(prio) + self.eps
        self.tree.batch_update(idx, p ** self.alpha)

    def anneal_beta(self, step: int) -> None:
        frac = min(1.0, step / max(1, self.beta_steps))
        self.beta = self.beta0 + frac * (1.0 - self.beta0)


# ==============================================================================
# 6. DQN 网络与智能体
# ==============================================================================
def _build_net(obs_dim: int, n_actions: int, hidden: int, dueling: bool):
    import torch
    import torch.nn as nn

    class QNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.dueling = dueling
            self.backbone = nn.Sequential(
                nn.Linear(obs_dim, hidden), nn.ReLU(),
                nn.Linear(hidden, hidden), nn.ReLU(),
            )
            if dueling:
                self.value = nn.Sequential(nn.Linear(hidden, hidden // 2), nn.ReLU(),
                                           nn.Linear(hidden // 2, 1))
                self.adv = nn.Sequential(nn.Linear(hidden, hidden // 2), nn.ReLU(),
                                         nn.Linear(hidden // 2, n_actions))
            else:
                self.head = nn.Linear(hidden, n_actions)

        def forward(self, x):
            h = self.backbone(x)
            if self.dueling:
                v = self.value(h)
                a = self.adv(h)
                return v + a - a.mean(dim=1, keepdim=True)
            return self.head(h)

    return QNet()


class DQNAgent:
    """Dueling Double DQN + n-step + (可选)PER。"""

    def __init__(self, obs_dim: int = OBS_DIM, n_actions: int = N_ACTIONS,
                 hidden: int = 256, lr: float = 1e-4, gamma: float = 0.99,
                 n_step: int = 3, double: bool = True, dueling: bool = True,
                 per: bool = False, replay_size: int = 300_000,
                 batch_size: int = 256, device: str = "auto", seed: int = 0,
                 grad_clip: float = 10.0, target_sync: int = 2000):
        import torch
        self.torch = torch
        self.device = self._resolve_device(device)
        self.gamma = gamma
        self.n_step = n_step
        self.double = double
        self.per = per
        self.batch_size = batch_size
        self.target_sync = target_sync
        self.grad_clip = grad_clip
        self.n_actions = n_actions
        self.learn_steps = 0
        self.rng = np.random.default_rng(seed + 777)
        torch.manual_seed(seed)
        self.q = _build_net(obs_dim, n_actions, hidden, dueling).to(self.device)
        self.target = _build_net(obs_dim, n_actions, hidden, dueling).to(self.device)
        self.target.load_state_dict(self.q.state_dict())
        self.target.eval()
        self.opt = torch.optim.Adam(self.q.parameters(), lr=lr)
        buf_cls = PrioritizedReplayBuffer if per else ReplayBuffer
        self.buffer = buf_cls(replay_size, obs_dim, seed=seed)

    @staticmethod
    def _resolve_device(device: str) -> str:
        import torch
        if device == "auto":
            return "cuda" if torch.cuda.is_available() else "cpu"
        return device

    # ------------------------------------------------------------------ 动作
    def act(self, obs: np.ndarray, epsilon: float = 0.0) -> np.ndarray:
        n = obs.shape[0]
        if epsilon > 0:
            explore = self.rng.random(n) < epsilon
        else:
            explore = np.zeros(n, dtype=bool)
        actions = np.zeros(n, dtype=np.int64)
        if (~explore).any():
            with self.torch.no_grad():
                t = self.torch.as_tensor(obs[~explore], device=self.device)
                q = self.q(t)
                actions[~explore] = q.argmax(dim=1).cpu().numpy()
        if explore.any():
            actions[explore] = self.rng.integers(0, self.n_actions, size=int(explore.sum()))
        return actions

    def q_values(self, obs: np.ndarray) -> np.ndarray:
        with self.torch.no_grad():
            t = self.torch.as_tensor(obs, device=self.device)
            return self.q(t).cpu().numpy()

    # ------------------------------------------------------------------ 学习
    def learn(self, discount_pow: float) -> Optional[float]:
        torch = self.torch
        if self.buffer.size < self.batch_size:
            return None
        if self.per:
            obs, act, rew, nobs, done, idx, w = self.buffer.sample(self.batch_size)
            self.buffer.anneal_beta(self.learn_steps)
            w_t = torch.as_tensor(w, device=self.device)
        else:
            obs, act, rew, nobs, done, idx = self.buffer.sample(self.batch_size)
            w_t = None
        obs_t = torch.as_tensor(obs, device=self.device)
        act_t = torch.as_tensor(act, device=self.device).unsqueeze(1)
        rew_t = torch.as_tensor(rew, device=self.device)
        nobs_t = torch.as_tensor(nobs, device=self.device)
        done_t = torch.as_tensor(done, device=self.device)
        q = self.q(obs_t).gather(1, act_t).squeeze(1)
        with torch.no_grad():
            if self.double:
                a_star = self.q(nobs_t).argmax(dim=1, keepdim=True)
                q_next = self.target(nobs_t).gather(1, a_star).squeeze(1)
            else:
                q_next = self.target(nobs_t).max(dim=1).values
            target = rew_t + (self.gamma ** discount_pow) * q_next * (1.0 - done_t)
        td = q - target
        loss = torch.nn.functional.smooth_l1_loss(q, target, reduction="none")
        if w_t is not None:
            loss = loss * w_t
        loss = loss.mean()
        self.opt.zero_grad(set_to_none=True)
        loss.backward()
        if self.grad_clip:
            torch.nn.utils.clip_grad_norm_(self.q.parameters(), self.grad_clip)
        self.opt.step()
        self.learn_steps += 1
        if self.per:
            self.buffer.update_priorities(idx, td.detach().abs().cpu().numpy())
        if self.learn_steps % self.target_sync == 0:
            self.target.load_state_dict(self.q.state_dict())
        return float(loss.item())

    # ------------------------------------------------------------------ 存取
    def save(self, path: str, extra: Optional[Dict[str, Any]] = None) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        payload = {"q": self.q.state_dict(), "target": self.target.state_dict(),
                   "learn_steps": self.learn_steps, "extra": extra or {}}
        self.torch.save(payload, path)

    def load(self, path: str, map_location: Optional[str] = None) -> Dict[str, Any]:
        payload = self.torch.load(path, map_location=map_location or self.device, weights_only=False)
        self.q.load_state_dict(payload["q"])
        self.target.load_state_dict(payload.get("target", payload["q"]))
        self.learn_steps = payload.get("learn_steps", 0)
        return payload.get("extra", {})


# ==============================================================================
# 7. n-step 回放装配
# ==============================================================================
class NStepAccumulator:
    """把向量环境每个 tick 的 (obs, act, rew, done) 组装成 n-step 转移。"""

    def __init__(self, n_envs: int, obs_dim: int, n_step: int, gamma: float):
        self.n = n_envs
        self.k = n_step
        self.gamma = gamma
        self.obs = np.zeros((n_step, n_envs, obs_dim), dtype=np.float32)
        self.act = np.zeros((n_step, n_envs), dtype=np.int64)
        self.rew = np.zeros((n_step, n_envs), dtype=np.float32)
        self.done = np.zeros((n_step, n_envs), dtype=np.float32)
        self.filled = 0
        self.ptr = 0

    def push(self, obs, act, rew, done):
        i = self.ptr
        self.obs[i] = obs
        self.act[i] = act
        self.rew[i] = rew
        self.done[i] = done
        self.ptr = (self.ptr + 1) % self.k
        self.filled = min(self.filled + 1, self.k)

    def ready_batch(self, next_obs: np.ndarray):
        """返回最老的那一组 n-step 转移（若不足 n 步则返回 None）。

        next_obs 是本 tick 环境返回的 s_{t+n}，正是最老转移要自举的那个状态
        （之前误用了环内最后一个 obs，等于晚了一步，属 off-by-one）。
        """
        if self.filled < self.k:
            return None
        i0 = self.ptr  # 最老的位置
        rew = np.zeros(self.n, dtype=np.float32)
        done = np.zeros(self.n, dtype=np.float32)
        cutoff = np.zeros(self.n, dtype=bool)
        for j in range(self.k):
            idx = (i0 + j) % self.k
            alive = ~cutoff
            rew = np.where(alive, rew + (self.gamma ** j) * self.rew[idx], rew)
            cutoff |= self.done[idx] > 0
            done = np.where((self.done[idx] > 0) & alive, 1.0, done)
        return (self.obs[i0].copy(), self.act[i0].copy(), rew, next_obs.copy(), done)


# ==============================================================================
# 8. 策略与评估
# ==============================================================================
def scalar_heuristic_action(env: ScalarBirdEnv, bias: float = 15.0) -> int:
    """手写启发式控制器（与 tools/ref_env.js 内的实现同款），用于基线与自检。"""
    by = env.bird_y + BH / 2
    target = 280.0
    best = None
    for p in env.pipes:
        if p.x + PW > BX and (best is None or p.x < best.x):
            best = p
    if best is not None:
        d = PIPE_TYPES[best.type]
        sp = BPS * d["sm"] + env.level * 8
        ta = max(0.0, (best.x - BX) / sp)
        if d["osc"]:
            top = best.base_th + math.sin((env.frame + ta * 60) * 0.04 + best.ph) * d["osc"]
        else:
            top = best.top_h
        target = top + best.gap / 2 + bias
    return 1 if (by > target and env.bird_v > -30) else 0


def vec_heuristic_actions(env: VectorBirdEnv) -> np.ndarray:
    """和 JS ref_env 里同款的启发式（含浮动管预测），用于基线对比。"""
    n = env.n
    by = env.bird_y + BH / 2
    out = np.zeros(n, dtype=np.int64)
    active = (env.px > -1e8) & (env.px + PW > BX)
    big = np.where(active, env.px, np.inf)
    order = np.argmin(big, axis=1)
    rows = np.arange(n)
    has = active[rows, order]
    x = env.px[rows, order]
    top = env.ptop[rows, order]
    gap = env.pgap[rows, order]
    ti = env.ptype[rows, order]
    ph = env.pph[rows, order]
    sp = BPS * PSM[ti] + env.level * 8
    ta = np.maximum(0.0, (x - BX) / np.maximum(sp, 1e-6))
    phase = (env.frame + ta * 60) * 0.04 + ph
    top_pred = np.where(POSC[ti] != 0, env.pbase[rows, order] + np.sin(phase) * POSC[ti], top)
    center = top_pred + gap / 2 + 15.0
    default_center = np.full(n, 280.0)
    center = np.where(has, center, default_center)
    return ((by > center) & (env.bird_v > -30)).astype(np.int64)


def evaluate_policy(agent: Optional[DQNAgent], episodes: int, config: GameConfig,
                    seed: int = 12345, policy: str = "greedy",
                    max_frames: int = 18000) -> Dict[str, Any]:
    """用向量化环境跑 N 局（每只鸟取第一局），返回分数统计。

    max_frames 是"每个 tick 的墙钟上限"（tick 数 ≈ 游戏秒数 × 60），
    超时的鸟按当前分数计入并标记 censored（分数只会更高）。
    """
    env = VectorBirdEnv(episodes, config, seed=seed)
    obs = env.reset()
    first_score = np.full(episodes, np.nan)
    first_frames = np.full(episodes, np.nan)
    rng = np.random.default_rng(seed)
    t = 0
    while np.isnan(first_score).any() and t < max_frames:
        if policy == "greedy" and agent is not None:
            act = agent.act(obs, 0.0)
        elif policy == "heuristic":
            act = vec_heuristic_actions(env)
        else:
            act = rng.integers(0, 2, size=episodes)
        obs, rew, done, info = env.step(act)
        if "episode_scores" in info:
            for k, ei in enumerate(info["episode_env_idx"]):
                if np.isnan(first_score[ei]):
                    first_score[ei] = info["episode_scores"][k]
                    first_frames[ei] = info["episode_frames"][k]
        t += 1
    censored = int(np.isnan(first_score).sum())
    if censored:   # 未结束的鸟：取当前分数（下限）
        idx = np.nonzero(np.isnan(first_score))[0]
        first_score[idx] = env.score[idx]
        first_frames[idx] = env.frame[idx]
    arr = first_score[~np.isnan(first_score)]
    fr = first_frames[~np.isnan(first_frames)]
    return {
        "episodes": int(len(arr)),
        "censored": censored,
        "mean": float(arr.mean()) if arr.size else 0.0,
        "median": float(np.median(arr)) if arr.size else 0.0,
        "max": float(arr.max()) if arr.size else 0.0,
        "min": float(arr.min()) if arr.size else 0.0,
        "std": float(arr.std()) if arr.size else 0.0,
        "p90": float(np.percentile(arr, 90)) if arr.size else 0.0,
        "mean_frames": float(fr.mean()) if fr.size else 0.0,
        "scores": [float(x) for x in arr],
    }


# ==============================================================================
# 9. 训练
# ==============================================================================
def linear_epsilon(step: int, start: float, end: float, decay_steps: int) -> float:
    if step >= decay_steps:
        return end
    return start + (end - start) * (step / decay_steps)


def train(args) -> None:
    import torch
    cfg = GameConfig(bird=args.bird, stars=tuple(args.stars), wings=args.wings)
    rc = RewardConfig(score_scale=args.r_score, alive=args.r_alive,
                      life_lost=args.r_life, death=args.r_death,
                      shaping=args.r_shaping, gamma=args.gamma)
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)

    agent = DQNAgent(obs_dim=OBS_DIM, hidden=args.hidden, lr=args.lr, gamma=args.gamma,
                     n_step=args.n_step, double=not args.no_double,
                     dueling=not args.no_dueling, per=(args.replay == "per"),
                     replay_size=args.replay_size, batch_size=args.batch_size,
                     device=args.device, seed=args.seed, target_sync=args.target_sync)
    if args.ckpt and os.path.exists(args.ckpt):
        agent.load(args.ckpt)
        print(f"[加载] 续训自 {args.ckpt}（已完成 {agent.learn_steps} 次梯度更新）")
    print(f"[配置] 玩法={cfg.describe()}  设备={agent.device}  网络={'Dueling' if not args.no_dueling else 'MLP'}"
          f"  Double={not args.no_double}  回放={args.replay}  n_step={args.n_step}  N={args.n_envs}")

    env = VectorBirdEnv(args.n_envs, cfg, seed=args.seed, reward_cfg=rc)
    obs = env.reset()
    acc = NStepAccumulator(args.n_envs, OBS_DIM, args.n_step, args.gamma)
    log_path = os.path.join(out_dir, "log.csv")
    csv_f = open(log_path, "a", newline="")
    csv_w = csv.writer(csv_f)
    if csv_f.tell() == 0:
        csv_w.writerow(["agent_steps", "env_steps", "wall_s", "epsilon", "loss",
                        "ep_score_ma100", "ep_score_ma20", "ep_len_ma100",
                        "eval_mean", "eval_median", "eval_max", "eval_p90", "best_eval"])
    recent_scores: deque = deque(maxlen=100)
    recent_lens: deque = deque(maxlen=100)
    best_eval = -1e18
    if args.ckpt and os.path.exists(args.ckpt):
        try:
            meta = torch.load(args.ckpt, map_location="cpu", weights_only=False).get("extra", {})
            prev = meta.get("score", {}).get("mean")
            if prev is not None:
                best_eval = float(prev)
                print(f"[续训] 以载入权重的历史评估均值 {best_eval:.2f} 作为 best 基准")
        except Exception:  # noqa: BLE001
            pass
    t0 = time.time()
    total_updates = 0
    loss_ema: Optional[float] = None
    step = 0
    next_eval = args.eval_start

    while step < args.steps:
        eps = linear_epsilon(step, args.eps_start, args.eps_end, args.eps_decay)
        act = agent.act(obs, eps)
        nobs, rew, done, info = env.step(act)
        acc.push(obs, act, rew, done.astype(np.float32))
        ready = acc.ready_batch(nobs)
        if ready is not None:
            o, a, r, no, d = ready
            agent.buffer.add(o, a, r, no, d)
        if "episode_scores" in info:
            recent_scores.extend(info["episode_scores"].tolist())
            recent_lens.extend(info["episode_frames"].tolist())
        obs = nobs
        step += args.n_envs
        # 梯度更新
        if step >= args.learning_starts and ready is not None:
            for _ in range(args.updates_per_step):
                loss = agent.learn(args.n_step)
                if loss is not None:
                    total_updates += 1
                    loss_ema = loss if loss_ema is None else 0.99 * loss_ema + 0.01 * loss
        # 日志
        if step >= next_eval:
            ev = evaluate_policy(agent, args.eval_episodes, cfg, seed=args.eval_seed,
                                 policy="greedy")
            ma100 = float(np.mean(recent_scores)) if recent_scores else 0.0
            ma20 = float(np.mean(list(recent_scores)[-20:])) if recent_scores else 0.0
            lma = float(np.mean(recent_lens)) if recent_lens else 0.0
            wall = time.time() - t0
            csv_w.writerow([step, step, f"{wall:.1f}", f"{eps:.4f}",
                            f"{loss_ema:.5f}" if loss_ema else "",
                            f"{ma100:.2f}", f"{ma20:.2f}", f"{lma:.1f}",
                            f"{ev['mean']:.2f}", f"{ev['median']:.2f}",
                            f"{ev['max']:.1f}", f"{ev['p90']:.1f}", f"{best_eval:.2f}"])
            csv_f.flush()
            print(f"[{wall:7.1f}s] step={step:>8} eps={eps:.3f} loss={loss_ema if loss_ema else 0:.4f} "
                  f"train_ma100={ma100:7.2f} | 评估 {ev['episodes']}局: 均{ev['mean']:7.2f} "
                  f"中位{ev['median']:7.1f} 最高{ev['max']:6.0f} P90{ev['p90']:7.1f} | 更新{total_updates}")
            if ev["mean"] > best_eval:
                best_eval = ev["mean"]
                agent.save(os.path.join(out_dir, "best.pt"),
                           dict(score=ev, config=asdict(cfg), step=step,
                                hidden=args.hidden, dueling=not args.no_dueling,
                                n_step=args.n_step, gamma=args.gamma,
                                bird=args.bird, stars=list(args.stars), wings=args.wings))
                print(f"          ↑ 新最优（评估均值 {ev['mean']:.2f}），已保存 best.pt")
            agent.save(os.path.join(out_dir, "last.pt"),
                       dict(score=ev, config=asdict(cfg), step=step,
                            hidden=args.hidden, dueling=not args.no_dueling,
                            n_step=args.n_step, gamma=args.gamma,
                            bird=args.bird, stars=list(args.stars), wings=args.wings))
            next_eval = step + args.eval_every
    csv_f.close()
    print(f"[完成] {step} 步，用时 {(time.time() - t0) / 60:.1f} 分钟，最优评估均值 {best_eval:.2f}")


# ==============================================================================
# 10. 命令行
# ==============================================================================
def cmd_train(a):
    train(a)


def cmd_eval(a):
    # 先用默认结构读一次权重元信息，再按训练时的结构重建网络
    probe = DQNAgent(obs_dim=OBS_DIM, device=a.device)
    meta = probe.load(a.ckpt)
    agent = DQNAgent(obs_dim=OBS_DIM, hidden=int(meta.get("hidden", 256)),
                     dueling=bool(meta.get("dueling", True)),
                     n_step=int(meta.get("n_step", 3)), gamma=float(meta.get("gamma", 0.99)),
                     device=a.device)
    meta = agent.load(a.ckpt)
    bird = a.bird if a.bird is not None else int(meta.get("bird", a.bird or 0))
    stars = tuple(a.stars) if a.stars is not None else tuple(meta.get("stars", [1, 1, 1]))
    wings = a.wings if a.wings is not None else bool(meta.get("wings", False))
    cfg = GameConfig(bird=bird, stars=stars, wings=wings)
    print(f"[权重] {a.ckpt}  梯度更新={agent.learn_steps}  训练时评估记录="
          f"{json.dumps(meta.get('score', {}), ensure_ascii=False)[:260]}")
    print(f"[玩法] {cfg.describe()}（--bird/--stars/--wings 可覆盖）")
    res = evaluate_policy(agent, a.episodes, cfg, seed=a.seed, policy="greedy")
    print(f"[评估] {res['episodes']} 局  均值 {res['mean']:.2f}  中位 {res['median']:.1f}  "
          f"最高 {res['max']:.0f}  P90 {res['p90']:.1f}  最低 {res['min']:.0f}  平均存活 {res['mean_frames']:.0f} 帧")
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"config": asdict(cfg), "result": res}, f, ensure_ascii=False, indent=2)
        print(f"[输出] {a.json}")


def cmd_baselines(a):
    cfg = GameConfig(bird=a.bird, stars=tuple(a.stars), wings=a.wings)
    for policy in ["random", "heuristic"]:
        res = evaluate_policy(None, a.episodes, cfg, seed=a.seed, policy=policy)
        print(f"[基线·{policy:9s}] 均值 {res['mean']:7.2f}  中位 {res['median']:6.1f}  "
              f"最高 {res['max']:6.0f}  P90 {res['p90']:6.1f}  最低 {res['min']:5.0f}  "
              f"平均存活 {res['mean_frames']:6.0f} 帧")
        if a.json:
            with open(a.json, "a") as f:
                f.write(json.dumps({"policy": policy, "config": asdict(cfg), "result": res},
                                   ensure_ascii=False) + "\n")


def cmd_bench(a):
    cfg = GameConfig(bird=a.bird, stars=tuple(a.stars), wings=a.wings)
    env = VectorBirdEnv(a.n_envs, cfg, seed=0)
    obs = env.reset()
    n_steps = a.steps
    t0 = time.time()
    rng = np.random.default_rng(0)
    for _ in range(n_steps):
        obs, r, d, info = env.step(rng.integers(0, 2, size=a.n_envs))
    el = time.time() - t0
    bird_steps = n_steps * a.n_envs
    print(f"[吞吐] N={a.n_envs}  {n_steps} tick  {bird_steps} 鸟步  用时 {el:.3f}s")
    print(f"        ≈ {bird_steps / el / 1e6:.2f} M 鸟步/秒   （等价 {bird_steps / el / 60 / 1e6:.2f} M 游戏分钟/秒）")


def cmd_parity(a):
    """调用 tools/parity_test.py 做逐帧一致性验证。"""
    here = os.path.dirname(os.path.abspath(__file__))
    script = os.path.join(here, "tools", "parity_test.py")
    cmd = [sys.executable, script, "--episodes", str(a.episodes), "--seed", str(a.seed)]
    if a.keep:
        cmd.append("--keep")
    sys.exit(subprocess.call(cmd))


def cmd_self_test(a):
    # 1) PRNG 与 JS 一致性（直接调用 Node 参考环境自检）
    js_ref = [0.9797282677609473, 0.3067522644996643, 0.484205421525985,
              0.817934412509203, 0.5094283693470061, 0.34747186047025025,
              0.07375754183158278, 0.7663964673411101, 0.9968264393974096,
              0.8250224851071835]
    here = os.path.dirname(os.path.abspath(__file__))
    ref = os.path.join(here, "tools", "ref_env.js")
    if os.path.exists(ref):
        try:
            out = subprocess.run(["node", ref, "--self-test"], capture_output=True, text=True, timeout=30)
            if out.returncode == 0 and out.stdout.strip():
                js_ref = json.loads(out.stdout.strip())
        except Exception as e:  # noqa: BLE001
            print(f"  (跳过 Node 自检：{e})")
    rng0 = Mulberry32(12345)
    got = [rng0.random() for _ in range(len(js_ref))]
    assert got == js_ref, f"PRNG 与 JS 不一致:\n{got}\n{js_ref}"
    print(f"[1/4] mulberry32 标量实现与 Node 逐位一致（{len(js_ref)} 个随机数完全相同）✓")
    # 2) 向量化 PRNG 与标量一致
    st = np.array([12345, 999, 7], dtype=np.uint32)
    vs = st.copy()
    for i in range(5):
        u, vs = mul_next(vs)
        for j, seed in enumerate([12345, 999, 7]):
            rr = Mulberry32(seed)
            for _ in range(i + 1):
                exp = rr.random()
            assert abs(u[j] - exp) < 1e-15, (i, j, u[j], exp)
    print("[2/4] mulberry32 向量化实现与标量一致 ✓")
    # 3) 两个环境在脚本化管道序列下逐帧一致
    seq = [(i % 5, 60 + i * 7, 0.3 * i) for i in range(200)]
    se = ScalarBirdEnv(GameConfig(), seed=1, pipe_seq=seq)
    ve = VectorBirdEnv(1, GameConfig(), seed=1, pipe_seq=seq)
    se.reset()
    ve.reset(seeds=[1])
    rng = np.random.default_rng(0)
    t = 0
    for t in range(20000):
        a = scalar_heuristic_action(se)          # 用启发式动作，保证能跑出长局
        if t % 37 == 0:
            a = int(rng.integers(0, 2))          # 偶尔掺入随机动作，覆盖碰撞/掉命分支
        so, sr, sd, si = se.step(int(a))
        vo, vr, vd, vi = ve.step(np.array([int(a)]))
        assert abs(sr - vr[0]) < 1e-9, (t, sr, vr)
        assert int(sd) == int(vd[0]), (t, sd, vd)
        if sd:
            break
        assert abs(se.bird_y - ve.bird_y[0]) < 1e-9, (t, se.bird_y, ve.bird_y[0])
        assert se.score == ve.score[0], (t, se.score, ve.score[0])
        assert se.lives == ve.lives[0], (t, se.lives, ve.lives[0])
        assert len(se.pipes) == int(np.sum(ve.px[0] > -1e8)), (t, len(se.pipes), ve.px[0])
        se_x = sorted(round(p.x, 6) for p in se.pipes)
        ve_x = sorted(round(float(v), 6) for v in ve.px[0] if v > -1e8)
        assert se_x == ve_x, (t, se_x, ve_x)
    print(f"[3/4] 标量与向量环境逐帧一致（{t + 1} 帧，得分 {si['score']:.0f}，"
          f"等级 {si['level']}）✓")
    # 4) 观测维度
    assert so.shape == (OBS_DIM,), so.shape
    print(f"[4/4] 观测维度 {OBS_DIM} ✓")
    print("self-test 全部通过")


def cmd_plot(a):
    """画训练曲线（标签用英文，避免无 CJK 字体时出现方块）。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    pretty = {"lr25": "phase-1: from scratch (2M steps, lr 2.5e-4)",
              "main": "phase-2: fine-tune (6M steps, lr 5e-5)"}
    series = []
    for path in a.csv:
        rows = list(csv.DictReader(open(path)))
        if rows:
            d = os.path.basename(os.path.dirname(os.path.abspath(path)))
            series.append((pretty.get(d, d), rows))
    if not series:
        print("CSV 为空"); return
    fig, axes = plt.subplots(1, 3, figsize=(16.5, 4.6))
    for name, rows in series:
        x = [float(r["agent_steps"]) for r in rows]
        axes[0].plot(x, [float(r["ep_score_ma100"]) for r in rows], lw=1.8,
                     label=f"{name.split(':')[0]} train (100-ep MA)")
        axes[1].plot(x, [float(r["eval_mean"]) for r in rows], lw=2.0, label=f"{name.split(':')[0]} eval mean")
        axes[1].plot(x, [float(r["eval_median"]) for r in rows], "--", lw=1.2, alpha=.8,
                     label=f"{name.split(':')[0]} eval median")
        axes[1].plot(x, [float(r["eval_max"]) for r in rows], ":", lw=1.4, alpha=.9,
                     label=f"{name.split(':')[0]} eval max")
        axes[2].plot(x, [float(r["loss"]) if r["loss"] else np.nan for r in rows], lw=1.3,
                     label=name.split(':')[0])
    axes[0].set_xlabel("agent steps"); axes[0].set_ylabel("pipes passed per episode")
    axes[0].legend(fontsize=8); axes[0].grid(alpha=.3)
    axes[0].set_title("Training score (moving average)")
    axes[1].set_xlabel("agent steps"); axes[1].set_ylabel("score per episode")
    axes[1].legend(fontsize=8); axes[1].grid(alpha=.3)
    axes[1].set_title("Greedy evaluation (50 episodes, fixed seeds)")
    axes[2].set_xlabel("agent steps"); axes[2].set_ylabel("Huber loss")
    axes[2].legend(fontsize=8); axes[2].grid(alpha=.3); axes[2].set_yscale("log")
    axes[2].set_title("TD loss")
    fig.tight_layout()
    fig.savefig(a.out, dpi=130)
    print(f"[绘图] {a.out}")


def build_parser():
    p = argparse.ArgumentParser(description="小鸟过管道 · DQN 强化学习")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, optional: bool = False):
        d = None if optional else 0
        sp.add_argument("--bird", type=int, default=d, choices=[0, 1, 2])
        sp.add_argument("--stars", type=int, nargs=3, default=None if optional else [1, 1, 1])
        sp.add_argument("--wings", action="store_true", default=None if optional else False)

    sp = sub.add_parser("train", help="训练")
    common(sp)
    sp.add_argument("--steps", type=int, default=3_000_000, help="总 agent 步数")
    sp.add_argument("--n-envs", type=int, default=256)
    sp.add_argument("--device", default="auto")
    sp.add_argument("--out", default="runs/main")
    sp.add_argument("--ckpt", default=None, help="续训权重")
    sp.add_argument("--hidden", type=int, default=256)
    sp.add_argument("--lr", type=float, default=1e-4)
    sp.add_argument("--gamma", type=float, default=0.99)
    sp.add_argument("--n-step", type=int, default=3)
    sp.add_argument("--batch-size", type=int, default=256)
    sp.add_argument("--replay-size", type=int, default=300_000)
    sp.add_argument("--replay", choices=["uniform", "per"], default="per")
    sp.add_argument("--updates-per-step", type=int, default=64, help="每个向量 tick 的梯度更新次数")
    sp.add_argument("--learning-starts", type=int, default=20_000)
    sp.add_argument("--eps-start", type=float, default=1.0)
    sp.add_argument("--eps-end", type=float, default=0.05)
    sp.add_argument("--eps-decay", type=int, default=200_000)
    sp.add_argument("--target-sync", type=int, default=2000)
    sp.add_argument("--seed", type=int, default=0)
    sp.add_argument("--eval-every", type=int, default=50_000)
    sp.add_argument("--eval-start", type=int, default=50_000)
    sp.add_argument("--eval-episodes", type=int, default=50)
    sp.add_argument("--eval-seed", type=int, default=12345)
    sp.add_argument("--no-double", action="store_true")
    sp.add_argument("--no-dueling", action="store_true")
    sp.add_argument("--r-score", type=float, default=1.0)
    sp.add_argument("--r-alive", type=float, default=0.0)
    sp.add_argument("--r-life", type=float, default=1.0)
    sp.add_argument("--r-death", type=float, default=1.0)
    sp.add_argument("--r-shaping", type=float, default=0.5, help="势函数塑形系数(0=关闭)")
    sp.set_defaults(func=cmd_train)

    sp = sub.add_parser("eval", help="评估权重")
    common(sp, optional=True)
    sp.add_argument("--ckpt", required=True)
    sp.add_argument("--episodes", type=int, default=200)
    sp.add_argument("--seed", type=int, default=12345)
    sp.add_argument("--device", default="auto")
    sp.add_argument("--json", default=None)
    sp.set_defaults(func=cmd_eval)

    sp = sub.add_parser("baselines", help="随机/启发式基线")
    common(sp)
    sp.add_argument("--episodes", type=int, default=200)
    sp.add_argument("--seed", type=int, default=12345)
    sp.add_argument("--json", default=None)
    sp.set_defaults(func=cmd_baselines)

    sp = sub.add_parser("bench", help="环境吞吐测试")
    common(sp)
    sp.add_argument("--n-envs", type=int, default=512)
    sp.add_argument("--steps", type=int, default=2000)
    sp.set_defaults(func=cmd_bench)

    sp = sub.add_parser("parity", help="与原版 JS 逐帧对拍")
    sp.add_argument("--episodes", type=int, default=20)
    sp.add_argument("--seed", type=int, default=1)
    sp.add_argument("--keep", action="store_true")
    sp.set_defaults(func=cmd_parity)

    sp = sub.add_parser("plot", help="画训练曲线")
    sp.add_argument("--csv", nargs="+", default=["runs/main/log.csv"])
    sp.add_argument("--out", default="runs/main/curve.png")
    sp.set_defaults(func=cmd_plot)

    sp = sub.add_parser("self-test", help="自检")
    sp.set_defaults(func=cmd_self_test)
    return p


def main():
    p = build_parser()
    a = p.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
