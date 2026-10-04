/**
 * OneBot v11 **正向 WebSocket** 通道（M2.77）
 *
 * ## 它补的是哪一块
 *
 * 在此之前本仓库接 OneBot 只有一条路：**反向 HTTP 上报 + HTTP API 调用**（\`onebot.ts\`）。
 * 那条路要求用户同时配两样东西 —— 把协议端的「上报地址」指到本机、再把本机的
 * 「API 基址」指向协议端。两头都要填对，错一头就是「机器人不理人」，
 * 而且本机还必须对协议端暴露一个 HTTP 端口。
 *
 * 这一层是**内置的 OneBot 连接**：游戏自己连协议端（NapCat / LLOneBot / Lagrange 的
 * 「正向 WebSocket 服务器」），事件从这条连接进来、发送也从这条连接出去。
 * 用户只需要填一个地址：
 *
 *     ONEBOT_WS_URL=ws://127.0.0.1:3001
 *
 * ## 三条边界，先说清楚
 *
 * 1. **内置的是连接层，不是 QQ 协议本身。** QQ NT 的协议实现必须由协议端提供
 *    （NapCat 等要驱动 QQ 客户端本体）。本仓库不内置、也不可能内置那部分。
 *    「内置 OneBot」的准确含义是：**用户不用再自己搭 OneBot 桥接与两套地址**。
 * 2. **传输用 Node 内建的全域 WebSocket**，不引 \`ws\` 之类的库（项目一直是零运行时依赖）。
 * 3. ⚠️ **内建 WebSocket 不能自定义请求头** —— 这是标准 API 的限制（undici 同样遵守）。
 *    所以 \`access_token\` 只能走 **query 参数**（\`?access_token=xxx\`），
 *    而 NapCat / LLOneBot 都支持这种写法。头鉴权那条路留给 HTTP 上报模式。
 *
 * ## 与官方通道的关系
 *
 * 两条通道是对等的：同一个 \`Adapter\` 接口、同一个 router、同一套判定。
 * 选哪条由 \`ADAPTER=onebot|qq\` 决定；本文件让 onebot 这一侧也有**连接管理、重连、
 * 鉴权、心跳与状态统计**，而不是把这些问题留给用户。
 */
import type { Logger } from '../infra/logger.ts';
import { NUMERIC } from '../config/numeric.ts';
import { OneBotAdapter, mapOneBotEvent, type HttpPost, type OneBotConfig } from './onebot.ts';

export interface OneBotWsConfig {
  /** 协议端的正向 WebSocket 地址，例如 ws://127.0.0.1:3001 */
  url: string;
  accessToken?: string;
  logger?: Logger;
  /** 单次 API 调用的超时（毫秒），默认取 NUMERIC.onebot.apiTimeoutMs */
  timeoutMs?: number;
  /** 断线是否自动重连（默认 true） */
  autoReconnect?: boolean;
}

export interface OneBotWsStats {
  connected: boolean;
  connects: number;
  disconnects: number;
  reconnects: number;
  /** 收到的消息事件数 */
  events: number;
  /** meta_event 心跳数（它是「协议端还活着」的唯一证据） */
  heartbeats: number;
  /** 生命周期事件数（connect / enable / disable） */
  lifecycles: number;
  apiCalls: number;
  apiErrors: number;
  lastError: string | null;
  /** 机器人自己的账号（get_login_info 拿到的）——「连上了但连错号」只有这里看得出来 */
  selfId: string | null;
  nickname: string | null;
  lastClose: { code: number; reason: string; at: number } | null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * OneBot 正向 WS 的传输层。
 *
 * 它做四件事：连上去（带 token）、把事件交出来、把 action 发出去并等 echo 回执、断了自动重连。
 * **它不认识本项目的任何业务概念** —— 事件映射与发送构造都在 \`onebot.ts\` 里，
 * 这一层只负责「一条能用的连接」。
 */
export class OneBotWsTransport {
  #config: OneBotWsConfig;
  #logger: Logger | undefined;
  #ws: WebSocket | null = null;
  #closing = false;
  #echo = 0;
  #pending = new Map<string, Pending>();
  #handler: ((payload: unknown) => void | Promise<void>) | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 等连接的调用方（发送时连接还没建立就等一会儿，而不是直接失败） */
  #readyWaiters: Array<() => void> = [];

  readonly stats: OneBotWsStats = {
    connected: false,
    connects: 0,
    disconnects: 0,
    reconnects: 0,
    events: 0,
    heartbeats: 0,
    lifecycles: 0,
    apiCalls: 0,
    apiErrors: 0,
    lastError: null,
    selfId: null,
    nickname: null,
    lastClose: null,
  };

  constructor(config: OneBotWsConfig) {
    this.#config = config;
    this.#logger = config.logger;
  }

  get url(): string {
    return this.#config.url;
  }

  onEvent(handler: (payload: unknown) => void | Promise<void>): void {
    this.#handler = handler;
  }

  /**
   * 连上协议端。resolve 只代表 socket 开了，不代表协议端已经就绪 ——
   * 「就绪」的证据是第一条 meta_event（见 #onFrame 的第二类帧）。
   */
  async connect(): Promise<void> {
    this.#closing = false;
    const url = this.#withToken(this.#config.url);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.#ws = ws;

      ws.addEventListener('open', () => {
        settled = true;
        this.stats.connected = true;
        this.stats.connects += 1;
        this.#logger?.info('OneBot 正向 WS 已连接', { url: this.#maskedUrl() });
        for (const waiter of this.#readyWaiters) waiter();
        this.#readyWaiters = [];
        resolve();
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        void this.#onFrame(String((event as { data: unknown }).data));
      });

      ws.addEventListener('error', (event: Event) => {
        const message = (event as { message?: string }).message ?? 'websocket error';
        this.stats.lastError = message;
        this.#logger?.error('OneBot WS 错误', { message });
        if (!settled) {
          settled = true;
          reject(new Error('OneBot WS 连接失败：' + message));
        }
      });

      ws.addEventListener('close', (event: CloseEvent) => {
        const code = (event as { code?: number }).code ?? 0;
        const reason = (event as { reason?: string }).reason ?? '';
        if (this.#ws === ws) this.#ws = null;
        this.stats.connected = false;
        this.stats.disconnects += 1;
        this.stats.lastClose = { code, reason, at: Date.now() };
        this.#logger?.warn('OneBot WS 已断开', { code, reason });
        // 断线时把所有在飞的调用拒掉：让它们立刻失败，比等到超时好 —— 调用方可能还想重试
        this.#failPending('连接已断开（code=' + code + '）');
        if (!settled) {
          settled = true;
          reject(new Error('OneBot WS 在握手阶段断开：code=' + code + ' reason=' + reason));
        }
        if (!this.#closing && this.#config.autoReconnect !== false) this.#scheduleReconnect();
      });
    });
  }

  /** 等到连接可用（已经连着就立刻返回） */
  waitConnected(timeoutMs = 5_000): Promise<void> {
    if (this.stats.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#readyWaiters = this.#readyWaiters.filter((w) => w !== onReady);
        reject(new Error('等待 OneBot WS 连接超时（' + timeoutMs + 'ms）'));
      }, timeoutMs);
      this.#readyWaiters.push(onReady);
    });
  }

  close(): void {
    this.#closing = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#failPending('连接已关闭');
    this.#ws?.close(1000, 'client close');
    this.#ws = null;
    this.stats.connected = false;
  }

  /**
   * 发一个 action 并等它的回执。
   *
   * OneBot 的回执靠 \`echo\` 对号：发出去的每一帧带一个唯一 echo，协议端把同一个 echo 原样带回来。
   * 连接断开或超时都会抛 —— 上层（OneBotAdapter.callApi）据此报错。
   */
  async call(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1) {
      // 没连上时先等一会儿再判死：协议端刚启动时第一条消息不该直接丢
      await this.waitConnected(Math.min(3_000, timeoutMs ?? NUMERIC.onebot.apiTimeoutMs));
    }
    const socket = this.#ws;
    if (!socket || socket.readyState !== 1) {
      this.stats.apiErrors += 1;
      throw new Error('OneBot WS 未连接：' + this.#maskedUrl());
    }

    this.#echo += 1;
    const echo = 'ob-' + this.#echo;
    this.stats.apiCalls += 1;
    const waitMs = timeoutMs ?? NUMERIC.onebot.apiTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        this.stats.apiErrors += 1;
        this.stats.lastError = 'OneBot ' + action + ' 超时（' + waitMs + 'ms）';
        reject(new Error(this.stats.lastError));
      }, waitMs);
      this.#pending.set(echo, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(echo);
        this.stats.apiErrors += 1;
        reject(error as Error);
      }
    });
  }

  /**
   * 给 OneBotAdapter 用的传输函数：把「HTTP POST 到一个 URL」翻译成「发一个 WS action」。
   *
   * \`OneBotAdapter.callApi\` 拼的是 apiBase + 斜杠 + action，这里把 action 从末段取回来 ——
   * 于是**发送逻辑一行都不用重写**，两条 OneBot 传输方式不会各长一套脾气。
   */
  readonly httpPost: HttpPost = async (url, body) => {
    const action = url.slice(url.lastIndexOf('/') + 1);
    const result = await this.call(action, asRecord(body));
    const record = asRecord(result);
    if (record.retcode !== undefined && record.retcode !== 0) {
      throw new Error('OneBot ' + action + ' 失败：retcode=' + String(record.retcode) + ' ' + String(record.message ?? ''));
    }
    return result;
  };

  /** 体检用：问协议端「你是谁」。连上了但连错号，只有这一步看得出来 */
  async fetchSelf(): Promise<{ selfId: string; nickname: string }> {
    const data = asRecord(await this.call('get_login_info', {}));
    const selfId = String(data.user_id ?? '');
    const nickname = String(data.nickname ?? '');
    this.stats.selfId = selfId || null;
    this.stats.nickname = nickname || null;
    return { selfId, nickname };
  }

  async #onFrame(raw: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = asRecord(JSON.parse(raw));
    } catch {
      this.#logger?.warn('OneBot WS 送来无法解析的帧', { head: raw.slice(0, 120) });
      return;
    }

    // ① API 回执：有 echo 就是它
    const echo = typeof frame.echo === 'string' ? frame.echo : null;
    if (echo !== null) {
      const pending = this.#pending.get(echo);
      if (pending) {
        this.#pending.delete(echo);
        clearTimeout(pending.timer);
        if (frame.status === 'failed') {
          this.stats.apiErrors += 1;
          this.stats.lastError = 'OneBot 回执失败：' + String(frame.message ?? frame.wording ?? '');
          pending.reject(new Error(this.stats.lastError));
        } else {
          pending.resolve(frame.data ?? null);
        }
      }
      return;
    }

    // ② 心跳与生命周期：不交给业务层，只用来判断「协议端还活着」
    if (frame.post_type === 'meta_event') {
      const kind = String(frame.meta_event_type ?? '');
      if (kind === 'heartbeat') this.stats.heartbeats += 1;
      else this.stats.lifecycles += 1;
      return;
    }

    // ③ 消息事件
    if (frame.post_type === 'message') {
      this.stats.events += 1;
      try {
        await this.#handler?.(frame);
      } catch (error) {
        // 业务异常不许把读循环带崩 —— 一条消息处理失败不该影响后面所有消息
        this.#logger?.error('OneBot 事件处理抛错', { message: (error as Error).message });
      }
      return;
    }

    this.#logger?.info('OneBot 收到未处理的事件类型', { post_type: String(frame.post_type ?? '') });
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    this.stats.reconnects += 1;
    const cap = NUMERIC.onebot.reconnectMaxMs;
    const backoff = Math.min(cap, NUMERIC.onebot.reconnectBaseMs * 2 ** Math.min(6, this.stats.reconnects - 1));
    // 半固定半随机：协议端重启时，多个机器人实例不要同时挤上去
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.#logger?.info('OneBot WS 准备重连', { delayMs: Math.round(delay), attempt: this.stats.reconnects });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#closing) return;
      void this.connect().catch((error: unknown) => {
        this.stats.lastError = (error as Error).message;
        this.#logger?.error('OneBot WS 重连失败', { message: (error as Error).message });
        if (!this.#closing && this.#config.autoReconnect !== false) this.#scheduleReconnect();
      });
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #failPending(reason: string): void {
    for (const [echo, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(echo);
      pending.reject(new Error('OneBot ' + reason));
    }
  }

  /** 鉴权只能走 query 参数 —— 内建 WebSocket 不允许自定义请求头（见文件头第 3 条） */
  #withToken(url: string): string {
    const token = this.#config.accessToken;
    if (!token) return url;
    const separator = url.includes('?') ? '&' : '?';
    return url + separator + 'access_token=' + encodeURIComponent(token);
  }

  /** 日志里不许出现 access_token（它就是协议端的口令） */
  #maskedUrl(): string {
    const token = this.#config.accessToken;
    return token ? this.#config.url + '（已带 access_token）' : this.#config.url;
  }
}

/* ------------------------------------------------------------------ *
 * 工厂：装配成业务层认识的 Adapter
 * ------------------------------------------------------------------ */

/**
 * 适配器 → 传输层的登记表。
 *
 * 为什么不给 `OneBotAdapter` 加一个 `transport` 字段：那个类是 HTTP 模式在用的，
 * 加一个「只有 WS 模式才有值」的字段会让类型与实现都变含糊。
 * WeakMap 的好处是**不侵入**：`/health` 与后台要拿连接状态时问一句就行，
 * 拿不到（HTTP 模式）就是 null —— 语义清楚，且不会拖住适配器被回收。
 */
const WS_OF = new WeakMap<OneBotAdapter, OneBotWsTransport>();

/** 这个适配器是不是内置 WS 通道；是的话把它的连接状态拿出来 */
export function wsTransportOf(adapter: unknown): OneBotWsTransport | null {
  if (!(adapter instanceof OneBotAdapter)) return null;
  return WS_OF.get(adapter) ?? null;
}

export interface OneBotWsBundle {
  /** 业务层用的适配器（发送逻辑与 HTTP 模式**完全共用**） */
  adapter: OneBotAdapter;
  transport: OneBotWsTransport;
}

/** 从环境变量装配 OneBot WS 通道 */
export function createOneBotWsAdapter(
  env: NodeJS.ProcessEnv = process.env,
  extra: { logger?: Logger; url?: string } = {},
): OneBotWsBundle {
  const url = (extra.url ?? env.ONEBOT_WS_URL ?? '').trim();
  if (!url) {
    throw new Error('缺少 ONEBOT_WS_URL：OneBot WS 通道要填协议端的正向 WebSocket 地址，例如 ws://127.0.0.1:3001');
  }
  const token = (env.ONEBOT_WS_TOKEN ?? env.ONEBOT_ACCESS_TOKEN ?? '').trim();
  const transport = new OneBotWsTransport({
    url,
    ...(token ? { accessToken: token } : {}),
    ...(extra.logger ? { logger: extra.logger } : {}),
  });
  const config: OneBotConfig = { apiBase: url, ...(token ? { accessToken: token } : {}) };
  const adapter = new OneBotAdapter(config, transport.httpPost);
  WS_OF.set(adapter, transport);
  transport.onEvent(async (payload) => {
    // 映射与 HTTP 模式共用同一个函数：两条路进来的事件必须长得一模一样
    if (mapOneBotEvent(payload)) await adapter.handleEvent(payload);
  });
  return { adapter, transport };
}
