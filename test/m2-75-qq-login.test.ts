/**
 * M2.75：QQ 官方通道的**登录体检**与「连不上」的三类处置。
 *
 * 这个文件守四件事：
 *   1. 体检三步（换 token → 机器人身份 → 网关地址与配额）各自成功/失败时的结论与建议；
 *   2. 配额阈值真的会分档（够用 / 偏低 / 见底），而不是永远一句「正常」；
 *   3. 网关关闭码的分档 —— **致命的那几个不许再重连**（重连只是烧配额），
 *      而 4009 会话超时**不许判成致命**（它靠 resume 自愈）；
 *   4. 接线：体检结果进 runtimeStatus（后台面板与 /health 读的就是它），
 *      发消息被 401 拒绝时会作废 token 重发一次。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  runLoginCheck,
  renderLoginReport,
  humanizeMs,
  fetchBotIdentity,
} from '../src/adapter/qq-official/login-check.ts';
import { TokenManager, TOKEN_URL } from '../src/adapter/qq-official/token.ts';
import { closeCodeHint, API_BASE_PROD, QQGateway, type GatewayStats } from '../src/adapter/qq-official/gateway.ts';
import { QQOfficialAdapter } from '../src/adapter/qq-official/index.ts';
import { NUMERIC } from '../src/config/numeric.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 按 URL 分派的假 fetch。没准备的路由直接抛 —— 比回 404 更容易发现用例写漏了 */
function fakeFetch(routes: Array<[RegExp, () => Response]>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    for (const [pattern, make] of routes) if (pattern.test(url)) return make();
    throw new Error('测试没有为这个 URL 准备响应：' + url);
  }) as unknown as typeof fetch;
}

const TOKEN_OK: [RegExp, () => Response] = [
  /getAppAccessToken/,
  () => jsonResponse({ access_token: 'tk-0123456789abcdef', expires_in: '7200' }),
];
const IDENTITY_OK: [RegExp, () => Response] = [
  /users\/@me/,
  () => jsonResponse({ id: '10086', username: '群星低语', avatar: 'https://x/a.png' }),
];
function gatewayBot(remaining: number, extra: Record<string, unknown> = {}): [RegExp, () => Response] {
  return [
    /gateway\/bot/,
    () => jsonResponse({
      url: 'wss://api.sgroup.qq.com/websocket',
      shards: 1,
      session_start_limit: { total: 1500, remaining, reset_after: 86_400_000, max_concurrency: 1 },
      ...extra,
    }),
  ];
}

function emptyStats(over: Partial<GatewayStats> = {}): GatewayStats {
  return {
    hellos: 0, identifies: 0, resumes: 0, heartbeats: 0, heartbeatAcks: 0,
    dispatches: 0, reconnects: 0, lastError: null, lastClose: null, fatalStops: 0,
    resumedFromDisk: false, quotaBlocked: 0,
    ...over,
  };
}

test('登录体检：换 token → 身份 → 配额三步全过，结论是「正常」', async () => {
  const fetchImpl = fakeFetch([TOKEN_OK, IDENTITY_OK, gatewayBot(1490)]);
  const manager = new TokenManager({ appId: '1020', clientSecret: 's', fetchImpl });
  const report = await runLoginCheck({
    appId: '1020', apiBase: API_BASE_PROD, tokenProvider: () => manager.get(), fetchImpl,
  });

  assert.equal(report.ok, true);
  assert.equal(report.sandbox, false);
  assert.equal(report.identity?.username, '群星低语');
  assert.equal(report.identity?.id, '10086');
  assert.equal(report.gatewayBot?.sessionLimit?.remaining, 1490);
  assert.equal(report.gatewayBot?.shards, 1);
  assert.deepEqual(report.steps.map((s) => s.id), ['config', 'token', 'identity', 'quota', 'gateway-url']);
  assert.ok(report.steps.every((s) => s.status === 'ok'), '三步全过时不该有 warn');
  assert.match(report.verdict, /正常/);
  assert.deepEqual(report.advice, [], '没问题时不该给建议');
  // token 只以脱敏形式出现（前 4 后 4 + 长度），任何地方都不许落明文
  assert.match(report.tokenMasked, /^tk-0\.\.\.cdef\(len=\d+\)$/);
  assert.ok(!JSON.stringify(report).includes('tk-0123456789abcdef'), '体检报告里混进了 token 明文');
});

test('登录体检：AppSecret 错了要在第一步就停住，并说清改哪里', async () => {
  const fetchImpl = fakeFetch([
    [/getAppAccessToken/, () => jsonResponse({ code: 100016, message: 'appid or secret invalid' })],
  ]);
  const manager = new TokenManager({ appId: '1020', clientSecret: '错的', fetchImpl });
  const report = await runLoginCheck({
    appId: '1020', apiBase: API_BASE_PROD, tokenProvider: () => manager.get(), fetchImpl,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.steps.map((s) => s.id), ['config', 'token'], '第一环不通就不该再往下查');
  assert.equal(report.steps[1]?.status, 'fail');
  assert.ok(report.advice.some((a) => a.includes('AppSecret')), '要告诉人改哪个环境变量');
  assert.match(report.verdict, /换 access_token/);
});

test('登录体检：身份取不到（401）时给出「凭证被拒」的处置，而不是只说失败', async () => {
  const fetchImpl = fakeFetch([TOKEN_OK, [/users\/@me/, () => jsonResponse({ message: 'unauthorized' }, 401)]]);
  const manager = new TokenManager({ appId: '1020', clientSecret: 's', fetchImpl });
  const report = await runLoginCheck({
    appId: '1020', apiBase: API_BASE_PROD, tokenProvider: () => manager.get(), fetchImpl,
  });

  assert.equal(report.ok, false);
  assert.equal(report.steps.find((s) => s.id === 'identity')?.status, 'fail');
  assert.ok(report.advice.some((a) => a.includes('平台拒绝了这个 access_token')));
});

test('登录体检：配额按阈值分档（够用 / 偏低 / 见底），见的底是真的底', async () => {
  const run = async (remaining: number) => {
    const fetchImpl = fakeFetch([TOKEN_OK, IDENTITY_OK, gatewayBot(remaining)]);
    const manager = new TokenManager({ appId: '1020', clientSecret: 's', fetchImpl });
    return runLoginCheck({
      appId: '1020', apiBase: API_BASE_PROD, tokenProvider: () => manager.get(), fetchImpl,
    });
  };

  const ok = await run(1490);
  assert.equal(ok.steps.find((s) => s.id === 'quota')?.status, 'ok');

  const warn = await run(NUMERIC.qqBot.quotaWarnBelow - 1);
  assert.equal(warn.steps.find((s) => s.id === 'quota')?.status, 'warn');
  assert.equal(warn.ok, true, '偏低不等于不能跑');
  assert.ok(warn.advice.some((a) => a.includes('配额偏低')));

  const bad = await run(NUMERIC.qqBot.quotaCriticalBelow - 1);
  assert.equal(bad.steps.find((s) => s.id === 'quota')?.status, 'fail');
  assert.equal(bad.ok, false, '配额见底必须让整体结论变红 —— 它当天真的连不上');
  assert.ok(bad.advice.some((a) => a.includes('配额快见底')));
  // 配额那一步的文案要说清「今天还能建几次」与「什么时候重置」
  assert.match(bad.steps.find((s) => s.id === 'quota')?.detail ?? '', /今天还能建 \d+\/\d+ 次/);
  assert.match(humanizeMs(86_400_000), /小时后重置/);
  assert.equal(humanizeMs(0), '即将重置');
});

test('登录体检：网络不通与「被平台拒绝」是两类故障，说的话不一样', async () => {
  const fetchImpl = (async () => {
    throw new Error('getaddrinfo ENOTFOUND api.bot.qq.com');
  }) as unknown as typeof fetch;
  const manager = new TokenManager({ appId: '1020', clientSecret: 's', fetchImpl });
  const report = await runLoginCheck({
    appId: '1020', apiBase: API_BASE_PROD, tokenProvider: () => manager.get(), fetchImpl,
  });

  assert.equal(report.ok, false);
  assert.match(report.steps[1]?.detail ?? '', /未拿到 HTTP 响应/);
  assert.ok(report.advice.some((a) => a.includes('核对') || a.includes('网络')));
});

test('登录体检：网关最近一次异常关闭会被翻成中文处置（4004 是致命的）', async () => {
  const fetchImpl = fakeFetch([TOKEN_OK, IDENTITY_OK, gatewayBot(1490)]);
  const manager = new TokenManager({ appId: '1020', clientSecret: 's', fetchImpl });
  const report = await runLoginCheck({
    appId: '1020', apiBase: API_BASE_PROD, tokenProvider: () => manager.get(), fetchImpl,
    gatewayStats: () => emptyStats({
      identifies: 1, lastClose: { code: 4004, reason: 'auth failed', at: Date.now() }, fatalStops: 1,
    }),
  });

  const gw = report.steps.find((s) => s.id === 'gateway');
  assert.equal(gw?.status, 'fail', '致命关闭码要让整体结论变红');
  assert.match(gw?.detail ?? '', /鉴权失败/);
  assert.equal(report.ok, false);
  assert.ok(report.advice.some((a) => a.includes('AppID')), '4004 的处置要指向凭证');
});

test('网关关闭码：致命的判致命，会话类的判可重连，不认识的不许停连', () => {
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014, 4914, 4915]) {
    assert.equal(closeCodeHint(code).fatal, true, code + ' 应当是致命码（重连不会好）');
  }
  for (const code of [4006, 4007, 4008, 4009, 4900, 4901, 4903]) {
    assert.equal(closeCodeHint(code).fatal, false, code + ' 不该判成致命码');
  }
  // 4009 会话超时靠 resume 自愈（官方与社区口径都是这样）—— 判成致命会让一次正常回收变成停机
  assert.equal(closeCodeHint(4009).fatal, false);
  assert.match(closeCodeHint(4009).advice, /resume/);
  // 不认识就继续重连：贸然停下等于「机器人静默不理人」，比多几次重连难查得多
  const unknown = closeCodeHint(9999);
  assert.equal(unknown.fatal, false);
  assert.match(unknown.title, /未登记/);
});

test('token 主动续期：只在快到期时才换，其余时候一次网络都不打', async () => {
  let now = 1_000_000;
  let calls = 0;
  const fetchImpl = fakeFetch([
    [/getAppAccessToken/, () => {
      calls += 1;
      return jsonResponse({ access_token: 'tk-0123456789abcdef', expires_in: '7200' });
    }],
  ]);
  const manager = new TokenManager({ appId: '1020', clientSecret: 's', fetchImpl, now: () => now });

  await manager.get();
  assert.equal(calls, 1);
  // 刚换完：远没到期
  assert.equal(await manager.refreshIfStale(), false);
  assert.equal(calls, 1, '还够用的时候不该打网络');

  // 走到只剩 5 分钟（< 提前续期阈值）
  now += (7200 - 300) * 1000;
  assert.equal(await manager.refreshIfStale(), true);
  assert.equal(calls, 2);
  assert.equal(manager.snapshot().sweepFailures, 0);
  assert.equal(manager.snapshot().autoRefresh, false, '没 startAutoRefresh 时面板要看得出来');
});

test('适配器：体检结果进 runtimeStatus（面板与 /health 读的就是这一份）', async () => {
  const fetchImpl = fakeFetch([TOKEN_OK, IDENTITY_OK, gatewayBot(1490)]);
  const gw = {
    stats: emptyStats(),
    ready: true,
    async connect() {},
    close() {},
    async waitReady() {},
  };
  const adapter = new QQOfficialAdapter(
    { appId: '1020', clientSecret: 's', apiBase: API_BASE_PROD } as never,
    { fetch: fetchImpl, gateway: gw as never },
  );

  assert.equal(adapter.runtimeStatus().login, null, '没跑过体检时是 null，不是一份假报告');
  const report = await adapter.loginCheck();
  assert.equal(report.ok, true);

  const login = adapter.runtimeStatus().login;
  assert.equal(login?.ok, true);
  assert.equal(login?.identity?.username, '群星低语');
  assert.equal(login?.sessionLimit?.remaining, 1490);
  assert.match(renderLoginReport(report), /✓ 机器人身份：群星低语/);
  // 网关计数必须是**真网关那一个 stats 对象**：早先构造时手写了一份字面量，
  // 于是运行期 adapter.stats.gateway.identifies 恒为 0 —— 面板上永远是 0
  gw.stats.identifies = 7;
  assert.equal(adapter.runtimeStatus().stats.gateway.identifies, 7, 'stats.gateway 没有指向真网关');
});

test('发消息被 401 拒绝：作废 token 重发一次，不把失败丢给玩家', async () => {
  let posts = 0;
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (/getAppAccessToken/.test(url)) {
      return jsonResponse({ access_token: 'tk-0123456789abcdef', expires_in: '7200' });
    }
    posts += 1;
    if (posts === 1) return jsonResponse({ message: 'unauthorized' }, 401);
    return jsonResponse({ id: 'msg-2', timestamp: Date.now() });
  }) as unknown as typeof fetch;

  const adapter = new QQOfficialAdapter(
    { appId: '1020', clientSecret: 's', apiBase: API_BASE_PROD } as never,
    { fetch: fetchImpl, gateway: { stats: emptyStats(), ready: true, async connect() {}, close() {}, async waitReady() {} } as never },
  );
  // 被动回复要有凭证：先喂一条真实事件（适配器会把 msg_id 记下来）
  const msg = await adapter.handleDispatch('GROUP_AT_MESSAGE_CREATE', {
    id: 'm1', group_openid: 'G1', content: '.状态',
    author: { member_openid: 'U1', username: '甲' }, timestamp: Date.now(),
  });
  assert.ok(msg, '事件没被接受，后面的发送就测不到');

  await adapter.sendGroup('G1', '你好');
  assert.equal(posts, 2, '401 之后必须重发一次');
  assert.equal(adapter.stats.repliesSent, 1);
  assert.equal(adapter.stats.lastError, null, '重试成功就不该留下错误');
});

test('发消息被 401 拒绝：重试一次仍然 401 就如实报错（不许无限重试）', async () => {
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (/getAppAccessToken/.test(url)) {
      return jsonResponse({ access_token: 'tk-0123456789abcdef', expires_in: '7200' });
    }
    return jsonResponse({ message: 'unauthorized' }, 401);
  }) as unknown as typeof fetch;

  const adapter = new QQOfficialAdapter(
    { appId: '1020', clientSecret: 's', apiBase: API_BASE_PROD } as never,
    { fetch: fetchImpl, gateway: { stats: emptyStats(), ready: true, async connect() {}, close() {}, async waitReady() {} } as never },
  );
  await adapter.handleDispatch('GROUP_AT_MESSAGE_CREATE', {
    id: 'm1', group_openid: 'G1', content: '.状态',
    author: { member_openid: 'U1', username: '甲' }, timestamp: Date.now(),
  });

  await assert.rejects(() => adapter.sendGroup('G1', '你好'), /HTTP 401/);
  assert.equal(adapter.stats.repliesSent, 0);
  assert.match(adapter.stats.lastError ?? '', /401/);
  void TOKEN_URL;
});

/* ------------------------------------------------------------------ *
 * 网关关闭码的**行为**（不只是那张表）：会话该不该留着、什么时候停连
 * ------------------------------------------------------------------ */

/** 可控的假 WebSocket：能手动触发 open / message / close，并把发出去的帧记下来 */
class FakeWs {
  static instances: FakeWs[] = [];
  static reset(): void { FakeWs.instances = []; }
  readyState = 0;
  sent: string[] = [];
  #listeners: Record<string, Array<(event: unknown) => void>> = {};
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    (this.#listeners[type] ??= []).push(fn);
  }
  send(data: string): void { this.sent.push(data); }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.#emit('close', { code, reason });
  }
  #emit(type: string, event: unknown): void {
    for (const fn of this.#listeners[type] ?? []) fn(event);
  }
  open(): void { this.readyState = 1; this.#emit('open', {}); }
  /** 喂一帧给网关（走的是和真网关同一条路径） */
  frame(payload: unknown): void { this.#emit('message', { data: JSON.stringify(payload) }); }
  hello(intervalMs = 40_000): void { this.frame({ op: 10, d: { heartbeat_interval: intervalMs } }); }
  ready(sessionId = 'sess-1'): void {
    this.frame({ op: 0, t: 'READY', s: 1, d: { session_id: sessionId, user: { id: '1', username: 'bot' } } });
  }
  /** 发出去的帧里有没有某个 opcode */
  opcodes(): number[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { op: number }).op);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个用假 WebSocket 的网关。
 *
 * 关掉自动重连的**退避抖动**做不到（那是刻意的设计），所以这些用例真的要等
 * 1 秒左右的退避 —— 换来的是「4006 到底会不会重新 identify」这种只有真跑才敢下结论的判据。
 */
async function withFakeGateway<T>(
  body: (ctx: { gw: import('../src/adapter/qq-official/gateway.ts').QQGateway; fatal: Array<{ code: number; title: string }>; authFailures: () => number }) => Promise<T>,
  /**
   * M2.99：个别用例要注入网关选项。
   * 最典型的是心跳 ACK 超时 —— 真机上那个阈值约 108 秒，测试里必须能调小，
   * 否则这条用例要么跑两分钟，要么根本没法写。
   */
  extra: Partial<ConstructorParameters<typeof QQGateway>[0]> = {},
): Promise<T> {
  const savedWs = globalThis.WebSocket;
  const savedFetch = globalThis.fetch;
  FakeWs.reset();
  /*
   * ⚠️ 这里把全局 fetch 换成一个**会抛错**的实现，而不是「返回假响应」。
   *
   * 理由很具体（M2.76 实测）：原来「取网关地址」那一步在内部直接用全局 fetch，
   * 于是用例**真的打到了 api.sgroup.qq.com** —— 而它照样通过（有 fallback 兜底），
   * 日志里只留下一行平台返回的真实 401。换成抛错之后，任何绕过注入的调用都会当场炸。
   * 注入的那份假 fetch 通过 fetchImpl 传下去。
   */
  const resolveFetch = (async () => jsonResponse({ url: 'wss://fake.invalid/websocket' })) as unknown as typeof fetch;
  (globalThis as { fetch: unknown }).fetch = (() => {
    throw new Error('测试里不许打真实网络：这个调用没有走注入的 fetch');
  }) as unknown as typeof fetch;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWs as unknown as typeof WebSocket;
  let authFailures = 0;
  const fatal: Array<{ code: number; title: string }> = [];
  const gw = new QQGateway({
    tokenProvider: async () => 'fake-token',
    apiBase: API_BASE_PROD,
    fetchImpl: resolveFetch,
    onAuthFailure: () => { authFailures += 1; },
    onFatal: (info) => { fatal.push({ code: info.code, title: info.title }); },
    ...extra,
  });
  try {
    /*
     * ⚠️ 顺序不能写成 await connect() 之后才 open()：connect() 的 promise 正是
     * 靠 open 事件 resolve 的，那样写就是自己等自己（第一次写就是这么挂住的）。
     * 所以先起 connect，等假 socket 被造出来，再触发 open，最后才 await。
     */
    const connecting = gw.connect();
    for (let i = 0; i < 100 && FakeWs.instances.length === 0; i += 1) await sleep(5);
    FakeWs.instances[0]?.open();
    await connecting;
    return await body({ gw, fatal, authFailures: () => authFailures });
  } finally {
    gw.close();
    (globalThis as { WebSocket: unknown }).WebSocket = savedWs;
    (globalThis as { fetch: unknown }).fetch = savedFetch;
  }
}

test('网关：close 4006（无效 session）后必须重新 identify，不能带着死会话 resume', async () => {
  await withFakeGateway(async ({ gw }) => {
    const first = FakeWs.instances[0]!;
    first.hello();
    first.ready('sess-1');
    await sleep(50);
    // 首跳心跳带 0.3—0.7 倍间隔的抖动（12—28 秒），所以这里只能断言「第一帧是 identify」
    assert.equal(first.opcodes()[0], 2, 'hello 之后第一帧应当是 identify（op 2）');

    first.close(4006, 'invalid session');
    await sleep(1400);
    const second = FakeWs.instances[1];
    assert.ok(second, '4006 之后应当重连');
    second.open();
    second.hello();
    await sleep(50);
    // 关键判据：会话被清掉了，所以第二段连接**不重发 resume**，而是重新 identify
    assert.ok(second.opcodes().includes(2), '4006 之后必须重新 identify');
    assert.ok(!second.opcodes().includes(6), '带着一个已经作废的会话去 resume 会一直失败');
    assert.equal(gw.stats.lastClose?.code, 4006);
  });
});

test('网关：close 4009（会话超时）保留会话走 resume —— 不许当成「重新登录」', async () => {
  await withFakeGateway(async ({ gw }) => {
    const first = FakeWs.instances[0]!;
    first.hello();
    first.ready('sess-1');
    await sleep(50);

    first.close(4009, 'session timeout');
    await sleep(1400);
    const second = FakeWs.instances[1];
    assert.ok(second, '4009 之后应当重连');
    second.open();
    second.hello();
    await sleep(50);
    // 官方与社区口径一致：4009 靠 resume 恢复。判成「重新 identify」会白烧配额、还会丢断线期间的事件
    assert.ok(second.opcodes().includes(6), '4009 之后应当 resume（op 6）');
    assert.ok(!second.opcodes().includes(2), '4009 不该触发重新 identify');
    assert.equal(gw.stats.resumes, 1);
    assert.equal(gw.stats.identifies, 1, 'identify 只该发生一次（第一次登录）');
  });
});

test('网关：4004 鉴权失败 → 作废 token 重连一次；再失败就停连（不再烧配额）', async () => {
  await withFakeGateway(async ({ gw, fatal, authFailures }) => {
    const first = FakeWs.instances[0]!;
    first.hello();
    first.ready('sess-1');
    await sleep(50);

    first.close(4004, 'auth failed');
    await sleep(1400);
    assert.equal(authFailures(), 1, '第一次 4004 要先作废 token 再试一次');
    const second = FakeWs.instances[1];
    assert.ok(second, '第一次 4004 之后应当重连');

    // 第二次还是 4004：说明 AppID / Secret 真的不匹配，继续重连只是烧配额
    second.open();
    second.hello();
    await sleep(50);
    second.close(4004, 'auth failed again');
    await sleep(1600);

    assert.equal(gw.stats.fatalStops, 1);
    assert.equal(fatal.length, 1, '致命停连必须回调出去（否则表现是「机器人静默不理人」）');
    assert.match(fatal[0]?.title ?? '', /鉴权失败/);
    assert.equal(FakeWs.instances.length, 2, '判了致命之后就不该再建新连接');
    assert.equal(authFailures(), 1, '只重试一次，不许无限作废重连');
  });
});

/* ------------------------------------------------------------------ *
 * 后台面板：登录相关的格子与体检区块
 *
 * 这里测的是**渲染函数的产出**，不是浏览器里的像素 —— 因为本机 .env 缺 AppID，
 * 真的 QQ 通道起不来（createQQApp 会先读凭证）。写成判据的好处是可复现：
 * 面板以后再改，这两条会先红。
 * ------------------------------------------------------------------ */

const AD_JS = readFileSync('src/admin/adapter.js', 'utf8');
const adFns = new Function(AD_JS + '; return { adCells: adCells, adLoginBlock: adLoginBlock };')() as {
  adCells: (rt: unknown) => string;
  adLoginBlock: (rt: unknown) => string;
};

const RT = {
  connected: false,
  token: { appId: '1020', hasToken: true, remainingSec: 1200, refreshes: 3, autoRefresh: true, sweepFailures: 0 },
  stats: {
    lastError: null,
    gateway: { identifies: 2, resumes: 1, reconnects: 1, fatalStops: 0, lastClose: null, lastError: null },
  },
  pendingReconnect: [],
  login: {
    at: 1_700_000_000_000,
    durationMs: 123,
    ok: false,
    verdict: '登录链路有问题：会话配额 —— 今天还能建 0/1500 次会话',
    advice: ['配额快见底了：先查日志里最近是不是在反复重连。'],
    steps: [
      { id: 'config', label: '配置', status: 'ok', detail: 'AppID 1020（正式环境）' },
      { id: 'quota', label: '会话配额', status: 'fail', detail: '今天还能建 0/1500 次会话' },
    ],
    identity: { id: '1', username: '群星低语', avatar: null },
    sessionLimit: { total: 1500, remaining: 0, resetAfterMs: 3_600_000, maxConcurrency: 1 },
    shards: 1,
    tokenMasked: 'tk-0...cdef(len=20)',
  },
};

test('后台面板：登录相关的格子要画出来（只看「网关已连接」是看不出配额烧光的）', () => {
  const cells = adFns.adCells(RT);
  assert.ok(cells.includes('<b>群星低语</b>'), '面板要看得到机器人是谁');
  assert.ok(cells.includes('<b>0/1500</b>'), '会话配额要看得到');
  assert.ok(cells.includes('identify/resume'), 'identify 与 resume 要能对比 —— 差太多说明会话没被复用');
  assert.ok(cells.includes('<b>2/1</b>'));
  assert.ok(cells.includes('<b>开</b>'), '主动续期开着没有要看得到');

  // 没体检过时不许假装有数据：配额给破折号而不是 0（0 会被读成「今天烧光了」）
  const noLogin = adFns.adCells({ ...RT, login: null });
  assert.ok(noLogin.includes('<b>未体检</b>'));
  assert.ok(noLogin.includes('<b>—</b>'));
});

test('后台面板：体检结果三段式（结论 / 每一步 / 建议），没跑过时不留空白', () => {
  const block = adFns.adLoginBlock(RT);
  assert.ok(block.includes('adverdict err'), '结论要按 ok / err 着色');
  assert.ok(block.includes('✗ 会话配额'), '失败的步骤要有醒目的记号');
  assert.ok(block.includes('✓ 配置'));
  assert.ok(block.includes('配额快见底了'), '建议必须一起铺出来');
  assert.ok(block.includes('体检时间'));
  // 空着会被当成「一切正常」，所以必须有一句明确的话
  const empty = adFns.adLoginBlock({ login: null });
  assert.ok(empty.includes('还没有跑过登录体检'));
});

/* ------------------------------------------------------------------ *
 * M2.99：**半开连接**（心跳发出去了、没人回 ACK）必须自己发现
 * ------------------------------------------------------------------ */

test('M2.99 网关：心跳长期没有 ACK ⇒ 判定连接已僵死并强制重连', async () => {
  await withFakeGateway(
    async ({ gw }) => {
      const first = FakeWs.instances[0]!;
      first.hello(40); // 心跳间隔 40ms
      first.ready('sess-1');
      await sleep(60);

      /*
       * 从这里开始**一条 ACK 都不回**：真机上这就是「网络中间设备静默丢弃」的样子 ——
       * readyState 还是 OPEN、心跳照发，但事件一条也收不到、消息也发不出去
       * （官方原文：发送消息要求机器人**连接到 WebSocket 并保持在线**）。
       * 玩家看到的就是「群里、私聊全都不响应」，而日志里只有一行行心跳。
       */
      const beatsBefore = gw.stats.heartbeats;
      await sleep(400);

      assert.ok(
        (gw.stats.lastError ?? '').includes('没有收到 ACK'),
        '必须记下「为什么重连」，否则又是一次只能靠猜的故障：' + String(gw.stats.lastError),
      );
      assert.equal(first.readyState, 3, '判定僵死后必须主动关掉那条连接');
      assert.ok(gw.stats.reconnects >= 1, '关掉之后要走重连，而不是原地不动');
      assert.ok(
        gw.stats.heartbeats > beatsBefore,
        '判定之前心跳是照发的 —— 那正是半开连接看起来「一切正常」的原因',
      );
    },
    // 真机阈值约 108 秒（41.25s × 2.5 + 5s 余量），测试里调小到 120ms
    { heartbeatAckTimeoutMs: 120 },
  );
});

test('M2.99 登录体检：网络层失败自动重试，一次启动抖动不该写成「链路有问题」', async () => {
  /*
   * 现场：服务每次启动都可能报「/users/@me 请求失败：fetch failed」，
   * 而同一时刻在 shell 里用同一份凭据手调是 200 —— 失败的是启动瞬间那一次。
   * 那次抖动会被面板写成「登录链路有问题」，把排查方向整个带偏。
   */
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls <= 2) throw new TypeError('fetch failed');
    return jsonResponse({ id: '1', username: '群星低语' });
  }) as unknown as typeof fetch;

  const who = await fetchBotIdentity(API_BASE_PROD, 'tk', { fetchImpl: flaky });
  assert.equal(who.username, '群星低语');
  assert.equal(calls, 3, '前两次网络失败要重试，第三次成功 —— 体检不该把这一次抖动判成链路故障');

  // 一直失败时**仍要抛**，而且原因要带出来（不许重试到变成「ok」）
  let always = 0;
  const broken = (async () => {
    always += 1;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchBotIdentity(API_BASE_PROD, 'tk', { fetchImpl: broken }),
    (e: Error) => e.message.includes('ECONNRESET'),
    '一直连不上时必须把 cause 写进错误信息（原来只有一句 fetch failed）',
  );
  assert.equal(always, 3, '首次 + 两次重试 = 3 次');
});
