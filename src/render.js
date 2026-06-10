// ============================================================
// render.js — 渲染层:只负责画,不改任何游戏状态
// ============================================================
import { W, H, MAX_HP } from './config.js';

// 把颜色加深,用来画履带和炮塔(省去维护一套深色表)
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.floor(((n >> 16) & 255) * f);
  const g = Math.floor(((n >> 8) & 255) * f);
  const b = Math.floor((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

export function drawField(cx, walls) {
  cx.fillStyle = '#2E332B';
  cx.fillRect(0, 0, W, H);
  cx.strokeStyle = '#3A4036'; cx.lineWidth = 1;
  for (let x = 48; x < W; x += 48) { cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, H); cx.stroke(); }
  for (let y = 48; y < H; y += 48) { cx.beginPath(); cx.moveTo(0, y); cx.lineTo(W, y); cx.stroke(); }
  cx.strokeStyle = '#6B7159'; cx.lineWidth = 3;
  cx.strokeRect(1.5, 1.5, W - 3, H - 3);
  cx.lineWidth = 1;
  for (const w of walls) {
    cx.fillStyle = '#565D49';
    cx.beginPath(); cx.roundRect(w.x, w.y, w.w, w.h, 6); cx.fill();
    cx.fillStyle = '#6B7159';
    cx.beginPath(); cx.roundRect(w.x, w.y, w.w, 9, 6); cx.fill();
  }
}

// 道具箱:木箱 + 问号(种类保密,捡了才知道)
export function drawBox(cx, b, now) {
  const bob = Math.sin(now / 400 + b.x) * 2;   // 轻微浮动,显眼一点
  const y = b.y + bob;
  cx.save(); cx.translate(b.x, y);
  cx.fillStyle = '#8A7A46';
  cx.beginPath(); cx.roundRect(-13, -13, 26, 26, 5); cx.fill();
  cx.strokeStyle = '#5C5230'; cx.lineWidth = 2;
  cx.strokeRect(-13, -13, 26, 26);
  cx.beginPath(); cx.moveTo(-13, 0); cx.lineTo(13, 0); cx.stroke();
  cx.fillStyle = '#F2EFE4';
  cx.font = '700 16px sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText('?', 0, 1);
  cx.restore(); cx.lineWidth = 1;
}

// 飘字(捡到道具 / 击杀提示)
export function drawFloats(cx, floats) {
  cx.font = '700 14px sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  for (const f of floats) {
    cx.globalAlpha = Math.max(0, 1 - f.age / f.life);
    cx.fillStyle = f.color;
    cx.fillText(f.text, f.x, f.y);
  }
  cx.globalAlpha = 1;
}

// 自己当前生效的道具状态(画在画布左上角)
export function drawEffectHud(cx, lines) {
  if (!lines.length) return;
  cx.font = '600 13px sans-serif';
  cx.textAlign = 'left'; cx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const y = 22 + i * 22;
    cx.fillStyle = 'rgba(15,18,13,0.65)';
    cx.beginPath(); cx.roundRect(10, y - 10, cx.measureText(l.text).width + 20, 20, 6); cx.fill();
    cx.fillStyle = l.color;
    cx.fillText(l.text, 20, y + 1);
  });
}

// 画一辆坦克(本地和远程通用)
// t 需要:x, y, bodyA, aimA, color, name;可选:stale, hp, invulnUntil
export function drawTank(cx, t, isMe) {
  const dark = shade(t.color, 0.55);

  // 重生无敌:半透明闪烁
  const now = performance.now();
  const invuln = t.invulnUntil && now < t.invulnUntil;
  if (invuln) cx.globalAlpha = 0.45 + 0.35 * Math.sin(now / 70);

  // 车身 + 履带
  cx.save(); cx.translate(t.x, t.y); cx.rotate(t.bodyA);
  cx.fillStyle = dark;
  cx.fillRect(-16, -13, 32, 5); cx.fillRect(-16, 8, 32, 5);
  cx.fillStyle = t.color;
  cx.beginPath(); cx.roundRect(-14, -9, 28, 18, 4); cx.fill();
  cx.restore();

  // 炮塔(独立朝向)
  cx.save(); cx.translate(t.x, t.y); cx.rotate(t.aimA);
  cx.strokeStyle = dark; cx.lineWidth = 5;
  cx.beginPath(); cx.moveTo(0, 0); cx.lineTo(22, 0); cx.stroke();
  cx.fillStyle = dark;
  cx.beginPath(); cx.arc(0, 0, 8, 0, 7); cx.fill();
  cx.restore(); cx.lineWidth = 1;
  cx.globalAlpha = 1;

  // 道具视觉:fx 位标志(1=护盾 2=加速 4=三连发),本地远程通用
  const fx = t.fx | 0;
  if (fx & 1) {   // 护盾:呼吸光环
    cx.strokeStyle = '#7FD4B5'; cx.lineWidth = 2;
    cx.globalAlpha = 0.55 + 0.3 * Math.sin(now / 180);
    cx.beginPath(); cx.arc(t.x, t.y, 22, 0, 7); cx.stroke();
    cx.globalAlpha = 1; cx.lineWidth = 1;
  }
  if (fx & 2) {   // 加速:车尾速度线
    cx.strokeStyle = '#4E9ED9'; cx.globalAlpha = 0.5; cx.lineWidth = 2;
    for (const off of [-8, 0, 8]) {
      const bx = t.x - Math.cos(t.bodyA) * 20 + Math.cos(t.bodyA + Math.PI / 2) * off;
      const by = t.y - Math.sin(t.bodyA) * 20 + Math.sin(t.bodyA + Math.PI / 2) * off;
      cx.beginPath(); cx.moveTo(bx, by);
      cx.lineTo(bx - Math.cos(t.bodyA) * 10, by - Math.sin(t.bodyA) * 10); cx.stroke();
    }
    cx.globalAlpha = 1; cx.lineWidth = 1;
  }
  if (fx & 4) {   // 三连发:炮口金色光点
    cx.fillStyle = '#D9A23E';
    cx.beginPath();
    cx.arc(t.x + Math.cos(t.aimA) * 22, t.y + Math.sin(t.aimA) * 22, 3.5, 0, 7);
    cx.fill();
  }

  // 名字(自己加框,方便分辨)
  cx.font = '500 12px sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillStyle = isMe ? '#FFFFFF' : '#C9CEC2';
  cx.fillText((isMe ? '▶ ' : '') + t.name, t.x, t.y - 30);

  // 血量格(满格绿 → 1 格红)
  const hp = t.hp ?? MAX_HP;
  const pw = 9, gap = 3, total = MAX_HP * pw + (MAX_HP - 1) * gap;
  for (let i = 0; i < MAX_HP; i++) {
    cx.fillStyle = i < hp
      ? (hp === 1 ? '#E07B6E' : '#7FD4B5')
      : 'rgba(255,255,255,0.15)';
    cx.fillRect(t.x - total / 2 + i * (pw + gap), t.y - 23, pw, 4);
  }

  // 对方网络卡顿标记
  if (t.stale) {
    cx.fillStyle = '#E0B040';
    cx.fillText('…', t.x + 34, t.y - 30);
  }
}

// 炮弹:小圆 + 短拖尾
export function drawBullet(cx, b) {
  const sp = Math.hypot(b.vx, b.vy) || 1;
  cx.strokeStyle = b.color; cx.globalAlpha = 0.45; cx.lineWidth = 3;
  cx.beginPath();
  cx.moveTo(b.x - b.vx / sp * 12, b.y - b.vy / sp * 12);
  cx.lineTo(b.x, b.y); cx.stroke();
  cx.globalAlpha = 1; cx.lineWidth = 1;
  cx.fillStyle = '#F2EFE4';
  cx.beginPath(); cx.arc(b.x, b.y, 4, 0, 7); cx.fill();
  cx.fillStyle = b.color;
  cx.beginPath(); cx.arc(b.x, b.y, 2.5, 0, 7); cx.fill();
}

// 粒子特效(命中火花 / 死亡爆炸)
export function drawParticles(cx, parts) {
  for (const p of parts) {
    cx.globalAlpha = Math.max(0, 1 - p.age / p.life);
    cx.fillStyle = p.color;
    cx.beginPath(); cx.arc(p.x, p.y, p.r * (1 - p.age / p.life * 0.5), 0, 7); cx.fill();
  }
  cx.globalAlpha = 1;
}

// 回合结算横幅
export function drawRoundBanner(cx, winnerName, winnerColor, msLeft, nextMapName) {
  cx.fillStyle = 'rgba(15,18,13,0.82)';
  cx.beginPath(); cx.roundRect(W / 2 - 190, H / 2 - 64, 380, 128, 16); cx.fill();
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillStyle = winnerColor;
  cx.font = '700 24px sans-serif';
  cx.fillText(winnerName + ' 获胜!', W / 2, H / 2 - 28);
  cx.fillStyle = '#E8E6DD';
  cx.font = '400 15px sans-serif';
  cx.fillText(`${Math.ceil(msLeft / 1000)} 秒后开新一局`, W / 2, H / 2 + 8);
  cx.fillStyle = '#9BA194';
  cx.font = '400 13px sans-serif';
  cx.fillText('下一张地图:' + nextMapName, W / 2, H / 2 + 36);
}

// 阵亡后的重生倒计时
export function drawRespawnHint(cx, msLeft) {
  cx.fillStyle = 'rgba(15,18,13,0.78)';
  cx.beginPath(); cx.roundRect(W / 2 - 130, H / 2 - 28, 260, 56, 12); cx.fill();
  cx.fillStyle = '#FFFFFF';
  cx.font = '600 17px sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText(`被击毁了!${Math.ceil(msLeft / 1000)} 秒后重生`, W / 2, H / 2);
}

export function drawFocusHint(cx) {
  cx.fillStyle = 'rgba(15,18,13,0.78)';
  cx.beginPath(); cx.roundRect(W / 2 - 170, 16, 340, 40, 10); cx.fill();
  cx.fillStyle = '#FFFFFF';
  cx.font = '400 15px sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText('先点一下战场,键盘才能控制坦克', W / 2, 36);
}
