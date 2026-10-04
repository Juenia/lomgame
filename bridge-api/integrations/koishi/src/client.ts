/**
 * Koishi 侧的桥接客户端 —— **零 Koishi 依赖**的那一半。
 *
 * 为什么要把逻辑切在这里：Koishi 插件本体（`index.ts`）必须在 Koishi 环境里才能加载
 * （它要 `Schema` 与 `h`），而本仓库没有 Koishi 依赖 —— 于是"插件能不能用"
 * 就变成了一句无法验证的话。切法很简单：
 *
 *   · 本文件：协议怎么发、回执怎么渲染、出站长轮询怎么转 —— **纯逻辑，可测**；
 *   · `index.ts`：把它接到 Koishi 的 Context / Session / bot 上 —— 只剩接线。
 *
 * 这样"桥接逻辑对不对"在仓库里就能验（见 bridge-api/test/koishi-client.test.ts），
 * 而剩下那 60 行接线是可以逐行读懂的。
 */
import type {
  BridgeScene,
  Capabilities,
  InboundResponse,
  OutboundItem,
  OutboundResponse,
} from '../../../src/protocol.ts';

/**
 * 把一个不知道是什么的错误说清楚。
 *
 * 原来这里写的是 `(error as Error).message` —— 结果日志里是 `error: ''`：
 * Koishi 的 adapter 抛的东西未必是 Error 实例，`.message` 取不到东西，
 * 而空字符串让整条日志等于没写。排障时最怕的就是这个：有日志，但什么都没说。
 */
export function describeError(error: unknown): string {
  // ⚠️ AggregateError 要**先展开**：它的 message 默认是空字符串，
  // 而真正的错误在 .errors 里。
  //
  // 这不是理论：Satori 的 QMessageEncoder.send 就是 `throw new AggregateError(this.errors)`
  //（@satorijs/core/lib/index.cjs:756）。不展开的话，日志里永远是一句空 message ——
  // 明明有错误、却什么都看不到，这正是上一轮卡住的原因。
  if (error instanceof AggregateError || (typeof error === 'object' && error !== null && Array.isArray((error as { errors?: unknown }).errors))) {
    const list = ((error as { errors?: unknown[] }).errors ?? []) as unknown[];
    if (list.length === 0) return 'AggregateError（errors 为空）';
    const inner = list.map((one, index) => '[' + index + '] ' + describeError(one)).join(' ｜ ');
    return ('AggregateError(' + list.length + ' 个)：' + inner).slice(0, 900);
  }
  if (error instanceof Error) {
    const parts = [error.message];
    if (error.name && error.name !== 'Error') parts.unshift(error.name);
    if (error.cause !== undefined) parts.push('cause=' + String(error.cause).slice(0, 200));
    if (error.message === '' && error.stack) parts.push(error.stack.split('\n').slice(0, 3).join(' | '));
    return parts.join(' ').slice(0, 600);
  }
  if (typeof error === 'string') return error.slice(0, 600);
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return json.slice(0, 600);
  } catch { /* 循环引用之类，往下走 */ }
  return String(error).slice(0, 600) + '（原始类型 ' + typeof error + '）';
}

export interface BridgeClientOptions {
  /** 例：`http://127.0.0.1:3200` */
  apiBase: string;
  /** 与 BRIDGE_TOKEN 一致；服务端没设口令时可以留空 */
  token?: string;
  /** 上游框架名（写进 platform 字段，用于审计与出站回源） */
  platform?: string;
  /** 测试注入用；默认用全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface InboundPayload {
  scene: BridgeScene;
  sceneId: string;
  userId: string;
  nickname?: string;
  text: string;
  messageId?: string;
  timestamp?: number;
  sync?: boolean;
}

export interface BridgeCapabilitiesPatch {
  buttons?: boolean;
  images?: boolean;
  inlineImages?: boolean;
  /** 能不能把图上传换成公网 URL（反向通道；QQ 官方通道有） */
  inlineUpload?: boolean;
  richText?: boolean;
  avatarTemplate?: string;
}

/** 一条回执渲染成 Koishi 侧要发的东西 */
export interface RenderedMessage {
  text: string;
  image?: { base64?: string; url?: string; mediaType: string; alt?: string };
  /** 原始按钮（`command` 是完整指令）。当前只用于文本提示，见 renderOutbound 的说明 */
  buttons: Array<{ label: string; command: string }>;
}

export class BridgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
  }
}

export class BridgeClient {
  readonly #base: string;
  readonly #token: string | undefined;
  readonly #platform: string;
  readonly #fetch: typeof fetch;

  constructor(options: BridgeClientOptions) {
    this.#base = options.apiBase.replace(/\/+$/, '');
    this.#token = options.token === '' ? undefined : options.token;
    this.#platform = options.platform ?? 'koishi';
    this.#fetch = options.fetchImpl ?? fetch;
  }

  #headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#token !== undefined ? { authorization: `Bearer ${this.#token}` } : {}),
    };
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.#fetch(this.#base + path, {
      ...init,
      headers: { ...this.#headers(), ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      // 把服务端说的那句话原样带出去 —— 这一层最常见的失败是 401 与 400，各有各的修法
      throw new BridgeError(res.status, `${res.status} ${text.slice(0, 300)}`);
    }
    return (text === '' ? {} : JSON.parse(text)) as T;
  }

  /** 把一条玩家消息送进游戏 */
  async inbound(payload: InboundPayload): Promise<InboundResponse> {
    return this.#json<InboundResponse>('/api/v1/inbound', {
      method: 'POST',
      body: JSON.stringify({
        platform: this.#platform,
        ...payload,
      }),
    });
  }

  /** 取回执（`waitSec > 0` 时是长轮询） */
  async outbound(cursor: number, waitSec = 0, limit = 20): Promise<OutboundResponse> {
    const query = new URLSearchParams({
      cursor: String(cursor),
      limit: String(limit),
      platform: this.#platform,
      ...(waitSec > 0 ? { wait: String(waitSec) } : {}),
    });
    return this.#json<OutboundResponse>(`/api/v1/outbound?${query.toString()}`);
  }

  /** 声明这条通道能做什么（不调也行，服务端会用最保守的缺省档） */
  async declareCapabilities(patch: BridgeCapabilitiesPatch): Promise<Capabilities> {
    const body = await this.#json<{ ok: true; capabilities: Capabilities }>('/api/v1/capabilities', {
      method: 'POST',
      body: JSON.stringify({ platform: this.#platform, ...patch }),
    });
    return body.capabilities;
  }

  /**
   * 回传「这张图换回来的公网 URL」—— 协议里唯一一条反向的路。
   *
   * 换不到就传 `url: undefined` 加一句原因：服务端会回落成「图单独发一条」，
   * **不会**因为上传失败让玩家什么都看不到。
   */
  async declareInlineImage(payload: { requestId: string; url?: string; error?: string }): Promise<void> {
    await this.#json<{ ok: true }>('/api/v1/inline-image', {
      method: 'POST',
      body: JSON.stringify({
        platform: this.#platform,
        requestId: payload.requestId,
        ...(payload.url !== undefined ? { url: payload.url } : {}),
        ...(payload.error !== undefined ? { error: payload.error.slice(0, 300) } : {}),
      }),
    });
  }

  get platform(): string {
    return this.#platform;
  }
}

/**
 * 把回执里的图变成 Koishi 侧 `h.image` 能吃的 src。
 *
 * ## 为什么非要自己拼 `data:`，不能直接把 Buffer 丢给 `h.image`
 *
 * Satori 的元素工厂 `createAssetFactory`（`@satorijs/element`）对**非字符串**的 src
 * 用的默认前缀是 **`base64://`**：
 *
 *     h.image(buffer)   →   src = "base64://<base64>"
 *
 * 而 QQ 官方适配器（`@satorijs/adapter-qq` 的 `sendFile`）认的是另一条正则：
 *
 *     /^data:([\w/.+-]+);base64,(.*)$/
 *
 * `base64://` 既不匹配它、也不是 http(s)，于是掉进 `ctx.http.file()` 那条
 * 「本地资源」分支 —— 那一路拿不到图片文件名，图就**静默发不出去**
 * （适配器把错误吞进 `this.errors`：消息照发，只是没有图）。
 *
 * 现场症状：官方通道下按钮正常、markdown 正常，**只有图全都不出来** ——
 * 前两者走的是文本，只有图会经过这个前缀。OneBot 适配器两种前缀都认，
 * 所以这个坑只在官方通道显形。
 *
 * 所以这里显式拼成 `data:<mime>;base64,<…>`：它同时是「Satori 的标准形态」
 * 和「官方适配器唯一认得的那条正则」。
 * （`h.image(buffer, mime)` 运行时也行，但 Koishi 的类型签名只声明了一个参数，
 *   两参会直接 TS2554 —— 而且显式拼出来的这行更不容易被后人改回去。）
 *
 * @returns 拼好的 src；base64 与 url 都没有时返回 undefined（调用方退回纯文字）
 */
export function imageSrc(image: { base64?: string; url?: string; mediaType: string }): string | undefined {
  if (image.base64 !== undefined && image.base64 !== '') {
    return `data:${image.mediaType};base64,${image.base64}`;
  }
  if (image.url !== undefined && image.url !== '') return image.url;
  return undefined;
}

/**
 * 把「一行一个群号」的屏蔽名单解析成集合。
 *
 * ## 为什么是文本而不是数组控件
 *
 * Koishi 设置页里文本域（`role('textarea')`）比数组控件好写太多：
 * 从群列表复制一列群号粘进去就完事，不用一个个点「添加」。
 *
 * ## 规矩就三条
 *
 * · 空行忽略；
 * · `#` 开头的行当注释 —— 配置里能顺手写一句「这个群为什么屏蔽」，半年后还看得懂；
 * · 前后空白吃掉（从聊天记录里复制常带空格）；行内**不切分** ——
 *   群号是纯数字，逗号或空格只会把 `123 456` 这种手滑变成两个号，那不是帮忙。
 *
 * 返回 Set：判断是 O(1)，而这件事**每条消息、每条回执**都要做一次。
 */
export function parseBlockedGroups(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    out.add(line);
  }
  return out;
}

/**
 * 这条消息 / 回执是不是落在屏蔽名单里。
 *
 * ⚠️ **只挡群**：私聊与频道不受影响。
 * 屏蔽一个群 ≠ 封掉群里那个人的角色 —— 他私聊还能照玩。
 * 「屏蔽群」与「拉黑玩家」是两件事，这里只做前一件。
 */
export function isBlockedGroup(blocked: ReadonlySet<string>, scene: string, targetId: string): boolean {
  return scene === 'group' && blocked.has(targetId);
}

/**
 * 把一条出站项渲染成 Koishi 要发的内容。
 *
 * ## 为什么按钮在**这一版**里只做文本提示
 *
 * 判定层有两种形态（见 src/adapter/interactive.ts）：
 *   · 通道不声明按钮（默认）→ 它直接发**带完整文本菜单**的正文（`kind = 'text'`），
 *     玩家回数字就行 —— 这条路在**所有** Koishi adapter 上都能用；
 *   · 通道声明 `buttons = true` → 它发精简正文 + `options`（`kind = 'interactive'`），
 *     此时**上游必须自己把选项画出来**，否则玩家看不到任何选项。
 *
 * 这里对第二种情况做的是"**把选项拼回文本**"—— 于是即使上游不画按钮，
 * 玩家也不会少看到东西。要真正上原生按钮，改这一个函数即可
 * （Koishi 的按钮元素因 adapter 而异，不适合在一个通用桥里写死）。
 */
export function renderOutbound(item: OutboundItem): RenderedMessage {
  /*
   * 按钮有两个来源，**都要给上游**：
   *   · `item.buttons` —— 主动推送底部的原始按钮（点了等于手打 command）；
   *   · `item.options` —— 菜单选项（点了等于回数字）。
   *
   * 上一版只搬了前者，于是「声明能摆按钮」之后选项全被拼成文本、一个按钮都没有。
   */
  const commands = (item.buttons ?? []).map((b) => ({ label: b.label, command: b.command }));
  const optionButtons = (item.options ?? []).map((o) => ({ label: o.label, command: o.id }));
  const buttons = [...commands, ...optionButtons];
  if (item.kind === 'image') {
    return {
      text: item.text,
      ...(item.image !== undefined
        ? {
            image: {
              ...(item.image.base64 !== undefined ? { base64: item.image.base64 } : {}),
              ...(item.image.url !== undefined ? { url: item.image.url } : {}),
              mediaType: item.image.mediaType,
              ...(item.image.alt !== undefined ? { alt: item.image.alt } : {}),
            },
          }
        : {}),
      buttons,
    };
  }
  if (item.kind === 'text') {
    return { text: item.text, buttons };
  }
  /*
   * interactive：正文 + 选项列表。
   *
   * ⚠️ 这段排版是 `src/adapter/interactive.ts` 的 `renderInteractiveText` 的**逐字复刻** ——
   * 理由：判定层在"通道不摆按钮"时发的纯文本就是那个函数渲染的，两条路必须长得一样，
   * 否则同一个菜单在"声明按钮"前后会变成两种排版（玩家会以为菜单变了）。
   *
   * 复刻而不是 import，是因为这个插件要能独立分发（拷进 Koishi 项目就能用）；
   * 代价是可能漂移 —— 所以 bridge-api/test/koishi-client.test.ts 里有一条**对拍**用例守着。
   * 常量同样来自那边：`FREEFORM_KEY = '0'`、`MENU_REPLY_HINT = '回复数字。'`。
   */
  const lines: string[] = [item.text, ''];
  for (const option of item.options ?? []) {
    const preview = option.preview !== undefined && option.preview !== '' ? `（${option.preview}）` : '';
    const disabled = option.disabled === true ? `　〔不可选：${option.disabledReason ?? '暂不可选'}〕` : '';
    lines.push(`${option.id}. ${option.label}${preview}${disabled}`);
  }
  if (item.freeformLabel !== null) {
    lines.push(`0. ${item.freeformLabel ?? '自己写一个行为'}`);
  }
  lines.push('');
  lines.push('回复数字。');
  /*
   * 快捷指令按钮（M2.86）：`renderInteractiveText` 不管它（那边是给"手打指令"的提示），
   * 但上游声明了 buttons 时它没有别的出口 —— 落在正文最后一行，至少不丢。
   */
  if ((item.quickButtons ?? []).length > 0) {
    lines.push('快捷指令：' + (item.quickButtons ?? []).map((b) => `.${b.command.replace(/^\./, '')}`).join('　'));
  }
  return { text: lines.join('\n'), buttons };
}

export interface OutboundLoopOptions {
  client: BridgeClient;
  /** 一条回执要发到哪 —— 由调用方（Koishi 接线）实现 */
  deliver: (item: OutboundItem) => Promise<void>;
  logger: { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void; error: (m: string, meta?: Record<string, unknown>) => void };
  /** 长轮询挂多久（秒） */
  waitSec?: number;
  /** 出错后隔多久重试（毫秒） */
  retryMs?: number;
  /**
   * `waitSec = 0`（关掉长轮询）且这一轮没取到东西时，歇多久再问（毫秒）。
   *
   * ⚠️ 这一位不是可选的优化：关掉长轮询后服务端会**立刻**返回空，
   * 没有这个退让就是一个打满 CPU、每秒几千次请求的死循环 —— 而配置里写个 0 很容易。
   */
  idleMs?: number;
  /** 起始游标（默认 0 = 从头取；重启后建议从 0，宁可重发也别漏发） */
  cursor?: number;
  /** 测试用：注入 sleep */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 出站长轮询循环。
 *
 * 为什么是"长轮询"而不是 WebSocket：Koishi 里一个 `while` 循环加 `fetch` 就够，
 * 断线重连、超时、退避全都看得见；而 WS 要多一套心跳与状态机，
 * 对"一个进程一条桥"这种用法不划算（服务端也提供 SSE，见 docs/API.md）。
 *
 * `gap` 必须被报出来：队列在服务端是有容量上限的，被裁剪过就意味着
 * **中间那几条回执已经永远丢了** —— 这是运维要知道的事，不是能"继续往下跑"的小事。
 */
export function startOutboundLoop(options: OutboundLoopOptions): { stop: () => void; cursor: () => number } {
  const { client, deliver, logger } = options;
  const waitSec = options.waitSec ?? 25;
  const retryMs = options.retryMs ?? 3000;
  const idleMs = options.idleMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let cursor = options.cursor ?? 0;
  let stopped = false;

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const batch = await client.outbound(cursor, waitSec);
        if (batch.gap === true) {
          logger.warn('回执队列中间被裁剪过，有消息丢了', {
            cursor,
            earliest: batch.earliest,
            hint: '上游离线太久（队列有容量上限）—— 调大 BRIDGE_OUTBOX_CAPACITY 或让桥常驻',
          });
        }
        cursor = batch.cursor;
        if (batch.items.length === 0 && waitSec <= 0) {
          // 见 idleMs 的说明：没有长轮询兜着，就必须自己退让
          await sleep(idleMs);
          if (stopped) return;
          continue;
        }
        for (const item of batch.items) {
          if (stopped) return;
          try {
            await deliver(item);
          } catch (error) {
            // 单条发不出去不该打断整条桥（下一个群、下一条消息还要用）
            logger.error('回执投递失败', { seq: item.seq, scene: item.scene, error: describeError(error) });
          }
        }
      } catch (error) {
        if (stopped) return;
        logger.warn('取回执失败，稍后重试', { error: (error as Error).message, retryMs });
        await sleep(retryMs);
      }
    }
  };
  void run();

  return {
    stop: () => {
      stopped = true;
    },
    cursor: () => cursor,
  };
}
