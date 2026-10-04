/**
 * 压测环境（W6）：真实进程 + 真实 HTTP。
 *
 * 刻意不用 in-process 的 createApp：
 *   - 启动独立的 node 进程跑 src/main.ts（含迁移、内容播种、启动自检、备份）
 *   - 上报走 HTTP，出站消息打到假 OneBot API
 *   - 库断言直接打开同一个 SQLite 文件（WAL 模式支持并发读）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFreePort } from './ports.ts';
import { startFakeOneBotApi, type FakeOneBot } from './client.ts';

export interface TestServerOptions {
  /** 数据库文件路径（默认在 data/loadtest-<时间戳>.db） */
  dbPath?: string;
  /** 是否在启动时补跑每日结算 */
  runTickOnStart?: boolean;
  /** 是否开启运维服务（备份等） */
  startOps?: boolean;
  accessToken?: string;
  /** 演练用时间偏移（天）：只改服务端时钟 */
  timeTravelDays?: number;
  /** 是否允许测试固定服务端时钟（W7 虚拟玩家用） */
  allowClockControl?: boolean;
  /** W7：id 确定性派生，让「同一 seed 输出一致」真正成立 */
  deterministicIds?: boolean;
  /**
   * M2.4：世界种子（雾日 / 天气 / 世界事件的确定性来源）。
   * 不传时沿用环境变量 WORLD_SEED（服务端默认 'world'）——
   * 显式传是为了让「4 个分片拿同一个世界 seed」这件事**可断言**，而不是靠继承 shell 环境。
   */
  worldSeed?: string;
}

export interface TestServer {
  appPort: number;
  apiPort: number;
  dbPath: string;
  /** 上报与 /admin/tick 共用的令牌 */
  token: string;
  onebot: FakeOneBot;
  child: ChildProcess;
  logs: string[];
  /** 只读打开同一个库做断言 */
  openDb(): import('node:sqlite').DatabaseSync;
  stop(): Promise<void>;
  /** 进程是否还活着 */
  alive(): boolean;
}

async function waitForHealth(port: number, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${lastError}`);
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const appPort = await getFreePort();
  const onebot = await startFakeOneBotApi();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dbPath = options.dbPath ?? join(process.cwd(), 'data', `loadtest-${stamp}.db`);
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  const backupDir = join(process.cwd(), 'data', `loadtest-backups-${stamp}`);

  const logs: string[] = [];
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      DB_PATH: dbPath,
      ONEBOT_API_BASE: `http://127.0.0.1:${onebot.port}`,
      BACKUP_DIR: backupDir,
      RUN_TICK_ON_START: options.runTickOnStart === false ? '0' : '1',
      ONEBOT_TOKEN: options.accessToken ?? 'loadtest-token',
      ...(options.timeTravelDays ? { TIME_TRAVEL_DAYS: String(options.timeTravelDays) } : {}),
      ...(options.allowClockControl ? { ALLOW_CLOCK_CONTROL: '1' } : {}),
      ...(options.deterministicIds ? { DETERMINISTIC_IDS: '1' } : {}),
      // M2.4：世界 seed 全局一个 —— 分片跑时 4 片必须拿到同一个值
      ...(options.worldSeed ? { WORLD_SEED: options.worldSeed } : {}),
      // 压测 / 实例测试不需要备份、归档与定时结算：一并关掉（START_OPS=0）
      ...(options.startOps === false ? { START_OPS: '0', BACKUP_RETAIN_DAYS: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));

  try {
    await waitForHealth(appPort);
  } catch (error) {
    child.kill();
    await onebot.close();
    throw error;
  }

  const { DatabaseSync } = await import('node:sqlite');

  return {
    appPort,
    apiPort: onebot.port,
    dbPath,
    token: options.accessToken ?? 'loadtest-token',
    onebot,
    child,
    logs,
    openDb: () => new DatabaseSync(dbPath),
    alive: () => child.exitCode === null && !child.killed,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await onebot.close();
      if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
    },
  };
}

/** 清理压测产生的库文件 */
export function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
}
