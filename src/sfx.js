// ============================================================
// sfx.js — 音效层:全部用 WebAudio 现场合成,不需要任何音频文件
// 浏览器规定 AudioContext 必须由用户手势触发,所以 unlock()
// 要在某次点击事件里调用(进房按钮正好是一次手势)。
// ============================================================

let ac = null, master = null;
let muted = false;

function ctx() {
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;                      // 测试环境/不支持时静默跳过
  if (!ac) {
    ac = new AC();
    master = ac.createGain();
    master.gain.value = 0.25;
    master.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

export function unlock() { try { ctx(); } catch {} }
export function toggle() { muted = !muted; return muted; }
export function isMuted() { return muted; }

// ---- 小工具 ----
function tone(c, { type = 'sine', f0, f1, t0, dur, vol = 0.5 }) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function noise(c, { t0, dur, vol = 0.5, filterF0 = 2000, filterF1 = 400 }) {
  const len = Math.ceil(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(); src.buffer = buf;
  const flt = c.createBiquadFilter(); flt.type = 'lowpass';
  flt.frequency.setValueAtTime(filterF0, t0);
  flt.frequency.exponentialRampToValueAtTime(filterF1, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(flt); flt.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur + 0.02);
}

// ---- 音效(vol 参数:远处的事件可以传小一点) ----

// 开炮:短促的"砰"(方波降调 + 一点白噪)
export function fire(vol = 1) {
  if (muted) return; const c = ctx(); if (!c) return;
  const t = c.currentTime;
  tone(c, { type: 'square', f0: 190, f1: 65, t0: t, dur: 0.11, vol: 0.4 * vol });
  noise(c, { t0: t, dur: 0.06, vol: 0.25 * vol, filterF0: 3000, filterF1: 800 });
}

// 命中:金属"铛"
export function hit(vol = 1) {
  if (muted) return; const c = ctx(); if (!c) return;
  const t = c.currentTime;
  tone(c, { type: 'triangle', f0: 340, f1: 160, t0: t, dur: 0.09, vol: 0.45 * vol });
  noise(c, { t0: t, dur: 0.07, vol: 0.3 * vol, filterF0: 4000, filterF1: 1200 });
}

// 护盾挡弹:清脆高音"叮"
export function shieldBlock(vol = 1) {
  if (muted) return; const c = ctx(); if (!c) return;
  const t = c.currentTime;
  tone(c, { type: 'sine', f0: 1250, f1: 880, t0: t, dur: 0.14, vol: 0.4 * vol });
}

// 击毁:低沉爆炸(长白噪 + 低频)
export function explode(vol = 1) {
  if (muted) return; const c = ctx(); if (!c) return;
  const t = c.currentTime;
  noise(c, { t0: t, dur: 0.5, vol: 0.7 * vol, filterF0: 900, filterF1: 80 });
  tone(c, { type: 'sine', f0: 110, f1: 38, t0: t, dur: 0.45, vol: 0.5 * vol });
}

// 捡到道具:上行三连音
export function pickup(vol = 1) {
  if (muted) return; const c = ctx(); if (!c) return;
  const t = c.currentTime;
  [523, 784, 1046].forEach((f, i) =>
    tone(c, { type: 'sine', f0: f, t0: t + i * 0.07, dur: 0.12, vol: 0.35 * vol }));
}

// 回合胜利:小号角
export function win() {
  if (muted) return; const c = ctx(); if (!c) return;
  const t = c.currentTime;
  [523, 659, 784, 1046].forEach((f, i) =>
    tone(c, { type: 'triangle', f0: f, t0: t + i * 0.13, dur: i === 3 ? 0.5 : 0.16, vol: 0.4 }));
}
