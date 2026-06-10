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

// 返回归一化移动向量 [x, y],没按键时是 [0, 0]
export function moveVector() {
  const x = keys.r - keys.l, y = keys.d - keys.u;
  const m = Math.hypot(x, y);
  return m ? [x / m, y / m] : [0, 0];
}

// 把屏幕坐标换算成画布内坐标(画布被 CSS 缩放过)
function canvasPos(cv, ev) {
  const r = cv.getBoundingClientRect();
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

  // 触屏开炮按钮(点按一次开一炮,冷却由 main 控制)
  const fb = document.getElementById('btnFire');
  if (fb) fb.addEventListener('pointerdown', (e) => {
    e.preventDefault(); focused = true;
    if (fireFn) fireFn();
  });
}
