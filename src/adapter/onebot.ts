import type { Adapter, ButtonSpec, InternalMessage, MessageHandler, MessageHeader, OutboundImage, Scene } from './types.ts';
import type { InteractiveMessage } from './interactive.ts';
import { commandNameOf } from './command-name.ts';

/**
 * OneBot v11 适配器（W1 内测通道）
 *
 * 传输方式选择：反向 HTTP 上报 + HTTP API 调用。
 * 理由：不需要 WebSocket 库，零依赖即可跑通；NapCat / Lagrange 都支持该模式。
 * 若后续要换反向 WS，只需新增一个 Adapter 实现，业务层零改动（S1 §5.1）。
 *
 * 配置：把 OneBot 实现的「上报地址」指向 http://<本机>:<PORT>/onebot/event
 */
export interface OneBotConfig {
  /** OneBot 实现的 HTTP API 基址，例如 http://127.0.0.1:3000（WS 模式下是协议端地址） */
  apiBase: string;
  accessToken?: string;
  timeoutMs?: number;
  /**
   * **灰度白名单**（M2.82）：只放行这些指令名（不含点号）。空数组或 ['*'] = 全放行。
   *
   * 与 QQ 官方通道同口径 —— 两条通道的开关不该有两套脾气。
   */
  allowedCommands?: readonly string[];
}

/** 运行期改配置的结果（与 QQ 官方通道同形，后台两端共用一套回执文案） */
export interface OneBotReconfigureResult {
  applied: string[];
  needsReconnect: string[];
  pendingReconnect: string[];
}

/** 后台面板要的一屏配置（全部是**此刻真的在用**的值） */
export interface OneBotRuntimeStatus {
  apiBase: string;
  /** 只报「配没配」，不回显 token 本身 */
  hasToken: boolean;
  allowedCommands: string[];
  handled: number;
  /** 被灰度白名单挡下的条数（不为 0 就说明有人在用没放行的指令） */
  filteredByWhitelist: number;
}

export type HttpPost = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
) => Promise<unknown>;

export const defaultHttpPost: HttpPost = async (url, body, headers) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

interface OneBotEventLike {
  post_type?: string;
  message_type?: string;
  sub_type?: string;
  message_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  guild_id?: string;
  channel_id?: string;
  raw_message?: string;
  time?: number;
  sender?: { nickname?: string; card?: string };
  message?: unknown;
}

/** OneBot 事件 → InternalMessage；非消息事件返回 null */
export function mapOneBotEvent(payload: unknown): InternalMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as OneBotEventLike;
  if (event.post_type !== 'message') return null;

  const rawText = typeof event.raw_message === 'string' ? event.raw_message : '';
  const timestamp = typeof event.time === 'number' ? event.time * 1000 : Date.now();
  const nickname = event.sender?.card || event.sender?.nickname || '';

  let scene: Scene;
  let sceneId: string;
  if (event.message_type === 'private') {
    scene = 'private';
    sceneId = String(event.user_id ?? '');
  } else if (event.message_type === 'group') {
    scene = 'group';
    sceneId = String(event.group_id ?? '');
  } else if (event.message_type === 'guild' || event.message_type === 'channel') {
    scene = 'channel';
    sceneId = String(event.channel_id ?? event.group_id ?? '');
  } else {
    return null;
  }

  const userId = String(event.user_id ?? '');
  const messageId = String(event.message_id ?? '');
  if (!userId || !messageId || !sceneId) return null;

  return {
    messageId: `onebot:${messageId}`,
    platform: 'onebot',
    scene,
    sceneId,
    userId,
    nickname,
    rawText,
    timestamp,
  };
}

export class OneBotAdapter implements Adapter {
  /**
   * M2.7：OneBot v11 没有跨实现的按钮标准（NapCat 的 keyboard 是扩展且各家不一），
   * 所以这里**明确声明不支持**：业务层会把 InteractiveMessage 降级成文本菜单。
   * 降级后玩家回数字，走的是 M2.3 就有的 pending_menus 路径，行为与按钮完全一致。
   */
  readonly supportsButtons = false;

  #config: OneBotConfig;
  #post: HttpPost;
  #handler: MessageHandler | null = null;
  /** 已经改掉、但还没生效的配置项（后台拿它提示人） */
  #pendingReconnect: string[] = [];
  /** 观测用：已处理事件数 */
  handled = 0;
  /** 观测用：被灰度白名单挡下的条数 */
  filteredByWhitelist = 0;

  constructor(config: OneBotConfig, post: HttpPost = defaultHttpPost) {
    this.#config = config;
    this.#post = post;
  }

  onMessage(handler: MessageHandler): void {
    this.#handler = handler;
  }

  /** HTTP 服务器收到上报后调用；返回映射出的内部消息（被忽略时为 null） */
  async handleEvent(payload: unknown): Promise<InternalMessage | null> {
    const msg = mapOneBotEvent(payload);
    if (!msg) return null;
    /*
     * M2.82：**灰度白名单**，与 QQ 官方通道同一条纪律 ——
     * 被挡下的消息不交给业务层，但**计数要留下**：
     * 「指令发出去了但被开关挡掉」和「机器人坏了」在玩家那边长得一样，
     * 面板上那个计数就是用来分开它们的。
     *
     * 不是指令的文本（自由文本、数字回复）一律放行 —— 灰度只针对显式指令。
     */
    if (!this.#allowed(msg)) {
      this.filteredByWhitelist += 1;
      return null;
    }
    this.handled += 1;
    if (this.#handler) await this.#handler(msg);
    return msg;
  }

  #allowed(msg: InternalMessage): boolean {
    const list = this.allowedCommands;
    if (list.length === 0 || list.includes('*')) return true;
    const name = commandNameOf(msg.rawText);
    if (name === null) return true;
    return list.includes(name);
  }

  /** 当前灰度白名单（'*' = 全放行，空数组 = 全放行）。启动日志与后台都用它 */
  get allowedCommands(): readonly string[] {
    return this.#config.allowedCommands ?? [];
  }

  /**
   * 运行期改配置（M2.82）。与 QQ 官方通道**同一套判据**：
   *   · 每条消息都读的（白名单 / 超时）→ 写进 #config 就立刻生效；
   *   · 只在发请求时用的（apiBase / accessToken）→ 标成「要重连才生效」。
   */
  reconfigure(patch: Partial<OneBotConfig>): OneBotReconfigureResult {
    const applied: string[] = [];
    const needsReconnect: string[] = [];
    const cfg = this.#config as unknown as Record<string, unknown>;
    const sameValue = (a: unknown, b: unknown): boolean =>
      Array.isArray(a) && Array.isArray(b) ? a.join('\u0000') === b.join('\u0000') : a === b;

    for (const key of ['allowedCommands', 'timeoutMs'] as const) {
      if (!(key in patch)) continue;
      if (sameValue(cfg[key], patch[key])) continue;
      cfg[key] = patch[key];
      applied.push(key);
    }
    for (const key of ['apiBase', 'accessToken'] as const) {
      if (!(key in patch)) continue;
      if (cfg[key] === patch[key]) continue;
      cfg[key] = patch[key];
      needsReconnect.push(key);
      if (!this.#pendingReconnect.includes(key)) this.#pendingReconnect.push(key);
    }
    return { applied, needsReconnect, pendingReconnect: [...this.#pendingReconnect] };
  }

  /** 还没生效的配置项（后台拿它提示人） */
  get pendingReconnect(): readonly string[] {
    return [...this.#pendingReconnect];
  }

  /** 重连完成（或重新装配）后清掉「待生效」清单 */
  clearPendingReconnect(): void {
    this.#pendingReconnect = [];
  }

  runtimeStatus(): OneBotRuntimeStatus {
    return {
      apiBase: this.#config.apiBase,
      hasToken: (this.#config.accessToken ?? '').length > 0,
      allowedCommands: [...this.allowedCommands],
      handled: this.handled,
      filteredByWhitelist: this.filteredByWhitelist,
    };
  }

  async sendPrivate(userId: string, text: string): Promise<void> {
    await this.callApi('send_private_msg', { user_id: toId(userId), message: text });
  }

  async sendGroup(groupId: string, text: string, _header?: MessageHeader | null, _buttons?: ButtonSpec[]): Promise<void> {
    await this.callApi('send_group_msg', { group_id: toId(groupId), message: text });
  }

  /**
   * M2.47：OneBot v11 发图。
   *
   * 用 **base64 内联**（`[CQ:image,file=base64://…]`）而不是先落盘再传路径，有两个理由：
   *   1. 路径形态各家实现不一（file:// / 绝对路径 / 相对宿主目录），base64 是 v11 的标准写法；
   *   2. 机器人进程与 OneBot 实现**可能不在同一台机器上**，路径发过去就是一句 404。
   *
   * 代价是消息体变大（一张 620×1000 的卡约 50—120KB，base64 后 ×1.37）——
   * 内测量级可以接受；真要压，先压图再进这里，而不是改这一段。
   */
  readonly supportsImages = true;
  /**
   * M2.86：**OneBot 支持富文本标签**。
   *
   * 它发的是普通消息（`send_group_msg` 的 `message` 字段原样进客户端），
   * 所以 `<font color="#e05a4f">危险</font>` 这类标签**手机电脑都渲染、还能复制**。
   *
   * 这正是用户看到「云助手」有色字的机制 —— 那类机器人多半也是个人号框架。
   * 官方 QQ Bot 通道做不到（markdown 白名单没有颜色）。
   */
  readonly supportsRichText = true;

  /**
   * M2.47：OneBot 通道的头像直链。
   * OneBot 的 `user_id` 就是 QQ 号，直接用公开头像服务。
   */
  avatarUrlForUser(userId: string, size = 640): string | undefined {
    if (!/^\d+$/.test(userId)) return undefined;
    return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(userId)}&s=${size}`;
  }

  async sendImage(scene: InternalMessage['scene'], targetId: string, image: OutboundImage): Promise<boolean> {
    const cq = `[CQ:image,file=base64://${Buffer.from(image.bytes).toString('base64')}]`;
    const message = `${cq}${image.alt ? '\n' + image.alt : ''}`;
    if (scene === 'private') {
      await this.callApi('send_private_msg', { user_id: toId(targetId), message });
      return true;
    }
    if (scene === 'group') {
      await this.callApi('send_group_msg', { group_id: toId(targetId), message });
      return true;
    }
    await this.sendChannel(targetId, message);
    return true;
  }

  /**
   * 频道消息。OneBot v11 无频道概念，这里按 NapCat 的扩展事件与 API 处理：
   * 部分实现要求带 guild_id，W1 未实测，接入频道前需校准（见 docs/W1-交付说明.md）。
   */
  async sendChannel(channelId: string, text: string): Promise<void> {
    await this.callApi('send_guild_channel_msg', {
      channel_id: channelId,
      message: text,
    });
  }

  async callApi(action: string, params: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.#config.accessToken) headers.authorization = `Bearer ${this.#config.accessToken}`;
    const url = `${this.#config.apiBase.replace(/\/+$/, '')}/${action}`;
    const result = (await this.#post(url, params, headers)) as
      | { status?: string; retcode?: number; message?: string }
      | null;
    if (result && typeof result === 'object' && 'retcode' in result && result.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败：retcode=${result.retcode} ${result.message ?? ''}`);
    }
    return result;
  }

  /**
   * M2.7：按钮通道未实现 → 一律返回 false，由 sendReplies 回退成纯文本发送。
   * 不抛异常是有意的：**降级是 OneBot 的正常路径**，不是错误。
   */
  async sendInteractive(
    _scene: Scene,
    _targetId: string,
    _message: InteractiveMessage,
  ): Promise<boolean> {
    return false;
  }

  /** HTTP 服务器需要的共享密钥校验 */
  authorized(header?: string): boolean {
    if (!this.#config.accessToken) return true;
    return header === `Bearer ${this.#config.accessToken}`;
  }
}

function toId(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
}
