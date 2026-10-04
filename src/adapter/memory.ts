import type { Adapter, ButtonSpec, InternalMessage, MessageHandler, MessageHeader, OutboundImage } from './types.ts';
import type { InteractiveMessage } from './interactive.ts';

export interface SentMessage {
  scene: InternalMessage['scene'];
  targetId: string;
  text: string;
  /** M2.47：这条消息带的一张图（只有图片通道发送时才有） */
  image?: OutboundImage;
  /**
   * M2.7：这条消息携带的选项（只有按钮通道发送时才有）。
   * 测试据此断言「同一份 InteractiveMessage 在两种 Adapter 下选项完全一致」。
   */
  interactive?: InteractiveMessage;
}

export interface MemoryAdapterOptions {
  /**
   * 是否模拟「支持按钮的通道」（官方机器人）。
   * 默认 false = 模拟 OneBot，走文本降级 —— 与 M2.3 起的既有行为完全一致。
   */
  supportsButtons?: boolean;
  /**
   * 是否模拟「能发图的通道」。默认 false。
   *
   * 默认关是有意的：**绝大多数内测通道发不了图**（官方群机器人要富媒体上传），
   * 所以"默认不能发"才是真实的那一侧 —— 让降级路径成为测试里最常走的那条。
   */
  supportsImages?: boolean;
  /**
   * 是否模拟「能把图片写进正文的通道」（官方 markdown）。
   * 默认 false = 图片只能另发一条，与 OneBot 一致。
   */
  supportsInlineImages?: boolean;
  /**
   * M2.86：模拟「**通道自己能把图上传播**成正文可用的 URL」——
   * 给了它就返回这个 URL（官方通道的 `raw_url` 等价物）。
   *
   * 不给 = 这条通道没有这个能力（OneBot / 内存通道的默认形态），
   * 调用方会走既有降级（富媒体直发 / 文字卡）。
   */
  inlineImageUrl?: string;
}

/**
 * 内存适配器：W1 的联调与压测替身，也用于 scripts/demo.ts 打印完整对话。
 * 不属于 S1 目录树，属于测试/开发支撑（已在交付说明中登记）。
 *
 * M2.7 起它还能扮演两种通道：默认是 OneBot（降级文本），
 * 打开 supportsButtons 就是官方机器人（原生按钮）。两条路可以拿同一份 InteractiveMessage 对拍。
 */
export class MemoryAdapter implements Adapter {
  sent: SentMessage[] = [];
  readonly supportsButtons: boolean;
  readonly supportsImages: boolean;
  readonly supportsInlineImages: boolean;
  /**
   * M2.86：通道自传图片的**调用记录**。
   * 用它断言「同一张图不该重复上传」（缓存真的生效了）。
   */
  uploads: OutboundImage[] = [];
  #inlineImageUrl: string | undefined;
  #handler: MessageHandler | null = null;

  constructor(options: MemoryAdapterOptions = {}) {
    this.supportsButtons = options.supportsButtons === true;
    this.supportsImages = options.supportsImages === true;
    this.supportsInlineImages = options.supportsInlineImages === true;
    this.#inlineImageUrl = options.inlineImageUrl;
  }

  onMessage(handler: MessageHandler): void {
    this.#handler = handler;
  }

  async deliver(msg: InternalMessage): Promise<void> {
    if (this.#handler) await this.#handler(msg);
  }

  async sendPrivate(userId: string, text: string): Promise<void> {
    this.sent.push({ scene: 'private', targetId: userId, text });
  }

  async sendGroup(groupId: string, text: string, _header?: MessageHeader | null, _buttons?: ButtonSpec[]): Promise<void> {
    this.sent.push({ scene: 'group', targetId: groupId, text });
  }

  async sendChannel(channelId: string, text: string): Promise<void> {
    this.sent.push({ scene: 'channel', targetId: channelId, text });
  }

  /**
   * 按钮通道：把结构化选项一并记下来。
   * 不支持按钮时返回 false —— 调用方会回退成 sendPrivate(text)，与老通道一字不差。
   */
  async sendInteractive(
    scene: InternalMessage['scene'],
    targetId: string,
    message: InteractiveMessage,
  ): Promise<boolean> {
    if (!this.supportsButtons) return false;
    this.sent.push({ scene, targetId, text: message.text, interactive: message });
    return true;
  }

  /**
   * 图片通道：把图记进 sent（`text` 留空，断言时用 `image` 字段）。
   * 不支持图片时返回 false —— 调用方会回退成文本，与老通道一字不差。
   */
  async sendImage(
    scene: InternalMessage['scene'],
    targetId: string,
    image: OutboundImage,
  ): Promise<boolean> {
    if (!this.supportsImages) return false;
    this.sent.push({ scene, targetId, text: '', image });
    return true;
  }

  /**
   * M2.86：模拟官方通道「上传图片换 `raw_url`」。
   *
   * 没配 `inlineImageUrl` 时返回 undefined（= 这条通道没这个能力），
   * 与真实通道「上传失败」走的是同一条降级路 —— 调用方不该区分这两者。
   */
  async prepareInlineImage(
    _scene: InternalMessage['scene'],
    _targetId: string,
    image: OutboundImage,
  ): Promise<string | undefined> {
    if (this.#inlineImageUrl === undefined) return undefined;
    this.uploads.push(image);
    return this.#inlineImageUrl;
  }

  take(): SentMessage[] {
    const out = this.sent;
    this.sent = [];
    return out;
  }
}
