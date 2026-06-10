// ============================================================
// net.js — 网络层:封装 Supabase Realtime
// 职责:进房间、收发广播消息、维护在线名单(presence)
// 游戏逻辑完全不出现在这个文件里
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// 我的全局唯一 ID(每次刷新页面都是新的,M1 不做断线重连)
export const myId = crypto.randomUUID();

let supabase = null;
let channel  = null;
const handlers = {};   // 事件名 → 回调函数

// 注册消息处理器,例如 on('st', p => {...})
export function on(event, fn) { handlers[event] = fn; }

// 进入房间:订阅 channel + 上报 presence
export async function join(roomId, name) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  channel = supabase.channel('tank:' + roomId, {
    config: {
      broadcast: { self: false },   // 自己发的消息不回传给自己
      presence:  { key: myId },     // presence 名单用 myId 做 key
    },
  });

  // 把所有 broadcast 事件路由到 handlers
  // 'st' 状态同步 | 'fi' 开炮 | 'ht' 命中(受害者权威)
  // 'bx' 房主刷箱 | 'bxs' 房主全量同步箱子 | 'pk' 拾取认领 | 'rw' 回合结束(房主权威)
  for (const ev of ['st', 'fi', 'ht', 'bx', 'bxs', 'pk', 'rw']) {
    channel.on('broadcast', { event: ev }, ({ payload }) => {
      if (handlers[ev]) handlers[ev](payload);
    });
  }

  // presence 同步:任何人进出房间都会触发,拿到完整在线名单
  channel.on('presence', { event: 'sync' }, () => {
    if (handlers.presence) handlers.presence(channel.presenceState());
  });

  // 订阅并等待成功;失败时抛错让 UI 提示
  await new Promise((resolve, reject) => {
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        // 上报自己的信息;joinedAt 用于按加入顺序分配颜色和将来的房主选举
        await channel.track({ name, joinedAt: Date.now() });
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        reject(new Error('连接失败: ' + status + '(检查 config.js 里的 URL 和 key)'));
      }
    });
  });
}

// 广播一条消息给房间里的其他人
export function send(event, payload) {
  if (channel) channel.send({ type: 'broadcast', event, payload });
}

// 离开房间(M1 暂未用到,页面关闭时 Supabase 会自动清理 presence)
export async function leave() {
  if (channel) await channel.unsubscribe();
  channel = null;
}
