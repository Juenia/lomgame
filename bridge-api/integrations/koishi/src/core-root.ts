/**
 * 内核**跑在哪**这件事，单独放一个文件。
 *
 * 为什么不留在 core.ts 里：那个文件为了编译产物用了 `.js` 后缀的相对导入
 * （`./node-runtime.js`），Node 直接跑 `.ts` 时解析不到 —— 于是它整份都测不了。
 * 而「内核跑在插件包里还是数据目录里」恰恰是必须钉住的一条（见下）。
 * 所以拆出来：零 Koishi 依赖、零 node-runtime 依赖，能在测试里直接跑。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 内核入口，按优先级排。
 *
 * **编译产物优先**（`dist/main.js`）：Node 禁止对 node_modules 下的 .ts 剥离类型。
 * `.ts` 那条只在仓库里开发时命中。
 */
export const CORE_ENTRIES: string[][] = [
  // **编译产物优先**：Node 禁止对 node_modules 下的 .ts 做类型剥离，
  // 所以装成包之后只有 .js 跑得起来（开发时才有 .ts）。
  ['dist', 'bridge-api', 'src', 'main.js'],
  ['bridge-api', 'src', 'main.ts'],
];

/** 只用到 info / warn —— 与 core.ts 的 Logger 结构兼容 */
export interface CoreRootLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * 内核的**运行根**：发布形态下，先把包里那份内核铺到数据目录，再从那里跑。
 *
 * ## 为什么不能在插件包里跑（真机事故，用户反馈过两次）
 *
 * 插件装在 `node_modules/koishi-plugin-lom-bridge` 里，内核就在它的 `core/` 下。
 * 只要内核**正在跑**，那个包目录就被占着 —— npm 替换包目录会失败，用户看到的就是
 * 「**插件运行时更新不了，得先去控制台把插件停掉**」。
 *
 * 停一次能让更新成功一次，但下一次照旧：只要内核还在包里跑，这个坑就一直在。
 * 所以把它**搬出来**：插件包从此只读，更新时不会被任何东西占着。
 *
 * 目录名带插件版本号 —— 插件升级后自动重铺一份，顺带解决
 * 「插件更新了、内核还是旧的」这个次生问题（旧版本目录留在那儿，约 10MB 一份，
 * 想清就删 `data/lom/core-*` 里不在跑的那些）。
 *
 * 铺不动就退回在包里跑：宁可留着老毛病，也不能让游戏起不来。
 */
export function prepareCoreRunRoot(root: string, dataDir: string, logger: CoreRootLogger): string {
  // 开发形态（在仓库里直接跑）：不复制 —— 复制一份出去会让改代码不生效
  const pkgJson = join(root, '..', 'package.json');
  if (!existsSync(pkgJson)) return root;
  let version = 'unknown';
  try {
    const parsed = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version !== '') version = parsed.version;
  } catch {
    // 读不出来照样能跑：下面用 unknown 当目录名
  }
  const runRoot = join(dataDir, 'core-' + version.replace(/[^\w.-]/g, '_'));
  // 这个版本已经铺过：直接用（依据是入口文件在不在）
  if (CORE_ENTRIES.some((rel) => existsSync(join(runRoot, ...rel)))) return runRoot;
  try {
    mkdirSync(dataDir, { recursive: true });
    rmSync(runRoot, { recursive: true, force: true });
    cpSync(root, runRoot, { recursive: true });
    logger.info('内核已铺到数据目录 —— 插件包从此只读，更新时不会再被占用', { runRoot, version });
    return runRoot;
  } catch (error) {
    logger.warn('内核铺到数据目录失败，退回在插件包里跑（更新插件时可能被占用）', {
      error: String(error).slice(0, 200),
    });
    return root;
  }
}