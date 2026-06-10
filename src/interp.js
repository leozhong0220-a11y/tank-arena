// ============================================================
// interp.js — 远程坦克插值
// 核心思想:不直接把网络收到的坐标 set 上去(会一跳一跳),
// 而是把快照存进缓冲区,渲染时回看 120ms 前,在两个快照之间平滑过渡。
// 注意:用的是"本地收到时刻"(performance.now()),
// 绝不使用对方发来的时间戳做插值——两台电脑的时钟不可比。
// ============================================================
import { INTERP_DELAY, STALE_MS } from './config.js';

// 角度插值要走最短弧(从 350° 转到 10° 应该转 20°,不是 -340°)
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d >  Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class RemoteTank {
  constructor(id) {
    this.id = id;
    this.name = '';
    this.color = '#888888';
    this.buf = [];        // 快照缓冲区
    this.x = -100; this.y = -100;   // 收到第一个快照前画在屏幕外
    this.bodyA = 0; this.aimA = 0;
    this.stale = false;   // true = 对方网络卡了
  }

  // 收到一条 'st' 消息时调用
  push(s) {
    this.buf.push({ x: s.x, y: s.y, ba: s.ba, aa: s.aa, rt: performance.now() });
    if (this.buf.length > 60) this.buf.shift();   // 只保留最近 ~5 秒
  }

  // 每帧渲染前调用:算出当前应该画在哪
  sample() {
    if (this.buf.length === 0) return;
    const now  = performance.now();
    const last = this.buf[this.buf.length - 1];
    this.stale = now - last.rt > STALE_MS;

    const t = now - INTERP_DELAY;   // 渲染时间 = 现在 − 缓冲延迟

    // 找到夹住 t 的两个快照 a、b
    let a = this.buf[0], b = last;
    for (let i = this.buf.length - 1; i >= 0; i--) {
      if (this.buf[i].rt <= t) {
        a = this.buf[i];
        b = this.buf[i + 1] || a;
        break;
      }
    }

    const span = b.rt - a.rt;
    const k = span > 0 ? Math.min(1, (t - a.rt) / span) : 1;
    this.x = a.x + (b.x - a.x) * k;
    this.y = a.y + (b.y - a.y) * k;
    this.bodyA = lerpAngle(a.ba, b.ba, k);
    this.aimA  = lerpAngle(a.aa, b.aa, k);
  }
}
