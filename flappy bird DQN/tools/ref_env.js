#!/usr/bin/env node
/**
 * ref_env.js —— 《小鸟过管道》无头参考环境（Ground Truth）
 * ============================================================================
 * 本脚本 **不重写、不修改** 任何游戏逻辑：它把原版小游戏的 js/main.js 原封不动
 * 载入 Node 的 vm 沙箱（stub 掉 wx.* 图形/音频 API），然后直接调用游戏内部的
 * reset() / upd(dt) / 输入处理，把每一帧的完整状态以 JSONL 流式输出。
 *
 * 用途：
 *   1. 作为 Python 移植版环境的"地面真值"，做逐帧一致性验证（tools/parity_test.py）
 *   2. 证明 RL 训练用的环境与真机游戏逻辑完全一致（而不是"另写了一个类似游戏"）
 *
 * 用法：
 *   node tools/ref_env.js --job job.json                 # 从 job 文件读取任务
 *   node tools/ref_env.js --job job.json --out out.jsonl # 输出到文件
 *   node tools/ref_env.js --self-test                    # PRNG 自检
 *
 * job.json 格式：
 * {
 *   "game": "tools/upstream_main.js",     // 可选，默认本目录 upstream_main.js
 *   "config": {"bird":0, "stars":[1,1,1], "wings":false, "rocket":false},
 *   "episodes": [
 *      {"seed": 1, "actions": "0100101...", "controller": "replay", "maxFrames": 20000}
 *   ]
 * }
 *   controller = "replay"    : 用 actions 字符串逐帧回放（Python 侧传入）
 *              = "heuristic"  : 由内置启发式控制器现场决策（用于生成高分局回放数据）
 *              = "random"     : 随机动作
 *
 * 输出 JSONL：每帧一行 {"e":<episode>,"f":<frame>,"a":<action>,"s":[...state...]}
 * 状态数组 s 依次为：
 *   [birdY, birdV, score, level, lives, pipesPassed, frame, invincible,
 *    pipeCounts×5, comboTimers×5, lastSpawnX, npipes, (x,topH,gap,type,scored)×npipes]
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// ---------------------------------------------------------------- 种子化 PRNG
// mulberry32：双端（JS / Python）逐位一致的实现，保证同种子下随机流完全相同。
function mulberry32(a) {
  let s = a >>> 0;
  const f = function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.state = () => s >>> 0;   // 当前内部状态（用于逐帧随机流比对）
  return f;
}

// ---------------------------------------------------------------- 载入原版游戏
function loadGame(gamePath) {
  let code = fs.readFileSync(gamePath, 'utf8');
  // 唯一的一处"外科手术"：把 ES module 的默认导出改成普通类声明，
  // 这样可以直接丢进 vm 沙箱执行；其余源码一字未动。
  const before = code;
  code = code.replace('export default class Main', 'class Main');
  if (code === before) throw new Error('未能定位 export default class Main，请检查 main.js 版本');
  // 追加一个观测/控制用的钩子（读的是同一个模块作用域里的变量，不改变任何逻辑）
  code += `
globalThis.__API = {
  reset, upd, mkPipe, pipeReward, die,
  flap() { birdV = JV; },
  setScreen(s) { screen = s; },
  isOver() { return screen !== 'playing'; },
  setConfig(cfg) {
    selectedBird = cfg.bird || 0;
    birdStars = (cfg.stars || [1,1,1]).slice();
    shopState.rocket.equipped = !!cfg.rocket;
    shopState.wings.equipped = !!cfg.wings;
  },
  snap() {
    const s = [birdY, birdV, score, level, lives, pipesPassed, frame, invincible];
    for (let i = 0; i < 5; i++) s.push(pipeCounts[i]);
    for (let i = 0; i < 5; i++) s.push(comboTimers[i]);
    s.push(lastSpawnX, pipes.length);
    for (let i = 0; i < pipes.length; i++) {
      const p = pipes[i];
      s.push(p.x, p.topH, p.gap, p.type, p.scored ? 1 : 0);
    }
    s.push(globalThis.__PRNG.state(), globalThis.__PRNG.calls, ptN);   // 末三位：随机流状态 + 调用次数 + 存活粒子数
    return s;
  },
  consts() { return { G, JV, BPS, PW, BGAP, SPAWN, BW, BH, BX, GH, FAST_GAP, tpSum,
                       PD: PD.map(d => ({ sm: d.sm, gm: d.gm, pts: d.pts, prob: d.prob,
                                          fast: d.fast || 0, osc: d.osc || 0 })) }; },
  nextPipe() {
    let best = null;
    for (let i = 0; i < pipes.length; i++) {
      const p = pipes[i];
      if (p.x + PW > BX && (best === null || p.x < best.x)) best = p;
    }
    return best ? { x: best.x, topH: best.topH, gap: best.gap, type: best.type,
                    baseTH: best.baseTH, ph: best.ph, scored: best.scored } : null;
  }
};`;
  return code;
}

function makeSandbox(prng, api) {
  const noop = () => {};
  const ctxProxy = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (t[k] = noop)),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const store = {};
  const wx = {
    createCanvas: () => ({ getContext: () => ctxProxy, width: 0, height: 0 }),
    getSystemInfoSync: () => ({ screenWidth: 400, screenHeight: 600, pixelRatio: 2 }),
    getOpenDataContext: () => { throw new Error('headless: no open data context'); },
    createWebAudioContext: () => null,
    createImage: () => ({}),
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v; },
    setUserCloudStorage: noop,
    onTouchStart: noop, onTouchMove: noop, onTouchEnd: noop,
  };
  // 独立的 Math 对象：把 random 换成种子化 PRNG，其余方法沿用原生实现
  const M = Object.create(Math);
  M.random = prng;
  // 统计随机数调用次数（对拍定位用）
  const counted = function () { counted.calls++; return prng(); };
  counted.calls = 0;
  counted.state = () => prng.state();
  M.random = counted;
  const sandbox = {
    wx, Math: M, console, Date, JSON, parseInt, parseFloat, isNaN,
    Array, Object, String, Number, Boolean, Error, Proxy, Symbol,
    requestAnimationFrame: noop, setTimeout: noop, clearTimeout: noop,
    __PRNG: counted, __HOOKS: api,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

// ---------------------------------------------------------------- 启发式控制器
// 仅用于生成"能打高分"的动作序列（给 Python 提供深度覆盖的对照数据）
function heuristicAction(api, consts) {
  const s = api.snap();
  const birdY = s[0], birdV = s[1], level = s[3], frame = s[6];
  const p = api.nextPipe();
  let center = 280;
  if (p) {
    const d = consts.PD[p.type];
    const sp = consts.BPS * d.sm + level * 8;
    const ta = Math.max(0, (p.x - consts.BX) / sp);
    const topH = d.osc ? p.baseTH + Math.sin((frame + ta * 60) * 0.04 + p.ph) * d.osc : p.topH;
    center = topH + p.gap / 2 + 15;   // +15：略微瞄低一点，给跳跃留余量
  }
  return (birdY + 15 > center && birdV > -30) ? 1 : 0;
}

// ---------------------------------------------------------------- 主流程
function runJob(job, out) {
  const consts0 = {};
  const episodes = job.episodes || [];
  const results = [];
  for (let ei = 0; ei < episodes.length; ei++) {
    const ep = episodes[ei];
    const seed = (ep.seed === undefined ? ei + 1 : ep.seed) >>> 0;
    const prng = mulberry32(seed);
    const ctrlRng = mulberry32((seed ^ 0x9E3779B9) >>> 0);   // 控制器独立随机流，避免污染游戏随机数
    const sandbox = makeSandbox(prng, null);
    vm.runInContext(loadGame(job.game), sandbox, { filename: job.game });
    const api = sandbox.__API;
    Object.assign(consts0, api.consts());
    api.setConfig(job.config || {});
    api.setScreen('playing');
    api.reset();

    const controller = ep.controller || 'replay';
    const actions = ep.actions || '';
    const maxFrames = ep.maxFrames || 20000;
    const dt = 1 / 60;
    let i = 0, score = 0;
    for (; i < maxFrames; i++) {
      let a;
      if (controller === 'replay') a = actions.charCodeAt(i) === 49 ? 1 : 0;
      else if (controller === 'heuristic') a = heuristicAction(api, consts0);
      else a = ctrlRng() < 0.05 ? 1 : 0;
      if (a) api.flap();
      api.upd(dt);
      const st = api.snap();
      score = st[2];
      out.write(JSON.stringify({ e: ei, f: i, a: a, s: st }) + '\n');
      if (api.isOver()) { i++; break; }
    }
    results.push({ episode: ei, seed: seed, frames: i, score: score });
  }
  return results;
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const selfTest = argv.includes('--self-test');

  if (selfTest) {
    const r = mulberry32(12345);
    const out = [];
    for (let i = 0; i < 10; i++) out.push(r());   // JSON 浮点 = 最短往返表示，可与 Python 逐位比较
    console.log(JSON.stringify(out));
    return;
  }

  const jobPath = get('--job');
  if (!jobPath) { console.error('usage: node ref_env.js --job job.json [--out out.jsonl]'); process.exit(2); }
  let job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  if (!job.game) job.game = path.join(__dirname, 'upstream_main.js');
  else job.game = path.resolve(job.game);

  const outPath = get('--out');
  const out = outPath ? fs.createWriteStream(outPath) : process.stdout;
  const results = runJob(job, out);
  if (outPath) out.end();
  else process.stdout.write(JSON.stringify({ __summary: results }) + '\n');
}

main();
