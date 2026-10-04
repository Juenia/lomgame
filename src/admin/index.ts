/**
 * 管理后台路由（M2.49）：挂在现有 HTTP 服务上，处理 /admin/*
 *
 * ## 口令从哪来
 *
 * 优先 ADMIN_PASSWORD（.env）。**没有就当场生成一个随机口令打到日志** ——
 * 写一个默认口令（admin/admin）等于没有登录：后台能改玩家数值、能改 AppSecret。
 * 随机口令只在启动日志里出现一次，要进后台的人去翻日志。
 *
 * ## session 为什么改成签名 cookie
 *
 * 一开始是内存里的 token 集合。理由是「重启即失效比较安全」——
 * 但开发期一天要重启四五次，每次改完代码登录态就没了，人得反复重登。
 * 所以改成**无状态签名 cookie**：token = 过期时间戳 + HMAC(口令, 时间戳)。
 * 重启不掉线；口令一改，所有旧 token 的签名对不上，立刻全失效 ——
 * 「改口令踢掉所有人」这条反而比内存方案更可靠。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { envGet, maskSecret, readEnv, writeEnv, envSet } from './env.ts';
import {
  ACCESS_KEYS, checkPasswordStrength, clientIp, createLoginGuard, PASSWORD_MIN,
  readAccess, writeAccessKey, type AccessDeps, type LoginGuard,
} from './access.ts';
import { adminPage } from './page.ts';
import { condOptionsOf, ENTITIES, entityById, entityMeta, groupedEntities, refTargetsOf, type EntitySpec, type FieldSpec } from './schema.ts';
import { createEntity, listEntity, readEntity, writeEntity } from './data.ts';
import {
  gmApplyStats, gmDetail, gmInventory, gmOptions, gmResetDaily, gmSearch,
  gmSetPathway, gmSetPowerRelation, gmSetStatus, gmStats, gmTeleport, type GmResult, type StatKey,
} from './gm.ts';
import type { Db } from '../infra/db/sqlite.ts';
import {
  commandCatalogue, compareAdapter, compareOneBot, labelOf,
  onebotPatchFromForm, patchFromForm,
  type AdapterControl, type OneBotControl,
} from './adapter.ts';
import { FEEDBACK_CATEGORY_LABEL, FEEDBACK_STATUS_LABEL, backupView, feedbackView, opsPayload, overviewPayload, type HealthSnapshot } from './panels.ts';
import { PANELS, groupedPanels } from './nav.ts';
import { searchAudit } from './audit.ts';
import { worldView } from './world.ts';
import { contentView } from './content.ts';
// M2.86：一键修复（只补缺，绝不编内容；幂等 + 备份，见 admin/fix.ts 的文件头）
import { applyEventCardFix, planEventCardFix } from './fix.ts';
import { SIM_LIMITS, SIM_STRATEGY_CHOICES, runSim } from './sim.ts';
import { processLogs } from '../infra/log-buffer.ts';
import { backupDatabase, pruneBackups } from '../infra/backup.ts';
import { FeedbackRepo } from '../infra/db/feedback.ts';
import { dateKey } from '../infra/date.ts';

export interface AdminContext {
  /** .env 的绝对路径 */
  envPath: string;
  /** 日志口 */
  log: (message: string, meta?: Record<string, unknown>) => void;
  /** 进程启动时刻（ISO 串），页面用来显示"启动于" */
  startedAt: string;
  /**
   * 网关是不是真的连上了。
   *
   * 上一版这里写死 false —— 登录窗里"网关：未连接"永远是红的，
   * 而日志里明明写着「QQ 官方通道已就绪」。**状态是假的，这个窗就没有意义**：
   * 它存在的全部理由就是让人一眼看出连没连上。
   */
  gatewayReady?: () => boolean;
  /** 项目根：数据编辑按它拼 src/data/*.yaml 与 data/backups/ */
  root: string;
  /**
   * 游戏库句柄。GM 管理要读写玩家状态，数据编辑不碰它。
   *
   * 为什么是必填而不是可选：可选意味着「没传进来」和「传进来了」在类型上一样，
   * 而没有库句柄的 GM 面板只能报一堆运行时错。
   */
  db: Db;
  /**
   * 适配器控制（只有 QQ 官方适配器提供）。
   *
   * 是可选的：OneBot 通道没有这些操作，而「没有它」和「有它」在面板上要长得不一样 ——
   * 摆一堆点了没反应的按钮，比不摆更糟。
   */
  adapter?: AdapterControl;
  /**
   * OneBot 通道的控制（M2.78）：看连接、重连、体检。
   *
   * 与上面那个 adapter 互斥 —— 一个进程只接一条通道。分成两个字段而不是合并成一个，
   * 是为了让「这条通道能做什么」在类型上就说清楚（见 OneBotControl 的注释）。
   */
  onebot?: OneBotControl;
  /**
   * 运行期启用 / 停用一条通道（M2.83）。
   *
   * 存在的理由就是用户那句「别让用户去直接编写文件」：启用动作要在后台点一下完成 ——
   * .env 由服务端写（下次启动照样生效），而**这一层负责让它此刻就生效**。
   */
  channelControl?: (
    channel: 'onebot' | 'qq',
    enable: boolean,
  ) => Promise<{ hot: boolean; message: string }>;
  /** 路由**自己注册**的指令名。白名单勾选按它出，不手抄一份会漂移的清单 */
  commandNames?: () => string[];
  /** /health 的那份快照。总览复用它，不另算一份口径 */
  health?: () => HealthSnapshot;
  /** 备份目录（与 app.config.backupDir 同一处解析，后台不自己拼） */
  backupDir?: string;
  /**
   * M2.63：**内容热重载**。数据编辑器保存成功后调它，让改动立刻生效。
   *
   * 定义在 admin 里而不是从 main 导入：后台不该认识游戏主程序 ——
   * 形状与 `health` 那个注入同一个手法（只声明需求，由 main 提供实现）。
   *
   * **可选**是有意的：没有它时保存仍然成功（文件已经写进磁盘了），
   * 只是回执会说「重启后生效」—— 与这个字段出现之前的旧行为一致，
   * 于是既有测试与只想要文件编辑的调用方都不受影响。
   */
  /**
   * 服务与访问（M2.82）：本机网卡、服务实际绑在哪、信不信反代。
   *
   * 这三个都由 main 注入而不是后台自己去问 —— 后台不该认识游戏主程序，
   * 也不该自己去枚举网卡（那让这一屏没法在测试里跑）。
   */
  access?: {
    lanIps: string[];
    listening: { host: string; port: number };
  };
  reloadContent?: () => {
    ok: boolean;
    rebuilt: string[];
    errors: string[];
    warnings: string[];
  };
}

/** 这台机器上有效的一次性口令 */
let password = '';
const COOKIE = 'dsh_admin';
/** 登录态有效期：12 小时。到期要重登，但不至于一个下午被踢几次 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 登录失败限流（M2.82）。
 *
 * 在此之前后台**一次登录尝试都不限** —— 本机访问时那没问题，
 * 但一旦绑到 0.0.0.0（局域网 / 公网），它就是一条可以无限试的口令。
 * 这也是「服务与访问」那一屏把监听地址摆出来时必须一起补上的东西。
 */
const loginGuard: LoginGuard = createLoginGuard();
/**
 * 信不信 X-Forwarded-For 里的来访 IP。
 *
 * 默认**不信**：那个头谁都能伪造，信了等于让攻击者自己填审计日志里的来源，
 * 顺带让限流按假 IP 记账（每次换个头就绕过去了）。
 * 只有前面确实有一层自己配的反向代理时才打开（TRUST_PROXY=1）。
 */
let trustProxy = false;

/** 签名密钥由口令派生：改口令 = 所有旧会话立刻失效 */
function sign(payload: string): string {
  return createHmac('sha256', 'dsh-admin:' + password).update(payload).digest('base64url');
}

function makeToken(): string {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return exp + '.' + sign(exp);
}

function verifyToken(token: string): boolean {
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const exp = token.slice(0, i);
  const mac = token.slice(i + 1);
  const want = sign(exp);
  // 长度不等时 timingSafeEqual 会抛，先挡掉
  if (mac.length !== want.length) return false;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  return Number(exp) > Date.now();
}

export function ensureAdminPassword(
  envPath: string,
  log: AdminContext['log'],
  opts: { trustProxy?: boolean } = {},
): void {
  trustProxy = opts.trustProxy === true;
  const fromEnv = envGet(readEnv(envPath), 'ADMIN_PASSWORD');
  if (fromEnv !== undefined && fromEnv.length > 0) {
    password = fromEnv;
    return;
  }
  /*
   * M2.86：**不再自动生成随机口令**（用户拍板）。
   *
   * 原来的做法是生成一串 24 字节 base64url **打进日志**。问题是：
   *   · 日志在控制台/文件里，用浏览器的人**根本看不到**，只会看到「口令不对」；
   *   · 每次重启都换一串，等于每次都要回去翻日志；
   *   · 用户真正的诉求是「初次启动就该让我设一个自己的口令」。
   *
   * 所以现在**留空**表示「还没设」。空口令在登录口是被拒的（见 :460 的 `password.length === 0`），
   * 因此空口令天然就是一个安全的「未设置」状态；
   * 前端据此显示设置界面，走 `POST /admin/api/setup`。
   */
  password = '';
  log('管理后台还没设口令 —— 打开 ' + '/admin 在页面里设置一个（不设谁也进不去）');
}

/**
 * 换掉后台口令（M2.82：让「服务与访问」那一屏能改口令）。
 *
 * 签名密钥由口令派生（见 sign），所以这一句**同时**做到两件事：
 * 新口令立刻可用、所有旧会话的 cookie 当场失效。
 * 「改口令踢掉所有人」是想要的语义，不是副作用。
 */
export function setAdminPassword(next: string): void {
  password = next;
}

/** 进程此刻在用的口令（面板要拿它和磁盘上的比） */
export function currentAdminPassword(): string {
  return password;
}

function cookies(req: IncomingMessage): string {
  const raw = req.headers.cookie;
  return Array.isArray(raw) ? raw.join('; ') : (raw ?? '');
}

function authed(req: IncomingMessage): boolean {
  const m = /(?:^|;\s*)dsh_admin=([^;]+)/.exec(cookies(req));
  return m !== null && verifyToken(decodeURIComponent(m[1] ?? ''));
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/**
 * 数据编辑的前端脚本路径。
 *
 * 它是一个**真正的 .js 文件**而不是拼在 page.ts 里的字符串数组 ——
 * 那样每行 JS 都要在单引号里再写引号，转义层数一深就必错（这一轮栽了三次）。
 * 独立成文件之后 node --check 能直接查语法，浏览器里也能直接打断点。
 */
const CLIENT_SCRIPTS: Record<string, string> = {
  // M2.74：markdown 渲染器（运营日报与压测报告要把生成出来的 md 渲染出来）
  '/admin/md.js': fileURLToPath(new URL('./md.js', import.meta.url)),
  '/admin/editor.js': fileURLToPath(new URL('./editor.js', import.meta.url)),
  '/admin/gm.js': fileURLToPath(new URL('./gm.js', import.meta.url)),
  '/admin/adapter.js': fileURLToPath(new URL('./adapter.js', import.meta.url)),
  '/admin/console.js': fileURLToPath(new URL('./console.js', import.meta.url)),
};

/**
 * 处理 /admin/*。
 *
 * 返回 true 表示这条路已经处理完，调用方不要再往下走 if-else 链。
 */
/**
 * 「服务与访问」那一屏要的全部输入。
 *
 * ⚠️ `CARD_PUBLIC_BASE_URL` 读的是 **process.env** —— 那是进程启动时的快照，
 * 正是「进程此刻在用的值」。磁盘上的那一份由 readAccess 自己读 .env，两列分开。
 */
/**
 * 保存 / 新建之后的收尾：热重载，并生成回执里那半句话。
 *
 * 抽出来是因为两条路都要它。各写一遍的下场是**迟早有一条忘了热重载** ——
 * 而那个症状是「界面上改好了，机器人那边当它不存在」：不报错、不提示，
 * 人只会觉得「这个后台怎么时灵时不灵」。
 */
function reloadSuffix(ctx: AdminContext, spec: EntitySpec): string {
  if (ctx.reloadContent === undefined) {
    return '重启机器人后生效；原文件备份在 data/backups/。';
  }
  try {
    const reload = ctx.reloadContent();
    ctx.log('内容热重载', {
      entity: spec.id, ok: reload.ok, rebuilt: reload.rebuilt, errors: reload.errors.length,
    });
    return reload.ok
      ? '**已即时生效**（换了 ' + reload.rebuilt.join('、') +
          (reload.warnings.length > 0 ? '；' + reload.warnings.length + ' 条提示请看服务日志' : '') +
          '）；原文件备份在 data/backups/。'
      : '**但没有生效** —— 内容校验没通过：' + reload.errors.slice(0, 3).join('；') +
        '（机器人仍在跑改动前的那一份）。原文件备份在 data/backups/。';
  } catch (e) {
    return '热重载抛错：' + (e as Error).message + '。改动已写入磁盘，重启机器人后生效。';
  }
}

/** 这组字段里有没有「条件列表」（要递归 —— cond 藏在卡片的 trigger 下面） */
function hasCondList(fields: FieldSpec[]): boolean {
  return fields.some((f) => f.condList === true ||
    hasCondList(f.objectFields ?? []) || hasCondList(f.rowFields ?? []));
}

const accessDeps = (ctx: AdminContext): AccessDeps => ({
  envPath: ctx.envPath,
  running: {
    ADMIN_PASSWORD: currentAdminPassword(),
    HOST: ctx.access?.listening.host ?? '',
    PORT: String(ctx.access?.listening.port ?? 0),
    CARD_PUBLIC_BASE_URL: process.env['CARD_PUBLIC_BASE_URL'] ?? '',
    TRUST_PROXY: trustProxy ? '1' : '',
    /*
     * 通道与运维令牌（M2.82）。
     *
     * ⚠️ 这几个**不脱敏地读进内存**再交给 readAccess 去打码 —— 打码只发生在
     * 出口那一层（access.ts 的 show）。别在这里打码：那样「磁盘 vs 进程」
     * 比的就是两个星号串，两个不同的密钥会长得一模一样。
     */
    ONEBOT_TOKEN: process.env['ONEBOT_TOKEN'] ?? '',
    ONEBOT_WS_TOKEN: process.env['ONEBOT_WS_TOKEN'] ?? process.env['ONEBOT_ACCESS_TOKEN'] ?? '',
    ADMIN_TOKEN: process.env['ADMIN_TOKEN'] ?? process.env['ONEBOT_TOKEN'] ?? '',
  },
  lanIps: ctx.access?.lanIps ?? [],
  guard: loginGuard,
  now: Date.now(),
});

/**
 * 探一个本机端口有没有在监听（M2.85）。
 */
async function probePort(port: number, timeoutMs = 400): Promise<boolean> {
  const net = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
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
 * 检测本机有没有 **QQ 协议端**在跑（M2.85）。
 *
 * ## 为什么做这个
 *
 * 用户的原话是「OneBot 登录框架没内嵌在里面吗？起码实现扫码登录」——
 * 而扫码登录**只能**在协议端做（本项目不内嵌 QQ 协议，见台账 B2-12）。
 * 既然不能内嵌，就至少要做到「**告诉用户下一步该做什么**」：
 * 装没装、跑没跑、跑在哪个端口上 —— 而不是让他对着「未连接」发呆。
 *
 * ## 只报看得见的证据，不猜路径
 *
 * 两件事都**实测**：进程列表里有没有 napcat / lagrange / llonebot 字样；
 * 常见端口（3000 / 3001 / 8080）有没有在监听。
 * 猜安装路径（C:\\Program Files\\…）看着聪明，但猜错的表现是
 * 「面板说装了、用户找不到」—— 那比不检测更糟。
 */
async function detectProtocolEnds(): Promise<{
  processes: string[];
  ports: Array<{ port: number; listening: boolean }>;
  error: string | null;
}> {
  const processes: string[] = [];
  let error: string | null = null;
  try {
    const { execFile } = await import('node:child_process');
    const isWin = process.platform === 'win32';
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        isWin ? 'tasklist' : 'ps',
        isWin ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm'],
        { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
      );
    });
    const re = /napcat|lagrange|llonebot|onebot/i;
    for (const line of out.split(/\r?\n/)) {
      if (!re.test(line)) continue;
      // CSV 的第一列是映像名；ps 的输出本身就是名字
      const label = isWin ? (line.split(',')[0] ?? '').replace(/"/g, '').trim() : line.trim();
      if (label !== '' && !processes.includes(label)) processes.push(label);
    }
  } catch (e) {
    // 拿不到进程列表不算失败：端口那一路照样有信息
    error = (e as Error).message;
  }
  const ports = await Promise.all(
    [3000, 3001, 8080].map(async (port) => ({ port, listening: await probePort(port) })),
  );
  return { processes, ports, error };
}

export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: AdminContext,
): Promise<boolean> {
  /*
   * 只接管后台自己的路径。
   *
   * ⚠️ 不能用 url.startsWith('/admin') 圈地：M2.39 已经有一个 POST /admin/tick
   * （时间旅行端点），前缀一撞就被后台的鉴权挡掉，那条链路整个失效。
   * 路由前缀圈地之前，先确认没有别人用这个名字。
   */
  const mine =
    url === '/admin' || url === '/admin/' ||
    url in CLIENT_SCRIPTS ||
    url.startsWith('/admin/api/');
  if (!mine) return false;

  /*
   * 前端脚本放行，不要求登录：它是登录页本身要加载的东西，
   * 而且里面没有任何机密（机密全在服务端的元数据与 yaml 里）。
   */
  const script = CLIENT_SCRIPTS[url];
  if (req.method === 'GET' && script !== undefined) {
    try {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(script, 'utf8'));
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(url + ' 读取失败');
    }
    return true;
  }

  // 登录页放行：没登录的人要能看到输入框
  if (req.method === 'GET' && (url === '/admin' || url === '/admin/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(adminPage());
    return true;
  }

  /*
   * **首次设置口令**（M2.86）。
   *
   * 用户：「初次启动脚本时应该检测是否有登录密码，没有则前端显示设置密码界面，
   * 密码要求别那么复杂，几位数都行」。
   *
   * 安全性靠一条：**只在 `password === ''` 时可用**。一旦设过，这两个端点就永久关闭 ——
   * 否则「未登录就能改口令」等于没有口令。
   */
  if (req.method === 'GET' && url === '/admin/api/setup') {
    json(res, 200, { needsSetup: password.length === 0 });
    return true;
  }

  if (req.method === 'POST' && url === '/admin/api/setup') {
    if (password.length > 0) {
      json(res, 403, { error: '口令已经设过了。要改口令请登录后在「服务与访问」里改。' });
      return true;
    }
    const ip = clientIp(req, trustProxy);
    const gate = loginGuard.check(ip, Date.now());
    if (!gate.ok) {
      const secs = Math.ceil(gate.retryAfterMs / 1000);
      json(res, 429, { error: '试得太频繁了，请等 ' + secs + ' 秒' });
      return true;
    }
    const body = JSON.parse((await readBody(req)) || '{}') as { password?: string };
    const next = (body.password ?? '').trim();
    /*
     * **只要非空就行**（用户明确要求「几位数都行」）。
     *
     * 原来这里走 `checkPasswordStrength`（至少 N 位、不许纯数字、不许重复、不许常见词）。
     * 那套规则挡的是**公网爆破**，但这个后台默认只监听本机 / 内网，
     * 而且真正防爆破的是 `loginGuard`（连续失败就锁）—— 长度门槛收益很小、
     * 代价却是「自己想设的口令设不上」，最后人会去设一个更长的弱口令。
     * 所以放开，但仍挡住**空口令**与**超长**（超长会把 cookie 撑爆）。
     */
    if (next.length === 0) {
      json(res, 400, { error: '口令不能是空的。' });
      return true;
    }
    if (next.length > 128) {
      json(res, 400, { error: '口令太长了（最多 128 位）。' });
      return true;
    }
    setAdminPassword(next);
    // 同时落盘：重启之后还是这一个（否则下次启动又变回「未设置」）
    const file = readEnv(ctx.envPath);
    envSet(file, 'ADMIN_PASSWORD', next);
    writeEnv(ctx.envPath, file);
    loginGuard.ok(ip);
    ctx.log('管理后台设置了首个口令', { ip });
    /*
     * 设完直接发登录 cookie —— 用户刚证明了他就是这台机器的主人（他有本机/内网访问权），
     * 再让他手打一遍刚设的口令是纯粹的仪式。
     *
     * 走 `makeToken()` 而不是自己 `sign()`：**cookie 的形状只能有一处定义**，
     * 自己拼一个 `exp.sign(exp)` 会在签发格式改动时安静地失效（签名对了、格式不对）。
     */
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': COOKIE + '=' + encodeURIComponent(makeToken()) + '; Path=/; HttpOnly; SameSite=Lax',
    });
    res.end(JSON.stringify({ ok: true, message: '口令已设置，已直接登录。' }));
    return true;
  }

  if (req.method === 'POST' && url === '/admin/api/login') {
    /*
     * M2.82：来访 IP 与失败限流。
     *
     * 原来这里 `ip: 'local'` 是写死的 —— 本机访问时那是实话，
     * 但绑到 0.0.0.0 之后它就是假的：公网上出了事，审计日志里全是一样的字符串。
     */
    const ip = clientIp(req, trustProxy);
    const gate = loginGuard.check(ip, Date.now());
    if (!gate.ok) {
      /*
       * 429 而不是 401 —— 这两种失败对人要说不同的话：
       * 401 是「口令不对」，429 是「错太多次了，等一会儿」。
       * 混成一个，运维会一直重输口令，而真正的原因在限流上。
       */
      const secs = Math.ceil(gate.retryAfterMs / 1000);
      json(res, 429, {
        error: '口令连续错误太多次，请等 ' + secs + ' 秒再试',
        retryAfterMs: gate.retryAfterMs,
      });
      return true;
    }
    const body = JSON.parse((await readBody(req)) || '{}') as { password?: string };
    if (body.password !== password || password.length === 0) {
      loginGuard.fail(ip, Date.now());
      ctx.log('管理后台登录失败', { ip });
      json(res, 401, { error: '口令不对' });
      return true;
    }
    loginGuard.ok(ip);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      // HttpOnly：前端脚本读不到，XSS 也偷不走
      // SameSite=Lax 挡跨站提交；Max-Age 让浏览器把它当持久 cookie，关标签页也不丢
      'set-cookie': COOKIE + '=' + encodeURIComponent(makeToken()) +
        '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
    });
    res.end('{"ok":true}');
    ctx.log('管理后台登录成功', { ip });
    return true;
  }

  if (!authed(req)) { json(res, 401, { error: '未登录' }); return true; }

  if (url === '/admin/api/adapter' && req.method === 'GET') {
    const file = readEnv(ctx.envPath);
    json(res, 200, {
      appId: envGet(file, 'QQ_BOT_APPID') ?? '',
      secretMasked: maskSecret(envGet(file, 'QQ_BOT_SECRET')),
      sandbox: (envGet(file, 'QQ_BOT_SANDBOX') ?? '0') === '1',
      markdown: (envGet(file, 'QQ_BOT_MARKDOWN') ?? '0') === '1',
      buttons: (envGet(file, 'QQ_BOT_BUTTONS') ?? '0') === '1',
      allowedCommands: envGet(file, 'QQ_BOT_ALLOWED_COMMANDS') ?? '*',
      connected: ctx.gatewayReady?.() === true,
      pid: process.pid,
      startedAt: ctx.startedAt,
      envPath: ctx.envPath,
    });
    return true;
  }

  if (url === '/admin/api/adapter' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;

    /*
     * M2.82：**OneBot 那一页的保存**。
     *
     * 与 QQ 侧同一套做法：先写 .env（下次启动读的就是新值），再顺手改进程里的配置 ——
     * 白名单立刻生效，地址与令牌标成「要重连协议端才生效」（界面会提示点哪个按钮）。
     */
    if (b.channel === 'onebot') {
      const envFile = readEnv(ctx.envPath);
      const obChanged: string[] = [];
      const putOb = (key: string, value: string): void => {
        if (envGet(envFile, key) !== value) obChanged.push(key);
        envSet(envFile, key, value);
      };
      if (typeof b.wsUrl === 'string') putOb('ONEBOT_WS_URL', b.wsUrl.trim());
      // 留空 = 不改（页面不回显 token）
      if (typeof b.token === 'string' && b.token.length > 0) putOb('ONEBOT_WS_TOKEN', b.token.trim());
      if (typeof b.allowedCommands === 'string') putOb('ONEBOT_ALLOWED_COMMANDS', b.allowedCommands.trim());
      writeEnv(ctx.envPath, envFile);

      const obRec = ctx.onebot?.reconfigure(onebotPatchFromForm(b));
      const obApplied = obRec?.applied ?? [];
      const obPending = obRec?.pendingReconnect ?? [];
      ctx.log('管理后台改了 OneBot 配置', { changed: obChanged, applied: obApplied, pending: obPending });

      const obParts: string[] = [];
      if (obChanged.length > 0) obParts.push('已写入 .env：' + obChanged.join('、'));
      if (obApplied.length > 0) obParts.push('立刻生效：' + obApplied.join('、'));
      if (obPending.length > 0) obParts.push('要重连协议端才生效：' + obPending.join('、') + '（点「重连协议端」，不用重启进程）');
      if (obChanged.length === 0 && obApplied.length === 0 && obPending.length === 0) obParts.push('没有改动');
      json(res, 200, { ok: true, message: obParts.join('；'), changed: obChanged, applied: obApplied, pending: obPending });
      return true;
    }

    const file = readEnv(ctx.envPath);
    const changed: string[] = [];
    const put = (key: string, value: string): void => {
      if (envGet(file, key) !== value) changed.push(key);
      envSet(file, key, value);
    };
    if (typeof b.appId === 'string') put('QQ_BOT_APPID', b.appId.trim());
    // 留空表示"不改" —— 页面不回显 secret，不留这条规则的话一保存就把密钥清空了
    if (typeof b.secret === 'string' && b.secret.length > 0) put('QQ_BOT_SECRET', b.secret.trim());
    put('QQ_BOT_SANDBOX', b.sandbox === true ? '1' : '0');
    put('QQ_BOT_MARKDOWN', b.markdown === true ? '1' : '0');
    put('QQ_BOT_BUTTONS', b.buttons === true ? '1' : '0');
    if (typeof b.allowedCommands === 'string' && b.allowedCommands.length > 0) put('QQ_BOT_ALLOWED_COMMANDS', b.allowedCommands.trim());
    writeEnv(ctx.envPath, file);

    /*
     * 写完 .env 顺手把**进程里的配置**也改掉。
     *
     * 这是这个面板最大的一处改进：原来它只改磁盘，人得自己去重启进程 ——
     * 而重启会断网关、清掉被动回复凭证，玩家那边就是「机器人忽然不理人一会儿」。
     * 能在运行期改的项（白名单 / Markdown / 调试日志）现在是立刻生效的；
     * 剩下的（AppID / AppSecret / 沙箱 / 原生按钮）也不用重启，点一下重连网关就行。
     */
    const rec = ctx.adapter?.reconfigure(patchFromForm(b));
    const applied = rec?.applied ?? [];
    const pending = rec?.pendingReconnect ?? [];
    ctx.log('管理后台改了适配器配置', { changed, applied, pending });

    const parts: string[] = [];
    if (changed.length > 0) parts.push('已写入 .env：' + changed.map(labelOf).join('、'));
    if (applied.length > 0) parts.push('立刻生效：' + applied.map(labelOf).join('、'));
    if (pending.length > 0) {
      parts.push('要重连网关才生效：' + pending.map(labelOf).join('、') + '（点「重连网关」，不用重启进程）');
    }
    if (changed.length > 0 && ctx.adapter === undefined) {
      parts.push('当前通道没有热改接口，重启机器人后生效');
    }
    json(res, 200, {
      ok: true, changed, applied, pendingReconnect: pending,
      message: parts.length > 0 ? parts.join('；') + '。' : '没有变化。',
    });
    return true;
  }

  /*
   * ── 适配器的实时状态（M2.51） ──────────────────────────────
   *
   * 与 /admin/api/adapter 的区别：那条读的是**.env 磁盘**，这条读的是**进程此刻在用的值**。
   * 两者不一样，而且差别是静默的（改完没重启、或 .env 缺省时适配器有自己的默认），
   * 所以这里把两边都发下去，让界面把它们并排显示、标出不同的地方。
   */
  if (url === '/admin/api/adapter/live' && req.method === 'GET') {
    const file = readEnv(ctx.envPath);
    const disk: Record<string, string | undefined> = {};
    for (const key of [
      'QQ_BOT_APPID', 'QQ_BOT_SECRET', 'QQ_BOT_SANDBOX', 'QQ_BOT_BUTTONS',
      'QQ_BOT_MARKDOWN', 'QQ_BOT_DEBUG', 'QQ_BOT_ALLOWED_COMMANDS',
      // M2.82：OneBot 那一侧的可改项一并读出来（面板两页共用同一个 disk 映射）
      'ONEBOT_WS_URL', 'ONEBOT_WS_TOKEN', 'ONEBOT_API_BASE', 'ONEBOT_TOKEN', 'ONEBOT_ALLOWED_COMMANDS',
    ]) {
      disk[key] = envGet(file, key);
    }
    const rt = ctx.adapter?.runtimeStatus();
    const onebot = ctx.onebot?.status() ?? null;
    const onebotConfig = ctx.onebot?.config() ?? null;
    json(res, 200, {
      pid: process.pid,
      startedAt: ctx.startedAt,
      envPath: ctx.envPath,
      connected: ctx.gatewayReady?.() === true,
      hasControl: ctx.adapter !== undefined,
      /*
       * M2.78：**这一行是前端按通道切换界面的依据**。
       *
       * 在此之前面板只认 QQ 官方通道（`running` 为 null 就显示「当前通道没有热改接口」），
       * 于是接了 OneBot 的部署打开这一页几乎是空的 —— 明明有连接、有账号、有重连次数，
       * 却只能去翻日志。
       */
      channel: rt !== undefined ? 'qq' : onebot !== null ? 'onebot' : 'none',
      /*
       * M2.79：**两条通道可以同时在线**（ADAPTER=both），所以这里给的是数组 ——
       * 前端据此把两块都显示出来，而不是二选一。
       * channel 那个字段保留着：单通道时的快捷判定，也免得老前端立刻坏掉。
       */
      channels: [
        ...(rt !== undefined ? ['qq'] : []),
        ...(onebot !== null ? ['onebot'] : []),
      ],
      /** 这个进程是按哪种模式起来的（onebot / qq / both）—— 运维第一眼要看的就是它 */
      adapterMode: (process.env.ADAPTER ?? 'onebot').trim().toLowerCase(),
      /*
       * M2.80：**没启用的通道也要列出来**。
       *
       * 原来只返回「已启用的通道」，于是跑 OneBot 模式的部署打开这一页，
       * 根本看不出「还有一条 QQ 官方通道可以开」—— 用户的原话就是
       * 「为什么适配器里只有 OneBot 适配器？QQ 适配器呢？」。
       * 一个管理页只显示**已有**的东西、不显示**可有**的东西，等于把选择权藏起来了。
       */
      available: [
        {
          id: 'onebot',
          label: 'OneBot（QQ NT 协议端）',
          enabled: onebot !== null,
          mode: onebot === null ? null : (onebot.transport === 'websocket' ? '内置 WS' : 'HTTP 上报'),
          how: 'ADAPTER=onebot（默认）；想要内置连接就再填 ONEBOT_WS_URL=ws://127.0.0.1:3001',
          note: '协议端（NapCat / LLOneBot / Lagrange）要你自己运行 —— 内置的是连接层，不是 QQ 协议本身。',
        },
        {
          id: 'qq',
          label: 'QQ 官方机器人（QQ 开放平台）',
          enabled: rt !== undefined,
          mode: rt === undefined ? null : (rt.sandbox ? '沙箱' : '正式'),
          how: '点下面这个按钮启用；凭证（AppID / AppSecret）在它自己的子页里填',
          /*
           * M2.83：缺凭证时不该给一个点了必然失败的「启用」按钮 ——
           * 那只会让人以为「程序坏了」。前端据这个标记把按钮换成「去填凭证」。
           */
          needsSetup: rt === undefined && (
            (process.env['QQ_BOT_APPID'] ?? '').trim() === ''
            || (process.env['QQ_BOT_SECRET'] ?? '').trim() === ''
          ),
          note: '走官方协议，不依赖 QQ 客户端，但需要开放平台的机器人资质。',
        },
      ],
      running: rt ?? null,
      onebot,
      onebotConfig,
      diff: rt === undefined ? [] : compareAdapter(disk, rt),
      // M2.82：OneBot 的「磁盘 vs 运行中」—— 与 QQ 那一份同一个行形状，前端一个渲染函数画两边
      onebotDiff: onebotConfig === null ? [] : compareOneBot(disk, onebotConfig),
      commands: commandCatalogue(ctx.commandNames?.() ?? []),
    });
    return true;
  }

  /*
   * M2.83：**启用 / 停用一条通道**（总览页卡片上的那两个按钮）。
   *
   * 两件事一起做，缺一不可：
   *   1. 写 .env 的 ADAPTER —— 让「界面上的状态」与「下次启动的状态」是同一个；
   *   2. 让 channelControl 当场热装/卸载 —— 否则用户还得自己去重启进程。
   */
  /*
   * M2.85：协议端检测 —— 「我该装/该启动什么」这件事不该让用户去猜。
   * 只在人点按钮时跑（进程列表 + 端口探测都要花几百毫秒，不适合轮询）。
   */
  if (url === '/admin/api/adapter/env' && req.method === 'GET') {
    const detected = await detectProtocolEnds();
    json(res, 200, {
      ok: true,
      ...detected,
      /*
       * 引导信息里**只放官方仓库**（地址都核对过），不放第三方转载站 ——
       * 让用户去下别人打包的 QQ 协议端，是这个项目最不该做的一件事。
       */
      options: [
        {
          name: 'NapCat',
          repo: 'https://github.com/NapNeko/NapCatQQ',
          how: '把 NTQQ 客户端跑在无头环境里（它的登录就是 QQ 的登录，支持扫码）',
        },
        {
          name: 'Lagrange.Core',
          repo: 'https://github.com/LagrangeDev/Lagrange.Core',
          how: '纯 C# 自己实现 NTQQ 协议，不需要装 QQ 客户端',
        },
      ],
    });
    return true;
  }

  if (url === '/admin/api/adapter/channel' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const channel = String(b.channel ?? '');
    if (channel !== 'onebot' && channel !== 'qq') {
      json(res, 400, { error: '通道名只支持 onebot / qq' });
      return true;
    }
    const enable = b.enabled === true;

    const file = readEnv(ctx.envPath);
    const current = (envGet(file, 'ADAPTER') ?? 'onebot').trim().toLowerCase();
    const set = new Set<string>(
      current === 'both' ? ['onebot', 'qq'] : [current === 'qq' ? 'qq' : 'onebot'],
    );
    if (enable) set.add(channel);
    else set.delete(channel);
    // 一条都不剩时保留另一条 —— 「两条都停」等于机器人彻底不接消息，那不该是一个按钮能做到的事
    const next = set.size === 0
      ? (channel === 'onebot' ? 'qq' : 'onebot')
      : (set.size === 2 ? 'both' : [...set][0]!);
    envSet(file, 'ADAPTER', next);
    writeEnv(ctx.envPath, file);

    const hot = ctx.channelControl === undefined
      ? { hot: false, message: '这个进程不支持运行期启用，重启后生效。' }
      : await ctx.channelControl(channel, enable);
    ctx.log('管理后台切换了通道', { channel, enable, adapter: next, hot: hot.hot });

    json(res, 200, {
      ok: hot.hot,
      message: (enable ? '启用 ' : '停用 ') + channel + '：' + hot.message +
        '（.env 的 ADAPTER 已写成 ' + next + '，重启后也是这个状态）',
    });
    return true;
  }

  if (url === '/admin/api/adapter/reconnect' && req.method === 'POST') {
    if (ctx.onebot !== undefined) {
      // M2.78：OneBot 通道也有「重连」了 —— 原来这个按钮对它是不存在的
      const out = await ctx.onebot.reconnect();
      ctx.log('管理后台重连了 OneBot 连接', { ok: out.ok });
      json(res, out.ok ? 200 : 400, out);
      return true;
    }
    if (ctx.adapter === undefined) { json(res, 400, { error: '当前通道不支持重连' }); return true; }
    try {
      await ctx.adapter.reconnectGateway();
      ctx.log('管理后台重连了网关');
      json(res, 200, { ok: true, message: '网关已按新配置重建并重连。掉线期间的群消息平台会重投，但有几秒空档。' });
    } catch (e) {
      json(res, 500, { error: '重连失败：' + (e as Error).message });
    }
    return true;
  }

  if (url === '/admin/api/adapter/verify' && req.method === 'POST') {
    if (ctx.onebot !== undefined) {
      const out = await ctx.onebot.verify();
      json(res, out.ok ? 200 : 400, out);
      return true;
    }
    if (ctx.adapter === undefined) { json(res, 400, { error: '当前通道不支持自检' }); return true; }
    const out = await ctx.adapter.verify();
    json(res, out.ok ? 200 : 400, out);
    return true;
  }

  /*
   * ── 数据编辑 ────────────────────────────────────────────────
   *
   * 三条路：实体清单 → 记录列表 → 单条读写。
   * 前端拿字段元数据渲染控件（中文标签 / 数字框 / 下拉 / 开关），
   * 服务端用同一份元数据校验 —— 绕过界面直接打 API 也过不了枚举和类型。
   */
  if (url === '/admin/api/data' && req.method === 'GET') {
    /*
     * 一次把「分类 + 字段元数据 + 引用选项」全给前端。
     *
     * 引用选项（ref）单独拉会让界面出现"先选教会、等半秒才出选项"的空窗；
     * 这些列表都很小（城市 6 条、教会 7 条），一次带走更省事也更快。
     */
    const options: Record<string, Array<{ id: string; title: string }>> = {};
    /*
     * 引用目标走 schema.ts 的 refTargetsOf（那份实现会递归到 rowFields 与
     * objectFields 里）。原来这里是**第二份**实现、而且只递归了 rowFields ——
     * 嵌套对象里的引用会让下拉空着，且不报错。
     */
    const allRefs = new Set(ENTITIES.flatMap((x) => refTargetsOf(x.fields)));
    for (const e of ENTITIES) {
      if (!allRefs.has(e.id)) continue;
      try {
        options[e.id] = listEntity(ctx.root, e).map((r) => ({ id: r.id, title: r.title }));
      } catch {
        options[e.id] = [];
      }
    }
    json(res, 200, {
      groups: groupedEntities(),
      options,
      entities: ENTITIES.map(entityMeta),
      /*
       * M2.83：触发条件的候选。只有**真的有条件字段**的实体才带它 ——
       * 否则它是一份没人看的参考表，白拖首屏。
       */
      condOptions: ENTITIES.some((e) => hasCondList(e.fields)) ? condOptionsOf(ctx.root) : undefined,
    });
    return true;
  }

  const dm = /^\/admin\/api\/data\/([^/]+)(?:\/(.+))?$/.exec(url.split('?')[0] ?? '');
  if (dm !== null) {
    const spec = entityById(decodeURIComponent(dm[1] ?? ''));
    if (spec === undefined) { json(res, 404, { error: '没有这个可编辑实体' }); return true; }
    const rowId = dm[2] === undefined ? undefined : decodeURIComponent(dm[2]);

    if (req.method === 'GET' && rowId === undefined) {
      json(res, 200, { entity: spec.id, label: spec.label, rows: listEntity(ctx.root, spec) });
      return true;
    }
    if (req.method === 'GET' && rowId !== undefined) {
      const row = readEntity(ctx.root, spec, rowId);
      if (row === null) { json(res, 404, { error: '找不到这一条：' + rowId }); return true; }
      json(res, 200, { row });
      return true;
    }
    /*
     * 新建一条（M2.84）：**不带 rowId 的 POST**。
     *
     * 与「改一条」共用同一套校验（值域 + 跨表 + 必填），差别只在落盘那一步 ——
     * 而那一步（flushDoc）也是同一个函数。校验分两条路的下场是
     * 「新建能绕过全部约束」，而新建恰恰是最需要约束的入口：
     * 运营会拿它来批量加内容，一条脏记录能在里面躺很久没人发现。
     */
    if (req.method === 'POST' && rowId === undefined) {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        id?: string; patch?: Record<string, unknown>;
      };
      try {
        const created = createEntity(ctx.root, spec, body.id ?? '', body.patch ?? {});
        ctx.log('管理后台新增了内容数据', { entity: spec.id, id: body.id });
        json(res, 200, {
          ok: true, id: (body.id ?? '').trim(), changed: created.changed,
          message: '已新增到 ' + spec.file + '：' + (body.id ?? '').trim() +
            '（' + created.changed.join('、') + '）。' + reloadSuffix(ctx, spec),
        });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return true;
    }

    if (req.method === 'POST' && rowId !== undefined) {
      const patch = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      try {
        const out = writeEntity(ctx.root, spec, rowId, patch);
        ctx.log('管理后台改了内容数据', { entity: spec.id, id: rowId, changed: out.changed });
        /*
         * M2.63：保存成功后**立刻热重载**，让人不必重启进程。
         *
         * 为什么放在这里而不是让前端再发一个「应用」请求：
         * 那会留下一个「文件改了但没应用」的中间态 —— 而那个状态在界面上
         * 与「已经生效」长得一样，最容易被忘掉。
         *
         * 重载失败**不影响这次保存**：文件已经写进磁盘了（那是这次请求真正做的事），
         * 而失败信息会如实报出来 —— 回执里说清楚「写进去了，但没换上」。
         */
        /*
         * 热重载只在**真的改了东西**时做：没变化的保存跑一遍重载是白费 ——
         * 而重载会重建事件引擎，代价不小。
         */
        const suffix = out.changed.length === 0 ? '' : reloadSuffix(ctx, spec);
        json(res, 200, {
          ok: true, changed: out.changed,
          message: out.changed.length === 0 ? '没有变化。'
            : '已写入 ' + spec.file + '，改动：' + out.changed.join('、') + '。' + suffix,
        });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return true;
    }
  }

  /*
   * ---------------- 后台框架：导航与总览（M2.52） ----------------
   *
   * 导航由服务端的注册表（nav.ts）出，前端只负责画。加一个面板 = 改注册表一处，
   * 不用同时改 aside、section 和显隐开关 —— 三处漏一处就是「点了没反应」。
   */
  if (url === '/admin/api/nav' && req.method === 'GET') {
    json(res, 200, { panels: groupedPanels(), planned: PANELS.filter((p) => p.state === 'planned').length });
    return true;
  }

  /* ---------------- 服务与访问（M2.82） ---------------- */

  if (url === '/admin/api/access' && req.method === 'GET') {
    json(res, 200, readAccess(accessDeps(ctx)));
    return true;
  }

  if (url === '/admin/api/access' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      key?: string; value?: string; password?: string;
    };
    /*
     * 改任何一项都要**先证明你是主人**。理由不是「防手滑」：
     *
     *   · 会话 cookie 可能来自一台没锁屏的机器。而「后台口令」这一项一改，
     *     真正的主人就被踢出去了 —— 抢到会话的人于是能永久占住后台；
     *   · 「监听地址」这一项能把后台从「只有本机能进」变成「谁都能试」。
     *
     * 所以这一屏的写权限比数据编辑**高一档**：数据编辑只要会话，这里还要口令。
     */
    if (body.password !== password || password.length === 0) {
      json(res, 401, { error: '这一步需要再输一次当前口令' });
      return true;
    }
    try {
      const r = writeAccessKey(ctx.envPath, body.key ?? '', body.value ?? '');
      /*
       * 口令改完**立刻**换掉进程里的那一份。
       * 不换的话，面板上「磁盘 vs 进程」会一直显示「不一致」，而运营刚刚才看见
       * 「立刻生效」四个字 —— 那种自相矛盾会让人开始怀疑整个面板。
       */
      if (body.key === 'ADMIN_PASSWORD') setAdminPassword((body.value ?? '').trim());
      ctx.log('后台改了访问配置', { item: r.changed, apply: r.apply });
      json(res, 200, r);
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  if (url === '/admin/api/overview' && req.method === 'GET') {
    if (ctx.health === undefined) { json(res, 503, { error: '后台没拿到进程快照' }); return true; }
    json(res, 200, overviewPayload(ctx.health(), ctx.db, dateKey(Date.now()), process.pid, ctx.startedAt));
    return true;
  }

  if (url === '/admin/api/ops' && req.method === 'GET') {
    json(res, 200, opsPayload(ctx.db, dateKey(Date.now())));
    return true;
  }

  /* ---------------- 日志 / 审计 / 世界 / 内容 / 模拟（M2.53） ---------------- */

  if ((url === '/admin/api/logs' || url.startsWith('/admin/api/logs?')) && req.method === 'GET') {
    const p = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const rawLevel = p.get('level') ?? '';
    const level = rawLevel === 'info' || rawLevel === 'warn' || rawLevel === 'error' ? rawLevel : undefined;
    const limit = Number(p.get('limit') ?? 200);
    json(res, 200, {
      entries: processLogs.recent({
        ...(level === undefined ? {} : { level }),
        q: p.get('q') ?? '',
        limit: Number.isFinite(limit) ? limit : 200,
      }),
      counts: processLogs.counts(),
      capacity: processLogs.capacity,
      dropped: processLogs.dropped(),
    });
    return true;
  }

  if ((url === '/admin/api/audit' || url.startsWith('/admin/api/audit?')) && req.method === 'GET') {
    const p = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const num = (key: string): number | undefined => {
      const v = p.get(key);
      if (v === null || v.trim() === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    json(res, 200, searchAudit(ctx.db, {
      text: p.get('text') ?? undefined,
      command: p.get('command') ?? undefined,
      userId: p.get('userId') ?? undefined,
      from: num('from'),
      to: num('to'),
      limit: num('limit'),
    }));
    return true;
  }

  if (url === '/admin/api/world' && req.method === 'GET') {
    json(res, 200, worldView(ctx.db, Date.now()));
    return true;
  }

  if (url === '/admin/api/content' && req.method === 'GET') {
    json(res, 200, contentView());
    return true;
  }

  /*
   * **一键修复**（M2.86）。
   *
   * 两条分开：`GET plan` 只出计划（界面先给运营看「哪一行会变成什么」），
   * `POST apply` 才落盘。**apply 里在服务端重算一遍计划**，不接收前端传来的行号 ——
   * 前端传的行号可能已经过期（别人改过文件），照着它改就是**改错行**。
   * 这也是「一键修复不是一键修坏」的一条：**唯一可信的计划来源是当前文件本身**。
   */
  if (url === '/admin/api/content/fix/plan' && req.method === 'GET') {
    json(res, 200, planEventCardFix(join(ctx.root, 'src', 'data')));
    return true;
  }

  if (url === '/admin/api/content/fix/apply' && req.method === 'POST') {
    const dataDir = join(ctx.root, 'src', 'data');
    const plan = planEventCardFix(dataDir);
    /*
     * M2.89：**没有要修的就不动文件。**
     *
     * 用户报「一键修复点击无效」——查下来它不是坏了，是**本来就没东西可修**
     * （154 个地点全都有 events 池）。但界面只回一句「已修复 0 处」，
     * 看起来与「点了没反应」一模一样。
     *
     * 而且旧写法在计划为 0 时**仍然走 applyEventCardFix** —— 那会落盘、建备份，
     * 产生一个「什么都没改的 .bak」。备份是给「改坏了能退回去」用的，
     * 攒一堆空备份会让真正的那一份找不到。
     */
    if (plan.changes.length === 0) {
      json(res, 200, { planned: 0, written: 0, backup: null, skipped: plan.skipped, reason: plan.summary });
      return true;
    }
    const result = applyEventCardFix(dataDir, plan);
    json(res, 200, {
      planned: plan.changes.length,
      written: result.written,
      backup: result.backup,
      skipped: plan.skipped,
    });
    return true;
  }

  // 上限只此一处（admin/sim.ts 的 SIM_LIMITS）—— 界面上写死一份迟早会与它不一致
  if (url === '/admin/api/sim/limits' && req.method === 'GET') {
    json(res, 200, { ...SIM_LIMITS, strategies: SIM_STRATEGY_CHOICES });
    return true;
  }

  if (url === '/admin/api/sim' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const out = runSim(ctx.db, body);
    if (!out.ok) { json(res, 400, out); return true; }
    ctx.log('管理后台跑了一次模拟', { 策略: out.runs.length, 耗时毫秒: out.elapsedMs });
    json(res, 200, out);
    return true;
  }

  if (url === '/admin/api/backup' && ctx.backupDir !== undefined) {
    const dir = ctx.backupDir;
    if (req.method === 'GET') { json(res, 200, backupView(dir)); return true; }
    if (req.method === 'POST') {
      const out = backupDatabase(ctx.db, dir, Date.now());
      ctx.log('管理后台做了一次数据库备份', { file: out.file, created: out.created });
      json(res, 200, {
        ok: true,
        created: out.created,
        pruned: out.pruned.map((f) => f.replace(/^.*[\\/]/, '')),
        message: out.created
          ? '已备份到 ' + out.file.replace(/^.*[\\/]/, '') +
            (out.pruned.length > 0 ? '，并清理了 ' + out.pruned.length + ' 份过期备份。' : '。')
          : // 每天只留一份：今天的已经在了就直说，不要假装又备了一次
            '今天已经备份过了（' + out.file.replace(/^.*[\\/]/, '') + '），没有重复写。',
        view: backupView(dir),
      });
      return true;
    }
  }

  if (url === '/admin/api/backup/prune' && req.method === 'POST' && ctx.backupDir !== undefined) {
    const body = JSON.parse((await readBody(req)) || '{}') as { retainDays?: unknown };
    const days = Math.round(Number(body.retainDays ?? 7));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      json(res, 400, { error: '保留天数只能是 1—365' });
      return true;
    }
    const pruned = pruneBackups(ctx.backupDir, days, Date.now());
    ctx.log('管理后台清理了旧备份', { days, count: pruned.length });
    json(res, 200, {
      ok: true,
      pruned: pruned.map((f) => f.replace(/^.*[\\/]/, '')),
      message: pruned.length > 0
        ? '已清理 ' + pruned.length + ' 份早于 ' + days + ' 天的备份。'
        : '没有需要清理的（都在 ' + days + ' 天内）。',
      view: backupView(ctx.backupDir),
    });
    return true;
  }

  if (url === '/admin/api/feedback' && req.method === 'GET') {
    json(res, 200, {
      ...feedbackView(ctx.db),
      statusLabels: FEEDBACK_STATUS_LABEL,
      categoryLabels: FEEDBACK_CATEGORY_LABEL,
    });
    return true;
  }

  const fm = /^\/admin\/api\/feedback\/(\d+)$/.exec(url);
  if (fm !== null && req.method === 'POST') {
    if (fm === null) return false;
    const id = Number(fm[1]);
    const repo = new FeedbackRepo(ctx.db);
    if (repo.getById(id) === null) { json(res, 404, { error: '没有这条反馈：' + id }); return true; }
    const body = JSON.parse((await readBody(req)) || '{}') as { status?: unknown; category?: unknown };
    const done: string[] = [];
    if (typeof body.status === 'string') {
      if (!(body.status in FEEDBACK_STATUS_LABEL)) {
        json(res, 400, { error: '状态只能是：' + Object.values(FEEDBACK_STATUS_LABEL).join(' / ') });
        return true;
      }
      repo.markHandled(id, Date.now(), body.status);
      done.push('状态 → ' + FEEDBACK_STATUS_LABEL[body.status]);
    }
    if (typeof body.category === 'string') {
      if (!(body.category in FEEDBACK_CATEGORY_LABEL)) {
        json(res, 400, { error: '分类只能是：' + Object.values(FEEDBACK_CATEGORY_LABEL).join(' / ') });
        return true;
      }
      repo.setCategory(id, body.category);
      done.push('分类 → ' + FEEDBACK_CATEGORY_LABEL[body.category]);
    }
    if (done.length === 0) { json(res, 400, { error: '没有要改的东西' }); return true; }
    ctx.log('管理后台处理了一条反馈', { id, done });
    json(res, 200, { ok: true, message: '反馈 #' + id + '：' + done.join('，'), view: feedbackView(ctx.db) });
    return true;
  }

  /*
   * ---------------- GM 管理（M2.50） ----------------
   *
   * 与数据编辑彻底分开：数据编辑改的是 src/data/*.yaml（内容，重启生效），
   * GM 改的是 data/game.db 里的玩家状态（立刻生效，玩家下一次说话就是新数值）。
   * 两件事的爆炸半径差得远，所以既不复用路由，也不复用那一套「重启后生效」的话术。
   */
  if (url === '/admin/api/gm/options' && req.method === 'GET') {
    /*
     * ⚠️ 统计数叫 counts，**不能叫 stats**：gmOptions() 里已经有一个 stats
     * （属性的定义：key / 中文名 / 上下界），展开之后再用同名键覆盖，
     * 前端拿到的就是一堆数字而不是数组 —— 它调用 .forEach 直接崩，而且页面照常渲染到那一步为止。
     */
    json(res, 200, { ...gmOptions(ctx.db), counts: gmStats(ctx.db) });
    return true;
  }

  /*
   * M2.68：**世界级**的 GM 写入 —— 势力之间的关系不属于任何一个玩家，
   * 所以它不挂在 /gm/players/<id>/... 下面。
   */
  if (url === '/admin/api/gm/power-relations' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const out = gmSetPowerRelation(ctx.db, body);
    if (out.ok) {
      ctx.log('GM 改了势力关系', { from: body['from'], to: body['to'], kind: body['kind'] });
      json(res, 200, out);
    } else {
      json(res, 400, out);
    }
    return true;
  }

  if (url.startsWith('/admin/api/gm/players')) {
    const rest = url.slice('/admin/api/gm/players'.length);
    const qs = url.indexOf('?') >= 0 ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : null;

    // 列表 / 搜索
    if (rest === '' || rest.startsWith('?')) {
      json(res, 200, { players: gmSearch(ctx.db, qs?.get('q') ?? '', 60), counts: gmStats(ctx.db) });
      return true;
    }

    const m = /^\/([^/?]+)(?:\/([a-z-]+))?$/.exec(rest);
    if (m !== null) {
      const id = decodeURIComponent(m[1]!);
      const action = m[2];
      if (action === undefined) {
        if (req.method !== 'GET') { json(res, 405, { error: '查详情用 GET' }); return true; }
        const detail = gmDetail(ctx.db, id);
        if (detail === null) { json(res, 404, { error: '找不到这个角色：' + id }); return true; }
        json(res, 200, detail);
        return true;
      }
      if (req.method !== 'POST') { json(res, 405, { error: '写操作用 POST' }); return true; }

      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      let out: GmResult;
      switch (action) {
        case 'stats': out = gmApplyStats(ctx.db, id, body as Partial<Record<StatKey, unknown>>); break;
        case 'pathway': out = gmSetPathway(ctx.db, id, body['pathway'], body['sequence']); break;
        case 'status': out = gmSetStatus(ctx.db, id, body['status']); break;
        case 'teleport': out = gmTeleport(ctx.db, id, body['cityId']); break;
        case 'inventory': out = gmInventory(ctx.db, id, body); break;
        case 'reset-daily': out = gmResetDaily(ctx.db, id); break;
        default: json(res, 404, { error: '没有这个 GM 操作：' + action }); return true;
      }
      if (out.ok) {
        ctx.log('GM 改了玩家数据', { character: id, action, message: out.message });
        json(res, 200, out);
      } else {
        json(res, 400, out);
      }
      return true;
    }
  }

  json(res, 404, { error: 'no such admin api' });
  return true;
}

/** 后台路由要挂的 .env 默认位置 */
export const ADMIN_ENV_PATH = (cwd: string): string => join(cwd, '.env');
