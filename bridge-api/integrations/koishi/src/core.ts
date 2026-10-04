/**
 * 随身内核：把游戏核心一起打进插件，**装完就能用**。
 *
 * ## 为什么是子进程，而不是 import
 *
 * 内核（\`src/\` + \`bridge-api/src/\`）里带着平台适配器
 *（QQ 官方网关、OneBot、频道）—— 那是给"自己就是通道"的那种部署用的。
 * 这一版的口径是**无适配器**：插件是唯一的上游，内核只负责判定。
 *
 * 所以内核必须跑在**独立进程**里：
 *
 *   · 模块图隔离 —— 本插件进程里永远不会加载到 \`src/adapter/*\`，
 *     \`bridge-api/test/no-platform-adapter.test.ts\` 那条运行时守卫才有意义；
 *   · 崩了不带走 Koishi —— 内核是"游戏引擎"，不该和机器人框架同生共死。
 *
 * ## 内核从哪来
 *
 * 优先**复用已经在跑的那个**（比如你另外开了 bridge-api，或者 BEE 那边跑着），
 * 找不到才自己拉一个。这条顺序很重要：同一个端口上跑两份内核，
 * 它们会各自持有一个 SQLite 句柄，**世界会被写坏**。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { ensureNode } from './node-runtime.js';
import { delimiter, join } from 'node:path';

/* 内核入口与「跑在哪」那两件事在 core-root.ts —— 拆出去是为了能直接测（见那个文件头） */
import { CORE_ENTRIES, prepareCoreRunRoot } from './core-root.js';

/** 入口是 .ts 时才需要「类型剥离」那个能力（22.18+）；.js 不需要 */
const MIN_NODE = [22, 18] as const;

export interface Logger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface CoreOptions {
  /** 内核监听端口。**与 BEE 那边分开** —— 两边各跑各的，互不打扰 */
  port: number;
  /** 存档目录（data/）。自己装的 node 也放这儿 */
  dataDir: string;
  /** 口令，空表示不校验（只服务本机请求） */
  token: string;
  logger: Logger;
  /** 用哪个 node 跑内核（留空 = 自动找一个够新的） */
  nodePath?: string;
  /** 找不到够新的 node 时，要不要自己下载一个便携版（默认要） */
  autoInstallNode?: boolean;
  /** 换个下载地址（内网镜像） */
  nodeDownloadURL?: string;
  /**
   * 外部内核地址。**只有用户显式配了才用它** —— 那表示「我另外跑了一份，你接过去」。
   *
   * ⚠️ 不要拿它去「探测有没有现成的可以蹭」。Koishi 就是 Koishi 的。
   */
  externalBase?: string;
}

export interface CoreHandle {
  /** 真正在用的地址 */
  base: string;
  /** 是我们拉起来的（false = 复用了已有的） */
  started: boolean;
  stop: () => Promise<void>;
}

/** 内核源码的根目录：装成 npm 包时是 \`<pkg>/core\`，开发时是仓库根 */
export function resolveCoreRoot(): string | undefined {
  // 打进 Koishi 的插件是 **CJS**（loader 用 require 加载），所以用 __dirname。
  // 曾经这里写的是 import.meta.url —— 那个在 CJS 里根本不存在，
  // tsc 会报 TS1470，运行时取值也拿不到东西。
  const here = __dirname;
  const candidates = [
    join(here, '..', 'core'),     // 发布形态：dist/core
    join(here, '..', '..'),       // 开发形态：integrations/koishi/src → 仓库根
    join(here, '..', '..', '..'),
  ];
  for (const root of candidates) {
    if (CORE_ENTRIES.some((entry) => existsSync(join(root, ...entry)))) return root;
  }
  return undefined;
}

/** Node 够不够跑 TS 源码 */
export function nodeSupportsTypeScript(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** 探一次 \`/health\`，活着就返回 true */
async function probe(base: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(base.replace(/\/+$/, '') + '/health', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 等到内核就绪（或超时） */
async function waitReady(base: string, timeoutMs: number, logger: Logger): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(base, 1200)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  logger.error('内核没能在期限内就绪', { base, timeoutMs });
  return false;
}

/**
 * 拿到一个可用的内核：先看有没有现成的，没有才自己拉。
 */
export async function ensureCore(options: CoreOptions): Promise<CoreHandle | undefined> {
  const { port, dataDir, token, logger } = options;
  const base = `http://127.0.0.1:${port}`;

  // ① 用户显式配了外部内核 → 用它，我们不拉进程。
  if (options.externalBase !== undefined && options.externalBase !== '') {
    const external = options.externalBase.replace(/\/+$/, '');
    if (await probe(external)) {
      logger.info('接上外部内核', { base: external });
      return { base: external, started: false, stop: async () => {} };
    }
    logger.warn('配的 apiBase 连不上，改为自己拉一个', { base: external });
  }

  // ② 只认**自己这个端口**上有没有上次没退干净的自己。
  //    刻意不去探测别的端口：那是别人的内核，蹭上去只会把两边的数据搅在一起。
  if (await probe(base)) {
    logger.info('这个端口上已经有一个内核，接上它', { base });
    return { base, started: false, stop: async () => {} };
  }

  // ② 没有 → 自己拉
  const root = resolveCoreRoot();
  if (root === undefined) {
    logger.error('包里找不到游戏内核（core/bridge-api/src/main.ts）—— 这个包可能装得不完整');
    return undefined;
  }
  /*
   * 发布形态下把内核铺到数据目录再跑 —— 插件包保持只读。
   * 这一条就是「插件运行时更新不了、得手动停插件」的根治（见 prepareCoreRunRoot）。
   */
  const runRoot = prepareCoreRunRoot(root, dataDir, logger);
  // 先定用哪个入口：优先编译后的 JS（不挑 Node 版本），退回 .ts（开发时）。
  let entry: string | undefined;
  for (const rel of CORE_ENTRIES) {
    const candidate = join(runRoot, ...rel);
    if (existsSync(candidate)) { entry = candidate; break; }
  }
  if (entry === undefined) {
    logger.error('包里找不到内核入口', { root: runRoot });
    return undefined;
  }
  const entryIsTs = entry.endsWith('.ts');
  logger.info(entryIsTs ? '内核入口：TypeScript 源码（开发形态）' : '内核入口：编译后的 JS', { entry });

  // 编译后的 JS 在**任何** Node 上都能跑；只有 .ts 才需要 >= 22.18。
  //
  // ⚠️ **不能用 process.execPath**：Koishi 桌面版自带 Node 20，而插件就跑在
  // 那个 Node 上 —— 实测报的是「Node 20.12.2 跑不了内核」。
  // 所以要另找一个够新的，和 BEE 版同一套做法：先看配置，再看 PATH。
  // Node 必须 >= 22.5：内核用了 node:sqlite，那是 22.5 才有的内置模块。
  // 编译成 JS 只能免掉「类型剥离」，免不掉这一条 —— 所以这里必须真解决。
  const nodePath = await ensureNode({
    dataDir,
    explicit: options.nodePath ?? '',
    logger,
    ...(options.autoInstallNode !== undefined ? { autoInstall: options.autoInstallNode } : {}),
    ...(options.nodeDownloadURL !== undefined ? { downloadUrl: options.nodeDownloadURL } : {}),
  });
  if (nodePath === undefined) {
    logger.error('拿不到能跑内核的 Node（需要 22.5+）。装一个，或在 nodePath 里填路径，或别关 autoInstallNode。');
    return undefined;
  }
  if (nodePath !== process.execPath) {
    logger.info('用这个 Node 跑内核', { node: nodePath });
  }

  // 首次启动：把包里那份「已建好的空世界」铺到位。
  //
  // 不带种子的话，空库要跑一遍 seeding —— 实测 40 多秒，期间收到的消息只能排队。
  // 包里带了一份（scripts/pack-core.mjs 生成），复制过去就省掉那一段。
  const dbPath = join(dataDir, 'bridge.db');
  if (!existsSync(dbPath)) {
    const seed = join(root, 'seed', 'bridge.db');
    if (existsSync(seed)) {
      mkdirSync(dataDir, { recursive: true });
      copyFileSync(seed, dbPath);
      logger.info('首次启动：已铺好种子世界');
    }
  }

  const child: ChildProcess = spawn(
    nodePath,
    [entry],
    {
      // cwd 也指到运行根：内核的相对路径（data/ 之外那些）不再落进插件包
      cwd: runRoot,
      windowsHide: true,
      // stdin 必须是**管道**，不能是 ignore：
      // 内核靠「stdin 读到 EOF」判断拉起它的进程已经没了。
      // 给 ignore 的话它一起就读到 EOF，会立刻自杀。
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT: String(port),
        BRIDGE_DB_PATH: dbPath,
        BRIDGE_TOKEN: token,
        /*
         * ⚠️ **必须传**：内核的运行期数据（卡片、头像、菜单图缓存）默认写在
         * `<cwd>/data` 下，而这里的 cwd 就是**插件安装目录里的 core/**。
         *
         * 那意味着每出一张图都在 node_modules 里写文件，后果有两个：
         *   · 插件一更新，整个包目录被替换，玩家的头像/卡片缓存跟着没；
         *   · 更新那一刻目录里还有文件在写、内核的 cwd 也在里头 ——
         *     现场就是用户报的「**插件不停止，Koishi 的更新就装不上**」，
         *     得先去控制台停掉插件（= 杀掉内核）才装得进。
         *
         * 数据指到存档目录之后，插件包保持只读，两个问题一起消失。
         */
        LOM_DATA_DIR: dataDir,
      },
    },
  );

  // 内核的日志进 Koishi 的日志，但压到 debug —— 它话不少，不该刷屏
  const relay = (chunk: Buffer, level: 'info' | 'error'): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const text = line.trim();
      if (text !== '') logger[level](text.slice(0, 400));
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => relay(chunk, 'info'));
  child.stderr?.on('data', (chunk: Buffer) => relay(chunk, 'error'));
  child.on('exit', (code, signal) => {
    logger.warn('内核进程退出了', { code, signal });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  if (!(await waitReady(base, 180_000, logger))) {
    await stop();
    return undefined;
  }
  logger.info('内核已就绪', { base, root });
  return { base, started: true, stop };
}
