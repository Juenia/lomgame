/**
 * 多通道合成（M2.79）
 *
 * ## 它解决的问题
 *
 * 在此之前一个进程只接**一条**通道（\`ADAPTER=onebot\` 或 \`ADAPTER=qq\`）。
 * 而运营上很自然的需求是「两个入口一起开」：官方机器人是一条正规通道，
 * OneBot（协议端）是另一条 —— 让不同的群从不同的门进来，进的是**同一个世界**。
 *
 * ## 它是怎么做到「回复回到正确的通道」的
 *
 * 业务层（router）只认 \`scene\` + \`targetId\`，它**不知道**这条消息是从哪条通道来的 ——
 * 这是架构铁律（判定层不认识通道），不能为了多通道把它破掉。
 *
 * 所以路由信息留在这一层：**收到消息时记住「这个会话来自哪条通道」**，
 * 发送时按同一把钥匙查回去。
 *
 *     收到 onebot 的群 901372907  → 记 group:901372907 → onebot
 *     稍后 sendGroup('901372907') → 查表 → 走 onebot 发出去
 *
 * 这样 \`InternalMessage\` 与 \`CommandResult\` 一个字段都不用改，
 * 而「同一条通道内部的被动回复凭证（msg_id / ticket）」仍然由各自的适配器管，
 * 这一层只负责转交。
 *
 * ## 查不到的时候怎么办
 *
 * 会有这种情况：机器人**主动**往一个从没收到过消息的会话发东西（比如世界播报到某个群）。
 * 这时按 \`defaultChannel\` 发（默认第一条通道），并把 \`unrouted\` 计数加一 ——
 * 那个计数会在面板上，运维一眼能看出「有多少条是猜着发的」。
 *
 * ## ⚠️ 一条必须说清的边界
 *
 * **两条通道并行 ≠ 同一个玩家两边都能接着玩。**
 *
 * OneBot 的 \`userId\` 是 QQ 号，官方通道的 \`userId\` 是 openid ——
 * 同一个人在两条通道里会被判定层认成**两个不同的玩家**（两个角色、两份进度）。
 * 身份打通需要一层「账号绑定」（在 A 通道把 B 通道的号绑过来），
 * 那是独立的一块，本轮没做。这里做到的是：**两个入口进同一个世界、同一份数据库**。
 */
import type {
  Adapter, ButtonSpec, InternalMessage, MessageHandler, MessageHeader, OutboundImage, Scene,
} from './types.ts';
import type { InteractiveMessage } from './interactive.ts';

export interface AdapterSlot {
  /** 通道名（日志与面板用）：onebot / qq */
  name: string;
  adapter: Adapter;
}

export interface CompositeStats {
  /** 收到并分发给业务层的事件数（按通道分） */
  received: Record<string, number>;
  /** 发送时**查到了**来源通道的次数 */
  routed: number;
  /** 发送时查不到、按默认通道发出去的次数。这个数应当很小 */
  unrouted: number;
}

/** 会话钥匙：scene + id。私聊与群聊的 id 空间不同，所以要带上 scene */
function sceneKey(scene: Scene, id: string): string {
  return scene + ':' + id;
}

export class CompositeAdapter implements Adapter {
  readonly #slots: AdapterSlot[];
  readonly #defaultSlot: AdapterSlot;
  /** 会话 → 通道名。收到消息时写，发送时读 */
  readonly #routes = new Map<string, string>();
  #handler: MessageHandler | null = null;

  readonly stats: CompositeStats = { received: {}, routed: 0, unrouted: 0 };

  constructor(slots: AdapterSlot[], options: { defaultChannel?: string } = {}) {
    if (slots.length === 0) throw new Error('CompositeAdapter 至少要一条通道');
    this.#slots = slots;
    const preferred = options.defaultChannel === undefined
      ? undefined
      : slots.find((s) => s.name === options.defaultChannel);
    // 默认通道 = 显式指定的那条，否则第一条。它只影响「主动推送」这一种情况
    this.#defaultSlot = preferred ?? slots[0]!;
  }

  get slots(): readonly AdapterSlot[] {
    return this.#slots;
  }

  /** 按名字取子适配器（后台要分别问它们的状态） */
  slot(name: string): Adapter | null {
    return this.#slots.find((s) => s.name === name)?.adapter ?? null;
  }

  /**
   * 业务层注册 handler 时，把它接到**每一条**子通道上。
   *
   * 注册动作本身只做一次（业务层眼里只有「一个适配器」），
   * 分发的细节全部留在这一层。
   */
  onMessage(handler: MessageHandler): void {
    this.#handler = handler;
    for (const slot of this.#slots) this.#bind(slot);
  }

  /** 把业务层的 handler 接到一条通道上（新挂上来的也要接，否则它收得到消息也没人处理） */
  #bind(slot: AdapterSlot): void {
    slot.adapter.onMessage(async (msg: InternalMessage) => {
      /*
       * 先记路由再分发：万一 handler 里同步就回了消息，
       * 顺序反了会查不到来源通道、被当成「主动推送」发到默认通道去。
       */
      this.#routes.set(sceneKey(msg.scene, msg.sceneId), slot.name);
      this.#routes.set('user:' + msg.userId, slot.name);
      this.stats.received[slot.name] = (this.stats.received[slot.name] ?? 0) + 1;
      await this.#handler?.(msg);
    });
  }

  /**
   * 运行期挂上一条新通道（M2.83）。
   *
   * 为什么需要它：后台的「启用这条通道」不该要求人改 .env 再重启 ——
   * app.adapter 在启动时就定死了，而 router 攥着的是**同一个对象**，
   * 所以只要这个对象能动态增删通道，「点一下启用、立刻开始收消息」就是可能的。
   */
  addSlot(slot: AdapterSlot): { ok: boolean; reason: string | null } {
    if (this.#slots.some((s) => s.name === slot.name)) {
      return { ok: false, reason: '通道 ' + slot.name + ' 已经在运行了' };
    }
    this.#slots.push(slot);
    if (this.#handler !== null) this.#bind(slot);
    return { ok: true, reason: null };
  }

  /**
   * 摘掉一条通道（停用）。
   *
   * ⚠️ 同时要清掉**路由表里指向它的条目** —— 留着的话，往那个会话发消息会查到一个
   * 已经不在列表里的通道名，然后悄悄落到默认通道上（消息发去了另一条通道，
   * 而人以为这条通道还在）。
   */
  removeSlot(name: string): boolean {
    const index = this.#slots.findIndex((s) => s.name === name);
    if (index < 0) return false;
    this.#slots.splice(index, 1);
    for (const [key, value] of [...this.#routes]) {
      if (value === name) this.#routes.delete(key);
    }
    return true;
  }

  /** 这条通道在不在（后台的启用/停用按钮据此显示状态） */
  hasSlot(name: string): boolean {
    return this.#slots.some((s) => s.name === name);
  }

  #pick(scene: Scene, targetId: string): AdapterSlot {
    const name = this.#routes.get(sceneKey(scene, targetId));
    if (name !== undefined) {
      const hit = this.#slots.find((s) => s.name === name);
      if (hit !== undefined) {
        this.stats.routed += 1;
        return hit;
      }
    }
    this.stats.unrouted += 1;
    return this.#defaultSlot;
  }

  async sendPrivate(userId: string, text: string, header?: MessageHeader | null, buttons?: ButtonSpec[]): Promise<void> {
    // 私聊优先按「这个用户从哪条通道来过」定位，其次按 userId 直接当会话 id 查
    const byUser = this.#routes.get('user:' + userId);
    if (byUser !== undefined) {
      const hit = this.#slots.find((s) => s.name === byUser);
      if (hit !== undefined) {
        this.stats.routed += 1;
        await hit.adapter.sendPrivate(userId, text, header, buttons);
        return;
      }
    }
    await this.#pick('private', userId).adapter.sendPrivate(userId, text, header, buttons);
  }

  /*
   * M2.125：主动推送 = **不借任何被动回复凭证**。
   *
   * 本通道本来就没有「被动回复凭证」这个概念 —— 一条消息发出去就是发出去，
   * 所以这里等价于 sendGroup。真正需要区分的是 QQ 官方通道
   * （那边一张 msg_id 只有 5 条额度，播报借它等于从玩家回执里偷）。
   */
  async sendProactive(scene: Scene, targetId: string, text: string, buttons?: ButtonSpec[]): Promise<void> {
    if (scene === 'private') return this.sendPrivate(targetId, text, null, buttons);
    return this.sendGroup(targetId, text, null, buttons);
  }

  async sendGroup(
    groupId: string,
    text: string,
    header?: MessageHeader | null,
    buttons?: ButtonSpec[],
  ): Promise<void> {
    await this.#pick('group', groupId).adapter.sendGroup(groupId, text, header, buttons);
  }

  async sendChannel(channelId: string, text: string, header?: MessageHeader): Promise<void> {
    await this.#pick('channel', channelId).adapter.sendChannel(channelId, text, header);
  }

  /*
   * 能力位是**合成**的：只要有一条通道支持，业务层就该走那条路。
   * 真正不支持的那条会在 sendInteractive / sendImage 里返回 false，
   * 由调用方降级 —— 这与单通道时「不支持的通道返回 false」是同一条纪律。
   */
  get supportsButtons(): boolean {
    return this.#slots.some((s) => s.adapter.supportsButtons === true);
  }

  get supportsImages(): boolean {
    return this.#slots.some((s) => s.adapter.supportsImages === true);
  }

  get supportsInlineImages(): boolean {
    return this.#slots.some((s) => s.adapter.supportsInlineImages === true);
  }

  async sendInteractive(
    scene: Scene,
    targetId: string,
    message: InteractiveMessage,
    header?: MessageHeader,
  ): Promise<boolean> {
    const slot = this.#pick(scene, targetId);
    if (!slot.adapter.sendInteractive) return false;
    return slot.adapter.sendInteractive(scene, targetId, message, header);
  }

  async sendImage(
    scene: Scene,
    targetId: string,
    image: OutboundImage,
    header?: MessageHeader,
  ): Promise<boolean> {
    const slot = this.#pick(scene, targetId);
    if (!slot.adapter.sendImage) return false;
    return slot.adapter.sendImage(scene, targetId, image, header);
  }

  /**
   * M2.86：把图片交给**这条会话真正在用的通道**去上传换 URL。
   *
   * 转发而不是「挨个问」：上传是**有副作用**的动作（真的会产生一个 COS 对象、
   * 消耗一次接口配额），所以必须只让将要发这条消息的那条通道做
   * —— 这与能力位（`supportsImages` 那种「有一条支持就行」）的合成方式刻意不同。
   */
  async prepareInlineImage(scene: Scene, targetId: string, image: OutboundImage): Promise<string | undefined> {
    const slot = this.#pick(scene, targetId);
    if (!slot.adapter.prepareInlineImage) return undefined;
    return slot.adapter.prepareInlineImage(scene, targetId, image);
  }

  /**
   * 头像直链：先按「这个用户从哪条通道来过」定位，再退化成「挨个问，谁能给就用谁的」。
   *
   * 退化的顺序有讲究：OneBot 只对纯数字 QQ 号给地址（\`/^\d+$/\`），
   * 官方通道对任何 openid 都能拼出地址 —— 所以如果反过来先问官方，
   * 一个 QQ 号会被拼进官方的 URL 里，得到一个**看起来正常但打不开**的头像。
   */
  avatarUrlForUser(userId: string, size?: number): string | undefined {
    const name = this.#routes.get('user:' + userId);
    if (name !== undefined) {
      const hit = this.#slots.find((s) => s.name === name);
      const url = hit?.adapter.avatarUrlForUser?.(userId, size);
      if (url !== undefined) return url;
    }
    for (const slot of this.#slots) {
      const url = slot.adapter.avatarUrlForUser?.(userId, size);
      if (url !== undefined) return url;
    }
    return undefined;
  }

  /** 观测一眼：哪条通道收了多少、有多少条是猜着发的 */
  snapshot(): CompositeStats & { channels: string[] } {
    return { ...this.stats, received: { ...this.stats.received }, channels: this.#slots.map((s) => s.name) };
  }
}
