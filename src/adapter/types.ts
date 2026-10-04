/**
 * 接入抽象（S1 交付物二 —— src/adapter/types.ts）
 * 业务层只认 InternalMessage，不认 OneBot / 官方协议。
 *
 * M2.7 增补：接入层同时负责「选项怎么渲染」——
 * 业务层产出 InteractiveMessage（纯数据），通道要么摆原生按钮，要么降级成文本菜单。
 * 两条路的语义一致（按钮回传的就是选项 id），详见 src/adapter/interactive.ts。
 */
import type { InteractiveMessage } from './interactive.ts';

/**
 * 通道来源。
 *
 * M2.104：新增 `bridge` —— 「无适配器 / 纯 API 版」（`bridge-api/`）的消息来自
 * **第三方机器人框架**（BEE / Koishi 等）转发，它既不是 OneBot 直连、也不是 QQ 官方直连。
 *
 * 判定层**从不读这个字段**（它只用于排查、审计与幂等键），所以加一个成员不改变任何既有行为。
 */
export type Platform = 'onebot' | 'official' | 'bridge';
export type Scene = 'private' | 'group' | 'channel';

export interface InternalMessage {
  messageId: string;
  platform: Platform;
  scene: Scene;
  /** 私聊为好友 id，群聊为群号，频道为子频道 id */
  sceneId: string;
  userId: string;
  nickname: string;
  rawText: string;
  timestamp: number;
}

export type MessageHandler = (msg: InternalMessage) => Promise<void> | void;

/**
 * 消息头（M2.45，用户指定版式）：**所有富文本回执**统一顶上这一段 ——
 *
 *     [头像]  **昵称** ♂
 *     愚者 · 序列 9
 *     ────────────
 *
 * 为什么要统一：群里同时有好几个人在玩，机器人每条回执长得一模一样，
 * 玩家分不清哪条是自己的（真机反馈的原话）。
 *
 * ⚠️ **头像不在这里**：它是一条 `q.qlogo.cn/qqapp/{appid}/{openid}` 直链，
 * 只有通道知道自己 appId 和平台发下来的 openid —— 由通道侧补上（见 official.ts）。
 * 判定层只负责「这个人叫什么、什么性别、走到哪一步了」。
 */
/**
 * **主动推送的按钮**（M2.86）。
 *
 * 与 `InteractiveOption` 的关键区别：
 *   · `InteractiveOption` 的 `id` 是**菜单数字 key**（'1'/'2'），平台回传后走
 *     `MENU_REPLY` → `pendingMenus.pick()` —— **需要一条待答菜单**。
 *     主动推送没有待答菜单，所以那个 id 回传后无人认领。
 *   · 这里的 `command` 是**完整指令原文**，按钮的 `data` 直接带它，
 *     平台回传后调方**当指令执行**，不查任何菜单状态。
 *
 * 这就是「事件底部附按钮」能成立的原因：每条推送的按钮各自带着自己的指令，
 * 多条推送同时在场也互不干扰。
 */
export interface ButtonSpec {
  /** 按钮文字（官方限制最多 10 个字符） */
  label: string;
  /** 完整指令原文（不含前导点号），点了等于手打这条 */
  command: string;
}

export interface MessageHeader {
  nickname: string;
  /** 性别图标（`♂` / `♀`），未设置时为空 */
  genderTag?: string;
  /** 「愚者 · 序列 9」，或未入途径时的「还没有途径」 */
  pathwayLine?: string;
  /**
   * M2.86：**发言人的平台用户 id**（官方通道是 openid），用来取头像。
   *
   * 为什么必须由业务侧给：通道只知道这条消息发往哪个会话 ——
   * **私聊**时 targetId 就是对方，**群聊**时 targetId 是**群的 openid**，
   * 从它推不出发言人的头像。而这正是第一版「群里画不出头像」的原因。
   */
  avatarUserId?: string;
  /**
   * M2.86：**所在地点**（信息条图片的第二行）。
   *
   * 为什么由业务侧给而不是通道自己查：通道不认识角色卡，也不知道他现在站在哪。
   * 缺它时信息条就退化成「头像 + 昵称 + 性别」——仍然出图，只是少一行。
   */
  locationName?: string;
}

/**
 * 待发送的一张图（M2.47）。
 *
 * 为什么是 `bytes` 而不是路径：通道两侧拿到的形态根本不同 ——
 * OneBot 要 base64 内联进 CQ 码，官方通道要先上传拿 file_info，
 * 而"本地路径"对两者都没用（进程可能不在同一台机器上）。
 * 统一成字节，由各通道自己决定怎么投递。
 */
export interface OutboundImage {
  bytes: Uint8Array;
  /** 通道只用它推断格式/文件名，不参与寻址 */
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** 无障碍替换文本（官方 markdown 的 `![alt](url)` 用得上） */
  alt?: string;
  /**
   * **公网可访问**的图片 URL（M2.47）。
   *
   * 为什么字节之外还要带它：两种通道的投递方式根本不同 ——
   *   · OneBot：把 `bytes` 编成 base64 内联进 CQ 码；
   *   · QQ 官方：markdown 图片语法要一个**公网 url**（平台自己下载转存），本地字节对它没用。
   * 所以谁需要什么由自己挑：OneBot 用 bytes，官方用 url。
   */
  url?: string;
}

export interface Adapter {
  onMessage(handler: MessageHandler): void;
  /*
   * M2.45：三个发送方法都收一个**可选**的 `header`。
   * 可选是为了不破坏既有通道 —— OneBot / 内存通道忽略它就行，
   * 而那些通道本来也没有富文本可言（降级是正常路径，与按钮同一条纪律）。
   */
  /**
   * M2.86：**这条通道支不支持富文本标签**（`<font color>` 之类）。
   *
   * 为什么必须是**通道能力**而不是全局开关：
   *
   *   · OneBot（个人号：NapCat / Lagrange 等）→ 发的是**普通消息**，
   *     富文本标签直接进 content，**手机电脑都渲染**（用户实机看到的「云助手」就是这个）；
   *   · 官方 QQ Bot → 走 `msg_type: 2` 的 markdown，**白名单里没有颜色**
   *     （官方文档「支持格式」清单：标题/加粗/下划线/斜体/删除线/链接/图片/列表/引用/分割线，没有颜色）。
   *
   * 同一份文案在两条通道上必须有不同表现，这只能是通道自己说了算。
   */
  readonly supportsRichText?: boolean;

  /* ---------------- M2.86：主动推送的按钮 ---------------- */

  /** 主动推送可用的按钮（与 InteractiveOption 的区别见 ButtonSpec 的注释） */
  /*
   * `header` 的三态（M2.86）：
   *   · `undefined` —— 自动：通道按被动回复凭证里的 userId 生成头像与昵称；
   *   · `MessageHeader` —— 业务侧补充性别 / 途径序列；
   *   · **`null` —— 明确不要信息头**。世界播报走这条（用户：
   *     「主动推送不应该带信息头」）：世界在说话，不是某个玩家在说话，
   *     顶上挂一个玩家头像会让人以为那是他自己的消息。
   */
  /*
   * `buttons`（M2.86）：**主动推送也要能带原始按钮**（用户：「事件底部附带对应的原始按钮」）。
   *
   * 官方现行文档里 `keyboard` 是**与 `msg_id` 平级的独立可选参数** ——
   * 不传 `msg_id` 就是主动消息，照样能带键盘。所以这条路是通的。
   *
   * 按钮走 `action.type = 1`（回调按钮）：平台推 `INTERACTION_CREATE`、`data` 原样回传，
   * **不经过 `pendingMenus`** —— 这正是「多条推送各带各的按钮」能成立的原因。
   */
  sendPrivate(userId: string, text: string, header?: MessageHeader | null, buttons?: ButtonSpec[]): Promise<void>;
  sendGroup(groupId: string, text: string, header?: MessageHeader | null, buttons?: ButtonSpec[]): Promise<void>;
  sendChannel(channelId: string, text: string, header?: MessageHeader | null): Promise<void>;
  /**
   * **主动推送**（世界播报、事件推送）—— 与上面两条的区别既是语义的，也是纪律的：
   * **它不许借任何被动回复凭证。**
   *
   * 为什么单开一条（M2.125，用户口径：「本质上他就不能是被动回复，这里参考 koishi
   * 的 QQ 适配器」）：
   *
   *   · 被动回复的额度是**玩家的** —— 一条玩家消息 = 一张 `msg_id` = 群聊 5 条。
   *     播报借它，等于从玩家自己的回执里偷：三个群的世界播报跑一轮，
   *     玩家那条 `.状态` 就可能发不出来，而报出来的错还是「没有主动推送凭证」，
   *     指向完全错误的方向（M2.124 查了三轮才落到这里）。
   *   · koishi 的 adapter-qq 里，主动推送走 `bot.sendMessage`（没有 session ⇒
   *     不带 `msg_id`），**从来不借凭证**；借凭证只发生在 `session.send()`，
   *     也就是「回复某个人刚说的那句话」。这里对齐它。
   *
   * 实现上就是「用空凭证发」：QQ 官方那边对应官方文档里的**主动消息**
   * （无任何条件、不吃被动额度，只受每天 1000 条/群的频控）；
   * OneBot / 内存通道本来就没有凭证这个概念，等价于 `sendGroup`。
   */
  sendProactive?(scene: Scene, targetId: string, text: string, buttons?: ButtonSpec[]): Promise<void>;

  /* ---------------- M2.7：按钮交互 ---------------- */

  /**
   * 这个通道能不能摆原生按钮。
   * 缺省（undefined）按 false 处理 = 走文本降级 —— 老通道/第三方框架什么都不用改。
   */
  readonly supportsButtons?: boolean;

  /**
   * 带选项的发送。
   *
   * 返回值即契约：
   *   - `true`：这条消息**已经**由按钮通道发出（可能同时带了正文）；
   *   - `false`：本通道不摆按钮，请调用方回退到 sendPrivate / sendGroup 发纯文本。
   *
   * 为什么用「返回 false 回退」而不是「抛异常」：降级是**正常路径**而不是错误 ——
   * OneBot 占内测通道的绝大多数，它每次都会走降级分支。
   */
  sendInteractive?(
    scene: Scene,
    targetId: string,
    message: InteractiveMessage,
    header?: MessageHeader,
  ): Promise<boolean>;

  /* ---------------- M2.47：图片 ---------------- */

  /**
   * 这个通道能不能发图。
   * 缺省（undefined）按 false 处理 = 调用方走文本降级 —— 与按钮同一条纪律：
   * 不支持的通道什么都不用改，玩家也**不会**因此少拿到信息（文字状态卡一直在）。
   */
  readonly supportsImages?: boolean;

  /**
   * 这个通道能不能把图片**放进正文里**（而不是另发一条）。
   *
   * 为什么与 `supportsImages` 分开（M2.45 第十三版，用户：「别人是合并一起发出来，
   * 你是分开来发的」）：
   *   · 官方 markdown 通道**没有**"发一张图"的独立接口 —— 图就是正文里的一行
   *     `![alt #宽px #高px](url)`，所以它天生能把「图 + 文字 + 按钮」并成一条消息；
   *   · OneBot 的图片是独立的 CQ 码消息 —— 它 `supportsImages` 为真，但**内嵌不了**。
   * 只有这一位为真，调用方才会把图片行写进正文（否则会看到 markdown 源码）。
   */
  readonly supportsInlineImages?: boolean;

  /**
   * 发一张图。
   *
   * 返回值即契约（与 `sendInteractive` 同构）：
   *   - `true`：已发出；
   *   - `false`：本通道发不了，请调用方回退到文本。
   *
   * 为什么不用异常表达「不支持」：除 OneBot 外的通道每次都会走降级分支，
   * 那是**正常路径**而不是错误。
   */
  sendImage?(
    scene: Scene,
    targetId: string,
    image: OutboundImage,
    header?: MessageHeader,
  ): Promise<boolean>;

  /**
   * 把一张图**交给通道自己上传**，换一个能写进 markdown 正文的 URL（M2.86）。
   *
   * ## 为什么需要这一位
   *
   * 官方 markdown 的图片要求 URL 落在平台的 **SSRF 白名单**里（九个腾讯域名，
   * 见 `src/card/media-host.ts`）。外部图床、自建托管**全部不在名单里** ——
   * 真机一律裂图（uguu / picui / jsDelivr / 自建域名，四次实测）。
   *
   * 于是只剩一条路：**让平台自己当图床**。官方富媒体上传接口
   * （`srv_send_msg: false`，只上传不发送）返回的 `raw_url` 是
   * `qqbot-file-upload-…cos.accelerate.myqcloud.com` —— `*.myqcloud.com` 正好在名单里。
   *
   * ⚠️ **上传分片时必须带 `content-type`**（实测决定成败的一步，见下）：
   *   · 不带 → COS 把对象存成 `application/octet-stream`，平台抓到不认 ⇒ **裂图**（实验A）；
   *   · 带 `image/png` → 对象的 `content-type` 就是 `image/png`，平台转存 ⇒ **正常显示**（实验C）。
   * `q-header-list=host` 的预签名只覆盖 host，所以这个 header 加得上。
   * `x-cos-force-download: true` 与 `content-disposition: attachment` **不影响**转存，
   * 别被它们误导（第一版就是这么误判的）。
   *
   * ## 返回值即契约（与 `sendImage` 同构）
   *   - `string`：可直接写进 `![alt #宽px #高px](url)`；
   *   - `undefined`：本通道没有这个能力，或上传失败 ⇒ 调用方走既有降级
   *     （富媒体直发 / 文字卡），**不抛异常**。
   */
  prepareInlineImage?(
    scene: Scene,
    targetId: string,
    image: OutboundImage,
  ): Promise<string | undefined>;

  /* ---------------- M2.47：头像直链 ---------------- */

  /**
   * 取「这个玩家在这条通道里的头像直链」。
   *
   * 为什么由通道回答：头像地址是**平台相关**的 ——
   *   · QQ 官方：`https://q.qlogo.cn/qqapp/{appId}/{openid}/{size}`
   *     （appId 只有通道知道，openid 就是它的 userId）
   *   · OneBot：`https://q1.qlogo.cn/g?b=qq&nk={qq}&s={size}`
   * 路由层不该认识这两套 URL —— 它只问「有没有」，拿不到就画首字纹章。
   *
   * 返回 undefined = 这条通道给不出（或这个用户没有），**不是错误**。
   */
  avatarUrlForUser?(userId: string, size?: number): string | undefined;
}
