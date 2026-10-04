/**
 * bridge-api 的 HTTP 服务 —— 这一版**唯一的对外入口**。
 *
 * 它把三件本来分散在不同地方的事放在同一个端口上：
 *
 *   1. `/api/v1/*` —— 上游框架（BEE / Koishi）对接用的那套接口（见 docs/API.md）；
 *   2. `/admin/*`  —— 运营后台，**原样复用**现有版本的实现（`src/admin/index.ts`）：
 *      内容编辑、GM、备份、热重载全套都在，一行都没有重写；
 *   3. `/health` `/metrics` —— 运维探活。
 *
 * ## 为什么后台能直接复用
 *
 * 因为后台从来就不认识适配器：它要的是「一个库句柄 + 一份健康快照 + 一个热重载函数」，
 * 而这些都由 `createApp` 的产物提供。所以这一版干脆把适配器相关的那几个可选字段
 * （`adapter` / `onebot` / `channelControl`）**不传** —— 后台里对应面板会显示"没有"，
 * 这正是事实。
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { ADMIN_ENV_PATH, ensureAdminPassword, handleAdmin, type AdminContext } from '../../src/admin/index.ts';
import type { HealthSnapshot } from '../../src/admin/panels.ts';
import type { InternalMessage } from '../../src/adapter/types.ts';
import type { App } from '../../src/app.ts';
import { worldClock } from '../../src/domain/world/clock.ts';
import { AbilityRepo } from '../../src/infra/db/abilities.ts';
import { CharacterRepo } from '../../src/infra/db/characters.ts';
import { DailyTickRepo } from '../../src/infra/db/daily-ticks.ts';
import { ItemRepo } from '../../src/infra/db/items.ts';
import { LocationRepo } from '../../src/infra/db/locations.ts';
import { LostControlRepo } from '../../src/infra/db/lost-control-events.ts';
import { RecipeRepo } from '../../src/infra/db/recipes.ts';
import { WorldRepo } from '../../src/infra/db/world.ts';
import { archiveStats } from '../../src/infra/archive.ts';
import { listBackups } from '../../src/infra/backup.ts';
import type { Logger } from '../../src/infra/logger.ts';
import type { ApiChannel } from './channel.ts';
import type { BridgeConfig } from './config.ts';
import type { Outbox } from './outbox.ts';
import { capabilitiesSchema, inboundSchema, inlineImageSchema, type ErrorResponse } from './protocol.ts';

/** 入站报文很小（一条消息），256KB 已经绰绰有余 —— 与现有版本的 /onebot/event 同一口径 */
const MAX_BODY = 256 * 1024;

/** SSE 心跳间隔：比大多数反代的 60 秒空闲超时短一半 */
const SSE_PING_MS = 15_000;

export interface BridgeServerOptions {
  app: App;
  channel: ApiChannel;
  outbox: Outbox;
  config: BridgeConfig;
  logger: Logger;
  /** 前面有自己配的反向代理时才开（认 X-Forwarded-For） */
  trustProxy?: boolean;
}

export function createBridgeServer(options: BridgeServerOptions): Server {
  const { app, channel, outbox, config, logger } = options;
  const adminCtx = buildAdminContext(options);
  ensureAdminPassword(adminCtx.envPath, adminCtx.log, {
    trustProxy: options.trustProxy === true,
  });

  return createServer((req, res) => {
    void (async () => {
      const rawUrl = req.url ?? '/';
      try {
        // 后台自带登录，放在最前面（与现有版本的顺序一致）
        if (await handleAdmin(req, res, rawUrl, adminCtx)) return;
        const url = new URL(rawUrl, 'http://localhost');
        const path = url.pathname;

        if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
          sendJson(res, 200, { ok: true, ...healthSnapshot(app), bridge: bridgeStatus(options) });
          return;
        }
        if (req.method === 'GET' && path === '/metrics') {
          sendJson(res, 200, {
            ok: true,
            monitor: app.monitor.snapshot(),
            audit: archiveStats(app.db),
            outbox: outbox.stats,
            upstreams: channel.upstreams(),
          });
          return;
        }
        if (path === '/api/v1/inbound' && req.method === 'POST') {
          if (!authorized(req, url, config)) return deny(res);
          await handleInbound(req, res, options);
          return;
        }
        if (path === '/api/v1/outbound' && req.method === 'GET') {
          if (!authorized(req, url, config)) return deny(res);
          await handleOutbound(req, res, options);
          return;
        }
        if (path === '/api/v1/stream' && req.method === 'GET') {
          // 浏览器 EventSource 带不了 header ⇒ 这里也认 ?token=
          if (!authorized(req, url, config)) return deny(res);
          await handleStream(req, res, options);
          return;
        }
        if (path === '/api/v1/capabilities') {
          if (!authorized(req, url, config)) return deny(res);
          if (req.method === 'POST') {
            await handleCapabilitiesPost(req, res, options);
            return;
          }
          if (req.method === 'GET') {
            const platform = url.searchParams.get('platform') ?? undefined;
            sendJson(res, 200, { ok: true, capabilities: channel.capabilitiesOf(platform) });
            return;
          }
        }
        if (path === '/api/v1/inline-image' && req.method === 'POST') {
          if (!authorized(req, url, config)) return deny(res);
          await handleInlineImage(req, res, options);
          return;
        }
        if (req.method === 'GET' && path === '/api/v1') {
          // 一份"这个端口是干什么的"的自述（人直接用 curl 看，不用翻文档）
          sendJson(res, 200, {
            ok: true,
            service: 'lord-of-mysteries bridge-api（无适配器 / 纯 API 版）',
            endpoints: [
              'POST /api/v1/inbound          上游送一条玩家消息进来（?sync=true 同步回执；&format=text 回执用纯文本）',
              'GET  /api/v1/outbound?cursor=&wait=&platform=   取回执（长轮询）',
              'GET  /api/v1/stream?cursor=&platform=           取回执（SSE 实时）',
              'POST /api/v1/capabilities     声明这条通道能做什么',
              'POST /api/v1/inline-image      上游回传「这张图换回来的公网 URL」（反向的那一条）',
              'GET  /api/v1/capabilities     看当前生效的能力',
              'GET  /api/v1/health           健康与队列状态',
              'GET  /admin                   运营后台',
            ],
          });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' } satisfies ErrorResponse);
      } catch (error) {
        logger.error('请求处理失败', { url: rawUrl, error: (error as Error).message });
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
        else res.end();
      }
    })();
  });
}

/* ------------------------------------------------------------------ *
 * /api/v1 的三个处理器
 * ------------------------------------------------------------------ */

async function handleInbound(
  req: IncomingMessage,
  res: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  const { channel, logger } = options;
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw === '' ? null : JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' } satisfies ErrorResponse);
    return;
  }
  const parsed = inboundSchema.safeParse(body);
  if (!parsed.success) {
    /*
     * 400 里带上**具体哪个字段**不对。
     * 少了这一句，上游看到的就是一个光秃秃的 400 —— 而字段名拼错（userid / userId）
     * 恰恰是这一层最常见的错误，也是最不容易自己看出来的那种。
     */
    sendJson(res, 400, {
      ok: false,
      error: '入参不合法',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    } satisfies ErrorResponse);
    return;
  }
  const data = parsed.data;
  /*
   * `format=text`：**同步模式下回执用纯文本返回**（每条之间空一行）。
   *
   * 给谁用：像易语言这种解析 JSON 要多引一个模块的客户端 —— 它在同步模式下
   * 只需要把响应体原样发给群，一行代码。JSON 那条路仍然在（默认就是它）。
   */
  const wantsText = new URL(req.url ?? '/', 'http://localhost').searchParams.get('format') === 'text';
  const now = Date.now();
  const message: InternalMessage = {
    // 幂等键：上游给了就用它的（重发时两次认成一次），没给就派生一个稳定的
    messageId:
      data.messageId ?? `bridge:${data.platform}:${data.sceneId}:${data.userId}:${data.timestamp ?? now}`,
    platform: 'bridge',
    scene: data.scene,
    sceneId: data.sceneId,
    userId: data.userId,
    nickname: data.nickname ?? data.userId,
    rawText: data.text,
    timestamp: data.timestamp ?? now,
  };
  const replies = await channel.deliver(message, data.platform);
  const lastSeq = replies.length > 0 ? replies[replies.length - 1]!.seq : undefined;
  if (data.sync === true) {
    if (wantsText) {
      const text = replies
        .map((item) => item.text)
        .filter((t) => t !== '')
        .join('\n\n');
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      accepted: channel.ready,
      replies,
      ...(lastSeq !== undefined ? { cursor: lastSeq } : {}),
    });
    return;
  }
  // 不同步也要说清楚"处理了没有"——上游据此决定要不要重发
  logger.info('上游消息已受理', {
    platform: data.platform,
    scene: data.scene,
    userId: data.userId,
    chars: data.text.length,
    replies: replies.length,
  });
  sendJson(res, 200, { ok: true, accepted: channel.ready });
}

async function handleOutbound(
  req: IncomingMessage,
  res: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  const { outbox, channel, config } = options;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const platform = url.searchParams.get('platform') ?? undefined;
  if (platform !== undefined) channel.touch(platform);
  const cursor = toInt(url.searchParams.get('cursor'), 0);
  const limit = toInt(url.searchParams.get('limit'), 20);
  // wait 的单位是**秒**（易语言、curl 手敲都方便）
  const waitSec = Math.min(toInt(url.searchParams.get('wait'), 0), Math.ceil(config.longPollMaxMs / 1000));
  const selector = { cursor, limit, ...(platform !== undefined ? { platform } : {}) };
  let batch = outbox.take(selector);
  if (batch.items.length === 0 && waitSec > 0) {
    /*
     * ⚠️ 顺序不能反：**先 take 再 wait**。
     * take 是同步的，两者之间没有 await，所以不存在"刚取完、还没挂上就来了新数据"
     * 那个丢唤醒的窗口（写反了会表现为"偶尔卡满一个 wait 周期"，而且只在负载高时出现）。
     */
    await outbox.wait(waitSec * 1000, { unref: true });
    batch = outbox.take(selector);
  }
  channel.noteTaken(platform, batch.items.length);
  sendJson(res, 200, batch);
}

async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  const { outbox, channel } = options;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const platform = url.searchParams.get('platform') ?? undefined;
  if (platform !== undefined) channel.touch(platform);
  let cursor = toInt(url.searchParams.get('cursor'), 0);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx 一类的缓冲会把 SSE 攒成一大块 —— 这一行让它别攒
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  while (!closed) {
    const batch = outbox.take({ cursor, limit: 50, ...(platform !== undefined ? { platform } : {}) });
    if (batch.items.length > 0) {
      for (const item of batch.items) {
        if (closed) break;
        res.write(`data: ${JSON.stringify(item)}\n\n`);
      }
      channel.noteTaken(platform, batch.items.length);
      cursor = batch.cursor;
      continue;
    }
    res.write(': ping\n\n');
    await outbox.wait(SSE_PING_MS, { unref: true });
  }
  res.end();
}

async function handleCapabilitiesPost(
  req: IncomingMessage,
  res: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw === '' ? null : JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' } satisfies ErrorResponse);
    return;
  }
  const parsed = capabilitiesSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, {
      ok: false,
      error: '入参不合法',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    } satisfies ErrorResponse);
    return;
  }
  const data = parsed.data;
  const next = options.channel.setCapabilities(data.platform, {
    ...(data.buttons !== undefined ? { buttons: data.buttons } : {}),
    ...(data.images !== undefined ? { images: data.images } : {}),
    ...(data.inlineImages !== undefined ? { inlineImages: data.inlineImages } : {}),
    ...(data.inlineUpload !== undefined ? { inlineUpload: data.inlineUpload } : {}),
    ...(data.richText !== undefined ? { richText: data.richText } : {}),
    ...(data.avatarTemplate !== undefined ? { avatarTemplate: data.avatarTemplate } : {}),
  });
  options.logger.info('上游声明了通道能力', { platform: data.platform, capabilities: next });
  sendJson(res, 200, { ok: true, capabilities: next });
}

/**
 * `POST /api/v1/inline-image`：上游回传「这张图换回来的公网 URL」。
 *
 * 号对不上（超时了、或者是别的上游发的）→ 404，但**那不是错误**：
 * 服务端早就回落成「图单独发一条」了，这一条只是没人等的回执。
 */
async function handleInlineImage(
  req: IncomingMessage,
  res: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw === '' ? null : JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' } satisfies ErrorResponse);
    return;
  }
  const parsed = inlineImageSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, {
      ok: false,
      error: '入参不合法',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    } satisfies ErrorResponse);
    return;
  }
  const data = parsed.data;
  const taken = options.channel.resolveInlineUpload(data.requestId, data.url);
  if (data.url === undefined || data.url === '') {
    options.logger.warn('上游说这张图换不到 URL，回落成图单独发', {
      platform: data.platform,
      requestId: data.requestId,
      error: data.error ?? '',
    });
  } else {
    options.logger.info('上游回传了图片 URL', { platform: data.platform, requestId: data.requestId });
  }
  if (!taken) {
    sendJson(res, 404, { ok: false, error: '这个 requestId 没人等了（多半已超时）' } satisfies ErrorResponse);
    return;
  }
  sendJson(res, 200, { ok: true });
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function buildAdminContext(options: BridgeServerOptions): AdminContext {
  const { app, channel, config } = options;
  return {
    envPath: ADMIN_ENV_PATH(process.cwd()),
    log: (message, meta) => options.logger.info(message, meta),
    startedAt: new Date().toISOString(),
    root: process.cwd(),
    db: app.db,
    /*
     * 适配器相关的三个字段（adapter / onebot / channelControl）**故意不传** ——
     * 这一版没有适配器。后台里那几屏会显示"没有"，那是事实，比摆一堆点了没反应的按钮好。
     */
    commandNames: () => app.router.commands,
    health: () => healthSnapshot(app),
    backupDir: app.config.backupDir ?? join(dirname(app.config.dbPath), 'backups'),
    access: {
      lanIps: lanAddresses(),
      // 这一版监听的是 BRIDGE_HOST / BRIDGE_PORT（不是现有版本的 HOST / PORT）
      listening: { host: config.host, port: config.port },
    },
    reloadContent: () => app.reloadContent(),
    // 「网关连上了吗」= 最近有没有上游在动（见 channel.isAnyUpstreamAlive）
    gatewayReady: () => channel.isAnyUpstreamAlive(),
  };
}

/** 与现有版本 /health 同一份口径（后台总览复用它，不另算一份） */
function healthSnapshot(app: App): HealthSnapshot {
  const backups = listBackups(app.config.backupDir ?? join(dirname(app.config.dbPath), 'backups'));
  return {
    commands: app.router.commands,
    characters: new CharacterRepo(app.db).count(),
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
    backup: backups[0] ? { file: backups[0].file, bytes: backups[0].bytes, count: backups.length } : null,
    audit: archiveStats(app.db),
    timeTravelDays: app.config.timeTravelDays ?? 0,
    dbPath: app.config.dbPath,
    // 这一版没有 QQ 官方网关、也没有 OneBot 连接：null 是事实（面板会显示"无此通道"）
    qq: null,
    onebot: null,
  };
}

function bridgeStatus(options: BridgeServerOptions): Record<string, unknown> {
  const { channel, outbox, config } = options;
  const now = Date.now();
  return {
    database: config.dbPath,
    imageMode: config.imageMode,
    outbox: outbox.stats,
    upstreams: channel.upstreams().map((u) => ({
      platform: u.platform,
      /** 距上次动静多少毫秒 —— 比一个布尔值有用得多（能看出"断了一分钟"还是"断了六小时"） */
      idleMs: now - u.lastSeenAt,
      inbound: u.inbound,
      taken: u.taken,
      capabilities: u.capabilities,
    })),
  };
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}

function toInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error('body 太大');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 口令不对/不该来的，一律 401（不回显配置里有没有口令 —— 那本身就是情报） */
function deny(res: ServerResponse): void {
  sendJson(res, 401, { ok: false, error: 'unauthorized' } satisfies ErrorResponse);
}

/**
 * 鉴权：`Authorization: Bearer <BRIDGE_TOKEN>`，或 `?token=`（浏览器 EventSource 用得上）。
 *
 * **没设口令时只服务本机**（回环地址）—— 这一条是默认值里最重要的一个：
 * 一个能改玩家存档的接口，不能因为"忘了配置"就对整个内网敞开。
 */
function authorized(req: IncomingMessage, url: URL, config: BridgeConfig): boolean {
  const remote = req.socket.remoteAddress ?? '';
  const loopback =
    remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote.startsWith('127.');
  if (config.token === undefined) return loopback;
  const header = req.headers.authorization ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const fromQuery = url.searchParams.get('token') ?? '';
  const provided = bearer !== '' ? bearer : fromQuery;
  if (provided.length !== config.token.length) return false;
  // 定时安全比较：长度已经比过了，这里逐字节比
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(config.token, 'utf8'));
}

export { MAX_BODY };
