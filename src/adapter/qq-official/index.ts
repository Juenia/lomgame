/**
 * QQ 官方机器人适配器（交付物之一 —— src/adapter/qq-official/index.ts）
 *
 * 把「官方网关推来的事件」翻成 InternalMessage，把路由产出的回复翻回官方 HTTP 调用。
 * **本文件不做任何判定** —— 指令解析、菜单、数值全在 src/router 与 src/domain，
 * 与 OneBot 通道走的是同一套（架构铁律：判定层不认识通道）。
 *
 * ── 与 OneBot 通道最大的一个不同：回复要有「凭证」──────────────────
 *
 * OneBot 想发就发（send_group_msg 给群号就行）。官方不一样：
 *
 *   - **被动回复**：必须带收到那条消息的 `msg_id`，且**5 分钟内**有效，
 *     URL 是 POST /v2/groups/{group_openid}/messages；
 *   - **主动消息**：**不带 `msg_id`**。⚠️ 曾经的注释在这里写着「要单独申请权限，本项目没有」——
 *     **那句是错的**（M2.115 查官方《消息收发概述》：「主动消息 | 无任何条件」）。
 *     不需要申请，直接发；接收方可以在客户端关掉「允许主动发送」，关掉之后那条会发送失败。
 *
 * 所以本适配器在收到群消息时把 `msg_id` 按 group_openid 记下来，
 * sendGroup 时取出来当凭证、`msg_seq` 自增（同一个 msg_id 的多条回复要各自不同）。
 * 窗口过期后 sendGroup 会**明确抛错**说明「主动推送未获批」，
 * 而不是发一条静默失败的消息 —— 玩家看到的行为差异必须能在日志里找到原因。
 *
 * 另一个坑：`group_openid` **不是群号**。群号 901372907 在官方协议里没有意义，
 * 所有收发都用事件里给的 `group_openid`。见 mapQQGroupAtMessage。
 */

import { displayLengthOf, truncateKeepingTags } from '../text-tags.ts';
import { createHash } from 'node:crypto';
import type { Adapter, ButtonSpec, InternalMessage, MessageHandler, MessageHeader, OutboundImage, Scene } from '../types.ts';

// 被动回复限制对应的错误搬去了 infra（错误类型是契约，不是适配器实现 ——
// app.ts 为了一句 instanceof 引用它，不该把整个官方网关拉进 bridge-api 的模块图）。
import { ReplyQuotaError, NoReplyTicketError } from '../../infra/reply-errors.ts';
// 老路径继续可用：外部仍然可以从这里按名字取到它们
export { ReplyQuotaError, NoReplyTicketError };
import type { InteractiveMessage } from '../interactive.ts';
// M2.44：按钮与 Markdown 复用 M2.7 就写好的协议构造层（official.ts），不另造一份 ——
// 那一层是通道无关的纯函数，且有 test/m2-7.test.ts 守着；这里只负责「发出去」。
import { readFileSync } from 'node:fs';
import { HEADER_W, headerCacheKey, readHeaderUrl, renderHeader, writeHeaderUrl, type HeaderInput } from '../../card/header.ts';
import { resolveAvatarPath } from '../../card/avatar.ts';
import {
  avatarUrlOf,
  buildKeyboardPayload,
  callbackButton,
  commandButton,
  // M2.99：取 openid 的非空取值工具 —— 与协议层共用同一份，别在这里再写一条 ?? 链
  firstNonEmpty,
  officialMarkdownOf,
  mapOfficialInteraction,
  toQQMarkdown,
  type KeyboardPayload,
} from '../official.ts';
import type { Logger } from '../../infra/logger.ts';
import { consoleLogger } from '../../infra/logger.ts';
import { TokenManager, loadTokenConfig, type TokenConfig } from './token.ts';
import {
  API_BASE_PROD,
  API_BASE_SANDBOX,
  DEFAULT_INTENTS,
  INTENT_INTERACTION,
  QQGateway,
  type GatewayStats,
} from './gateway.ts';
// M2.75：登录体检（换 token → 取机器人身份 → 取网关地址与配额）。
// 它只读不写，不主动连网关 —— 体检的职责是「看」，连一次会消耗一次 identify 配额。
import {
  runLoginCheck,
  type BotIdentity,
  type LoginReport,
  type LoginStepStatus,
  type SessionLimit,
} from './login-check.ts';
import { NUMERIC } from '../../config/numeric.ts';
import { QQSessionStore } from '../../infra/qq-session-store.ts';

/* ------------------------------------------------------------------ *
 * 事件 → InternalMessage
 * ------------------------------------------------------------------ */

/** 官方事件体里我们真正用到的字段 */
export interface QQGroupAtPayload {
  id?: string;
  content?: string;
  group_openid?: string;
  group_id?: string;
  /**
   * 发消息的人。三个 openid 的**语义完全不同**（M2.92 踩过一次，见下方注释）：
   *   · `member_openid` —— **群成员** openid（同一个人在不同群不同）
   *   · `user_openid`   —— **单聊** openid（C2C 事件里才有；发送地址要用它）
   *   · `union_openid`  —— 同一开发者主体下**唯一**（跨群、跨单聊都是同一个人）
   */
  author?: { member_openid?: string; user_openid?: string; union_openid?: string; id?: string; username?: string };
  /**
   * @ 提及列表。**全量群消息事件靠它判断有没有 @ 机器人**：
   * 只有 `is_you === true` 的那一项才代表「@ 的是本机器人」。
   */
  mentions?: Array<{
    bot?: boolean;
    id?: string;
    is_you?: boolean;
    member_openid?: string;
    username?: string;
  }>;
  timestamp?: string | number;
}

/** 群 @ 机器人（仅 @ 时才推的窄事件） */
/**
 * 平台报「access_token 无效或过期」时用的错误码（M2.75）。
 *
 * 真机样本（2026-09-29，用一个无效 token 发群消息）：
 *   HTTP 401 + {"message":"AccessToken无效或过期","code":11244,"err_code":40011027,...}
 * 这里认的是 `err_code`（40011027）；同一响应里的 `code` 是 11244，
 * 两者都登记在这里，免得下次只认了一个。
 */
export const AUTH_ERR_CODES: readonly number[] = [40011027, 11244];

/** 上面那张表里最常出现的一个（自愈判定用） */
const AUTH_ERR_CODE = 40011027;

export const EVENT_GROUP_AT_MESSAGE_CREATE = 'GROUP_AT_MESSAGE_CREATE';
/**
 * 群消息（**全量**：群里每条消息都推）。
 *
 * ⚠️ 这是实测才发现的差异，任务书写的是 GROUP_AT_MESSAGE_CREATE。
 * 本机实测（2026-09-27 19:21）群里 @ 机器人发 `.创建 张三`，
 * 推来的是 **GROUP_MESSAGE_CREATE**，且 content 里 @ 部分**没有**被剥掉：
 *
 *   {"t":"GROUP_MESSAGE_CREATE","d":{
 *      "content":"<@634D074AF2C97A5C45C5DB0CBCF4F54C> .创建 张三",
 *      "group_openid":"F066563EDF0FEF1F44636F55E80222F9",
 *      "mentions":[{"bot":true,"is_you":true,"username":"测试1"}]}}
 *
 * 原因见群里的系统提示：「群主已授权测试1查看群内全部对话」——
 * 授权之后推的是全量事件。**所以绝不能只认 GROUP_AT_MESSAGE_CREATE**，
 * 否则一条事件都收不到（这正是我第一次联调踩的坑）。
 */
export const EVENT_GROUP_MESSAGE_CREATE = 'GROUP_MESSAGE_CREATE';
/** 单聊 */
export const EVENT_C2C_MESSAGE_CREATE = 'C2C_MESSAGE_CREATE';

/**
 * 互动事件（M2.44）：用户点了消息里的内联键盘按钮。
 *
 * 两条平台要求：① 必须先 `PUT /interactions/{id}` 回应，否则客户端一直 loading；
 * ② 回复要用这个事件的**最外层 id** 当 `event_id`（不是 `msg_id`）。
 */
export const EVENT_INTERACTION_CREATE = 'INTERACTION_CREATE';

/**
 * 剥掉正文里的 `<@openid>` 提及标记。
 *
 * GROUP_AT_MESSAGE_CREATE 的 content 是剥好的，GROUP_MESSAGE_CREATE 不是。
 * 不剥的话路由拿到的是 `<@634D07...> .创建 张三`，
 * parseCommand 看到的第一个字符是 `<` 而不是 `.`，指令永远匹配不上。
 */
export function stripMentions(content: string): string {
  return content.replace(/<@!?[^>]*>/g, '').trim();
}

/** 这条消息有没有 @ 本机器人 */
export function isBotMentioned(d: QQGroupAtPayload): boolean {
  return (d.mentions ?? []).some((m) => m.is_you === true);
}

/**
 * 官方时间戳是**字符串**，且不同事件给的单位不一致（有的是秒、有的是毫秒）。
 * 用位数判断：10 位当秒、13 位当毫秒。判不准就退回当前时间 ——
 * 这个字段只影响审计显示，不影响任何判定，不值得为它抛错。
 */
export function toMillis(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n > 1e12) return n; // 毫秒
  if (n > 1e9) return n * 1000; // 秒
  return fallback;
}

/*
 * M2.99：「取第一个非空 openid」的实现在协议层 `../official.ts`（那里写了为什么 `??` 链会出事），
 * 这里**原样转出** —— 上面两处映射用它，既有的 import 路径也不必动。
 * 一份实现、两条通道共用：写两份的话，早晚只修一处，而那种 bug 恰恰不报错。
 */
export { firstNonEmpty };

/**
 * GROUP_AT_MESSAGE_CREATE → InternalMessage。
 *
 * 两处必须注意：
 *   1. `sceneId` 用 **group_openid**，不是群号。路由会拿它做 world.touchGroup，
 *      回复时也用同一个值拼 URL —— 全程不碰真实群号。
 *   2. `content` 里官方已经把 @机器人 那段剥掉了，但常留一个前导空格，要 trim。
 */
export function mapQQGroupAtMessage(
  d: QQGroupAtPayload,
  now: number = Date.now(),
): InternalMessage | null {
  const messageId = d.id ?? '';
  const groupOpenid = d.group_openid ?? '';
  /*
   * M2.92：**身份键优先取 union_openid**。
   *
   * `member_openid` 是「群成员」id —— 同一个人换个群就换一个 id，私聊里又是另一个 id。
   * 玩家在群里建的角色，到了私聊就找不到了（.状态 会回「你还没有角色」）。
   * `union_openid` 在同一开发者主体下唯一，群与私聊拿到的是同一个值。
   *
   * 退回顺序保留了 member_openid —— 老 payload 与既有测试里只有它，行为不变。
   *
   * ⚠️ M2.99：取值必须走 `firstNonEmpty`，**不能写成 `??` 链** ——
   * 官方给的空串（`"union_openid":""`）会截断 `??` 链，整条群消息同样会被静默丢掉。
   * 真机 C2C 就是这么丢掉私聊消息的（见 `mapQQC2CMessage`），群这边只是暂时没给空串。
   */
  const userId = firstNonEmpty(d.author?.union_openid, d.author?.member_openid, d.author?.user_openid, d.author?.id);
  if (!messageId || !groupOpenid || !userId) return null;
  return {
    messageId: `qq:${messageId}`,
    platform: 'official',
    scene: 'group',
    sceneId: groupOpenid,
    userId,
    nickname: d.author?.username ?? '',
    // GROUP_MESSAGE_CREATE 的 content 带 <@openid>，必须剥（见 stripMentions）
    rawText: stripMentions(d.content ?? ''),
    timestamp: toMillis(d.timestamp, now),
  };
}

/**
 * C2C_MESSAGE_CREATE → InternalMessage（私聊）。
 *
 * ## ⚠️ M2.92：**这里原来一个字段都取不到，于是私聊完全静默**
 *
 * 用户实测：「QQ 官方适配器，私聊发送 .状态，没有任何反应」。
 *
 * 根因：C2C 事件的 payload 里，发消息的人写在 **`author.user_openid`**，
 * 而这里取的是 `author.member_openid ?? union_openid ?? id` ——
 * `member_openid` 是**群成员**字段，单聊事件里根本没有它。
 * 于是（当 payload 也没带 union_openid / id 时）userId 是空串 ⇒ `return null`
 * ⇒ 消息在适配器层就被丢掉，**不报错、不日志、没有任何反应**。
 *
 * 另一个隐患：`sceneId` 原来也取 userId。私聊的**发送地址**必须是 `user_openid`
 * （`POST /v2/users/{openid}/messages`），而**身份**要用 union_openid ——
 * 两者从此分开：`sceneId` 是发信地址，`userId` 是玩家身份。
 */
export function mapQQC2CMessage(
  d: QQGroupAtPayload,
  now: number = Date.now(),
): InternalMessage | null {
  const messageId = d.id ?? '';
  /*
   * ⚠️ M2.99：**这一行就是「私聊发什么都没反应」的根因所在。**
   *
   * 真机 C2C payload 里 `union_openid` 是空串（不是 undefined），
   * `??` 链在它那里就停了 ⇒ userId 是空串 ⇒ 下面 `return null` ⇒
   * 消息在适配器层被丢掉，不报错、不打日志。改用 firstNonEmpty 之后
   * 空串会被跳过，退回 `user_openid`（真机上它一定在）。
   */
  const userOpenid = firstNonEmpty(d.author?.user_openid, d.author?.id);
  const userId = firstNonEmpty(d.author?.union_openid, d.author?.member_openid, userOpenid);
  if (!messageId || userId === '') return null;
  return {
    messageId: `qq:${messageId}`,
    platform: 'official',
    scene: 'private',
    // 发信地址：官方接口认的是 user_openid；拿不到时才退回身份键
    sceneId: userOpenid !== '' ? userOpenid : userId,
    userId,
    nickname: d.author?.username ?? '',
    rawText: (d.content ?? '').trim(),
    timestamp: toMillis(d.timestamp, now),
  };
}

/* ------------------------------------------------------------------ *
 * HTTP 调用
 * ------------------------------------------------------------------ */

/** 调官方 API 失败。**带上原始响应体与 trace_id** —— 排查不需要猜，也不用等复现 */
export class QQApiError extends Error {
  readonly httpStatus: number;
  readonly path: string;
  readonly raw: string;
  /** 官方业务错误码。**判定失败以它为准**（见 #post 的说明） */
  readonly errCode: number | null;
  /** 平台链路追踪 ID：需要找平台协助时把这个交出去，对方能直接查日志 */
  readonly traceId: string | null;

  constructor(
    path: string,
    httpStatus: number,
    raw: string,
    errCode: number | null = null,
    traceId: string | null = null,
  ) {
    super(
      `QQ API ${path} 失败：${errCode !== null ? `err_code=${errCode} ` : ''}HTTP ${httpStatus}` +
        `${traceId ? ` trace_id=${traceId}` : ''} 原始响应：${raw.slice(0, 500)}`,
    );
    this.name = 'QQApiError';
    this.httpStatus = httpStatus;
    this.path = path;
    this.raw = raw;
    this.errCode = errCode;
    this.traceId = traceId;
  }
}

/**
 * 被动回复的两条硬规则，出自官方文档「消息收发概述 → 频率与时效规则」：
 *
 *   | 场景 | 有效期   | 每条消息可回复次数 |
 *   | 单聊 | 60 分钟  | 4 次              |
 *   | 群聊 | 5 分钟   | 5 次              |
 *
 * 两个都不能想当然：
 *
 *   1. **单聊是 60 分钟，不是 5 分钟**。早先不加区分地统一用 4.5 分钟，
 *      等于把 55 分钟内本可以送达的私聊明细提前判了死刑 —— 而那正是
 *      「群聊给摘要、明细走私聊」（S1 §7）依赖的通道。
 *   2. **回复条数有硬上限**。同一个 msg_id 群聊最多回 5 条、单聊 4 条，
 *      超了再发直接失败。所以下面要先拦，而不是等 API 报一个看不懂的错。
 *
 * 有效期留 30 秒余量：卡着整点发容易因为网络往返被判过期。
 */
export const REPLY_RULES: Record<Scene, { windowMs: number; maxReplies: number }> = {
  group: { windowMs: 5 * 60 * 1000 - 30_000, maxReplies: 5 },
  private: { windowMs: 60 * 60 * 1000 - 30_000, maxReplies: 4 },
  // 频道不走这条路（sendChannel 直接抛错），留着只为类型完整
  channel: { windowMs: 5 * 60 * 1000 - 30_000, maxReplies: 5 },
};

/**
 * M2.44：**intents 由「要哪些能力」推出来**，不再各处写 `config.intents ?? DEFAULT_INTENTS`。
 *
 * 理由是一条真实事故的形状：少订阅一位，平台**什么都不推**，而本地一切正常 ——
 * 表现为「按钮点了没反应 / 群里发的消息收不到」，日志里干干净净。
 * 把「要按钮」与「订阅 INTERACTION」绑成同一件事，就不会出现「开了按钮却收不到回调」。
 */
export function intentsFor(config: QQOfficialConfig): number {
  const base = config.intents ?? DEFAULT_INTENTS;
  return config.buttons === true ? base | INTENT_INTERACTION : base;
}

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

export interface QQOfficialConfig {
  appId: string;
  clientSecret: string;
  /** 正式 / 沙箱基址 */
  apiBase?: string;
  intents?: number;
  logger?: Logger;
  timeoutMs?: number;
  /**
   * 被动回复窗口的安全余量。官方是 5 分钟，这里默认 4.5 分钟 ——
   * 卡着 5 分钟整发很容易因为网络往返被判过期，留 30 秒余量。
   */
  replyWindowMs?: number;
  /**
   * **灰度开关**：只放行这些指令名（不含点号）。空 = 全放行。
   *
   * 任务书要求「先只接一条指令，跑通再放全量」，所以默认只放行 `创建`。
   * 放开全量不需要改代码：`QQ_BOT_ALLOWED_COMMANDS=*`。
   */
  allowedCommands?: readonly string[];
  /**
   * M2.44：正文改用 **Markdown**（`msg_type: 2` + `markdown.content`）。默认关。
   *
   * 官方文档里 `template_id` / `custom_template_id` **都已标废弃** ⇒ 直接发 `content`，
   * 不需要先在后台建模板。开了之后纯文本回复也会走 MD；发失败会**自动回退**纯文本。
   */
  markdown?: boolean;
  /**
   * M2.86：**正文样式档**（`plain` / `bold-italic` / `keep`）。
   *
   * 官方文档列了 `**加粗**`，但用户实机确认手机端不渲染（星号原样显示）。
   * 默认 `plain`（全去掉，最难看错）；换成 `bold-italic` 可用官方清单里的 `***加粗斜体***` 再试。
   */
  mdStyle?: 'plain' | 'bold-italic' | 'keep';
  /**
   * M2.86：**富文本标签开关**（`QQ_BOT_RICH_TEXT=1`）。
   *
   * 开了之后 `.看` 里的地点/危险/端倪会带 `<font color="#..">`。
   * ⚠️ 只在 `.mdprobe html` 验证过**至少一种写法生效**之后才开 ——
   * 不支持时整条会漏出裸标签，比不上色难看。
   */
  richText?: boolean;
  /**
   * M2.44：发**原生按钮**（`keyboard.content.rows`），并订阅 `INTERACTION (1<<26)`。默认关。
   *
   * 开了之后 `supportsButtons` 才是 true —— 否则 `InteractiveMessage` 一律降级成文本菜单
   * （那条路走数字回复，语义等价，不是功能缺失）。
   */
  buttons?: boolean;
  /** 打印完整事件 payload（任务 4 的验收就是靠它） */
  debug?: boolean;
  /** 正文长度上限保护，默认 1000 字符。超了截断并打 warn（不静默丢消息） */
  maxContentChars?: number;
  /**
   * 网关会话的落盘路径（M2.76）。给了它，**重启之后可以 resume 而不是重新登录**：
   * 省一次 `session_start_limit` 配额，并且平台会把重启期间漏掉的事件补发回来。
   *
   * 不传就是纯内存会话（老行为）—— 测试与一次性脚本不需要落盘。
   */
  sessionFile?: string;
}

export interface QQOfficialStats {
  events: number;
  groupMessages: number;
  filteredByWhitelist: number;
  repliesSent: number;
  repliesRefused: number;
  /** M2.44：其中带原生按钮（keyboard）发出去的有几条 */
  buttonsSent: number;
  /** M2.47：其中走富媒体（msg_type=7，角色卡图片）发出去的有几条 */
  imagesSent: number;
  /**
   * M2.86：**真的上传过几张**（把字节交给官方上传接口换 `raw_url`）。
   *
   * ⚠️ 缓存命中**不**计入 —— 这个计数回答的是「官方上传接口被用了几次」，
   * 是排查「是不是被频次限制卡住了」的那个数。
   * 与 `imagesSent`（走富媒体发出去几条）分开，两个计数合在一起就分不清
   * 「图裂了」是 URL 的问题还是通道的问题。
   */
  imagesUploaded: number;
  /** M2.44：发失败的 Markdown（已回退纯文本）次数 —— 真机校准期间用它判断语法有没有被拒 */
  markdownFallbacks: number;
  /** M2.44：收到的按钮点击（INTERACTION_CREATE）次数 */
  interactions: number;
  /** 任务 4 要求「把 group_openid 记下来」—— 这里留最近的几个 */
  groupOpenids: string[];
  lastError: string | null;
  gateway: GatewayStats;
}

/** 运行期改配置的结果：哪些立刻生效，哪些还等着重连 */
export interface AdapterReconfigureResult {
  applied: string[];
  needsReconnect: string[];
  /** 累计还没通过重连生效的项 */
  pendingReconnect: string[];
}

/** 后台面板要的一屏状态（全部是**此刻真的在用的值**，不是 .env 里的值） */
export interface AdapterRuntimeStatus {
  appId: string;
  /** 只报「配没配」，不回显密钥本身 */
  hasSecret: boolean;
  apiBase: string;
  sandbox: boolean;
  markdown: boolean;
  buttons: boolean;
  debug: boolean;
  supportsButtons: boolean;
  supportsImages: boolean;
  allowedCommands: string[];
  connected: boolean;
  pendingReconnect: string[];
  token: {
    appId: string;
    hasToken: boolean;
    remainingSec: number | null;
    refreshes: number;
    /** M2.75：主动续期开着没有。关着时「token 会不会悄悄过期」是运营要自己关心的事 */
    autoRefresh: boolean;
    /** 主动续期的连续失败次数 */
    sweepFailures: number;
  };
  stats: QQOfficialStats;
  /**
   * M2.75：最近一次登录体检的结果，没跑过就是 null。
   *
   * 后台面板靠它回答「机器人为什么连不上」—— 面板原来只有 token 快照与计数，
   * 而「换了 token 但机器人被下架」「配额烧光」这两种情况在那两项里**完全看不出来**。
   */
  login: LoginSnapshot | null;
}

/** 登录体检的一屏快照（后台面板与 /health 共用） */
export interface LoginSnapshot {
  at: number;
  durationMs: number;
  ok: boolean;
  verdict: string;
  advice: string[];
  steps: Array<{ id: string; label: string; status: LoginStepStatus; detail: string }>;
  identity: BotIdentity | null;
  sessionLimit: SessionLimit | null;
  shards: number | null;
  tokenMasked: string;
}

/**
 * 从正文里取指令名（只取第一个词）。
 *
 * 刻意**不 import router 的 parseCommand**：适配器不该认识指令体系，
 * 真正的解析与判定全部发生在 router。这里只做一次「这段文本像不像我们要放行的那条」的
 * 粗筛，服务于灰度开关。
 */
/**
 * 从互动事件体里取出按钮的 `data`（只用于日志排查）。
 *
 * 官方文档：`data.resolved.button_data` 是「发送消息按钮时设置的 `action.data`」。
 * 本项目把它设成选项 id（数字），所以这条日志等于「玩家点了哪个选项」。
 */
export function buttonDataOf(payload: unknown): string | null {
  const resolved = (payload as { data?: { resolved?: { button_data?: string } } })?.data?.resolved;
  return resolved?.button_data ?? null;
}

/*
 * M2.82：实现搬到了 ../command-name.ts（两条通道的灰度白名单要判同一件事），
 * 这里**原样再导出** —— 既有的 import 与测试都不用动。
 */
import { commandNameOf } from '../command-name.ts';

export { commandNameOf };

/**
 * M2.86：内嵌图 URL 的缓存时长。
 *
 * 官方 `raw_url` 的读权限只在**签名**里，实测 `q-sign-time` 差是 3600 秒（1 小时）。
 * 缓存取 45 分钟 —— 留 15 分钟余量，保证「从缓存里取出来的 URL」在被平台抓取时**一定还没过期**。
 * 超时可以重新上传（缓存键不变，会覆盖成新 URL）。
 */
const INLINE_IMAGE_TTL_MS = 45 * 60 * 1000;

/** 内嵌图缓存条数上限。一张卡面几十 KB，URL 串只有 200 字节左右，200 条足够覆盖活跃玩家 */
const INLINE_IMAGE_CACHE_MAX = 200;

/**
 * 图片字节的**内容哈希**（缓存键，M2.86）。
 *
 * 用内容而不是「玩家 id + 时间」做键，是因为要回答的问题就是
 * 「这张图跟上次那张是不是同一张」—— 内容相同必得同一个键，
 * 卡面变了（数值、称号、头像）则键自然不同。
 */
function inlineImageKey(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * 角色卡消息底部的**常用按钮**（M2.47）。
 *
 * 官方 Button 的两条硬约束（docs/M2.44-QQ能力扩展.md 已登记）：
 *   · `render_data.label` **最多 10 字符**；
 *   · `action.type: 2` 是**指令按钮**（点击后在输入框插入 `@bot <data>`，玩家再发一次）。
 *
 * 为什么用指令按钮而不是回调按钮：回调要订阅 `INTERACTION (1<<26)` 并回执
 * `PUT /interactions/{id}`（见 M2.44 待办清单第 2 条），本版还没接；
 * 指令按钮只需要把指令写进 `data`，玩家点一下就得到和手打一样的结果。
 */
export function cardKeyboard(): Record<string, unknown> {
  /*
   * M2.86：改用 `commandButton`（official.ts）——它把 `visited_label` / `unsupported_tips`
   * 这些**官方文档要求的字段写全了**。旧版这里手搓的按钮只有三个字段，
   * 真机上的表现是「**根本没有按钮**」（本轮现场），所以不再另抄一份形状。
   */
  return {
    content: {
      rows: [
        {
          buttons: [
            commandButton('角色', '.角色'),
            commandButton('状态', '.状态'),
            commandButton('背包', '.背包'),
            commandButton('帮助', '.帮助'),
          ],
        },
      ],
    },
  };
}

export class QQOfficialAdapter implements Adapter {
  /**
   * M2.44：按钮由配置决定，不再写死 false。
   *
   * 之前写死 false 的理由是「按钮要 INTERACTION_CREATE，需要额外订阅与真机校准」——
   * 现在两样都做了（`INTENT_INTERACTION` + `PUT /interactions/{id}` 回应），
   * 所以开关交给 `QQ_BOT_BUTTONS=1`，默认仍是关（降级成文本菜单，语义等价）。
   */
  supportsButtons: boolean;

  /**
   * M2.47：**markdown 模式下支持图片**。
   *
   * 依据（官方 markdown 文档原文）：「对于 markdown 消息内的图片资源，
   * 请使用可在公网访问的资源 url，开放平台会下载转存该资源」。
   * ⇒ 官方通道没有"发一张图"的独立接口，图片是**正文里的一行**，
   * 所以能力跟着 markdown 开关走：`QQ_BOT_MARKDOWN=0` 时它只能是 false。
   */
  supportsImages: boolean;

  /** M2.45：图片能不能内嵌进正文 —— 与 `supportsImages` 同源（都是 markdown 开关） */
  supportsInlineImages: boolean;
  /**
   * M2.86：**官方通道不支持富文本标签**（`<font color>` 这类）——**永远 false**。
   *
   * 依据是官方 markdown 文档的「支持格式」清单，它是**完整枚举**且没有颜色：
   * 标题 / `**加粗**` / `__下划线加粗__` / `_斜体_` / `*星号斜体*` / `***加粗斜体***` /
   * `~~删除线~~` / 链接 / 图片 / 列表 / 块引用 / 分割线 / 换多行。
   * 项目旧实测也记着手机端把 `<font>` 显示成字面量。
   *
   * 想看颜色要走 OneBot（个人号）那条路 —— 它的 `supportsRichText` 是 true。
   */
  /**
   * M2.86：**这条通道支不支持富文本标签**（`<font color>` 之类）。
   *
   * 官方文档的「支持格式」清单里没有颜色，所以**默认 false**；
   * 但用户实机看到**同为官方 Bot 的「云助手」有色字**（可复制、非图片），
   * 而 `.mdprobe html` 这个探测器本来就是为「腾讯 markdown 好像支持部分 html 标签」做的 ——
   * 所以做成**配置驱动**：跑一次 `.探针 html`，哪个写法生效就设 `QQ_BOT_RICH_TEXT=1`。
   */
  readonly supportsRichText: boolean;

  #config: QQOfficialConfig;
  /** 注入的 fetch（富媒体上传要用它打 COS 与开放平台） */
  #fetch: typeof fetch;
  #logger: Logger;
  #tokens: TokenManager;
  #gateway: QQGateway;
  /** 令牌与网关的构造工厂：重连时要按**当前**配置重建（见 reconnectGateway） */
  #makeTokens: () => TokenManager;
  #makeGateway: () => QQGateway;
  /** 已经改掉、但还没通过重连真正生效的配置项（管理后台拿它提示人） */
  #pendingReconnect: string[] = [];
  #handler: MessageHandler | null = null;
  /** 最近一次登录体检的结果（M2.75）。后台面板与 /health 都读它 */
  #lastLogin: LoginReport | null = null;
  /** 会话落盘（M2.76）。null = 不落盘 */
  #sessionStore: QQSessionStore | null = null;

  /**
   * 被动回复凭证：会话 id（群 group_openid / 私聊 user openid）→ 最近一条消息。
   * seq 是给同一个 msg_id 的多条回复用的，官方要求各自不同。
   */
  /**
   * 被动回复凭证。`msgId` 来自普通消息事件，`eventId` 来自互动事件 ——
   * 官方对这两者写的是「**二选一**」（`event_id` 支持 INTERACTION_CREATE 等三类事件），
   * 所以两个都留着，发的时候谁有值用谁。
   */
  #tickets = new Map<string, { msgId: string; eventId?: string; seq: number; at: number; nickname?: string; userId?: string }>();

  /**
   * M2.99：私聊的「**身份键 → 发信地址**」。
   *
   * 两个 openid 不是一回事：
   *   · `union_openid` —— 身份（跨群、跨单聊同一个人），路由层私聊的 `targetId` 用它；
   *   · `user_openid`  —— 地址（`POST /v2/users/{openid}/messages` 认它），票据也按它存。
   *
   * 于是 union 有值时，「拿 targetId 直接查票据 / 直接拼 URL」两边都会错，
   * 而**错法都不是报错那么明显**：查不到票据 ⇒ NoReplyTicketError；
   * 地址拼成 union ⇒ 平台回 404。收消息时记下对应关系，发送时换算（见 `#privateAddress`）。
   */
  #privateAddresses = new Map<string, string>();

  /**
   * M2.86：**内嵌图 URL 缓存** —— 同一张图不重复上传。
   *
   * 为什么必须有这一层：官方上传接口有频次限制，而「同一个玩家反复发 .角色」
   * 会让同一张 PNG 被反复要求上传（每次 4 个 HTTP 往返）。
   * 缓存键是**图片字节的哈希**，所以卡面真的变了时键自然变 —— 不需要额外的失效逻辑。
   */
  #inlineImages = new Map<string, { url: string; at: number }>();

  readonly stats: QQOfficialStats = {
    events: 0,
    groupMessages: 0,
    filteredByWhitelist: 0,
    repliesSent: 0,
    repliesRefused: 0,
    buttonsSent: 0,
    imagesSent: 0,
    imagesUploaded: 0,
    markdownFallbacks: 0,
    interactions: 0,
    groupOpenids: [],
    lastError: null,
    gateway: {
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
    },
  };

  constructor(
    config: QQOfficialConfig,
    /*
     * `fetch` 也可注入（M2.47）：富媒体上传要打 COS 预签名 URL，
     * 那段逻辑必须能脱网测试 —— 否则每条用例都要真传一次文件到腾讯云。
     */
    deps: { tokens?: TokenManager; gateway?: QQGateway; fetch?: typeof fetch } = {},
  ) {
    this.#config = config;
    this.supportsButtons = config.buttons === true;
    this.supportsImages = config.markdown === true;
    this.supportsInlineImages = config.markdown === true;
    this.supportsRichText = config.richText === true;
    this.#logger = config.logger ?? consoleLogger;
    this.#fetch = deps.fetch ?? fetch;
    /*
     * 令牌与网关做成工厂而不是直接 new：管理后台的「重连网关」要按**当前**配置
     * 重建它们 —— intents / apiBase / 凭证都是构造时烘进网关的，改不了只能重建。
     * 注入的依赖优先：测试不该因为一次重连就丢掉自己的假网关。
     */
    this.#makeTokens = () =>
      deps.tokens ??
      new TokenManager({
        appId: this.#config.appId,
        clientSecret: this.#config.clientSecret,
        timeoutMs: this.#config.timeoutMs,
        /*
         * M2.75：**注入的 fetch 必须一路贯穿到令牌管理器**。
         *
         * 早先这里漏了它：注入了假 fetch 的测试在「需要换 token」的那一刻仍会真的
         * 去打 api.bot.qq.com，于是用例拿到的是平台的真实业务错误
         * （比如 code=10004「机器人不存在」）—— 排查方向会被带向「AppID 配错了」，
         * 而真正的原因是「这一层没脱网」。所有出网调用必须是同一个 fetch，
         * 否则「能注入」就只是半句话。
         */
        ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
      });
    this.#makeGateway = () =>
      deps.gateway ??
      new QQGateway({
        apiBase: this.#config.apiBase ?? API_BASE_PROD,
        intents: intentsFor(this.#config),
        logger: this.#logger,
        // M2.76：取网关地址这一步也要用同一个 fetch —— 否则「注入」只是半句话
        fetchImpl: this.#fetch,
        tokenProvider: () => this.#tokens.get(),
        onRawFrame: (raw) => {
          if (this.#config.debug) this.#logger.info('网关原始帧', { raw });
        },
        onDispatch: async (payload) => {
          // 第三个参数是**事件最外层的 id** —— 互动事件回执要用它（见 handleDispatch）
          await this.handleDispatch(payload.t, payload.d, payload.id);
        },
        /*
         * M2.75：网关因鉴权失败（close 4004）时会先来这里作废 token 再连一次。
         * token 提前失效是常见情形；不作废的话「token 恰好失效」会被误判成
         * 「AppID 不对」而直接停止重连 —— 一个本来能自愈的抖动变成要人介入的故障。
         */
        onAuthFailure: () => {
          this.#tokens.invalidate();
          this.#logger.warn('网关报鉴权失败，已作废 access_token（下次 identify 会换新的）');
        },
        /*
         * 致命关闭码：网关已经**停止重连**。这里必须留下痕迹，
         * 否则表现就是「机器人忽然不理人，日志里什么都没有」。
         */
        onFatal: (info) => {
          this.stats.lastError = '登录失败：' + info.title + '（close ' + info.code + '）';
          this.#logger.error('登录失败，网关已停止重连', {
            code: info.code, title: info.title, advice: info.advice,
          });
        },
        /*
         * M2.76：会话落盘。网关把「会话变了」这件事交出来，这里只做一个判断：
         *   有 sessionId 且有 seq → 存起来（下次重启能 resume）
         *   任何一个是 null      → 会话已作废，把盘上那份删掉
         *                         （留着它，下次重启还会拿这个死会话去 resume，白等一轮往返）
         * 合并写与原子写都在 QQSessionStore 里，这里不重复实现。
         */
        ...(this.#sessionStore === null ? {} : {
          resumeState: this.#sessionStore.load(),
          onSession: (session: { sessionId: string | null; seq: number | null; url: string | null }) => {
            const store = this.#sessionStore;
            if (store === null) return;
            if (session.sessionId === null || session.seq === null) store.clear();
            else store.save({ sessionId: session.sessionId, seq: session.seq, url: session.url, savedAt: Date.now() });
          },
        }),
      });

    this.#sessionStore = config.sessionFile === undefined
      ? null
      : new QQSessionStore(config.sessionFile, {
          onError: (message) => this.#logger.warn('会话缓存', { message }),
        });
    this.#tokens = this.#makeTokens();
    this.#gateway = this.#makeGateway();
    /*
     * M2.75：`stats.gateway` 必须指向**真网关那一个 stats 对象**。
     *
     * 原来它在字段初始化器里手写了一份同名字面量 —— 数值一样、对象不同，
     * 于是 `adapter.stats.gateway.identifies` 在运行期**恒为 0**：
     * 只有 stop() 与 reconnectGateway() 那两处赋值会同步一次。
     * 后台面板读的正是这个字段，所以「网关计数一直是 0」既不会报错也没人会察觉 ——
     * 典型的静默错误，属于这个仓库最在意的那一类。
     */
    this.stats.gateway = this.#gateway.stats;
  }

  get tokens(): TokenManager {
    return this.#tokens;
  }

  /** 当前灰度白名单（'*' = 全放行，空数组 = 全放行）。启动日志与 /health 都用它 */
  get allowedCommands(): readonly string[] {
    return this.#config.allowedCommands ?? [];
  }

  get apiBase(): string {
    return this.#config.apiBase ?? API_BASE_PROD;
  }

  get gateway(): QQGateway {
    return this.#gateway;
  }

  /**
   * 跑一次登录体检（M2.75）。后台按钮、启动自检、CLI 三个入口都走这一个方法 ——
   * 三处各写一份的话，口径迟早会分叉，而「面板说正常、启动日志说有问题」是最难解释的一类。
   *
   * **它不抛异常**：报告里带着失败步骤与处置建议（见 login-check.ts 的口径）。
   */
  async loginCheck(): Promise<LoginReport> {
    const report = await runLoginCheck({
      appId: this.#config.appId,
      apiBase: this.apiBase,
      tokenProvider: () => this.#tokens.get(),
      // 体检与业务共用同一个 fetch：测试注入假 fetch 时，体检也走假的（不必脱网真打）
      fetchImpl: this.#fetch,
      ...(this.#config.timeoutMs === undefined ? {} : { timeoutMs: NUMERIC.qqBot.checkTimeoutMs }),
      gatewayStats: () => this.#gateway.stats,
    });
    this.#lastLogin = report;
    this.#logger.info('登录体检完成', {
      ok: report.ok,
      verdict: report.verdict,
      bot: report.identity?.username ?? null,
      remaining: report.gatewayBot?.sessionLimit?.remaining ?? null,
      durationMs: report.durationMs,
    });
    for (const item of report.advice) this.#logger.warn('登录体检建议', { advice: item });
    return report;
  }

  /** 最近一次体检结果（没跑过返回 null） */
  get lastLogin(): LoginReport | null {
    return this.#lastLogin;
  }

  /** 连上网关并开始收事件；resolve 只代表 socket 开了 */
  async start(): Promise<void> {
    this.#logger.info('QQ 官方适配器启动', {
      appId: this.#config.appId,
      apiBase: this.#config.apiBase ?? API_BASE_PROD,
      intents: intentsFor(this.#config),
      allowedCommands: this.#config.allowedCommands?.length ? this.#config.allowedCommands.join(',') : '(全放行)',
      /*
       * M2.47：**markdown 要在启动日志里可见**。
       *
       * 它是角色卡能不能出图的总开关（官方图片只能挂在 markdown 正文里），
       * 而它没开时的症状是「机器人回话正常、就是没有图」—— 只靠翻 .env 排查太慢。
       * `images` 直接给出结论：false = 这条路现在是死的，别去怀疑图床。
       */
      markdown: this.#config.markdown === true,
      images: this.supportsImages,
      buttons: this.#config.buttons === true,
    });
    await this.#gateway.connect();
  }

  /** 等到 READY（identify 被平台接受） */
  async waitReady(timeoutMs = 20_000): Promise<void> {
    return this.#gateway.waitReady(timeoutMs);
  }

  stop(): void {
    this.#gateway.close();
    this.stats.gateway = this.#gateway.stats;
    /*
     * 退出前把会话落盘（M2.76）：进程是被人 stop 的还是自己崩的都不要紧，
     * 盘上那份会话就是下次启动能不能 resume 的全部依据。
     */
    this.#sessionStore?.flush();
  }

  /**
   * 运行期改配置（管理后台用）。
   *
   * ## 为什么需要它
   *
   * 配置原来只在构造时读一遍，所以改完 .env **必须重启进程**才生效。开发期一天重启
   * 四五次，每次重启都会断网关、清掉被动回复凭证（reply ticket）—— 玩家那边表现为
   * 「机器人忽然不理人一会儿」。能在运行期改的就不该让人重启。
   *
   * ## 判据是「这个值什么时候被读」
   *
   *   · **每条消息都读一次** → 写进 #config 就立刻生效（白名单 / markdown / debug / 上限）
   *   · **只在建立连接时用一次** → 必须重建网关（intents / apiBase / 凭证）
   *
   * `buttons` 落在中间，所以两边都出现：`supportsButtons` 立刻能改（发按钮靠
   * keyboard.content，与订阅无关），但**收到按钮点击**要 INTERACTION (1<<26) 订阅，
   * 而 intents 是连接时定下的。改完不重连 = 按钮能发出去、点了没反应。
   */
  reconfigure(patch: Partial<QQOfficialConfig>): AdapterReconfigureResult {
    const applied: string[] = [];
    const needsReconnect: string[] = [];
    const cfg = this.#config as unknown as Record<string, unknown>;

    /** 每条消息都读的项 */
    const hot: Array<keyof QQOfficialConfig> = [
      'allowedCommands', 'markdown', 'debug', 'maxContentChars', 'replyWindowMs',
    ];
    /** 连接时烘进网关的项 */
    const cold: Array<keyof QQOfficialConfig> = ['appId', 'clientSecret', 'apiBase', 'buttons'];

    /*
     * 只把**真的变了**的项报成「立刻生效」。
     *
     * 面板每次提交都会带上全部字段，不比一下的话，改一个白名单会回一句
     * 「立刻生效：指令白名单、Markdown 消息」—— 而 Markdown 根本没动。
     * 回执说的和做的不一样，人就再也不信这个回执了。
     */
    const sameValue = (a: unknown, b: unknown): boolean =>
      Array.isArray(a) && Array.isArray(b) ? a.join('\u0000') === b.join('\u0000') : a === b;

    for (const key of hot) {
      if (!(key in patch)) continue;
      if (sameValue(cfg[key], patch[key])) continue;
      cfg[key] = patch[key];
      applied.push(key);
    }
    // markdown 是「能不能发图」的总开关，而 supportsImages 是构造时烘的，要同步
    if (applied.includes('markdown')) {
      this.supportsImages = this.#config.markdown === true;
      this.supportsInlineImages = this.#config.markdown === true;
    }

    for (const key of cold) {
      if (!(key in patch)) continue;
      if (cfg[key] === patch[key]) continue;
      cfg[key] = patch[key];
      needsReconnect.push(key);
      if (!this.#pendingReconnect.includes(key)) this.#pendingReconnect.push(key);
    }
    if (needsReconnect.includes('buttons')) this.supportsButtons = this.#config.buttons === true;
    // 凭证变了：令牌管理器也攥着一份，必须一起重建，否则取到的还是旧 AppID 的令牌
    if (needsReconnect.includes('appId') || needsReconnect.includes('clientSecret')) {
      this.#tokens = this.#makeTokens();
    }

    this.#logger.info('适配器配置已改', {
      applied, needsReconnect, pendingReconnect: this.#pendingReconnect,
    });
    return { applied, needsReconnect, pendingReconnect: [...this.#pendingReconnect] };
  }

  /**
   * 按当前配置**重建**网关并重连。返回时 socket 已开，但还没等到 READY。
   *
   * 为什么不「关掉再开」：intents 与 apiBase 是 new QQGateway 时传进去的，
   * 老对象上没有地方改。重建是唯一能让它们生效的办法。
   */
  async reconnectGateway(): Promise<void> {
    /*
     * 重建网关前先把会话落盘：内存里的会话在旧对象上，新网关要从盘上重新 load。
     * 不 flush 的话，节流窗口里那 500ms 的 seq 更新就白丢了（方向安全，但没必要丢）。
     */
    this.#sessionStore?.flush();
    this.#gateway.close(1000, 'reconfigure');
    this.#gateway = this.#makeGateway();
    this.#pendingReconnect = [];
    this.#logger.info('网关已按新配置重建，正在重连', {
      appId: this.#config.appId,
      apiBase: this.apiBase,
      intents: intentsFor(this.#config),
    });
    await this.#gateway.connect();
    this.stats.gateway = this.#gateway.stats;
  }

  /** 后台面板要的一屏状态：配置 + 连接 + 令牌 + 计数，全部是此刻真的在用的值 */
  runtimeStatus(): AdapterRuntimeStatus {
    return {
      appId: this.#config.appId,
      hasSecret: (this.#config.clientSecret ?? '').length > 0,
      apiBase: this.apiBase,
      sandbox: this.apiBase === API_BASE_SANDBOX,
      markdown: this.#config.markdown === true,
      buttons: this.#config.buttons === true,
      debug: this.#config.debug === true,
      supportsButtons: this.supportsButtons,
      supportsImages: this.supportsImages,
      allowedCommands: [...this.allowedCommands],
      connected: this.#gateway.ready,
      pendingReconnect: [...this.#pendingReconnect],
      token: this.#tokens.snapshot(),
      stats: this.stats,
      login: this.#lastLogin === null ? null : snapshotOf(this.#lastLogin),
    };
  }

  onMessage(handler: MessageHandler): void {
    this.#handler = handler;
  }

  /**
   * 处理一条网关事件，返回映射出的 InternalMessage（被忽略时为 null）。
   *
   * 公开而非私有：形状对齐 OfficialAdapter.handleEvent ——
   * 联调脚本与测试可以直接喂一个事件体进来，不必真的连上网关。
   */
  /**
   * @param eventId 事件**最外层的** id（网关帧的 `id`，形如 `INTERACTION_CREATE:<uuid>`）。
   *   互动事件的被动回执要的是它，**不是 `d.id`** —— 官方原文「从事件最外层的 id 获取」。
   *   传错了平台回 `err_code=40034025 请求参数event_id无效`（真机实测的原文）。
   */
  async handleDispatch(t: string, d: unknown, eventId?: string): Promise<InternalMessage | null> {
    this.stats.events += 1;
    this.stats.gateway = this.#gateway.stats;
    const payload = (d ?? {}) as QQGroupAtPayload;

    let msg: InternalMessage | null = null;
    const isGroupMessage = t === EVENT_GROUP_AT_MESSAGE_CREATE || t === EVENT_GROUP_MESSAGE_CREATE;
    if (isGroupMessage) {
      /*
       * **这里不做 @ 过滤** —— 群里所有消息都放进来，由路由去识别指令文本。
       *
       * 曾经这里要求 `mentions[].is_you === true`（只放行 @ 机器人的），那是错的。
       * 「这是不是一条给机器人的消息」在本项目里本来就由**指令后缀约定**回答
       * （`.` / `。` / `．` 开头，见 parseCommand），而不是由 @ 回答 ——
       * OneBot 通道从来不过滤 @，群里的 `.探索` 一直都能用。
       * 官方通道没有任何理由比它更严：玩家在群里打过 `.创建 张三`，本就该被认。
       *
       * 真正的安全阀有两道，都长在路由侧、都不依赖 @：
       *   ① 非指令文本（既不是 `.xxx` 也不是数字）在 router.handle 里直接 return []，
       *      连幂等表都不写；
       *   ② 裸数字要过 #hasPendingMenu —— 只有**正在跟机器人玩的那个人**的数字才认，
       *      别人随口打的「1」查不到待命菜单，一声不响。
       */
      msg = mapQQGroupAtMessage(payload, Date.now());
      /*
       * ⚠️ M2.99：**映射失败必须留痕。**
       * 私聊那边的教训是「日志里只有一句收到事件，之后什么都没有，只能靠猜」——
       * 群这条路是同一个形状：下面的日志原来整段写在 `if (msg)` 里，
       * 一旦映射返回 null（比如 payload 里 group_openid 是空串）就一片安静。
       */
      if (!msg) {
        this.#logger.warn('群消息映射失败（消息被丢弃）', {
          t,
          msgId: payload.id ?? '',
          groupOpenid: payload.group_openid ?? '',
          authorKeys: Object.keys(payload.author ?? {}),
          raw: JSON.stringify(payload).slice(0, 500),
        });
      } else {
        this.stats.groupMessages += 1;
        this.#rememberGroupOpenid(msg.sceneId);
        /*
         * 凭证对**每一条**入站群消息都刷新 —— 包括下面会被灰度开关拦掉的那些。
         *
         * 理由：凭证（5 分钟内的 msg_id）是这个通道上唯一稀缺的资源，
         * 越新越值钱；而 Adapter.sendGroup(groupId, text) 这个接口没有
         * 「回复哪一条」的参数（它与 OneBot 共用，不能为官方加字段），
         * 所以只能取「最近一条」。
         *
         * 代价说清楚：若群里刚有人发了被白名单拦下的 .探索，
         * 紧接着发出去的回复会**引用** .探索 那条（QQ 会显示成引用回复）。
         * 内容仍然正确，只是引用对象不是被答复的那条。
         * 接受这个代价，因为它比「拿一条 4 分 59 秒前的旧凭证」安全得多。
         */
        // 昵称一并存下：MD 回执顶部要标「这条是谁的」（群里多人同时玩时用来分辨）
        this.#tickets.set(msg.sceneId, { msgId: payload.id ?? '', seq: 0, at: Date.now(), nickname: msg.nickname, userId: msg.userId });
        // 任务 4 的验收：把完整 payload 打出来，group_openid 也从这里抄
        this.#logger.info('收到群 @ 消息（完整 payload）', {
          t,
          payload: JSON.stringify(payload),
          groupOpenid: msg.sceneId,
          memberOpenid: msg.userId,
          msgId: payload.id ?? '',
          content: msg.rawText,
          // 有没有 @ 机器人不再影响处理，但排查时它是最想知道的一个事实
          atBot: isBotMentioned(payload),
        });
      }
    } else if (t === EVENT_INTERACTION_CREATE) {
      /*
       * 按钮点击（M2.44）。
       *
       * **顺序是有讲究的：先回应，再交给路由。**
       * 回应（PUT /interactions/{id}）是给平台看的，用来解除客户端那个转圈的 loading；
       * 而路由那条路要查库、跑判定，可能几百毫秒 —— 先等它会把 loading 拖长。
       * 官方还说「同一个 interaction_id 只能回应一次」，所以这里只调一次、不看结果。
       *
       * 回应失败**不阻断**后续处理：玩家点了按钮就该拿到回执，
       * 哪怕那个 loading 解除得晚一点。失败会记进 stats.lastError。
       */
      await this.#ackInteraction(payload.id);
      msg = mapOfficialInteraction({ t, d: payload });
      /*
       * ⚠️ 这条日志**必须打在 `if (msg)` 外面**。
       * M2.44 的现场就是：事件收到了、映射返回 null、于是「收到按钮点击」那条没打，
       * 日志里只剩下光秃秃一句「收到事件」—— 花了一轮才定位到是 userId 取不到。
       * 映射失败本身就是最该记下来的事实。
       */
      this.#logger.info('互动事件', {
        interactionId: payload.id ?? '',
        mapped: msg !== null,
        buttonData: buttonDataOf(payload),
        chatType: (payload as { chat_type?: number }).chat_type ?? null,
        groupOpenid: (payload as { group_openid?: string }).group_openid ?? null,
        memberOpenid: (payload as { group_member_openid?: string }).group_member_openid ?? null,
        raw: this.#config.debug ? JSON.stringify(payload).slice(0, 700) : undefined,
      });
      if (msg) {
        this.stats.interactions += 1;
        this.#rememberGroupOpenid(msg.sceneId);
        /*
         * 互动事件的被动回复凭证是**事件最外层的 id**（`INTERACTION_CREATE:<uuid>`）。
         *
         * ⚠️ 别把三个 id 混了，它们在这一条里各不相同、作用也不同：
         *   `eventId`     —— 网关帧最外层的 `id`，**回执用它**（`event_id` 字段）
         *   `payload.id`  —— 事件体的 `d.id`，**回应互动用它**（`PUT /interactions/{id}`）
         *   `button_data` —— 玩家点了哪个选项
         * M2.44 真机：拿 `d.id` 当 `event_id` 发出去，平台回「请求参数event_id无效」。
         */
        this.#tickets.set(msg.sceneId, {
          msgId: payload.id ?? '',
          eventId: eventId ?? payload.id ?? '',
          seq: 0,
          at: Date.now(),
          nickname: msg.nickname,
          userId: msg.userId,
        });
        this.#logger.info('收到按钮点击', {
          interactionId: payload.id ?? '',
          buttonData: buttonDataOf(payload),
          sceneId: msg.sceneId,
          userId: msg.userId,
        });
      }
    } else if (t === EVENT_C2C_MESSAGE_CREATE) {
      msg = mapQQC2CMessage(payload, Date.now());
      /*
       * ⚠️ 这条日志**必须打在 `if (msg)` 外面** —— 与上面互动事件同一条教训（M2.44）。
       *
       * M2.99 现场：玩家私聊发 `.状态`，日志里只有一句「收到事件」，
       * 之后**什么都没有** —— 没有报错、没有「消息已发出」，玩家看到的就是「没反应」。
       * 根因是映射返回了 null（取 openid 用了 `??` 链，被空串截断），
       * 而「映射失败」这件事当时一个字都没记，只能靠翻 payload 猜。
       */
      this.#logger.info('收到私聊消息', {
        messageId: payload.id ?? '',
        mapped: msg !== null,
        userId: msg?.userId ?? null,
        sceneId: msg?.sceneId ?? null,
        rawText: msg?.rawText ?? null,
        ...(this.#config.debug ? { raw: JSON.stringify(payload).slice(0, 700) } : {}),
      });
      if (msg) this.#tickets.set(msg.sceneId, { msgId: payload.id ?? '', seq: 0, at: Date.now(), nickname: msg.nickname, userId: msg.userId });
    } else if (this.#config.debug) {
      this.#logger.info('收到其他事件', { t, payload: JSON.stringify(payload).slice(0, 800) });
    }

    if (!msg) return null;
    /*
     * M2.99：私聊的**身份键**与**发信地址**是两个不同的 openid，这里把对应关系记下来。
     *   · `userId`  —— 身份（官方 C2C 里是 union_openid），路由层私聊的 targetId 用它；
     *   · `sceneId` —— 地址（user_openid），官方发送接口与票据都按它来。
     * 两者不同时才会有映射；相同（union 为空、或 OneBot 通道）时这里什么都不做。
     */
    if (msg.scene === 'private' && msg.userId !== msg.sceneId) this.#privateAddresses.set(msg.userId, msg.sceneId);
    if (!this.#allowed(msg)) return null;

    if (!this.#handler) {
      // 消息已经记进凭证表了，只是没人消费 —— 返回 msg 让调用方看得见
      this.#logger.warn('适配器还没有 onMessage 处理器，消息未被消费', { messageId: msg.messageId });
      return msg;
    }
    await this.#handler(msg);
    return msg;
  }

  /**
   * 回应互动事件（`PUT /interactions/{interaction_id}`）。
   *
   * 官方原文：「收到事件后需调用 `PUT /interactions/{interaction_id}` 接口回应，
   * 否则客户端会一直 loading 直到超时」「同一 interaction_id 只能回应一次」。
   *
   * 吞掉异常是有意的：回应失败不该让玩家的这次点击没有回执。
   */
  async #ackInteraction(interactionId: string | undefined): Promise<void> {
    if (!interactionId) return;
    try {
      const token = await this.#tokens.get();
      const base = (this.#config.apiBase ?? API_BASE_PROD).replace(/\/+$/, '');
      const response = await fetch(`${base}/interactions/${encodeURIComponent(interactionId)}`, {
        method: 'PUT',
        headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ code: 0 }),
      });
      if (!response.ok) {
        this.stats.lastError = `互动回应失败 HTTP ${response.status}`;
        this.#logger.warn('互动回应失败', { interactionId, status: response.status });
      }
    } catch (error) {
      this.stats.lastError = `互动回应异常：${String(error)}`;
      this.#logger.warn('互动回应异常', { interactionId, error: String(error) });
    }
  }

  /**
   * 灰度闸门：只放行白名单里的**显式指令**。
   *
   * ⚠️ 早期的写法是「拿不到指令名就拦」，那是错的 —— 数字回复（`1`）、
   * 菜单选项的纯文本、自由输入待命，这些**没有指令名**，但恰恰是白名单里
   * 那条指令**流程的一部分**：放行 `.创建` 却不放行它下一步的「1」，
   * 等于让玩家卡在半路上。实测就撞到了：
   *     .创建 李四 → 群里正常摆出性别菜单
   *     回 1        → 灰度开关拦下 {"rawText":"1","commandName":null}
   *
   * 所以这里只对**显式指令**（`.` / `。` / `．` 开头）做白名单判断；
   * 其余一律放行，交给路由 —— 路由那边本来就有更准的闸门
   * （非指令直接 return []；裸数字要过 #hasPendingMenu）。
   */
  #allowed(msg: InternalMessage): boolean {
    const allowed = this.#config.allowedCommands;
    if (!allowed || allowed.length === 0) return true;
    if (allowed.includes('*')) return true;
    const name = commandNameOf(msg.rawText);
    // 不是显式指令 → 不属于灰度白名单的管辖范围（数字回复 / 选项文本 / 自由输入）
    if (name === null) return true;
    if (allowed.includes(name)) return true;
    this.stats.filteredByWhitelist += 1;
    this.#logger.info('灰度开关拦下（未在白名单内）', {
      rawText: msg.rawText,
      commandName: name,
      allowed: allowed.join(','),
    });
    return false;
  }

  #rememberGroupOpenid(openid: string): void {
    if (this.stats.groupOpenids.includes(openid)) return;
    this.stats.groupOpenids.push(openid);
    // 只留最近 20 个，避免长期运行无限增长
    if (this.stats.groupOpenids.length > 20) this.stats.groupOpenids.shift();
  }

  /**
   * 把私聊的 `targetId` 换算成官方认的**发信地址**。
   *
   * 路由层私聊传的是 `msg.userId`（身份，官方 C2C 里是 union_openid），
   * 而官方发送接口 `POST /v2/users/{openid}/messages` 与被动回复票据都认 `user_openid`。
   * 只有真的见过这个人的私聊消息、且两个 id 不同时才有映射；其余情况**原样返回** ——
   * 所以 OneBot 通道（私聊 userId 与 sceneId 都是 QQ 号）与 union 为空的官方 C2C
   * 这两条既有路径的行为一个字都没变。
   */
  #privateAddress(targetId: string): string {
    return this.#privateAddresses.get(targetId) ?? targetId;
  }

  /* ---------------- 发送侧 ---------------- */

  /*
   * M2.125：主动推送 = **不借任何被动回复凭证**。
   *
   * 这个语义在本类里**早就存在** —— `#buildReply` 见到 `header === null` 就走
   * `#buildProactiveBody`（不带 msg_id / event_id / msg_seq 的主动消息体）。
   * 世界播报调的正是 `sendGroup(id, text, null, buttons)`。
   *
   * 所以这个方法**不是新能力，是给那条路一个显式的名字**：
   *   · 接口层从此说得出「这条不许借凭证」，别的通道不会再照抄成借凭证的写法；
   *   · 以后要给主动消息加东西（重试策略、频控、审核回执），有唯一的落点。
   */
  async sendProactive(scene: Scene, targetId: string, text: string, buttons?: ButtonSpec[]): Promise<void> {
    if (scene === 'private') return this.sendPrivate(targetId, text, null, buttons);
    return this.sendGroup(targetId, text, null, buttons);
  }

  async sendGroup(groupOpenid: string, text: string, header?: MessageHeader | null, buttons?: ButtonSpec[]): Promise<void> {
    const body = await this.#buildReply('group', groupOpenid, text, header, undefined, buttons);
    await this.#post(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, body);
    this.stats.repliesSent += 1;
  }

  async sendPrivate(userOpenid: string, text: string, header?: MessageHeader | null, buttons?: ButtonSpec[]): Promise<void> {
    // M2.99：传进来的可能是**身份键**（union_openid），官方接口要的是**发信地址**（user_openid）
    const address = this.#privateAddress(userOpenid);
    const body = await this.#buildReply('private', address, text, header, undefined, buttons);
    await this.#post(`/v2/users/${encodeURIComponent(address)}/messages`, body);
    this.stats.repliesSent += 1;
  }

  /**
   * 频道消息：官方群机器人没有频道概念（那是 guild 那套 API）。
   * 明确抛错而不是静默丢弃 —— 路由的 sendReplies 会把它记进日志。
   */
  async sendChannel(_channelId: string, _text: string): Promise<void> {
    throw new Error('QQ 官方群机器人不支持频道（channel）场景，请用 sendGroup / sendPrivate');
  }

  /**
   * M2.47：官方通道发图 —— **走富媒体（msg_type: 7 + media.file_info）**。
   *
   * ## 为什么不是 markdown 图片外链
   *
   * markdown 也支持图片（`![alt #宽px #高px](url)`），但它要求一个**公网可访问**的 url。
   * 真机试过一次：图确实画了、也传上图床拿到了 url、markdown 也发出去了 200，
   * **但 QQ 客户端里是一个破图框**（alt 文字显示出来、图片加载不出）。原因不外两种：
   * 客户端取不到那个图床域名，或平台没有转存。无论哪种，外链这条路在真机上是不可靠的。
   *
   * 富媒体把图片**直接传给平台**：分片上传 → 合并 → 拿 file_info → msg_type=7 发送。
   * 不依赖图床、不依赖公网地址，`file_info` 有效期 24 小时。
   *
   * ## 官方定义的四步（本机实测逐条通过）
   *
   * | 步 | 接口 | 实测 |
   * | --- | --- | --- |
   * | ① | `POST /v2/groups/{openid}/upload_prepare` `{file_type,file_size,file_name}` | 200 ⇒ `upload_id` + `parts[].presigned_url` |
   * | ② | `PUT` 每个分片到它的 presigned_url（**不带 Authorization**，COS 认签名） | 200 |
   * | ③ | `POST /v2/groups/{openid}/upload_part_finish` `{upload_id,part_index,block_size}` | 200 |
   * | ④ | `POST /v2/groups/{openid}/files` `{file_type,upload_id,srv_send_msg:false}` | 200 ⇒ `file_info`（ttl 86400） |
   * | ⑤ | `POST /v2/groups/{openid}/messages` `{msg_type:7, media:{file_info}}` | 200，**群里真的显示出图片** |
   *
   * 卡面只有几十 KB，正常只会有一个分片；仍按官方流程逐片处理，免得将来图变大就断。
   *
   * ⚠️ **群与单聊的上传接口是分开的**（`/v2/groups/…` vs `/v2/users/…`），
   * 且"用群接口上传的文件仅能发送到群聊"。
   *
   * M2.86：单聊那一路**已实测通过**（`/v2/users/{openid}/` 四步返回 `raw_url`，
   * 回读 200 / `image/png`），所以两边的上传都收敛到 `#uploadMedia`。
   * 频道（guild）是另一套 API，仍未接 —— 那里返回 false，由调用方降级。
   */
  /**
   * M2.47：QQ 官方通道的头像直链。
   *
   * 用户给的 API 形状：`https://q.qlogo.cn/qqapp/[appid]/[openid]/[size]`。
   * 群消息事件里带着 `author.member_openid`（已核对真机 payload），
   * 而通道侧把它存成了 `InternalMessage.userId` —— 所以这里直接用它。
   */
  avatarUrlForUser(userId: string, size = 640): string | undefined {
    if (userId.length === 0) return undefined;
    return avatarUrlOf(this.#config.appId, userId, size);
  }

  /**
   * 官方富媒体上传（M2.86 从 `sendImage` 里提炼）：四步 → `{ fileInfo, rawUrl }`。
   *
   * ## ⚠️ `PUT` 分片必须带 `content-type`（本轮实测最关键的一行）
   *
   * 不带时 COS 把对象存成 `application/octet-stream`，平台抓到**不认** ⇒ markdown 里裂图；
   * 带上 `image/png` 时对象的 `content-type` 就是 `image/png`，平台正常转存 ⇒ 显示。
   * 预签名的 `q-header-list=host` 只覆盖 host，所以这个 header 加得上。
   *
   * 顺带记一笔别被误导的：`x-cos-force-download: true` 与 `content-disposition: attachment`
   * **不影响**转存 —— 第一版就是把它们当成了裂图根因（详见 docs/QQ-markdown-能力实测.md 第五节）。
   *
   * ## 群与单聊的接口是分开的
   *
   * 官方口径：「用群接口上传的文件仅能发送到群聊」。所以路径按 scene 二选一。
   * M2.86 实测单聊 `/v2/users/{openid}/…` 四步同样通 ⇒ 两边都走这里。
   */
  async #uploadMedia(
    scene: Scene,
    targetId: string,
    image: OutboundImage,
  ): Promise<{ fileInfo: string; rawUrl: string }> {
    const token = await this.#tokens.get();
    const auth = { authorization: `QQBot ${token}` };
    const base = scene === 'private'
      ? `/v2/users/${encodeURIComponent(targetId)}`
      : `/v2/groups/${encodeURIComponent(targetId)}`;

    const call = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await this.#fetch(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`QQ 富媒体 ${path} 失败：${res.status} ${text.slice(0, 200)}`);
      return text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    };

    const ext = image.mediaType === 'image/jpeg' ? 'jpg'
      : image.mediaType === 'image/webp' ? 'webp'
        : image.mediaType === 'image/gif' ? 'gif' : 'png';

    // ① 准备
    const prep = await call(`${base}/upload_prepare`, {
      file_type: 1,
      file_size: image.bytes.length,
      file_name: `card.${ext}`,
    });
    const uploadId = String(prep.upload_id ?? '');
    const parts = Array.isArray(prep.parts) ? (prep.parts as Array<{ index: number; presigned_url: string }>) : [];
    if (uploadId.length === 0 || parts.length === 0) throw new Error('QQ 富媒体：upload_prepare 没给出 upload_id/parts');

    // ② 逐片 PUT + ③ 逐片通知完成
    for (const part of parts) {
      const put = await this.#fetch(part.presigned_url, {
        method: 'PUT',
        // ⚠️ 这一行决定 markdown 里裂不裂（见方法注释）
        headers: { 'content-type': image.mediaType },
        body: image.bytes,
      });
      if (!put.ok) throw new Error(`QQ 富媒体：分片 ${part.index} 上传失败 ${put.status}`);
      await call(`${base}/upload_part_finish`, {
        upload_id: uploadId,
        part_index: part.index,
        block_size: image.bytes.length,
      });
    }

    // ④ 合并拿 file_info 与 raw_url
    const merged = await call(`${base}/files`, {
      file_type: 1,
      upload_id: uploadId,
      srv_send_msg: false,
    });
    const fileInfo = String(merged.file_info ?? '');
    if (fileInfo.length === 0) throw new Error('QQ 富媒体：合并后没有 file_info');
    return { fileInfo, rawUrl: String(merged.raw_url ?? '') };
  }

  /**
   * M2.86：把图**上传换成能写进 markdown 正文的 URL**（`raw_url`）。
   *
   * 这一位补上了 M2.47 留下的缺口：官方 markdown 要「平台能抓到的公网图片 URL」，
   * 而外部图床与自建托管**全都不在 SSRF 白名单里**（真机四次裂图）。
   * 官方上传接口返回的 `raw_url` 落在 `*.myqcloud.com`（名单内）⇒「零成本图床」成立。
   *
   * 失败返回 `undefined`（不抛）：上传是**可降级的**一步，调用方还有富媒体直发与文字卡两条路。
   */
  async prepareInlineImage(scene: Scene, targetId: string, image: OutboundImage): Promise<string | undefined> {
    if (scene === 'channel') return undefined;
    if (image.bytes.length === 0) return undefined;
    // M2.99：私聊先换算成发信地址（上传接口是按 /v2/users/{openid} 分路的）
    if (scene === 'private') targetId = this.#privateAddress(targetId);

    const key = inlineImageKey(image.bytes);
    const hit = this.#inlineImages.get(key);
    if (hit !== undefined && Date.now() - hit.at < INLINE_IMAGE_TTL_MS) {
      // 缓存命中**不计** imagesUploaded —— 那个计数回答的是「真的上传了几张」，
      // 用来判断官方上传接口的用量；命中缓存没有产生任何上传。
      return hit.url;
    }

    try {
      const { rawUrl } = await this.#uploadMedia(scene, targetId, image);
      if (rawUrl.length === 0) return undefined;
      this.#inlineImages.set(key, { url: rawUrl, at: Date.now() });
      // 超上限先挤掉最旧的一条（Map 的迭代顺序就是插入顺序）
      while (this.#inlineImages.size > INLINE_IMAGE_CACHE_MAX) {
        const oldest = this.#inlineImages.keys().next().value;
        if (oldest === undefined) break;
        this.#inlineImages.delete(oldest);
      }
      this.stats.imagesUploaded += 1;
      return rawUrl;
    } catch (error) {
      this.#logger.warn('官方通道：图片上传失败，回落富媒体直发', {
        scene,
        bytes: image.bytes.length,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  async sendImage(scene: Scene, targetId: string, image: OutboundImage): Promise<boolean> {
    // 群与单聊都走富媒体（M2.86：单聊上传接口已实测通过）；频道没接，交给调用方降级
    if (scene === 'channel') return false;
    if (image.bytes.length === 0) return false;
    // M2.99：与 sendInteractive 同一条纪律 —— 私聊先换算成发信地址
    if (scene === 'private') targetId = this.#privateAddress(targetId);

    const { fileInfo } = await this.#uploadMedia(scene, targetId, image);

    /*
     * 5 发送富媒体消息（带角色名 + 常用按钮）
     *
     * M2.45：`content` 原来是空串 —— 于是「图」那条只有一个光秃秃的图，
     * 与紧跟其后的状态卡互不相干。填上 alt（调用方传的是「<角色名> 的角色卡」）之后，
     * 图和文字两条读起来是同一件事；按钮本来就在这条上，不用改。
     */
    const keyboard = cardKeyboard();
    const sendPath = scene === 'private'
      ? `/v2/users/${encodeURIComponent(targetId)}/messages`
      : `/v2/groups/${encodeURIComponent(targetId)}/messages`;
    const reply = (await this.#post(sendPath, {
      msg_type: 7,
      media: { file_info: fileInfo },
      content: image.alt ?? '',
      // 卡面底部挂常用按钮：点击等同手打这几条指令（指令按钮 type=2）
      keyboard,
    })) as Record<string, unknown>;
    /*
     * 把回执里的 id 与按钮数量记下来：按钮不显示时，
     * 「平台收了但没渲染」和「我们压根没带」必须能分开 —— 没有这条日志就只能猜。
     */
    this.#logger.info('角色卡已发出', {
      msgId: String(reply.id ?? '').slice(0, 24),
      buttons: (((keyboard.content as { rows: Array<{ buttons: unknown[] }> }).rows)[0]?.buttons ?? []).length,
      imageBytes: image.bytes.length,
    });
    this.stats.repliesSent += 1;
    this.stats.imagesSent += 1;
    return true;
  }

  /**
   * M2.44：原生按钮（`keyboard.content.rows`）+ Markdown 正文。
   *
   * 三条官方事实决定了这条路的形状（逐条见 `docs/M2.44-QQ能力扩展.md`）：
   *   1. 传了 `markdown` 之后 `content` **必须为空** ⇒ 这条路不能同时带纯文本；
   *   2. 按钮走 `action.type: 1`（回调按钮），点击后平台推 `INTERACTION_CREATE`；
   *   3. 那类事件**必须** `PUT /interactions/{id}` 回应，否则客户端一直 loading ——
   *      回应在 `handleDispatch` 里做（那里才拿得到 `interaction_id`）。
   *
   * `buttons` 没开时返回 false：路由会把 `InteractiveMessage` 降级成文本菜单，
   * 那条路走数字回复，语义等价 —— 降级是正常路径，不是错误（与 OneBot 同一条纪律）。
   */
  async sendInteractive(
    scene: Scene,
    targetId: string,
    message: InteractiveMessage,
    header?: MessageHeader,
  ): Promise<boolean> {
    if (!this.#config.buttons) return false;
    // M2.99：私聊的 targetId 可能是身份键 —— 上传、票据、URL 三处都按地址来
    if (scene === 'private') targetId = this.#privateAddress(targetId);
    /*
     * M2.86：**顶部玩家信息条**（用户拍板「长久化图片绘制，置顶部，做常驻显示，
     * 只有角色卡不显示，图片自绘增加缓存，不要每次都重画，没变化则不花」）。
     *
     * 三层判断，每一层都是「能省则省」：
     *   ① `noHeader` → 根本不生成（角色卡走这条）
     *   ② 没有 `locationName` → 退回 M2.45 那套文字头（缺地点时图不完整，不如不画）
     *   ③ URL 缓存命中 → **连出图与上传都省掉**（一次网络往返）
     *
     * ⚠️ `raw_url` 是 24 小时有效的 COS 链接，所以缓存带时效（见 card/header.ts）。
     * 任一环节失败都只是退回文字头 —— 信息条是增强，不是正文。
     */
    let headerImageUrl: string | undefined;
    const headerForImage = message.noHeader === true ? undefined : header;
    if (headerForImage !== undefined && headerForImage.locationName !== undefined) {
      try {
        /*
         * ⚠️ `genderTag` 现在是**汉字**「男/女」（`GENDER_TAGS` 在 status.ts 里），
         * 而信息条要画的是**符号** ♂/♀/⚧（用户：「性别符号抽象显示」）。
         * 第一版只认符号，于是所有人都会被画成 ♂ —— 而这种错**不会报错**，只是悄悄画错。
         * 所以两种写法都认。
         */
        /*
         * ⚠️ **头像必须内嵌成 data URI**，不能让渲染器自己去拉网络图。
         *
         * 第一版这里漏了传头像，于是左边那个圆里画的是**名字首字纹章** ——
         * 版式全对、只是没有脸（用户截图指出的就是这个）。
         *
         * `resolveAvatarPath` 会把头像**下载并缓存**到本地（7 天）、顺带做魔数校验
         * （拿到 HTML 错误页也不落盘），所以这里只负责读成 data URI。
         */
        let avatarDataUri: string | undefined;
        /*
         * ⚠️ 头像 URL 只能从**通道自己**取，不能从 who 取 —— who 是 markdown 回调的参数，
         * 在回调外面不存在（第一版就是在这里用了 who.avatarUrl，tsc 直接报未定义）。
         *
         * 而且**只有私聊才拿得到**：私聊的 targetId 就是对方的 openid；
         * 群里 targetId 是**群的 openid**，不是发言人的 —— 那种情况只能画纹章（诚实降级，不猜）。
         */
        /*
         * ⚠️ 第一版写的是 `scene === 'private' ? avatarUrlForUser(targetId) : undefined` ——
         * 于是**群里永远画不出头像**（群里 targetId 是群 openid，不是发言人的）。
         * 用户实机截图里左边一直是纹章，就是这个原因。
         *
         * 现在优先用业务侧给的发言人 id，拿不到才退回 targetId（私聊时两者相同）。
         */
        const avatarKey = headerForImage.avatarUserId ?? targetId;
        const avatarUrl = this.avatarUrlForUser(avatarKey);
        if (avatarUrl !== undefined && avatarUrl.length > 0) {
          try {
            // key 用发言人 id：同一个人在群聊与私聊里应当命中同一张缓存
            const file = await resolveAvatarPath({ key: avatarKey, url: avatarUrl });
            if (file !== undefined) {
              const bytes = readFileSync(file);
              const mime = /jpe?g$/i.test(file) ? 'image/jpeg' : /webp$/i.test(file) ? 'image/webp' : /gif$/i.test(file) ? 'image/gif' : 'image/png';
              avatarDataUri = 'data:' + mime + ';base64,' + bytes.toString('base64');
            }
          } catch {
            // 头像拿不到是常态：没有就画纹章（template 里那条降级路径）
          }
        }
        const tag = headerForImage.genderTag ?? '';
        const gender = tag === '女' || tag === '♀' ? 'female' : tag === '⚧' ? 'other' : 'male';
        const input: HeaderInput = {
          nickname: headerForImage.nickname,
          gender,
          locationName: headerForImage.locationName,
          ...(headerForImage.pathwayLine !== undefined ? { pathwayLabel: headerForImage.pathwayLine } : {}),
          ...(avatarDataUri !== undefined ? { avatarDataUri } : {}),
        };
        const key = headerCacheKey(input);
        const cached = readHeaderUrl(key);
        if (cached !== undefined) {
          headerImageUrl = cached;
        } else {
          const image = await renderHeader(input);
          if (image !== undefined) {
            const uploaded = await this.#uploadMedia(scene, targetId, { bytes: image.png, mediaType: 'image/png', alt: '信息' });
            if (uploaded.rawUrl.length > 0) {
              headerImageUrl = uploaded.rawUrl;
              writeHeaderUrl(key, uploaded.rawUrl);
            }
          }
        }
      } catch {
        // 出图 / 上传失败 → headerImageUrl 保持 undefined → 退回文字头
      }
    }
    const body = await this.#buildReplyBody(scene, targetId, {
      markdown: (who) =>
        officialMarkdownOf(
          message,
          /*
           * M2.86：`noHeader` 时传**空的 who** —— 头像与昵称那一行就不会出现。
           *
           * 这是唯一能去掉信息头的地方：`avatarUrl` 是这里从被动回复凭证
           * （`ticket.userId`）现取的，调用方没有这个入参。
           * `.角色` 的「图 + 常用按钮」就走这条路（用户口径：不要信息头）。
           */
          message.noHeader === true
            ? {}
            : {
                ...who,
                ...(header !== undefined ? { header } : {}),
                // M2.86：有信息条图片就用它当消息头（toQQMarkdown 里整块跳过文字头）
                ...(headerImageUrl !== undefined ? { headerImageUrl } : {}),
              },
        ),
      keyboard: buildKeyboardPayload(message),
    });
    const path = scene === 'private'
      ? `/v2/users/${encodeURIComponent(targetId)}/messages`
      : `/v2/groups/${encodeURIComponent(targetId)}/messages`;
    /*
     * 真机校准用：把**实际发出去的按钮文字**记下来。
     * M2.44 就是靠它发现「10 个字符的中文标签在群里显示不全」的 ——
     * 只看代码里的 `slice(0, 10)` 完全看不出问题。
     */
    if (this.#config.debug) {
      this.#logger.info('发出带按钮的消息', {
        scene,
        targetId,
        labels: message.options.map((option) => option.label),
        sentLabels: body.keyboard
          ? (body.keyboard as KeyboardPayload).content.rows.flatMap((row) =>
              row.buttons.map((button) => button.render_data.label),
            )
          : [],
        markdownHead: body.markdown ? String((body.markdown as { content: string }).content).slice(0, 60) : null,
        /*
         * M2.85：**必须能看到完整的 markdown 正文**。
         *
         * 原来的 `markdownHead` 只记前 60 个字符 —— 而那 60 个字符正好是消息头那一行头像
         * （`![头像 #60px #60px](…)`）。于是排查「回复里只有一张图、正文不见了」这类问题时，
         * 日志里**完全看不出正文在不在**，只能靠猜。
         * 这一次的现场就是：现象明确、日志却只给了个头像，白绕了好几轮。
         */
        markdownBody: body.markdown ? String((body.markdown as { content: string }).content).slice(0, 800) : null,
      });
    }
    await this.#post(path, body);
    this.stats.repliesSent += 1;
    this.stats.buttonsSent += 1;
    return true;
  }

  /**
   * 消费一张被动回复凭证（`msg_id` + 自增 `msg_seq`）。
   *
   * 两条官方约束都在这里落地：`msg_id` **5 分钟内有效**、同一个 msg_id **最多回 5 次**。
   * M2.44 把它从 `#buildReply` 里提出来，是因为现在有两条回复体（纯文本 / Markdown+按钮）
   * 要共用同一个闸门 —— 复制一份的话，两条路迟早会漂（K16 的形状）。
   */
  #consumeTicket(
    scene: Scene,
    targetId: string,
  ): { msgId: string; eventId?: string; seq: number; nickname?: string; userId?: string } | null {
    const ticket = this.#tickets.get(targetId);
    const rules = REPLY_RULES[scene];
    // 配置项只作覆盖，默认按场景取官方规则（单聊 60 分钟 / 群聊 5 分钟）
    const windowMs = this.#config.replyWindowMs ?? rules.windowMs;
    const age = ticket ? Date.now() - ticket.at : null;
    /*
     * ⚠️ M2.115：**没有凭证 ⇒ 发「主动消息」，不抛错。**
     *
     * 这一条是用户纠正的：「主动推送已经下放了，不需要额外申请权限，你再好好查查官方文档」。
     * 查了 —— 官方《消息收发概述》原文：
     *
     *   主动消息 | **无任何条件** | 机器人主动触达用户，
     *           用户可在客户端关闭「允许主动发送」开关，关闭后主动消息将发送失败
     *
     * 也就是说：**不需要申请**，不带 `msg_id` 直接发就行（有频控：群 60/qpm、每群每天 1000 条）。
     *
     * 而这里原来**一律抛 `NoReplyTicketError`** —— 于是「不等玩家说话直接发」那条路
     * 在本项目里**从来没通过**：世界播报、天气推送、任何主动消息全部卡死在这一行，
     * 而日志里写的是「要单独申请权限、本项目没申请」—— 一句**过时且错误**的话。
     *
     * ⚠️ 而「只有一个群收到」的现象，官方文档里也有答案：
     *   **用户可在客户端关闭「允许主动发送」开关，关闭后主动消息将发送失败。**
     * 那是接收方设置，不是权限、不是 DNS。
     */
    if (!ticket || age === null || age > windowMs) {
      this.stats.repliesRefused += 1;
      return null;
    }
    if (ticket.seq >= rules.maxReplies) {
      this.stats.repliesRefused += 1;
      throw new ReplyQuotaError(scene, targetId, ticket.msgId, rules.maxReplies);
    }
    ticket.seq += 1;
    const base = {
      msgId: ticket.msgId,
      seq: ticket.seq,
      ...(ticket.nickname ? { nickname: ticket.nickname } : {}),
      ...(ticket.userId ? { userId: ticket.userId } : {}),
    };
    return ticket.eventId ? { ...base, eventId: ticket.eventId } : base;
  }

  /**
   * 拼「带凭证」的回复体。**`markdown` 与 `content` 互斥** ——
   * 官方原文：「传了 markdown 后此字段必须为空」。
   *
   * `msg_type`：`0`=纯文本、`2`=Markdown。文档要求显式声明，早先靠默认值。
   */
  #buildReplyBody(
    scene: Scene,
    targetId: string,
    /*
     * `markdown` 收一个**函数**而不是字符串：昵称存在凭证里，
     * 而凭证刚刚才被 `#consumeTicket` 取出来 —— 让函数去拿，
     * 免得把昵称在调用链上再穿一遍（三个调用点都要改）。
     */
    content:
      | { text: string }
      | {
          markdown: (who: { header?: MessageHeader; avatarUrl?: string; headerImageUrl?: string }) => string;
          keyboard?: KeyboardPayload;
        },
  ): Record<string, unknown> {
    /*
     * ⚠️ M2.115：`ticket === null` = **主动消息**（不带 `msg_id` / `event_id`）。
     * 它同时意味着**没有头像与昵称可挂** —— 主动消息的正文本来就不该有信息头。
     */
    const ticket = this.#consumeTicket(scene, targetId);
    /*
     * 互动事件用 `event_id`，普通消息用 `msg_id` —— 官方写的是「**二选一**」。
     *
     * ⚠️ M2.44 真机：`event_id` 那一支**不能带 `msg_seq`**。
     * 官方对 `msg_seq` 的原文是「回复消息的序号，**与 `msg_id` 联合使用**」，
     * 它是 `msg_id` 那一套的字段；两个一起发，平台回的是
     * `err_code=40034025 HTTP 400`（错误码表里查不到这一条，是实测出来的）。
     * 现象是：按钮点下去「操作成功」，但机器人**一条回复都发不出来**。
     */
    const ticketFields =
      ticket === null
        ? {} // 主动消息：不带任何凭证字段
        : ticket.eventId
          ? { event_id: ticket.eventId }
          : { msg_id: ticket.msgId, msg_seq: ticket.seq };
    if ('markdown' in content) {
      return {
        ...ticketFields,
        ...(ticket !== null ? { msg_seq: ticket.seq } : {}),
        msg_type: 2,
        markdown: {
          content: this.#clampContent(
            content.markdown({
              ...(ticket?.userId ? { avatarUrl: avatarUrlOf(this.#config.appId, ticket.userId) } : {}),
            }),
          ),
        },
        ...(content.keyboard ? { keyboard: content.keyboard } : {}),
      };
    }
    return {
      ...ticketFields,
      content: this.#clampContent(content.text),
      msg_type: 0,
    };
  }

  /**
   * 纯文本回复体的入口。
   *
   * M2.44：`QQ_BOT_MARKDOWN=1` 时整条改走 `msg_type: 2`。**只做换行处理**
   * （见 `toQQMarkdown`），不做美化 —— 猜语法的代价是整条被平台拒掉。
   */
  #buildReply(
    scene: Scene,
    targetId: string,
    text: string,
    /*
     * M2.86：`null` = **明确不要信息头**。
     *
     * 信息头（头像 + 昵称 + 途径地点那一块）本来是给「某玩家发了一条指令」的回执用的。
     * 而主动推送是世界在说话 —— 顶上挂一个玩家头像，会让人以为那是他自己的消息。
     *
     * 注意这个头**不是业务侧加的**：`#buildReplyBody` 会从被动回复凭证里取
     * `ticket.userId` 生成头像直链，业务侧根本没有这个入参。所以只能在这里拦。
     */
    header?: MessageHeader | null,
    /**
     * M2.47：正文之外再挂一张图（**只能走 markdown**）。
     * 图片是正文里的一行 —— `content` 与 `markdown` 互斥，没有第二条路。
     */
    image?: { url: string; alt: string },
    /** M2.86：主动推送要带的原始按钮（回调按钮，data 是完整指令） */
    buttons?: ButtonSpec[],
  ): Record<string, unknown> {
    /*
     * `header === null` = **主动推送**，走一条不带凭证的路径（M2.86）。
     *
     * 为什么必须分开：`#buildReplyBody` 开头就 `#consumeTicket(scene, targetId)` ——
     * 它取的是**被动回复凭证**（`msg_id` + `msg_seq`，5 分钟窗口、每条最多 5 次）。
     * 而主动推送**根本没有凭证**（它就是「不等玩家说话直接发」），
     * 强行走那条路只会拿到空 ticket 或抛错。
     *
     * 官方现行文档里 `msg_id` 是可选的：不传就是主动消息，
     * 而 `keyboard` 与它平级 —— 所以主动消息照样能带按钮。
     */
    if (header === null) {
      return this.#buildProactiveBody(scene, targetId, text, buttons);
    }
    if (!this.#config.markdown) {
      // markdown 关着时图片无处可挂：硬塞进纯文本就是给玩家看一串 ![](...)
      return this.#buildReplyBody(scene, targetId, { text });
    }
    return this.#buildReplyBody(scene, targetId, {
      // `who` 是通道侧补的（昵称 / 头像直链），`header` 是业务侧给的（性别 / 途径序列）
      markdown: (who) => {
        // header === null → 丢掉 who（含 avatarUrl），信息头整块不出现
        const base = header === null ? {} : { ...who, ...(header ? { header } : {}) };
        const body = toQQMarkdown(text, { ...base, mdStyle: this.#config.mdStyle });
        /*
         * 尺寸按**逻辑尺寸**标注：卡面现在以 2x 出图（1240x2000），
         * 但按 620x1000 标注显示 —— 客户端拿到的是高分辨率源、
         * 按一半尺寸排版，字与细线才不会糊（用户反馈「糊的很」）。
         */
        return image === undefined ? body : `${body}\n\n![image #620px #1000px](${image.url})`;
      },
    });
  }

  /**
   * **主动推送的消息体**（M2.86）—— 不带任何被动回复凭证。
   *
   * 与 `#buildReplyBody` 的差别只有一个：**没有 `msg_id` / `event_id` / `msg_seq`**。
   * 加上那三个字段就是「回复某条消息」，不加就是「主动发一条」。
   *
   * 按钮用 `callbackButton`（`action.type = 1`）：平台推 `INTERACTION_CREATE`，
   * `data` 原样回传，那边的 `mapOfficialInteraction` 把它塞进 `rawText` 走普通路由 ——
   * **不依赖任何待答菜单**，所以多条推送各带各的按钮不会互相覆盖。
   *
   * ⚠️ 频控（官方现行文档，主动消息）：
   *   · Bot 维度：认证 60/qpm、未认证 30/qpm；
   *   · 单关系维度：20/qpm，每群每天最多接收 1000 条。
   * 调用方（世界播报）的令牌桶按 20/qpm 设，正好卡在单群上限。
   */
  #buildProactiveBody(
    scene: Scene,
    targetId: string,
    text: string,
    buttons?: ButtonSpec[],
  ): Record<string, unknown> {
    /*
     * ⚠️ M2.125（用户口径：「**按 koishi 的做**」）：**有凭证就借，没有才走主动消息。**
     *
     * 原先这里一律不带凭证 —— 而 koishi 的 adapter-qq 不是这么干的：它有一个 session
     * 就带上 `msg_id`（那就是被动回复），没有才不带。差别是**实打实的**：
     *
     *   官方原文：用户可在客户端关闭「允许主动发送」开关，关闭后主动消息将发送失败。
     *
     * 于是「一律走主动消息」的后果是：**那个群只要有人关过这个开关，播报就永远发不进去**，
     * 而别的群照常 —— 正是用户报的「两个群只有一个能发送成功」。
     * 借凭证则不受这个开关管（它是回复某条消息，不是主动触达）。
     *
     * 代价记账：借用会消耗那张凭证的额度（群聊 5 条）。所以顺序是**先用凭证**，
     * 用光了或过期了自然落到主动消息 —— 与 koishi 的行为一致。
     */
    const ticket = this.#consumeTicket(scene, targetId);
    const ticketFields =
      ticket === null
        ? {}
        : ticket.eventId
          ? { event_id: ticket.eventId }
          : { msg_id: ticket.msgId, msg_seq: ticket.seq };
    const keyboard =
      buttons !== undefined && buttons.length > 0
        ? {
            content: {
              /*
 * ⚠️ M2.112：**分行**（原来把所有按钮塞进一行）。
 *
 * 用户的截图：「所有按钮显示不完整」——世界播报的三个按钮被截成
 * 「去大桥区…」「打听消息…」「无视，该…」。一行三个 ⇒ 每个只放得下四个汉字；
 * 一行两个就翻倍（按钮的宽度上限跟着行内个数走，见 official.ts 的 labelWidthFor）。
 */
rows: Array.from({ length: Math.ceil(buttons.length / 2) }, (_, i) => buttons.slice(i * 2, i * 2 + 2)).map(
              (row) => ({ buttons: row.map((b) => callbackButton(b.label, b.command)) }),
            ),
            },
          }
        : undefined;
    if (this.#config.markdown) {
      return {
        ...ticketFields,
        msg_type: 2,
        markdown: { content: this.#clampContent(toQQMarkdown(text, { mdStyle: this.#config.mdStyle })) },
        ...(keyboard ? { keyboard } : {}),
      };
    }
    return {
      ...ticketFields,
      msg_type: 0,
      content: this.#clampContent(toQQMarkdown(text, { mdStyle: this.#config.mdStyle })),
      ...(keyboard ? { keyboard } : {}),
    };
  }

  /**
   * 正文长度保护。
   *
   * 官方对 content 有长度限制（具体阈值随平台调整，这里默认 1000 字符保守值）。
   * **不静默截断**：截了就打 warn 把原始长度记下来，
   * 否则「玩家看到的菜单少了一截」会变成一个查不出来的现象。
   */
  #clampContent(text: string): string {
    const max = this.#config.maxContentChars ?? 1000;
    const trimmed = text ?? '';
    /*
     * ⚠️ M2.116：**长度按「客户端看得见的字」算**（用户报的 BUG）。
     *
     * 正文里的 `<qqbot-cmd-input … />` 标签源码有 90 多个字符，
     * 而客户端只显示 `show` 那几个字 —— 按 `text.length` 算等于
     * **每多一个可点物品，正文就凭空多算 90 个字符**，十来件就把上限撑爆、整条被截断。
     * 判定与截断都交给 `text-tags.ts`（那里还保证不把标签切一半）。
     */
    const effective = displayLengthOf(trimmed);
    if (effective <= max) return trimmed;
    this.#logger.warn('回复正文超长已截断', {
      originalLength: trimmed.length,
      effectiveLength: effective,
      max,
    });
    return truncateKeepingTags(trimmed, max - 20) + '\n…（内容过长已截断）';
  }

  /**
   * 发一条消息（M2.75：带上 401 自愈）。
   *
   * 401 的唯一合理解释是「手里这个 token 平台不认了」—— 可能是提前失效、
   * 也可能是平台侧轮换了。这时候**作废重换一次再发**的成功率很高，
   * 而不做这一步的代价是玩家看到一条没头没尾的失败。
   *
   * 为什么重试不会造成重发：401 是**鉴权层拒绝**，请求根本没进业务，
   * 不存在「其实发出去了却又被拒」的窗口。所以重试是安全的。
   * 次数由 NUMERIC.qqBot.authRetryOn401 管（默认 1 次），不无限重试 ——
   * 真错的是凭证时，重试多少次都一样，只会把日志刷满。
   */
  async #post(path: string, body: unknown): Promise<unknown> {
    return this.#postOnce(path, body, NUMERIC.qqBot.authRetryOn401);
  }

  async #postOnce(path: string, body: unknown, retriesLeft: number): Promise<unknown> {
    const token = await this.#tokens.get();
    const base = (this.#config.apiBase ?? API_BASE_PROD).replace(/\/+$/, '');
    /*
     * ⚠️ 必须用 this.#fetch（可注入的那个），不是全局 fetch。
     * 早先这里是全局 fetch，于是「注入了假 fetch」的测试在发消息这一步**真的打到了平台** ——
     * 用例拿到的是平台的真实鉴权错误（trace_id 都是真的），而排查方向会被带向
     * 「token 怎么无效了」而不是「这一层没脱网」。
     */
    const response = await this.#fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        // 文档的 curl 示例写的是 application/json; charset=utf-8
        'content-type': 'application/json; charset=utf-8',
        authorization: `QQBot ${token}`,
        // 官方要求带上，用于多应用路由
        'x-union-appid': this.#config.appId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#config.timeoutMs ?? 10_000),
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }

    /*
     * 鉴权失败自愈：**HTTP 401 与平台业务码都算**。
     *
     * 真机样本（2026-09-29，用一个无效 token 发群消息）：
     *   POST /v2/groups/{openid}/messages → HTTP 401
     *   {"message":"AccessToken无效或过期","code":11244,"err_code":40011027,"trace_id":"..."}
     * 注意它**同时**给了 HTTP 401 与 err_code —— 但文档反复强调「失败判定以 err_code 为准、
     * HTTP 可能仍是 200」，所以两个信号都要认：只认 401 的话，
     * 万一平台某天改成 200 + err_code，这条自愈就会静默失效。
     */
    const earlyErrCode = typeof parsed?.err_code === 'number' ? parsed.err_code : null;
    if (retriesLeft > 0 && (response.status === 401 || earlyErrCode === AUTH_ERR_CODE)) {
      this.#tokens.invalidate();
      this.#logger.warn('发消息被鉴权拒绝：作废 token 后重试一次', {
        path, retriesLeft, httpStatus: response.status, errCode: earlyErrCode, hadToken: token.length > 0,
      });
      return this.#postOnce(path, body, retriesLeft - 1);
    }

    /*
     * 失败判定**以 err_code 为准**，不是 HTTP 状态码，更不是 message。
     *
     * 官方文档（API 调用指南 → 响应结构）原话：
     *   「API 调用成功时，响应体直接返回业务数据；调用失败时，响应体包含
     *     err_code、message 等错误信息……**请不要依据 message 来判定一个请求
     *     是否失败**，message 可能会随时调整，建议根据 err_code 判断请求是否失败。」
     *
     * 两个信号都要看，因为它们各自会漏：
     *   - 只看 HTTP：漏掉「200 + err_code=40034005（回复消息 msg_id 已过期）」这类；
     *   - 只看 err_code：漏掉网关层直接挡回来的（401/429/500，body 里没有 err_code）。
     * 早先的版本只看 `!response.ok`，属于文档点名的写法。
     */
    const errCode = typeof parsed?.err_code === 'number' ? parsed.err_code : null;
    const traceId =
      (typeof parsed?.trace_id === 'string' ? parsed.trace_id : null) ??
      response.headers.get('X-Tps-trace-ID') ??
      null;

    if (errCode !== null && errCode !== 0) {
      this.stats.lastError = `err_code=${errCode} ${String(parsed?.message ?? '')}`;
      throw new QQApiError(path, response.status, raw, errCode, traceId);
    }
    if (!response.ok) {
      this.stats.lastError = `HTTP ${response.status} ${raw.slice(0, 200)}`;
      throw new QQApiError(path, response.status, raw, null, traceId);
    }

    this.#logger.info('消息已发出', {
      path,
      msgSeq: (body as { msg_seq?: number }).msg_seq ?? null,
      // 平台侧排查要 trace_id，顺手落日志
      ...(traceId ? { traceId } : {}),
    });
    return parsed;
  }
}

/** LoginReport → 后台面板要的一屏快照（丢掉 raw 之类的重字段） */
function snapshotOf(report: LoginReport): LoginSnapshot {
  return {
    at: report.at,
    durationMs: report.durationMs,
    ok: report.ok,
    verdict: report.verdict,
    advice: report.advice,
    steps: report.steps.map((s) => ({ id: s.id, label: s.label, status: s.status, detail: s.detail })),
    identity: report.identity,
    sessionLimit: report.gatewayBot?.sessionLimit ?? null,
    shards: report.gatewayBot?.shards ?? null,
    tokenMasked: report.tokenMasked,
  };
}

/* ------------------------------------------------------------------ *
 * 工厂：从环境变量装配
 * ------------------------------------------------------------------ */

export function createQQOfficialAdapter(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<QQOfficialConfig> = {},
): QQOfficialAdapter {
  const tokenConfig: TokenConfig = loadTokenConfig(env);
  const sandbox = env.QQ_BOT_SANDBOX?.trim() === '1';
  const rawAllowed = (env.QQ_BOT_ALLOWED_COMMANDS ?? '创建').trim();
  const allowedCommands = rawAllowed === '' || rawAllowed === '*'
    ? (rawAllowed === '*' ? ['*'] : [])
    : rawAllowed.split(',').map((s) => s.trim()).filter(Boolean);

  return new QQOfficialAdapter({
    appId: tokenConfig.appId,
    clientSecret: tokenConfig.clientSecret,
    apiBase: sandbox ? API_BASE_SANDBOX : API_BASE_PROD,
    // QQ_BOT_DEBUG=1 打开：打印每条事件的完整 payload 与网关原始帧（任务 4 的验收靠它）
    debug: env.QQ_BOT_DEBUG?.trim() === '1',
    // M2.44：两个能力开关，默认都关 —— 打开之前先确认真机接受（真机拒绝的症状是「机器人不回话」）
    markdown: env.QQ_BOT_MARKDOWN?.trim() === '1',
    /*
     * M2.86：**正文样式档**。
     *
     * 官方 markdown 文档列了 `**加粗**`，但用户实机确认手机端**不渲染**（星号原样显示）。
     * 默认 `plain`（全去掉，最不容易看错）；`QQ_BOT_MD_STYLE=bold-italic` 可换成
     * 官方清单里的 `***加粗斜体***` —— 那一档手机上如果认，就能拿回强调。
     */
    mdStyle: ((): 'plain' | 'bold-italic' | 'keep' => {
      const v = env.QQ_BOT_MD_STYLE?.trim();
      return v === 'bold-italic' || v === 'keep' ? v : 'plain';
    })(),
    // M2.86：富文本标签（颜色）—— 先用 .探针 html 验证再开
    richText: env.QQ_BOT_RICH_TEXT?.trim() === '1',
    buttons: env.QQ_BOT_BUTTONS?.trim() === '1',
    allowedCommands,
    ...overrides,
  });
}
