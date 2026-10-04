/**
 * QQ 官方机器人 access_token（交付物之一 —— src/adapter/qq-official/token.ts）
 *
 * 官方协议的第一步：用 AppID + AppSecret 换一个短命的 access_token，
 * 之后**所有** HTTP 调用（发消息）与 WebSocket 网关握手（identify）都用它。
 *
 * 三条设计约束：
 *
 *   1. **密钥不进代码**。真值只从 `process.env.QQ_BOT_APPID` / `process.env.QQ_BOT_SECRET` 读，
 *      落在 .env（已 gitignore）。本文件、日志、异常信息里都不出现 secret 本身 ——
 *      TokenError 只回显服务端的 code/message 与 HTTP 状态，回显不了密钥。
 *
 *   2. **到期前 60 秒刷新**。网关重连与被動回复都在用 token，若等它真过期再换，
 *      会出现「正好卡在过期那一秒」的偶发 401。留 60 秒余量，把这种噪声消掉。
 *
 *   3. **并发去重**。群里同时来三条消息，只应该换一次 token：
 *      用 in-flight promise 复用，否则官方换 token 的频次限制会被打满
 *      （打满后的表现是网关断连，排查起来很远）。
 *
 * 已知口径：
 *   - **失败响应（本机实测 2026-09-27）**：故意用假密钥请求
 *     bots.qq.com/app/getAppAccessToken，得到 HTTP 400 +
 *     `{"code":100002,"message":"internal err"}`。
 *     所以 TokenError 保留 code / httpStatus / raw 三样，排查时不必猜。
 *   - **`expires_in` 官方给的是字符串**（真密钥实测 2026-09-27：`"5929"`），
 *     不是数字。直接拿去算数会得到 NaN，进而「每次调用都刷新」——
 *     这里用 asNumber() 强制归一，数字与字符串两种都能吃。
 *
 * ⚠️ 一条踩过的坑，写下来免得重犯：
 *   用 PowerShell 的 `Set-Content -Encoding utf8` 写请求体、再交给 curl.exe 发，
 *   在 Windows PowerShell 5.1 下会写入 **UTF-8 BOM**。BOM 混进 JSON 后平台解析失败，
 *   返回的却是 `{"code":100002,"message":"internal err"}` —— 和「密钥错误」**长得一模一样**。
 *   我因此一度以为真密钥无效。**用 Node 的 fetch + JSON.stringify 发请求不会有这个问题。**
 */

import { NUMERIC } from '../../config/numeric.ts';

/**
 * 换 token 的端点，**按官方文档用 api.bot.qq.com**。
 *
 * 文档「获取访问凭证」写的是 `https://api.bot.qq.com/app/getAppAccessToken`。
 * 本机实测（2026-09-27）`bots.qq.com` 是它的等价别名：两个域名返回**同一个
 * access_token**，所以从任务书给的旧域名迁过来不影响任何东西。
 * 注意它和 api.sgroup.qq.com 不是一回事 —— 后者只用于调 API / 连网关。
 */
export const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';

/**
 * 官方文档「获取访问凭证 → 业务错误码」那张表。
 *
 * 单独列出来是因为官方明确说 message「仅用于人工排查，内容可能随时调整」——
 * 拿 message 做判断迟早会坏，判断一律用 code。
 */
const TOKEN_ERROR_HINT: Record<number, string> = {
  100001: '请求过于频繁，降低调用频率后重试',
  100007: 'AppID 无效，或机器人状态不正常（被封禁或已删除）',
  100016: 'AppID 或 ClientSecret 不正确',
  10004: 'AppID 对应的机器人不存在',
};

/** 默认提前刷新窗口（秒）。理由见文件头第 2 条 */
export const DEFAULT_REFRESH_AHEAD_SEC = 60;

export interface TokenConfig {
  appId: string;
  clientSecret: string;
  /** 提前多少秒认为「该刷新了」，默认 60 */
  refreshAheadSec?: number;
  timeoutMs?: number;
  /** 可注入时钟，便于测试过期行为（默认 Date.now） */
  now?: () => number;
  /** 可注入 fetch，便于在没有真密钥时验证缓存/刷新逻辑 */
  fetchImpl?: typeof fetch;
}

/** 换 token 失败。带服务端原始 code/message —— 排查时不需要猜 */
export class TokenError extends Error {
  readonly httpStatus: number | null;
  readonly code: number | null;
  readonly raw: string;

  constructor(message: string, opts: { httpStatus?: number | null; code?: number | null; raw?: string } = {}) {
    super(message);
    this.name = 'TokenError';
    this.httpStatus = opts.httpStatus ?? null;
    this.code = opts.code ?? null;
    this.raw = opts.raw ?? '';
  }
}

/**
 * 从环境变量读配置。
 *
 * 缺值时**启动即失败**而不是等第一次发消息才 401：
 * 「配置没填」和「平台拒绝」是两类完全不同的故障，不该长得一样。
 */
export function loadTokenConfig(env: NodeJS.ProcessEnv = process.env): TokenConfig {
  const appId = (env.QQ_BOT_APPID ?? '').trim();
  const clientSecret = (env.QQ_BOT_SECRET ?? '').trim();
  const missing: string[] = [];
  if (!appId) missing.push('QQ_BOT_APPID');
  if (!clientSecret) missing.push('QQ_BOT_SECRET');
  if (missing.length > 0) {
    throw new TokenError(
      `缺少环境变量 ${missing.join('、')}。把 .env.example 复制成 .env 并填真值，` +
        `然后用 \`node --env-file=.env ...\` 启动（.env 已被 gitignore，不要提交）。`,
    );
  }
  return { appId, clientSecret };
}

/** 日志用的脱敏串：保留前 4 后 4，中间打码。任何地方要打 token 都用它 */
export function maskToken(token: string | null | undefined): string {
  if (!token) return '(none)';
  if (token.length <= 12) return '***';
  return `${token.slice(0, 4)}...${token.slice(-4)}(len=${token.length})`;
}

interface TokenResponseLike {
  access_token?: unknown;
  expires_in?: unknown;
  code?: unknown;
  message?: unknown;
}

export class TokenManager {
  #config: TokenConfig;
  #token: string | null = null;
  /** 绝对到期时刻（ms）。0 = 没有可用的 token */
  #expiresAt = 0;
  /** 并发去重：同一时刻只有一个换 token 的请求在飞 */
  #inflight: Promise<string> | null = null;
  /** 观测：换过几次 token（真机联调时用来确认 60 秒窗口真的生效） */
  refreshes = 0;
  /** 主动续期的定时器（M2.75） */
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 主动续期连续失败次数。>0 说明下一次真要用 token 时会现换（可变慢，但不会错） */
  sweepFailures = 0;

  constructor(config: TokenConfig) {
    this.#config = config;
  }

  get appId(): string {
    return this.#config.appId;
  }

  #now(): number {
    return this.#config.now ? this.#config.now() : Date.now();
  }

  #aheadMs(): number {
    return (this.#config.refreshAheadSec ?? DEFAULT_REFRESH_AHEAD_SEC) * 1000;
  }

  /** 现在这个 token 还能不能用（留了提前刷新余量） */
  #usable(): boolean {
    return this.#token !== null && this.#now() < this.#expiresAt - this.#aheadMs();
  }

  /**
   * 拿一个可用的 token。缓存命中直接返回，否则换一个。
   * 并发调用共享同一个 in-flight 请求。
   */
  async get(): Promise<string> {
    if (this.#usable()) return this.#token as string;
    return this.#refreshShared();
  }

  /** 无条件换一个（网关拿到 401、主动续期、后台「验一次凭证」都走它） */
  async refresh(): Promise<string> {
    return this.#refreshShared();
  }

  /**
   * 换 token 的**唯一入口**：并发调用共享同一个 in-flight 请求（M2.75）。
   *
   * 早先 refresh() 是直接调 #refresh() 的，绕过了去重 ——
   * 于是「主动续期」与「一条消息发现 token 该换了」同时发生时就会换两次。
   * 官方对这个接口有频次限制（code 100001，打满之后的表现是网关断连），
   * 所以所有换 token 的路径都必须收敛到这一个函数上。
   */
  #refreshShared(): Promise<string> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#refresh().finally(() => {
      // 失败的 promise 绝不能留在 #inflight 里：否则后面每次调用都复现旧错误、
      // 再也不会重试 —— 一次网络抖动会变成永久故障。
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /**
   * **主动续期**（M2.75）：定时检查 token 是不是快到期了，是就提前换掉。
   *
   * ## 为什么不能只靠懒刷新
   *
   * 懒刷新的语义是「有人要用的时候才换」。运营期最典型的场景恰恰是**没人用**：
   * 深夜群里没人说话，token 悄悄过期；第二天早上第一条消息进来时，
   * 玩家要多等一次「换 token」的网络往返（正常几十毫秒，抖动时几秒）才能看到回执。
   * 主动续期把这一次往返挪到没人用的时候做掉。
   *
   * 失败**不抛异常**：续期是后台行为，没有一个「调用者」可以接这个异常，
   * 抛出去只会变成 unhandled rejection 把进程带走。失败留给下一轮再试，
   * 并把次数记在 sweepFailures 上（后台面板会显示）。
   */
  startAutoRefresh(onError?: (error: Error) => void): void {
    if (this.#sweepTimer !== null) return;
    this.#sweepTimer = setInterval(() => {
      void this.#sweep(onError);
    }, NUMERIC.qqBot.tokenSweepIntervalMs);
    // 定时器不该阻止进程退出（否则 CLI 与测试会挂住）
    this.#sweepTimer.unref?.();
  }

  stopAutoRefresh(): void {
    if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }

  /**
   * 「该换就换」—— 主动续期的实际动作，**公开**是为了让测试与后台能直接触发
   * （不然只能等 5 分钟的定时器，那没法写成用例）。
   *
   * @returns 是否真的换了 token（false = 还够用，什么都没做）
   */
  async refreshIfStale(): Promise<boolean> {
    const remainingMs = this.#expiresAt - this.#now();
    // 还有很久才到期：什么都不做（一次本地时间比较，不产生网络请求）
    if (this.#token !== null && remainingMs > NUMERIC.qqBot.tokenProactiveRefreshMs) return false;
    await this.refresh();
    this.sweepFailures = 0;
    return true;
  }

  /** 定时器那一层：失败不抛（没有调用者能接），只记次数并回调 */
  async #sweep(onError?: (error: Error) => void): Promise<void> {
    try {
      await this.refreshIfStale();
    } catch (error) {
      this.sweepFailures += 1;
      onError?.(error as Error);
    }
  }

  /** 作废当前 token：下次 get() 会重新换 */
  invalidate(): void {
    this.#token = null;
    this.#expiresAt = 0;
  }

  /** 观测快照。**不含 token 本身** */
  snapshot(): {
    appId: string;
    hasToken: boolean;
    remainingSec: number | null;
    refreshes: number;
    autoRefresh: boolean;
    sweepFailures: number;
  } {
    return {
      appId: this.#config.appId,
      hasToken: this.#token !== null,
      remainingSec: this.#token === null ? null : Math.round((this.#expiresAt - this.#now()) / 1000),
      refreshes: this.refreshes,
      // 主动续期开着没有：后台面板要能看见（关着的话「token 会不会过期」就是个运营要关心的问题）
      autoRefresh: this.#sweepTimer !== null,
      sweepFailures: this.sweepFailures,
    };
  }

  /** 给 Authorization 用的头值。官方前缀是 `QQBot `，不是 Bearer */
  async authorization(): Promise<string> {
    return `QQBot ${await this.get()}`;
  }

  async #refresh(): Promise<string> {
    const fetchImpl = this.#config.fetchImpl ?? fetch;
    const timeoutMs = this.#config.timeoutMs ?? 10_000;

    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appId: this.#config.appId,
          clientSecret: this.#config.clientSecret,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TokenError(`换 access_token 请求失败（未拿到 HTTP 响应）：${(error as Error).message}`);
    }

    const raw = await response.text();
    let parsed: TokenResponseLike | null = null;
    try {
      parsed = raw ? (JSON.parse(raw) as TokenResponseLike) : null;
    } catch {
      parsed = null;
    }

    /*
     * ⚠️ **先看业务 code，再看 HTTP 状态码** —— 顺序绝不能反。
     *
     * 官方文档（开发文档 → 获取访问凭证）原话：
     *   「该接口的业务错误通过响应体的 code 返回，**即使调用失败，HTTP 返回码仍为 200**。
     *     请优先依据 code 判断请求是否成功，不要只依赖 HTTP 返回码；
     *     也不要依据 message 判定错误类型。」
     *
     * 早先的版本先判 `!response.ok`。后果是「HTTP 200 + code 100016（密钥错）」
     * 会一路掉到下面那句「响应里没有 access_token 字段」—— 报出来的是**假错误**，
     * 真正的错误码被丢掉，排查方向整个带偏。这正是文档点名要避免的写法。
     */
    const code = asNumber(parsed?.code);
    if (code !== null && code !== 0) {
      throw new TokenError(
        `换 access_token 被拒：code=${code}（${TOKEN_ERROR_HINT[code] ?? '未知错误码'}）` +
          ` message=${String(parsed?.message ?? '')} HTTP=${response.status}`,
        { httpStatus: response.status, code, raw },
      );
    }

    if (!response.ok) {
      throw new TokenError(
        `换 access_token 失败：HTTP ${response.status}，原始响应 ${raw.slice(0, 200)}`,
        { httpStatus: response.status, code, raw },
      );
    }

    const token = typeof parsed?.access_token === 'string' ? parsed.access_token : '';
    if (!token) {
      throw new TokenError(
        `换 access_token 返回 HTTP ${response.status} 但没有 access_token 字段，原始响应：${raw.slice(0, 300)}`,
        { httpStatus: response.status, code, raw },
      );
    }

    // expires_in 官方给字符串，这里强制归一。拿不到就按 3600 秒保守估
    const expiresInSec = asNumber(parsed?.expires_in) ?? 3600;
    this.#token = token;
    this.#expiresAt = this.#now() + expiresInSec * 1000;
    this.refreshes += 1;
    return token;
  }
}

/** 把 "7200" / 7200 / "abc" 统一成数字或 null */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * CLI：`node --env-file=.env src/adapter/qq-official/token.ts`
 * 手动验证「钥匙对不对」这一步，输出永远不含 token 明文。
 * ------------------------------------------------------------------ */
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const config = loadTokenConfig();
  const manager = new TokenManager(config);
  const token = await manager.get();
  console.log(JSON.stringify({
    ok: true,
    appId: config.appId,
    token: maskToken(token),
    expiresInSec: manager.snapshot().remainingSec,
    refreshes: manager.refreshes,
    // 再取一次：应该命中缓存、refreshes 不变。这就是「缓存 + 提前刷新」的现场证明
    secondCall: maskToken(await manager.get()),
    refreshesAfterSecondCall: manager.refreshes,
  }, null, 2));
}
