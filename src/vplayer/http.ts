/**
 * 虚拟玩家的 HTTP 通道（W7）：所有游戏行为都走真实 HTTP，不直接调纯函数。
 *   - 指令上报：POST /onebot/event
 *   - 时间控制：POST /admin/clock（测试专用端点，让同一 seed 完全可复现）
 *   - 出站消息：由假 OneBot API 接收，按收件人分发到各玩家的收件箱
 */
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

export interface OutboundMessage {
  path: string;
  targetId: string;
  text: string;
  at: number;
}

export interface FakeInbox {
  port: number;
  server: Server;
  /** 取出某个收件人的所有私聊消息（群聊消息单独统计） */
  drainPrivate(userId: string): OutboundMessage[];
  /**
   * 只取出群聊回执，**私聊留在队列里**。
   * 曾经的写法是 drainAll() 再把群聊筛出来——那会把别人发给其他玩家的私聊一起吃掉，
   * 交易邀请因此永远送不到买家手上（W7 第一轮 175 笔交易 0 次确认就是这么来的）。
   */
  drainGroup(): OutboundMessage[];
  /** 取出全部消息（用于覆盖率统计） */
  drainAll(): OutboundMessage[];
  /**
   * 等到出站消息"排空"再取件。
   *
   * 服务端发私聊回执是异步的（handler 写完库就先返回 HTTP 响应，消息随后才 POST 到假 API）。
   * CLI 若在响应返回后立刻 drain，就会**漏读拒绝回执** —— 于是「被冷却挡回」的指令
   * 被当成「执行了但状态没变」，误报成卡死（W8 并行跑时 P1 从 0 涨到 109 条就是这个竞态）。
   *
   * 实现：连续 quietTicks 次轮询都看不到新消息就算排空；最多等 maxMs 毫秒兜底。
   */
  flush(options?: { quietTicks?: number; maxMs?: number }): Promise<void>;
  groupMessages: number;
  close(): Promise<void>;
}

/** 轮询间隔：1ms 足够（同机 loopback），再长就拖慢 20 万条动作的长跑 */
const FLUSH_POLL_MS = 1;
const FLUSH_QUIET_TICKS = 3;
const FLUSH_MAX_MS = 50;

async function waitForQuiet(countFn: () => number, options?: { quietTicks?: number; maxMs?: number }): Promise<void> {
  const quietTicks = options?.quietTicks ?? FLUSH_QUIET_TICKS;
  const maxMs = options?.maxMs ?? FLUSH_MAX_MS;
  const deadline = Date.now() + maxMs;
  let last = countFn();
  let stable = 0;
  while (stable < quietTicks && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, FLUSH_POLL_MS));
    const current = countFn();
    stable = current === last ? stable + 1 : 0;
    last = current;
  }
}

/** 每个收件人最多留多少条私聊：留太多既没用又吃内存（跑完的玩家不会再来取） */
const PRIVATE_BUCKET_LIMIT = 200;

function pushCapped(bucket: Map<string, OutboundMessage[]>, key: string, message: OutboundMessage): void {
  const list = bucket.get(key) ?? [];
  list.push(message);
  if (list.length > PRIVATE_BUCKET_LIMIT) list.splice(0, list.length - PRIVATE_BUCKET_LIMIT);
  bucket.set(key, list);
}

/**
 * 假 OneBot API：收走机器人发出去的消息，并按收件人分发。
 *
 * 结构上是「私聊按收件人分桶 + 群聊一条队列」：
 *   - 私聊必须留到收件人来取（交易邀请就是这么送到买家手上的）；
 *   - 群聊由出招的玩家顺手取走，不占内存。
 */
export async function startInbox(port = 0): Promise<FakeInbox> {
  const privateMessages = new Map<string, OutboundMessage[]>();
  let groups: OutboundMessage[] = [];
  let groupMessages = 0;
  /** 累计收到的出站消息数（只增）：flush 用它判断"还在不在来消息" */
  let receivedTotal = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const action = (req.url ?? '').replace(/^\//, '');
      const text = String(body.message ?? '');
      receivedTotal += 1;
      if (action === 'send_private_msg') {
        pushCapped(privateMessages, String(body.user_id ?? ''), {
          path: action,
          targetId: String(body.user_id ?? ''),
          text,
          at: Date.now(),
        });
      } else if (action === 'send_group_msg' || action === 'send_guild_channel_msg') {
        groupMessages += 1;
        groups.push({
          path: action,
          targetId: String(body.group_id ?? body.channel_id ?? ''),
          text,
          at: Date.now(),
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0 }));
    });
  });
  server.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const boundPort = (server.address() as AddressInfo).port;

  return {
    port: boundPort,
    server,
    get groupMessages(): number {
      return groupMessages;
    },
    drainPrivate: (userId) => {
      const list = privateMessages.get(userId) ?? [];
      privateMessages.set(userId, []);
      return list;
    },
    drainGroup: () => {
      const taken = groups;
      groups = [];
      return taken;
    },
    drainAll: () => {
      const taken = [...groups];
      for (const list of privateMessages.values()) taken.push(...list);
      privateMessages.clear();
      groups = [];
      return taken;
    },
    flush: (options) => waitForQuiet(() => receivedTotal, options),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * 把压测 harness 的假 OneBot API 包装成收件箱。
 * 服务端只有一个 ONEBOT_API_BASE，所以必须复用同一个假 API，不能再起第二个。
 */
export function harnessInbox(onebot: {
  port: number;
  server: Server;
  received: Array<{ path: string; body: Record<string, unknown>; at: number }>;
}): FakeInbox {
  const privateMessages = new Map<string, OutboundMessage[]>();
  let groups: OutboundMessage[] = [];
  let groupCount = 0;
  /**
   * 游标增量归类：每条出站消息**只被处理一次**。
   * 不能用「每次 drain 都全量扫一遍 received」——私聊要留到收件人来取，
   * 数组会越堆越长，200 人 × 7 天就是每步 O(n)、整体 O(n²)，直接跑成假死。
   */
  let cursor = 0;
  const ingest = (): void => {
    const received = onebot.received;
    for (; cursor < received.length; cursor += 1) {
      const entry = received[cursor]!;
      const message: OutboundMessage = {
        path: entry.path,
        targetId: String(entry.body.user_id ?? entry.body.group_id ?? entry.body.channel_id ?? ''),
        text: String(entry.body.message ?? ''),
        at: entry.at,
      };
      if (entry.path === 'send_private_msg') {
        pushCapped(privateMessages, String(entry.body.user_id ?? ''), message);
      } else {
        groups.push(message);
        groupCount += 1;
      }
    }
  };

  return {
    port: onebot.port,
    server: onebot.server,
    get groupMessages(): number {
      ingest();
      return groupCount;
    },
    drainPrivate: (userId) => {
      ingest();
      const list = privateMessages.get(userId) ?? [];
      privateMessages.set(userId, []);
      return list;
    },
    drainGroup: () => {
      ingest();
      const taken = groups;
      groups = [];
      return taken;
    },
    drainAll: () => {
      ingest();
      const taken = [...groups];
      for (const list of privateMessages.values()) taken.push(...list);
      privateMessages.clear();
      groups = [];
      return taken;
    },
    // 假 API 的 received 只增不减（我们从不移除元素），所以「长度不再变化」就是排空
    flush: (options) => waitForQuiet(() => onebot.received.length, options),
    close: async () => {
      /* 由 harness 负责关闭 */
    },
  };
}

/**
 * 群聊台账（方案 C）：虚拟玩家原来只 drain 私聊，读不到群里的组队公告。
 *
 * 服务端的公告是这样的（src/router/commands/party.ts）：
 *   【稳健者0】创建了队伍 307798。
 * 队号就在里头，而 `.队伍 加入 <队号>` 是合法用法 —— 所以「读到群消息就能加入」
 * 这条链路本来就是通的，缺的只是虚拟玩家去读。
 *
 * 只登记「创建了队伍 X」：解散/离开的公告不带队号（【X】解散了队伍。），
 * 所以靠 TTL + 加入失败自然淘汰，不猜。
 */
export interface GroupChatLog {
  /** 从一批群消息里登记队伍公告（now 用**虚拟时间**，保证同 seed 可复现） */
  ingest(messages: readonly OutboundMessage[], now: number): void;
  /** 还没过期的队伍 id（最近公告的在前） */
  openParties(now: number): string[];
  /** 划掉一个队（加入时发现已解散 / 已满 / 不存在）——真人也是这么学会的 */
  close(id: string): void;
  size(): number;
}

/** 公告有效期：48 小时虚拟时间（玩家一天上线 1—4 次，过期太久会去打已经散了的队） */
export const PARTY_ANNOUNCE_TTL_MS = 48 * 60 * 60 * 1000;

export function createGroupChatLog(options: { ttlMs?: number } = {}): GroupChatLog {
  const parties = new Map<string, number>();
  const ttl = options.ttlMs ?? PARTY_ANNOUNCE_TTL_MS;
  return {
    ingest: (messages, now) => {
      for (const message of messages) {
        const matched = /创建了队伍\s*([0-9A-Za-z]{4,12})/.exec(message.text);
        const id = matched?.[1];
        if (id) parties.set(id.toUpperCase(), now);
      }
    },
    openParties: (now) => {
      const live: Array<{ id: string; at: number }> = [];
      for (const [id, at] of [...parties.entries()]) {
        if (now - at > ttl) parties.delete(id);
        else live.push({ id, at });
      }
      return live.sort((a, b) => b.at - a.at).map((entry) => entry.id);
    },
    close: (id) => {
      parties.delete(id.toUpperCase());
    },
    size: () => parties.size,
  };
}

/**
 * 加入失败时「这个队不要再试了」的判据（服务端话术，见 src/domain/party/party.ts）。
 * 注意不含「你已经在一个队伍里」——那是我方状态问题，不该把队划掉。
 */
export const PARTY_GONE_PATTERN = /解散|已满|找不到这个队伍/;

export interface SendCommandResult {
  status: number;
  costMs: number;
  error?: string;
}

/** M2.3：服务端菜单的结构化快照（/admin/menu 的返回体） */
export interface MenuSnapshot {
  menuType: string;
  title?: string;
  options: Array<{ key: string; label: string; command: string; preview?: string; disabled?: string }>;
}

/** 回执里出现这句 = 服务端刚给了一份菜单 */
export const MENU_MARKER = '回复数字。';

/**
 * M2.4：群里的世界播报抬头（domain/world/events.ts 的 headline 生成的就是它）。
 * 虚拟玩家在群里读到它就说明「世界说话了」——下一步去拉那张世界事件菜单，回数字参与。
 */
export const WORLD_EVENT_MARKER = '【世界 ·';

export interface HttpOptions {
  baseUrl: string;
  token: string;
}

export class PlayerHttp {
  #baseUrl: string;
  #token: string;

  constructor(options: HttpOptions) {
    this.#baseUrl = options.baseUrl;
    this.#token = options.token;
  }

  /**
   * 固定服务端虚拟时钟（同一 seed 复现的关键）。
   * 返回 false = 目标服务没开 ALLOW_CLOCK_CONTROL：这时跑出来的结果不可复现，
   * 调用方必须中止，而不是"跑完再说"。
   */
  async pinClock(nowMs: number): Promise<boolean> {
    const response = await fetch(`${this.#baseUrl}/admin/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': this.#token },
      body: JSON.stringify({ now: nowMs }),
    });
    return response.ok;
  }

  /**
   * M2.3：取服务端此刻挂着的菜单（结构化）。
   * 返回 null = 没有菜单（过期 / 从未开过 / 群里发的指令）。
   */
  async menu(userId: string): Promise<MenuSnapshot | null> {
    try {
      const response = await fetch(`${this.#baseUrl}/admin/menu`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': this.#token },
        body: JSON.stringify({ userId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { menu?: MenuSnapshot | null };
      return payload.menu ?? null;
    } catch {
      return null;
    }
  }

  async tick(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.#baseUrl}/admin/tick`, {
      method: 'POST',
      headers: { 'x-admin-token': this.#token },
    });
    return (await response.json()) as Record<string, unknown>;
  }

  async health(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.#baseUrl}/health`);
    return (await response.json()) as Record<string, unknown>;
  }

  /** 发一条指令，返回 HTTP 状态与端到端耗时 */
  async send(input: {
    messageId: string;
    userId: string;
    rawText: string;
    scene: 'private' | 'group';
    sceneId?: string;
    nickname?: string;
  }): Promise<SendCommandResult> {
    const started = performance.now();
    const event =
      input.scene === 'group'
        ? {
            post_type: 'message',
            message_type: 'group',
            message_id: input.messageId,
            user_id: Number(input.userId),
            group_id: Number(input.sceneId ?? '10001'),
            raw_message: input.rawText,
            time: Math.floor(Date.now() / 1000),
            sender: { card: input.nickname ?? input.userId },
          }
        : {
            post_type: 'message',
            message_type: 'private',
            message_id: input.messageId,
            user_id: Number(input.userId),
            raw_message: input.rawText,
            time: Math.floor(Date.now() / 1000),
            sender: { nickname: input.nickname ?? input.userId },
          };
    try {
      const response = await fetch(`${this.#baseUrl}/onebot/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(15_000),
      });
      const costMs = performance.now() - started;
      await response.text();
      return { status: response.status, costMs };
    } catch (error) {
      return { status: 0, costMs: performance.now() - started, error: (error as Error).message };
    }
  }
}
