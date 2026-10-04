import type { Adapter, ButtonSpec, InternalMessage, MessageHandler, MessageHeader, OutboundImage, Scene } from './types.ts';
import type { HttpPost } from './onebot.ts';
import { defaultHttpPost } from './onebot.ts';
import {
  chunkOptions,
  foldOptions,
  foldNote,
  renderInteractiveText,
  type InteractiveMessage,
} from './interactive.ts';
import { BUTTON } from '../config/numeric.ts';

/**
 * 官方 QQ 机器人适配器。
 *
 * W1 只完成事件映射，发送侧故意留空 —— 官方开放平台的 msg_id / msg_seq 规则
 * 必须用真实报文校准，在没有通过审核、拿不到真实事件之前写出来的发送逻辑只是「看起来对」。
 *
 * M2.7 补齐两件事（都是**接口先行、真机待校准**，不是假装实测过）：
 *   1. 原生按钮：InteractiveMessage → keyboard 结构，action.data = 选项 id（数字）；
 *      点击后官方推送 INTERACTION_CREATE，本文件把它映射成 rawText = 那个数字的 InternalMessage。
 *      于是「点按钮」与「回数字」在服务端**是同一条路径**（MENU_REPLY），行为必然一致。
 *   2. 发送：只做「配置齐全才发」的保守实现 —— 没给 apiBase/post 就返回 false 走文本降级，
 *      绝不假装发成功。真机接入后按真实报文校准 msg_id / msg_seq（见 docs/M2.7-交付说明.md 遗留项）。
 */
export interface OfficialConfig {
  appId: string;
  /** 上报校验用，官方平台在 Webhook 握手时会带上 */
  token?: string;
  /** 机器人 access token（获取方式随平台版本变，真机接入时填） */
  accessToken?: string;
  /** 开放平台 API 基址，默认官方域名 */
  apiBase?: string;
  timeoutMs?: number;
}

/** 官方开放平台按钮的渲染样式（0 = 灰线，1 = 蓝线） */
export type OfficialButtonStyle = 0 | 1;

interface OfficialEventLike {
  /** 事件类型（webhook v2 用 t 字段） */
  t?: string;
  post_type?: string;
  id?: string;
  content?: string;
  timestamp?: string | number;
  group_openid?: string;
  author?: {
    id?: string;
    member_openid?: string;
    union_openid?: string;
    username?: string;
  };
  /** 频道事件用 */
  channel_id?: string;
  guild_id?: string;
  /** INTERACTION_CREATE 的数据体 */
  d?: OfficialInteractionLike;
}

interface OfficialInteractionLike {
  id?: string;
  type?: number;
  group_openid?: string;
  channel_id?: string;
  guild_id?: string;
  timestamp?: string | number;
  user_openid?: string;
  data?: {
    type?: number;
    resolved?: {
      button_data?: string;
      button_id?: string;
      user_id?: string;
      /** 部分版本把操作者放在这里 */
      user_openid?: string;
    };
    user_id?: string;
  };
  /** M2.44 真机：群聊场景的操作者在这里（不在 `data.resolved.user_id` 里） */
  group_member_openid?: string;
}

/**
 * 取第一个**非空**的 openid；全空时返回空串。
 *
 * ## ⚠️ 为什么不能用 `??` 链（M2.99 真机现场）
 *
 * 官方 C2C 事件的 payload 里，`author.union_openid` 是**空字符串**（字段在、值为空）：
 *
 * ```json
 * "author":{"bot":false,"id":"7A34…","union_openid":"","user_openid":"7A34…","username":""}
 * ```
 *
 * 而 `??` 只跳过 `null` / `undefined` —— 遇到 `""` 就停下。于是
 * `union_openid ?? user_openid` 得到的是 **空串**，下游 `if (!userId) return null`
 * 接着把整条消息丢掉：玩家私聊发 `.状态` **没有任何反应**，日志里连一行「为什么丢」都没有。
 *
 * 互动事件（按钮点击）的取值链同一个道理：`resolved.user_id` 若是空串，
 * 后面的 `group_member_openid` 就永远轮不到 —— 表现同样是「点了按钮没反应」。
 *
 * 判据一句话：**取 openid 一律走这个函数，不要写 `??` 链。**
 *
 * 放在协议层是因为**两条通道的映射都要用它**（`adapter/official.ts` 与
 * `adapter/qq-official/index.ts`）—— 写两份的话，早晚只修一处。
 */
export function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} 尚未实现（等待官方机器人审核通过后按真实报文接入）`);
    this.name = 'NotImplementedError';
  }
}

/**
 * INTERACTION_CREATE → InternalMessage。
 *
 * 关键约定：按钮的 `button_data` **就是菜单选项 id（数字）**，
 * 所以这里把它当成玩家发出的那条消息正文 —— 服务端随后走 parseNumericReply，
 * 命中 pending_menus 里同一个选项。按钮与文本菜单因此共享同一条执行路径。
 */
export function mapOfficialInteraction(payload: unknown): InternalMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as OfficialEventLike;
  const type = event.t ?? event.post_type;
  if (type !== 'INTERACTION_CREATE' && type !== 'interaction') return null;
  const data = event.d ?? (payload as OfficialInteractionLike);
  const resolved = data.data?.resolved ?? {};
  const buttonData = resolved.button_data ?? resolved.button_id ?? '';
  if (!buttonData) return null;

  /*
   * 操作者 id —— M2.44 真机实测：**群聊场景在 `d.group_member_openid`**。
   *
   * 官方的事件示例里只写了 `data.resolved.button_data`（群聊那一条连 user_id 都没有），
   * 而这份代码早先只找 `resolved.user_id` ⇒ 取不到 ⇒ `return null` ⇒
   * **事件收到了、被静默丢掉，日志里只有一个「收到事件」**（真机现象：点按钮没反应）。
   * 取值链按「越具体越优先」排：resolved 里的 > 群成员 > 单聊用户。
   */
  /*
   * ⚠️ M2.99：这里同样**不能写 `??` 链** —— 空串会截断它（真机 C2C payload 里
   * `union_openid` 就是空串，与私聊静默是同一个根因）。空串要跳过，继续往后找。
   */
  const userId = firstNonEmpty(
    resolved.user_id,
    resolved.user_openid,
    data.data?.user_id,
    data.group_member_openid,
    data.user_openid,
  );
  if (!userId) return null;

  let scene: Scene = 'private';
  let sceneId = userId;
  const groupOpenid = data.group_openid ?? event.group_openid;
  const channelId = data.channel_id ?? event.channel_id;
  if (groupOpenid) {
    scene = 'group';
    sceneId = groupOpenid;
  } else if (channelId) {
    scene = 'channel';
    sceneId = channelId;
  }

  const raw = typeof data.timestamp === 'string' ? Number(data.timestamp) : (data.timestamp ?? Date.now());

  return {
    messageId: `official:interaction:${data.id ?? buttonData}`,
    platform: 'official',
    scene,
    sceneId,
    userId,
    nickname: '',
    // 按钮点下去 = 替玩家发出「选项 id」这条消息（数字回复体系不变）
    rawText: String(buttonData),
    timestamp: raw,
  };
}

/** 官方 Webhook 事件 → InternalMessage；未实测，字段名按官方文档，接入时需校准 */
export function mapOfficialEvent(payload: unknown): InternalMessage | null {
  const interaction = mapOfficialInteraction(payload);
  if (interaction) return interaction;
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as OfficialEventLike;
  const messageId = event.id;
  const content = event.content ?? '';
  // M2.99：同样跳过空串；顺带补上 union_openid（官方 webhook 的 author 也可能带它）
  const userId = firstNonEmpty(event.author?.id, event.author?.member_openid, event.author?.union_openid);
  if (!messageId || !userId) return null;

  let scene: InternalMessage['scene'] = 'private';
  let sceneId = userId;
  if (event.group_openid) {
    scene = 'group';
    sceneId = event.group_openid;
  } else if (event.channel_id) {
    scene = 'channel';
    sceneId = event.channel_id;
  }

  const timestamp =
    typeof event.timestamp === 'string' ? Number(event.timestamp) : (event.timestamp ?? Date.now());

  return {
    messageId: `official:${messageId}`,
    platform: 'official',
    scene,
    sceneId,
    userId,
    nickname: event.author?.username ?? '',
    rawText: content.replace(/^\s*/, ''),
    timestamp,
  };
}

/**
 * 官方按钮的点击行为（M2.44 按官方文档补齐）。
 *
 *   1 = **回调按钮**：点击后平台推 `INTERACTION_CREATE`，`data` 原样带回后台；
 *   2 = 指令按钮：只把「@bot data」插进输入框，玩家还要自己按发送，**不产生任何事件**。
 */
export type OfficialButtonActionType = 1 | 2;

export interface KeyboardButton {
  id: string;
  render_data: { label: string; visited_label: string; style: OfficialButtonStyle };
  action: {
    type: OfficialButtonActionType;
    permission: { type: 2 };
    data: string;
    /**
     * ⚠️ 官方文档里这里是 **string**（版本过低时的提示文案）。
     * M2.44 之前写的是 `{ title, content }` 对象 —— 真机会因为字段类型不符报错。
     */
    unsupported_tips: string;
  };
}

export interface KeyboardPayload {
  content: { rows: Array<{ buttons: KeyboardButton[] }> };
}

/**
 * InteractiveMessage → 官方 keyboard。
 *
 * 三条约束都来自平台：
 *   - 按钮必须按行分组（每行 1—5 个，这里用 BUTTON.maxPerRow 收窄到 3，手机上更好点）；
 *   - 一屏按钮总数有限（BUTTON.maxTotal），超出的**不生成二级键盘**——
 *     它们仍在正文文本里，玩家可以回数字选（见 interactive.ts 的 foldOptions 说明）；
 *   - 禁用态用 style 0（灰线）+ unsupported_tips 表达：官方不支持「点了没反应」，
 *     必须给玩家一句为什么。
 */
/**
 * M2.86：**指令按钮**（`action.type = 2`）。
 *
 * 与选项按钮（type=1）的关键差别 —— 这两条都有真机依据：
 *   · type=1 **回调按钮**：点击后平台推 `INTERACTION_CREATE`，后台**必须**
 *     `PUT /interactions/{id}` 回应，否则客户端一直 loading（M2.44 的既有结论）。
 *     它是给「选项 / 待答问题」用的。
 *   · type=2 **指令按钮**：只把 `@bot <data>` 插进输入框，**平台不推任何事件**。
 *     对「常用指令」这种「点了就等于手打」的用途，它正合适：没有回执要还。
 *
 * 字段按 `buildKeyboardPayload` 里那套**完整写全**（`visited_label` / `unsupported_tips`）——
 * 选项按钮就是带着这些字段被真机验证过的，不带的那一版（`cardKeyboard` 的旧写法）
 * 在真机上是「根本没有按钮」，所以这里不再省字段。
 */
export function commandButton(label: string, command: string): KeyboardButton {
  const width = labelWidthFor(4);
  return {
    id: command,
    render_data: {
      label: clipButtonLabel(label, width),
      visited_label: clipButtonLabel(label, width),
      style: 1,
    },
    action: {
      type: 2,
      permission: { type: 2 },
      data: command,
      unsupported_tips: '这个按钮暂时不可用',
    },
  };
}

/**
 * **回调按钮**（M2.86）—— 主动推送专用，与 `commandButton` 的区别要看清：
 *
 * | | `commandButton`（type=2） | `callbackButton`（type=1） |
 * | --- | --- | --- |
 * | 点击后 | 把 `@bot data` **插进输入框**，玩家还得自己按发送 | 平台推 `INTERACTION_CREATE`，`data` 原样回传 |
 * | 玩家感受 | 「点了像没反应」 | 真的执行了 |
 * | 依赖 | 无 | 后台要回应 `PUT /interactions/{id}`（本通道已接） |
 *
 * ## `data` 为什么带前导点号
 *
 * 回传后 `mapOfficialInteraction` 把它**原样塞进 `rawText`**（`:147`），
 * 然后走与玩家手打完全相同的路由 —— 而路由认指令要**点号前缀**。
 * 所以这里补上点号，点按钮就等于玩家手打了那条指令。
 *
 * ## 为什么不复用 `InteractiveOption`
 *
 * 那条路的 `data` 是菜单数字 key（`opt-1`），回传后走 `MENU_REPLY` → `pendingMenus.pick()`，
 * **需要一条待答菜单**。主动推送没有待答菜单，数字回传会无人认领。
 * 带完整指令就没有这个依赖 —— 多条推送各带各的按钮，互不干扰。
 */
export function callbackButton(label: string, command: string): KeyboardButton {
  const width = labelWidthFor(4);
  const text = command.startsWith('.') ? command : '.' + command;
  return {
    id: text,
    render_data: {
      label: clipButtonLabel(label, width),
      visited_label: clipButtonLabel(label, width),
      style: 1,
    },
    action: {
      type: 1,
      permission: { type: 2 },
      data: text,
      unsupported_tips: '这个按钮暂时不可用',
    },
  };
}

export function buildKeyboardPayload(message: InteractiveMessage): KeyboardPayload {
  /*
   * M2.86：**固定指令按钮优先**。
   *
   * 它不是一个「选项清单」，所以不参与 foldOptions / cutMenuOptions 那一套
   * （折叠、补「0. 自己写一个行为」都是给待答问题设计的）。
   * 有 quickButtons 的消息（`.角色`：一张图 + 四个快捷入口）走这条分支。
   */
  if (message.quickButtons !== undefined && message.quickButtons.length > 0) {
    return {
      content: {
        rows: [{ buttons: message.quickButtons.map((button) => commandButton(button.label, button.command)) }],
      },
    };
  }
  const { shown, folded } = foldOptions(message.options);
  const note = foldNote(folded);
  /*
   * ⚠️ M2.112：一行**两个**（原来按 `BUTTON.maxPerRow`，那是 4 个）。
   *
   * 用户的截图：「所有按钮显示不完整」——「去大桥区…」「打听消息…」「无视，该…」
   * 全被 `clipButtonLabel` 按宽度截掉了。按钮的宽度上限**跟着行内个数走**
   * （`labelWidthFor`），一行四个 ⇒ 每个只放得下四个汉字。一行两个就翻倍。
   *
   * 代价是行数变多（4 个选项从 1 行变 2 行）—— 键盘区放得下，而截断的标签是**读不懂**的。
   */
  const rows = chunkOptions(shown, BUTTON.maxPerRow <= 2 ? BUTTON.maxPerRow : 2).map((row) => ({
    // 宽度上限跟着**行内个数**走（见 labelWidthFor）—— 一行三个和单独一行能放的字数差一倍
    buttons: row.map((option): KeyboardButton => ({
      id: `opt-${option.id}`,
      render_data: {
        // M2.44：按**显示宽度**截断（不是字符数）—— 真机实测「10 个字符」的长中文标签会显示不全。
        label: clipButtonLabel(shortButtonLabel(option.label), labelWidthFor(row.length)),
        visited_label: clipButtonLabel(shortButtonLabel(option.label), labelWidthFor(row.length)),
        style: option.disabled ? 0 : 1,
      },
      action: {
        /*
         * ⚠️ M2.44 校准：必须是 **1（回调按钮）**，不能是 2。
         *
         *   1 = 回调按钮：点击后平台推 `INTERACTION_CREATE`，`data` 原样带回后台
         *       —— 这才是「按钮事件」，也是本文件 `mapOfficialInteraction` 一直在等的那条路。
         *   2 = 指令按钮：只把「@bot data」插进输入框，**玩家还得自己按发送**，
         *       平台不会推任何事件（文件头那句「点击后官方推送 INTERACTION_CREATE」与 type=2 的实际行为不符）。
         *
         * 代价：type=1 要求后台配置回调地址 + 收到事件后**必须** `PUT /interactions/{interaction_id}`
         * 回应，否则客户端一直 loading 到超时。这条由 qq-official 通道负责（M2.44）。
         */
        type: 1,
        permission: { type: 2 },
        data: option.id,
        // M2.44：官方这里是 **string**（版本过低时的提示文案），原来传的是 { title, content } 对象。
        unsupported_tips: option.disabled
          ? option.disabledReason ?? '现在不能选'
          : note ?? '这一项暂时不可用',
      },
    })),
  }));
  return { content: { rows } };
}

/**
 * 一个字符在按钮上占几列：全角 2、半角 1。
 *
 * 覆盖 CJK 汉字、CJK 标点（`（）`「」等）、全角形式、以及中文项目里常见的 `…`「——」。
 * 不追求 Unicode East Asian Width 的完整实现 —— 按钮上出现的字只有中文、数字和标点这三类。
 */
function displayWidthOf(ch: string): number {
  return /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)
    ? 2
    : 1;
}

/**
 * 按**显示宽度**截断按钮文字，超长补 `…`。
 *
 * 为什么不是 `slice(0, 10)`：那个按 UTF-16 码元算，一个汉字算 1 ——
 * 于是「查看背包与身上的东西」（10 字符 / 20 列宽）整条发出去，
 * 客户端只显示前一半。**这是真机实测出来的**（M2.44）。
 */
export function clipButtonLabel(label: string, maxWidth: number): string {
  let width = 0;
  let out = '';
  for (const ch of label) {
    const w = displayWidthOf(ch);
    // 放得下就整字放，放不下才截 —— 不预留省略号位（否则刚好占满的标签会被白截一个字）
    if (width + w > maxWidth) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}

/**
 * 把菜单文案精简成**按钮该有的样子**。
 *
 * 真机现场（M2.44）：菜单入口的 label 是
 *   `他去让你做的事：去外国人聚居区走一趟。找一个叫「灰先生」的人，找到也不用说话。`
 * —— 一整个句子塞进按钮，截断后只剩 `他去让你…`，信息全丢。
 *
 * 三条规则，按优先级：
 *   1. **删掉括号里的补充说明**：`休息一下（恢复 HP 与 MAD）` → `休息一下`。
 *      括号里的是解释，它该待在**正文**里，不该占按钮的格子。
 *   2. **取到第一个断句符之前**：`: ： ， , 。` —— 一条 label 如果自己带了断句，
 *      那说明它本来就是「标题 + 解释」两段，按钮只该拿标题。
 *   3. 仍超宽就交给 `clipButtonLabel` 按宽度截。
 */
export function shortButtonLabel(label: string): string {
  const noParen = label.replace(/[（(][^）)]*[）)]/g, '').trim();
  const head = noParen.split(/[：:，,。；;]/)[0]?.trim() ?? '';
  const clause = head.length > 0 ? head : noParen;
  // 3. 再砍掉并列结构：`查看背包与身上的东西` → `查看背包`。
  //    按钮的格子里塞不下两个并列项，而并列项的后半截截断后读起来是断的。
  const single = clause.split(/[与和及、]/)[0]?.trim() ?? '';
  return single.length > 0 ? single : clause;
}

/**
 * 一行放 N 个按钮时，每个按钮能用的**显示宽度**。
 *
 * 这个数不是算出来的，是**真机看出来的**：截图里三个按钮并排一行时，
 * 每个只放得下约 4 个汉字；单独一行的 `查看状态`（4 字）则完整显示。
 * ⇒ 一行的按钮越多，每个越窄。所以宽度上限必须跟着**行内个数**走，不能是个定值。
 *
 * ⚠️ 手机型号会带来差别，这几个数取的是**保守侧** —— 宁可自己截并补省略号，
 * 也不要让客户端在句子中间切一刀（那样看起来像 bug）。
 */
export function labelWidthFor(buttonsInRow: number): number {
  if (buttonsInRow <= 1) return 20;
  if (buttonsInRow === 2) return 12;
  return 8;
}

/** QQ Markdown 里实现「换多行」的那个字符（零宽空格，官方语法页「换多行」一节） */
const ZERO_WIDTH_SPACE = '\u200B';

/**
 * M2.44：把正文渲染成 QQ 的 Markdown（`msg_type: 2` 的 `markdown.content`）。
 *
 * 官方语法白名单（`server-inter/message/type/markdown.html`）：
 *   标题 `#` / `##`｜`**加粗**` `__下划线加粗__` `_斜体_` `*星号斜体*` `***加粗斜体***` `~~删除线~~`｜
 *   链接 `[文字](url)`｜图片 `![alt #宽px #高px](url)`｜有序 `1.`｜无序 `-`｜块引用 `>`｜
 *   分割线 `***`｜**换多行：行尾加 `\u200B`**。
 * 同一页 2026/04/23 的更新说明：群聊 / 单聊的自定义 Markdown **已开放到所有机器人，
 * 无需单独申请模版**（所以 `template_id` / `custom_template_id` 那两个废弃字段确实不用碰）。
 *
 * ## 这一版只做一件事：换行
 *
 * 不把首行变标题、不加粗、不画分割线 —— 那些都是**猜**，猜错的代价是整条消息被平台拒掉，
 * 而症状是「机器人不回话」，最难查（本仓库在按钮字段上已经踩过一次同型的坑）。
 * 换行则**必须**做：不补 `\u200B` 的话，多行正文在 QQ 里会挤成一整段。
 */
/**
 * 头像直链（M2.44 真机验证：`q.qlogo.cn/qqapp/{appid}/{openid}/{size}` 返回 image/jpeg）。
 *
 * `openid` 用**平台发下来的那个 openid**（群聊场景是 `group_member_openid`），
 * 不要用 QQ 号 —— 官方给的是 app 维度的 openid，头像服务认的也是它。
 * 实测：群成员与群 openid 都能取到图（200 / image/jpeg / JPEG 魔数 ffd8ffe0）。
 */
export function avatarUrlOf(appId: string, openid: string, size = 100): string {
  return `https://q.qlogo.cn/qqapp/${encodeURIComponent(appId)}/${encodeURIComponent(openid)}/${size}`;
}

/** Markdown 的水平分割线 —— 它自己占一行，**不能**再补零宽空格 */
const MD_RULE = '***';



/**
 * 一行正文 → Markdown 行（行尾补零宽空格；块级元素与空行按下述规则处理）。
 *
 * ## 空行 = **一个只含零宽空格的行**（依据：官方 markdown 文档「换多行」一节）
 *
 * 文档原文（那一段代码块就是它推荐的写法）：
 *
 *     第一行
 *     第二行
 *     \u200B
 *     \u200B
 *     第三行
 *
 * ⇒ 只含零宽空格的行**就是**空行，两个连在一起渲染出一个空段落。
 * 这也解释了本文件为什么给每一行行尾都补零宽空格：QQ 把换行符当空白折叠，
 * 零宽空格不是空白字符（`/\s/` 不匹配 U+200B），它才是唯一能"撑住"换行/空行的东西。
 *
 * ## ⚠️ 但**表格**必须用真空行终止
 *
 * 第九版把空行改回真空行，是因为真机出过一次事故：
 * 「表格污染了，表格把下面的数据也污染进表格里了」——表格把后面的正文吃进了格子。
 * 根因不是「空行该长什么样」，而是**表格的终止判据**：它认的是**真的空行**与块级结构
 * （标题 / 分割线 / 列表），一行零宽空格两者都不是。
 *
 * ⇒ 两条规则各管一段，顺序不能颠倒：
 *   1. 先 `mdLine`：段落里的空行 → 零宽空格行（**给人看的空行**）；
 *   2. 再 `blankAfterTables`：表格块后面补一个**真空行**（**给解析器看的终止符**）。
 */
function mdLine(line: string): string {
  const trimmed = line.replace(/[ \t]+$/, '');
  if (trimmed.length === 0) return ZERO_WIDTH_SPACE;
  /*
   * 块级元素**不补**零宽空格：
   *   `***` 补了就不是分割线；
   *   `|…|` 表格行同理 —— 表格是块级的，行尾多一个零宽空格可能让最后那一格解析不出来；
   *   **整行就是一张图片**时也补不得：平台转存图片资源时，URL 会连着行尾一起被取走。
   *
   * ⚠️ 判据是「整行**只有**一张图片」，不是「以 `![` 开头」——
   * M2.45 第十一版把头像与昵称并成了一行（`![头像](url) **の** 男`），
   * 那种行是**行内内容**，行尾该有零宽空格（它加在文字后面，碰不到 URL）。
   * 用前缀判断会静默漏掉它。
   */
  if (trimmed === MD_RULE || trimmed.startsWith('|')) return trimmed;
  if (/^!\[[^\]]*\]\([^)]*\)$/.test(trimmed)) return trimmed;
  return trimmed + ZERO_WIDTH_SPACE;
}

/**
 * 正文 → QQ Markdown。
 *
 * M2.44 第二轮（用户要求「多用 MD 标签 + 顶部标出是谁的信息」）：
 *   1. **顶部挂说话人**：`**昵称**` + 分割线 —— 群里同时有好几个人在玩，
 *      机器人每条回执长得一样，玩家分不清哪条是自己的。
 *      昵称只能从**通道侧**拿（只有它看得到平台的 `author.username`），
 *      所以由 `sendInteractive` 从凭证里取出来传进来，判定层不需要知道这件事。
 *   2. **首行的【…】做加粗**：本项目所有菜单标题都是这个形式（`【下一步 · 还没有途径】`），
 *      加粗后一眼能看出这是标题而不是正文。
 *   3. 正文各行原样保留，只做换行处理 —— 其余标签（列表 / 引用 / 链接 / **表格**）留给内容自己写。
 *
 * ⚠️ 头像：官方事件里**没有**群成员头像字段（`author` 只有 id / username / member_openid），
 * 也没有「按 openid 查头像」的接口，所以这一版只有昵称。
 * 图片标签 `![alt #宽px #高px](url)` 的用法记在 docs/M2.44-QQ能力扩展.md，
 * 等有公网图床（豆包出的图）之后再上。
 */
/**
 * 表格块后面**必须**跟一个空行（M2.45 第九版，通道层兜底）。
 *
 * 为什么在这一层兜：表格只认**空行**（以及标题 / 分割线 / 列表这类块级结构）作为终止 ——
 * 表块后面直接跟一行普通正文时，各家解析器的行为不一致，QQ 上实测是
 * 「表格把下面的数据也污染进表格」（用户的真机反馈）。
 *
 * 与其要求四十多个指令文件每次都记得补一个空行（`bag.ts` 的「发送 .背包 2 查看下一页」
 * 就漏了），不如在**唯一的出口**统一补齐：谁都不用记这条规则。
 */
function blankAfterTables(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]!);
    const next = lines[i + 1];
    // 表格块的最后一行之后一律补一个**真空行** —— 表格只认它（与块级结构）作终止
    if (lines[i]!.startsWith('|') && (next === undefined || !next.startsWith('|'))) out.push('');
  }
  return out;
}

/**
 * 正文首行的「所在」标记（`◉ 廷根市`，由 `renderStatus` 产出）。
 *
 * 渲染层认得它，是为了把那一行搬进消息头的引用块。这是一处**刻意的耦合**：
 * 判定层不 import 渲染层，只能靠一个约定好的前缀把两边对上。
 */
const LOCATION_PREFIX = '◉ ';

export function toQQMarkdown(
  text: string,
  options: {
    header?: MessageHeader;
    avatarUrl?: string;
    /**
     * M2.86：**顶部玩家信息条的图片 URL**（用户拍板）。
     *
     * 给了它就用**图片**当消息头，文字头整块跳过 ——
     * 理由见 card/header.ts：markdown 摆不出「头像 + 右边两行」这个形状，
     * 合成一张图之后版式、字号、平台差异一起消失。
     */
    headerImageUrl?: string;
    /** 信息条的显示宽度（px）；高度按 620:116 的比例派生 */
    headerImageWidth?: number;
    /** 正文样式档（M2.86）：默认 plain —— 手机端最保险 */
    mdStyle?: MdStyle;
  } = {},
): string {
  const lines = (text ?? '').split('\n');
  const head: string[] = [];
  const h = options.header;
  /*
   * M2.86：**信息条图片优先**。
   *
   * 没有图时逐位退回 M2.45 那套文字头（15 版调出来的那版）——
   * 降级路径不能退化：图裂了、Edge 挂了、上传失败，玩家看到的还应该是能读的头。
   */
  if (options.headerImageUrl !== undefined) {
    const w = options.headerImageWidth ?? 620;
    const hh = Math.round(w * (116 / 620));
    head.push('![信息 #' + w + 'px #' + hh + 'px](' + options.headerImageUrl + ')');
    head.push('');
  } else if (h || options.avatarUrl) {
    /*
     * M2.45 第十一版：**整个消息头压成一行**。
     *
     *     [头像 40px] **の**　男（愚者 · 序列 9）
     *     ────────────
     *
     * 用户原话（附了另一款机器人的截图）：
     *
     * > 信息头不能做成这样子横过来的吗，你现在的信息头很丑，而且很占高度。
     *
     * 第二版曾经把头像放到 60px 并让它**独占一行**，理由是「40px 跟一行大字挤在一起
     * 像贴歪的邮票」。真机上那个判断是错的：独占一行 + 昵称一行 + 引用块一行 + 分割线一行
     * ＝ **四条消息头**，比正文还高，而其中三行只有一个字段的信息量。
     *
     * 并排为什么成立：markdown 里图片是**行内元素**，跟在它后面的文字就排在它右边 ——
     * 这恰好是平台原生做不到、而正文里做得到的事（官方事件里没有群成员头像字段，
     * 见 docs/M2.44-QQ能力扩展.md）。
     *
     * 版式三处决定：
     *   · 头像 **32px**（60px 几乎占掉半个气泡宽、把整行撑高；40px 又让昵称显得更低 ——
     *     行内图片与文字是**基线对齐**的，图片越高，文字中心相对图片中心就越靠下）；
     *   · 性别与途径序列**并进同一行**，用全角空格 + 括号分区（原来各占一行）；
     *   · 引用块（`>`）不用了 —— 它是为「独占一行的次要信息」设计的，
     *     现在没有独占的行给它。
     *
     * 没有昵称（单聊 / 取不到 username）时不加头，保持原样。
     */
    const name = h?.nickname ?? '玩家';
    const gender = h?.genderTag ? `　${h.genderTag}` : '';
    /*
     * 头像 **56px** + 一个**半角空格**（8px）= 64px = 4 个字宽 —— 与 LOCATION_INDENT 的
     * 4 个全角空格对齐。
     *
     * 尺寸试过四轮：60px（独占一行，太占高度）→ 40px → 32px（比两行文字矮一截，用户：
     * 「这样看着不变扭吗」）→ **56px**（用户：「头像还是太小」）。56px 略高于右边两行文字，
     * 头像成为那个格子的主体，而整块高度仍由两行文字决定。
     */
    /*
     * M2.45 第十五版：**消息头只占一行** —— 头像 + 昵称 + 性别 + 途径序列。
     *
     * 「右边两行文字」试过三版，两行都不成立：
     *   · 第十三版把第二行推到头像右侧（4 个全角空格）⇒ 真机「文字歪了」——
     *     全角空格宽度 ＝ 字号宽度，头像 56px 是像素值，两者只在某个特定字号下相等；
     *   · 第十四版改成顶格 ⇒ 真机「文字还是跑到头像底下去了」——
     *     这是 markdown 的硬行为：图片是**行内元素**，换行后文字从**段落左边缘**开始，
     *     不是从图片右边缘开始（markdown 没有 float，也没有 vertical-align）。
     *
     * 两行都不成立，那就**压成一行**：一行没有第二行，既不会掉下去、也不会歪。
     * 途径序列用括号挂在昵称后面；昵称很长时这一行会折行，但折行仍然贴着头像，
     * 不会错位到别处（那是可以接受的失败方式）。
     */
    const avatar = options.avatarUrl ? `![头像 #56px #56px](${options.avatarUrl}) ` : '';
    /*
     * 第二行的缩进锚：**同一张头像，显示成 56×1**。
     *
     * 这是「头像右边两行文字」唯一不依赖字号的实现 ——
     *   · 全角空格凑不行：它的宽度 ＝ 字号宽度，换个字号就错开（第十四版「文字歪了」）；
     *   · 表格能并排，但表格在 QQ 上撑满气泡宽度、行高 1.5 倍，代价比收益大；
     *   · 图片的宽度是**像素**值，写 56px 就是 56px ⇒ 第二行的文字起点与第一行严格对齐。
     * 高度取 1px 是为了让它几乎不可见（它就是头像最上面那一行像素）。
     *
     * ⚠️ 用的是**头像自己的 URL**（`q.qlogo.cn`，腾讯自家域名）——
     * 不引入任何外部图床，所以不会像卡面外链那样裂。
     */
    /*
     * 第二行的内容：途径 · 序列 ＋ 所在。
     *
     * 「◉ 城市」本来在正文第一行，这里搬上来；搬的只是**这一层拆出来的数组**，
     * OneBot 那类不走 markdown 的通道照旧从正文里看到它，信息不丢。
     */
    const minor: string[] = [];
    if (h?.pathwayLine) minor.push(h.pathwayLine);
    if (options.avatarUrl !== undefined && (lines[0] ?? '').trim().startsWith(LOCATION_PREFIX)) {
      minor.push((lines[0] ?? '').trim());
      lines.shift();
      while ((lines[0] ?? '').trim() === '') lines.shift();
    }
    /*
     * ⚠️ M2.45 第二十一版：**表格名片撤掉了**（第十九版做的，被真机打回来）。
     *
     * 用户把**手机 QQ 与电脑 QQ 并排截图**之后看到：表格里的 `<br>` 在**两端都是把表格
     * 撑成两行**（第二行左格空着），根本不是"单元格内换行" —— 而 markdown 表格没有 rowspan，
     * 所以"头像跨两行 + 右边两行文字"**做不到**。视觉上就是地点飘在头像右下角。
     *
     * （探测时我把"数据行里分了行"误读成"单元格内换行"，这个误读的教训写进了
     * docs/QQ-markdown-能力实测.md —— 探测要看**两端**，而且要看**表格结构**而不只是有没有换行。）
     *
     * 现在回到第十八版的形态：**头像 + 昵称一行，次要信息走引用块一行**。
     * 它在手机上是稳的：引用块的缩进由客户端给，不靠凑对齐、不靠表格。
     */
    head.push(`${avatar}**${name}**${gender}`);
    if (minor.length > 0) head.push(`> ${minor.join('　')}`);
    head.push(MD_RULE);
  }
  /*
   * 正文的结构化（M2.55）。
   *
   * 这一层只做**标记翻译**，一个字都不改语义 —— 项目的正文里本来就有结构，
   * 只是用中文标点和空格写的：
   *   · 独立成行的【…】= 小标题（原来只认首行那一个，正文里的小标题全是白的）
   *   · 行首的「 · 」    = 项目符号（项目里到处都是 ` · 黑荆棘修道院（不安 · 晴）`）
   *
   * ⚠️ 两条都必须**整行匹配**：`事件【以后有事找你】` 这种行内的【】不是标题，
   * `不安 · 晴` 这种行内的· 也不是项目符号。只按行首/整行判，就不会误伤。
   *
   * 为什么敢动这一层：官方白名单里 `**加粗**`、`- `、`***` 都在（见文件头的清单），
   * 而它们都是**行内/行级**语法，不改变消息结构 —— 猜错的代价只是不好看，
   * 不像 `#` 标题或模板字段那样会让整条消息被平台拒掉。
   */
  const body: string[] = [];
  let seenTitle = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    /*
     * 首行的【…】是**这条回执的标题**，但它后面常常还跟着信息
     * （【克莱恩】老码头（不安）· 晴 · 今日 1/3 次）—— 所以只加粗【】那一段，
     * 不要求整行都是标题。首行不加粗的话，玩家扫一眼分不出这条回执是干什么的。
     */
    if (i === 0) {
      const lead = /^(【[^】]+】)(.*)$/.exec(trimmed);
      if (lead !== null) {
        seenTitle = true;
        body.push('**' + lead[1] + '**' + lead[2]);
        continue;
      }
    }
    if (/^【.+】$/.test(trimmed)) {
      // 第二个及以后的小标题前面加一条分割线：正文与菜单、段落与段落之间才分得开
      if (seenTitle) {
        if (body.length > 0 && body[body.length - 1] !== '') body.push('');
        body.push(MD_RULE);
        body.push('');
      }
      seenTitle = true;
      body.push('**' + trimmed + '**');
      continue;
    }
    const bullet = /^(\s*)·\s+(.*)$/.exec(line);
    if (bullet !== null) {
      body.push(bullet[1] + '- ' + bullet[2]);
      continue;
    }
    body.push(line);
  }
  // 顺序要紧：先 mdLine（空行 → 零宽空格行），再 blankAfterTables（表格后补真空行）
  // M2.86：按档位处理正文样式（官方文档列了**加粗**，但用户实机确认手机端不渲染）
  return applyMdStyle(blankAfterTables([...head, ...body].map(mdLine)).join('\n'), options.mdStyle ?? 'plain');
}

/**
 * **手机端兼容：去掉 `**`**（M2.86，用户实机确认）。
 *
 * 用户截图里 `**【曾经】**铁工厂(极危险)` 在手机 QQ 上是**带星号原样显示**的 ——
 * 也就是说那份「官方白名单里有 `**加粗**`」的旧记录，在手机端不成立。
 * 而电脑端会把它渲染出来，于是**两端看到的东西不一样**。
 *
 * 处理：**统一去掉 `**`**，正文的层次改由项目里两端都成立的手段承担 ——
 *   · 独立成行的【…】= 小标题（已经有了）
 *   · `>` 引用块 = 次要信息（已经有了）
 *   · 空行 + 分割线 = 段落（已经有了）
 *
 * ⚠️ 只去 `**`，不动 `*`（分割线）与表格 —— 那些是行级语法，两端都认。
 */
/**
 * 正文样式的**三档**（M2.86，用户实机反馈后用官方文档定的）。
 *
 * 官方 markdown 文档（`bot.qq.com/.../message/type/markdown.html`）的「支持格式」是完整清单：
 *
 *   标题 / **加粗** / __下划线加粗__ / _斜体_ / *星号斜体* / ***加粗斜体*** / ~~删除线~~ /
 *   链接 / 图片 / 有序无序列表 / 块引用 / 分割线 / 换多行
 *
 * ⚠️ **清单里没有颜色** —— 官方 markdown 不支持字体颜色（用户看到别人有颜色，
 * 那是图片或链接或 emoji，不是字体色）。
 *
 * 用户实测「手机端不渲染 `**`」（截图里星号原样显示），而 `**` 恰好在官方清单里 ——
 * 所以手机端对样式的支持可能与文档有出入。于是给三档，真机上哪个好用哪个：
 *
 *   plain：全去掉（**最保险**，纯靠【】与引用块分层）
 *   bold-italic：`**X**` → `***X***`（官方清单里的加粗斜体，比 `**` 更醒目）
 *   keep：原样保留（电脑端友好）
 *
 * 默认 `plain`：因为用户实机确认手机端连 `**` 都不认，裸星号最难看。
 */
export type MdStyle = 'plain' | 'bold-italic' | 'keep';

export function applyMdStyle(text: string, style: MdStyle): string {
  if (style === 'keep') return text;
  if (style === 'bold-italic') {
    // `**X**` → `***X***`（官方清单里的加粗斜体）；已经是 *** 的不动
    return text.replace(/(?<!\*)\*\*([^*\n]+?)\*\*(?!\*)/g, '***$1***');
  }
  // plain：`**X**` → `X`；`***` 这种整行分割线留着（它是行级语法，两端都认）
  return text.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
}

/** 兼容旧名：等价于 plain 档（手机端最保险的那一档） */
export function stripBoldForMobile(text: string): string {
  return applyMdStyle(text, 'plain');
}

/** 按钮 + Markdown 通道的正文 = 正文 + 折叠提示（放不下的选项不能凭空消失），再 MD 化一次 */
export function officialMarkdownOf(
  message: InteractiveMessage,
  who: { header?: MessageHeader; avatarUrl?: string; headerImageUrl?: string } = {},
): string {
  return toQQMarkdown(officialTextOf(message), who);
}

/** 按钮通道的纯文本正文 = 正文 + 折叠提示（降级路径用） */
export function officialTextOf(message: InteractiveMessage): string {
  const { folded } = foldOptions(message.options);
  const note = foldNote(folded);
  const head = message.text;
  if (!note) return head;
  return `${head}\n${note}`;
}

export class OfficialAdapter implements Adapter {
  /** M2.7：官方机器人原生支持按钮 */
  readonly supportsButtons = true;

  /**
   * M2.47：**支持图片**（走 markdown，`msg_type: 2`）。
   *
   * 官方 markdown 文档原文：「对于 markdown 消息内的图片资源，请使用**可在公网访问的资源 url**，
   * 开放平台会下载转存该资源」。⇒ 图片不是独立接口，而是正文里的一行
   * `![alt #宽px #高px](url)`，所以这条能力成立的前提是**调用方能给出公网 URL**
   * （`OutboundImage.url`）—— 只给字节时 `sendImage` 返回 false，由调用方降级成文字。
   */
  readonly supportsImages = true;

  /**
   * M2.45：**图片能写进正文** —— 这正是官方 markdown 通道的形态（见 `supportsImages` 的注释）。
   *
   * 有了它，`.角色` 才能把「卡面 + 文字状态卡 + 按钮」发成**一条**消息；
   * 没有它的通道（OneBot）仍旧走"先发图、再发文字"两条。
   */
  readonly supportsInlineImages = true;

  #config: OfficialConfig;
  #post: HttpPost | null;
  #handler: MessageHandler | null = null;
  /** 观测：已发出的带按钮消息数（真机联调时用） */
  buttonsSent = 0;
  /** 观测：已发出的图片消息数（M2.47） */
  imagesSent = 0;

  constructor(config: OfficialConfig, post?: HttpPost) {
    this.#config = config;
    this.#post = post ?? null;
  }

  get appId(): string {
    return this.#config.appId;
  }

  onMessage(handler: MessageHandler): void {
    this.#handler = handler;
  }

  async handleEvent(payload: unknown): Promise<InternalMessage | null> {
    const msg = mapOfficialEvent(payload);
    if (!msg) return null;
    if (this.#handler) await this.#handler(msg);
    return msg;
  }

  /**
   * 发送侧是否可用：必须同时给出 post（或默认 fetch）与 accessToken。
   * 不满足时返回 false 走文本降级 —— 宁可退化成文本菜单，也不假装按钮发出去了。
   */
  get canSend(): boolean {
    return Boolean(this.#config.accessToken) && Boolean(this.#config.apiBase || this.#post);
  }

  async sendInteractive(
    scene: Scene,
    targetId: string,
    message: InteractiveMessage,
  ): Promise<boolean> {
    if (!this.canSend) return false;
    if (message.options.length === 0) return false;
    const keyboard = buildKeyboardPayload(message);
    const body = {
      content: officialTextOf(message),
      msg_type: 2,
      keyboard,
    };
    await this.#call(this.#messagePath(scene, targetId), body);
    this.buttonsSent += 1;
    return true;
  }

  async sendPrivate(userId: string, text: string): Promise<void> {
    this.#requireSend();
    await this.#call(this.#messagePath('private', userId), { content: text, msg_type: 0 });
  }

  /*
   * ⚠️ M2.171 的一次**回滚**，写在这里免得下一个人再走一遍：
   *
   * 为了让「灾厄的 MD 模板」生效，我一度在这里给 `sendGroup` 加了 markdown 分支 ——
   * 但 `OfficialConfig`（本文件的 config 类型）**根本没有 `markdown` 字段**：
   * 那个开关的真身在 `src/adapter/qq-official/index.ts`（`QQ_BOT_MARKDOWN`），
   * 而**真正跑线上的是那一个**（它的 `#buildReply` 在 M2.44 就已经「整条改走 msg_type: 2」）。
   *
   * 教训：改一个通道之前，先确认**哪个实现真的在被用** ——
   * 仓库里有两套官方通道代码，而它们的开关读的不是同一个地方。
   */
  async sendGroup(groupOpenid: string, text: string, _header?: MessageHeader | null, _buttons?: ButtonSpec[]): Promise<void> {
    this.#requireSend();
    await this.#call(this.#messagePath('group', groupOpenid), { content: text, msg_type: 0 });
  }

  async sendChannel(channelId: string, text: string): Promise<void> {
    this.#requireSend();
    await this.#call(this.#messagePath('channel', channelId), { content: text, msg_type: 0 });
  }

  /**
   * M2.47：发一张图 = 发一条**带图片的 markdown 消息**。
   *
   * 为什么必须走 markdown：官方没有"发图"的独立消息类型给群机器人用，
   * 图片是 markdown 正文里的一行；而 `markdown` 与 `content` **互斥**，
   * 所以整条消息就是 `msg_type: 2`，正文里带上 `![alt #宽px #高px](url)`。
   *
   * 尺寸写死 600×968（卡面 620×1000 等比）：不写尺寸时 QQ 按原图铺开，
   * 竖版卡会占满整屏 —— 官方语法就是 `![text #208px #320px](url)` 这个形状。
   */
  async sendImage(scene: Scene, targetId: string, image: OutboundImage): Promise<boolean> {
    if (image.url === undefined || image.url.length === 0) return false;
    if (!this.canSend) return false;
    const alt = image.alt ?? 'image';
    const body = {
      content: '',
      msg_type: 2,
      markdown: { content: `![${alt} #600px #968px](${image.url})` },
    };
    await this.#call(this.#messagePath(scene, targetId), body);
    this.imagesSent += 1;
    return true;
  }

  /** 未配置齐全时保持 W1 的行为：明确抛 NotImplementedError，而不是静默丢弃 */
  #requireSend(): void {
    if (!this.canSend) throw new NotImplementedError('OfficialAdapter.send');
  }

  #messagePath(scene: Scene, targetId: string): string {
    if (scene === 'group') return `/v2/groups/${targetId}/messages`;
    if (scene === 'channel') return `/channels/${targetId}/messages`;
    return `/v2/users/${targetId}/messages`;
  }

  async #call(path: string, body: unknown): Promise<unknown> {
    const post = this.#post ?? defaultHttpPost;
    const base = (this.#config.apiBase ?? 'https://api.sgroup.qq.com').replace(/\/+$/, '');
    const headers: Record<string, string> = { 'x-union-appid': this.#config.appId };
    if (this.#config.accessToken) headers.authorization = `QQBot ${this.#config.accessToken}`;
    return post(`${base}${path}`, body, headers);
  }
}

/** 供文本降级路径复用：把 InteractiveMessage 渲染成 OneBot 那份一模一样的菜单文本 */
export { renderInteractiveText };
