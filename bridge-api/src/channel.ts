/**
 * API 通道 —— 这一版**唯一**的 Adapter 实现。
 *
 * ## 它做了什么
 *
 * 判定层要的只是一个 `Adapter`：一个入站口（`onMessage`）与几个出站方法。
 * 原来的 OneBot / QQ 官方通道把这些调用翻译成平台协议；这里把它们翻译成
 * **队列里的一条出站项** —— 谁把它取走、怎么投递，是上游框架（BEE / Koishi）的事。
 *
 * ## 三条来自既有通道的纪律，这里一条都没放松
 *
 * 1. **降级是正常路径，不是错误**（见 src/adapter/types.ts）：
 *    `sendInteractive` 返回 `false` 时调用方会自己回退成纯文本，
 *    所以"这条通道不摆按钮"不需要抛异常、也不需要 if 分支污染判定层。
 * 2. **能力由通道回答，不由调用方猜**：`supportsButtons` / `supportsImages` …
 *    全部是 getter —— 上游随时可以用 `POST /api/v1/capabilities` 改口，
 *    改完**下一次判定立刻按新能力走**（不用重启进程）。
 * 3. **出站必须带上"回给谁"**：由某条入站触发的回执定向回那条上游；
 *    世界播报这种没有来源的（`platform === undefined`）才广播给所有上游。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Adapter,
  ButtonSpec,
  InternalMessage,
  MessageHandler,
  MessageHeader,
  OutboundImage,
  Scene,
} from '../../src/adapter/types.ts';
import type { InteractiveMessage } from '../../src/adapter/interactive.ts';
import type { Logger } from '../../src/infra/logger.ts';
import { randomUUID } from 'node:crypto';
import type { ImageMode } from './config.ts';
import type { Outbox, PendingItem } from './outbox.ts';
import {
  DEFAULT_CAPABILITIES,
  type OutboundHeader,
  type OutboundImagePayload,
  type OutboundItem,
  type OutboundOption,
  type ResolvedCapabilities,
} from './protocol.ts';

/** 当前正在处理的那条入站消息的上下文（出站项据此定向回源） */
interface HandlingContext {
  platform: string;
  items: OutboundItem[];
}

export interface UpstreamRecord {
  platform: string;
  /** 最后一次见到它的时刻（毫秒） */
  lastSeenAt: number;
  /** 它送进来多少条玩家消息 */
  inbound: number;
  /** 它取走了多少条回执 */
  taken: number;
  capabilities: ResolvedCapabilities;
}

export interface ApiChannelOptions {
  outbox: Outbox;
  logger: Logger;
  /** 上游没声明能力时的缺省档（默认取最保守的一档） */
  capabilities?: ResolvedCapabilities;
  imageMode?: ImageMode;
  /** 单张图的字节上限；超了只告警，不丢图 */
  maxImageBytes?: number;
  /** 多久没动静算"不在线" */
  upstreamStaleMs?: number;
  /** 等上游回传「图的公网 URL」的时限（毫秒）。玩家在等这张图，别太久 */
  inlineUploadTtlMs?: number;
  now?: () => number;
}

export class ApiChannel implements Adapter {
  readonly #outbox: Outbox;
  readonly #logger: Logger;
  readonly #imageMode: ImageMode;
  readonly #maxImageBytes: number;
  readonly #upstreamStaleMs: number;
  readonly #now: () => number;
  readonly #defaultCapabilities: ResolvedCapabilities;
  /** 按上游覆盖的能力（`POST /api/v1/capabilities` 写进来） */
  readonly #capabilities = new Map<string, ResolvedCapabilities>();
  readonly #upstreams = new Map<string, UpstreamRecord>();
  /**
   * 用 AsyncLocalStorage 而不是一个实例字段来记"当前来源"。
   *
   * 为什么：判定层的出站是**异步**的（`await sendReplies(...)` 里一条条发），
   * 而两条入站消息可能同时在飞。用一个字段记来源，就会出现
   * 「A 的回执被标成发给了 B」—— 表现为玩家甲收到玩家乙的回复，且**不报错**。
   */
  readonly #handling = new AsyncLocalStorage<HandlingContext>();
  #handler: MessageHandler | null = null;
  /** 等上游回传「图的公网 URL」的时限 */
  readonly #inlineUploadTtlMs: number;
  /** 还没回传的上传请求：requestId → 唤醒函数（见 prepareInlineImage） */
  readonly #pendingUploads = new Map<string, (url: string | undefined) => void>();

  constructor(options: ApiChannelOptions) {
    this.#outbox = options.outbox;
    this.#logger = options.logger;
    this.#imageMode = options.imageMode ?? 'base64';
    this.#maxImageBytes = options.maxImageBytes ?? 4 * 1024 * 1024;
    this.#upstreamStaleMs = options.upstreamStaleMs ?? 120_000;
    this.#inlineUploadTtlMs = options.inlineUploadTtlMs ?? 10_000;
    this.#now = options.now ?? (() => Date.now());
    this.#defaultCapabilities = options.capabilities ?? { ...DEFAULT_CAPABILITIES };
  }

  /* ---------------- 入站 ---------------- */

  onMessage(handler: MessageHandler): void {
    this.#handler = handler;
  }

  /** 处理器装上了吗（启动中断 / 正在关闭时为 false）—— server 用它回 accepted */
  get ready(): boolean {
    return this.#handler !== null;
  }

  /**
   * 把一条上游消息交给判定层（由 server 调用）。
   *
   * 返回值是**这条消息触发的出站项**（同步模式直接把它们塞进响应体）。
   * ⚠️ 它们**同时也进了队列** —— 同步模式不是第二条通道，只是"顺手捎一份"。
   */
  async deliver(msg: InternalMessage, platform: string): Promise<OutboundItem[]> {
    const record = this.#recordOf(platform);
    record.lastSeenAt = this.#now();
    record.inbound += 1;
    const handler = this.#handler;
    if (handler === null) {
      // 启动中断/正在关闭：说清楚，别让上游以为消息被受理了
      this.#logger.warn('消息处理器还没装上，这条消息被丢弃', { platform, userId: msg.userId });
      return [];
    }
    const context: HandlingContext = { platform, items: [] };
    return this.#handling.run(context, async () => {
      await handler(msg);
      return context.items;
    });
  }

  /* ---------------- 能力 ---------------- */

  get supportsRichText(): boolean {
    return this.#effective().richText;
  }

  get supportsButtons(): boolean {
    return this.#effective().buttons;
  }

  get supportsImages(): boolean {
    return this.#effective().images;
  }

  get supportsInlineImages(): boolean {
    return this.#effective().inlineImages;
  }

  /** 运行期改口（`POST /api/v1/capabilities`）—— 只给的那几项覆盖，其余照旧 */
  setCapabilities(platform: string, patch: Partial<ResolvedCapabilities>): ResolvedCapabilities {
    const base = this.#capabilities.get(platform) ?? { ...this.#defaultCapabilities };
    const next: ResolvedCapabilities = { ...base };
    if (patch.buttons !== undefined) next.buttons = patch.buttons;
    if (patch.images !== undefined) next.images = patch.images;
    if (patch.inlineImages !== undefined) next.inlineImages = patch.inlineImages;
    if (patch.richText !== undefined) next.richText = patch.richText;
    if (patch.inlineUpload !== undefined) next.inlineUpload = patch.inlineUpload;
    if (patch.avatarTemplate !== undefined) next.avatarTemplate = patch.avatarTemplate;
    this.#capabilities.set(platform, next);
    this.#recordOf(platform).capabilities = next;
    return next;
  }

  capabilitiesOf(platform?: string): ResolvedCapabilities {
    if (platform === undefined) return { ...this.#defaultCapabilities };
    return { ...(this.#capabilities.get(platform) ?? this.#defaultCapabilities) };
  }

  /**
   * 取"当前这条上游"的能力。
   *
   * 不在处理入站消息的上下文里时（比如启动日志、世界播报的出站），用缺省档 ——
   * 这正是我们要的：主动推送不该按某一条通道的脾气来渲染。
   */
  #effective(): ResolvedCapabilities {
    const platform = this.#handling.getStore()?.platform;
    if (platform === undefined) return this.#defaultCapabilities;
    return this.#capabilities.get(platform) ?? this.#defaultCapabilities;
  }

  /* ---------------- 出站 ---------------- */

  async sendPrivate(userId: string, text: string, header?: MessageHeader | null): Promise<void> {
    this.#emit({
      kind: 'text',
      scene: 'private',
      targetId: userId,
      text,
      ...this.#headerPart(header),
    });
  }

  async sendGroup(
    groupId: string,
    text: string,
    header?: MessageHeader | null,
    buttons?: ButtonSpec[],
  ): Promise<void> {
    this.#emit({
      kind: 'text',
      scene: 'group',
      targetId: groupId,
      text,
      ...this.#headerPart(header),
      // 主动推送的原始按钮：点了等于手打 command（没有待答菜单，见 src/adapter/types.ts）
      ...(buttons !== undefined && buttons.length > 0
        ? { buttons: buttons.map((b) => ({ label: b.label, command: b.command })) }
        : {}),
    });
  }

  async sendChannel(channelId: string, text: string, header?: MessageHeader | null): Promise<void> {
    this.#emit({
      kind: 'text',
      scene: 'channel',
      targetId: channelId,
      text,
      ...this.#headerPart(header),
    });
  }

  /**
   * 带选项的发送。
   *
   * 返回值即契约：`true` = 已经交给上游（它负责把选项变成按钮）；
   * `false` = 这条通道不摆按钮，请调用方回退发纯文本（**正常路径**，不是错误）。
   */
  async sendInteractive(
    scene: Scene,
    targetId: string,
    message: InteractiveMessage,
    header?: MessageHeader,
  ): Promise<boolean> {
    if (!this.supportsButtons) return false;
    const options = message.options.map(
      (option): OutboundOption => ({
        id: option.id,
        label: option.label,
        command: option.command,
        ...(option.preview !== undefined ? { preview: option.preview } : {}),
        ...(option.disabled === true ? { disabled: true } : {}),
        ...(option.disabledReason !== undefined ? { disabledReason: option.disabledReason } : {}),
      }),
    );
    const quickButtons = (message.quickButtons ?? []).map((b) => ({ label: b.label, command: b.command }));
    // 一个可点的东西都没有 ⇒ 当作"摆不出来"，让调用方走文本（与 canUseButtons 同一条判据）
    if (options.length === 0 && quickButtons.length === 0) return false;
    /*
     * M2.86 的 noHeader：这条消息**明确不要信息头**。
     * 这里必须显式判它 —— 少了这一句，`.角色` 那种"一张图 + 几个按钮"的消息
     * 会顶着一个玩家头像，与世界播报那个坑一模一样。
     */
    const withHeader = message.noHeader === true ? {} : this.#headerPart(header);
    this.#emit({
      kind: 'interactive',
      scene,
      targetId,
      text: message.text,
      ...withHeader,
      ...(options.length > 0 ? { options } : {}),
      ...(quickButtons.length > 0 ? { quickButtons } : {}),
      // undefined（用默认文案）与 null（不要这行）必须原样传出去，见 protocol.ts
      ...(message.freeformLabel !== undefined ? { freeformLabel: message.freeformLabel } : {}),
    });
    return true;
  }

  /**
   * 发一张图。
   *
   * `true` = 已交给上游；`false` = 本通道发不了（调用方回退文本，与老通道一致）。
   * 图片本体怎么给由 `BRIDGE_IMAGE_MODE` 定：base64（默认，谁都能用）/ url / both。
   */
  async sendImage(
    scene: Scene,
    targetId: string,
    image: OutboundImage,
    header?: MessageHeader,
  ): Promise<boolean> {
    if (!this.supportsImages) return false;
    const payload = this.#imagePayload(image);
    if (payload === undefined) return false;
    this.#emit({
      kind: 'image',
      scene,
      targetId,
      // 图与文字是两条消息（与 OneBot 通道同一形态）——正文留空是有意的
      text: '',
      ...this.#headerPart(header),
      image: payload,
    });
    return true;
  }

  /**
   * 「把这张图交给上游换成公网 URL」—— 协议里唯一一条反向的路。
   *
   * ## 为什么值得为它开一条反向通道（推翻了这一版早先的判断）
   *
   * 早先这里写的是「这一版不做」，理由是"只换来少发一条消息的观感差异"。
   * 那个判断在**官方通道**下是错的：单发的富媒体图片与 markdown 正文**互斥**，
   * 于是「图 + 正文 + 按钮」永远得分两条 —— 而用户要的恰恰是一条。
   *
   * 唯一形态是 markdown 正文里嵌图（`![](url)`），那个 url 必须落在平台白名单域名上，
   * 也就是只能由**上游**（QQ 富媒体，凭据在它手里）上传换来。字节在服务端、凭据在上游，
   * 缺一不可 —— 所以只能来回这一趟。
   *
   * ## 降级（永远在）
   *
   * 上游没声明 `inlineUpload`、或者没在时限内回传 → 返回 `undefined`，
   * 调用方走既有那条路（图单独发一条）。**上传失败不会让玩家什么都看不到。**
   */
  async prepareInlineImage(
    scene: Scene,
    targetId: string,
    image: OutboundImage,
  ): Promise<string | undefined> {
    if (!this.#effective().inlineUpload) return undefined;
    const payload = this.#imagePayload(image);
    // base64 模式下才有字节可交；url 模式下图本来就有直链，不必绕这一趟
    if (payload === undefined || payload.base64 === undefined) return undefined;

    const requestId = randomUUID();
    const ttlMs = this.#inlineUploadTtlMs;
    const answer = new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingUploads.delete(requestId);
        this.#logger.warn('上游没在时限内回传图片 URL，回落成图单独发一条', { requestId, ttlMs });
        resolve(undefined);
      }, ttlMs);
      this.#pendingUploads.set(requestId, (url) => {
        clearTimeout(timer);
        this.#pendingUploads.delete(requestId);
        resolve(url);
      });
    });
    /*
     * 这条出站项的正文是空的 —— 它不发给玩家，是发给**上游**的一个请求。
     * platform 由 #emit 按当前处理上下文补上（判定层的出图都在入站链路里）。
     */
    this.#emit({ kind: 'upload', scene, targetId, text: '', requestId, image: payload });
    return answer;
  }

  /**
   * 上游回传上传结果（`POST /api/v1/inline-image`）。
   *
   * @returns 找到等待者 = `true`；号不对或已经超时 = `false` ——
   *          后者**不是错误**，只是没人等了（超时那条日志在 prepareInlineImage 里）
   */
  resolveInlineUpload(requestId: string, url: string | undefined): boolean {
    const waiter = this.#pendingUploads.get(requestId);
    if (waiter === undefined) return false;
    // 空串按「换不到」处理：上游回一句空 url 不该被当成有效直链
    const clean = url === undefined || url.trim() === '' ? undefined : url.trim();
    waiter(clean);
    return true;
  }

  avatarUrlForUser(userId: string, size = 100): string | undefined {
    const template = this.#effective().avatarTemplate;
    if (template === undefined) return undefined;
    return template
      .split('{userId}')
      .join(encodeURIComponent(userId))
      .split('{size}')
      .join(String(size));
  }

  /* ---------------- 上游台账（给 /health 与后台看） ---------------- */

  /** 见到一条上游请求就记一笔（server 在每个 /api/v1/* 请求上调用） */
  touch(platform: string): void {
    this.#recordOf(platform).lastSeenAt = this.#now();
  }

  /** 上游取走了几条（只用于观测：能看出"它是不是不收了"） */
  noteTaken(platform: string | undefined, count: number): void {
    if (platform === undefined || count === 0) return;
    this.#recordOf(platform).taken += count;
  }

  upstreams(): UpstreamRecord[] {
    return [...this.#upstreams.values()].map((r) => ({ ...r, capabilities: { ...r.capabilities } }));
  }

  /** 有没有上游在最近 `upstreamStaleMs` 内动过（后台的"网关已连接"读它） */
  isAnyUpstreamAlive(): boolean {
    const deadline = this.#now() - this.#upstreamStaleMs;
    for (const record of this.#upstreams.values()) {
      if (record.lastSeenAt >= deadline) return true;
    }
    return false;
  }

  /* ---------------- 内部 ---------------- */

  #recordOf(platform: string): UpstreamRecord {
    const existing = this.#upstreams.get(platform);
    if (existing !== undefined) return existing;
    const fresh: UpstreamRecord = {
      platform,
      lastSeenAt: this.#now(),
      inbound: 0,
      taken: 0,
      capabilities: { ...(this.#capabilities.get(platform) ?? this.#defaultCapabilities) },
    };
    this.#upstreams.set(platform, fresh);
    return fresh;
  }

  #headerPart(header?: MessageHeader | null): { header?: OutboundHeader } {
    // null / undefined 都表示"这条消息不要信息头"（世界播报走的就是这条）
    if (header === undefined || header === null) return {};
    const avatarUrl =
      header.avatarUserId === undefined ? undefined : this.avatarUrlForUser(header.avatarUserId);
    return {
      header: {
        nickname: header.nickname,
        ...(header.genderTag !== undefined ? { genderTag: header.genderTag } : {}),
        ...(header.pathwayLine !== undefined ? { pathwayLine: header.pathwayLine } : {}),
        ...(header.locationName !== undefined ? { locationName: header.locationName } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      },
    };
  }

  #imagePayload(image: OutboundImage): OutboundImagePayload | undefined {
    const wantBase64 = this.#imageMode !== 'url';
    const wantUrl = this.#imageMode !== 'base64';
    const bytes = image.bytes.byteLength;
    const base64 = wantBase64 && bytes > 0 ? Buffer.from(image.bytes).toString('base64') : undefined;
    const url = wantUrl ? image.url : undefined;
    if (base64 === undefined && url === undefined) return undefined;
    if (base64 !== undefined && bytes > this.#maxImageBytes) {
      /*
       * 超限**仍然发**，只告警。
       * 理由是取舍：玩家在等那张角色卡，把它换成一行动画字符（降级）比多花几 MB 内存更糟；
       * 而这条日志能让人知道"队列为什么涨"。
       */
      this.#logger.warn('图片超过配置上限（仍然发送）', {
        bytes,
        limit: this.#maxImageBytes,
        mediaType: image.mediaType,
      });
    }
    return {
      mediaType: image.mediaType,
      ...(base64 !== undefined ? { base64 } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(image.alt !== undefined ? { alt: image.alt } : {}),
    };
  }

  /** 出站唯一出口：进队列 + （在处理上下文中时）记进本次同步返回的那一批 */
  #emit(item: PendingItem): OutboundItem {
    const context = this.#handling.getStore();
    const pending: PendingItem =
      context === undefined || item.platform !== undefined
        ? item
        : { ...item, platform: context.platform };
    const saved = this.#outbox.push(pending, this.#now());
    context?.items.push(saved);
    return saved;
  }
}
