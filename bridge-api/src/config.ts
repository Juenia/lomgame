/**
 * bridge-api 自己的配置（全部来自环境变量，与现有版本共用一套读取习惯）。
 *
 * ## 一条口径：**默认值取"不容易出事"的那一侧**
 *
 *   · 监听地址默认 **127.0.0.1**（不是 0.0.0.0）—— 上游框架通常与本进程同机或同内网，
 *     而"随手起一个 0.0.0.0 且没设口令"的 API 是能改玩家存档的；
 *   · 没设 `BRIDGE_TOKEN` 时，**非本机请求一律拒绝**（不是放行）——
 *     要跨机接入就必须显式设一个口令，这一步不能靠"忘了"跳过；
 *   · 数据库默认写 `data/bridge.db`，**与现有版本的库分开** ——
 *     两个进程同时写一个 SQLite 文件会锁冲突（那是"偶尔卡住几秒"这种最难查的故障）。
 */
import { join } from 'node:path';
import { DEFAULT_CAPABILITIES, type ResolvedCapabilities } from './protocol.ts';

export type ImageMode = 'base64' | 'url' | 'both';

export interface BridgeConfig {
  /** 监听地址（默认 127.0.0.1） */
  host: string;
  port: number;
  /** 接口口令；未设置时只服务本机请求 */
  token?: string;
  /** 游戏库路径（默认 data/bridge.db —— 与现有版本分开） */
  dbPath: string;
  /** 出站队列容量（超出挤掉最旧的，并在响应里报 gap） */
  outboxCapacity: number;
  /** 图片怎么给上游：base64（默认，最通用）/ url（最省流量）/ both */
  imageMode: ImageMode;
  /** 长轮询最多挂多久（毫秒） */
  longPollMaxMs: number;
  /** 单张图的字节上限；超了只告警（不丢图 —— 玩家等的是那张卡，不是日志） */
  maxImageBytes: number;
  /** 上游多久没动静就算"不在线"（毫秒） */
  upstreamStaleMs: number;
  /** 全局缺省能力（上游没声明时按它走） */
  capabilities: ResolvedCapabilities;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = (env[key] ?? '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = (env[key] ?? '').trim();
  return raw === '' ? fallback : raw;
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const token = (env.BRIDGE_TOKEN ?? '').trim();
  const mode = str(env, 'BRIDGE_IMAGE_MODE', 'base64').toLowerCase();
  const capabilities: ResolvedCapabilities = { ...DEFAULT_CAPABILITIES };
  /*
   * 全局能力开关（可选）：`BRIDGE_CAPS=buttons,images,richText`。
   *
   * 为什么要有它：单上游部署（最常见）没人会去调 /api/v1/capabilities，
   * 而"这条通道到底能不能摆按钮"必须有个地方说。写在这里 = 改 .env 重启即可。
   * 运行期的 /api/v1/capabilities 优先级更高（它更具体）。
   */
  for (const raw of str(env, 'BRIDGE_CAPS', '').split(',')) {
    const key = raw.trim().toLowerCase();
    if (key === 'buttons') capabilities.buttons = true;
    else if (key === 'images') capabilities.images = true;
    else if (key === 'inline' || key === 'inlineimages') capabilities.inlineImages = true;
    else if (key === 'richtext') capabilities.richText = true;
  }
  const avatarTemplate = (env.BRIDGE_AVATAR_TEMPLATE ?? '').trim();
  if (avatarTemplate !== '') capabilities.avatarTemplate = avatarTemplate;
  return {
    host: str(env, 'BRIDGE_HOST', '127.0.0.1'),
    port: num(env, 'BRIDGE_PORT', 3200),
    ...(token !== '' ? { token } : {}),
    dbPath: str(env, 'BRIDGE_DB_PATH', join(process.cwd(), 'data', 'bridge.db')),
    outboxCapacity: Math.max(1, Math.floor(num(env, 'BRIDGE_OUTBOX_CAPACITY', 500))),
    imageMode: mode === 'url' || mode === 'both' ? mode : 'base64',
    longPollMaxMs: Math.max(0, Math.floor(num(env, 'BRIDGE_LONGPOLL_MS', 25_000))),
    maxImageBytes: Math.max(1024, Math.floor(num(env, 'BRIDGE_MAX_IMAGE_KB', 4096) * 1024)),
    upstreamStaleMs: Math.max(1_000, Math.floor(num(env, 'BRIDGE_UPSTREAM_STALE_MS', 120_000))),
    capabilities,
  };
}

/** 口令脱敏：日志里只留前 4 位与长度（照抄 src/adapter/qq-official/token.ts 的口径） */
export function maskToken(token: string): string {
  if (token.length <= 4) return '*'.repeat(token.length);
  return token.slice(0, 4) + '*'.repeat(Math.max(0, token.length - 4));
}

/** 启动日志用的那份（**已脱敏**；口令只出现在这里，别处不许打） */
export function describeBridgeConfig(config: BridgeConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    token: config.token === undefined ? '(未设置，只服务本机请求)' : maskToken(config.token),
    dbPath: config.dbPath,
    outboxCapacity: config.outboxCapacity,
    imageMode: config.imageMode,
    longPollMs: config.longPollMaxMs,
    capabilities: config.capabilities,
  };
}
