/**
 * 适配器面板的服务端（M2.51）。
 *
 * ## 这个面板为什么必须改
 *
 * 它原来显示的是 **.env 文件里的值**。而「.env 里写的」和「进程此刻在用的」
 * 是两件事，差别还是**静默**的：
 *
 *   · 改完 .env 没重启 —— 面板显示新值，机器人跑的还是旧值；
 *   · `QQ_BOT_ALLOWED_COMMANDS` 缺省时适配器的默认是**只放行「创建」**，
 *     面板却按 `?? '*'` 兜底显示成 `*` —— 它说的和做的不一样。
 *
 * 所以这里一律分开列：磁盘上写了什么、进程里在用什么、一不一样。
 *
 * ## 哪些能热改
 *
 * 判据是「这个值什么时候被读」，见适配器的 reconfigure()：
 * 每条消息都读的（白名单 / markdown / debug）改完立刻生效；
 * 只在建连时用一次的（AppID / Secret / 沙箱 / intents）必须重连网关 —— 但**不必重启进程**。
 */
import { maskSecret } from './env.ts';
/*
 * M2.104：基址常量改从 config 层引入（值没变）。
 * 原来的写法会让**每一个用到后台表单的进程**把整条官方网关链路（WS/心跳/重连）
 * 一起加载进来 —— 对「无适配器 / 纯 API 版」是致命的（见 src/config/qq-api.ts）。
 */
import { API_BASE_PROD, API_BASE_SANDBOX } from '../config/qq-api.ts';
// M2.86：指令说明的唯一出处（玩家 .菜单 图用的也是这一份）
import { COMMAND_GROUPS } from '../domain/menu/command-groups.ts';
import type {
  AdapterReconfigureResult,
  AdapterRuntimeStatus,
  QQOfficialConfig,
} from '../adapter/qq-official/index.ts';
import type { OneBotReconfigureResult, OneBotRuntimeStatus } from '../adapter/onebot.ts';

/**
 * OneBot 通道的一屏状态（M2.78）。
 *
 * 与 /health 的 `onebot` 段**同一份形状**（panels.ts 里那个类型就是这个的别名）——
 * 两处各定义一遍迟早会漂移，而「健康检查说 A、面板说 B」是最难解释的一类不一致。
 */
export interface OneBotStatus {
  /** websocket = 内置正向 WS；http = 反向 HTTP 上报（协议端往本机 POST） */
  transport: 'websocket' | 'http';
  /** WS 模式是协议端地址；HTTP 模式是本机上报地址 */
  url: string | null;
  connected: boolean | null;
  /** 协议端的机器人账号（get_login_info）—— 连上了但连错号，只有这里看得出来 */
  selfId: string | null;
  nickname: string | null;
  heartbeats: number;
  events: number;
  apiCalls: number;
  apiErrors: number;
  reconnects: number;
  lastError: string | null;
  lastClose: { code: number; reason: string; at: number } | null;
  /** 适配器一共处理过多少条消息事件（HTTP 模式也有的那个计数） */
  handled: number;
}

/**
 * 后台能对 **OneBot 通道**做的事（M2.78）。
 *
 * 与 AdapterControl 分开是有意的：那一个是 QQ 官方专属（改 AppID、换 token、重连网关），
 * 而 OneBot 这边能做的只有「看连接」与「重连 / 体检」。
 * 硬套成一个接口会让两边都长出一堆用不上的字段 ——
 * 而「摆一堆点了没反应的按钮比不摆更糟」这条，M2.51 已经写在 AdapterControl 的注释里了。
 */
export interface OneBotControl {
  status(): OneBotStatus;
  /** 进程此刻在用的配置（不是 .env 里写的） */
  config(): OneBotConfigView;
  /** 运行期改配置：立刻生效的立刻生效，要重连的报给界面 */
  reconfigure(patch: OneBotPatch): OneBotReconfigureResult;
  /** 断开重连（只有内置 WS 有长连接可重连） */
  reconnect(): Promise<{ ok: boolean; message: string }>;
  /** 体检：连上了吗、连的是哪个 QQ 号 */
  verify(): Promise<{ ok: boolean; message: string }>;
}

/** OneBot 的可改项（后台表单提交的形状） */
export interface OneBotPatch {
  apiBase?: string;
  accessToken?: string;
  allowedCommands?: string[];
  timeoutMs?: number;
}

/** OneBot 的一屏配置（后台的「磁盘 vs 运行中」对照与表单都读它） */
export interface OneBotConfigView extends OneBotRuntimeStatus {
  /** 内置 WS 还是反向 HTTP 上报 —— 界面上要能区分「地址」指的是哪一头 */
  transport: 'websocket' | 'http';
  url: string | null;
  pendingReconnect: string[];
}

/**
 * OneBot 的「磁盘 vs 运行中」对照。
 *
 * 与 QQ 那套 compareAdapter **共用同一个行形状**（AdapterField），
 * 所以前端一个渲染函数就能画两边 —— 两套形状会长出两套渲染，迟早只剩一边在维护。
 */
export function compareOneBot(
  disk: Record<string, string | undefined>,
  rt: OneBotConfigView,
): AdapterField[] {
  const rows: Array<{
    key: string; label: string; disk: string; running: string;
    needsReconnect: boolean; presenceOnly?: boolean; diskPresent?: boolean;
  }> = [
    {
      key: 'ONEBOT_WS_URL', label: '协议端地址（正向 WS）',
      disk: disk.ONEBOT_WS_URL || '（未设 → 走反向 HTTP 上报）',
      running: rt.transport === 'websocket' ? (rt.url ?? '（未设）') : '（当前是 HTTP 上报模式）',
      needsReconnect: true,
    },
    {
      key: 'ONEBOT_WS_TOKEN', label: '协议端 access_token',
      disk: disk.ONEBOT_WS_TOKEN ? '（已配置）' : '（未设）',
      running: rt.hasToken ? '（已配置）' : '（未配置）',
      presenceOnly: true, diskPresent: Boolean(disk.ONEBOT_WS_TOKEN), needsReconnect: true,
    },
    {
      key: 'ONEBOT_API_BASE', label: '协议端 HTTP API 基址',
      disk: disk.ONEBOT_API_BASE ?? '（未设 → 默认 http://127.0.0.1:3000）',
      running: rt.apiBase,
      needsReconnect: true,
    },
    {
      key: 'ONEBOT_ALLOWED_COMMANDS', label: '指令白名单',
      disk: disk.ONEBOT_ALLOWED_COMMANDS === undefined
        ? '（未设 → 全放行）'
        : (disk.ONEBOT_ALLOWED_COMMANDS === '' || disk.ONEBOT_ALLOWED_COMMANDS === '*'
          ? '* （全放行）' : disk.ONEBOT_ALLOWED_COMMANDS),
      running: allowedText(rt.allowedCommands),
      needsReconnect: false,
    },
  ];
  /*
   * ⚠️ 比较要按**语义**，不是按字面。
   *
   * 截图验证时抓到的：.env 里什么都没写、进程走反向 HTTP 上报，
   * 卡片上却标了「不一样」—— 因为左边写着「（未设 → 走反向 HTTP 上报）」、
   * 右边写着「（当前是 HTTP 上报模式）」。字面不同、意思完全一样。
   * 白名单那行同理（「（未设 → 全放行）」vs「（全放行）」）。
   * **假的「不一样」和真的「不一样」一样有害**：它让人去查一个不存在的不一致。
   */
  const semanticSame = (r: (typeof rows)[number]): boolean => {
    if (r.presenceOnly) return r.diskPresent === rt.hasToken;
    if (r.key === 'ONEBOT_WS_URL') {
      const diskWs = (disk.ONEBOT_WS_URL ?? '').trim();
      // 磁盘上没写 = 走 HTTP 上报；进程此刻正是 HTTP 上报 → 一致
      if (diskWs === '') return rt.transport === 'http';
      return diskWs === (rt.url ?? '');
    }
    if (r.key === 'ONEBOT_API_BASE') {
      const diskBase = (disk.ONEBOT_API_BASE ?? '').trim();
      return diskBase === '' ? rt.apiBase === 'http://127.0.0.1:3000' : diskBase === rt.apiBase;
    }
    if (r.key === 'ONEBOT_ALLOWED_COMMANDS') {
      const norm = (s: string): string => (s.trim() === '' || s.trim() === '*' ? '*' : s.trim());
      const diskList = norm(disk.ONEBOT_ALLOWED_COMMANDS ?? '');
      const runList = rt.allowedCommands.length === 0 || rt.allowedCommands.includes('*')
        ? '*' : rt.allowedCommands.join(',');
      return diskList === runList;
    }
    return r.disk === r.running;
  };

  return rows.map((r) => ({
    key: r.key, label: r.label, disk: r.disk, running: r.running,
    needsReconnect: r.needsReconnect,
    same: semanticSame(r),
  }));
}

/**
 * 后台表单 → OneBot 配置补丁。
 *
 * ⚠️ 白名单三种写法（空串 / '*' / 逗号列表）的口径必须与启动时读 .env 的那段**一模一样**，
 * 否则「界面保存的值」和「下次启动读同一个 .env 得到的值」会不一样 ——
 * 那种不一致平时看不出来，重启之后才现形。
 */
export function onebotPatchFromForm(b: Record<string, unknown>): OneBotPatch {
  const patch: OneBotPatch = {};
  if (typeof b.wsUrl === 'string') patch.apiBase = b.wsUrl.trim();
  // 留空 = 不改：页面不回显 token，没有这条规则一保存就把它清了
  if (typeof b.token === 'string' && b.token.length > 0) patch.accessToken = b.token.trim();
  if (typeof b.allowedCommands === 'string') {
    const raw = b.allowedCommands.trim();
    patch.allowedCommands = raw === '' || raw === '*'
      ? (raw === '*' ? ['*'] : [])
      : raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return patch;
}

/** 后台能对适配器做的事。OneBot 适配器没有这些，所以是可选的 */
export interface AdapterControl {
  runtimeStatus(): AdapterRuntimeStatus;
  reconfigure(patch: Partial<QQOfficialConfig>): AdapterReconfigureResult;
  reconnectGateway(): Promise<void>;
  /** 强制换一次 access_token：把「凭证错」和「网关没连上」分开 */
  verify(): Promise<{ ok: boolean; message: string }>;
}

/**
 * 配置项的中文名。
 *
 * 后台的回执里不该出现 `allowedCommands`、`apiBase` 这种原文 ——
 * 「改了什么」这句话是给人看的，人认的是「指令白名单」。
 */
export const CONFIG_LABEL: Record<string, string> = {
  appId: 'AppID',
  clientSecret: 'AppSecret',
  apiBase: '沙箱环境',
  sandbox: '沙箱环境',
  markdown: 'Markdown 消息',
  buttons: '原生按钮',
  debug: '调试日志',
  allowedCommands: '指令白名单',
  maxContentChars: '正文长度上限',
  replyWindowMs: '被动回复窗口',
};

export const labelOf = (key: string): string => CONFIG_LABEL[key] ?? key;

export interface AdapterField {
  /** .env 里的键名 */
  key: string;
  label: string;
  /** 磁盘上的值（已转成人看的形式） */
  disk: string;
  /** 进程此刻在用的值 */
  running: string;
  same: boolean;
  /** 这一项改了要不要重连网关 */
  needsReconnect: boolean;
}

const yn = (b: boolean): string => (b ? '开' : '关');

/** 白名单归一成一行。['*'] 与 [] 都是「全放行」，但来源不同，注释里说清楚 */
function allowedText(list: readonly string[]): string {
  if (list.includes('*')) return '* （全放行）';
  if (list.length === 0) return '（全放行）';
  return list.join(', ');
}

/**
 * 磁盘 vs 运行中。
 *
 * @param disk .env 里的原始值（没设就是 undefined）
 */
export function compareAdapter(
  disk: Record<string, string | undefined>,
  rt: AdapterRuntimeStatus,
): AdapterField[] {
  const rows: Array<Omit<AdapterField, 'same' | 'disk' | 'running'> & {
    disk: string;
    running: string;
    /** 只比「有没有值」，不比内容（密钥不回显） */
    presenceOnly?: boolean;
    diskPresent?: boolean;
  }> = [
    { key: 'QQ_BOT_APPID', label: 'AppID', disk: disk.QQ_BOT_APPID ?? '（未设）', running: rt.appId || '（未设）', needsReconnect: true },
    {
      key: 'QQ_BOT_SECRET', label: 'AppSecret',
      disk: disk.QQ_BOT_SECRET ? maskSecret(disk.QQ_BOT_SECRET) : '（未设）',
      running: rt.hasSecret ? '（已配置）' : '（未配置）',
      // 密钥不回显，所以只能比「有没有」
      presenceOnly: true, diskPresent: Boolean(disk.QQ_BOT_SECRET), needsReconnect: true,
    },
    {
      key: 'QQ_BOT_SANDBOX', label: '沙箱环境',
      disk: disk.QQ_BOT_SANDBOX === '1' ? '是' : '否',
      running: rt.sandbox ? '是' : '否',
      needsReconnect: true,
    },
    {
      key: 'QQ_BOT_BUTTONS', label: '原生按钮',
      disk: disk.QQ_BOT_BUTTONS === '1' ? '开' : '关',
      running: yn(rt.buttons),
      needsReconnect: true,
    },
    {
      key: 'QQ_BOT_MARKDOWN', label: 'Markdown 消息',
      disk: disk.QQ_BOT_MARKDOWN === '1' ? '开' : '关',
      running: yn(rt.markdown),
      needsReconnect: false,
    },
    {
      key: 'QQ_BOT_DEBUG', label: '调试日志',
      disk: disk.QQ_BOT_DEBUG === '1' ? '开' : '关',
      running: yn(rt.debug),
      needsReconnect: false,
    },
    {
      key: 'QQ_BOT_ALLOWED_COMMANDS', label: '指令白名单',
      // 缺省时适配器的真实默认是 ['创建']，不是 '*' —— 这里必须显示真的那个
      disk: disk.QQ_BOT_ALLOWED_COMMANDS === undefined ? '（未设 → 进程默认只放行「创建」）'
        : (disk.QQ_BOT_ALLOWED_COMMANDS === '*' || disk.QQ_BOT_ALLOWED_COMMANDS === '')
          ? '* （全放行）' : disk.QQ_BOT_ALLOWED_COMMANDS,
      running: allowedText(rt.allowedCommands),
      needsReconnect: false,
    },
  ];

  return rows.map((r) => ({
    key: r.key, label: r.label, disk: r.disk, running: r.running,
    needsReconnect: r.needsReconnect,
    same: r.presenceOnly ? r.diskPresent === rt.hasSecret : r.disk === r.running,
  }));
}

/**
 * 面板提交的表单 → 适配器能吃的配置补丁。
 *
 * ⚠️ 白名单三种写法（空串 / '*' / 逗号列表）的**口径必须和 createQQOfficialAdapter 一模一样**，
 * 否则「界面保存的值」和「下次启动读同一个 .env 得到的值」会不一样 ——
 * 那种不一致平时看不出来，重启之后才现形，是最难查的一类。
 */
export function patchFromForm(b: Record<string, unknown>): Partial<QQOfficialConfig> {
  const patch: Partial<QQOfficialConfig> = {};
  if (typeof b['appId'] === 'string') patch.appId = b['appId'].trim();
  // 留空 = 不改：页面不回显密钥，没有这条规则的话一保存就把密钥清了
  if (typeof b['secret'] === 'string' && b['secret'].length > 0) patch.clientSecret = b['secret'].trim();
  patch.markdown = b['markdown'] === true;
  patch.buttons = b['buttons'] === true;
  if (typeof b['sandbox'] === 'boolean') {
    patch.apiBase = b['sandbox'] ? API_BASE_SANDBOX : API_BASE_PROD;
  }
  if (typeof b['allowedCommands'] === 'string') {
    const raw = b['allowedCommands'].trim();
    patch.allowedCommands = raw === '' || raw === '*'
      ? (raw === '*' ? ['*'] : [])
      : raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return patch;
}

/**
 * 指令表：名字来自**路由自己注册的**那一份（不是手抄的清单）。
 *
 * ## 说明的出处改过一次（M2.86）
 *
 * 原来是**从 `.帮助` 的文案里逐行摘**（找 `——` 再正取指令名）。那套办法在
 * `.帮助` 精简之后就崩了 —— 而**测试还是绿的**，因为它只断言了「状态」「创建」
 * 两个碰巧还留着的名字。
 *
 * 现在从 **`COMMAND_GROUPS`** 摘：那是玩家 `.菜单` 图用的同一份表，
 * 也是唯一一份带着说明的权威表（`test/menu-image.test.ts` 会拿它与 router 对账）。
 * 于是「玩家看到的说明」与「后台看到的说明」**永远是同一句**。
 */
export function commandCatalogue(names: readonly string[]): Array<{ name: string; help: string }> {
  const docs = new Map<string, string>();
  for (const group of COMMAND_GROUPS) {
    for (const command of group.commands) {
      if (docs.has(command.name)) continue;
      docs.set(command.name, command.usage !== undefined
        ? command.brief + '（' + command.usage + '）'
        : command.brief);
    }
  }
  return [...names].sort().map((name) => ({ name, help: docs.get(name) ?? '' }));
}
