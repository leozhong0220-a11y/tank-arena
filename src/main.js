// ============================================================
// main.js — 装配与游戏主循环(M2:开炮与命中)
//
// 数据流:input → 本地模拟 → (12Hz)广播 'st' ┐
//        点击/空格 → 'fi' 开炮 ───────────────┤
//        net 收到快照 → interp 缓冲 ──────────→ render
//
// 命中判定采用「受害者权威」:
//   每台机器只判定"炮弹有没有打中 *我自己*"。
//   打中了就广播 'ht'(我被谁的哪颗炮弹打了,剩多少血,死没死)。
//   这样永远不会出现"我明明躲开了却被判死"的争议——
//   你屏幕上的你,就是权威的你。
//   代价:对方网络很卡时,射手会看到炮弹穿过对方(可接受)。
// ============================================================
import * as cfg from './config.js';
import * as net from './net.js';
import * as sfx from './sfx.js';
import { RemoteTank } from './interp.js';
import { initInput, moveVector, mouse, focused, onFire, setRotated } from './input.js';
import {
  drawField, drawTank, drawBullet, drawParticles,
  drawBox, drawFloats, drawEffectHud, drawRoundBanner,
  drawFocusHint, drawRespawnHint,
} from './render.js';

const cv = document.getElementById('cv');
const cx = cv.getContext('2d');

console.log('%c[坦克对决] M4.2 — 强制横屏', 'color:#7FD4B5;font-weight:bold');

// ---------- 回合状态 ----------
let ROOM = '';            // 房间码(算每一局的地图用)
let roundNum = 0;         // 当前局数,地图 = mapIndexFor(房间码 + 局数)
let roundOver = false;    // 结算画面中
let roundEndsAt = 0, pendingRn = 0;
let roundWinner = { name: '', color: '#E8E6DD' };

// ---------- 本地坦克 ----------
const me = {
  x: 0, y: 0, bodyA: 0, aimA: 0,
  color: '#3FA98B', name: '',
  hp: cfg.MAX_HP, dead: false,
  invulnUntil: 0,      // 重生无敌截止时刻
  respawnAt: 0,        // 死亡后的重生时刻(用于倒计时)
  shield: false,       // 护盾:挡下 1 发炮弹
  speedUntil: 0,       // 加速截止时刻
  tripleUntil: 0,      // 三连发截止时刻
  fx: 0,               // 道具视觉位标志(每帧计算,随 st 广播)
};

// ---------- 远程坦克表:playerId → RemoteTank ----------
const remotes = new Map();

// ---------- 道具箱:boxId → {x, y, k}(k = BOX_KINDS 下标) ----------
const boxes = new Map();
let isHost = false;          // 我是不是房主(joinedAt 最早的人)
let lastBoxSpawn = 0, lastBoxSync = 0, boxSeq = 0;

// ---------- 飘字 ----------
const floats = [];
function float(x, y, text, color) {
  floats.push({ x, y, text, color, age: 0, life: 1.3 });
}

// ---------- 炮弹表:bulletId → {pid, x, y, vx, vy, born, color} ----------
const bullets = new Map();

// ---------- 特效粒子 ----------
const particles = [];
function boom(x, y, color, n, spd, r) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = spd * (0.35 + Math.random() * 0.65);
    particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      age: 0, life: 0.35 + Math.random() * 0.4,
      r: r * (0.6 + Math.random() * 0.8), color,
    });
  }
}
const sparkHit  = (x, y, c) => boom(x, y, c, 10, 130, 2.5);
const sparkWall = (x, y)    => boom(x, y, '#B8B49F', 5, 80, 1.8);
const bigBoom   = (x, y, c) => { boom(x, y, c, 26, 220, 4); boom(x, y, '#E8D9A0', 14, 150, 3); };

// ---------- 击杀榜:playerId → 击杀数 ----------
const kills = new Map();
let rosterPlayers = [];   // 最近一次 presence 名单(用于随时重刷 UI)

function colorOf(pid) {
  if (pid === net.myId) return me.color;
  return remotes.get(pid)?.color || '#999999';
}

function refreshRoster() {
  document.getElementById('playerCount').textContent = rosterPlayers.length;
  document.getElementById('roster').innerHTML = rosterPlayers
    .map((p, i) => {
      const c = cfg.COLORS[i % cfg.COLORS.length];
      const k = kills.get(p.id) || 0;
      const name = p.id === net.myId ? `<b>${p.name}(我)</b>` : p.name;
      return `<span style="color:${c}">●</span> ${name} <span style="color:#9BA194">✕${k}</span>`;
    })
    .join('<br>');
}

// ---------- 当前地图(进房时由房间码哈希确定,同房间必然同图) ----------
let MAP = cfg.MAPS[0];

// ---------- 碰撞检测 ----------
function blockedAt(x, y, r) {
  if (x < r || y < r || x > cfg.W - r || y > cfg.H - r) return true;
  for (const w of MAP.walls)
    if (x > w.x - r && x < w.x + w.w + r && y > w.y - r && y < w.y + w.h + r) return true;
  return false;
}

// ---------- 出生点保险:万一某个点被堵(以后改地图也安全),向外螺旋找空位 ----------
function safePoint(x, y) {
  if (!blockedAt(x, y, cfg.TANK_R)) return [x, y];
  for (let rad = 20; rad <= 200; rad += 20)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const nx = x + Math.cos(a) * rad, ny = y + Math.sin(a) * rad;
      if (!blockedAt(nx, ny, cfg.TANK_R)) return [nx, ny];
    }
  return [cfg.W / 2, cfg.H / 2 - 120];   // 理论上到不了这里
}

// ---------- 网络消息处理 ----------

// 状态快照 → 插值缓冲;hp/fx 不插值,直接取最新值
net.on('st', (p) => {
  const r = remotes.get(p.id);
  if (r) { r.push(p); r.hp = p.hp ?? cfg.MAX_HP; r.fx = p.fx | 0; }
});

// 房主刷了一个箱子
net.on('bx', (b) => boxes.set(b.bid, { x: b.x, y: b.y, k: b.k }));

// 房主全量同步箱子(迟到进房 / 防消息丢失);附带局数,迟到者据此校正地图
net.on('bxs', (s) => {
  if (s.rn !== undefined && s.rn !== roundNum && !roundOver) {
    roundNum = s.rn;
    MAP = cfg.MAPS[cfg.mapIndexFor(ROOM + roundNum)];
    const el = document.getElementById('mapName');
    if (el) el.textContent = MAP.name;
    if (blockedAt(me.x, me.y, cfg.TANK_R)) [me.x, me.y] = safePoint(me.x, me.y);   // 新地图把我压墙里就挪开
  }
  boxes.clear();
  for (const b of s.boxes) boxes.set(b.bid, { x: b.x, y: b.y, k: b.k });
});

// 有人认领了箱子 → 删箱、飘字(效果本身通过对方的 st.fx 同步过来)
net.on('pk', (p) => {
  const bx = boxes.get(p.bid);
  boxes.delete(p.bid);
  if (bx) {
    const kind = cfg.BOX_KINDS[p.k];
    const who = remotes.get(p.pid);
    float(bx.x, bx.y - 18, (who?.name || '?') + ' ' + kind.label, kind.color);
    boom(bx.x, bx.y, kind.color, 8, 100, 2);
    sfx.pickup(0.5);
  }
});

// 有人开炮 → 本地生成这颗炮弹(之后各机独立模拟弹道)
net.on('fi', (b) => {
  if (roundOver) return;   // 结算画面中忽略残余炮火
  bullets.set(b.bid, {
    pid: b.pid, x: b.x, y: b.y,
    vx: Math.cos(b.a) * cfg.BULLET_SPD,
    vy: Math.sin(b.a) * cfg.BULLET_SPD,
    born: performance.now(), color: colorOf(b.pid),
  });
  sfx.fire(0.5);   // 远处的炮声小一点
});

// 有人宣布被打中(受害者权威)→ 删炮弹、出特效、记击杀
net.on('ht', (h) => {
  bullets.delete(h.bid);
  const v = remotes.get(h.victim);
  if (v) {
    v.hp = h.hp;
    if (h.sh) { boom(v.x, v.y, '#7FD4B5', 14, 140, 2.5); sfx.shieldBlock(0.7); }
    else if (h.dead) { bigBoom(v.x, v.y, v.color); sfx.explode(0.8); }
    else { sparkHit(v.x, v.y, v.color); sfx.hit(0.7); }
  }
  if (h.dead) {
    kills.set(h.by, (kills.get(h.by) || 0) + 1);
    refreshRoster();
    checkWin(h.by);
  }
});

// 在线名单变化(有人进/出)→ 维护 remotes 表、分配颜色、刷新名单
net.on('presence', (state) => {
  rosterPlayers = Object.entries(state)
    .map(([id, metas]) => ({ id, ...metas[0] }))
    .sort((a, b) => a.joinedAt - b.joinedAt);   // 按加入顺序排,颜色才稳定

  rosterPlayers.forEach((p, i) => {
    const color = cfg.COLORS[i % cfg.COLORS.length];
    if (p.id === net.myId) {
      me.color = color; me.name = p.name;
    } else {
      let r = remotes.get(p.id);
      if (!r) { r = new RemoteTank(p.id); remotes.set(p.id, r); }
      r.name = p.name; r.color = color;
    }
  });

  // 清理已离开的玩家
  for (const id of remotes.keys())
    if (!state[id]) remotes.delete(id);

  // 房主 = joinedAt 最早的人;房主掉线自动由下一位接任
  const wasHost = isHost;
  isHost = rosterPlayers.length > 0 && rosterPlayers[0].id === net.myId;
  // 名单变化时房主全量同步箱子,迟到进房的人立刻看到场上的箱子
  if (isHost) syncBoxes();
  if (isHost && !wasHost) lastBoxSpawn = performance.now();   // 刚接任,重置刷箱计时

  refreshRoster();
});

// ---------- 回合制(胜负判定:房主权威) ----------
function nameColorOf(pid) {
  const i = rosterPlayers.findIndex((p) => p.id === pid);
  return {
    name: pid === net.myId ? me.name : (remotes.get(pid)?.name || '?'),
    color: i >= 0 ? cfg.COLORS[i % cfg.COLORS.length] : '#E8E6DD',
  };
}

// 房主在每次击杀数变动后检查:有人到目标 → 广播回合结束
function checkWin(pid) {
  if (!isHost || roundOver) return;
  if ((kills.get(pid) || 0) >= cfg.KILL_TARGET) {
    const rn = roundNum + 1;
    net.send('rw', { winner: pid, rn });
    applyRoundOver(pid, rn);
  }
}

function applyRoundOver(winnerPid, rn) {
  if (roundOver) return;
  roundOver = true;
  pendingRn = rn;
  roundEndsAt = performance.now() + cfg.ROUND_OVER_MS;
  roundWinner = nameColorOf(winnerPid);
  bullets.clear(); boxes.clear(); particles.length = 0;
  sfx.win();
  setTimeout(startNewRound, cfg.ROUND_OVER_MS);
}

function startNewRound() {
  roundNum = pendingRn;
  MAP = cfg.MAPS[cfg.mapIndexFor(ROOM + roundNum)];
  const el = document.getElementById('mapName');
  if (el) el.textContent = MAP.name;
  kills.clear();
  bullets.clear(); boxes.clear();
  // 自己满状态重生
  const sp = MAP.spawns[Math.floor(Math.random() * MAP.spawns.length)];
  [me.x, me.y] = safePoint(sp[0], sp[1]);
  me.hp = cfg.MAX_HP; me.dead = false;
  me.shield = false; me.speedUntil = 0; me.tripleUntil = 0;
  me.invulnUntil = performance.now() + cfg.INVULN_MS;
  roundOver = false;
  if (isHost) { lastBoxSpawn = performance.now(); syncBoxes(); }
  refreshRoster();
}

net.on('rw', (h) => applyRoundOver(h.winner, h.rn));

// ---------- 房主:刷箱与同步 ----------
function syncBoxes() {
  net.send('bxs', { boxes: [...boxes.entries()].map(([bid, b]) => ({ bid, ...b })), rn: roundNum });
  lastBoxSync = performance.now();
}

function hostBoxTick(now) {
  // 每 5 秒全量同步一次,防消息丢失
  if (now - lastBoxSync > 5000) syncBoxes();
  if (boxes.size >= cfg.BOX_MAX || now - lastBoxSpawn < cfg.BOX_SPAWN_MS) return;
  // 找一个不卡墙、离现有箱子不太近的随机点
  for (let tries = 0; tries < 30; tries++) {
    const x = 40 + Math.random() * (cfg.W - 80);
    const y = 40 + Math.random() * (cfg.H - 80);
    if (blockedAt(x, y, cfg.BOX_R + 6)) continue;
    let near = false;
    for (const b of boxes.values())
      if (Math.hypot(b.x - x, b.y - y) < 60) { near = true; break; }
    if (near) continue;
    const bid = 'b' + net.myId.slice(0, 4) + (++boxSeq);
    const k = Math.floor(Math.random() * cfg.BOX_KINDS.length);
    boxes.set(bid, { x, y, k });
    net.send('bx', { bid, x: Math.round(x), y: Math.round(y), k });
    lastBoxSpawn = now;
    return;
  }
}

// ---------- 拾取道具 ----------
function applyPickup(k) {
  const now = performance.now();
  const kind = cfg.BOX_KINDS[k];
  if (k === 0) me.speedUntil = now + cfg.SPEED_MS;
  if (k === 1) me.tripleUntil = now + cfg.TRIPLE_MS;
  if (k === 2) me.shield = true;
  if (k === 3) { me.hp = cfg.MAX_HP; }
  float(me.x, me.y - 30, '+' + kind.label, kind.color);
  boom(me.x, me.y, kind.color, 10, 110, 2.2);
  sfx.pickup();
}

// ---------- 开炮 ----------
let lastFire = -1e9;
let bulletSeq = 0;

function fire() {
  const now = performance.now();
  if (me.dead || roundOver) return;
  if (now - lastFire < cfg.FIRE_CD) return;
  lastFire = now;
  me.invulnUntil = 0;   // 开炮立刻解除重生无敌,防止无敌状态白嫖输出
  sfx.fire();

  // 三连发生效时打扇形三发,否则单发
  const angles = now < me.tripleUntil
    ? [me.aimA - cfg.TRIPLE_SPREAD, me.aimA, me.aimA + cfg.TRIPLE_SPREAD]
    : [me.aimA];

  for (const a of angles) {
    const bid = net.myId.slice(0, 6) + '-' + (++bulletSeq);
    const x = me.x + Math.cos(a) * 24;
    const y = me.y + Math.sin(a) * 24;
    bullets.set(bid, {
      pid: net.myId, x, y,
      vx: Math.cos(a) * cfg.BULLET_SPD,
      vy: Math.sin(a) * cfg.BULLET_SPD,
      born: now, color: me.color,
    });
    net.send('fi', { bid, pid: net.myId, x: Math.round(x), y: Math.round(y), a: +a.toFixed(3) });
  }
  boom(me.x + Math.cos(me.aimA) * 24, me.y + Math.sin(me.aimA) * 24, '#E8D9A0', 4, 90, 1.6);
}
onFire(fire);

// ---------- 中弹 / 死亡 / 重生 ----------
function takeHit(b, bid) {
  bullets.delete(bid);
  // 护盾:挡下这一发,不掉血
  if (me.shield) {
    me.shield = false;
    boom(me.x, me.y, '#7FD4B5', 14, 140, 2.5);
    float(me.x, me.y - 30, '护盾抵挡!', '#7FD4B5');
    sfx.shieldBlock();
    net.send('ht', { bid, victim: net.myId, by: b.pid, hp: me.hp, dead: false, sh: 1 });
    return;
  }
  me.hp -= 1;
  const dead = me.hp <= 0;
  if (dead) {
    me.dead = true;
    me.respawnAt = performance.now() + cfg.RESPAWN_MS;
    me.shield = false; me.speedUntil = 0; me.tripleUntil = 0;   // 死亡掉光道具
    bigBoom(me.x, me.y, me.color);
    sfx.explode();
    kills.set(b.pid, (kills.get(b.pid) || 0) + 1);   // broadcast self:false,自己这边手动记
    refreshRoster();
    setTimeout(respawn, cfg.RESPAWN_MS);
  } else {
    sparkHit(me.x, me.y, me.color);
    sfx.hit();
  }
  net.send('ht', { bid, victim: net.myId, by: b.pid, hp: Math.max(0, me.hp), dead });
  if (dead) checkWin(b.pid);
}

function respawn() {
  if (!me.dead || roundOver) return;   // 新一局已重置 / 结算中,这个旧定时器作废
  // 选离所有敌人最远的出生点,避免落地秒杀
  let best = MAP.spawns[0], bestD = -1;
  for (const sp of MAP.spawns) {
    let d = Infinity;
    for (const r of remotes.values())
      if ((r.hp ?? 1) > 0) d = Math.min(d, Math.hypot(sp[0] - r.x, sp[1] - r.y));
    if (d > bestD) { bestD = d; best = sp; }
  }
  [me.x, me.y] = safePoint(best[0], best[1]);
  me.hp = cfg.MAX_HP; me.dead = false;
  me.invulnUntil = performance.now() + cfg.INVULN_MS;
}

// ---------- 状态广播(限频是网络层成本的关键) ----------
let lastSent = 0;
let lastSnapshot = '';

function broadcastState() {
  const now = performance.now();
  const snap = {
    id: net.myId,
    x: Math.round(me.x), y: Math.round(me.y),
    ba: +me.bodyA.toFixed(2), aa: +me.aimA.toFixed(2),
    hp: me.dead ? 0 : me.hp,
    fx: me.fx,
  };
  const key = `${snap.x},${snap.y},${snap.ba},${snap.aa},${snap.hp},${snap.fx}`;
  const changed = key !== lastSnapshot;
  // 移动时 12Hz,静止时降到 2Hz 心跳(告诉别人"我还在")
  const interval = changed ? 1000 / cfg.TICK_HZ : 1000 / cfg.IDLE_HZ;
  if (now - lastSent >= interval) {
    net.send('st', snap);
    lastSent = now;
    lastSnapshot = key;
  }
}

// ---------- 主循环 ----------
let lastTs = 0;
function loop(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  const now = performance.now();

  // 1. 本地坦克:输入即时生效(零延迟手感);死亡或结算中不能动
  if (!me.dead && !roundOver) {
    const [mx, my] = moveVector();
    const spd = cfg.BASE_SPD * (now < me.speedUntil ? cfg.SPEED_MULT : 1);
    if (mx || my) {
      const nx = me.x + mx * spd * dt;
      const ny = me.y + my * spd * dt;
      // 防卡死保险:如果当前位置本身已经在墙里(理论上不该发生),放行移动让玩家逃出来
      const stuck = blockedAt(me.x, me.y, cfg.TANK_R);
      if (stuck || !blockedAt(nx, me.y, cfg.TANK_R)) me.x = nx;
      if (stuck || !blockedAt(me.x, ny, cfg.TANK_R)) me.y = ny;
      const tgtA = Math.atan2(my, mx);
      let da = tgtA - me.bodyA;
      while (da >  Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      me.bodyA += da * Math.min(1, dt * 9);
    }
    me.aimA = Math.atan2(mouse.y - me.y, mouse.x - me.x);

    // 拾取检测:碰到箱子 → 本地立即生效 + 广播认领
    for (const [bid, bx] of boxes) {
      if (Math.hypot(bx.x - me.x, bx.y - me.y) < cfg.TANK_R + cfg.BOX_R) {
        boxes.delete(bid);
        applyPickup(bx.k);
        net.send('pk', { bid, pid: net.myId, k: bx.k });
      }
    }
  }

  // 道具视觉位标志(随 st 同步给所有人)
  me.fx = (me.shield ? 1 : 0) | (now < me.speedUntil ? 2 : 0) | (now < me.tripleUntil ? 4 : 0);

  // 2. 广播自己的状态;房主额外负责刷箱与同步(结算中暂停刷箱)
  broadcastState();
  if (isHost && !roundOver) hostBoxTick(now);

  // 3. 炮弹模拟:飞行、撞墙、超时、是否打中"我"
  for (const [bid, b] of bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (now - b.born > cfg.BULLET_LIFE || blockedAt(b.x, b.y, cfg.BULLET_R - 2)) {
      sparkWall(b.x, b.y);
      bullets.delete(bid);
      continue;
    }
    // 受害者权威:只判定打没打中自己(结算中不判)
    if (!me.dead && !roundOver && now > me.invulnUntil && b.pid !== net.myId &&
        Math.hypot(b.x - me.x, b.y - me.y) < cfg.TANK_R + cfg.BULLET_R) {
      takeHit(b, bid);
    }
  }

  // 4. 粒子特效与飘字更新
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age += dt;
    if (p.age >= p.life) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.92; p.vy *= 0.92;
  }
  for (let i = floats.length - 1; i >= 0; i--) {
    const f = floats[i];
    f.age += dt; f.y -= 26 * dt;
    if (f.age >= f.life) floats.splice(i, 1);
  }

  // 5. 远程坦克:从插值缓冲取出当前应渲染的位置
  for (const r of remotes.values()) r.sample();

  // 6. 渲染
  drawField(cx, MAP.walls);
  for (const b of boxes.values()) drawBox(cx, b, now);
  for (const b of bullets.values()) drawBullet(cx, b);
  for (const r of remotes.values())
    if ((r.hp ?? cfg.MAX_HP) > 0) drawTank(cx, r, false);
  if (!me.dead) drawTank(cx, me, true);
  drawParticles(cx, particles);
  drawFloats(cx, floats);
  // 左上角:自己当前生效的道具
  const fxLines = [];
  if (me.shield) fxLines.push({ text: '护盾 ✓', color: '#7FD4B5' });
  if (now < me.speedUntil) fxLines.push({ text: `加速 ${((me.speedUntil - now) / 1000).toFixed(1)}s`, color: '#4E9ED9' });
  if (now < me.tripleUntil) fxLines.push({ text: `三连发 ${((me.tripleUntil - now) / 1000).toFixed(1)}s`, color: '#D9A23E' });
  drawEffectHud(cx, fxLines);
  if (roundOver) {
    const next = cfg.MAPS[cfg.mapIndexFor(ROOM + pendingRn)].name;
    drawRoundBanner(cx, roundWinner.name, roundWinner.color, roundEndsAt - now, next);
  } else if (me.dead) {
    drawRespawnHint(cx, me.respawnAt - now);
  }
  if (!focused) drawFocusHint(cx);

  requestAnimationFrame(loop);
}

// ---------- 大厅逻辑 ----------
const $ = (id) => document.getElementById(id);

function randomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // 去掉易混淆的 I、O
  return Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
}

// ---------- 手机全屏适配(竖屏时整体旋转 90° 强制横屏) ----------
const IS_TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

function updateLayout() {
  const game = document.getElementById('game');
  if (!game.classList.contains('mfs')) return;
  const portrait = window.innerHeight > window.innerWidth;
  game.classList.toggle('rot', portrait);
  setRotated(portrait);
  // 可用空间:旋转模式下宽高互换
  const aw = portrait ? window.innerHeight : window.innerWidth;
  const ah = portrait ? window.innerWidth : window.innerHeight;
  const s = Math.min(aw / cfg.W, ah / cfg.H);
  cv.style.width = Math.floor(cfg.W * s) + 'px';
  cv.style.height = Math.floor(cfg.H * s) + 'px';
}

function enableMobileLayout() {
  document.body.classList.add('touchmode', 'ingame');
  document.getElementById('game').classList.add('mfs');
  updateLayout();
  window.addEventListener('resize', updateLayout);
  // 能锁横屏就锁(Android Chrome 全屏下支持);锁不了也无所谓,旋转模式兜底
  try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch {}
  try { screen.orientation?.lock?.('landscape').then(updateLayout).catch(() => {}); } catch {}
}

async function enterRoom(code, name) {
  $('lobbyError').textContent = '';
  $('btnCreate').disabled = $('btnJoin').disabled = true;
  if (IS_TOUCH) enableMobileLayout();   // 在点击手势内尽早请求全屏,成功率最高
  try {
    await net.join(code, name);
    sfx.unlock();   // 浏览器要求音频由用户手势触发,进房点击正好是
    // 进房成功:房间码+局数哈希定地图(同房间所有人同图)、随机出生点、切换 UI
    ROOM = code;
    MAP = cfg.MAPS[cfg.mapIndexFor(ROOM + roundNum)];
    const sp = MAP.spawns[Math.floor(Math.random() * MAP.spawns.length)];
    [me.x, me.y] = safePoint(sp[0], sp[1]);
    $('lobby').style.display = 'none';
    $('game').style.display = 'block';
    initInput(cv);
    requestAnimationFrame(loop);
    // HUD 文本放最后,且元素缺失时不让游戏崩掉(防止 HTML/JS 版本混搭黑屏)
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('roomCode', code);
    set('mapName', MAP.name);
  } catch (err) {
    $('lobbyError').textContent = err.message;
    $('btnCreate').disabled = $('btnJoin').disabled = false;
    if (IS_TOUCH) {   // 进房失败:撤掉全屏布局回大厅
      document.body.classList.remove('ingame');
      document.getElementById('game').classList.remove('mfs');
      try { document.exitFullscreen?.().catch(() => {}); } catch {}
    }
  }
}

$('btnCreate').addEventListener('click', () => {
  const name = $('nameInput').value.trim() || '玩家' + Math.floor(Math.random() * 99);
  enterRoom(randomCode(), name);
});

$('btnJoin').addEventListener('click', () => {
  const name = $('nameInput').value.trim() || '玩家' + Math.floor(Math.random() * 99);
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { $('lobbyError').textContent = '房间码是 4 位字母'; return; }
  enterRoom(code, name);
});

// 音效开关
const btnSound = $('btnSound');
if (btnSound) btnSound.addEventListener('click', () => {
  btnSound.innerHTML = sfx.toggle() ? '&#128263;' : '&#128266;';
});
