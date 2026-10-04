/**
 * HTML → PNG（M2.54）：项目的**唯一**出图通道。
 *
 * ## 为什么抽出来
 *
 * 原来这套逻辑写死在 card/render.ts 里，尺寸也是常量（620×1000）。
 * 世界地图要出的是另一种尺寸、另一份 HTML，但**下面这些坑一个都不会少**：
 * Edge 的位置、profile 不能删、stderr 全是噪音、Chromium 会在 PNG 落盘前退出……
 * 复制一份等于把这些坑再踩一遍。所以抽成这里，两边共用。
 *
 * ## 为什么是 Edge（与 M2.48 同一条理由）
 *
 * 本机是 Windows，**Edge 是系统自带的**，不用引任何原生依赖。
 * 无头模式 + `--screenshot` 就能把 HTML 出成 PNG，拿到的却是完整 Chromium：
 * blur / z-index / mix-blend-mode / feTurbulence / radial-gradient 全都能用。
 * 运行时的 npm 依赖依然只有 yaml + zod。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Edge 的位置。**先查固定路径再退回 PATH**：
 * 固定路径命中时省掉一次进程启动，出图是玩家等着的操作，能省一点是一点。
 */
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

let cachedEdge: string | undefined;

export function findEdge(): string {
  if (cachedEdge !== undefined) return cachedEdge;
  for (const candidate of EDGE_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedEdge = candidate;
      return candidate;
    }
  }
  throw new Error(
    '找不到 msedge.exe。本项目用 Edge 无头模式出图（见 src/render/browser.ts 顶部注释）。\n' +
    ' Windows 自带 Edge；如果被卸载了，装回 Edge 或改 EDGE_CANDIDATES。',
  );
}

/**
 * Chromium 的 profile 目录，**每个进程一个**。
 *
 * ⚠️ 这里原来是全机器共用一个（不带 PID），假设是「同一进程内两次渲染不可能重叠」
 * （本函数全同步，`execFileSync` 阻塞事件循环）—— 那个假设**只对单进程成立**。
 *
 * `node --test` 会**并行跑多个测试文件，每个文件是独立进程**，它们于是同时抢同一个
 * profile：后起的 Chromium 连不上、卡住不退出，实测把 card-command 那条端到端用例
 * 拖成 28.5 秒后失败（生产是单进程，所以一直没暴露）。
 *
 * 加上 PID 之后每个进程各用各的，生产仍然只有一个（一个进程一个目录）。
 *
 * 为什么不能每次建一个再删：profile 里的 crashpad 子进程会短暂攥着句柄，
 * Windows 上 `rmSync` 直接抛 EPERM（实测在 card-avatar.test.ts 挂掉两条用例）；
 * 而且每渲染一次就漏一个几十 MB 的 Chromium profile 进 %TEMP%。
 * 所以：**profile 常驻不删，一次性的临时目录只放 html 和 png** —— 那两个没锁。
 */
const PROFILE_DIR = join(tmpdir(), 'dsh-card-chrome-profile-' + process.pid);

export interface RenderOptions {
  /** 设计网格宽（px）。出图尺寸 = width × scale */
  width: number;
  /** 设计网格高（px） */
  height: number;
  /** 设备像素比，默认 2 */
  scale?: number;
  /** 临时文件前缀，只影响 %TEMP% 里的名字，便于排查时认出是谁出的图 */
  tag?: string;
}

/**
 * 把一段完整的 HTML 渲染成 PNG 字节。
 *
 * 用 execFileSync 而不是异步：调用方都在 QQ 回复链路上，本来就一路 await 到底，
 * 多包一层 Promise 只是把同一个等待换个写法。
 */

/**
 * **异步出图**（M2.86）：与同步版同一个 Edge 调用，但**不阻塞事件循环**。
 *
 * ## 为什么必须加这一版
 *
 * 同步版用 `execFileSync` —— 注释里自己写着「阻塞事件循环」。那意味着
 * **一条消息要出图，整个 Node 进程就停住一到两秒，所有玩家的指令一起等**。
 * 用户实机感受就是「绘制图片的速度太慢」。
 *
 * 异步版用 `execFile` + Promise：这一个等待不再挡住别人。
 * 同步版保留（卡片那条路已经调通、且它的调用方本来就等在回复链路上），
 * 新代码一律用异步版。
 */
export function renderHtmlToPngAsync(html: string, options: RenderOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const edge = findEdge();
    const scale = options.scale ?? 2;
    const tag = options.tag ?? 'shot';
    const dir = mkdtempSync(join(tmpdir(), tag + '-'));
    const htmlPath = join(dir, tag + '.html');
    const outPath = join(dir, tag + '.png');
    writeFileSync(htmlPath, html, 'utf8');
    mkdirSync(PROFILE_DIR, { recursive: true });
    const child = spawn(
      edge,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--force-device-scale-factor=' + scale,
        '--window-size=' + options.width + ',' + options.height,
        '--user-data-dir=' + PROFILE_DIR,
        '--screenshot=' + outPath,
        pathToFileURL(htmlPath).href,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60_000 },
    );
    /*
     * Chromium 偶尔在 PNG 落盘前就退出（截图写在 IO 线程上），所以**不信任退出码**，
     * 一律轮询文件：正常情况第一次就命中，异常情况最多等 1.5 秒。
     * 轮询用 setTimeout（异步），不阻塞事件循环 —— 这正是这一版存在的理由。
     */
    let tries = 0;
    const poll = (): void => {
      if (existsSync(outPath)) {
        try {
          resolve(readFileSync(outPath));
        } catch (readError) {
          reject(readError as Error);
        }
        return;
      }
      tries += 1;
      if (tries >= 30) { reject(new Error('Edge 没有产出 PNG')); return; }
      setTimeout(poll, 50);
    };
    child.on('error', (error: Error) => reject(error));
    child.on('close', () => { poll(); });
  });
}

/**
 * 量一次页面的**真实内容高度**（`documentElement.scrollHeight`）。
 *
 * ## 为什么非得单独量一次
 *
 * Edge 的 `--screenshot` **只按 `--window-size` 截图** —— 页面比窗口高，多出来的部分
 * 直接被裁掉，不报错、也不留痕。本机实测（2026-10-04）：内容 1560px、窗口 1000px，
 * 产物就是一张 720×1000 的裁切图。
 *
 * 而各张图的行数是**活的**（菜单第 6 张、帮助页、掉落列表…），写死高度就一定截断 ——
 * 用户报的「菜单 6 被硬编码截断」就是这么来的。
 *
 * 所以先跑一趟 `--dump-dom`：HTML 里塞一段探针脚本，把 scrollHeight 写进 `<title>`，
 * 这里再读回来。**同一台 Edge、同一份 HTML**，量出来的就是下一趟截图该用的高度。
 *
 * `--virtual-time-budget` 是必需的：不给它，Chromium 偶尔在脚本跑之前就把 DOM 倒出来，
 * 读到的是初始值 0（实测过）。
 *
 * @returns 量到的高度（CSS 像素）；**量不到返回 0** —— 调用方退回写死的高度，
 *          绝不因为「量高度失败」让整张图出不来。
 */
export function measureHtmlHeight(html: string, width: number): number {
  const edge = findEdge();
  const dir = mkdtempSync(join(tmpdir(), 'measure-'));
  const htmlPath = join(dir, 'measure.html');
  try {
    writeFileSync(htmlPath, withHeightProbe(html), 'utf8');
    mkdirSync(PROFILE_DIR, { recursive: true });
    const out = execFileSync(
      edge,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--window-size=' + width + ',1000',
        '--user-data-dir=' + PROFILE_DIR,
        '--virtual-time-budget=3000',
        '--dump-dom',
        pathToFileURL(htmlPath).href,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 },
    );
    const hit = /<title>(\d+)<\/title>/.exec(out);
    if (hit === null || hit[1] === undefined) return 0;
    const height = Number.parseInt(hit[1], 10);
    return Number.isFinite(height) && height > 0 ? height : 0;
  } catch {
    return 0;
  } finally {
    // 清临时目录是尽力而为：删不掉也绝不能拖着出图失败
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/** 把「把 scrollHeight 写进 <title>」的探针脚本塞进 HTML（截图那份不需要它） */
function withHeightProbe(html: string): string {
  const probe =
    '<script>window.addEventListener("load",function(){' +
    'document.title=String(Math.ceil(document.documentElement.scrollHeight));});</script>';
  return html.includes('</body>') ? html.replace('</body>', probe + '</body>') : html + probe;
}

export function renderHtmlToPng(html: string, options: RenderOptions): Buffer {
  const edge = findEdge();
  const scale = options.scale ?? 2;
  const tag = options.tag ?? 'shot';
  const dir = mkdtempSync(join(tmpdir(), tag + '-'));
  const htmlPath = join(dir, tag + '.html');
  const outPath = join(dir, tag + '.png');
  try {
    writeFileSync(htmlPath, html, 'utf8');
    mkdirSync(PROFILE_DIR, { recursive: true });
    execFileSync(
      edge,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--force-device-scale-factor=' + scale,
        '--window-size=' + options.width + ',' + options.height,
        '--user-data-dir=' + PROFILE_DIR,
        '--screenshot=' + outPath,
        pathToFileURL(htmlPath).href,
      ],
      {
        // Edge 往 stderr 写一堆无关噪音（"QQBrowser user data path not found" 之类），全部吞掉
        stdio: ['ignore', 'ignore', 'ignore'],
        /*
         * ⚠️ **超时是必须的，不是保险。**
         *
         * 这个调用是同步的（execFileSync 阻塞事件循环），所以 Edge 一旦挂起 ——
         * 组策略拦了 headless、profile 被另一个实例锁住、显卡驱动崩了 ——
         * 它会**永远等下去**，而整个 Node 进程（连同所有玩家的指令）就此停摆。
         * 症状是「机器人突然不理人」，日志最后一条停在出图那一刻，
         * 而 /health 还是 200（HTTP 线程根本没轮到）—— 极难查。
         *
         * 超时之后 execFileSync 抛错，被调用方的 try/catch 接住，回执退回文字。
         * 玩家看到的只是「这次没图」，而不是机器人死了。
         */
        /*
         * 上限的取值：生产是单进程同步出图，正常 1—2 秒，所以这不是性能参数，
         * 是**「卡住了最多等多久」**。
         *
         * 一开始写 20 秒，结果 test/card-command 那条端到端用例在满负载（node --test
         * 并行跑各测试文件）下需要更久，被误杀成失败 —— 超时太紧会把「慢」判成「坏」。
         * 放宽到 60 秒：正常路径一点不变，真卡住时也总有个头。
         */
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
    );
    /*
     * Chromium 偶尔在 PNG 落盘前就退出（截图是在 IO 线程上写的）。
     * 轮询而不是 sleep 一个固定值：正常情况第一次就命中，异常情况最多等 1.5 秒。
     */
    for (let i = 0; i < 30; i += 1) {
      if (existsSync(outPath)) {
        const png = readFileSync(outPath);
        if (png.length > 0) return png;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    throw new Error('Edge 没有产出 PNG（' + outPath + '）。检查 --headless=new 是否被策略禁用。');
  } finally {
    /*
     * 清临时目录是**尽力而为**：里面只剩 html / png，正常都删得掉；
     * 万一被谁占着，也绝不能因为「删不掉垃圾」让整次出图失败。
     */
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略：清理失败不影响出图 */
    }
  }
}
