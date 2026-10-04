/**
 * QQ 官方机器人 WebSocket 网关（交付物之一 —— src/adapter/qq-official/gateway.ts）
 *
 * 为什么需要它：官方机器人与 OneBot 的传输模型不同 —— OneBot 是「HTTP 反向上报」，
 * 官方是「客户端主动连网关、服务端推事件」。所以 Adapter 的 onMessage 侧不能挂在
 * HTTP 服务器上，必须有一个长连接客户端把 op 0 帧翻成 InternalMessage。
 *
 * 传输层用 **Node 24 内建的全域 WebSocket**，不引第三方 `ws`：
 * 这个项目一直是零运行时依赖（只 yaml + zod），网关这一层没必要破例。
 *
 * ── 协议状态机（实测口径，见文件末尾「实测记录」）──────────────────
 *
 *   connect ──► 收 op 10 hello（含 heartbeat_interval）
 *           ──► 发 op 2 identify（token + intents + properties）
 *           ──► 收 op 0 READY（s=1 起开始带序列号）
 *           ──► 按 heartbeat_interval 发 op 1，服务端回 op 11 ack
 *           ──► 收 op 0 DISPATCH（t = GROUP_AT_MESSAGE_CREATE 之类）
 *
 * 三个容易踩的点，这里都处理了：
 *
 *   1. **必须先收 hello 再 identify**。identify 发早了服务端会直接断开 ——
 *      不是报错，是闷声断连，日志里只能看到 close 事件。
 *   2. **心跳不发会在约 30 秒内被踢**。间隔取 hello 给的 heartbeat_interval
 *      （实测 41250ms），首跳按官方建议加随机抖动，避免集群同时重连打爆网关。
 *   3. **op 9 invalid session 不能立刻重连**。官方要求等 1—5 秒再重连，
 *      且分两种：可恢复（带 session_id + 序号走 op 6 resume）与不可恢复（重新 identify）。
 *
 * ── M2.75：关闭码要分类，不能一律重连 ─────────────────────────────
 *
 * 早先的版本对**所有** close 都做退避重连。鉴权失败（4004）、intents 无权限（4014）、
 * 机器人被下架（4914）这三类，重连一万次也不会有一次成功 ——
 * 结果是：日志被同一条错误刷满、**每次重连都消耗一次 identify 配额**（真机总配额 1500/天），
 * 而真正的病因（AppID 不对 / 权限没申请）一次都没有被报出来。
 *
 * 现在按 close code 分三档（表见 CLOSE_CODES）：
 *   · **致命** → 停止重连 + 报出中文处置建议（4004 例外，见下）
 *   · **会话作废**（4006 无效 session / 4007 无效 seq）→ 清掉 session 再连，
 *     否则重连后会带着旧 session 去 resume，平台继续回 4006，永远绕不出来
 *   · **其余** → 照旧退避重连
 *
 * 4004 单独一档：token 提前失效是常见情形，所以先作废 token 重连**一次**，
 * 仍然是 4004 才判「AppID 与 Secret 不匹配」并停下来。
 *
 * ⚠️ 表的来源要说清楚：官方文档「WebSocket 错误码」给了 code 与名称，
 * 但**没有逐个说清该 resume 还是该重新 identify**。社区实现（NousResearch/hermes-agent、
 * openclaw 的 qqbot 适配器）在这上面踩过并留下了修正记录：
 *   · 4009（会话超时）**要 resume，不要重新 identify** —— 本项目因此**不清会话**，
 *     重连后照常带 session 走 op 6 resume（resume 真失败时平台会回 4006，届时按 4006 处理）；
 *   · op 7 RECONNECT **要保留会话**（本项目早已如此，见 #onFrame）。
 * 本机真机只复现过 4004 与「正常关闭 1000/4000」，其余按文档口径登记。
 *
 * ── 实测记录（本机，2026-09-27）────────────────────────────────────
 *   GET https://api.sgroup.qq.com/websocket/（无 Upgrade 头）→ HTTP 426
 *        {"WebSocket protocol violation: Upgrade header "" does not contain websocket"}
 *   带 Upgrade 头 → HTTP 101，**未携带任何有效 token** 即收到：
 *        {"d":{"heartbeat_interval":41250},"op":10}
 *   结论：握手阶段不校验 token，鉴权发生在 identify。所以
 *   `resolveGatewayUrl` 允许取不到 REST 的 url 就直接用约定地址兜底。
 */

import type { Logger } from '../../infra/logger.ts';
import { NUMERIC } from '../../config/numeric.ts';
import type { SessionQuota } from './quota.ts';

/** 网关 opcode */
export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/**
 * 需要单独处理的三个关闭码。
 *
 * 4009（会话超时）**故意不在**这里：它的正确处理是 resume，而 resume 是默认路径 ——
 * 把它列进来反而会诱导后来人「清掉会话重新登录」，那是错的（见文件头）。
 */
export const CLOSE = {
  AUTH_FAILED: 4004,
  INVALID_SESSION: 4006,
  INVALID_SEQ: 4007,
} as const;

export interface CloseHint {
  /** 中文名（官方文档那张表的名称） */
  title: string;
  /** 重连能不能好。true = 必须先改配置/等平台，重连只是烧配额 */
  fatal: boolean;
  /** 给运营看的一句话处置建议 */
  advice: string;
}

/**
 * 关闭码 → 中文名 + 处置建议。来源与口径见文件头「M2.75」那一段。
 *
 * **不认识的码一律按可重连处理**：宁可按退避节奏多试几次，也不要在没弄清语义时
 * 把一条本来能自愈的连接停掉 —— 停掉的代价是「机器人静默不理人」，
 * 而它比多几次重连难查得多。
 */
const CLOSE_CODES: Record<number, CloseHint> = {
  4001: { title: '无效的 opcode', fatal: false, advice: '本机发了平台不认识的 opcode —— 多半是协议版本不匹配。' },
  4002: { title: '无效的 payload', fatal: false, advice: '帧格式不被接受。查 identify 的 properties 与 shard 字段。' },
  4003: { title: '未登录就发包', fatal: false, advice: 'identify 之前发了别的帧。这是客户端顺序问题：必须先收 hello 再 identify。' },
  4004: { title: '鉴权失败', fatal: true, advice: 'identify 里的 token 被拒：核对 AppID / Secret 是否配套，并确认机器人没有被下架。' },
  4005: { title: '重复 identify', fatal: false, advice: '同一条连接发了两次 identify。重连后应当走 op 6 resume。' },
  4006: { title: '无效的 session', fatal: false, advice: '会话已失效，已清掉会话，重连会重新 identify（消耗一次配额）。' },
  4007: { title: '无效的 seq', fatal: false, advice: 'resume 带的序号不对，已清掉会话，重连会重新 identify。' },
  4008: { title: '限流', fatal: false, advice: '发帧太频繁被限流，退避后再来。' },
  4009: { title: '会话超时', fatal: false, advice: '会话闲置过久被回收。按官方与社区口径应当 resume（保留会话），本项目就是这么做的。' },
  4010: { title: '无效的 shard', fatal: true, advice: 'shard 参数不合法：确认写的是 [分片号, 分片总数] 且分片号小于总数。' },
  4011: { title: '需要更多分片', fatal: true, advice: '平台要求更多分片才接得完事件 —— 单分片吃不下，要开分片。' },
  4012: { title: '无效的版本', fatal: true, advice: '网关版本不被支持。' },
  4013: { title: '无效的 intents', fatal: true, advice: 'intents 值不合法：只用官方定义的那几位（群消息 1<<25、互动 1<<26）。' },
  4014: { title: 'intents 无权限', fatal: true, advice: '用了没申请到的 intents。去开放平台把对应权限申请通过；临时可以先关掉要该权限的开关（如 QQ_BOT_BUTTONS 要 INTERACTION 位）。' },
  4900: { title: '网关内部错误', fatal: false, advice: '平台侧故障，退避重连即可。' },
  4901: { title: '分片已存在', fatal: false, advice: '同一个分片重复连接。' },
  4902: { title: '分片不存在', fatal: false, advice: '分片号超出范围。' },
  4903: { title: '会话建立失败', fatal: false, advice: '平台侧建会话失败，退避重连。' },
  4904: { title: '请求非法', fatal: false, advice: '请求不合法。' },
  4905: { title: '内部错误', fatal: false, advice: '平台侧故障，退避重连。' },
  4906: { title: '内部错误', fatal: false, advice: '平台侧故障，退避重连。' },
  4907: { title: '内部错误', fatal: false, advice: '平台侧故障，退避重连。' },
  4908: { title: '内部错误', fatal: false, advice: '平台侧故障，退避重连。' },
  4909: { title: '内部错误', fatal: false, advice: '平台侧故障，退避重连。' },
  4910: { title: '内部错误', fatal: false, advice: '平台侧故障，退避重连。' },
  4911: { title: '内部错误', fatal: false, advice: '平台侧故障，退避重连。' },
  4912: { title: '内部错误', fatal: false, advice: '平台侧故障，退避重连。' },
  4913: { title: '内部错误', fatal: false, advice: '平台侧故障，退避重连。' },
  4914: { title: '机器人已下架', fatal: true, advice: '机器人被下架了 —— 去开放平台看状态。重连再多次也不会好。' },
  4915: { title: '机器人已被封禁', fatal: true, advice: '机器人被封禁 —— 联系平台处理。' },
};

/** 查关闭码的中文含义与处置。未登记的码按「可重连」返回 */
export function closeCodeHint(code: number): CloseHint {
  return CLOSE_CODES[code] ?? {
    title: '未登记的关闭码',
    fatal: false,
    advice: '未登记的关闭码按可重连处理（不认识就继续重连，比贸然停下安全）：把 code ' + code + ' 拿去查平台文档。',
  };
}

/**
 * 群消息事件（GROUP_AT_MESSAGE_CREATE）所需的那一位。
 *
 * 官方文档叫「群聊消息 / 单聊消息」权限位。任务书要求**只加这一位**：
 * 每多要一个 intent 就多一份审核与限流风险，群消息用不到别的。
 */
export const INTENT_GROUP_AND_C2C_MESSAGE = 1 << 25; // = 33554432

/**
 * 互动事件（消息按钮回调）那一位：官方文档写的是 `INTERACTION (1 << 26)`。
 *
 * M2.44：按钮要能点、点了要有事件，就必须订阅这一位 ——
 * **不加它，按钮点下去平台什么都不推，而本地一切正常**（静默失效的典型形状）。
 */
export const INTENT_INTERACTION = 1 << 26; // = 67108864

export const DEFAULT_INTENTS = INTENT_GROUP_AND_C2C_MESSAGE;

/*
 * M2.104：两个基址常量搬到了 `src/config/qq-api.ts`（见那个文件的说明）。
 * 这里引入是为了本文件内部继续用，同时**转出**以保持对外导出不变 ——
 * `qq-official/index.ts` 仍然可以照旧 `from './gateway.ts'` 拿它们。
 */
import { API_BASE_PROD, API_BASE_SANDBOX } from '../../config/qq-api.ts';
export { API_BASE_PROD, API_BASE_SANDBOX } from '../../config/qq-api.ts';

/** 从环境变量挑基址 */
export function apiBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.QQ_BOT_SANDBOX?.trim() === '1' ? API_BASE_SANDBOX : API_BASE_PROD;
}

export interface GatewayUrlResult {
  url: string;
  /** rest = GET /gateway 拿到；rest-websocket = GET /websocket/ 拿到；fallback = 约定地址兜底 */
  source: 'rest' | 'rest-websocket' | 'fallback';
  /** REST 那一步失败时的原始响应，供排查（成功时为 null） */
  restError: string | null;
}

/**
 * 取 wss 地址。
 *
 * **实测修正（2026-09-27）**：真正的「拿网关地址」接口是 `GET /gateway`：
 *     GET https://sandbox.api.sgroup.qq.com/gateway
 *     → 200 {"url":"wss://sandbox.api.sgroup.qq.com/websocket"}
 *
 * 而 `GET /websocket/` 是 **WebSocket 端点本身**，不带 Upgrade 头去请求它会被
 * 网关（TAPISIX）挡成 `HTTP 426 WebSocket protocol violation`。
 * 早先版本只试了 `/websocket/`，于是每次都落到 fallback —— 虽然结果侥幸正确
 * （fallback 拼出来的地址恰好一样），但那是巧合，不是设计。
 * 现在按 /gateway → /websocket/ → 约定地址 三层来，并把实际来源记进日志。
 */
export async function resolveGatewayUrl(
  apiBase: string,
  token: string,
  timeoutMs = 10_000,
  /*
   * M2.76：**必须能注入 fetch**。
   *
   * 这是同一类问题在本仓库出现的第三次（前两次：#post 发消息、TokenManager 换 token）——
   * 某个函数自己在内部用全局 fetch，于是「注入进去的那个 fetch」根本管不到它。
   * 后果不是功能错，而是**测试静默地打到了真实平台**：用例照样通过（有 fallback 兜底），
   * 只是请求真的发出去了 —— 排查时看到的是平台返回的真实错误码，方向整个带偏。
   */
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayUrlResult> {
  const base = apiBase.replace(/\/+$/, '');
  const failures: string[] = [];

  for (const [path, source] of [['/gateway', 'rest'], ['/websocket/', 'rest-websocket']] as const) {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: { authorization: `QQBot ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (response.ok) {
        const parsed = text ? (JSON.parse(text) as { url?: unknown }) : null;
        if (typeof parsed?.url === 'string' && parsed.url) {
          return { url: parsed.url, source, restError: null };
        }
        failures.push(`${path} HTTP ${response.status} 但没有 url 字段`);
      } else {
        failures.push(`${path} HTTP ${response.status}：${text.slice(0, 120)}`);
      }
    } catch (error) {
      failures.push(`${path} 请求失败：${(error as Error).message}`);
    }
  }

  // 兜底：https://host -> wss://host。握手阶段不校验 token，退回不损失鉴权。
  const url = base.replace(/^http/, 'ws') + '/websocket';
  return { url, source: 'fallback', restError: failures.join(' | ') };
}

export interface GatewayOptions {
  /** 每次握手/identify 现场取 token（由 TokenManager 缓存，这里不自己存） */
  tokenProvider: () => Promise<string>;
  apiBase?: string;
  intents?: number;
  logger?: Logger;
  /** 收到 op 0 DISPATCH 时回调（t 为事件名，d 为事件体） */
    /**
   * `id` 是**事件最外层的 id**（形如 `INTERACTION_CREATE:<uuid>`），
   * 与 `d.id` **不是一回事** —— 互动事件的被动回执要的是前者。
   * M2.44 真机：拿 `d.id` 当 `event_id`，平台回「请求参数event_id无效」。
   */
  onDispatch?: (payload: { t: string; d: unknown; s: number | null; id?: string }) => void | Promise<void>;
  /** 收到 READY 时回调 */
  onReady?: (d: unknown) => void;
  /**
   * 每一帧的**原文**都先过这里。
   *
   * 存在的理由很具体：官方网关出错时常常是「闷声断开」而不是回一条错误帧，
   * 排查时唯一能贴回给开放平台的就是原始帧。联调期把它接上，
   * 配 QQ_BOT_DEBUG=1 打印全量 payload（任务 4 要的就是这个）。
   */
  onRawFrame?: (raw: string) => void;
  /** 心跳间隔的兜底值；hello 一到就按 hello 给的覆盖 */
  heartbeatIntervalMs?: number;
  /**
   * 多久收不到心跳 ACK 就判「这条连接已经僵死」（毫秒）。
   *
   * 不传就按 `hello 给的间隔 × 2.5 + 5 秒` 算（真机 41.25s ⇒ 约 108 秒）。
   * 单独列出来是为了**测试**：真机上不可能等两分钟才断言一次断线重连。
   */
  heartbeatAckTimeoutMs?: number;
  /** 断线是否自动重连（默认 true） */
  autoReconnect?: boolean;
  /** 重连退避上限（默认 30s） */
  maxReconnectDelayMs?: number;
  /** identify 的 properties 字段。纯元信息，按官方样例填即可 */
  properties?: Record<string, string>;
  shard?: [number, number];
  /**
   * 鉴权失败（close 4004）时回调。上层在这里作废 access_token，
   * 让下一次 identify 用一个新换的 token —— token 提前失效是常见情形，
   * 不做这一步的话「token 恰好失效」会被误判成「AppID 不对」而直接停连。
   */
  onAuthFailure?: () => void | Promise<void>;
  /**
   * 上次进程留下的会话（M2.76）。给了就优先 **resume 而不是 identify** ——
   * resume 不消耗 `session_start_limit` 配额，而且平台会把断线期间漏掉的事件补发回来。
   *
   * ⚠️ 它只是「一个可以试试的起点」：平台侧 session 过期时间官方没写清，
   * resume 被拒时网关会回 4006 / 4009，那时按既有分档清会话重新 identify 即可。
   * 换句话说，这个字段**永远不会**让机器人连不上。
   */
  resumeState?: { sessionId: string; seq: number | null; url: string | null } | null;
  /** 出网用的 fetch（可注入）。不传就是全局 fetch —— 但那样测试就脱不了网 */
  fetchImpl?: typeof fetch;
  /**
   * 会话配额账本（M2.76b）。给了它，配额见底时**不再发起 identify** ——
   * 重连风暴烧光当天配额之后，现象和「凭证错」一模一样，是最难查的一类停机。
   * 不传就是不管配额（老行为）。
   */
  quota?: SessionQuota;
  /** 配额见底、没有发起 identify 时的回调（上层记进 lastError 并让面板看得见） */
  onQuotaBlocked?: (info: { reason: string; waitMs: number }) => void;
  /** 会话发生变化（READY / RESUMED / 每条带序号的事件 / 会话作废）时回调，用于落盘 */
  onSession?: (state: { sessionId: string | null; seq: number | null; url: string | null }) => void;
  /**
   * 致命关闭码：**已经停止自动重连**，需要人介入。
   * 上层应当把它记进 stats/lastError 并让后台面板看得见 ——
   * 否则表现就是「机器人忽然不理人，日志里什么都没有」。
   */
  onFatal?: (info: { code: number; reason: string; title: string; advice: string }) => void;
}

export interface GatewayStats {
  hellos: number;
  identifies: number;
  /** 发过多少次 op 6 RESUME（正常情况应远少于 identifies） */
  resumes: number;
  heartbeats: number;
  heartbeatAcks: number;
  dispatches: number;
  reconnects: number;
  lastError: string | null;
  /**
   * 最近一次关闭（M2.75）。登录体检与后台面板靠它把「连不上」
   * 与「凭证错」分开 —— 这两个在玩家那边症状一模一样。
   */
  lastClose: { code: number; reason: string; at: number } | null;
  /** 因为致命关闭码而**停止重连**的次数。大于 0 就是要人介入，不是等一等能好的 */
  fatalStops: number;
  /**
   * 因为**会话配额用尽**而没有发起 identify 的次数（M2.76b）。
   * 它和 reconnects 是两件事：前者是「我们主动不连」（配额见底，连也白连），后者是「连了但断了」。
   */
  quotaBlocked: number;
  /**
   * 本次启动**靠落盘会话恢复成功**（M2.76）。
   *
   * 它回答的是一个很具体的问题：重启之后，断线期间那批漏掉的事件到底补回来了没有。
   * false + identifies 增长 = 每次重启都在重新登录（烧配额，且那段时间的消息永远收不到）。
   */
  resumedFromDisk: boolean;
}

/*
 * 心跳 ACK 超时（M2.99）。
 *
 * 官方网关用 `op 11 HEARTBEAT_ACK` 回执每一次心跳，这个机制存在的意义就是**发现半开连接**：
 * 网络中间设备静默丢弃之后 TCP 不一定会发 RST，`ws.readyState` 仍然是 OPEN ——
 * 于是表现成「心跳照发、事件一条收不到、发消息又被平台拒」（官方原文：
 * 「发送消息接口要求机器人接口需要连接到 WebSocket 上保持在线状态」）。
 * 玩家看到的是「群里私聊全都不响应」，而日志里只有一行行心跳 —— 最难查的一类停机。
 *
 * 阈值 = 间隔 × 2.5 + 5 秒余量：允许丢一次 ACK（偶发的调度抖动不该触发重连），
 * 连续静默才判死。重连走 resume，不烧 identify 配额，漏掉的事件平台会补发。
 */
const ACK_TIMEOUT_FACTOR = 2.5;
const ACK_TIMEOUT_GRACE_MS = 5_000;

interface Frame {
  op?: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
  /**
   * 事件最外层的 id（如 `INTERACTION_CREATE:<uuid>`）。
   * ⚠️ 它与 `d.id` 不同 —— 互动事件的被动回执（`event_id`）要的是**这个**。
   */
  id?: string;
}

export class QQGateway {
  #options: GatewayOptions;
  #logger: Logger | undefined;
  #ws: WebSocket | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次收到的 s，心跳要带上去；resume 也要它 */
  #seq: number | null = null;
  #sessionId: string | null = null;
  #heartbeatIntervalMs = 30_000;
  /**
   * 最近一次收到心跳 ACK（op 11）的时刻。
   *
   * ⚠️ 它是**半开连接**唯一的探针：连接被中间设备静默丢弃时 `readyState` 仍是 OPEN，
   * 只有「心跳发出去了却没人回 ACK」能说明这条连接已经不能用了。见 #beat 与 #startHeartbeat。
   */
  #lastAckAt = Date.now();
  #closing = false;
  #readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  /** 上一次握手拿到的 wss 地址（重连时优先复用） */
  #url: string | null = null;
  /** close 4004 已经重试过几次（成功 identify 后归零），见 #handleClose */
  #authRetries = 0;
  /** 外部通知会话变化（落盘用）。null = 会话已作废，盘上那份该删掉 */
  #notifySession(): void {
    this.#options.onSession?.({
      sessionId: this.#sessionId,
      seq: this.#seq,
      url: this.#url,
    });
  }

  readonly stats: GatewayStats = {
    hellos: 0,
    identifies: 0,
    resumes: 0,
    heartbeats: 0,
    heartbeatAcks: 0,
    dispatches: 0,
    reconnects: 0,
    lastError: null,
    lastClose: null,
    fatalStops: 0,
    resumedFromDisk: false,
    quotaBlocked: 0,
  };

  constructor(options: GatewayOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    /*
     * 吸收上次进程留下的会话（M2.76）。
     *
     * 注意 seq 必须是**数字**才有意义：没有 seq 就没法告诉平台「从哪一条之后补发」，
     * 那种情况下只能 identify —— 假装能 resume 只会换来一次 4007（无效 seq）。
     */
    const resume = options.resumeState ?? null;
    if (resume !== null && resume.seq !== null) {
      this.#sessionId = resume.sessionId;
      this.#seq = resume.seq;
      if (resume.url !== null) this.#url = resume.url;
      this.#logger?.info('拿到上次进程留下的会话，将优先 resume', {
        sessionId: resume.sessionId,
        seq: resume.seq,
        savedAt: null,
      });
    }
  }

  get ready(): boolean {
    return this.#readyWaiters.length === 0 && this.#sessionId !== null;
  }

  get heartbeatIntervalMs(): number {
    return this.#heartbeatIntervalMs;
  }

  /** 取 wss 地址并建立连接；resolve 只代表「socket 开了」，不代表 identify 成功 */
  async connect(): Promise<void> {
    this.#closing = false;
    const apiBase = this.#options.apiBase ?? API_BASE_PROD;
    const token = await this.#options.tokenProvider();
    let url = this.#url;
    if (!url) {
      const resolved = await resolveGatewayUrl(apiBase, token, 10_000, this.#options.fetchImpl ?? fetch);
      url = resolved.url;
      this.#url = url;
      this.#logger?.info('网关地址已获取', { url, source: resolved.source, restError: resolved.restError });
    }
    await this.#open(url);
  }

  #open(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.#ws = ws;

      ws.addEventListener('open', () => {
        settled = true;
        this.#logger?.info('网关已连接', { url });
        resolve();
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        void this.#onFrame(String((event as { data: unknown }).data));
      });

      ws.addEventListener('error', (event: Event) => {
        const message = (event as { message?: string }).message ?? 'websocket error';
        this.stats.lastError = message;
        this.#logger?.error('网关错误', { message });
        if (!settled) {
          settled = true;
          reject(new Error(`网关连接失败：${message}`));
        }
      });

      ws.addEventListener('close', (event: CloseEvent) => {
        const code = (event as { code?: number }).code ?? 0;
        const reason = (event as { reason?: string }).reason ?? '';
        this.#stopHeartbeat();
        /*
         * 只在「这仍然是我手上那条连接」时才清掉引用。
         * 重连之后旧 socket 的 close 事件可能**晚到**，那时 #ws 已经是新的了 ——
         * 无条件置 null 会把好端端的新连接丢掉，表现为「刚连上就又断了」。
         */
        if (this.#ws === ws) this.#ws = null;
        if (!settled) {
          settled = true;
          reject(new Error('网关在握手阶段断开：code=' + code + ' reason=' + reason));
        }
        void this.#handleClose(code, reason);
      });
    });
  }

  /** 等到 READY（或超时）。CLI 与联调都靠它判断「identify 成功了」 */
  waitReady(timeoutMs = 20_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#readyWaiters = this.#readyWaiters.filter((w) => w.timer !== timer);
        reject(new Error(`等待 READY 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#readyWaiters.push({ resolve, reject, timer });
    });
  }

  close(code = 1000, reason = 'client close'): void {
    this.#closing = true;
    this.#stopHeartbeat();
    for (const waiter of this.#readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('网关已关闭'));
    }
    this.#readyWaiters = [];
    this.#ws?.close(code, reason);
    this.#ws = null;
  }

  /**
   * 按关闭码决定「怎么接下去」（M2.75）。三档语义见文件头，这里只说实现要点：
   *
   *   · 会话作废的码（4006/4007）**先清会话再重连**，否则会带着死会话反复 resume；
   *   · 致命的码停止重连并回调 onFatal（4004 例外：先作废 token 重试一次）；
   *   · 其余照旧退避重连。
   */
  async #handleClose(code: number, reason: string): Promise<void> {
    const hint = closeCodeHint(code);
    this.stats.lastClose = { code, reason, at: Date.now() };
    this.#logger?.warn('网关已断开', { code, reason, title: hint.title, fatal: hint.fatal });
    if (this.#closing) return;

    if (code === CLOSE.INVALID_SESSION || code === CLOSE.INVALID_SEQ) {
      this.#sessionId = null;
      this.#seq = null;
      // 立刻把盘上那份也作废：留着它，下次重启还会拿这个死会话去 resume
      this.#notifySession();
      this.#logger?.warn('会话已作废，重连将重新 identify', { code, title: hint.title });
    }

    if (hint.fatal) {
      if (
        code === CLOSE.AUTH_FAILED &&
        this.#authRetries < NUMERIC.qqBot.authReconnectOnClose4004 &&
        this.#options.onAuthFailure
      ) {
        this.#authRetries += 1;
        this.#sessionId = null;
        this.#seq = null;
        this.#notifySession();
        this.#logger?.warn('鉴权失败：作废 token 后再连一次', { attempt: this.#authRetries });
        try {
          await this.#options.onAuthFailure();
        } catch (error) {
          // 作废 token 本身失败不阻断重连 —— 重连会用旧 token 再试一次，仍失败就判致命
          this.#logger?.warn('作废 token 时出错', { message: (error as Error).message });
        }
        if (!this.#closing) void this.#scheduleReconnect('close ' + code + ' 后重试');
        return;
      }
      this.stats.fatalStops += 1;
      this.stats.lastError = '致命关闭码 ' + code + '（' + hint.title + '）';
      this.#logger?.error('网关停止重连：这个错误重连不会好', {
        code, title: hint.title, advice: hint.advice,
      });
      this.#options.onFatal?.({ code, reason, title: hint.title, advice: hint.advice });
      return;
    }

    if (this.#options.autoReconnect !== false) {
      void this.#scheduleReconnect('close ' + code);
    }
  }

  async #scheduleReconnect(why: string): Promise<void> {
    this.stats.reconnects += 1;
    const cap = this.#options.maxReconnectDelayMs ?? 30_000;
    // 指数退避 + 抖动：网关侧故障时不要让本机变成重连风暴的一部分
    const backoff = Math.min(cap, 1000 * 2 ** Math.min(6, this.stats.reconnects - 1));
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.#logger?.info('准备重连', { why, delayMs: Math.round(delay), attempt: this.stats.reconnects });
    await new Promise((r) => setTimeout(r, delay));
    if (this.#closing) return;
    try {
      await this.connect();
    } catch (error) {
      this.stats.lastError = (error as Error).message;
      this.#logger?.error('重连失败', { message: (error as Error).message });
      if (!this.#closing && this.#options.autoReconnect !== false) {
        void this.#scheduleReconnect('重连失败');
      }
    }
  }

  async #onFrame(raw: string): Promise<void> {
    this.#options.onRawFrame?.(raw);
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      this.#logger?.warn('网关送来无法解析的帧', { head: raw.slice(0, 120) });
      return;
    }
    if (typeof frame.s === 'number') {
      this.#seq = frame.s;
      // 每条带序号的事件都通知一次；合并写由 QQSessionStore 负责（默认 500ms）
      this.#notifySession();
    }

    switch (frame.op) {
      case OP.HELLO: {
        this.stats.hellos += 1;
        const d = (frame.d ?? {}) as { heartbeat_interval?: number };
        // hello 给的间隔是权威值：写死 30s 会在官方调整后莫名其妙被踢
        if (typeof d.heartbeat_interval === 'number' && d.heartbeat_interval > 0) {
          this.#heartbeatIntervalMs = d.heartbeat_interval;
        }
        this.#logger?.info('收到 op 10 HELLO', {
          heartbeatIntervalMs: this.#heartbeatIntervalMs,
          // 手里有会话就 resume，没有才 identify —— 见 #resume 的说明
          willResume: this.#sessionId !== null && this.#seq !== null,
        });
        if (this.#sessionId !== null && this.#seq !== null) {
          await this.#resume();
        } else {
          await this.#identify();
        }
        break;
      }

      case OP.DISPATCH: {
        this.stats.dispatches += 1;
        const t = frame.t ?? '';
        if (t === 'READY') {
          const d = (frame.d ?? {}) as { session_id?: string; user?: { username?: string; id?: string } };
          this.#sessionId = d.session_id ?? null;
          // 连上了就说明凭证没问题，把 4004 的重试额度还回去
          this.#authRetries = 0;
          this.#notifySession();
          this.#logger?.info('identify 成功：收到 op 0 READY', {
            sessionId: this.#sessionId,
            botUsername: d.user?.username ?? null,
            botId: d.user?.id ?? null,
            shardInfo: (frame.d as { shard?: unknown } | null)?.shard ?? null,
          });
          this.#resolveReady();
        } else if (t === 'RESUMED') {
          // 恢复成功：断线期间漏掉的事件网关已经补发完毕
          this.#authRetries = 0;
          // 靠落盘会话恢复成功：这一轮重启既没烧配额，也没丢事件
          this.stats.resumedFromDisk = true;
          this.#notifySession();
          this.#logger?.info('会话已恢复：收到 op 0 RESUMED', {
            sessionId: this.#sessionId,
            seq: this.#seq,
          });
          this.#resolveReady();
        } else {
          this.#logger?.info('收到事件', { t, s: frame.s ?? null });
        }
        try {
          await this.#options.onDispatch?.({ t, d: frame.d, s: frame.s ?? null, id: frame.id });
        } catch (error) {
          // 业务异常不许把网关读循环带崩 —— 断连重来一遍代价远大于丢一条消息
          this.#logger?.error('事件处理回调抛错', { t, message: (error as Error).message });
        }
        if (t === 'READY') this.#options.onReady?.(frame.d);
        break;
      }

      case OP.HEARTBEAT_ACK:
        this.stats.heartbeatAcks += 1;
        // M2.99：连接活着的唯一证据 —— #beat 靠它判断是不是半开连接
        this.#lastAckAt = Date.now();
        break;

      case OP.RECONNECT: {
        /*
         * 服务端要求重连。**保留 session 与 seq** ——
         * 重连后要走 op 6 resume，让网关把断线期间漏掉的事件补发回来。
         *
         * 早先这里把 session 清成 null，重连就等价于「重新登录」：
         * 漏掉的事件永远补不回来（对聊天机器人 = 玩家消息凭空消失），
         * 而且每重连一次就消耗一次 session_start_limit 配额。
         */
        this.#logger?.warn('收到 op 7 要求重连（保留会话，稍后 resume）');
        this.#ws?.close(4000, 'server requested reconnect');
        break;
      }

      case OP.INVALID_SESSION: {
        /*
         * op 9 的 d 是布尔值：
         *   d === true  → 会话仍在，可以 resume
         *   d === false → 会话已失效，必须重新 identify
         *
         * 早先无视 d 一律清掉 session，于是「可恢复」那一半也被当成
         * 「重新登录」处理，白白丢掉补发机会与配额。
         */
        const resumable = frame.d === true;
        this.#logger?.warn('收到 op 9 invalid session', { resumable });
        if (!resumable) {
          this.#sessionId = null;
          this.#seq = null;
        }
        // 官方要求等 1—5 秒再重连，立刻重连会被再次拒绝
        const waitMs = 1000 + Math.floor(Math.random() * 4000);
        this.#ws?.close(4000, 'invalid session');
        await new Promise((r) => setTimeout(r, waitMs));
        break;
      }

      default:
        this.#logger?.info('收到未处理的 opcode', { op: frame.op });
    }
  }

  async #identify(): Promise<void> {
    /*
     * M2.76b：**配额闸门**。
     *
     * identify 是唯一消耗 `session_start_limit` 的动作（resume 不消耗）。
     * 所以重连风暴的代价是「把当天剩下的额度烧光」，而烧光之后的现象是「连不上」——
     * 与「凭证错」几乎无法区分。
     *
     * 这里的选择是：**确知没额度了就不再连**。什么都不做，比以退避节奏反复试更接近恢复 ——
     * 额度不会因为我们多试几次而回来。恢复路径有两条：
     *   · 等平台重置（reset_after，通常按天）；
     *   · 重启进程（重启会优先 resume，而 **resume 不消耗配额** —— 见会话落盘那一节）。
     */
    const quota = this.#options.quota;
    if (quota) {
      const decision = quota.canStartSession();
      if (!decision.ok) {
        this.stats.quotaBlocked += 1;
        this.stats.lastError = decision.reason;
        this.#logger?.error('会话配额已用尽：不发起 identify（连也白连，还会把日志刷满）', {
          reason: decision.reason,
          waitMs: decision.waitMs,
          hint: '等配额重置，或重启进程 —— 重启会优先 resume，而 resume 不消耗配额',
        });
        this.#options.onQuotaBlocked?.({ reason: decision.reason ?? '', waitMs: decision.waitMs });
        this.close(4000, 'session quota exhausted');
        return;
      }
      // 乐观扣减：两次查询之间平台的真实余量只能自己记。宁可扣多（早停）不可扣少（烧光）
      quota.noteIdentify();
    }

    const token = await this.#options.tokenProvider();
    const payload = {
      op: OP.IDENTIFY,
      d: {
        // 官方要求带 "QQBot " 前缀
        token: `QQBot ${token}`,
        intents: this.#options.intents ?? DEFAULT_INTENTS,
        shard: this.#options.shard ?? [0, 1],
        properties: this.#options.properties ?? { $os: 'linux', $browser: 'node', $device: 'node' },
      },
    };
    this.stats.identifies += 1;
    this.#send(payload);
    this.#logger?.info('已发送 op 2 IDENTIFY', {
      intents: payload.d.intents,
      shard: payload.d.shard,
      // 只打脱敏后的长度信息，绝不落 token 明文
      tokenLen: payload.d.token.length,
    });
    this.#startHeartbeat();
  }

  /**
   * op 6 Resume：断线重连后恢复会话。
   *
   * 官方文档（事件订阅与通知 → 恢复登录态 Session）原话：
   *   「断开重连 gateway 后**不需要**发送重新登录 Opcode 2 Identify 请求。
   *     在连接到 Gateway 之后，需要发送 Opcode 6 Resume 消息」
   * 恢复成功后网关会**补发** seq 之后漏掉的事件，补完下发一个 RESUMED 事件。
   *
   * 为什么必须做：不做则每次断线重连都等于重新登录 ——
   * 断线期间的事件永远补不回来，而且每重连一次消耗一次 session 配额
   * （`GET /gateway/bot` 返回的 session_start_limit.remaining 就是它；
   *   本机实测已从 1500 掉到 1494，全是重连烧掉的）。
   */
  async #resume(): Promise<void> {
    if (this.#sessionId === null || this.#seq === null) {
      await this.#identify();
      return;
    }
    const token = await this.#options.tokenProvider();
    this.stats.resumes += 1;
    this.#send({
      op: OP.RESUME,
      d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#seq },
    });
    this.#logger?.info('已发送 op 6 RESUME', {
      sessionId: this.#sessionId,
      seq: this.#seq,
      tokenLen: token.length + 6,
    });
    // resume 同样要恢复心跳：网关只认「有没有按时心跳」，不关心会话是 identify 还是 resume 换来的
    this.#startHeartbeat();
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    /*
     * 新一轮心跳（identify / resume 之后）重新开始计时。
     * 不重置的话，上一段连接静默的那几十秒会被算到这一轮头上，刚连上就判僵死。
     */
    this.#lastAckAt = Date.now();
    const interval = this.#heartbeatIntervalMs;
    // 首跳加抖动：官方文档建议，避免大批客户端在整点同时打网关
    const firstDelay = Math.floor(interval * (0.3 + Math.random() * 0.4));
    this.#firstBeatTimer = setTimeout(() => {
      this.#beat();
      this.#heartbeatTimer = setInterval(() => this.#beat(), interval);
    }, firstDelay);
    this.#logger?.info('心跳已启动', { intervalMs: interval, firstDelayMs: firstDelay });
  }

  #stopHeartbeat(): void {
    if (this.#firstBeatTimer) clearTimeout(this.#firstBeatTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#firstBeatTimer = null;
    this.#heartbeatTimer = null;
  }

  /** 心跳 ACK 的超时阈值：显式配置优先，否则按 hello 给的间隔算（见 #beat 的说明） */
  #ackTimeoutMs(): number {
    return (
      this.#options.heartbeatAckTimeoutMs ??
      Math.round(this.#heartbeatIntervalMs * ACK_TIMEOUT_FACTOR) + ACK_TIMEOUT_GRACE_MS
    );
  }

  #beat(): void {
    /*
     * ⚠️ M2.99：**先看上一轮心跳有没有被 ACK，再决定要不要发这一轮。**
     *
     * 详见文件里 ACK_TIMEOUT_FACTOR 那一段：半开连接不会自己好 ——
     * readyState 还是 OPEN，事件收不到，消息也发不出，而日志里只有心跳。
     * 没有这一步，机器人会一直「假装在线」，直到有人手工重启。
     */
    const sinceAck = Date.now() - this.#lastAckAt;
    const limit = this.#ackTimeoutMs();
    if (sinceAck > limit) {
      this.stats.lastError =
        '心跳 ' + Math.round(sinceAck / 1000) + ' 秒没有收到 ACK（阈值 ' + Math.round(limit / 1000) +
        ' 秒），判定连接已僵死，强制重连';
      this.#logger?.warn('心跳长期没有 ACK，判定连接已僵死 —— 强制重连', {
        sinceLastAckMs: sinceAck,
        limitMs: limit,
        intervalMs: this.#heartbeatIntervalMs,
        note: '半开连接不会自己好：readyState 仍是 OPEN，但事件收不到、消息也发不出',
      });
      /*
       * 走既有的关闭路径（#handleClose → 退避重连），**保留 session 与 seq** ——
       * 重连时 op 6 resume：不烧 identify 配额，断线期间漏掉的事件平台会补发。
       * code 4000 与 op 7「服务端要求重连」同档，不在致命关闭码那张表里。
       */
      this.#ws?.close(4000, 'heartbeat ack timeout');
      return;
    }
    this.stats.heartbeats += 1;
    // d 带最近一次序号（没有就是 null）—— 这是服务端判断「你有没有漏帧」的依据
    this.#send({ op: OP.HEARTBEAT, d: this.#seq });
  }

  #send(payload: unknown): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      this.#logger?.warn('想发包但连接不是 OPEN，已丢弃', { readyState: ws?.readyState ?? -1 });
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  #resolveReady(): void {
    for (const waiter of this.#readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.#readyWaiters = [];
  }
}
