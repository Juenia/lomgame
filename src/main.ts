/*
 * 入口：把应用组装（`./app.ts`）接到**具体通道**上，再起 HTTP 服务。
 *
 * 应用组装（AppConfig / AppDeps / App / createApp）已搬到 `src/app.ts` ——
 * 那是**通道无关**的部分：它只认 `deps.adapter` 这一个注入点，不认识 OneBot 或 QQ 官方。
 * 这样 `bridge-api/`（无适配器 / 纯 API 版）可以直接复用组装而不加载任何平台实现。
 *
 * 本文件负责的仍是原来那些事：通道装配、/onebot/event 上报、/admin 后台、/health、/metrics。
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OneBotAdapter } from './adapter/onebot.ts';
import { QQOfficialAdapter, createQQOfficialAdapter } from './adapter/qq-official/index.ts';
import { renderLoginReport } from './adapter/qq-official/login-check.ts';
import type { AdapterControl } from './admin/adapter.ts';
import type { HealthSnapshot, QqLoginHealth } from './admin/panels.ts';
import type { OneBotControl, OneBotStatus } from './admin/adapter.ts';
import { createOneBotWsAdapter, wsTransportOf } from './adapter/onebot-ws.ts';
import { CompositeAdapter, type AdapterSlot } from './adapter/composite.ts';
import { runDailyTick } from './infra/tick.ts';
import type { Adapter, InternalMessage } from './adapter/types.ts';
import { CharacterRepo } from './infra/db/characters.ts';
import { AbilityRepo } from './infra/db/abilities.ts';
import { archiveStats, archiveAuditLogs } from './infra/archive.ts';
import { backupDatabase, listBackups } from './infra/backup.ts';
import { LostControlRepo } from './infra/db/lost-control-events.ts';
import { DailyTickRepo } from './infra/db/daily-ticks.ts';
import { WorldRepo } from './infra/db/world.ts';
import { advanceWorld } from './infra/world-tick.ts';
import { BROADCAST_FLUSH_INTERVAL_MS, BroadcastThrottle, mergeBroadcastParts, type BroadcastButton } from './infra/broadcast.ts';
import type { WeatherChange } from './domain/world/weather.ts';
import type { WorldEvent } from './domain/world/events.ts';
import { worldClock } from './domain/world/clock.ts';
import { ItemRepo } from './infra/db/items.ts';
import { LocationRepo } from './infra/db/locations.ts';
import { RecipeRepo } from './infra/db/recipes.ts';
import { consoleLogger, type Logger } from './infra/logger.ts';
import { bufferedLogger, processLogs } from './infra/log-buffer.ts';
import { handleAdmin, ensureAdminPassword, ADMIN_ENV_PATH, type AdminContext } from './admin/index.ts';

import { createApp, loadConfig, type AppConfig, type App } from './app.ts';

// 对外导出保持不变：原来的 `import { createApp } from './main.ts'` 一律照旧可用。
export { createApp, loadConfig } from './app.ts';
export type { AppConfig, App } from './app.ts';

export function createOneBotApp(
  config: AppConfig,
  logger: Logger = consoleLogger,
  extra: { now?: () => number } = {},
): App {
  const adapter = singleChannel('onebot', new OneBotAdapter({
    apiBase: config.onebotApiBase,
    accessToken: config.onebotToken,
    // M2.82：OneBot 也有灰度白名单了（与 QQ 同口径），启动时按 .env 读
    ...(process.env.ONEBOT_ALLOWED_COMMANDS === undefined
      ? {} : { allowedCommands: parseAllowed(process.env.ONEBOT_ALLOWED_COMMANDS) }),
  }));
  const timeTravelDays = config.timeTravelDays ?? 0;
  const now =
    extra.now ??
    (timeTravelDays === 0
      ? undefined
      : () => Date.now() + timeTravelDays * 24 * 60 * 60 * 1000);
  return createApp(config, { adapter, logger, ...(now ? { now } : {}) });
}

/**
 * OneBot 通道 · 内置正向 WebSocket（M2.77）。
 *
 * ## 它和另外两条路的关系
 *
 * 本仓库现在有三条接入方式，**由用户按自己的部署挑一条**，业务层零差别：
 *
 * | 选谁 | 怎么配 | 适合 |
 * | --- | --- | --- |
 * | OneBot · 内置 WS（本函数） | `ADAPTER=onebot` + `ONEBOT_WS_URL=ws://…` | 推荐：只填一个地址，本机不用暴露端口 |
 * | OneBot · HTTP 上报（老路） | `ADAPTER=onebot` | 协议端在别的机器、只能往本机 POST 时 |
 * | QQ 官方机器人 | `ADAPTER=qq` | 有开放平台机器人资质时（走官方协议，不依赖 QQ 客户端） |
 *
 * ⚠️ **内置的是连接层，不是 QQ 协议本身**：QQ NT 的协议实现必须由协议端提供
 * （NapCat / LLOneBot / Lagrange 等，它们要驱动 QQ 客户端本体）。
 * 这里省掉的是「自己搭 OneBot 桥接 + 两头都要填对地址」那件事。
 *
 * 顺序与 createQQApp 同一个理由：**先 createApp 注册 onMessage，再连** ——
 * 反过来会让连上之后头几条事件没有消费者，直接被丢掉。
 */
export async function createOneBotWsApp(
  config: AppConfig,
  logger: Logger = consoleLogger,
  extra: { now?: () => number } = {},
): Promise<App> {
  const bundle = createOneBotWsAdapter(process.env, { logger });
  const timeTravelDays = config.timeTravelDays ?? 0;
  const now =
    extra.now ??
    (timeTravelDays === 0
      ? undefined
      : () => Date.now() + timeTravelDays * 24 * 60 * 60 * 1000);
  const app = createApp(config, { adapter: singleChannel('onebot', bundle.adapter), logger, ...(now ? { now } : {}) });
  await bundle.transport.connect();
  logger.info('OneBot 正向 WS 通道已就绪', {
    url: bundle.transport.url,
    hint: '协议端（NapCat 等）的「正向 WebSocket 服务器」要开在同一个地址上',
  });
  return app;
}

/**
 * **两条通道一起开**（M2.79）。
 *
 * ## 为什么不是「二选一」
 *
 * 官方机器人是一条正规通道，OneBot（协议端）是另一条 —— 运营上很自然的需求是
 * 「不同的群从不同的门进来，进的是同一个世界」。业务层零改动：
 * 两条通道各自把事件翻成 InternalMessage 交给同一套 router、同一个数据库。
 *
 * ## 一条通道坏了，另一条要还能用
 *
 * 所以这里的启动是**分开 try 的**：QQ 侧登录失败（凭证错 / 配额见底 / 平台抖动）
 * 只记 error 并继续，OneBot 侧照常服务。反过来也一样。
 * 只有 `QQ_BOT_STRICT_LOGIN=1` 时才让 QQ 侧的失败把进程带走（上线演练用）。
 *
 * ## ⚠️ 边界（写在这里，免得被误解）
 *
 * **两条通道并行 ≠ 同一个玩家两边接着玩。** OneBot 的 userId 是 QQ 号，
 * 官方的是 openid，判定层会把同一个人认成两个玩家（两个角色、两份进度）。
 * 这里做到的是「两个入口、同一个世界」；身份打通需要独立的账号绑定，本轮没做。
 */
export async function createMultiChannelApp(
  config: AppConfig,
  logger: Logger = consoleLogger,
  extra: { now?: () => number; readyTimeoutMs?: number } = {},
): Promise<App> {
  const slots: AdapterSlot[] = [];

  // ── OneBot 侧（内置 WS 优先，没配就退回反向 HTTP 上报）──
  const onebotWsUrl = (process.env.ONEBOT_WS_URL ?? '').trim();
  const onebotBundle = onebotWsUrl === '' ? null : createOneBotWsAdapter(process.env, { logger });
  const onebotAdapter = onebotBundle?.adapter ?? new OneBotAdapter({
    apiBase: config.onebotApiBase,
    accessToken: config.onebotToken,
  });
  slots.push({ name: 'onebot', adapter: onebotAdapter });

  // ── QQ 官方侧 ──
  const qqAdapter = createQQOfficialAdapter(process.env, { logger });
  slots.push({ name: 'qq', adapter: qqAdapter });

  const composite = new CompositeAdapter(slots, {
    // 主动推送（没收到过消息的会话）默认走哪条 —— 可配，默认 OneBot（内测期的主通道）
    defaultChannel: (process.env.CHANNEL_DEFAULT ?? 'onebot').trim(),
  });
  const timeTravelDays = config.timeTravelDays ?? 0;
  const now =
    extra.now ??
    (timeTravelDays === 0
      ? undefined
      : () => Date.now() + timeTravelDays * 24 * 60 * 60 * 1000);
  const app = createApp(config, { adapter: composite, logger, ...(now ? { now } : {}) });

  if (onebotBundle !== null) {
    try {
      await onebotBundle.transport.connect();
      logger.info('多通道：OneBot 内置 WS 已连上', { url: onebotBundle.transport.url });
    } catch (error) {
      logger.error('多通道：OneBot 内置 WS 连接失败（QQ 官方通道不受影响）', {
        message: (error as Error).message,
      });
    }
  }

  const strict = (process.env.QQ_BOT_STRICT_LOGIN ?? '').trim() === '1';
  try {
    const report = await qqAdapter.loginCheck();
    if (report.ok) {
      logger.info('多通道：QQ 官方通道登录体检通过', { bot: report.identity?.username ?? null });
    } else {
      logger.error('多通道：QQ 官方通道登录体检未通过', { verdict: report.verdict, advice: report.advice });
      if (strict) throw new Error('登录体检未通过（QQ_BOT_STRICT_LOGIN=1）：' + report.verdict);
    }
    qqAdapter.tokens.startAutoRefresh((error) => {
      logger.warn('token 主动续期失败（会在下次用到时再试）', { message: error.message });
    });
    await qqAdapter.start();
    await qqAdapter.waitReady(extra.readyTimeoutMs ?? 30_000);
    logger.info('多通道：QQ 官方通道已就绪');
  } catch (error) {
    logger.error('多通道：QQ 官方通道启动失败 —— OneBot 通道继续服务', {
      message: (error as Error).message,
    });
    if (strict) throw error;
  }

  logger.info('多通道已就绪', { channels: composite.snapshot().channels });
  return app;
}

/**
 * QQ 官方机器人通道（W9）。
 *
 * 与 createOneBotApp 的区别只有「接入层怎么来」：
 * OneBot 是等别人上报（HTTP 服务器被动收），官方是我们主动连网关推事件。
 * 业务侧完全一样 —— 同一个 createApp、同一个 router、同一套判定。
 *
 * 顺序有讲究：必须**先 createApp 注册好 onMessage，再 start 连网关**。
 * 反过来会让网关连上之后头几条事件没有消费者，直接被丢掉。
 */
export async function createQQApp(
  config: AppConfig,
  logger: Logger = consoleLogger,
  extra: { now?: () => number; readyTimeoutMs?: number } = {},
): Promise<App> {
  const adapter = createQQOfficialAdapter(process.env, {
    logger,
    /*
     * M2.76：网关会话落盘。放在数据库同目录（data/），与其它运行期状态一起 ——
     * 它既不是配置（不进 .env），也不是代码（不进版本控制）。
     *
     * 有了它，重启之后会**优先 resume**：省一次 identify 配额，且平台会把
     * 重启期间漏掉的事件补发回来。没有它，每次重启都等于「重新登录」，
     * 那几十秒里玩家发的消息永远不会被处理。
     */
    sessionFile: join(dirname(config.dbPath), 'qq-session.json'),
  });
  const timeTravelDays = config.timeTravelDays ?? 0;
  const now =
    extra.now ??
    (timeTravelDays === 0
      ? undefined
      : () => Date.now() + timeTravelDays * 24 * 60 * 60 * 1000);
  // M2.83：业务层拿到的是合成器（包着 QQ 这条通道），这样运行期还能往里加通道
  const app = createApp(config, { adapter: singleChannel('qq', adapter), logger, ...(now ? { now } : {}) });

  /*
   * M2.75：**先体检，再连网关**。
   *
   * 顺序有讲究：体检是三步只读 GET（换 token → 取机器人身份 → 取网关地址与配额），
   * 不碰网关、不消耗 identify 配额；而它能把「AppID/Secret 写错」这类问题
   * **在连网关之前**就说清楚 —— 否则要等网关以退避节奏重连几轮之后，
   * 日志里才会出现一个 4004。
   *
   * 失败**默认不拦启动**：网络抖动不该让机器人起不来（那会变成一次人为故障）。
   * 要「不通过就不许起」就把 QQ_BOT_STRICT_LOGIN=1 写进 .env ——
   * 正式上线前的演练适合用它，日常跑不建议。
   */
  const loginReport = await adapter.loginCheck();
  if (loginReport.ok) {
    logger.info('登录体检通过', {
      bot: loginReport.identity?.username ?? null,
      botId: loginReport.identity?.id ?? null,
      apiBase: loginReport.apiBase,
      sessionRemaining: loginReport.gatewayBot?.sessionLimit?.remaining ?? null,
      durationMs: loginReport.durationMs,
    });
  } else {
    logger.error('登录体检未通过', {
      verdict: loginReport.verdict,
      advice: loginReport.advice,
    });
    if ((process.env.QQ_BOT_STRICT_LOGIN ?? '').trim() === '1') {
      adapter.stop();
      throw new Error('登录体检未通过（QQ_BOT_STRICT_LOGIN=1）：' + loginReport.verdict);
    }
  }

  /*
   * 主动续期：让 token 在**没人用的时候**自己换新（运营期深夜最典型）。
   * 失败只记日志：续期是后台行为，没有调用者能接这个异常，
   * 抛出去就是 unhandled rejection 把进程带走。
   */
  adapter.tokens.startAutoRefresh((error) => {
    logger.warn('token 主动续期失败（会在下次用到时再试）', { message: error.message });
  });

  await adapter.start();
  // 等到 identify 被平台接受（日志里的「op 0 READY」）才算真的接通
  await adapter.waitReady(extra.readyTimeoutMs ?? 30_000);
  logger.info('QQ 官方通道已就绪', {
    appId: adapter.tokens.appId,
    groupOpenids: adapter.stats.groupOpenids,
  });
  return app;
}

const MAX_BODY = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/** 加速推进的上限：半年。再长就不是跑批而是压测了，给一个闸门免得一次请求把进程拖死 */
const ACCEL_MAX_DAYS = 180;

/** `days` 参数归一：缺省 / 非法 / ≤1 一律回到 1（= 老行为） */
function normalizeAccelDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  const days = Math.floor(value);
  if (days <= 1) return 1;
  return Math.min(days, ACCEL_MAX_DAYS);
}

/**
 * M2.39 任务 3：**加速推进 N 天**（`POST /admin/tick {"days": 30}`）。
 *
 * 为什么它必须存在：本轮的验收口径是「`/admin/tick 30` 产生 1 条播报」。
 * 而在这之前 `/admin/tick` 只结算当天、不推世界，加速只能靠「拨时钟 + 反复发指令」，
 * 那种跑法会在几分钟内把 30 天的播报（以及世界补跑的每一格）全部推出去 —— 配额就是那样被打爆的。
 *
 * 形状刻意做成「**连续 tick**」而不是一次跳到底：
 *   - 一次 `advanceWorld` 最多补 maxCatchUpLight 小时 / maxCatchUpHeavy 天（防重启跑爆的闸门），
 *     跳 30 天本来就得分几次推；
 *   - 逐天推进 = 每次 24 小时，落在补跑上限之内，世界不会「跳过」任何一格。
 *
 * 与老路径的关键差别：**推进过程一条播报都不发**，全部素材收完后渲染成**一条**。
 */
function accelerateDays(app: App, days: number): {
  days: number;
  settled: number;
  lightTicks: number;
  heavyTicks: number;
  events: number;
  broadcasts: number;
} {
  const deps = app.router.deps;
  const base = app.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const target = base + (days - 1) * DAY_MS;

  const changes: WeatherChange[] = [];
  const events: WorldEvent[] = [];
  let settled = 0;
  let lightTicks = 0;
  let heavyTicks = 0;

  try {
    for (let day = 1; day <= days; day += 1) {
      const at = base + (day - 1) * DAY_MS;
      app.setClock(at);
      const summary = runDailyTick(deps, at);
      if (!summary.skipped) settled += 1;
      const world = advanceWorld(deps, at, { force: true });
      changes.push(...world.changes);
      events.push(...world.events);
      lightTicks += world.light.executed;
      heavyTicks += world.heavy.executed;
    }
  } finally {
    /*
     * 时钟**必须还原**：setClock 是全局状态（测试模式下它固定了 app.now()），
     * 留在 future 会让之后每一条指令都跑在「未来」。
     */
    app.setClock(base);
  }

  /*
   * M2.171（用户拍板）：**不再发「过去 N 天」的总结**。
   *
   * 原来这里把补跑期间的全部变化聚合成一条「【世界动态】补齐 N 小时 / N 天……」，
   * 再经 `deps.broadcast` 推到所有群。
   *
   * 去掉它的理由：那是一段**回顾**，不是新闻 —— 群里的人没有义务读一份
   * 「你不在的时候世界发生了什么」的简报，而它占掉的是主动推送的额度
   * （那个额度是留给「现在正在出事」的）。
   *
   * ⚠️ 补跑本身**一个字没改**：每日结算、世界推进、事件落库全都照旧。
   *    砍掉的只有最后那一次推送。
   */

  return {
    days,
    settled,
    lightTicks,
    heavyTicks,
    events: events.length,
    // M2.171：补跑不再推送（这个字段留给调用方读数，恒为 0）
    broadcasts: 0,
  };
}

/**
 * 进程与内容的快照：/health 与管理后台的总览**共用同一份**。
 *
 * 为什么不各算各的：两处都算就是两套口径，而「/health 说 X、后台说 Y」是最难解释的
 * 一类不一致 —— 两个读数都没错，只是不是同一时刻、同一套算法。
 */
/**
 * QQ 官方通道的登录状态（M2.75）。
 *
 * 只读、纯取值 —— 它可能被 /health 高频调用，体检那种会打网络的活儿**不在这里做**。
 */
/*
 * M2.79：**多通道并行**之后 `app.adapter` 可能是 CompositeAdapter，
 * 所以「这条通道在不在」不能再用一次 instanceof 判定 —— 从这里统一取。
 */
function qqAdapterOf(app: App): QQOfficialAdapter | null {
  if (app.adapter instanceof QQOfficialAdapter) return app.adapter;
  if (app.adapter instanceof CompositeAdapter) {
    const slot = app.adapter.slot('qq');
    return slot instanceof QQOfficialAdapter ? slot : null;
  }
  return null;
}

/**
 * 探一下某个本机端口有没有在监听（M2.84）。
 *
 * 为什么需要它：「没连上协议端」底下有两类完全不同的原因 ——
 *   1. **协议端根本没启动**（端口没人监听）→ 去启动它；
 *   2. **协议端在跑，但它没连过来 / 没登录**（端口在听）→ 去协议端里连一次、扫一次码。
 * 两者的处置方式不同，而面板上原来都只显示「未连接」，用户只能猜。
 */
async function probePort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  const net = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * .env 里的白名单字符串 → 数组。**口径必须与后台的 onebotPatchFromForm 一致**：
 * 空串与 * 都是「全放行」，其余按逗号切。两处不一致的话，
 * 「界面保存的值」与「下次启动读同一个 .env 得到的值」会不一样 —— 重启之后才现形。
 */
function parseAllowed(raw: string): string[] {
  const t = raw.trim();
  if (t === '' || t === '*') return t === '*' ? ['*'] : [];
  return t.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 单通道也包一层合成器（M2.83）。
 *
 * 为什么：后台的「启用另一条通道」要在**不重启进程**的前提下做到，
 * 而 router 攥着的是 app.adapter 这一个对象 —— 只有它是合成器时，
 * 才能往里动态挂通道。包一层的代价是零：一条通道时它的行为与原来完全一样。
 */
function singleChannel(name: 'onebot' | 'qq', adapter: Adapter): CompositeAdapter {
  return new CompositeAdapter([{ name, adapter }], { defaultChannel: name });
}

function onebotAdapterOf(app: App): OneBotAdapter | null {
  if (app.adapter instanceof OneBotAdapter) return app.adapter;
  if (app.adapter instanceof CompositeAdapter) {
    const slot = app.adapter.slot('onebot');
    return slot instanceof OneBotAdapter ? slot : null;
  }
  return null;
}

function qqLoginHealth(app: App): QqLoginHealth | null {
  const qq = qqAdapterOf(app);
  if (qq === null) return null;
  const rt = qq.runtimeStatus();
  const login = rt.login;
  return {
    appId: rt.appId,
    sandbox: rt.sandbox,
    connected: rt.connected,
    tokenRemainingSec: rt.token.remainingSec,
    tokenAutoRefresh: rt.token.autoRefresh,
    gateway: {
      identifies: rt.stats.gateway.identifies,
      resumes: rt.stats.gateway.resumes,
      reconnects: rt.stats.gateway.reconnects,
      fatalStops: rt.stats.gateway.fatalStops,
      resumedFromDisk: rt.stats.gateway.resumedFromDisk,
      lastClose: rt.stats.gateway.lastClose,
    },
    login: login === null ? null : {
      ok: login.ok,
      at: login.at,
      verdict: login.verdict,
      bot: login.identity?.username ?? null,
      sessionRemaining: login.sessionLimit?.remaining ?? null,
      sessionTotal: login.sessionLimit?.total ?? null,
    },
  };
}

/**
 * OneBot 通道的连接状态（M2.77）。只读取值，不打网络、不建连接。
 *
 * 两种传输都在这里收口：
 *   · 内置正向 WS —— 报连接状态、协议端账号、心跳、重连次数；
 *   · 反向 HTTP 上报 —— 没有「连接」这个概念，`connected` 报 null
 *     （面板要能区分「没连上」和「本来就这种模式」）。
 */
function onebotStatusOf(app: App): OneBotStatus | null {
  const adapter = onebotAdapterOf(app);
  if (adapter === null) return null;
  const transport = wsTransportOf(adapter);
  if (transport === null) {
    return {
      transport: 'http',
      url: app.config.onebotApiBase,
      connected: null,
      selfId: null,
      nickname: null,
      heartbeats: 0,
      events: adapter.handled,
      apiCalls: 0,
      apiErrors: 0,
      reconnects: 0,
      lastError: null,
      lastClose: null,
      handled: adapter.handled,
    };
  }
  const s = transport.stats;
  return {
    transport: 'websocket',
    url: transport.url,
    connected: s.connected,
    selfId: s.selfId,
    nickname: s.nickname,
    heartbeats: s.heartbeats,
    events: s.events,
    apiCalls: s.apiCalls,
    apiErrors: s.apiErrors,
    reconnects: s.reconnects,
    lastError: s.lastError,
    lastClose: s.lastClose,
    handled: adapter.handled,
  };
}

function healthSnapshot(app: App): HealthSnapshot {
  const characters = new CharacterRepo(app.db).count();
  const backups = listBackups(
    app.config.backupDir ?? join(dirname(app.config.dbPath), 'backups'),
  );
  return {
    commands: app.router.commands,
    characters,
    cards: app.cards.length,
    locations: new LocationRepo(app.db).count(),
    recipes: new RecipeRepo(app.db).count(),
    items: new ItemRepo(app.db).count(),
    abilities: new AbilityRepo(app.db).count(),
    lostControlEvents: new LostControlRepo(app.db).total(),
    lastTick: new DailyTickRepo(app.db).latest(),
    world: (() => {
      const repo = new WorldRepo(app.db);
      const state = repo.state();
      const clock = worldClock(app.now(), repo.seed());
      return {
        seed: repo.seed(),
        timeOfDay: clock.timeOfDay,
        moonPhase: clock.moonPhase,
        foggy: clock.foggy,
        locations: repo.countWeather(),
        lightTicks: repo.countTicks('light'),
        heavyTicks: repo.countTicks('heavy'),
        lastLightAt: state?.lastLightAt ?? null,
        lastHeavyAt: state?.lastHeavyAt ?? null,
      };
    })(),
    backup: backups[0]
      ? { file: backups[0].file, bytes: backups[0].bytes, count: backups.length }
      : null,
    audit: archiveStats(app.db),
    timeTravelDays: app.config.timeTravelDays ?? 0,
    dbPath: app.config.dbPath,
    qq: qqLoginHealth(app),
    onebot: onebotStatusOf(app),
  };
}
/**
 * 没设 HOST 时服务实际绑在哪。
 *
 * Node 的 `listen(port)` 不写地址时绑**所有接口** —— 那不是「没配置」，
 * 而是一个真实且危险的默认值。面板上必须照实说（显示 0.0.0.0），
 * 不能显示成空白让人以为它只在本机。
 */
export const HOST_DEFAULT = '0.0.0.0';

/**
 * 本机的局域网 IPv4（M2.82：给「服务与访问」那一屏算「局域网从哪进」）。
 *
 * 只取 IPv4 非回环。IPv6 的地址长到没人会拿它进后台，
 * 而 ::1 是回环 —— 列进「局域网可达」只会让人以为能远程访问。
 */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

export function startHttpServer(app: App): Server {
  /*
   * 监听地址（M2.82）。
   *
   * ⚠️ `HOST` 不设时**保持原来那句 `listen(port)`** —— 这一项的目的不是改默认行为，
   * 而是把「其实已经能从局域网进」这件事变成可配置、可收回的。
   * 默认值一动，所有人的部署都会跟着变，那不是这一轮该做的事。
   */
  const host = (process.env['HOST'] ?? '').trim();
  /*
   * M2.49 管理后台。口令优先取 .env 的 ADMIN_PASSWORD，没有就当场生成一个随机口令
   * 打进日志 —— 后台能改玩家数值、能改 AppSecret，留默认口令等于没有登录。
   */
  /*
   * 适配器控制（M2.51）。做成结构性的窄接口而不是把 QQOfficialAdapter 整个暴露给后台：
   * OneBot 通道没有这些能力，而「没有它」在面板上要长得不一样 ——
   * 摆一堆点了没反应的按钮比不摆更糟。
   */
  const qq = qqAdapterOf(app) ?? undefined;
  const adapterControl: AdapterControl | undefined = qq === undefined ? undefined : {
    runtimeStatus: () => qq.runtimeStatus(),
    reconfigure: (patch) => qq.reconfigure(patch),
    reconnectGateway: () => qq.reconnectGateway(),
    /*
     * M2.75：这个按钮从「验一次凭证」升级成**完整登录体检**。
     *
     * 原来它只强制换一次 token，能回答的只有「凭证对不对」。而运营真正会遇到的
     * 「连不上」有五类（配置 / 凭证 / 配额 / 网络 / 权限），只验 token 会把后三类
     * 全部漏掉 —— 面板上显示「凭证有效」，人却仍然连不上，比什么都不显示更误导。
     */
    verify: async () => {
      const report = await qq.loginCheck();
      return { ok: report.ok, message: renderLoginReport(report) };
    },
  };

  /*
   * M2.78：OneBot 通道的后台控制。
   *
   * 在此之前面板只认 QQ 官方通道 —— 接了 OneBot 的部署打开「适配器」页几乎是空的，
   * 明明有连接、有账号、有重连次数，却只能去翻日志。
   */
  const onebotTransport = wsTransportOf(onebotAdapterOf(app));
  const onebotControl: OneBotControl | undefined =
    onebotAdapterOf(app) === null ? undefined : {
      status: () => onebotStatusOf(app) ?? {
        transport: 'http', url: app.config.onebotApiBase, connected: null, selfId: null, nickname: null,
        heartbeats: 0, events: 0, apiCalls: 0, apiErrors: 0, reconnects: 0,
        lastError: null, lastClose: null, handled: 0,
      },
      // M2.82：配置（此刻在用的）+ 连接（哪条传输、地址），与 QQ 那套同一份形状
      config: () => {
        const adapter = onebotAdapterOf(app);
        const status = onebotStatusOf(app);
        const runtime = adapter?.runtimeStatus() ?? {
          apiBase: app.config.onebotApiBase, hasToken: false,
          allowedCommands: [], handled: 0, filteredByWhitelist: 0,
        };
        return {
          ...runtime,
          transport: status?.transport ?? 'http',
          url: status?.url ?? app.config.onebotApiBase,
          pendingReconnect: adapter === null ? [] : [...adapter.pendingReconnect],
        };
      },
      reconfigure: (patch) => {
        const adapter = onebotAdapterOf(app);
        if (adapter === null) return { applied: [], needsReconnect: [], pendingReconnect: [] };
        return adapter.reconfigure(patch);
      },
      reconnect: async () => {
        if (onebotTransport === null) {
          return {
            ok: false,
            message: '当前是反向 HTTP 上报模式：没有长连接可重连 —— 事件由协议端主动 POST 过来。' +
              '要换成内置连接，请在 .env 里填 ONEBOT_WS_URL（协议端的正向 WebSocket 地址）。',
          };
        }
        onebotTransport.close();
        try {
          await onebotTransport.connect();
          // 重连成功 = 那些「要重连才生效」的项已经生效了，清单清掉
          onebotAdapterOf(app)?.clearPendingReconnect();
          return { ok: true, message: '已重新连接协议端 ' + onebotTransport.url + '。' };
        } catch (error) {
          return { ok: false, message: '重连失败：' + (error as Error).message };
        }
      },
      verify: async () => {
        if (onebotTransport === null) {
          return {
            ok: true,
            message: '反向 HTTP 上报模式：没有连接可查。「实时状态」里的「收到事件」是协议端推过来的条数 —— ' +
              '它会一直涨就说明通着。',
          };
        }
        try {
          const self = await onebotTransport.fetchSelf();
          /*
           * 拿到了机器人账号 = 协议端**已经登录 QQ** 了。
           * 反过来（连上了但 selfId 是空）说明协议端在跑、却没登录 —— 那一步只能在协议端里做，
           * 这里要把话说清楚，别让人以为是本项目的问题。
           */
          if (!self.selfId) {
            return {
              ok: false,
              message: '协议端连上了，但它还没登录 QQ。去协议端（NapCat / Lagrange 等）的界面里完成扫码登录，' +
                '登录后回这里再点一次「体检」。',
            };
          }
          return {
            ok: true,
            message: '协议端在线且已登录：机器人账号 ' + self.selfId + '（' + self.nickname + '）。' +
              '心跳 ' + onebotTransport.stats.heartbeats + ' 次，重连 ' + onebotTransport.stats.reconnects + ' 次。',
          };
        } catch (error) {
          /*
           * 连不上时，探一下协议端**到底在不在跑** —— 这是「去启动协议端」与
           * 「去协议端里连一次」的分岔口，而这两件事的处置完全不同。
           */
          let port = 0;
          try {
            port = Number(new URL(onebotTransport.url).port || '0');
          } catch { /* 地址不是标准 URL 就不探 */ }
          const listening = port > 0 ? await probePort('127.0.0.1', port) : null;
          const where = onebotTransport.url;
          const next = listening === true
            ? '端口 ' + port + ' **有服务在监听** —— 协议端在跑，但它没连过来（或它自己还没登录）。' +
              '去协议端里确认「正向 WebSocket 服务器」已开启、地址与这里一致。'
            : listening === false
              ? '端口 ' + port + ' **没有任何服务在监听** —— 协议端多半还没启动。先把它跑起来。'
              : '（没能判断本机端口状态，地址不是标准 URL。）';
          return {
            ok: false,
            message: '连不上协议端 ' + where + '：' + (error as Error).message + '\n' + next +
              '\n⚠️ 本项目**不内置 QQ 登录** —— 扫码那一步永远在协议端（NapCat / Lagrange 等）里做，' +
              '因为那需要驱动 QQ 客户端本体或自己实现 QQ 协议。',
          };
        }
      },
    };

  /*
   * M2.83：**运行期启用 / 停用一条通道**。
   *
   * 这是「别让用户手编 .env」的最后一块：启用动作在后台点一下，.env 由服务端写，
   * 而**这一层负责让它立刻生效**（不必重启进程）。router 攥着的是同一个合成器对象，
   * 往里挂一条通道就等于这条通道立刻开始收消息。
   */
  const channelControl = async (
    channel: 'onebot' | 'qq',
    enable: boolean,
  ): Promise<{ hot: boolean; message: string }> => {
    const composite = app.adapter instanceof CompositeAdapter ? app.adapter : null;
    if (composite === null) {
      return { hot: false, message: '这个进程的接入层不是合成器，重启进程后生效。' };
    }
    if (!enable) {
      const slot = composite.slot(channel);
      if (slot === null) return { hot: true, message: '它本来就没在跑。' };
      // 关掉底层连接：不关的话它还在收消息，只是没人处理（等于把消息丢了）
      if (slot instanceof QQOfficialAdapter) slot.stop();
      else wsTransportOf(slot)?.close();
      composite.removeSlot(channel);
      return { hot: true, message: '已停用（另一条通道不受影响）。' };
    }
    if (composite.hasSlot(channel)) return { hot: true, message: '它已经在跑了。' };
    try {
      if (channel === 'onebot') {
        const wsUrl = (process.env.ONEBOT_WS_URL ?? '').trim();
        const bundle = wsUrl === '' ? null : createOneBotWsAdapter(process.env, { logger: app.logger });
        const obAdapter = bundle?.adapter ?? new OneBotAdapter({
          apiBase: app.config.onebotApiBase,
          accessToken: app.config.onebotToken,
        });
        if (bundle !== null) await bundle.transport.connect();
        composite.addSlot({ name: 'onebot', adapter: obAdapter });
        return { hot: true, message: '已启用，开始收消息。' };
      }
      /*
       * ⚠️ 先查凭证，再动手。
       *
       * 直接调 createQQOfficialAdapter 会抛 TokenError，而那句话是给 CLI 看的
       * （「把 .env.example 复制成 .env 并填真值…」）—— 用户在后台点一下按钮，
       * 收到的却是教他怎么编辑文件的说明，而且**信息里没有"去哪儿填"**。
       * 现在这里直接说清楚：去哪一页、填哪两个值、然后回来点什么。
       */
      const hasCreds = (process.env.QQ_BOT_APPID ?? '').trim() !== ''
        && (process.env.QQ_BOT_SECRET ?? '').trim() !== '';
      if (!hasCreds) {
        return {
          hot: false,
          message: '还没填凭证。点这张卡片上的「进入」，在 QQ 官方机器人子页填 AppID 与 AppSecret，' +
            '保存后再回来点「启用」。',
        };
      }
      const qqAdapter = createQQOfficialAdapter(process.env, { logger: app.logger });
      const report = await qqAdapter.loginCheck();
      if (!report.ok) return { hot: false, message: '登录体检没过：' + report.verdict + '（填好凭证再试）' };
      qqAdapter.tokens.startAutoRefresh(() => { /* 后台行为，失败留给下一次 */ });
      await qqAdapter.start();
      await qqAdapter.waitReady(20_000);
      composite.addSlot({ name: 'qq', adapter: qqAdapter });
      return { hot: true, message: '已启用并连上网关。' };
    } catch (error) {
      return { hot: false, message: '启用失败：' + (error as Error).message };
    }
  };

  const adminCtx: AdminContext = {
    envPath: ADMIN_ENV_PATH(process.cwd()),
    log: (message, meta) => consoleLogger.info(message, meta),
    startedAt: new Date().toISOString(),
    root: process.cwd(),
    db: app.db,
    adapter: adapterControl,
    ...(onebotControl ? { onebot: onebotControl } : {}),
    channelControl,
    // 白名单勾选按路由**自己注册**的指令出，不手抄一份会漂移的清单
    commandNames: () => app.router.commands,
    // 总览直接读 /health 的那份快照，不另算一份
    health: () => healthSnapshot(app),
    backupDir: app.config.backupDir ?? join(dirname(app.config.dbPath), 'backups'),
    /*
     * M2.82：「服务与访问」那一屏要的两件事实。
     *
     * listening 用的是**配置值**而不是 server.address() —— 后者要等 listen 回调，
     * 而这个对象在 server 创建之前就建好了。两者在这里等价：
     * app.config.port 与 host 都是进程启动时读的那一份，正是「进程在用的值」。
     */
    access: {
      lanIps: lanAddresses(),
      listening: { host: host.length > 0 ? host : HOST_DEFAULT, port: app.config.port },
    },
    // M2.63：数据编辑器保存后立刻热重载 —— 改完内容不用重启进程（不断网关）
    reloadContent: () => app.reloadContent(),
    // 真连没连上，问网关自己 —— 别在后台里写死一个假状态
    gatewayReady: () => {
      const a = app.adapter as unknown as { gateway?: { ready?: boolean } };
      return a.gateway?.ready === true;
    },
  };
  ensureAdminPassword(adminCtx.envPath, adminCtx.log, {
    /*
     * TRUST_PROXY：前面有自己配的反向代理时才开。
     * 认它才认 X-Forwarded-For —— 默认不信，因为那个头谁都能伪造。
     */
    trustProxy: /^(1|true|yes)$/i.test(process.env['TRUST_PROXY'] ?? ''),
  });
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';
      // 放在业务路由之前：后台自带登录，与 /health /cards /metrics 互不相干
      if (await handleAdmin(req, res, url, adminCtx)) return;
      if (req.method === 'GET' && url.startsWith('/health')) {
        send(res, 200, { ok: true, ...healthSnapshot(app) });
        return;
      }
      /*
       * M2.47：角色卡图片托管。
       *
       * 为什么需要它：QQ 官方 Markdown 的图片要**公网可访问的 URL**
       * （官方原文：「请使用可在公网访问的资源 url，开放平台会下载转存该资源」），
       * 而卡是本地 PowerShell 画出来的。所以这里把出图目录挂成静态路由，
       * 由 `CARD_PUBLIC_BASE_URL` 指到外网可达的地址（反代 / 内网穿透 / 同机公网 IP）。
       *
       * 只认**纯文件名**（不含路径分隔符）且必须是 .png —— 这样不需要
       * 规范化路径也不会有目录穿越：`../` 里的斜杠在第一道白名单就被拒了。
       *
       * 没配 `CARD_PUBLIC_BASE_URL` 时这条路照样存在，只是没人会来取
       * （`.角色` 不会产生公网 URL，通道走不到发图分支）。
       */
      if (req.method === 'GET' && url.startsWith('/cards/')) {
        const name = decodeURIComponent(url.slice('/cards/'.length).split('?')[0] ?? '');
        if (!/^[A-Za-z0-9_-]+\.png$/.test(name)) {
          send(res, 400, { ok: false, error: 'bad card name' });
          return;
        }
        const cardDir = app.config.cardOutDir ?? join(process.cwd(), 'data', 'cards');
        try {
          const bytes = readFileSync(join(cardDir, name));
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': bytes.length,
            // 文件名带时间戳、内容不可变 ⇒ 可以长缓存
            'cache-control': 'public, max-age=86400, immutable',
          });
          res.end(bytes);
        } catch {
          // 不区分「不存在」与「读不了」：对外都是 404，避免泄露目录结构
          send(res, 404, { ok: false, error: 'card not found' });
        }
        return;
      }
      if (req.method === 'POST' && url.startsWith('/admin/clock')) {
        const token = app.config.adminToken ?? app.config.onebotToken;
        if (!token || req.headers['x-admin-token'] !== token) {
          send(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        if (!app.config.allowClockControl) {
          send(res, 403, { ok: false, error: 'clock control disabled' });
          return;
        }
        const body = await readBody(req);
        const payload = body ? (JSON.parse(body) as { now?: number | null }) : {};
        const next = typeof payload.now === 'number' ? payload.now : null;
        app.setClock(next);
        send(res, 200, { ok: true, now: next });
        return;
      }
      if (req.method === 'POST' && url.startsWith('/admin/tick')) {
        const token = app.config.adminToken ?? app.config.onebotToken;
        if (!token || req.headers['x-admin-token'] !== token) {
          send(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        const body = await readBody(req);
        const payload = body ? (JSON.parse(body) as { days?: unknown }) : {};
        const days = normalizeAccelDays(payload.days);
        if (days === 1) {
          // 用服务端时钟而不是 Date.now()：时钟被固定时（测试）才可能跨天补跑结算，
          // 否则第 2 天起 date 还是同一天，会被 daily_ticks 的幂等直接跳过。
          //
          // ⚠️ 这条是**原样的老路径**（days 缺省 = 1）：只结算当天，不推时钟、不发播报。
          const summary = runDailyTick(app.router.deps, app.now());
          app.logger.info('手动触发每日结算', { date: summary.date, skipped: summary.skipped });
          send(res, 200, { ok: true, summary });
          return;
        }
        const accelerated = accelerateDays(app, days);
        app.logger.info('加速推进完成', { ...accelerated });
        send(res, 200, { ok: true, ...accelerated });
        return;
      }
      // M2.3：把「服务端此刻挂着的菜单」结构化地交给测试侧。
      // 为什么需要它：菜单选项的 command（如 探索 老码头）无法从渲染文本可靠还原
      //（label 是给人看的，带了匹配度与掉落说明），虚拟玩家要回数字就必须拿到选项本身。
      // 与 /admin/clock 同一套开关：只有 allowClockControl（测试模式）才开。
      if (req.method === 'POST' && url.startsWith('/admin/menu')) {
        const token = app.config.adminToken ?? app.config.onebotToken;
        if (!token || req.headers['x-admin-token'] !== token) {
          send(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        if (!app.config.allowClockControl) {
          send(res, 403, { ok: false, error: 'menu endpoint disabled' });
          return;
        }
        const body = await readBody(req);
        const payload = body ? (JSON.parse(body) as { userId?: string }) : {};
        const character = new CharacterRepo(app.db).findByUserId(String(payload.userId ?? ''));
        const current = character
          ? app.router.deps.pendingMenus.current(character.id, app.now())
          : null;
        // M2.4：个人菜单没有时，把「房间里那张」世界事件菜单交出去 ——
        // 虚拟玩家靠它把群里看到的世界播报变成一次数字响应（与路由的 pick 同一口径）。
        const shared = current
          ? null
          : app.router.deps.pendingMenus.worldEventMenuAt(app.now());
        send(res, 200, {
          ok: true,
          menu: current
            ? { menuType: current.menuType, ...current.menu }
            : shared
              ? { menuType: shared.menuType, eventId: shared.eventId, ...shared.menu }
              : null,
        });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/metrics')) {
        send(res, 200, {
          ok: true,
          monitor: app.monitor.snapshot(),
          audit: archiveStats(app.db),
          lostControlEvents: new LostControlRepo(app.db).total(),
        });
        return;
      }
      if (req.method === 'POST' && url.startsWith('/onebot/event')) {
        // M2.83：单通道现在也包了一层合成器，所以这里不能再直接 instanceof —— 走 helper
        if (onebotAdapterOf(app) !== null && onebotAdapterOf(app)!.authorized(req.headers.authorization) === false) {
          send(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        try {
          const body = await readBody(req);
          const payload = body ? (JSON.parse(body) as unknown) : null;
          await onebotAdapterOf(app)?.handleEvent(payload);
          send(res, 200, { ok: true });
        } catch (error) {
          app.logger.error('上报处理失败', { error: (error as Error).message });
          send(res, 200, { ok: false, error: (error as Error).message });
        }
        return;
      }
      send(res, 404, { ok: false, error: 'not found' });
    })();
  });

  const onListen = (): void => {
    app.logger.info('HTTP 服务已启动', {
      // 把**实际绑的地址**打进日志：绑 0.0.0.0 和绑 127.0.0.1 是两件很不一样的事
      host: host.length > 0 ? host : HOST_DEFAULT + '（默认，所有网卡）',
      lanIps: lanAddresses(),
      port: app.config.port,
      onebotReportUrl: `http://127.0.0.1:${app.config.port}/onebot/event`,
      health: `http://127.0.0.1:${app.config.port}/health`,
      dbPath: app.config.dbPath,
    });
  };
  if (host.length === 0) server.listen(app.config.port, onListen);
  else server.listen(app.config.port, host, onListen);
  return server;
}

async function main(): Promise<void> {
  // .env 已进 .gitignore。文件不存在是正常情况（CI / 生产用环境变量注入），静默跳过。
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env，就用进程已有的环境变量
  }
  const config = loadConfig();
  // ADAPTER=qq 走官方机器人网关；默认仍是内测的 OneBot 通道
  const useQQ = (process.env.ADAPTER ?? 'onebot').trim().toLowerCase() === 'qq';
  /*
   * 真实进程的 logger 带上环形缓冲（后台的「日志」面板读它）。
   * 只在这里包一层：测试各自传自己的 logger，不该被塞进这个进程级缓冲里。
   */
  const logger = bufferedLogger(processLogs);
  /*
   * M2.77：OneBot 侧再分两种传输，**由配置决定**，不是二选一：
   *   配了 ONEBOT_WS_URL → 内置正向 WS（游戏主动连协议端，本机不用暴露端口）；
   *   没配              → 原来的反向 HTTP 上报，行为一字不变（老部署照常跑）。
   */
  const onebotWsUrl = (process.env.ONEBOT_WS_URL ?? '').trim();
  const adapterMode = (process.env.ADAPTER ?? 'onebot').trim().toLowerCase();
  /*
   * M2.79：`ADAPTER` 现在有三个值 —— 用户自己挑：
   *   onebot（默认）/ qq / **both（两条一起开）**。
   */
  const app = adapterMode === 'both'
    ? await createMultiChannelApp(config, logger)
    : useQQ
      ? await createQQApp(config, logger)
      : onebotWsUrl !== ''
        ? await createOneBotWsApp(config, logger)
        : createOneBotApp(config, logger);
  const server = startHttpServer(app);
  const shutdown = (signal: string): void => {
    app.logger.info('收到退出信号，正在关闭', { signal });
    server.close(() => {
      app.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error('启动失败', error);
    process.exit(1);
  });
}
