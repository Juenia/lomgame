/**
 * bridge-api 入口 —— 「无适配器 / 纯 API 版」的进程。
 *
 * ## 与现有版本的关系（一句话）
 *
 * **同一个判定内核，换了一条通道。** 业务代码一行没动：
 * `createApp` 是现有版本的应用组装（已抽到 `src/app.ts`，通道无关），
 * 这里只是把 `deps.adapter` 换成 `ApiChannel` —— 于是进程不再连 OneBot、
 * 不再连 QQ 官方网关，而是开一个 HTTP 端口（`/api/v1/*`），
 * 等 BEE / Koishi 这些上游框架把玩家消息送进来、把回执取走。
 *
 * ## 为什么库要分开
 *
 * 默认写 `data/bridge.db`（不是现有版本的 `data/game.db`）。
 * 两个进程同时写同一个 SQLite 文件会锁冲突，而它的表现是"偶尔卡几秒"——
 * 那种故障查起来最费劲。想共用同一个世界时，把 `DB_PATH` 显式指过去即可
 * （但那就**只能跑一个版本**，两个一起跑必然打架）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, loadConfig, type App, type AppConfig } from '../../src/app.ts';
import { bufferedLogger, processLogs } from '../../src/infra/log-buffer.ts';
import type { Logger } from '../../src/infra/logger.ts';
import { ApiChannel } from './channel.ts';
import { describeBridgeConfig, loadBridgeConfig, type BridgeConfig } from './config.ts';
import { Outbox } from './outbox.ts';
import { createBridgeServer } from './server.ts';

export interface BridgeRuntime {
  app: App;
  channel: ApiChannel;
  outbox: Outbox;
  server: ReturnType<typeof createBridgeServer>;
}

/**
 * 组装（不监听端口）—— 测试直接用它起一个临时实例。
 *
 * 分成"组装"与"监听"两半，是为了让测试能 `listen(0)` 拿随机端口，
 * 而不是去抢 3200（那正是"本地测试偶发失败"最常见的来源）。
 */
export function buildBridge(options: {
  bridge: BridgeConfig;
  appConfig: AppConfig;
  logger: Logger;
}): BridgeRuntime {
  const { bridge, appConfig, logger } = options;
  const outbox = new Outbox(bridge.outboxCapacity);
  const channel = new ApiChannel({
    outbox,
    logger,
    capabilities: bridge.capabilities,
    imageMode: bridge.imageMode,
    maxImageBytes: bridge.maxImageBytes,
    upstreamStaleMs: bridge.upstreamStaleMs,
  });
  const app = createApp(appConfig, { adapter: channel, logger });
  const server = createBridgeServer({
    app,
    channel,
    outbox,
    config: bridge,
    logger,
    trustProxy: /^(1|true|yes)$/i.test(process.env['TRUST_PROXY'] ?? ''),
  });
  return { app, channel, outbox, server };
}

/**
 * 读 `.env`：**已有的环境变量优先**，然后 `bridge-api/.env`，最后根 `.env`。
 *
 * 为什么不直接用 `process.loadEnvFile()`：它的覆盖规则（文件值 vs 进程值谁赢）
 * 不值得让部署去猜 —— 这里自己按行读，规则写死成一句"进程里已经有的不动"。
 */
function loadEnvFiles(cwd: string): void {
  for (const file of [join(cwd, 'bridge-api', '.env'), join(cwd, '.env')]) {
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (key === '' || process.env[key] !== undefined) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  loadEnvFiles(cwd);
  const bridge = loadBridgeConfig(process.env);
  /*
   * 库路径：只有**调用方没显式指定**时才替它选 bridge.db。
   * 显式指定（`DB_PATH=...`）就意味着"我知道我在共用/换库"，那不该被这里覆盖。
   */
  if ((process.env['DB_PATH'] ?? '').trim() === '') process.env['DB_PATH'] = bridge.dbPath;
  const appConfig: AppConfig = { ...loadConfig(process.env), port: bridge.port };
  const logger = bufferedLogger(processLogs);
  const runtime = buildBridge({ bridge, appConfig, logger });

  const onListen = (): void => {
    logger.info('bridge-api 已启动（无适配器 / 纯 API 版）', {
      ...describeBridgeConfig(bridge),
      endpoints: {
        inbound: `http://${bridge.host}:${bridge.port}/api/v1/inbound`,
        outbound: `http://${bridge.host}:${bridge.port}/api/v1/outbound`,
        stream: `http://${bridge.host}:${bridge.port}/api/v1/stream`,
        admin: `http://${bridge.host}:${bridge.port}/admin`,
        health: `http://${bridge.host}:${bridge.port}/health`,
      },
      note:
        bridge.token === undefined
          ? '没设 BRIDGE_TOKEN：只接受本机请求。要跨机接入，先设一个口令再改 BRIDGE_HOST。'
          : '口令已启用。',
    });
  };
  if (bridge.host === '') runtime.server.listen(bridge.port, onListen);
  else runtime.server.listen(bridge.port, bridge.host, onListen);

  const shutdown = (signal: string): void => {
    logger.info('收到退出信号，正在关闭', { signal });
    runtime.server.close(() => {
      runtime.app.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  /*
   * 父进程没了就自己退出。
   *
   * ## 为什么要靠 stdin，而不是信号
   *
   * Windows 上没有真正的信号，而拉起内核的那一侧（BEE 的 worker、Koishi 的插件）
   * 是**被强杀**的 —— 它没有机会发任何东西，内核就那么活了下来。
   *
   * 这个孤儿问题真实发生过：BEE 退出半小时后内核还在跑，占着端口、锁着数据库，
   * 而 Koishi 那边「先找后拉」的逻辑又把这份孤儿当成现成的复用了。
   *
   * 管道是可靠的判据：拉起内核的那一侧持着写端句柄，它一死句柄随之关闭，
   * 这边立刻读到 EOF。**任何操作系统上都是这个行为。**
   *
   * 手动跑（终端里 node bridge-api/src/main.ts）时 stdin 是 TTY，不受影响。
   */
  if (process.stdin.isTTY !== true) {
    process.stdin.on('end', () => shutdown('stdin 关闭（拉起它的进程已退出）'));
    process.stdin.on('close', () => shutdown('stdin 关闭（拉起它的进程已退出）'));
    process.stdin.resume();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    console.error('启动失败', error);
    process.exit(1);
  });
}
