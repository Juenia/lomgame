/**
 * QQ 官方通道的**登录体检**（M2.75）
 *
 * ## 为什么单独一个文件
 *
 * 「机器人不理人」在玩家那边只有一种症状，成因却有五大类，而它们的处理方式完全不同：
 *
 *   1. **配置错**（AppID / Secret 没填、填反了）—— 改 .env，重启；
 *   2. **凭证被拒**（code 100016 / 100007）—— 去开放平台核对，改 .env；
 *   3. **配额烧光**（session_start_limit.remaining = 0）—— 今天连不上了，等重置；
 *   4. **网关没连上**（网络 / 代理 / 平台抖动）—— 等一会儿，或看 close code；
 *   5. **连上了但事件不来**（intents 没申请、群没加进沙箱）—— 改开放平台配置。
 *
 * 在那之前，这五类只能靠人手工 curl 去分辨；上线备战期最需要的就是
 * **一条命令、三十秒内说清是哪一类**。这个文件就是那条命令。
 *
 * ## 三步体检（都是只读 GET，不改任何状态）
 *
 *   token       换一个可用的 access_token（走 TokenManager，可能命中缓存）
 *   identity    GET /users/@me        → 机器人是谁（顺带证明 token 真能用）
 *   gateway-bot GET /gateway/bot      → 网关地址 + **今天的 identify 配额** + 推荐分片数
 *   配额判定     把 remaining 与阈值比一下（阈值在 NUMERIC.qqBot）
 *   最近关闭     读网关统计里最后一次 close code，翻成中文处置建议
 *
 * ⚠️ 体检**不主动连网关**。连一次会消耗一次 identify 配额，还会把进程里
 * 正在用的那条连接挤掉 —— 体检的职责是「看」，不是「试」。
 *
 * ## 一条踩过的坑（写在这里免得重犯）
 *
 * 平台把业务错误放在响应体的 err_code 里，**HTTP 状态码可能仍是 200**。
 * 所以本文件所有 GET 都沿用 #post 的判定顺序：**先 err_code，后 HTTP**。
 * 只看 HTTP 会把「200 + err_code=11244」这类判成成功，然后在上层某处
 * 报一个毫不相干的错（历史上就是这么把「密钥错」显示成「响应里没有 access_token」的）。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { maskToken, TokenError } from './token.ts';
import { closeCodeHint, type GatewayStats } from './gateway.ts';

/** GET /users/@me 的响应（官方文档「获取当前用户信息」） */
export interface BotIdentity {
  id: string;
  username: string;
  avatar: string | null;
}

/**
 * GET /gateway/bot 的响应。
 *
 * session_start_limit 是**每次 identify 消耗一次**的日配额（真机实测 total=1500）。
 * reset_after 官方单位是毫秒（真机实测 86400000 = 24 小时）。
 */
export interface SessionLimit {
  total: number;
  remaining: number;
  resetAfterMs: number;
  maxConcurrency: number | null;
}

export interface GatewayBotInfo {
  url: string | null;
  shards: number | null;
  sessionLimit: SessionLimit | null;
}

export type LoginStepStatus = 'ok' | 'warn' | 'fail';

export interface LoginStep {
  id: string;
  /** 中文步骤名（后台与日志都直接显示它） */
  label: string;
  status: LoginStepStatus;
  detail: string;
}

export interface LoginReport {
  ok: boolean;
  at: number;
  durationMs: number;
  appId: string;
  apiBase: string;
  sandbox: boolean;
  steps: LoginStep[];
  identity: BotIdentity | null;
  gatewayBot: GatewayBotInfo | null;
  /** 一句话结论（后台按钮回执、启动日志都用它） */
  verdict: string;
  /** 下一步该做什么（按顺序） */
  advice: string[];
  /** 脱敏后的 token，只用于确认「换到的是同一个 token」 */
  tokenMasked: string;
}

/** 换 token 的错误码 → 中文处置。与 token.ts 的 TOKEN_ERROR_HINT 互补：那张表说「是什么」，这张说「怎么办」 */
const TOKEN_CODE_ADVICE: Record<number, string> = {
  100001: '换 token 被限频。等一分钟再试；反复出现就查是不是有多个进程用同一个 AppID 在跑。',
  100007: 'AppID 无效，或机器人状态不正常（被封禁 / 已删除）。去 QQ 开放平台确认机器人还在。',
  100016: 'AppID 与 AppSecret 不匹配。核对 .env 的 QQ_BOT_APPID / QQ_BOT_SECRET（Secret 重置过就要同步改）。',
  10004: 'AppID 对应的机器人不存在。核对 AppID 是不是机器人详情页那一个。',
};

/** HTTP 状态 → 中文处置（只用于「响应体里没有可用 err_code」的情况） */
const HTTP_ADVICE: Record<number, string> = {
  401: '平台拒绝了这个 access_token。先核对 AppID / Secret 是否配套，再确认机器人没有被下架。',
  403: '权限不足。去开放平台确认机器人已上架，且群消息 / 私聊消息权限已申请通过。',
  404: '接口或机器人不存在。确认 apiBase 是正式还是沙箱（两者不能混用同一条链路）。',
  429: '被平台限流。降频后重试。',
};

/** 体检过程中任何一步的 HTTP 失败 */
export class LoginHttpError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly path: string;
  readonly raw: string;
  readonly traceId: string | null;
  readonly advice: string | null;

  constructor(
    message: string,
    opts: { status?: number; code?: number | null; path?: string; raw?: string; traceId?: string | null; advice?: string | null } = {},
  ) {
    super(message);
    this.name = 'LoginHttpError';
    this.status = opts.status ?? 0;
    this.code = opts.code ?? null;
    this.path = opts.path ?? '';
    this.raw = opts.raw ?? '';
    this.traceId = opts.traceId ?? null;
    this.advice = opts.advice ?? null;
  }
}

export interface LoginCheckConfig {
  appId: string;
  apiBase: string;
  /** 由调用方给（通常是 TokenManager.get 的绑定），体检自己不缓存 token */
  tokenProvider: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** 只读网关统计（拿最后一次 close code）。不给就跳过这一步 */
  gatewayStats?: () => GatewayStats;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 网络层失败的自动重试次数与间隔（M2.99）。
 *
 * ⚠️ 现场（真机）：服务每次启动，体检都可能报
 * `/users/@me 请求失败（未拿到 HTTP 响应）：fetch failed`，
 * 而**同一时刻**在同一个 shell 里用同一份凭据手调 `/users/@me` 是 200 ——
 * 链路是好的，失败的是**启动瞬间那一次**（并发建连时的抖动）。
 *
 * 一次抖动被写成「登录链路有问题」，代价不是少个数字：它会把排查方向整个带偏
 * （去查 AppID / 权限 / 网络，而真凶只是时序）。所以这里重试；
 * HTTP 层与业务错误码**不重试** —— 那些是确定性结论，重试只是浪费时间。
 */
const NETWORK_RETRIES = 2;
const NETWORK_RETRY_DELAY_MS = 400;

/** 带网络层重试的 GET：只有「没拿到 HTTP 响应」才重试（见上面 NETWORK_RETRIES 的说明） */
async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  appId: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  let failure: unknown = null;
  for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt += 1) {
    try {
      return await fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: 'QQBot ' + token,
          ...(appId ? { 'x-union-appid': appId } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      failure = error;
      // 最后一次就别等了：下面的 catch 会把真正的原因（cause / 超时）说清楚
      if (attempt < NETWORK_RETRIES) await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS));
    }
  }
  throw failure;
}

/** 一步 GET：判定顺序与 #post 一致（先 err_code，后 HTTP） */
async function getJson(
  base: string,
  path: string,
  token: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; appId?: string },
): Promise<Record<string, unknown>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? NUMERIC.qqBot.checkTimeoutMs;
  const url = base.replace(/\/+$/, '') + path;

  let response: Response;
  try {
    // M2.99：启动瞬间建连抖动会误报「链路有问题」，所以这一层带重试（见 fetchWithRetry）
    response = await fetchWithRetry(fetchImpl, url, token, opts.appId, timeoutMs);
  } catch (error) {
    /*
     * 连不上和「连上了被拒」是两类故障，这里必须分开说。
     *
     * ⚠️ M2.99：**把 cause 与超时一起写出来**。
     * 原来只有一句 `fetch failed`，而 undici 把真正的原因藏在 `error.cause` 里
     * （ECONNRESET / ETIMEDOUT / ENOTFOUND …）—— 于是「平台侧瞬时断连」与
     * 「本机 DNS 挂了」在面板上是同一句话，只能靠猜。实测（真机）：
     * 同样一条体检失败，用不同机器/不同时刻复现时结论完全相反。
     */
    const name = (error as Error).name;
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    const why = name === 'TimeoutError'
      ? '超过 ' + timeoutMs + 'ms 没有响应'
      : (detail ? 'cause=' + detail : (error as Error).message);
    throw new LoginHttpError(
      path + ' 请求失败（未拿到 HTTP 响应）：' + (error as Error).message + '（' + why + '）',
      {
        path,
        advice:
          why + '。这是一次**没有拿到 HTTP 响应**的网络层失败，不是平台拒绝；' +
          '单次出现多半是瞬时故障，重启或稍后自行恢复。' +
          '若反复出现，再查 DNS / 代理 / 防火墙，或换一台机器试。',
      },
    );
  }

  const raw = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const traceId = (typeof parsed?.trace_id === 'string' ? parsed.trace_id : null) ?? response.headers.get('X-Tps-trace-ID');
  const code = asNumber(parsed?.err_code) ?? asNumber(parsed?.code);

  if (code !== null && code !== 0) {
    throw new LoginHttpError(
      path + ' 被拒：err_code=' + code + ' message=' + String(parsed?.message ?? '') + ' HTTP=' + response.status,
      { status: response.status, code, path, raw, traceId, advice: TOKEN_CODE_ADVICE[code] ?? null },
    );
  }
  if (!response.ok) {
    throw new LoginHttpError(
      path + ' 失败：HTTP ' + response.status + '，原始响应 ' + raw.slice(0, 200),
      { status: response.status, code, path, raw, traceId, advice: HTTP_ADVICE[response.status] ?? null },
    );
  }
  return parsed ?? {};
}

/** 机器人是谁。顺带证明这个 token 真的能用来调 API（换得到 ≠ 用得了） */
export async function fetchBotIdentity(
  apiBase: string,
  token: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; appId?: string } = {},
): Promise<BotIdentity> {
  const d = await getJson(apiBase, '/users/@me', token, opts);
  return {
    id: typeof d.id === 'string' ? d.id : '',
    username: typeof d.username === 'string' ? d.username : '',
    avatar: typeof d.avatar === 'string' && d.avatar ? d.avatar : null,
  };
}

/** 网关地址 + 今日 identify 配额 + 推荐分片数 */
export async function fetchGatewayBot(
  apiBase: string,
  token: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; appId?: string } = {},
): Promise<GatewayBotInfo> {
  const d = await getJson(apiBase, '/gateway/bot', token, opts);
  const limit = (d.session_start_limit ?? null) as Record<string, unknown> | null;
  return {
    url: typeof d.url === 'string' && d.url ? d.url : null,
    shards: asNumber(d.shards),
    sessionLimit: limit
      ? {
          total: asNumber(limit.total) ?? 0,
          remaining: asNumber(limit.remaining) ?? 0,
          resetAfterMs: asNumber(limit.reset_after) ?? 0,
          maxConcurrency: asNumber(limit.max_concurrency),
        }
      : null,
  };
}

/** 把 ms 说成人话：「约 3.2 小时后重置」 */
export function humanizeMs(ms: number): string {
  if (ms <= 0) return '即将重置';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return '约 ' + minutes + ' 分钟后重置';
  return '约 ' + (minutes / 60).toFixed(1) + ' 小时后重置';
}

/**
 * 跑一次完整登录体检。
 *
 * **任何一步失败都不抛异常** —— 它返回一份带失败步骤的报告。
 * 理由：这是给运营点的按钮，抛异常只会得到一句红字；而运营需要的是
 * 「哪一步、为什么、接下来干什么」三件事。
 */
export async function runLoginCheck(config: LoginCheckConfig): Promise<LoginReport> {
  const now = config.now ? config.now() : Date.now();
  const started = now;
  const steps: LoginStep[] = [];
  const advice: string[] = [];
  let identity: BotIdentity | null = null;
  let gatewayBot: GatewayBotInfo | null = null;
  let tokenMasked = '(none)';

  const push = (step: LoginStep): void => {
    steps.push(step);
  };
  const fail = (step: LoginStep, extra?: string): void => {
    push(step);
    if (extra) advice.push(extra);
  };

  // ── 1. 配置 ────────────────────────────────────────────────
  const appId = config.appId.trim();
  if (!appId) {
    fail(
      { id: 'config', label: '配置', status: 'fail', detail: 'AppID 是空的' },
      '在 .env 里填 QQ_BOT_APPID（机器人详情页那一个），然后重启进程。',
    );
    return finish();
  }
  push({ id: 'config', label: '配置', status: 'ok', detail: 'AppID ' + appId + '（' + (isSandbox(config.apiBase) ? '沙箱' : '正式') + '环境）' });

  // ── 2. token ──────────────────────────────────────────────
  let token: string;
  try {
    token = await config.tokenProvider();
    tokenMasked = maskToken(token);
    push({ id: 'token', label: '换 access_token', status: 'ok', detail: '已拿到 ' + tokenMasked });
  } catch (error) {
    const detail = (error as Error).message;
    const code = error instanceof TokenError ? error.code : null;
    fail(
      { id: 'token', label: '换 access_token', status: 'fail', detail },
      (code !== null ? TOKEN_CODE_ADVICE[code] : null) ??
        '这是登录链路的第一环，它不通后面都不用看：先在 .env 里核对 QQ_BOT_APPID / QQ_BOT_SECRET。',
    );
    return finish();
  }

  // ── 3. 机器人身份 ─────────────────────────────────────────
  try {
    identity = await fetchBotIdentity(config.apiBase, token, {
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
      appId,
    });
    push({
      id: 'identity',
      label: '机器人身份',
      status: identity.username ? 'ok' : 'warn',
      detail: identity.username
        ? identity.username + '（id ' + identity.id + '）'
        : '平台没返回 username（id ' + identity.id + '）',
    });
  } catch (error) {
    const e = error as LoginHttpError;
    fail({ id: 'identity', label: '机器人身份', status: 'fail', detail: e.message },
      e.advice ?? 'token 换了但调不动接口：确认 AppID 与这个 token 是同一个机器人。');
  }

  // ── 4. 网关地址与配额 ─────────────────────────────────────
  try {
    gatewayBot = await fetchGatewayBot(config.apiBase, token, {
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
      appId,
    });
    const limit = gatewayBot.sessionLimit;
    if (!limit) {
      push({ id: 'quota', label: '会话配额', status: 'warn', detail: '平台没有返回 session_start_limit，配额未知' });
    } else {
      const status: LoginStepStatus =
        limit.remaining <= NUMERIC.qqBot.quotaCriticalBelow ? 'fail'
          : limit.remaining <= NUMERIC.qqBot.quotaWarnBelow ? 'warn' : 'ok';
      push({
        id: 'quota',
        label: '会话配额',
        status,
        detail: '今天还能建 ' + limit.remaining + '/' + limit.total + ' 次会话（' + humanizeMs(limit.resetAfterMs) + '）',
      });
      if (status === 'fail') {
        advice.push(
          '配额快见底了。每次建连（含断线重连）消耗一次，烧光之后当天连不上：' +
            '先查日志里最近是不是在反复重连（stats.reconnects），把根因修掉再等 ' + humanizeMs(limit.resetAfterMs) + '。',
        );
      } else if (status === 'warn') {
        advice.push('配额偏低。留意日志里的重连次数 —— 正常情况下 resumes 远多于 identifies。');
      }
    }
    push({
      id: 'gateway-url',
      label: '网关地址',
      status: gatewayBot.url ? 'ok' : 'warn',
      detail: gatewayBot.url ?? '平台没返回 url（连网关时会退回约定地址）',
    });
    if (gatewayBot.shards !== null && gatewayBot.shards > 1) {
      push({
        id: 'shards',
        label: '推荐分片',
        status: 'warn',
        detail: '平台建议 ' + gatewayBot.shards + ' 个分片，本进程只用 [0,1]（事件量大到被限流时再开）',
      });
    }
  } catch (error) {
    const e = error as LoginHttpError;
    fail({ id: 'quota', label: '会话配额', status: 'fail', detail: e.message },
      e.advice ?? '拿不到 /gateway/bot：确认这个 AppID 有网关权限。');
  }

  // ── 5. 最近一次网关关闭 ───────────────────────────────────
  const stats = config.gatewayStats?.();
  if (stats) {
    const last = stats.lastClose;
    if (!last) {
      push({ id: 'gateway', label: '网关连接', status: stats.identifies > 0 ? 'ok' : 'warn',
        detail: stats.identifies > 0 ? 'identify ' + stats.identifies + ' 次，没有异常关闭记录' : '还没有连过网关' });
    } else {
      const hint = closeCodeHint(last.code);
      push({
        id: 'gateway',
        label: '网关连接',
        status: hint.fatal ? 'fail' : 'warn',
        detail: '最近一次关闭 code=' + last.code + '（' + hint.title + '）' + (last.reason ? ' reason=' + last.reason : ''),
      });
      advice.push(hint.advice);
    }
    if (stats.identifies > 0) {
      push({
        id: 'reconnect',
        label: '重连情况',
        status: stats.identifies > stats.resumes + 5 ? 'warn' : 'ok',
        detail: 'identify ' + stats.identifies + ' 次 / resume ' + stats.resumes + ' 次 / 重连 ' + stats.reconnects + ' 次',
      });
      if (stats.identifies > stats.resumes + 5) {
        advice.push('identify 明显多于 resume：说明会话没被复用，每次重连都在烧配额。查 op 9 / close 4006 / 4007。');
      }
    }
  }

  return finish();

  function finish(): LoginReport {
    const hasFail = steps.some((s) => s.status === 'fail');
    const hasWarn = steps.some((s) => s.status === 'warn');
    const firstFail = steps.find((s) => s.status === 'fail');
    const verdict = hasFail
      ? '登录链路有问题：' + (firstFail?.label ?? '') + ' —— ' + (firstFail?.detail ?? '')
      : hasWarn
        ? '登录链路可用，但有 ' + steps.filter((s) => s.status === 'warn').length + ' 项要留意。'
        : '登录链路正常：凭证有效、身份可取、网关地址与配额都拿到了。';
    return {
      ok: !hasFail,
      at: now,
      durationMs: (config.now ? config.now() : Date.now()) - started,
      appId,
      apiBase: config.apiBase,
      sandbox: isSandbox(config.apiBase),
      steps,
      identity,
      gatewayBot,
      verdict,
      advice: [...new Set(advice)],
      tokenMasked,
    };
  }
}

export function isSandbox(apiBase: string): boolean {
  return apiBase.includes('sandbox');
}

/** 人读的一屏摘要（CLI 与后台按钮共用同一份，避免两处口径不同） */
export function renderLoginReport(report: LoginReport): string {
  const lines: string[] = [];
  const mark: Record<LoginStepStatus, string> = { ok: '✓', warn: '!', fail: '✗' };
  lines.push(report.verdict);
  lines.push('');
  for (const step of report.steps) {
    lines.push(mark[step.status] + ' ' + step.label + '：' + step.detail);
  }
  if (report.advice.length > 0) {
    lines.push('');
    lines.push('接下来：');
    for (const item of report.advice) lines.push('· ' + item);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI：node --env-file=.env src/adapter/qq-official/login-check.ts
 *
 * 上线备战期的标准动作：**改完配置先跑这一条**，再启动机器人。
 * 输出永远不含 secret 与 token 明文（token 只出现脱敏后的前 4 后 4）。
 * ------------------------------------------------------------------ */
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { TokenManager } = await import('./token.ts');
  const { apiBaseFromEnv } = await import('./gateway.ts');
  /*
   * ⚠️ 这里**故意不用 loadTokenConfig()** —— 它在缺配置时直接抛异常，
   * 于是「AppID 没填」这种最常见的故障会以一段堆栈的形式呈现，
   * 而运营要的是一句「AppID 是空的，去 .env 里填上」。
   * 缺什么由 runLoginCheck 的 config / token 两步分别报出来（它本来就是干这个的）。
   *
   * 实测（2026-09-29）：本机 .env 的 QQ_BOT_APPID 就是**空值**，
   * 而 SECRET 有值 —— 这种「填了一半」的状态正是最容易被忽略的一种。
   */
  const appId = (process.env.QQ_BOT_APPID ?? '').trim();
  const clientSecret = (process.env.QQ_BOT_SECRET ?? '').trim();
  const manager = new TokenManager({ appId, clientSecret });
  const report = await runLoginCheck({
    appId,
    apiBase: apiBaseFromEnv(),
    tokenProvider: async () => {
      if (clientSecret === '') {
        throw new TokenError(
          '缺少环境变量 QQ_BOT_SECRET：把 .env.example 复制成 .env 并填真值（.env 已被 gitignore，不要提交）。',
        );
      }
      return manager.get();
    },
  });
  console.log(renderLoginReport(report));
  console.log('');
  console.log(JSON.stringify({
    ok: report.ok,
    appId: report.appId,
    apiBase: report.apiBase,
    identity: report.identity,
    shards: report.gatewayBot?.shards ?? null,
    sessionStartLimit: report.gatewayBot?.sessionLimit ?? null,
    token: report.tokenMasked,
    durationMs: report.durationMs,
  }, null, 2));
  process.exitCode = report.ok ? 0 : 2;
}
