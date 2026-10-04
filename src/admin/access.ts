/**
 * 「服务与访问」的服务端（M2.82）。
 *
 * ## 这一屏解决什么问题
 *
 * 后台原来只有**本机**好用：口令写在 .env 里、改完得重启进程；监听地址是
 * `server.listen(port)`（不写 host ⇒ 绑所有接口），于是它**其实已经**从局域网可达 ——
 * 而界面上没有任何地方说过这件事，也没有地方能把它收回来。
 *
 * 现在把「谁能访问」和「拿什么访问」摆到一屏上：口令、监听地址、端口、公网地址、
 * 是否信任反代。
 *
 * ## 与适配器面板同一条纪律：磁盘上的 ≠ 进程在用的
 *
 * 每一行都分开列，并且写清「改完怎么生效」：
 *
 *   口令            —— **立刻**。签名密钥由口令派生，旧 token 当场全失效。
 *   监听地址 / 端口 —— **必须重启**。listen 已经绑上了，热改不了。
 *   公网地址 / 反代 —— 立刻。
 *
 * 把「必须重启」写成「已保存」是这一屏最容易犯的错：运营改完看见绿字，
 * 以为生效了，然后对着一个没变的行为查半天。
 *
 * ## 公网暴露的三件配套
 *
 * 绑到 0.0.0.0 之前必须先有三样东西，否则等于把「能改玩家数值、能改 AppSecret」
 * 的入口挂到网上：
 *
 *   1. **登录失败限流**（createLoginGuard）—— 原来一次都没有，可以无限爆破；
 *   2. **审计日志记真实 IP**（clientIp）—— 原来写死 'local'，公网上出了事查不到人；
 *   3. **口令强度下限**（checkPasswordStrength）—— 随机生成的那个够强，
 *      但运营自己设的可能是 123456。
 *
 * 这三样都在本文件里，都能单独测。
 */
import { envGet, envSet, maskSecret, readEnv, writeEnv } from './env.ts';

/**
 * 后台口令的长度下限。
 *
 * 12 位不是拍脑袋：这一屏的口令要挡的是**公网上无人值守的爆破**，
 * 而 8 位纯小写在现代显卡下是分钟级的事。12 位混合字符把成本抬到不可行的量级，
 * 同时又短到能被人抄在纸上（把后台地址和口令抄给同事是真实场景）。
 */
export const PASSWORD_MIN = 12;

/**
 * 口令长度**上限**（M2.86）。
 *
 * 下限已于本轮放宽（见 `checkPasswordStrength`：用户要求「几位数都行」），
 * 上限则是唯一的硬约束 —— 口令会进签名 cookie，超长会把请求头撑爆。
 */
export const PASSWORD_MAX = 128;

/**
 * 口令够不够强。返回中文原因，null 表示通过。
 *
 * ⚠️ 这条**只在设置时**校验，不在登录时校验 —— 老口令可能不满足新规则，
 * 一升级就把主人挡在门外是最糟的一种「安全」。
 */
export function checkPasswordStrength(pw: string): string | null {
  /*
   * M2.86：**放宽到「非空即可」**（用户拍板：「密码要求别那么复杂，几位数都行」）。
   *
   * 原来这里有四道门：至少 `PASSWORD_MIN` 位、不许纯数字、不许同一字符重复、
   * 不许出现 password/admin/123456 这类词。
   *
   * 那套规则挡的是**公网爆破**，但这个后台默认只监听本机/内网，
   * 而真正防爆破的是 `loginGuard`（连续失败就锁一段时间）—— **长度门槛的边际收益很小**。
   * 代价却是实打实的：自己想设的口令设不上，于是人会去设一个更长的弱口令，
   * 或者干脆把口令写在便签上。**被规则逼出来的口令不会比用户自己选的好。**
   *
   * 所以只留两条硬约束：
   *   · **不能为空**（空口令在登录口本身就被拒，但设置时早点说清楚）；
   *   · **不能超长**（会把签名 cookie 撑爆，那是真的会坏）。
   *
   * 在**内网/本机**场景下，1 位口令的风险主要来自「别人也能访问这个端口」——
   * 那个问题该靠绑定地址与 `access.ts` 里的网段限制解决，不该靠难为用户。
   */
  if (pw.length === 0) return '口令不能是空的';
  if (pw.length > PASSWORD_MAX) return '口令太长了（最多 ' + PASSWORD_MAX + ' 位）';
  return null;
}

/* ================================================================== *
 * 登录失败限流
 * ================================================================== */

export interface LoginGuard {
  /** 现在能不能试这一下；不能就给出还要等多久 */
  check(ip: string, now: number): { ok: true } | { ok: false; retryAfterMs: number };
  /** 记一次失败（由它决定下一次要等多久） */
  fail(ip: string, now: number): void;
  /** 记一次成功：这个 IP 的记录清零 */
  ok(ip: string): void;
  /** 现在有哪些 IP 正在被挡（给面板看，也用来解释「为什么我进不去」） */
  snapshot(now: number): Array<{ ip: string; fails: number; retryAfterMs: number }>;
}

/**
 * 登录失败限流（M2.82）。
 *
 * ### 为什么是「指数退避」而不是「错 3 次锁死」
 *
 * 锁死有一个难看的副作用：**任何人都能故意锁住主人**。
 * 在公网上，攻击者只要打三次错口令，你和你的运营同事就都进不去了 ——
 * 一个「防爆破」的措施变成了拒绝服务。
 *
 * 指数退避两头都顾：打错一两次几乎无感（手滑是常态），
 * 而到第 10 次时每次要等好几分钟，爆破在时间上不可行。
 *
 * ### 数字
 *
 * 前 5 次不锁（free）—— 打错字、复制少一位、换了个键盘，都在这个范围里；
 * 之后每多错一次等待翻倍：1s → 2 → 4 → … 上限 15 分钟。
 * 上限是必要的：不封顶的话，几十次之后等待会长到「这辈子别想进」。
 *
 * ### 内存态
 *
 * 存在进程内存里，**重启就清空**。接受这个代价：落库要写一张只有安全用途的表，
 * 而能做到重启的人本来就已经拿到机器了 —— 到那一步限流不是主要防线。
 */
export function createLoginGuard(
  opts: { free?: number; baseMs?: number; maxMs?: number } = {},
): LoginGuard {
  const free = opts.free ?? 5;
  const baseMs = opts.baseMs ?? 1000;
  const maxMs = opts.maxMs ?? 15 * 60 * 1000;
  const seen = new Map<string, { fails: number; until: number; at: number }>();
  const retryOf = (fails: number): number => {
    if (fails <= free) return 0;
    return Math.min(maxMs, baseMs * Math.pow(2, fails - free - 1));
  };
  const prune = (now: number): void => {
    // 一小时没再有动作的记录直接丢掉：不然这张 Map 会随扫描流量无限长
    for (const [ip, r] of seen) if (now - r.at > 3600_000) seen.delete(ip);
  };
  return {
    check(ip, now) {
      const r = seen.get(ip);
      if (r === undefined) return { ok: true };
      const left = r.until - now;
      return left > 0 ? { ok: false, retryAfterMs: left } : { ok: true };
    },
    fail(ip, now) {
      prune(now);
      const r = seen.get(ip) ?? { fails: 0, until: 0, at: now };
      r.fails += 1;
      r.at = now;
      r.until = now + retryOf(r.fails);
      seen.set(ip, r);
    },
    ok(ip) { seen.delete(ip); },
    snapshot(now) {
      prune(now);
      return [...seen.entries()]
        .map(([ip, r]) => ({ ip, fails: r.fails, retryAfterMs: Math.max(0, r.until - now) }))
        .filter((x) => x.retryAfterMs > 0)
        .sort((a, b) => b.retryAfterMs - a.retryAfterMs);
    },
  };
}

/**
 * 这条请求是从哪个 IP 来的（M2.82）。
 *
 * ⚠️ `x-forwarded-for` **可以伪造** —— 谁都能带一个这样的头进来。
 * 只有在「这台机器前面确实有一层自己配置的反向代理」时才该信它，
 * 所以默认不信（trustProxy 必须显式打开）。
 *
 * 信错的后果不是「日志难看」：审计里会写满攻击者编的 IP，
 * 而限流会按那个假 IP 记账 —— 等于给爆破开了一条「每次都换个身份」的路。
 */
export function clientIp(
  req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } },
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const raw = req.headers['x-forwarded-for'];
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (typeof first === 'string' && first.trim().length > 0) {
      // 反代链是「客户端, 代理1, 代理2」—— 最左边那个才是最初的客户端
      return (first.split(',')[0] ?? '').trim() || 'unknown';
    }
  }
  const addr = req.socket?.remoteAddress ?? '';
  // ::ffff:127.0.0.1 是 IPv4 映射地址，还原成人看得懂的样子
  if (addr.startsWith('::ffff:')) return addr.slice(7);
  return addr.length > 0 ? addr : 'unknown';
}

/**
 * 这一屏管哪几个键 —— **唯一出处**。
 *
 * 读（readAccess）和写（writeAccessKey）都从它取，所以不可能出现
 * 「界面上有这一项、保存时说不认识」或者反过来的情况。
 */
export interface AccessKeySpec {
  key: string;
  label: string;
  /** 改完怎么生效 —— 界面上要照着它写，不能一律说「已保存」 */
  apply: 'now' | 'restart';
  /** 密钥：界面用 password 框，且不回显原文 */
  secret: boolean;
  hint: string;
}

export const ACCESS_KEYS: AccessKeySpec[] = [
  {
    key: 'ADMIN_PASSWORD', label: '后台口令', apply: 'now', secret: true,
    hint: '进后台用的口令。改完**立刻**生效 —— 包括你自己在内的所有人都会掉线，要重新登录',
  },
  {
    key: 'HOST', label: '监听地址', apply: 'restart', secret: false,
    hint: '服务绑在哪张网卡上。127.0.0.1 = 只有本机能进；0.0.0.0 = 本机 + 局域网 +（路由器放行的话）公网。改完**必须重启进程**才生效',
  },
  {
    key: 'PORT', label: '端口', apply: 'restart', secret: false,
    hint: '服务端口。改完必须重启进程；重启之前先确认新端口没被别的程序占用、防火墙也放行了',
  },
  {
    key: 'CARD_PUBLIC_BASE_URL', label: '公网地址', apply: 'now', secret: false,
    hint: '卡片图片对外用的地址（反向代理 / 内网穿透）。留空 = 图片只在机器人这边生成，不对外发链接',
  },
  /*
   * 通道凭证（M2.82）。
   *
   * QQ 官方那两个（AppID / AppSecret）在适配器面板里 —— 那边能热改 + 重连网关，
   * 做得比这里好。OneBot 这两个没有那样的通路：适配器只在建连时读一次，
   * 所以它们只能在这里改，而且**改完要重启**。
   *
   * 放在这一屏而不是适配器页，是因为「改完要重启」这件事在这里有地方说 ——
   * 适配器页那一套（改完立刻重连）的表达力反而会把它说错。
   */
  {
    key: 'ONEBOT_TOKEN', label: 'OneBot 访问令牌', apply: 'restart', secret: true,
    hint: '协议端的 access_token。反向 HTTP 模式下协议端要带上它，它同时也是 /onebot/event 的鉴权。改错 = 收不到任何消息，且日志里只有 401',
  },
  {
    key: 'ONEBOT_WS_TOKEN', label: 'OneBot WS 令牌', apply: 'restart', secret: true,
    hint: '正向 WebSocket（协议端连过来）用的 access_token。没开 WS 通道就留空',
  },
  {
    key: 'ADMIN_TOKEN', label: '运维接口令牌', apply: 'restart', secret: true,
    hint: 'POST /admin/tick 这类运维端点用的 x-admin-token（给脚本和压测工具，不是给浏览器）。留空则退回 OneBot 访问令牌',
  },
  {
    key: 'TRUST_PROXY', label: '信任反向代理', apply: 'now', secret: false,
    hint: '前面有自己配的反向代理时才开。开了才认 X-Forwarded-For 里的来访 IP —— 不开，审计日志记的是代理的地址；乱开，记的是攻击者自己编的地址',
  },
];

export interface AccessField extends AccessKeySpec {
  /** 磁盘上的值（密钥已打码） */
  disk: string;
  /** 进程此刻在用的值（密钥已打码） */
  running: string;
  same: boolean;
}

export interface AccessReach {
  scope: string;
  url: string;
  note: string;
}

export interface AccessStatus {
  fields: AccessField[];
  /** 现在从哪些地址进得来 —— 这是「公网 / 局域网访问」最直接的答案 */
  reach: AccessReach[];
  warnings: string[];
  loginFails: Array<{ ip: string; fails: number; retryAfterMs: number }>;
}

export interface AccessDeps {
  envPath: string;
  /** 进程**此刻**在每个键上的值（磁盘上那个可能还没生效） */
  running: Record<string, string>;
  /** 本机的局域网 IPv4（调用方从 os.networkInterfaces 取，保持这里可测） */
  lanIps: string[];
  guard: LoginGuard;
  now: number;
}

/** 服务实际绑在哪（不是 .env 里写的那个） */
const listeningOf = (deps: AccessDeps): { host: string; port: number } => ({
  host: deps.running['HOST'] ?? '',
  port: Number(deps.running['PORT'] ?? 0),
});

/** 绑在回环上吗（只认本机） */
export const isLoopbackOnly = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1';

/** 现在从哪些地址进得来 */
function reachOf(deps: AccessDeps): AccessReach[] {
  const { host, port } = listeningOf(deps);
  const out: AccessReach[] = [{
    scope: '本机', url: 'http://127.0.0.1:' + port + '/admin',
    note: '只有这台机器上的浏览器能打开',
  }];
  /*
   * 绑在回环上时，下面几条**不成立** —— 这是整屏最要紧的一条信息：
   * 运营以为自己在公网上（或者以为很安全），而事实正好相反。
   */
  if (!isLoopbackOnly(host)) {
    if (deps.lanIps.length === 0) {
      out.push({ scope: '局域网', url: '（没找到局域网地址）', note: '这台机器可能只有回环网卡' });
    }
    for (const ip of deps.lanIps) {
      out.push({ scope: '局域网', url: 'http://' + ip + ':' + port + '/admin', note: '同一个路由器下面的设备都能打开' });
    }
  }
  const pub = deps.running['CARD_PUBLIC_BASE_URL'] ?? '';
  if (pub.length > 0) {
    out.push({
      scope: '公网', url: pub.replace(/\/+$/, '') + '/admin',
      note: '按「公网地址」那一项推出来的；确认那个域名真的指到这台机器',
    });
  } else if (!isLoopbackOnly(host)) {
    out.push({
      scope: '公网', url: '（未配置公网地址）',
      note: '绑在 ' + host + ' 上，能不能从公网进来取决于路由器的端口转发与防火墙',
    });
  }
  return out;
}

/**
 * 绑到非回环地址时必须说的话。
 *
 * 这些不是客套的「注意安全」—— 每一条都对应一个**这台服务此刻真实存在**的缺口，
 * 而且不写出来就没人会想到。
 */
function warningsOf(deps: AccessDeps): string[] {
  const { host } = listeningOf(deps);
  if (isLoopbackOnly(host)) return [];
  const out: string[] = [
    '服务绑在 ' + host + ' 上：本机以外的设备可以访问后台，口令是唯一的门。',
    '后台走的是 http，**口令在网络上不加密**。要暴露到公网，请在前面加一层反向代理并配 https，' +
      '再把「信任反向代理」打开，否则审计日志记不到真实来访 IP。',
    '管理后台能改玩家数值、能改 AppSecret。没有 https 就不要直接把它挂到公网上。',
  ];
  const weak = checkPasswordStrength(deps.running['ADMIN_PASSWORD'] ?? '');
  if (weak !== null) out.push('当前口令不满足强度要求：' + weak);
  const fails = deps.guard.snapshot(deps.now);
  if (fails.length > 0) {
    const top = fails[0]!;
    out.push('有 ' + fails.length + ' 个来源正在被登录限流挡着（最近失败最多的是 ' +
      top.ip + '，已错 ' + top.fails + ' 次）—— 先确认那是不是你自己的手滑。');
  }
  return out;
}

/** 这一屏的全部内容 */
export function readAccess(deps: AccessDeps): AccessStatus {
  const file = readEnv(deps.envPath);
  const fields = ACCESS_KEYS.map((spec): AccessField => {
    const diskRaw = envGet(file, spec.key) ?? '';
    const runRaw = deps.running[spec.key] ?? '';
    const show = (v: string): string => (spec.secret ? maskSecret(v) : v) || '（没设）';
    return {
      ...spec,
      disk: show(diskRaw),
      running: show(runRaw),
      /*
       * 比的是**原值**而不是打码后的字符串：打码是定长的，两个不同的长密钥
       * 可能打出一模一样的星号串，那样「有没有生效」就判错了。
       */
      same: diskRaw === runRaw,
    };
  });
  return {
    fields,
    reach: reachOf(deps),
    warnings: warningsOf(deps),
    loginFails: deps.guard.snapshot(deps.now),
  };
}

/** 一次改动的结果 */
export interface AccessWriteResult {
  changed: string;
  apply: 'now' | 'restart';
  /** 给界面看的一句话 */
  message: string;
}

/**
 * 改一项配置。
 *
 * 只写 .env，**不**负责让进程用上它 —— 那是调用方的事（口令能立刻换，监听地址不能）。
 * 这样切开是因为「写磁盘」和「让进程生效」的失败方式完全不同：
 * 前者是权限问题，后者是「这个值什么时候被读」的问题。
 */
export function writeAccessKey(
  envPath: string, key: string, value: string,
): AccessWriteResult {
  const spec = ACCESS_KEYS.find((f) => f.key === key);
  if (spec === undefined) throw new Error('没有这一项配置：' + key);
  const v = value.trim();
  if (key === 'ADMIN_PASSWORD') {
    const bad = checkPasswordStrength(v);
    if (bad !== null) throw new Error(bad);
  }
  if (key === 'PORT') {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('端口必须是 1—65535 之间的整数');
  }
  /*
   * HOST 只放 IP 或主机名。**不校验它是不是本机网卡** —— 那要枚举网卡，
   * 而「填了一个这台机器没有的地址」的后果是进程起不来，那是一个响亮的失败，
   * 比在这里猜要诚实。
   */
  if (key === 'HOST' && v.length > 0 && !/^[0-9a-fA-F.:]+$/.test(v) && !/^[a-zA-Z0-9.-]+$/.test(v)) {
    throw new Error('监听地址只能填 IP 或主机名（0.0.0.0 / 127.0.0.1 / 一张网卡的地址）');
  }
  if (key === 'CARD_PUBLIC_BASE_URL' && v.length > 0 && !/^https?:\/\//.test(v)) {
    throw new Error('公网地址要以 http:// 或 https:// 开头');
  }
  const file = readEnv(envPath);
  envSet(file, key, v);
  writeEnv(envPath, file);
  return {
    changed: spec.label,
    apply: spec.apply,
    message: spec.apply === 'now'
      ? spec.label + '已改，立刻生效'
      : spec.label + '已写进 .env —— 要重启进程才生效',
  };
}
