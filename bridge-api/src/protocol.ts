/**
 * bridge-api 的对外协议（v1）—— 游戏核心与上游机器人框架之间**唯一的**约定。
 *
 * ## 这个版本和原来的版本差在哪
 *
 * 原来的版本自己就是通道：`src/adapter/onebot.ts` 连 OneBot 协议端、
 * `src/adapter/qq-official/` 连 QQ 官方网关。这一版把那一层**整个拿掉**，
 * 换成一组 HTTP 接口：谁把玩家消息送进来、谁把回执取走，由**上游机器人框架**
 * （BEE / Koishi）自己决定。
 *
 * 于是判定层与通道之间只剩这一份数据契约 —— 它必须足够精确，
 * 因为**拼错一个字段名不会报错，只会安静地什么都不发生**。
 *
 * ## 三条硬约束
 *
 * 1. **字段名写错必须当场报错**（所以入站用 `z.strictObject`，不是默认的 strip）。
 *    默认行为是「把不认识的字段悄悄扔掉」—— 上游写成 `userid` 时，
 *    服务端收到的就是一条 userId 为空的消息，随后要么 400、要么更糟：一个空 userId
 *    被当成"另一个玩家"建号。
 * 2. **入站与出站是同一套词汇**：`scene` / `sceneId` / `userId` / `targetId`
 *    在两边的含义逐字相同（私聊 targetId = 好友 id，群聊 = 群号，频道 = 子频道 id）。
 * 3. **回执只走一条路**：所有出站都进同一个有序队列（`outbox.ts`），
 *    同步返回只是"顺手把这一批也塞进响应体"，不是第二条通道 ——
 *    否则「同步模式」和「轮询模式」迟早会有一套丢消息。
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

/**
 * 场景取值与 `src/adapter/types.ts` 的 `Scene` 逐字相同。
 *
 * ⚠️ 不在这里重新起一套名字（比如 `dm` / `guild`）：那样两边就会漂移，
 * 而漂移的代价是「玩家在群里说话，机器人私聊回他」—— 一句错话要查半天。
 */
export const BRIDGE_SCENES = ['private', 'group', 'channel'] as const;
export type BridgeScene = (typeof BRIDGE_SCENES)[number];

/* ------------------------------------------------------------------ *
 * 入站：上游 → 游戏
 * ------------------------------------------------------------------ */

/**
 * 一条玩家消息。
 *
 * `userId` 是**玩家身份的唯一定义**：判定层用它找角色（`characters.findByUserId`）。
 * 所以它有两条要求，写在这里是因为错了以后**不会有任何报错**：
 *
 *   · **稳定**：同一个人每次都要给同一个 id（推荐直接用 QQ 号）；
 *   · **跨框架一致**：同一个人从 BEE 进来、从 Koishi 进来，必须是同一个 id ——
 *     否则他在两个框架下是**两个角色、两份进度**（这条在 M2.79 的跨通道绑定里
 *     已经踩过一次，见 docs/框架现状解读.md 的 B2-11）。
 */
export const inboundSchema = z.strictObject({
  /**
   * **上游框架名**（`bee` / `koishi` / 自定义，≤32 字符），用于审计与出站回源。
   *
   * ⚠️ 别与 `InternalMessage.platform` 混了：那个是**通道类型**，
   * 走这一版进来的消息一律是 `'bridge'`（见 src/adapter/types.ts 的 `Platform`）；
   * 这里是"具体是哪个框架"。
   */
  platform: z.string().min(1).max(32),
  scene: z.enum(BRIDGE_SCENES),
  /** 私聊为好友 id，群聊为群号，频道为子频道 id */
  sceneId: z.string().min(1).max(128),
  /** 玩家的稳定 id（见上面的两条要求） */
  userId: z.string().min(1).max(128),
  nickname: z.string().max(64).optional(),
  /** 消息原文（含前导点号；数字回复也走这里） */
  text: z.string().max(4000),
  /**
   * 幂等键。
   *
   * 不填时服务端用 `platform:sceneId:userId:timestamp` 派生一个 —— 但**强烈建议填**：
   * 上游重发（网络抖动、框架重试）时，只有真实的 message_id 能把两次认成一次。
   */
  messageId: z.string().max(128).optional(),
  /** 毫秒时间戳；不填用服务端时间 */
  timestamp: z.number().int().nonnegative().optional(),
  /**
   * 同步模式：把这条消息触发的回执**同时**放进响应体。
   *
   * 给谁用：像易语言这种不方便做长轮询/长连接的客户端 —— 发一条、拿一条，最简单。
   * ⚠️ 用它就**别同时开轮询**，否则同一条回执会发两遍（回执仍在队列里，
   * 队列语义是「按 seq 取，取到哪儿由上游的游标自己记住」）。
   */
  sync: z.boolean().optional(),
});

/* ------------------------------------------------------------------ *
 * 反向的那一条：上游把「图的公网 URL」交回来
 * ------------------------------------------------------------------ */
/**
 * 上游回传「这张图换回来的 URL」。
 *
 * ⚠️ 这是整份协议里**唯一一条反向的路**（服务端 → 上游 → 回服务端）：
 * 图的字节只有服务端有（那是它渲染出来的），能上传换 URL 的只有上游
 * （QQ 富媒体的凭据在它手里）。两边缺一不可，所以只能来回这一趟。
 *
 * 它换来的是「**图 + 正文 + 按钮塞进一条消息**」—— 官方通道下这是唯一形态：
 * 单发图片（富媒体）与 markdown 正文互斥，分两条发就是用户一直抱怨的老坑。
 *
 * 字段名拼错**不会报错、只会安静地什么都不发生**（开局就立下的那条规矩），
 * 所以这里也用 strictObject。
 */
export const inlineImageSchema = z.strictObject({
  platform: z.string().min(1).max(32),
  /** 出站那条 kind:'upload' 给的号，原样带回来 */
  requestId: z.string().min(1).max(64),
  /** 换到的 URL；传空 = 换不到（服务端回落成「图单独发一条」） */
  url: z.string().max(2048).optional(),
  /** 失败原因，只进日志，不给玩家看 */
  error: z.string().max(300).optional(),
});
export type InboundMessage = z.infer<typeof inboundSchema>;

/* ------------------------------------------------------------------ *
 * 出站：游戏 → 上游
 * ------------------------------------------------------------------ */

/**
 * 消息头（头像 + 昵称 + 途径/序列 + 所在地点）。
 *
 * 与 `src/adapter/types.ts` 的 `MessageHeader` 同源 —— 判定层产出的就是那个结构，
 * 这里只是把它序列化出去。**头像 URL 由服务端补**（`avatarUrl`）：
 * 「这个人在你这条通道上长什么样」只有上游知道（见 `capabilities.avatarTemplate`），
 * 而"这个人是谁"只有判定层知道。
 */
export interface OutboundHeader {
  nickname: string;
  genderTag?: string;
  pathwayLine?: string;
  locationName?: string;
  /** 已经拼好的头像直链（上游直接拿来发图；拿不到就没有这一项） */
  avatarUrl?: string;
}

/** 主动推送的原始按钮（点了等于手打 `command`）—— 与 `ButtonSpec` 同源 */
export interface OutboundButton {
  label: string;
  command: string;
}

/** 菜单选项 —— 与 `InteractiveOption` 同源，平台回传的是 `id` */
export interface OutboundOption {
  id: string;
  label: string;
  /** 完整指令原文（不含前导点号）；诊断用，按钮本身不传它 */
  command: string;
  preview?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface OutboundImagePayload {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** 图片字节的 base64（`BRIDGE_IMAGE_MODE=base64|both` 时才有） */
  base64?: string;
  /** 公网可访问的 URL（`BRIDGE_IMAGE_MODE=url|both` 时才有） */
  url?: string;
  alt?: string;
}

export type OutboundKind = 'text' | 'interactive' | 'image' | 'upload';

/**
 * 「把这张图换成公网 URL」的请求（`kind === 'upload'`）。
 *
 * 这是协议里**唯一一条反向的路**：服务端手上只有图的字节，能上传换 URL 的
 * 只有上游（QQ 富媒体的凭据在它那儿）。所以服务端把图发给上游、等它回传 URL ——
 * 拿到 URL，图就能写成 markdown 里的一行，和正文、按钮一起塞进**一条**消息。
 *
 * 上游拿到 `requestId` 后 `POST /api/v1/inline-image` 回传（见 inlineImageSchema）。
 * 服务端只等 `ttlMs`：超时就当上游换不到，回落成「图单独发一条」——
 * 降级路永远在，不会因为上传失败让玩家什么都看不到。
 */
export interface OutboundUploadRequest {
  requestId: string;
  /** 图的字节（与出站图同一种载荷） */
  image: OutboundImagePayload;
  /** 服务端愿意等多久（毫秒） */
  ttlMs: number;
}

/**
 * 一条回执。
 *
 * `seq` 是队列里的**全序**编号：轮询按它推进游标，同步模式也把它带回去
 * （上游可以把游标直接推到它，避免同一条发两遍）。
 */
export interface OutboundItem {
  seq: number;
  kind: OutboundKind;
  scene: BridgeScene;
  targetId: string;
  text: string;
  /**
   * 这条回执**回给谁**。
   *
   *   · 由某条入站消息触发的 → 定向回那条消息的来源上游（写它的 `platform`）；
   *   · 主动推送（世界播报、事件推送）→ `undefined`，**所有**上游都会拿到，
   *     由它们自己决定发不发（见 docs/API.md 的「两条通道同时在线的口径」）。
   */
  platform?: string;
  header?: OutboundHeader;
  /** 主动推送的原始按钮（世界播报底部那排） */
  buttons?: OutboundButton[];
  /**
   * `kind === 'upload'` 的回执号：上游原样 POST 回 `/api/v1/inline-image`，
   * 服务端才知道「这个 URL 是给哪张图的」。其它 kind 上没有这个字段。
   */
  requestId?: string;
  /** 菜单选项（`kind = 'interactive'` 时才有；平台回传 `id` 走数字回复那条判定路径） */
  options?: OutboundOption[];
  /** 快捷指令按钮（点了把指令插进输入框，没有待答状态） */
  quickButtons?: OutboundButton[];
  /**
   * 末尾那行「0. 自己写一个行为」。
   *
   *   · `undefined` —— 用默认文案（玩家可以自由输入一句行为）；
   *   · `null` —— **不要这一行**（业务层显式关掉）。
   *
   * 为什么必须传出来：上游要自己把选项渲染成文本（声明了 buttons 时），
   * 少了这一位就**分不出**"用默认文案"和"不要这行" —— 而这两件事在
   * 判定层是**不同**的（见 src/adapter/interactive.ts 的 freeformLabel）。
   */
  freeformLabel?: string | null;
  image?: OutboundImagePayload;
  createdAt: number;
}

/* ------------------------------------------------------------------ *
 * 能力协商
 * ------------------------------------------------------------------ */

/**
 * 上游声明「我这条通道能做什么」。
 *
 * ## 为什么必须由上游说，而不是服务端写死
 *
 * 同一份文案在不同框架上必须有不同形态 —— 这不是风格问题，是**能不能用**的问题：
 *
 *   · 能摆原生按钮的 → 选项进按钮，正文切掉选项清单（否则信息尾太长）；
 *   · 只能发纯文本的（易语言插件）→ 走 M2.3 的数字回复，正文里必须有 `1. xxx`。
 *
 * 缺省值一律**取最保守的那一档**（不能摆按钮、不能内联图、不能富文本）：
 * 猜错的代价是玩家看到一堆 markdown 源码或点了没反应的按钮，而保守档永远能用。
 */
export const capabilitiesSchema = z.strictObject({
  platform: z.string().min(1).max(32),
  /** 能不能摆原生按钮。缺省 false = 回退文本菜单（与 OneBot 通道同一档） */
  buttons: z.boolean().optional(),
  /** 能不能发图。缺省 true —— 上游框架基本都能发图，关了会让角色卡永远出不来 */
  images: z.boolean().optional(),
  /** 能不能把图**写进正文**（而不是另发一条）。缺省 false */
  inlineImages: z.boolean().optional(),
  /**
   * 能不能**把图上传换成公网 URL**（`POST /api/v1/inline-image` 回传）。缺省 false。
   *
   * 声明了它，服务端才会问上游「这张图能不能换成一个能写进 markdown 的 URL」。
   * 换来的是「图 + 正文 + 按钮」合成**一条**消息 —— 不声明就只能图一条、正文一条。
   * 判断依据是上游**有没有上传能力**：QQ 官方通道有（富媒体），OneBot 没有。
   */
  inlineUpload: z.boolean().optional(),
  /** 能不能渲染富文本标签（`<font color>` 之类）。缺省 false */
  richText: z.boolean().optional(),
  /**
   * 头像直链模板，形如 `https://q1.qlogo.cn/g?b=qq&nk={userId}&s={size}`。
   *
   * 支持的占位符：`{userId}` / `{size}`。不填 = 上游给不出头像，
   * 卡片会退回「首字纹章」（与拿不到头像的老通道同一条降级路）。
   */
  avatarTemplate: z.string().max(256).optional(),
});
/**
 * 上游上报**管理员名单**（M2.172）。
 *
 * ## 为什么由上游报，而不是让运营去改游戏机的 .env
 *
 * 管理员是「在 QQ 上按 id 认」的，而那条通道上的 id 长什么样只有上游最清楚
 * （OneBot 下是 QQ 号，QQ 官方通道下是 openid）。让运营在机器人框架的设置页里填，
 * 比要求他们去改游戏机的配置直觉得多。
 *
 * ⚠️ 这是**上报**不是**权威**：内核自己那份名单（.env 的 ADMIN_IDS）不受影响，
 * 两边取并集。插件挂了、没上报，管理员指令照样能用。
 *
 * ⚠️ 同一个 `platform` 重复上报 = **覆盖它自己那一路**（不会累积）。
 * 所以插件启动时全量报一次即可，改了配置再报一次。
 */
export const adminsSchema = z.strictObject({
  platform: z.string().min(1).max(32),
  /** 管理员 id 列表（QQ 号或 openid）。上限 200 是防呆：真配不了这么多 */
  adminIds: z.array(z.string().min(1).max(64)).max(200),
});
export type AdminReport = z.infer<typeof adminsSchema>;

export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** 补齐缺省值后的能力快照（服务端内部用） */
export interface ResolvedCapabilities {
  buttons: boolean;
  images: boolean;
  inlineImages: boolean;
  inlineUpload: boolean;
  richText: boolean;
  avatarTemplate?: string;
}

/** 最保守的一档：谁都没声明时按这个走（与 OneBot 通道的表现完全一致） */
export const DEFAULT_CAPABILITIES: ResolvedCapabilities = {
  buttons: false,
  images: true,
  inlineImages: false,
  inlineUpload: false,
  richText: false,
};

/* ------------------------------------------------------------------ *
 * 响应
 * ------------------------------------------------------------------ */

export interface InboundResponse {
  ok: true;
  /**
   * 这条消息真的交给判定层了吗。
   *
   * false 只有一种情况：服务端**还没装上消息处理器**（启动中断 / 正在关闭）。
   * 幂等命中的重复投递**不算 false** —— 它在判定层里被正常处理了、只是没产生回执，
   * 而这两件事从上游看是分不开的；硬塞一个字段只会让上游做错判断。
   */
  accepted: boolean;
  /** 同步模式下这一条触发的回执（`sync: true` 时才有） */
  replies?: OutboundItem[];
  /** 同步模式下这批回执里最大的 seq —— 上游可以直接把游标推到它 */
  cursor?: number;
}

export interface OutboundResponse {
  ok: true;
  items: OutboundItem[];
  /** 下次轮询带上的游标（= 本次最后一条的 seq，没数据时原样返回） */
  cursor: number;
  /**
   * 游标太旧，中间那段已经被队列裁剪掉了。
   *
   * 出现它说明上游离线太久（队列默认只留最近 500 条）—— 这是一个**需要被看见**的事件，
   * 所以它是响应里的显式字段，而不是靠上游自己比对序号去猜。
   */
  gap?: boolean;
  /** 队列里最早还留着的那条 seq（`gap` 时可以跳到它） */
  earliest?: number;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  /** 哪个字段不对（入参校验失败时） */
  issues?: string[];
}
