// ============================================================
// input.js — 输入层:键盘 / 鼠标 / 触屏按钮 → 统一输入状态
// 其他模块只读 moveVector() 和 mouse,不关心输入来自哪里
// ============================================================

const keys = { u: 0, d: 0, l: 0, r: 0 };
export const mouse = { x: 312, y: 264 };
export let focused = false;   // 画布是否已获得键盘焦点

// 开炮回调:由 main.js 注册,输入层只负责"什么时候想开炮"
let fireFn = null;
export function onFire(fn) { fireFn = fn; }

const KM = {
  ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
  ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r',
};

// 虚拟摇杆状态(手机用;x/y 为 -1..1 的模拟量)
const joy  = { active: false, id: null, cx: 0, cy: 0, x: 0, y: 0 };   // 左:移动
const joyA = { active: false, id: null, cx: 0, cy: 0, x: 0, y: 0 };   // 右:瞄准+连射

// 射击摇杆方向(没在推时返回 null)
export function aimVector() {
  if (!joyA.active) return null;
  const m = Math.hypot(joyA.x, joyA.y);
  return m > 0.25 ? [joyA.x, joyA.y] : null;   // 死区大一点,防误触乱射
}

// 返回移动向量 [x, y](模长 0..1):摇杆优先,否则键盘(归一化)
export function moveVector() {
  if (joy.active) {
    const m = Math.hypot(joy.x, joy.y);
    return m > 0.14 ? [joy.x, joy.y] : [0, 0];   // 小死区防漂移
  }
  const x = keys.r - keys.l, y = keys.d - keys.u;
  const m = Math.hypot(x, y);
  return m ? [x / m, y / m] : [0, 0];
}

// 强制横屏旋转标志:画面转了 90° 但触摸坐标不会跟着转,
// 所以瞄准和摇杆都要做反向旋转换算(由 main 的布局逻辑设置)
let rotated = false;
export function setRotated(v) { rotated = v; }

// 把屏幕坐标换算成画布内坐标(画布被 CSS 缩放过;旋转模式下轴互换)
function canvasPos(cv, ev) {
  const r = cv.getBoundingClientRect();
  if (rotated) {
    // 容器顺时针转了 90°:画布 x 轴 = 屏幕向下,画布 y 轴 = 屏幕向左
    return [
      (ev.clientY - r.top)  * cv.width  / r.height,
      (r.right - ev.clientX) * cv.height / r.width,
    ];
  }
  return [
    (ev.clientX - r.left) * cv.width  / r.width,
    (ev.clientY - r.top)  * cv.height / r.height,
  ];
}

export function initInput(cv) {
  cv.addEventListener('pointermove', (ev) => {
    const [x, y] = canvasPos(cv, ev);
    mouse.x = x; mouse.y = y;
  });

  // 点击画布 = 开炮(顺便抓键盘焦点)
  cv.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    cv.focus();
    focused = true;
    const [x, y] = canvasPos(cv, ev);
    mouse.x = x; mouse.y = y;
    if (fireFn) fireFn();
  });

  const onKD = (e) => {
    if (KM[e.code]) { keys[KM[e.code]] = 1; e.preventDefault(); }
    if (e.code === 'Space') { e.preventDefault(); if (fireFn) fireFn(); }
  };
  const onKU = (e) => { if (KM[e.code]) keys[KM[e.code]] = 0; };
  window.addEventListener('keydown', onKD);
  window.addEventListener('keyup', onKU);

  // 触屏方向键(长按)
  const hold = (id, k) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); focused = true; keys[k] = 1; });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel'])
      b.addEventListener(ev, () => { keys[k] = 0; });
  };
  hold('btnUp', 'u'); hold('btnDown', 'd'); hold('btnLeft', 'l'); hold('btnRight', 'r');

  // 触屏开炮按钮(兼容旧版按钮 id;现在主力是右摇杆)
  const fb = document.getElementById('btnFire');
  if (fb) fb.addEventListener('pointerdown', (e) => {
    e.preventDefault(); focused = true;
    if (fireFn) fireFn();
  });

  // ---------- 虚拟摇杆(通用) ----------
  // setPointerCapture 把那根手指绑死在各自摇杆上,
  // 左手移动 + 右手射击同时操作互不干扰
  const makeStick = (stickId, knobId, state) => {
    const st = document.getElementById(stickId);
    const knob = document.getElementById(knobId);
    if (!st || !knob) return;
    const R = 42;   // 摇杆最大行程 px
    const setKnob = () =>
      knob.style.transform = `translate(calc(-50% + ${state.x * R}px), calc(-50% + ${state.y * R}px))`;
    const track = (e) => {
      if (!state.active || e.pointerId !== state.id) return;
      // 屏幕方向 → 游戏方向(旋转模式下手指向下 = 游戏向右)
      const sx = (e.clientX - state.cx) / R, sy = (e.clientY - state.cy) / R;
      const dx = rotated ? sy : sx;
      const dy = rotated ? -sx : sy;
      const m = Math.hypot(dx, dy);
      const k = Math.min(1, m) / (m || 1);
      state.x = dx * k; state.y = dy * k;
      setKnob();
    };
    st.addEventListener('pointerdown', (e) => {
      e.preventDefault(); focused = true;
      state.active = true; state.id = e.pointerId;
      const r = st.getBoundingClientRect();
      state.cx = r.left + r.width / 2; state.cy = r.top + r.height / 2;
      st.setPointerCapture(e.pointerId);
      track(e);
    });
    st.addEventListener('pointermove', track);
    const end = (e) => {
      if (e.pointerId !== state.id) return;
      state.active = false; state.x = state.y = 0;
      knob.style.transform = 'translate(-50%,-50%)';
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);
    st.addEventListener('contextmenu', (e) => e.preventDefault());
  };
  makeStick('stick', 'knob', joy);            // 左:移动
  makeStick('stickFire', 'knobFire', joyA);   // 右:瞄准+连射

  // 长按画布不要弹出系统菜单/选中
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
}
