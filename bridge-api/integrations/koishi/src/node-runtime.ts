/**
 * Node 运行时：不够新就自己装一个。
 *
 * ## 为什么非做不可
 *
 * 内核用了 **`node:sqlite`** —— 那是 Node **22.5+** 才有的内置模块。
 * 而 **Koishi 桌面版自带 Node 20**（`koishi.exe` 就是改名的 node，实测 20.12.2），
 * 插件进程活在它里面。
 *
 * 编译成 JS 只能去掉「要类型剥离」这一条要求，`node:sqlite` 这一条去不掉。
 * 所以：**不自己解决 Node，每一个装这个插件的人都会卡住**。
 *
 * 做法和 BEE 版逐条对齐（那边已经真机验证过）：
 *
 *   ① 配置里指定的 → ② 插件自己装过的 → ③ 系统里够新的 → ④ 下载便携版
 *
 * 第 ④ 步下的是 Node 官方的 **Windows x64 便携版压缩包**（约 34 MB），
 * 解压到插件数据目录里 —— **不装进系统、不要管理员权限、不用了删掉即可**，
 * 也不会和用户自己装的 Node 打架。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** 内核需要的最低 Node：`node:sqlite` 从 22.5 开始有 */
const MIN_MAJOR = 22;
const MIN_MINOR = 5;

/** 默认下载地址：官方便携版（x64，Koishi 桌面版都是 x64） */
const DEFAULT_DOWNLOAD = 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip';

export interface NodeLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface NodeOptions {
  /** 插件数据目录（自己装的 node 放这儿） */
  dataDir: string;
  /** 配置里指定的 node 路径 */
  explicit: string;
  logger: NodeLogger;
  /** 找不到时要不要自己下载（默认要） */
  autoInstall?: boolean;
  /** 换个下载地址（内网镜像） */
  downloadUrl?: string;
}

/** 这个 node 的版本够不够跑内核 */
function versionOk(exe: string): boolean {
  try {
    const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 8000 }).trim();
    const parts = out.replace(/^v/, '').split('.');
    const major = Number.parseInt(parts[0] ?? '0', 10);
    const minor = Number.parseInt(parts[1] ?? '0', 10);
    return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
  } catch {
    return false;
  }
}

/** 系统里可能放着 node 的地方 */
function systemCandidates(): string[] {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const trimmed = dir.trim();
    if (trimmed !== '') out.push(join(trimmed, exe));
  }
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? '';
    out.push(join(pf, 'nodejs', exe));
    out.push(join(pf86, 'nodejs', exe));
    if (local !== '') out.push(join(local, 'Programs', 'nodejs', exe));
  }
  return out;
}

/** 用 PowerShell 解压（Windows 自带，不用额外依赖） */
function unzip(zip: string, into: string, logger: NodeLogger): boolean {
  try {
    mkdirSync(into, { recursive: true });
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}' -Force`,
    ], { encoding: 'utf8', timeout: 300000, windowsHide: true });
    return true;
  } catch (error) {
    logger.error('解压失败', { error: (error as Error).message.slice(0, 200) });
    return false;
  }
}

/** 下载一个文件 */
async function download(url: string, to: string, logger: NodeLogger): Promise<boolean> {
  try {
    logger.info('正在下载 Node 便携版（约 34 MB，只需一次）…', { url });
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      logger.error('下载失败', { status: response.status });
      return false;
    }
    await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(to));
    const size = statSync(to).size;
    if (size < 1024 * 1024) {
      logger.error('下载下来的文件太小，多半不是压缩包', { size });
      return false;
    }
    logger.info('下载完成', { mb: Math.round(size / 1024 / 1024) });
    return true;
  } catch (error) {
    logger.error('下载出错', { error: (error as Error).message.slice(0, 200) });
    return false;
  }
}

/**
 * 拿到一个能跑内核的 node。
 *
 * 找不到又装不上就返回 undefined —— 调用方会打日志并放弃这次启动。
 */
export async function ensureNode(options: NodeOptions): Promise<string | undefined> {
  const { dataDir, explicit, logger } = options;

  // ① 配置里指定的
  if (explicit !== '') {
    if (versionOk(explicit)) return explicit;
    logger.warn('配置里的 node 版本不够（需要 22.5+），忽略它', { node: explicit });
  }

  // ② 插件自己装过的
  const managed = join(dataDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  if (existsSync(managed) && versionOk(managed)) {
    logger.info('用插件自己装的 Node', { node: managed });
    return managed;
  }

  // ③ 系统里够新的
  for (const candidate of systemCandidates()) {
    if (existsSync(candidate) && versionOk(candidate)) {
      logger.info('用系统里已有的 Node', { node: candidate });
      return candidate;
    }
  }

  if (options.autoInstall === false) {
    logger.error('本机没有 22.5+ 的 Node，而 autoInstall 关着');
    return undefined;
  }

  // ④ 自己装一个
  logger.info('本机没有够新的 Node，开始自己装一个（不装进系统，只放在插件目录里）');
  mkdirSync(dataDir, { recursive: true });
  const zipPath = join(dataDir, 'node-download.zip');
  const url = options.downloadUrl !== undefined && options.downloadUrl !== '' ? options.downloadUrl : DEFAULT_DOWNLOAD;
  rmSync(zipPath, { force: true });
  if (!(await download(url, zipPath, logger))) return undefined;

  const unpacked = join(dataDir, 'node-unpack');
  rmSync(unpacked, { recursive: true, force: true });
  if (!unzip(zipPath, unpacked, logger)) return undefined;

  // 压缩包里是 node-v22.x.x-win-x64/node.exe，这里把它挑出来
  const inner = join(unpacked, `node-v22.23.2-win-x64`);
  const from = join(inner, process.platform === 'win32' ? 'node.exe' : 'node');
  if (!existsSync(from)) {
    logger.error('解压出来的结构不对，找不到 node.exe', { unpacked });
    return undefined;
  }
  mkdirSync(join(dataDir, 'node'), { recursive: true });
  copyFileSync(from, managed);
  rmSync(unpacked, { recursive: true, force: true });
  rmSync(zipPath, { force: true });

  if (!versionOk(managed)) {
    logger.error('装出来的 node 跑不起来', { node: managed });
    return undefined;
  }
  logger.info('Node 装好了（以后不用再下）', { node: managed });
  return managed;
}
