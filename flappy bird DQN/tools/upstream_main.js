// 小鸟过管道 - 微信小游戏 
const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');

const sysInfo = wx.getSystemInfoSync();
const screenW = sysInfo.screenWidth;
const screenH = sysInfo.screenHeight;
const dpr = Math.min(sysInfo.pixelRatio || 1, 2);  // 手机上限2x保证流畅

const DESIGN_W = 400;
const DESIGN_H = 600;
const scale = Math.min(screenW / DESIGN_W, screenH / DESIGN_H);

canvas.width = screenW * dpr;
canvas.height = screenH * dpr;

const offsetX = (screenW - DESIGN_W * scale) / 2;
const offsetY = (screenH - DESIGN_H * scale) / 2;

// 排行榜 - 开放数据域
var openDataCtx = null, sharedCanvas = null;
try {
  openDataCtx = wx.getOpenDataContext();
  sharedCanvas = openDataCtx.canvas;
  sharedCanvas.width = DESIGN_W;
  sharedCanvas.height = DESIGN_H;
} catch (e) {}
var rankingVisible = false, rankScrollY = 0, rankTouchY = 0, rankMaxScroll = 0;

// ===== 音频 =====
let ac = null;
function ia() { if (!ac) ac = wx.createWebAudioContext(); }
function beep(f, ty, d, v, rd) {
  if (!ac) return;
  const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
  o.type = ty; o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(v, t);
  if (rd) g.gain.exponentialRampToValueAtTime(0.001, t + d);
  else g.gain.setValueAtTime(0, t + d);
  o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + d);
}
function sfxJ() { if (muted) return; beep(900, 'triangle', 0.06, 0.2, 1); }
function sfxS() { if (muted) return; beep(880, 'triangle', 0.1, 0.15, 0); setTimeout(() => beep(1100, 'triangle', 0.1, 0.15, 0), 80); }
function sfxB() { if (muted) return; beep(660, 'triangle', 0.08, 0.1, 0); setTimeout(() => beep(880, 'triangle', 0.08, 0.1, 0), 70); setTimeout(() => beep(1320, 'triangle', 0.08, 0.2, 0), 140); }
function sfxH() { if (muted) return; beep(180, 'triangle', 0.3, 0.25, 1); }
function sfxHit() { if (muted) return; beep(250, 'triangle', 0.18, 0.22, 1); }
function sfxAch() {
  if (muted) return;
  beep(523, 'triangle', 0.15, 0.15, 0);
  setTimeout(() => beep(659, 'triangle', 0.15, 0.15, 0), 120);
  setTimeout(() => beep(784, 'triangle', 0.15, 0.15, 0), 240);
  setTimeout(() => beep(1047, 'triangle', 0.25, 0.3, 0), 360);
}
function sfxDodge() {
  if (muted) return;
  beep(1200, 'triangle', 0.04, 0.06, 1);
  setTimeout(() => beep(400, 'triangle', 0.06, 0.05, 1), 30);
}
function sfxUp() {
  if (muted) return;
  beep(880, 'triangle', 0.12, 0.12, 0);
  setTimeout(() => beep(1100, 'triangle', 0.12, 0.12, 0), 100);
  setTimeout(() => beep(1320, 'triangle', 0.12, 0.12, 0), 200);
  setTimeout(() => beep(1760, 'triangle', 0.2, 0.25, 0), 300);
}
function sfxRocket() {
  if (muted) return;
  beep(300, 'triangle', 0.1, 0.18, 1);
  setTimeout(() => beep(600, 'triangle', 0.1, 0.18, 1), 70);
  setTimeout(() => beep(1200, 'triangle', 0.16, 0.22, 1), 140);
}

// ===== 常量 =====
const G = 1800, JV = -480, BPS = 180, PW = 50, BGAP = 150, SPAWN = 200;
const BW = 30, BH = 30, BX = 100, GH = 55, FAST_GAP = 75;
const PD = [
  { c: '#228B22', cc: '#1a6b1a', sm: 1.0, gm: 1.00, pts: 1, prob: 42 },
  { c: '#CC3333', cc: '#991111', sm: 1.5, gm: 1.00, pts: 1, prob: 18, fast: 1 },
  { c: '#3366CC', cc: '#1a3388', sm: 1.0, gm: 1.00, pts: 1, prob: 18, osc: 40 },
  { c: '#8B3DB5', cc: '#5C1F80', sm: 1.0, gm: 0.80, pts: 1, prob: 12 },
  { c: '#FFB800', cc: '#CC8800', sm: 1.0, gm: 1.00, pts: 3, prob: 10 },
];
const tpSum = PD.reduce((s, d) => s + d.prob, 0);

// ===== 成就系统 =====
const ACH = [
  { id: 's10', n: '初出茅庐', d: '单局达到100分', ic: '🌟', img: 'images/9b647e46292f815019884c03df3d97cb.png' },
];
let achDone = {}, newBadges = [];
let badgeImgs = {};
for (let a of ACH) { if (a.img) { let im = wx.createImage(); im.src = a.img; badgeImgs[a.id] = im; } }
try { achDone = JSON.parse(wx.getStorageSync('fbAch') || '{}'); } catch (e) {}

function achSave() { try { wx.setStorageSync('fbAch', JSON.stringify(achDone)); } catch (e) {} }
function achCheck() {
  for (let a of ACH) {
    if (achDone[a.id]) continue;
    let ok = false;
    if (a.id === 's10') ok = score >= 100;
    if (ok) { achDone[a.id] = true; newBadges.push(a.id); achSave(); }
  }
}

// ===== 状态 =====
let screen = 'menu', birdY, birdV, pipes, score, best, level, frame, lastSpawnX, groundOff, menuBob = 0;
let lives = 3, maxLives = 3, invincible = 0;
let selectedBird = 0, detailBird = 0, detailBadge = 0;  // 小鸟和徽章详情
let muted = false, paused = false, resumeCountdown = 0, cdTimer = 0;
let birdStars = [1, 1, 1];  // 每只小鸟的星级
try { birdStars = JSON.parse(wx.getStorageSync('fbStars') || '[1,1,1]'); } catch (e) {}
let starCosts = [[1,2],[2,5],[3,10]];  // [鸟][1→2费, 2→3费]
let lastLifeScore = 0;  // 小红每15分加命追踪
let pipesPassed = 0;    // 通过的管道数（用于难度递增）
let pipeCounts = [0, 0, 0, 0, 0];  // 每种颜色通过计数
let comboTimers = [0, 0, 0, 0, 0];  // 各颜色连击剩余管道数（紫/金有持续时间）
const PTCAP = 50; let ptA = new Array(PTCAP), ptN = 0;
const POPCAP = 5; let popA = new Array(POPCAP), popN = 0;
let groundImg = null;
let totalScore = 0, coins = 0, baseScore = 0, baseCoins = 0;
try { totalScore = parseInt(wx.getStorageSync('fbTotal')) || 0; } catch (e) {}
coins = (totalScore / 100) | 0;
try { best = parseInt(wx.getStorageSync('fbBest')) || 0; } catch (e) { best = 0; }
try { muted = JSON.parse(wx.getStorageSync('fbMuted') || 'false'); } catch (e) { muted = false; }
// 商店（已购/穿戴状态）rocket=主动, wings=被动
let shopState = { rocket: { owned: false, equipped: false }, wings: { owned: false, equipped: false } };
try { shopState = JSON.parse(wx.getStorageSync('fbShop') || '{}'); } catch (e) {}
if (!shopState.rocket) shopState.rocket = { owned: false, equipped: false };
if (!shopState.wings) shopState.wings = { owned: false, equipped: false };
function shopSave() { try { wx.setStorageSync('fbShop', JSON.stringify(shopState)); } catch (e) {} }
// 通用购买/穿戴/脱下（cost 金币）
function shopBuy(itemKey, cost) {
  var it = shopState[itemKey];
  if (!it.owned) {
    if (coins >= cost) {
      coins -= cost; totalScore -= cost * 100;
      it.owned = true; shopSave();
      try { wx.setStorageSync('fbTotal', totalScore); } catch (e) {}
      sfxUp();
    } else {
      shopMsg = '金币不足!'; shopMsgT = 1.5;
      sfxHit();
    }
  } else if (!it.equipped) {
    it.equipped = true; shopSave(); sfxUp();
  } else {
    it.equipped = false; shopSave(); sfxS();
  }
}
// 火箭背包技能
const ROCKET_CD = 30, ROCKET_DUR = 1.2;
let rocketCD = 0, rocketBoost = 0;   // 冷却剩余 / 冲刺剩余
let shopMsg = '', shopMsgT = 0;      // 商店提示（如金币不足）
// 初始化时上传历史最高分
if (best > 0) { try { wx.setUserCloudStorage({ KVDataList: [{ key: 'bestScore', value: '' + best }] }); } catch (e) {} }

// ===== 工具 =====
function pfx(x, y, n, col, spd, life, ang) {
  for (let i = 0; i < n; i++) {
    if (ptN >= PTCAP) break;
    const a = ang != null ? ang + (Math.random() - 0.5) * 0.7 : Math.random() * Math.PI * 2;
    const s = spd * (0.3 + Math.random() * 0.7);
    ptA[ptN++] = { x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life || 0.5, ml: life || 0.5, rgba: col, sz: 2 + (Math.random() * 3 | 0) };
  }
}
function popup(x, y, t) { if (popN < POPCAP) popA[popN++] = { x, y, text: t, life: 0.7, ml: 0.7 }; }
function rmX() { let m = 0; for (let i = 0; i < pipes.length; i++) { if (pipes[i].x > m) m = pipes[i].x; } return m; }

// ===== 游戏流程 =====
function reset() {
  birdY = (DESIGN_H / 2) | 0; birdV = 0; pipes = []; score = 0; level = 0; frame = 0;
  lastSpawnX = DESIGN_W; groundOff = 0; ptN = 0; popN = 0;
  lives = selectedBird === 0 ? 3 : (selectedBird === 1 ? 1 : 2);
  // 星级生命加成
  if (selectedBird === 0 && birdStars[0] >= 2) lives += 2;
  if (selectedBird === 1 && birdStars[1] >= 2) lives += 1;
  if (selectedBird === 2 && birdStars[2] >= 2) lives += 1;
  maxLives = lives;
  invincible = 0; paused = false; resumeCountdown = 0; newBadges = [];
  baseScore = totalScore; baseCoins = coins;
  lastLifeScore = 10;   // 小红首次加命阈值=10
  pipesPassed = 0;
  pipeCounts = [0, 0, 0, 0, 0];
  comboTimers = [0, 0, 0, 0, 0];
  rocketCD = 0; rocketBoost = 0;  // 火箭背包每局重置
}
function startGame() { reset(); screen = 'playing'; ia(); }
function die() {
  if (screen !== 'playing') return;
  sfxH(); pfx(BX + (BW / 2 | 0), birdY + (BH / 2 | 0), 20, '#FFD700', 160, 0.7);
  if (score > best) {
    best = score;
    try { wx.setStorageSync('fbBest', best); } catch (e) {}
    try { wx.setUserCloudStorage({ KVDataList: [{ key: 'bestScore', value: '' + best }] }); } catch (e) {}
  }
  totalScore += score; coins = (totalScore / 100) | 0;
  try { wx.setStorageSync('fbTotal', totalScore); } catch (e) {}
  achCheck();
  if (newBadges.length > 0) { sfxAch(); screen = 'badgeEarned'; }
  else { screen = 'gameover'; }
}

// ===== 输入 =====
// 按钮在屏幕像素上的区域
// 按钮屏幕像素区域
var bSX1 = offsetX + (DESIGN_W / 2 - 90) * scale;
var bSY1 = offsetY + 195 * scale;          // 开始
var bSX2 = bSX1 + 180 * scale;
var bSY2 = bSY1 + 44 * scale;
var bBSY1 = offsetY + 249 * scale;         // 小鸟
var bBSY2 = bBSY1 + 44 * scale;
var bASY1 = offsetY + 303 * scale;         // 成就
var bASY2 = bASY1 + 44 * scale;
var bShY1 = offsetY + 357 * scale;         // 商店
var bShY2 = bShY1 + 44 * scale;
var rbX = offsetX + 18 * scale, rbW = 55 * scale;          // 排行榜按钮
var rbY = offsetY + (DESIGN_H - GH - 75) * scale, rbH = 55 * scale;

wx.onTouchStart(function (e) {
  // 排行榜模式：处理返回按钮和滑动
  if (rankingVisible) {
    var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (t) {
      var sx = t.clientX || t.x, sy = t.clientY || t.y;
      // 返回按钮（左上角）
      if (sx >= offsetX + 18 * scale && sx <= offsetX + 73 * scale && sy >= offsetY + 15 * scale && sy <= offsetY + 50 * scale) {
        rankingVisible = false; return;
      }
      rankTouchY = sy;
    }
    return;
  }
  if (screen === 'menu') {
    // 获取触摸坐标（多路径兼容）
    var tx, ty;
    if (e.touches && e.touches[0]) { tx = e.touches[0].x || e.touches[0].clientX; ty = e.touches[0].y || e.touches[0].clientY; }
    else if (e.changedTouches && e.changedTouches[0]) { tx = e.changedTouches[0].x || e.changedTouches[0].clientX; ty = e.changedTouches[0].y || e.changedTouches[0].clientY; }
    else { tx = e.x; ty = e.y; }
    // 排行榜按钮（左下角）
    if (ty >= rbY && ty <= rbY + rbH && tx >= rbX && tx <= rbX + rbW) {
      rankingVisible = true; rankScrollY = 0;
      if (openDataCtx) {
        openDataCtx.postMessage({ type: 'updateRank', best: best });
      }
      return;
    }
    // 静音按钮（右下角）
    if (ty >= rbY && ty <= rbY + rbH && tx >= offsetX + 338 * scale && tx <= offsetX + 380 * scale) {
      muted = !muted;
      try { wx.setStorageSync('fbMuted', JSON.stringify(muted)); } catch (e) {}
      return;
    }
    // 开始/小鸟/成就/商店按钮
    if (tx >= bSX1 && tx <= bSX2 && ty >= bSY1 && ty <= bSY2) { startGame(); return; }
    if (tx >= bSX1 && tx <= bSX2 && ty >= bBSY1 && ty <= bBSY2) { screen = 'birds'; return; }
    if (tx >= bSX1 && tx <= bSX2 && ty >= bASY1 && ty <= bASY2) { screen = 'achievements'; return; }
    if (tx >= bSX1 && tx <= bSX2 && ty >= bShY1 && ty <= bShY2) { screen = 'shop'; return; }
    // 坐标完全取不到时兜底（点击即开始，但排行榜仍可点）
    if (tx === undefined) { startGame(); return; }
    return;
  }
  if (screen === 'birds') {
    try {
      var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (t) {
        var sx = t.clientX || t.x, sy = t.clientY || t.y;
        // 返回按钮：左上角
        var bx = offsetX + 20 * scale, by = offsetY + 20 * scale;
        if (sx >= bx && sx <= bx + 60 * scale && sy >= by && sy <= by + 35 * scale) {
          screen = 'menu'; return;
        }
        // 静音按钮（右上角）
        if (sx >= offsetX + 340 * scale && sx <= offsetX + 380 * scale && sy >= offsetY + 18 * scale && sy <= offsetY + 48 * scale) {
          muted = !muted;
          try { wx.setStorageSync('fbMuted', JSON.stringify(muted)); } catch (e) {}
          return;
        }
        // 三张小鸟卡片: x=25/145/265, y=100, w=110, h=195
        var cCards = [25, 145, 265];
        var ccY = offsetY + 100 * scale, ccH = 195 * scale;
        for (var ci = 0; ci < 3; ci++) {
          var ccX = offsetX + cCards[ci] * scale, ccW = 110 * scale;
          if (sx >= ccX && sx <= ccX + ccW && sy >= ccY && sy <= ccY + ccH) {
            detailBird = ci; screen = 'birdDetail'; return;
          }
        }
      }
    } catch (_) {}
    return;
  }
  if (screen === 'birdDetail') {
    try {
      var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (t) {
        var sx = t.clientX || t.x, sy = t.clientY || t.y;
        // 返回按钮：左上角
        var bx = offsetX + 18 * scale, by = offsetY + 15 * scale;
        if (sx >= bx && sx <= bx + 55 * scale && sy >= by && sy <= by + 35 * scale) {
          screen = 'birds'; return;
        }
        // 静音按钮（右上角）
        if (sx >= offsetX + 340 * scale && sx <= offsetX + 380 * scale && sy >= offsetY + 18 * scale && sy <= offsetY + 48 * scale) {
          muted = !muted;
          try { wx.setStorageSync('fbMuted', JSON.stringify(muted)); } catch (e) {}
          return;
        }
        // 升级按钮 y=418..450
        var ux = offsetX + 30 * scale, uy = offsetY + 418 * scale, uw = 340 * scale, uh = 32 * scale;
        if (sx >= ux && sx <= ux + uw && sy >= uy && sy <= uy + uh) {
          var uc = starCosts[detailBird][birdStars[detailBird] - 1];
          if (birdStars[detailBird] < 3 && coins >= uc) {
            coins -= uc;
            birdStars[detailBird]++;
            sfxUp();
            totalScore -= uc * 100;
            try { wx.setStorageSync('fbTotal', totalScore); wx.setStorageSync('fbStars', JSON.stringify(birdStars)); } catch (e) {}
          }
          return;
        }
        // 选择按钮 y=460..504
        var b2x = offsetX + 30 * scale, b2y = offsetY + 460 * scale;
        if (sx >= b2x && sx <= b2x + 340 * scale && sy >= b2y && sy <= b2y + 44 * scale) {
          selectedBird = detailBird;
          screen = 'menu';
          return;
        }
      }
    } catch (_) {}
    return;
  }
  if (screen === 'achievements') {
    try {
      var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (t) {
        var sx = t.clientX || t.x, sy = t.clientY || t.y;
        var bx = offsetX + 20 * scale, by = offsetY + 20 * scale;
        if (sx >= bx && sx <= bx + 60 * scale && sy >= by && sy <= by + 35 * scale) { screen = 'menu'; return; }
        // 点击徽章卡片（2列×4行）
        var cols2 = [25, 205], cw2 = 170, ch2 = 104;
        for (let i = 0; i < ACH.length; i++) {
          var scx2 = offsetX + cols2[i % 2] * scale, scy2 = offsetY + (90 + ((i / 2) | 0) * 113) * scale;
          if (sx >= scx2 && sx <= scx2 + cw2 * scale && sy >= scy2 && sy <= scy2 + ch2 * scale) {
            detailBadge = i; screen = 'badgeDetail'; return;
          }
        }
      }
    } catch (_) {}
    return;
  }
  if (screen === 'badgeDetail') {
    try {
      var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (t) {
        var sx = t.clientX || t.x, sy = t.clientY || t.y;
        var bx = offsetX + 20 * scale, by = offsetY + 20 * scale;
        if (sx >= bx && sx <= bx + 60 * scale && sy >= by && sy <= by + 35 * scale) { screen = 'achievements'; return; }
      }
    } catch (_) {}
    return;
  }
  if (screen === 'shop') {
    try {
      var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (t) {
        var sx = t.clientX || t.x, sy = t.clientY || t.y;
        var bx = offsetX + 20 * scale, by = offsetY + 20 * scale;
        if (sx >= bx && sx <= bx + 60 * scale && sy >= by && sy <= by + 35 * scale) { screen = 'menu'; return; }
        // 左侧栏 主动装备：火箭背包 状态按钮
        var obx = offsetX + 50 * scale, oby = offsetY + 268 * scale, obw = 110 * scale, obh = 42 * scale;
        if (sx >= obx && sx <= obx + obw && sy >= oby && sy <= oby + obh) { shopBuy('rocket', 10); return; }
        // 右侧栏 被动装备：闪避之翼 状态按钮
        var pbx = offsetX + 240 * scale, pby = offsetY + 268 * scale, pbw = 110 * scale, pbh = 42 * scale;
        if (sx >= pbx && sx <= pbx + pbw && sy >= pby && sy <= pby + pbh) { shopBuy('wings', 10); return; }
      }
    } catch (_) {}
    return;
  }
  if (screen === 'playing') {
    var tx, ty;
    if (e.touches && e.touches[0]) { tx = e.touches[0].x || e.touches[0].clientX; ty = e.touches[0].y || e.touches[0].clientY; }
    else if (e.changedTouches && e.changedTouches[0]) { tx = e.changedTouches[0].x || e.changedTouches[0].clientX; ty = e.changedTouches[0].y || e.changedTouches[0].clientY; }
    else { tx = e.x; ty = e.y; }
    // 静音按钮（始终可用）
    if (ty >= offsetY + 8 * scale && ty <= offsetY + 36 * scale && tx >= offsetX + 322 * scale && tx <= offsetX + 350 * scale) {
      muted = !muted;
      try { wx.setStorageSync('fbMuted', JSON.stringify(muted)); } catch (e) {}
      return;
    }
    // 暂停时：任意触摸开始3秒倒计时
    if (paused) {
      if (resumeCountdown > 0) return;
      resumeCountdown = 3; cdTimer = 1.0; return;
    }
    // 暂停按钮
    if (ty >= offsetY + 8 * scale && ty <= offsetY + 36 * scale && tx >= offsetX + 355 * scale && tx <= offsetX + 390 * scale) {
      paused = true; return;
    }
    // 火箭技能按钮（左侧HUD下方，圆心 40,188 半径24）
    if (shopState.rocket.equipped) {
      var rcx = offsetX + 40 * scale, rcy = offsetY + 188 * scale;
      var rdx = tx - rcx, rdy = ty - rcy, rr2 = 30 * scale;
      if (rdx * rdx + rdy * rdy <= rr2 * rr2) {
        if (rocketCD <= 0 && rocketBoost <= 0) {
          rocketBoost = ROCKET_DUR; rocketCD = ROCKET_CD;
          sfxRocket();
        }
        return;
      }
    }
    birdV = JV; sfxJ(); return;
  }
  if (screen === 'badgeEarned') { newBadges.shift(); if (newBadges.length === 0) screen = 'gameover'; return; }
  if (screen === 'gameover') { screen = 'menu'; reset(); return; }
  birdV = JV; sfxJ();
});

// 排行榜滑动
wx.onTouchMove(function(e) {
  if (!rankingVisible) return;
  var t = e.touches && e.touches[0];
  if (!t) return;
  var sy = t.clientY || t.y;
  var dy = rankTouchY - sy;
  rankScrollY += dy;
  if (rankScrollY < 0) rankScrollY = 0;
  if (rankMaxScroll > 0 && rankScrollY > rankMaxScroll) rankScrollY = rankMaxScroll;
  rankTouchY = sy;
  // 实时发送滚动位置
  if (openDataCtx) openDataCtx.postMessage({ type: 'scroll', scrollY: rankScrollY, best: best });
});
wx.onTouchEnd(function(e) {
  if (!rankingVisible) return;
  // 更新开放数据域
  if (openDataCtx) openDataCtx.postMessage({ type: 'scroll', scrollY: rankScrollY, best: best });
});

// ===== 管道生成 =====
function mkPipe(atX) {
  let roll = Math.random() * tpSum, ti = 0;
  for (let i = 0; i < PD.length; i++) { roll -= PD[i].prob; if (roll <= 0) { ti = i; break; } }
  // 小粉：绿色管道变金色
  if (selectedBird === 2 && ti === 0) ti = 4;
  var d = PD[ti], gap = (BGAP * d.gm) | 0;
  // 紫色连击：新管道生成时应用间隙翻倍
  if (comboTimers[3] > 0) { gap *= 2; comboTimers[3]--; }
  var th = (Math.random() * (DESIGN_H - GH - gap - 120) + 60) | 0;
  let sx = atX != null ? atX : DESIGN_W;
  if (d.fast && atX == null) sx += FAST_GAP;
  pipes.push({ x: sx, topH: th, gap, type: ti, scored: false, baseTH: th, ph: Math.random() * Math.PI * 2 });
}

// 管道奖励：得分 + 金币检测 + 连击积累/触发 + 成就 + 小红吸血（通过/撞碎共用）
function pipeReward(p, pts) {
  score += pts; pipesPassed++;
  // 局内金币检测
  var newCoins = ((baseScore + score) / 100) | 0;
  if (newCoins > baseCoins) {
    baseCoins = newCoins; coins = baseCoins;
    popup(BX + 20, birdY - 40, '+🪙');
    pfx(BX + BW, birdY + (BH / 2 | 0), 6, '#FFD740', 60, 0.5);
  }
  // 连击计数（各自独立触发）
  pipeCounts[p.type]++;
  // 小粉：金色管道同时积累绿色计数
  if (selectedBird === 2 && p.type === 4) pipeCounts[0]++;
  // 全类型连击检测（链式触发，余数保留）
  var reqC = (selectedBird === 0 && birdStars[0] >= 3) ? 8 : 10;
  var rc, cc = 0;
  do {
    rc = false;
    for (var ct = 0; ct < 5; ct++) {
      if (pipeCounts[ct] >= reqC) {
        pipeCounts[ct] -= reqC; rc = true;
        var py = birdY - 30 + cc * 22; cc++;
        // 绿色连击：其他管道计数+2（翻倍+4）
        if (ct === 0) {
          for (var ci = 0; ci < 5; ci++) if (ci !== 0) pipeCounts[ci] += 2;
          sfxS();
          popup(DESIGN_W / 2, py, '绿色连击! 全计数+2');
          pfx(DESIGN_W / 2, birdY, 12, '#228B22', 100, 0.6);
        }
        // 红色连击：永久+1命（翻倍+2）
        if (ct === 1) {
          lives++; maxLives = lives;
          sfxS();
          popup(DESIGN_W / 2, py, '红色连击! +❤');
          pfx(DESIGN_W / 2, birdY, 12, '#FF5252', 100, 0.6);
        }
        // 蓝色连击：难度降1级（翻倍降2）
        if (ct === 2) {
          level = Math.max(0, level - 1);
          sfxS();
          popup(DESIGN_W / 2, py, '蓝色连击! 难度-1');
          pfx(DESIGN_W / 2, birdY, 12, '#3366CC', 100, 0.6);
        }
        // 紫色连击：下5管间隙翻倍（翻倍→间隙再翻倍）
        if (ct === 3) {
          comboTimers[3] = 5;
          sfxS();
          popup(DESIGN_W / 2, py, '紫色连击! 间隙↑');
          pfx(DESIGN_W / 2, birdY, 12, '#8B3DB5', 100, 0.6);
        }
        // 金色连击：下5管得分翻倍
        if (ct === 4) {
          comboTimers[4] = 5;
          sfxB();
          popup(DESIGN_W / 2, py, '金色连击! x2');
          pfx(DESIGN_W / 2, birdY, 15, '#FFB800', 120, 0.6);
        }
      }
    }
  } while (rc);
  achCheck();
  // 小红：首次10分加命，之后每15分加命
  if (selectedBird === 1 && score >= lastLifeScore) {
    var addLives = (birdStars[1] >= 3) ? 1.5 : 1;
    lives += addLives; maxLives = lives;
    lastLifeScore += 15;
    sfxS();
    popup(BX + 20, birdY - 25, '+' + (addLives === 1.5 ? '1.5❤' : '❤'));
    pfx(BX + BW, birdY + (BH / 2 | 0), addLives * 4, '#FF5252', 80, 0.4);
  }
  if (pts >= 3) { sfxB(); popup(BX + 20, birdY - 10, '+' + pts); pfx(BX + BW, birdY + (BH / 2 | 0), 12, '#FFD700', 100, 0.5); }
  else { sfxS(); popup(BX + 20, birdY - 10, '+' + pts); }
}

// ===== 更新 =====
function upd(dt) {
  if (dt > 0.1) dt = 0.1;
  if (screen !== 'playing') {
    menuBob += dt;
    if (shopMsgT > 0) { shopMsgT -= dt; if (shopMsgT <= 0) shopMsg = ''; }
    return;
  }
  if (paused) {
    if (resumeCountdown > 0) {
      cdTimer -= dt;
      if (cdTimer <= 0) {
        resumeCountdown--;
        if (resumeCountdown <= 0) { paused = false; }
        else { cdTimer += 1.0; }
      }
    }
    return;
  }
  frame++;
  if (invincible > 0) invincible -= dt;
  if (rocketCD > 0) rocketCD -= dt;
  if (rocketBoost > 0) {
    rocketBoost -= dt;
    // 持续向后（左）喷气特效：从背包喷嘴位置喷出
    if (Math.random() < 0.9) pfx(BX - 8, birdY + (BH / 2 | 0), 1, Math.random() < 0.5 ? '#FF9800' : '#FFD740', 230, 0.3, Math.PI);
  }
  birdV += G * dt; birdY += birdV * dt;
  if (birdY <= 0) {
    birdY = 0; birdV = 0;
    if (rocketBoost <= 0) die();
  } else if (birdY + BH >= DESIGN_H - GH) {
    birdY = DESIGN_H - GH - BH;
    if (rocketBoost <= 0) die();
  }
  const nl = (pipesPassed / 10) | 0; if (nl > level) level = nl;
  const rm = rmX();
  if (pipes.length === 0 || rm < lastSpawnX - SPAWN) { mkPipe(); lastSpawnX = DESIGN_W; }
  const sb = level * 8, gs = Math.min(level * 2, 16);
  const bMul = rocketBoost > 0 ? 2.2 : 1;  // 火箭冲刺速度倍率
  for (let i = pipes.length - 1; i >= 0; i--) {
    const p = pipes[i], d = PD[p.type], sp = (BPS * d.sm + sb) * bMul;
    p.x -= sp * dt;
    if (d.osc) p.topH = (p.baseTH + Math.sin(frame * 0.04 + p.ph) * d.osc) | 0;
    if (p.x + PW < -10) { pipes.splice(i, 1); continue; }
    if (!p.scored && p.x + PW < BX) {
      p.scored = true;
      var pts = d.pts;
      if (selectedBird === 2 && pts >= 3) pts = 4;  // 小粉金色管道+4分
      if (comboTimers[4] > 0) { pts *= 2; comboTimers[4]--; }  // 黄色连击：得分翻倍
      pipeReward(p, pts);
    }
    const ex = (gs / 2) | 0, et = p.topH + ex;
    if (BX + BW > (p.x | 0) && BX < (p.x + PW | 0)) {
      if (birdY < et || birdY + BH > et + p.gap - gs) {
        // 火箭冲刺：无敌撞碎管道（同样得分+积累连击）
        if (rocketBoost > 0) {
          var pts = d.pts;
          if (selectedBird === 2 && pts >= 3) pts = 4;
          if (comboTimers[4] > 0) { pts *= 2; comboTimers[4]--; }
          pipeReward(p, pts);
          const cpx = p.x + PW / 2 | 0, cpy = p.topH + p.gap / 2 | 0;
          pfx(cpx, cpy, 16, '#FF9800', 170, 0.5);
          pfx(cpx, cpy, 10, '#FFF', 130, 0.4);
          pipes.splice(i, 1);
          continue;
        }
        if (invincible > 0) continue;
        // 闪避判定：闪避之翼其他鸟+20%；小粉3星基础50%，翅膀乘算提高20%（50%×1.2=60%）
        var dodgeRate = shopState.wings.equipped ? 0.2 : 0;
        if (selectedBird === 2 && birdStars[2] >= 3) dodgeRate = 0.5 * (shopState.wings.equipped ? 1.2 : 1);
        if (dodgeRate > 0 && Math.random() < dodgeRate) {
          sfxDodge();
          popup(BX + 20, birdY - 10, '闪避!');
          pfx(p.x + PW / 2 | 0, p.topH + p.gap / 2 | 0, 10, '#E0E0E0', 100, 0.4);
          pipes.splice(i, 1);
          continue;
        }
        if (lives > 1) {
          // 消耗一条命，炸掉当前管道
          lives--;
          invincible = 1.5;
          sfxHit();
          // 爆炸粒子
          const px = p.x + PW / 2 | 0, py = p.topH + p.gap / 2 | 0;
          pfx(px, py, 20, '#FFD700', 150, 0.6);
          pfx(px, py, 10, '#FF6347', 150, 0.5);
          // 移除管道
          pipes.splice(i, 1);
        } else {
          die();
        }
      }
    }
  }
  for (let i = 0; i < ptN; i++) {
    const pt = ptA[i]; pt.life -= dt;
    if (pt.life <= 0) { ptA[i] = ptA[--ptN]; i--; continue; }
    pt.x += (pt.vx * dt) | 0; pt.y += (pt.vy * dt) | 0; pt.vy += 300 * dt;
  }
  for (let i = 0; i < popN; i++) {
    const sp = popA[i]; sp.life -= dt; if (sp.life <= 0) { popA[i] = popA[--popN]; i--; continue; }
    sp.y -= (50 * dt) | 0;
  }
  groundOff = (groundOff + BPS * dt * bMul) % 30;
}

// ===== 绘制 =====
function drawBird(by) {
  const y = by | 0, wf = (Math.sin(frame * 0.24) * 4) | 0;
  var cc = [['#FFD700','#FFA500'], ['#FF5252','#D32F2F'], ['#FF80AB','#E91E63']];
  var bodyC = cc[selectedBird][0], wingC = cc[selectedBird][1];
  ctx.fillStyle = bodyC;
  ctx.beginPath(); ctx.arc(BX + BW / 2, y + BH / 2 - 1, BW / 2 - 1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = wingC;
  ctx.beginPath(); ctx.arc(BX + BW / 2 - 2, y + BH / 2 + wf, (BW / 3) | 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#FFF';
  ctx.beginPath(); ctx.arc(BX + BW - 8, y + 9, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(BX + BW - 6, y + 8, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#F60';
  ctx.beginPath(); ctx.moveTo(BX + BW, y + 12); ctx.lineTo(BX + BW + 8, y + 16); ctx.lineTo(BX + BW, y + 20); ctx.closePath(); ctx.fill();
  // 闪避之翼（穿戴时背上，靠上；背包靠下，两者错开）
  if (shopState.wings.equipped) drawWings(BX + BW / 2 - 6, y + BH / 2 - 10, 9);
  // 红色喷气背包（穿戴时背上，靠后不挡脸）
  if (shopState.rocket.equipped) drawRocket(BX + BW / 2 - 17, y + BH / 2, 12, rocketBoost > 0);
}

// 红色喷气背包：背在鸟背上，喷嘴朝后（左），冲刺时持续向后喷气
function drawRocket(cx, cy, s, boost) {
  // 尾焰（向后/左喷，冲刺时加长并脉动）
  var pulse = boost ? 1 + Math.sin(frame * 0.5) * 0.3 : 1;
  var fl = boost ? 2.1 : 0.9;
  ctx.fillStyle = boost ? '#FF6D00' : '#FF9800';
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.42, cy - s * 0.26);
  ctx.lineTo(cx - s * (0.45 + fl * 0.55 * pulse), cy - s * 0.4);
  ctx.lineTo(cx - s * (0.45 + fl * 0.7 * pulse), cy);
  ctx.lineTo(cx - s * (0.45 + fl * 0.55 * pulse), cy + s * 0.4);
  ctx.lineTo(cx - s * 0.42, cy + s * 0.26);
  ctx.closePath(); ctx.fill();
  // 包体（红色圆角矩形）
  ctx.fillStyle = '#E53935';
  roundRect(cx - s * 0.5, cy - s * 0.55, s * 0.95, s * 1.15, s * 0.22);
  // 包体高光 + 暗边
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(cx - s * 0.42, cy - s * 0.47, s * 0.18, s * 0.95);
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.fillRect(cx + s * 0.18, cy - s * 0.47, s * 0.18, s * 0.95);
  // 包盖线条（上下两条横向装饰）
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(cx - s * 0.42, cy - s * 0.3, s * 0.78, s * 0.06);
  ctx.fillRect(cx - s * 0.42, cy + s * 0.1, s * 0.78, s * 0.06);
  // 背带（斜挎到鸟身）
  ctx.strokeStyle = '#8D2B24'; ctx.lineWidth = Math.max(2, s * 0.12);
  ctx.beginPath(); ctx.moveTo(cx + s * 0.4, cy - s * 0.4); ctx.lineTo(cx + s * 0.95, cy + s * 0.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx + s * 0.4, cy + s * 0.4); ctx.lineTo(cx + s * 0.95, cy - s * 0.2); ctx.stroke();
  ctx.lineWidth = 1;
  // 喷嘴（朝左/后）
  ctx.fillStyle = '#757575';
  roundRect(cx - s * 0.55, cy - s * 0.3, s * 0.28, s * 0.6, s * 0.08);
  ctx.fillStyle = '#424242';
  ctx.fillRect(cx - s * 0.62, cy - s * 0.3, s * 0.1, s * 0.6);
  // 舷窗装饰
  ctx.fillStyle = '#FFF59D';
  ctx.beginPath(); ctx.arc(cx - s * 0.02, cy - s * 0.08, s * 0.18, 0, Math.PI * 2); ctx.fill();
}

// 一片羽毛（沿 x 正方向伸出，len 长 wid 宽）
function featherPath(len, wid) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.55, -wid, len * 0.95, -wid * 0.55);
  ctx.quadraticCurveTo(len * 1.12, 0, len * 0.95, wid * 0.55);
  ctx.quadraticCurveTo(len * 0.55, wid, 0, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 羽毛茎
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(len * 0.85, 0);
  ctx.stroke();
}

// 闪避之翼：多层羽毛翼，背在鸟背上（向左展开）
function drawWings(cx, cy, s) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(-1, 1);  // 鸟朝右，翅膀在身后（左）
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = 'rgba(150,175,195,0.85)';
  ctx.lineWidth = 1.1;
  var fes = [
    { ang: -0.75, len: s * 1.5, wid: s * 0.38 },
    { ang: -0.38, len: s * 1.15, wid: s * 0.32 },
    { ang: 0.0, len: s * 0.75, wid: s * 0.26 },
    { ang: 0.35, len: s * 0.45, wid: s * 0.2 },
  ];
  for (var i = 0; i < fes.length; i++) {
    ctx.save();
    ctx.rotate(fes[i].ang);
    featherPath(fes[i].len, fes[i].wid);
    ctx.restore();
  }
  ctx.restore();
}

// 一对展开的翅膀（商店图标用，左右对称）
function drawWingPair(cx, cy, s) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = 'rgba(150,175,195,0.85)';
  ctx.lineWidth = 1.2;
  var half = function (dir) {
    ctx.save();
    ctx.scale(dir, 1);
    var fes = [
      { ang: -0.9, len: s * 1.65, wid: s * 0.4 },
      { ang: -0.5, len: s * 1.3, wid: s * 0.36 },
      { ang: -0.12, len: s * 0.9, wid: s * 0.3 },
      { ang: 0.28, len: s * 0.55, wid: s * 0.24 },
    ];
    for (var i = 0; i < fes.length; i++) {
      ctx.save();
      ctx.rotate(fes[i].ang);
      featherPath(fes[i].len, fes[i].wid);
      ctx.restore();
    }
    ctx.restore();
  };
  half(1);   // 右翼
  half(-1);  // 左翼
  ctx.restore();
}

function drawPipe(x, yh, gap, ti) {
  const xi = x | 0, d = PD[ti], by = yh + gap, bh = DESIGN_H - GH - by;
  ctx.fillStyle = d.c; ctx.fillRect(xi, 0, PW, yh);
  ctx.fillStyle = d.cc; ctx.fillRect(xi - 3, yh - 18, PW + 6, 18);
  ctx.fillStyle = d.c; ctx.fillRect(xi, by, PW, bh);
  ctx.fillStyle = d.cc; ctx.fillRect(xi - 3, by, PW + 6, 18);
  ctx.fillStyle = d.pts >= 3 ? '#FFE082' : d.c;
  ctx.fillRect(xi + (PW / 2 | 0) - 3, yh - 26, 6, 6);
}

function drawGround() {
  if (!groundImg) {
    groundImg = wx.createCanvas();
    groundImg.width = DESIGN_W + 30; groundImg.height = GH;
    const g = groundImg.getContext('2d');
    g.fillStyle = '#4CAF50'; g.fillRect(0, 0, DESIGN_W + 30, GH);
    g.fillStyle = '#8B6914'; g.fillRect(0, 14, DESIGN_W + 30, GH - 14);
    g.fillStyle = '#388E3C';
    for (let i = 0; i < DESIGN_W + 60; i += 12) { g.fillRect(i - 2, 0, 4, 8); }
  }
  const off = (-30 + groundOff) | 0;
  ctx.drawImage(groundImg, off, DESIGN_H - GH);
  if (off < -DESIGN_W) ctx.drawImage(groundImg, off + DESIGN_W + 30, DESIGN_H - GH);
}

function drawAchievements() {
  ctx.fillStyle = '#4DB8E8'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H - GH);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  [[40, 30, 40, 14], [150, 20, 32, 12], [280, 45, 38, 14], [80, 130, 44, 13], [250, 110, 36, 12]]
    .forEach(c => ctx.fillRect(c[0], c[1], c[2], c[3]));
  drawGround();

  ctx.font = 'bold 18px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(20, 20, 60, 35, 10);
  ctx.fillStyle = '#FFF'; ctx.fillText('← 返回', 50, 44);

  var done = 0;
  for (let i = 0; i < ACH.length; i++) if (achDone[ACH[i].id]) done++;
  ctx.font = 'bold 26px Arial';
  ctx.fillStyle = '#333'; ctx.fillText('成就徽章', DESIGN_W / 2 + 1, 61);
  ctx.fillStyle = '#FFD740'; ctx.fillText('成就徽章', DESIGN_W / 2, 60);
  ctx.font = 'bold 11px Arial'; ctx.fillStyle = '#AAA';
  ctx.fillText('已收集 ' + done + '/' + ACH.length, DESIGN_W / 2, 78);

  // 2列×4行紧凑卡片
  var cw = 170, ch = 104, cols = [25, 205];
  for (let i = 0; i < ACH.length; i++) {
    var a = ACH[i], ok = !!achDone[a.id];
    var cx = cols[i % 2], cy = 90 + ((i / 2) | 0) * 113;
    ctx.fillStyle = ok ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.5)';
    roundRect(cx, cy, cw, ch, 12);
    if (ok) { ctx.strokeStyle = '#FFB300'; ctx.lineWidth = 2; roundRectStroke(cx, cy, cw, ch, 12); ctx.lineWidth = 1; }
    // 徽章图/占位
    var bx = cx + cw / 2, by = cy + 38;
    if (a.img && badgeImgs[a.id] && badgeImgs[a.id].width > 0) {
      var img = badgeImgs[a.id];
      var r = Math.min(46 / img.width, 46 / img.height);
      ctx.drawImage(img, (bx - img.width * r / 2) | 0, (by - img.height * r / 2) | 0, (img.width * r) | 0, (img.height * r) | 0);
    } else {
      ctx.fillStyle = ok ? 'rgba(255,215,0,0.2)' : 'rgba(0,0,0,0.1)';
      ctx.beginPath(); ctx.arc(bx, by, 22, 0, Math.PI * 2); ctx.fill();
      ctx.font = '22px Arial'; ctx.fillStyle = ok ? '#FFD740' : '#BBB';
      ctx.fillText(ok ? '★' : a.ic, bx, by + 7);
    }
    ctx.font = 'bold 12px Arial'; ctx.fillStyle = ok ? '#333' : '#888';
    ctx.fillText(a.n, cx + cw / 2, cy + 72);
    ctx.font = 'bold 10px Arial';
    ctx.fillStyle = ok ? '#4CAF50' : '#BBB';
    ctx.fillText(ok ? '已获得' : '点击查看', cx + cw / 2, cy + 92);
  }
  ctx.textAlign = 'start';
}

function drawBadgeDetail() {
  var a = ACH[detailBadge], ok = !!achDone[a.id];
  ctx.fillStyle = '#4DB8E8'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H - GH);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  [[50, 25, 38, 14], [150, 18, 32, 12], [300, 40, 40, 14], [100, 140, 36, 12], [260, 120, 34, 13]]
    .forEach(c => ctx.fillRect(c[0], c[1], c[2], c[3]));
  drawGround();

  // 返回按钮
  ctx.font = 'bold 16px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(18, 15, 55, 35, 10);
  ctx.fillStyle = '#FFF'; ctx.fillText('← 返回', 46, 39);

  // 标题
  ctx.font = 'bold 24px Arial';
  ctx.fillStyle = '#333'; ctx.fillText('徽章详情', DESIGN_W / 2 + 1, 55);
  ctx.fillStyle = '#FFD740'; ctx.fillText('徽章详情', DESIGN_W / 2, 54);

  // 展示面板
  var px = 40, py = 80, pw = 320, ph = 340;
  if (ok) {
    var grd4 = ctx.createLinearGradient(px, py, px, py + ph);
    grd4.addColorStop(0, '#FFFDE7'); grd4.addColorStop(1, '#FFF3E0');
    ctx.fillStyle = grd4;
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
  }
  roundRect(px, py, pw, ph, 18);
  if (ok) { ctx.strokeStyle = '#FFB300'; ctx.lineWidth = 3; roundRectStroke(px, py, pw, ph, 18); ctx.lineWidth = 1; }

  // 大徽章图
  var bx = DESIGN_W / 2, by = py + 100;
  if (a.img && badgeImgs[a.id] && badgeImgs[a.id].width > 0) {
    var img2 = badgeImgs[a.id];
    var r2 = Math.min(110 / img2.width, 110 / img2.height);
    ctx.drawImage(img2, (bx - img2.width * r2 / 2) | 0, (by - img2.height * r2 / 2) | 0, (img2.width * r2) | 0, (img2.height * r2) | 0);
  } else {
    var grd5 = ctx.createRadialGradient(bx - 8, by - 8, 5, bx, by, 50);
    grd5.addColorStop(0, ok ? '#FFF8E1' : '#E0E0E0');
    grd5.addColorStop(1, ok ? '#FFB300' : '#9E9E9E');
    ctx.fillStyle = grd5;
    ctx.beginPath(); ctx.arc(bx, by, 48, 0, Math.PI * 2); ctx.fill();
    ctx.font = '48px Arial'; ctx.fillStyle = ok ? '#FFD740' : '#FFF';
    ctx.fillText(ok ? '★' : a.ic, bx, by + 15);
  }

  // 徽章名称
  ctx.font = 'bold 26px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = '#333'; ctx.fillText(a.n, DESIGN_W / 2, py + 220);

  // 描述 / 获取条件
  ctx.font = 'bold 14px Arial'; ctx.fillStyle = '#888';
  ctx.fillText(a.d, DESIGN_W / 2, py + 248);

  // 状态
  ctx.font = 'bold 16px Arial';
  if (ok) {
    ctx.fillStyle = '#4CAF50'; ctx.fillText('✦ 已获得此徽章 ✦', DESIGN_W / 2, py + 290);
  } else {
    ctx.fillStyle = '#BBB'; ctx.fillText('🔒 尚未获得', DESIGN_W / 2, py + 290);
  }
  ctx.textAlign = 'start';
}

function drawBadgeEarned() {
  ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
  var px = 40, py = 110, pw = 320, ph = 380;
  var grd6 = ctx.createLinearGradient(px, py, px, py + ph);
  grd6.addColorStop(0, '#FFFDE7'); grd6.addColorStop(1, '#FFF8E1');
  ctx.fillStyle = grd6; roundRect(px, py, pw, ph, 22);
  ctx.strokeStyle = '#FFB300'; ctx.lineWidth = 3; roundRectStroke(px, py, pw, ph, 22); ctx.lineWidth = 1;
  // 顶部装饰条
  ctx.fillStyle = '#FFB300';
  ctx.fillRect(px + 40, py + 8, pw - 80, 3);

  ctx.font = 'bold 24px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = '#E65100'; ctx.fillText('🎉 获得新徽章!', DESIGN_W / 2, py + 45);

  var a = null, curBadge = newBadges[0];
  for (let i = 0; i < ACH.length; i++) { if (ACH[i].id === curBadge) { a = ACH[i]; break; } }
  if (a) {
    var bx2 = DESIGN_W / 2, by2 = py + 125;
    if (a.img && badgeImgs[a.id] && badgeImgs[a.id].width > 0) {
      var imgE = badgeImgs[a.id];
      var rE = Math.min(100 / imgE.width, 100 / imgE.height);
      ctx.fillStyle = 'rgba(255,215,0,0.2)';
      ctx.beginPath(); ctx.arc(bx2, by2, 58, 0, Math.PI * 2); ctx.fill();
      ctx.drawImage(imgE, (bx2 - imgE.width * rE / 2) | 0, (by2 - imgE.height * rE / 2) | 0, (imgE.width * rE) | 0, (imgE.height * rE) | 0);
    } else {
      ctx.fillStyle = 'rgba(255,215,0,0.2)';
      ctx.beginPath(); ctx.arc(bx2, by2, 48, 0, Math.PI * 2); ctx.fill();
      var grdE = ctx.createRadialGradient(bx2 - 5, by2 - 5, 3, bx2, by2, 44);
      grdE.addColorStop(0, '#FFF8E1'); grdE.addColorStop(1, '#FFB300');
      ctx.fillStyle = grdE;
      ctx.beginPath(); ctx.arc(bx2, by2, 42, 0, Math.PI * 2); ctx.fill();
      ctx.font = '42px Arial'; ctx.fillStyle = '#FFF';
      ctx.fillText('★', bx2, by2 + 12);
    }
    ctx.font = 'bold 26px Arial'; ctx.fillStyle = '#333';
    ctx.fillText(a.n, DESIGN_W / 2, py + 215);
    ctx.font = '14px Arial'; ctx.fillStyle = '#888';
    ctx.fillText(a.d, DESIGN_W / 2, py + 245);
  }
  // 分割线
  ctx.fillStyle = '#E0E0E0';
  ctx.fillRect(px + 60, py + 275, pw - 120, 1);

  ctx.font = '15px Arial'; ctx.fillStyle = '#AAA';
  ctx.fillText('点击屏幕继续', DESIGN_W / 2, py + 340);
  ctx.textAlign = 'start';
}

function drawShop() {
  ctx.fillStyle = '#4DB8E8'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H - GH);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  [[40, 30, 40, 14], [150, 20, 32, 12], [280, 45, 38, 14], [80, 130, 44, 13], [250, 110, 36, 12]]
    .forEach(c => ctx.fillRect(c[0], c[1], c[2], c[3]));
  drawGround();

  // 返回按钮
  ctx.font = 'bold 18px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(20, 20, 60, 35, 10);
  ctx.fillStyle = '#FFF'; ctx.fillText('← 返回', 50, 44);

  // 标题 + 金币
  ctx.font = 'bold 26px Arial';
  ctx.fillStyle = '#333'; ctx.fillText('商 店', DESIGN_W / 2 + 1, 61);
  ctx.fillStyle = '#FFD740'; ctx.fillText('商 店', DESIGN_W / 2, 60);
  ctx.font = 'bold 13px Arial'; ctx.fillStyle = '#FFB300';
  ctx.fillText('🪙 ' + coins, DESIGN_W / 2, 80);

  // 商品卡片（通用，左右侧栏）
  function shopCard(cx, icon, name, desc1, desc2, it) {
    var cX = cx - 90, cY = 120, cW = 180, cH = 210;
    ctx.fillStyle = 'rgba(255,255,255,0.88)'; roundRect(cX, cY, cW, cH, 14);
    // 图标（'wing' 时画一对翅膀图形，否则用 emoji）
    ctx.textAlign = 'center';
    if (icon === 'wing') drawWingPair(cx, cY + 58, 17);
    else { ctx.font = '42px Arial'; ctx.fillText(icon, cx, cY + 60); }
    // 名字
    ctx.font = 'bold 16px Arial'; ctx.fillStyle = '#333';
    ctx.fillText(name, cx, cY + 90);
    // 描述两行
    ctx.font = '11px Arial'; ctx.fillStyle = '#888';
    ctx.fillText(desc1, cx, cY + 112);
    ctx.fillText(desc2, cx, cY + 129);
    // 状态按钮
    var bX = cx - 55, bY = cY + 148, bW = 110, bH = 42;
    ctx.textAlign = 'center';
    if (!it.owned) {
      ctx.fillStyle = 'rgba(0,0,0,0.15)'; roundRect(bX + 2, bY + 2, bW, bH, 21);
      ctx.fillStyle = '#FF9800'; roundRect(bX, bY, bW, bH, 21);
      ctx.font = 'bold 14px Arial'; ctx.fillStyle = '#FFF';
      ctx.fillText('🪙 10 购买', cx, bY + 27);
    } else if (!it.equipped) {
      ctx.fillStyle = 'rgba(0,0,0,0.15)'; roundRect(bX + 2, bY + 2, bW, bH, 21);
      ctx.fillStyle = '#4CAF50'; roundRect(bX, bY, bW, bH, 21);
      ctx.font = 'bold 14px Arial'; ctx.fillStyle = '#FFF';
      ctx.fillText('穿 戴', cx, bY + 27);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; roundRect(bX, bY, bW, bH, 21);
      ctx.font = 'bold 14px Arial'; ctx.fillStyle = '#FFF';
      ctx.fillText('脱 下', cx, bY + 27);
    }
    ctx.textAlign = 'left';
  }
  // 左侧栏：主动装备
  ctx.font = 'bold 14px Arial'; ctx.textAlign = 'center'; ctx.fillStyle = '#E65100';
  ctx.fillText('⚡ 主动装备', 105, 112);
  shopCard(105, '🚀', '火箭背包', '主动 · 冲刺无敌', '撞碎管道 · CD30秒', shopState.rocket);
  // 右侧栏：被动装备
  ctx.font = 'bold 14px Arial'; ctx.fillStyle = '#1565C0';
  ctx.fillText('🛡 被动装备', 295, 112);
  shopCard(295, 'wing', '闪避之翼', '被动 · 闪避率+20%', '小粉3星乘算可达60%', shopState.wings);
  // 规则提示
  ctx.font = '11px Arial'; ctx.textAlign = 'center'; ctx.fillStyle = '#777';
  ctx.fillText('最多同时装备 1 个主动 + 1 个被动', DESIGN_W / 2, 372);
  // 提示（金币不足等）
  if (shopMsg) {
    ctx.font = 'bold 14px Arial'; ctx.fillStyle = '#E53935';
    ctx.fillText(shopMsg, DESIGN_W / 2, 395);
  }
  ctx.textAlign = 'start';
}

function drawMenu() {
  ctx.fillStyle = '#4DB8E8'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H - GH);
  // 云朵
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  [[50, 40, 44, 16], [180, 30, 36, 14], [300, 55, 40, 16], [120, 100, 32, 12], [260, 85, 36, 14], [60, 160, 48, 14], [310, 150, 38, 13]]
    .forEach(c => ctx.fillRect(c[0], c[1], c[2], c[3]));
  drawGround();

  // ===== 金币 =====
  ctx.font = 'bold 16px Arial'; ctx.textAlign = 'right';
  ctx.fillStyle = '#000'; ctx.fillText('🪙 ' + coins, DESIGN_W - 14, 33);
  ctx.fillStyle = '#FFD740'; ctx.fillText('🪙 ' + coins, DESIGN_W - 16, 31);
  ctx.textAlign = 'center';

  // ===== 标题 =====
  ctx.font = 'bold 40px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = '#333'; ctx.fillText('小鸟过管道', DESIGN_W / 2 + 2, 117);
  ctx.fillStyle = '#FFF'; ctx.fillText('小鸟过管道', DESIGN_W / 2, 115);

  // ===== 开始按钮（绿色）=====
  const btnW = 180, btnH = 44, btnX = DESIGN_W / 2 - btnW / 2, btnY = 195;
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; roundRect(btnX + 3, btnY + 3, btnW, btnH, 22);
  const btnGrad = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnH);
  btnGrad.addColorStop(0, '#4CAF50'); btnGrad.addColorStop(1, '#2E7D32');
  ctx.fillStyle = btnGrad; roundRect(btnX, btnY, btnW, btnH, 22);
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; roundRect(btnX + 4, btnY + 3, btnW - 8, btnH / 2 - 4, 15);
  ctx.font = 'bold 20px Arial'; ctx.fillStyle = '#FFF';
  ctx.fillText('开 始', DESIGN_W / 2, btnY + 29);

  // ===== 小鸟按钮（黄色）=====
  const btnY2 = 249, btnX2 = btnX;
  ctx.fillStyle = 'rgba(0,0,0,0.15)'; roundRect(btnX2 + 2, btnY2 + 2, btnW, btnH, 22);
  const btnGrad2 = ctx.createLinearGradient(btnX2, btnY2, btnX2, btnY2 + btnH);
  btnGrad2.addColorStop(0, '#FFD740'); btnGrad2.addColorStop(1, '#FFA000');
  ctx.fillStyle = btnGrad2; roundRect(btnX2, btnY2, btnW, btnH, 22);
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; roundRect(btnX2 + 3, btnY2 + 2, btnW - 6, btnH / 2 - 3, 18);
  ctx.font = 'bold 20px Arial'; ctx.fillStyle = '#FFF';
  ctx.fillText('小 鸟', DESIGN_W / 2, btnY2 + 29);

  // ===== 成就按钮（紫色）=====
  const btnY3 = 303, btnX3 = btnX;
  ctx.fillStyle = 'rgba(0,0,0,0.15)'; roundRect(btnX3 + 2, btnY3 + 2, btnW, btnH, 22);
  const btnGrad3 = ctx.createLinearGradient(btnX3, btnY3, btnX3, btnY3 + btnH);
  btnGrad3.addColorStop(0, '#9C27B0'); btnGrad3.addColorStop(1, '#6A1B9A');
  ctx.fillStyle = btnGrad3; roundRect(btnX3, btnY3, btnW, btnH, 22);
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; roundRect(btnX3 + 3, btnY3 + 2, btnW - 6, btnH / 2 - 3, 18);
  ctx.font = 'bold 20px Arial'; ctx.fillStyle = '#FFF';
  ctx.fillText('成 就', DESIGN_W / 2, btnY3 + 29);

  // ===== 商店按钮（橙色）=====
  const btnY4 = 357, btnX4 = btnX;
  ctx.fillStyle = 'rgba(0,0,0,0.15)'; roundRect(btnX4 + 2, btnY4 + 2, btnW, btnH, 22);
  const btnGrad4 = ctx.createLinearGradient(btnX4, btnY4, btnX4, btnY4 + btnH);
  btnGrad4.addColorStop(0, '#FF9800'); btnGrad4.addColorStop(1, '#E65100');
  ctx.fillStyle = btnGrad4; roundRect(btnX4, btnY4, btnW, btnH, 22);
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; roundRect(btnX4 + 3, btnY4 + 2, btnW - 6, btnH / 2 - 3, 18);
  ctx.font = 'bold 20px Arial'; ctx.fillStyle = '#FFF';
  ctx.fillText('商 店', DESIGN_W / 2, btnY4 + 29);

  // ===== 小鸟预览（小鸟按钮左侧）=====
  ctx.textAlign = 'center';
  const px = DESIGN_W / 2 - 105;
  const py = btnY2 + btnH / 2;
  const bobY = Math.sin(menuBob * 4) * 8;
  const pby = py - 15 + bobY;
  const pwf = (Math.sin(menuBob * 8) * 4) | 0;
  var cc = [['#FFD700','#FFA500'], ['#FF5252','#D32F2F'], ['#FF80AB','#E91E63']];
  var bodyC = cc[selectedBird][0], wingC = cc[selectedBird][1];
  drawBirdModel(px, pby, bodyC, wingC, 13, pwf, shopState.rocket.equipped, shopState.wings.equipped);
  var birdNames = ['小黄', '小红', '小粉'];
  var birdName = birdNames[selectedBird];
  ctx.font = 'bold 13px Arial';
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillText(birdName, px, py + 26);
  ctx.fillStyle = '#FFF'; ctx.fillText(birdName, px, py + 25);

  // ===== 排行榜按钮（左下角）=====
  ctx.font = 'bold 32px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(18, DESIGN_H - GH - 75, 55, 55, 14);
  ctx.font = 'bold 32px Arial'; ctx.fillStyle = '#FFD740';
  ctx.fillText('🏆', 45, DESIGN_H - GH - 34);

  // ===== 静音按钮（右下角）=====
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(338, DESIGN_H - GH - 75, 42, 42, 14);
  ctx.font = 'bold 18px Arial'; ctx.fillStyle = muted ? '#888' : '#FFF';
  ctx.fillText(muted ? '🔇' : '🔊', 359, DESIGN_H - GH - 42);

  // ===== 底部提示 =====
  ctx.font = 'bold 14px Arial';
  ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillText('点击「开始」进入游戏', DESIGN_W / 2, 425);
  if (best > 0) {
    ctx.font = 'bold 16px Arial';
    ctx.fillStyle = '#FFD740';
    ctx.fillText('最高分: ' + best, DESIGN_W / 2, 455);
  }

  ctx.textAlign = 'start';
}

// 圆角矩形工具
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

// 通用小鸟模型绘制
function drawBirdModel(cx, cy, bodyC, wingC, sz, wf, rkt, wgs) {
  ctx.fillStyle = bodyC;
  ctx.beginPath(); ctx.arc(cx, cy, sz, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = wingC;
  ctx.beginPath(); ctx.arc(cx - sz * 0.15, cy - sz * 0.15 + wf, sz * 0.55, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#FFF';
  ctx.beginPath(); ctx.arc(cx + sz * 0.38, cy - sz * 0.22, sz * 0.35, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(cx + sz * 0.48, cy - sz * 0.3, sz * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#F60';
  ctx.beginPath();
  ctx.moveTo(cx + sz * 0.9, cy);
  ctx.lineTo(cx + sz * 1.3, cy + sz * 0.1);
  ctx.lineTo(cx + sz * 0.9, cy + sz * 0.25);
  ctx.closePath(); ctx.fill();
  // 闪避之翼（穿戴时背上，与局内 drawBird 相同比例）
  if (wgs) drawWings(cx - sz * 0.43, cy - sz * 0.71, sz * 0.64);
  // 红色喷气背包（穿戴时背上，与局内 drawBird 相同比例）
  if (rkt) drawRocket(cx - sz * 1.21, cy, sz * 0.86, false);
}

// ===== 小鸟选择界面 =====
function drawBirds() {
  ctx.fillStyle = '#4DB8E8'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H - GH);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  [[40, 30, 40, 14], [150, 20, 32, 12], [280, 45, 38, 14], [80, 130, 44, 13], [250, 110, 36, 12]]
    .forEach(c => ctx.fillRect(c[0], c[1], c[2], c[3]));
  drawGround();

  // 返回按钮
  ctx.font = 'bold 18px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(20, 20, 60, 35, 10);
  ctx.fillStyle = '#FFF'; ctx.fillText('← 返回', 50, 44);

  // 静音按钮（右上角）
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; roundRect(340, 18, 40, 30, 10);
  ctx.font = 'bold 14px Arial'; ctx.fillStyle = muted ? '#888' : '#FFF';
  ctx.fillText(muted ? '🔇' : '🔊', 360, 38);

  // 标题
  ctx.font = 'bold 28px Arial';
  ctx.fillStyle = '#333'; ctx.fillText('选择小鸟', DESIGN_W / 2 + 1, 61);
  ctx.fillStyle = '#FFF'; ctx.fillText('选择小鸟', DESIGN_W / 2, 60);

  // 当前选中标记
  ctx.font = 'bold 11px Arial';
  var names = ['小黄', '小红', '小粉'];
  var selText = '当前: ' + names[selectedBird];
  ctx.fillStyle = '#FFD740'; ctx.fillText(selText, DESIGN_W / 2, 82);

  var wf = Math.sin(menuBob * 8) * 3;
  var bob = Math.sin(menuBob * 3) * 6;

  var birds = [
    { x: 25, name: '小黄', body: '#FFD700', wing: '#FFA500', desc: '均衡属性', rarity: 0, stars: 1, stroke: '#4CAF50' },
    { x: 145, name: '小红', body: '#FF5252', wing: '#D32F2F', desc: '疯狂吸血', rarity: 1, stars: 1, stroke: '#2196F3' },
    { x: 265, name: '小粉', body: '#FF80AB', wing: '#E91E63', desc: '点绿为金', rarity: 2, stars: 1, stroke: '#9C27B0' },
  ];
  var rColors = ['#4CAF50','#2196F3','#9C27B0','#FF9800','#F44336'];
  var rNames = ['普通','稀有','史诗','传说','神话'];
  var cw = 110, ch = 195, cy = 100;

  for (var bi = 0; bi < birds.length; bi++) {
    var b = birds[bi];
    var cx = b.x;
    var rc = rColors[b.rarity];
    // 白卡 + 稀有度边框（始终显示）
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; roundRect(cx, cy, cw, ch, 12);
    ctx.lineWidth = selectedBird === bi ? 6 : 4;
    ctx.strokeStyle = rc; roundRectStroke(cx, cy, cw, ch, 12); ctx.lineWidth = 1;
    // 底部稀有度标签（盖住圆角底部不留白线）
    ctx.fillStyle = rc;
    ctx.fillRect(cx + 1, cy + ch - 31, cw - 2, 32);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(cx + 1, cy + ch - 31, cw - 2, 3);

    drawBirdModel(cx + cw / 2, cy + 54 + bob, b.body, b.wing, 16, wf, shopState.rocket.equipped, shopState.wings.equipped);

    ctx.font = 'bold 15px Arial';
    ctx.fillStyle = '#333'; ctx.fillText(b.name, cx + cw / 2, cy + 130);
    var ss = '';
    var curSt = birdStars[bi];
    for (var si = 0; si < curSt; si++) ss += '★';
    ctx.font = 'bold 11px Arial'; ctx.fillStyle = '#FFF';
    ctx.fillText(rNames[b.rarity] + ' · ' + ss, cx + cw / 2, cy + ch - 10);
  }

  ctx.textAlign = 'start';
}

// roundRect 描边版本
function roundRectStroke(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.stroke();
}

// ===== 小鸟详情界面 =====
function drawBirdDetail() {
  var bodies = ['#FFD700', '#FF5252', '#FF80AB'];
  var wings = ['#FFA500', '#D32F2F', '#E91E63'];
  var names = ['小黄', '小红', '小粉'];
  var raris = [0, 1, 2];
  var rColors2 = ['#4CAF50','#2196F3','#9C27B0','#FF9800','#F44336'];
  var rNames2 = ['普通','稀有','史诗','传说','神话'];
  var descs = ['均衡属性', '疯狂吸血', '点绿为金'];
  var bodyC = bodies[detailBird], wingC = wings[detailBird];
  var name = names[detailBird], desc = descs[detailBird];
  var rarity = raris[detailBird];
  var rc2 = rColors2[rarity];

  ctx.fillStyle = '#4DB8E8'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H - GH);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  [[50, 25, 38, 14], [150, 18, 32, 12], [300, 40, 40, 14], [100, 140, 36, 12], [260, 120, 34, 13]]
    .forEach(c => ctx.fillRect(c[0], c[1], c[2], c[3]));
  drawGround();

  // 返回按钮（左上角）
  ctx.font = 'bold 16px Arial'; ctx.textAlign = 'center';
  // 静音按钮（右上角）
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; roundRect(340, 18, 40, 30, 10);
  ctx.font = 'bold 14px Arial'; ctx.fillStyle = muted ? '#888' : '#FFF';
  ctx.fillText(muted ? '🔇' : '🔊', 360, 38);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(18, 15, 55, 35, 10);
  ctx.fillStyle = '#FFF'; ctx.fillText('← 返回', 46, 39);

  // 标题
  ctx.font = 'bold 26px Arial';
  ctx.fillStyle = '#333'; ctx.fillText('小鸟详情', DESIGN_W / 2 + 1, 58);
  ctx.fillStyle = '#FFF'; ctx.fillText('小鸟详情', DESIGN_W / 2, 57);

  // 鸟模型（放大）
  var wf = Math.sin(menuBob * 8) * 4;
  var bob = Math.sin(menuBob * 3) * 6;
  drawBirdModel(DESIGN_W / 2, 185 + bob, bodyC, wingC, 30, wf, shopState.rocket.equipped, shopState.wings.equipped);

  // 名字 + 稀有度 + 星级
  ctx.font = 'bold 22px Arial';
  ctx.fillStyle = '#333'; ctx.fillText(name, DESIGN_W / 2, 242);
  // 稀有度标签
  ctx.fillStyle = rc2; roundRect(DESIGN_W / 2 - 30, 250, 60, 18, 9);
  ctx.font = 'bold 11px Arial'; ctx.fillStyle = '#FFF';
  ctx.fillText(rNames2[rarity], DESIGN_W / 2, 264);
  // 星级
  var curStars = birdStars[detailBird];
  var ss2 = '';
  for (var si = 0; si < curStars; si++) ss2 += '★';
  ctx.font = 'bold 15px Arial'; ctx.fillStyle = '#FFB300';
  ctx.fillText(ss2, DESIGN_W / 2, 288);

  // 特征面板
  var fx = 30, fy = 300, fw = DESIGN_W - 60, fh = 110;
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; roundRect(fx, fy, fw, fh, 14);
  ctx.font = 'bold 15px Arial'; ctx.textAlign = 'left';
  ctx.fillStyle = '#555'; ctx.fillText('▸ 特征', fx + 16, fy + 28);
  ctx.font = '13px Arial'; ctx.fillStyle = '#333';
  if (detailBird === 0) {
    ctx.fillText('❤ 开局拥有3条命', fx + 15, fy + 54);
    ctx.fillText('   触碰管道消耗1命', fx + 15, fy + 74);
    if (curStars >= 3) ctx.fillText('⭐3星: 连击8管即可触发', fx + 15, fy + 94);
    else if (curStars >= 2) ctx.fillText('⭐2星: +2条命(共5命)', fx + 15, fy + 94);
  } else if (detailBird === 1) {
    ctx.fillText('❤ 开局拥有1条命', fx + 15, fy + 54);
    ctx.fillText('   首次10分获得生命，之后每15分获得生命', fx + 15, fy + 74);
    if (curStars >= 3) ctx.fillText('⭐3星: 每次吸血+2❤', fx + 15, fy + 94);
    else if (curStars >= 2) ctx.fillText('⭐2星: +1条命(共2命)', fx + 15, fy + 94);
  } else {
    ctx.fillText('❤ 开局拥有2条命', fx + 15, fy + 54);
    ctx.fillText('   绿色管道变金色，金色管道+4分', fx + 15, fy + 74);
    if (curStars >= 3) ctx.fillText('⭐3星: 50%概率闪避管道', fx + 15, fy + 94);
    else if (curStars >= 2) ctx.fillText('⭐2星: +1条命(共3命)', fx + 15, fy + 94);
  }

  // 升级按钮
  var btnUpY = fy + fh + 8, btnUpH = 32;
  var upCost = starCosts[detailBird][curStars - 1];
  if (curStars < 3 && coins >= upCost) {
    ctx.fillStyle = 'rgba(0,0,0,0.15)'; roundRect(fx + 2, btnUpY + 2, fw, btnUpH, 14);
    var bgU = ctx.createLinearGradient(fx, btnUpY, fx, btnUpY + btnUpH);
    bgU.addColorStop(0, '#FFB300'); bgU.addColorStop(1, '#FF8F00');
    ctx.fillStyle = bgU; roundRect(fx, btnUpY, fw, btnUpH, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; roundRect(fx + 3, btnUpY + 2, fw - 6, btnUpH / 2 - 2, 12);
    ctx.font = 'bold 14px Arial'; ctx.fillStyle = '#FFF';
    ctx.fillText('⬆ 升星 (' + upCost + '币)', DESIGN_W / 2, btnUpY + 22);
    var btnY3 = btnUpY + btnUpH + 10;
  } else if (curStars >= 3) {
    ctx.font = 'bold 12px Arial'; ctx.fillStyle = '#FFD740';
    ctx.fillText('已满星 ★★★', DESIGN_W / 2, btnUpY + 19);
    var btnY3 = btnUpY + btnUpH + 10;
  } else {
    ctx.font = 'bold 12px Arial'; ctx.fillStyle = '#AAA';
    ctx.fillText('升星需要 ' + upCost + ' 币 (当前' + coins + ')', DESIGN_W / 2, btnUpY + 19);
    var btnY3 = btnUpY + btnUpH + 10;
  }

  // 确认按钮
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; roundRect(fx + 3, btnY3 + 3, fw, 44, 22);
  var bg3 = ctx.createLinearGradient(fx, btnY3, fx, btnY3 + 44);
  bg3.addColorStop(0, '#4CAF50'); bg3.addColorStop(1, '#2E7D32');
  ctx.fillStyle = bg3; roundRect(fx, btnY3, fw, 44, 22);
  ctx.fillStyle = 'rgba(255,255,255,0.2)'; roundRect(fx + 3, btnY3 + 2, fw - 6, 18, 18);
  ctx.font = 'bold 18px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = '#FFF'; ctx.fillText('选 择 ' + name, DESIGN_W / 2, btnY3 + 30);

  ctx.textAlign = 'start';
}

function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
  const px = (DESIGN_W / 2 - 130) | 0, py = (DESIGN_H / 2 - 80) | 0;
  ctx.fillStyle = '#EEE'; ctx.fillRect(px, py, 260, 160);
  ctx.fillStyle = '#333'; ctx.fillRect(px + 2, py + 2, 256, 156);
  ctx.fillStyle = '#EEE'; ctx.fillRect(px + 4, py + 4, 252, 152);
  ctx.font = 'bold 26px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = '#222'; ctx.fillText('游戏结束!', DESIGN_W / 2, py + 36);
  ctx.font = 'bold 20px Arial'; ctx.fillText('分数: ' + score, DESIGN_W / 2, py + 70);
  ctx.fillStyle = score >= best && score > 0 ? '#E65100' : '#555';
  ctx.fillText(score >= best && score > 0 ? '新纪录!' : '最高分: ' + best, DESIGN_W / 2, py + 98);
  ctx.font = '15px Arial'; ctx.fillStyle = '#777'; ctx.fillText('点击继续', DESIGN_W / 2, py + 135);
  ctx.textAlign = 'start';
}

function drawHUD() {
  // 连击状态指示（顶部居中，可同时显示多个）
  var activeC = [];
  var cNames = ['绿', '红', '蓝', '紫', '金'];
  // 黄色显示剩余管数（生效于得分时）
  if (comboTimers[4] > 0) activeC.push('金x' + comboTimers[4]);
  if (activeC.length > 0) {
    ctx.font = 'bold 12px Arial'; ctx.textAlign = 'center';
    ctx.fillStyle = '#FFD740';
    ctx.fillText(activeC.join('  '), DESIGN_W / 2, 25);
    ctx.textAlign = 'start';
  }
  // 左上角 - 爱心生命（支持半心，超出换行）
  var MAX_ROW = 12, fullH = Math.floor(lives), halfH = lives - fullH >= 0.5;
  function drawHeart(cx, cy, s, half) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy + s * 0.3);
    ctx.bezierCurveTo(cx, cy - s * 0.3, cx - s, cy - s * 0.3, cx - s, cy + s * 0.3);
    ctx.bezierCurveTo(cx - s, cy + s * 1.2, cx, cy + s * 1.6, cx, cy + s * 1.8);
    ctx.bezierCurveTo(cx, cy + s * 1.6, cx + s, cy + s * 1.2, cx + s, cy + s * 0.3);
    ctx.bezierCurveTo(cx + s, cy - s * 0.3, cx, cy - s * 0.3, cx, cy + s * 0.3);
    ctx.clip();
    ctx.fillStyle = '#FF1744';
    ctx.fillRect(cx - s - 2, cy - s * 2, s * 2 + 4, s * 4);
    if (half) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(cx, cy - s * 2, s * 2, s * 4);
    }
    ctx.restore();
  }
  for (let i = 0; i < fullH; i++) {
    var r = Math.floor(i / MAX_ROW), c = i % MAX_ROW;
    drawHeart(10 + c * 22, 14 + r * 24, 7, false);
  }
  if (halfH) {
    var r2 = Math.floor(fullH / MAX_ROW), c2 = fullH % MAX_ROW;
    drawHeart(10 + c2 * 22, 14 + r2 * 24, 7, true);
  }
  // 第二行右移避免遮挡分数
  // 分数（爱心下方）
  var scoreY = (fullH + (halfH ? 1 : 0)) > MAX_ROW ? 71 : 63;
  ctx.font = 'bold 28px Arial';
  const st = '分数:' + score;
  ctx.fillStyle = '#000'; ctx.fillText(st, 9, scoreY); ctx.fillText(st, 11, scoreY); ctx.fillText(st, 10, scoreY - 1); ctx.fillText(st, 10, scoreY + 1);
  ctx.fillStyle = '#FFF'; ctx.fillText(st, 10, scoreY);
  // 金币（右上角）
  ctx.font = 'bold 13px Arial'; ctx.textAlign = 'right';
  ctx.fillStyle = '#FFD740';
  ctx.fillText('🪙 ' + coins, DESIGN_W - 10, 68);
  ctx.textAlign = 'left';
  // 最高分（右上角）
  const bt = '最高:' + best; ctx.font = 'bold 14px Arial';
  const bw = (ctx.measureText(bt).width) | 0;
  ctx.fillStyle = '#000'; ctx.fillText(bt, DESIGN_W - bw - 16, 50); ctx.fillText(bt, DESIGN_W - bw - 14, 50); ctx.fillText(bt, DESIGN_W - bw - 15, 49); ctx.fillText(bt, DESIGN_W - bw - 15, 51);
  ctx.fillStyle = '#FFF'; ctx.fillText(bt, DESIGN_W - bw - 15, 50);
  if (level > 0) { ctx.font = 'bold 11px Arial'; ctx.fillStyle = '#F60'; ctx.fillText('Lv.' + level, 10, 78); }
  // 管道进度条（等级下方）
  var pipeColors = ['#228B22', '#CC3333', '#3366CC', '#8B3DB5', '#FFB800'];
  var pipeLabels = ['绿', '红', '蓝', '紫', '金'];
  var barX = 10, barY = 95, barW = 80, barH = 10, barGap = 14;
  ctx.textAlign = 'left';
  for (let i = 0; i < 5; i++) {
    if (pipeCounts[i] > 0) {
      ctx.font = 'bold 10px Arial'; ctx.fillStyle = '#FFF';
      ctx.fillText(pipeLabels[i], barX, barY + i * barGap + 8);
      var barMax = (selectedBird === 0 && birdStars[0] >= 3) ? 8 : 10;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(barX + 14, barY + i * barGap + 1, barW - 14, barH);
      var fill = Math.min(pipeCounts[i] / barMax, 1);
      if (fill > 0) {
        ctx.fillStyle = pipeColors[i];
        ctx.fillRect(barX + 15, barY + i * barGap + 2, (barW - 16) * fill, barH - 2);
      }
      ctx.font = '10px Arial'; ctx.fillStyle = '#DDD';
      ctx.fillText(pipeCounts[i] + '/' + barMax, barX + barW + 3, barY + i * barGap + 9);
    }
  }
  // 右上角按钮：静音 + 暂停
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; roundRect(322, 8, 28, 28, 8);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; roundRect(355, 8, 35, 28, 8);
  ctx.font = 'bold 12px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = muted ? '#888' : '#FFF';
  ctx.fillText(muted ? '🔇' : '🔊', 336, 29);
  ctx.font = 'bold 16px Arial'; ctx.fillStyle = '#FFF';
  ctx.fillText('∥', 372, 30);
  // 火箭技能按钮（左侧HUD下方，圆心 40,188 半径24）
  if (shopState.rocket.equipped) {
    var rkx = 40, rky = 188, rr = 24;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(rkx, rky, rr, 0, Math.PI * 2); ctx.fill();
    ctx.font = '20px Arial'; ctx.fillStyle = '#FFF';
    ctx.fillText('🚀', rkx, rky + 7);
    if (rocketCD > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.arc(rkx, rky, rr, 0, Math.PI * 2); ctx.fill();
      ctx.font = 'bold 14px Arial'; ctx.fillStyle = '#FFF';
      ctx.fillText('' + Math.ceil(rocketCD), rkx, rky + 5);
    } else if (rocketBoost > 0) {
      ctx.strokeStyle = '#FF9800'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(rkx, rky, rr, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
    }
  }
  ctx.textAlign = 'start';
}

function drawPause() {
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
  ctx.font = 'bold 36px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = '#FFF'; ctx.fillText('暂停中', DESIGN_W / 2, DESIGN_H / 2 - 20);
  ctx.font = '16px Arial'; ctx.fillStyle = '#CCC';
  ctx.fillText('点击屏幕继续', DESIGN_W / 2, DESIGN_H / 2 + 25);
  ctx.textAlign = 'start';
}

function drawCountdown() {
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
  ctx.font = 'bold 100px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = '#FFF'; ctx.fillText('' + resumeCountdown, DESIGN_W / 2, DESIGN_H / 2 + 20);
  ctx.font = '16px Arial'; ctx.fillStyle = '#CCC';
  ctx.fillText('准备...', DESIGN_W / 2, DESIGN_H / 2 - 60);
  ctx.textAlign = 'start';
}

function render() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  ctx.fillStyle = '#4DB8E8'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H - GH);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  for (let i = 0; i < 3; i++) {
    const cx = ((i * 150 + frame * 0.3) % (DESIGN_W + 100) - 50) | 0, cy = (45 + i * 45) | 0, w = (40 + i * 6) | 0, h = (16 + i * 2) | 0;
    ctx.fillRect(cx, cy, w, h);
  }
  for (let i = 0; i < pipes.length; i++) drawPipe(pipes[i].x, pipes[i].topH, pipes[i].gap, pipes[i].type);
  drawGround();
  // 只在游戏进行中和结束时画小鸟
  if (screen === 'playing' || (screen === 'gameover' && birdY < DESIGN_H - GH - BH)) {
    if (invincible <= 0 || Math.floor(invincible * 10) % 2 === 0) {
      drawBird(birdY);
    }
  }
  for (let i = 0; i < ptN; i++) {
    const pt = ptA[i], a = pt.life / pt.ml;
    ctx.fillStyle = pt.rgba; ctx.globalAlpha = a > 1 ? 1 : a < 0 ? 0 : a;
    ctx.fillRect(pt.x - (pt.sz >> 1), pt.y - (pt.sz >> 1), pt.sz, pt.sz);
  }
  ctx.globalAlpha = 1;
  ctx.font = 'bold 20px Arial'; ctx.textAlign = 'center';
  for (let i = 0; i < popN; i++) {
    const sp = popA[i], a = sp.life / sp.ml;
    ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(2) + ')'; ctx.fillText(sp.text, sp.x, sp.y);
  }
  ctx.textAlign = 'start';
  if (screen === 'playing') drawHUD();
  else if (screen === 'gameover') { drawHUD(); drawGameOver(); }
  else if (screen === 'badgeEarned') { drawHUD(); drawBadgeEarned(); }
  else if (screen === 'birds') drawBirds();
  else if (screen === 'birdDetail') drawBirdDetail();
  else if (screen === 'achievements') drawAchievements();
  else if (screen === 'badgeDetail') drawBadgeDetail();
  else if (screen === 'shop') drawShop();
  else drawMenu();
  if (paused) { if (resumeCountdown > 0) drawCountdown(); else drawPause(); }

  ctx.restore();

  // 排行榜覆盖层（屏幕坐标绘制）
  if (rankingVisible) {
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(offsetX, offsetY, DESIGN_W * scale, DESIGN_H * scale);

    // 返回按钮（左上角）
    ctx.font = 'bold 18px Arial'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(offsetX + 18 * scale, offsetY + 15 * scale, 55 * scale, 35 * scale, 10);
    ctx.fillStyle = '#FFF';
    ctx.fillText('← 返回', offsetX + 45 * scale, offsetY + 39 * scale);

    if (sharedCanvas) {
      ctx.drawImage(sharedCanvas, offsetX, offsetY, DESIGN_W * scale, DESIGN_H * scale);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.88)';
      ctx.fillRect(offsetX, offsetY, DESIGN_W * scale, DESIGN_H * scale);
      ctx.font = 'bold 24px Arial'; ctx.textAlign = 'center';
      ctx.fillStyle = '#FFD740';
      ctx.fillText('🏆 好友排行', screenW / 2, offsetY + 60 * scale);
      ctx.font = 'bold 16px Arial';
      ctx.fillStyle = '#AAA';
      ctx.fillText('开发环境暂不可用', screenW / 2, offsetY + 180 * scale);
      ctx.fillText('真机预览可查看好友排名', screenW / 2, offsetY + 210 * scale);
      if (best > 0) {
        ctx.fillStyle = '#FFF';
        ctx.fillText('你的最高分: ' + best, screenW / 2, offsetY + 260 * scale);
      }
      ctx.font = '14px Arial'; ctx.fillStyle = '#888';
      ctx.fillText('滑动查看更多 · 点击 ← 返回', screenW / 2, offsetY + 340 * scale);
      ctx.textAlign = 'start';
    }
  }
  ctx.restore();
}

// ===== 主循环 =====
let lt = 0;
function loop(ts) {
  upd((ts - lt) / 1000); lt = ts; render();
  requestAnimationFrame(loop);
}

// ===== 启动 =====
export default class Main {
  constructor() {
    reset();
    screen = 'menu';
    lt = Date.now();
    requestAnimationFrame(loop);
  }
}
