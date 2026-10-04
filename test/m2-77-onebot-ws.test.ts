/**
 * M2.77：**内置的 OneBot 正向 WebSocket 通道**。
 *
 * 这一条的存在理由是「让用户少填一个地址」：老的 HTTP 上报要求两头都配对
 * （协议端指向本机、本机指向协议端），错一头就是「机器人不理人」。
 * 内置 WS 之后用户只填 ONEBOT_WS_URL 一个值。
 *
 * 判据分三层：
 *   1. 传输层：鉴权拼进 URL、事件交出去、action 发出去等 echo、心跳计数、断线重连；
 *   2. 复用：发送逻辑**没有重写**，走的是 OneBotAdapter 那套（两条传输方式不许各长一套脾气）；
 *   3. 接线：/health 能拿到连接状态；缺配置时报的错要能照着改。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createOneBotWsAdapter, OneBotWsTransport, wsTransportOf } from '../src/adapter/onebot-ws.ts';
import { OneBotAdapter } from '../src/adapter/onebot.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error('等不到：' + what);
}

/** 可控的假 WebSocket：记录构造时的 URL（鉴权就在那上面）与发出去的帧 */
class FakeWs {
  static instances: FakeWs[] = [];
  static reset(): void { FakeWs.instances = []; }
  url: string;
  readyState = 0;
  sent: string[] = [];
  #listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    (this.#listeners[type] ??= []).push(fn);
  }
  send(data: string): void { this.sent.push(data); }
  close(code = 1000, reason = ''): void { this.readyState = 3; this.#emit('close', { code, reason }); }
  #emit(type: string, event: unknown): void {
    for (const fn of this.#listeners[type] ?? []) fn(event);
  }
  open(): void { this.readyState = 1; this.#emit('open', {}); }
  frame(payload: unknown): void { this.#emit('message', { data: JSON.stringify(payload) }); }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

/** 装上假 WS，并把全局 fetch 换成会抛错的（任何绕过注入的网络调用当场炸） */
function seal(): () => void {
  const savedWs = globalThis.WebSocket;
  const savedFetch = globalThis.fetch;
  FakeWs.reset();
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWs as unknown as typeof WebSocket;
  (globalThis as { fetch: unknown }).fetch = (() => {
    throw new Error('测试里不许打真实网络');
  }) as unknown as typeof fetch;
  return () => {
    (globalThis as { WebSocket: unknown }).WebSocket = savedWs;
    (globalThis as { fetch: unknown }).fetch = savedFetch;
  };
}

async function connectedTransport(
  config: { url: string; accessToken?: string } = { url: 'ws://127.0.0.1:3001' },
): Promise<{ transport: OneBotWsTransport; ws: FakeWs }> {
  const transport = new OneBotWsTransport({ ...config, autoReconnect: false });
  const connecting = transport.connect();
  await waitFor('假 socket 建起来', () => FakeWs.instances.length > 0);
  const ws = FakeWs.instances[0]!;
  ws.open();
  await connecting;
  return { transport, ws };
}

test('OneBot WS：access_token 走 query 参数（内建 WebSocket 不能自定义请求头）', async () => {
  const restore = seal();
  try {
    const { transport, ws } = await connectedTransport({ url: 'ws://127.0.0.1:3001', accessToken: 's3cret' });
    assert.match(ws.url, /^ws:\/\/127\.0\.0\.1:3001\?access_token=s3cret$/, 'token 必须拼进 URL');
    assert.equal(transport.stats.connected, true);
    assert.equal(transport.stats.connects, 1);
    // 日志里不许出现 token 明文
    assert.ok(!transport.url.includes('s3cret'), 'transport.url 是给日志用的，不该带 token');
    transport.close();
  } finally {
    restore();
  }
});

test('OneBot WS：消息事件交给适配器，与 HTTP 上报走的是同一个映射函数', async () => {
  const restore = seal();
  try {
    const { adapter, transport } = createOneBotWsAdapter({ ONEBOT_WS_URL: 'ws://127.0.0.1:3001' });
    const received: string[] = [];
    adapter.onMessage(async (msg) => { received.push(msg.rawText); });

    const connecting = transport.connect();
    await waitFor('假 socket 建起来', () => FakeWs.instances.length > 0);
    const ws = FakeWs.instances[0]!;
    ws.open();
    await connecting;

    ws.frame({
      post_type: 'message', message_type: 'group', group_id: '111', user_id: '222',
      message_id: '333', raw_message: '.状态', time: 1_700_000_000, sender: { nickname: '甲' },
    });
    await sleep(20);
    assert.deepEqual(received, ['.状态'], '事件要真的走到 handler');
    assert.equal(transport.stats.events, 1);
    assert.equal(adapter.handled, 1, '适配器的计数也要跟着动（HTTP 模式看的就是它）');

    // 非消息事件不该进业务层
    ws.frame({ post_type: 'notice', notice_type: 'group_recall' });
    await sleep(10);
    assert.equal(adapter.handled, 1, 'notice 不该被当成消息');

    transport.close();
  } finally {
    restore();
  }
});

test('OneBot WS：action 发出去带 echo，回执按 echo 对上号；失败与超时都要抛', async () => {
  const restore = seal();
  try {
    const { transport, ws } = await connectedTransport();

    const sending = transport.call('send_group_msg', { group_id: 123, message: 'hi' });
    await sleep(10);
    const frame = ws.frames()[0]!;
    assert.equal(frame.action, 'send_group_msg');
    assert.deepEqual(frame.params, { group_id: 123, message: 'hi' });
    const echo = String(frame.echo);
    assert.ok(echo.startsWith('ob-'), 'echo 是回执对号的全部依据');

    ws.frame({ status: 'ok', retcode: 0, data: { message_id: 9 }, echo });
    assert.deepEqual(await sending, { message_id: 9 });
    assert.equal(transport.stats.apiCalls, 1);
    assert.equal(transport.stats.apiErrors, 0);

    // 协议端报失败（status=failed）→ 抛，且错误信息带上它的原话
    const failing = transport.call('send_group_msg', { group_id: 123, message: 'x' });
    await sleep(10);
    const echo2 = String(ws.frames()[1]!.echo);
    ws.frame({ status: 'failed', retcode: 100, message: '群不存在', echo: echo2 });
    await assert.rejects(() => failing, /群不存在/);
    assert.equal(transport.stats.apiErrors, 1);

    // 不回执 → 超时抛（不能让调用方永远等下去）
    await assert.rejects(() => transport.call('send_group_msg', {}, 50), /超时/);

    transport.close();
  } finally {
    restore();
  }
});

test('OneBot WS：心跳算「协议端还活着」，断线自动重连', async () => {
  const restore = seal();
  try {
    const transport = new OneBotWsTransport({ url: 'ws://127.0.0.1:3001' });
    const connecting = transport.connect();
    await waitFor('假 socket 建起来', () => FakeWs.instances.length > 0);
    const ws = FakeWs.instances[0]!;
    ws.open();
    await connecting;

    ws.frame({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true } });
    ws.frame({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' });
    await sleep(10);
    assert.equal(transport.stats.heartbeats, 1);
    assert.equal(transport.stats.lifecycles, 1);

    // 断线：状态立刻反映出来，并且会安排重连
    ws.close(1006, 'abnormal');
    assert.equal(transport.stats.connected, false);
    assert.equal(transport.stats.disconnects, 1);
    assert.equal(transport.stats.lastClose?.code, 1006);
    assert.equal(transport.stats.reconnects, 1, '断线要安排重连');

    // 退避是 0.5—1 秒，等它真的建起第二条连接
    await waitFor('重连建起新连接', () => FakeWs.instances.length >= 2, 4000);
    transport.close();
  } finally {
    restore();
  }
});

test('OneBot WS：发送逻辑一行都没重写（走的是 OneBotAdapter 那套）', async () => {
  const restore = seal();
  try {
    const { adapter, transport } = createOneBotWsAdapter({ ONEBOT_WS_URL: 'ws://127.0.0.1:3001' });
    const connecting = transport.connect();
    await waitFor('假 socket 建起来', () => FakeWs.instances.length > 0);
    const ws = FakeWs.instances[0]!;
    ws.open();
    await connecting;

    const sending = adapter.sendGroup('12345', '你好');
    await sleep(10);
    const frame = ws.frames()[0]!;
    assert.equal(frame.action, 'send_group_msg');
    // 群号是字符串进来、数字发出去 —— 这个转换在 onebot.ts 里，说明复用成功
    assert.equal((frame.params as { group_id: unknown }).group_id, 12345);
    ws.frame({ status: 'ok', retcode: 0, echo: String(frame.echo) });
    await sending;

    // /health 与后台拿连接状态靠的就是这个查询
    assert.ok(wsTransportOf(adapter) instanceof OneBotWsTransport);
    assert.equal(wsTransportOf(new OneBotAdapter({ apiBase: 'http://x' })), null, 'HTTP 模式的适配器没有 WS 状态');

    // 体检的入口：问协议端「你是谁」—— 连上去但连错号，只有这一步看得出来
    const asking = transport.fetchSelf();
    await sleep(10);
    const echo = String(ws.frames()[1]!.echo);
    ws.frame({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '群星低语' }, echo });
    assert.deepEqual(await asking, { selfId: '10001', nickname: '群星低语' });
    assert.equal(transport.stats.selfId, '10001');

    transport.close();
  } finally {
    restore();
  }
});

test('OneBot WS：没填 ONEBOT_WS_URL 时报的错要能照着改', () => {
  assert.throws(() => createOneBotWsAdapter({}), /ONEBOT_WS_URL/);
  assert.throws(() => createOneBotWsAdapter({}), /ws:\/\/127\.0\.0\.1:3001/);
});

/* ------------------------------------------------------------------ *
 * 后台面板：OneBot 也要有自己的专区
 *
 * 在此之前「适配器」页只认 QQ 官方通道 —— 接了 OneBot 的部署打开那一页
 * 只有一句「当前通道没有热改接口」，而连接、账号、心跳、重连次数全都有。
 * ------------------------------------------------------------------ */

const AD_JS = readFileSync('src/admin/adapter.js', 'utf8');
const adPanel = new Function(AD_JS + '; return { adOnebotCells: adOnebotCells, adApplyChannel: adApplyChannel };')() as {
  adOnebotCells: (ob: unknown) => string;
  adApplyChannel: () => void;
};

test('后台面板：OneBot 的格子要把「连接 / 账号 / 事件 / 心跳」画出来', () => {
  const html = adPanel.adOnebotCells({
    transport: 'websocket', url: 'ws://127.0.0.1:3001', connected: true,
    selfId: '10001', nickname: '群星低语', heartbeats: 12, events: 34, apiCalls: 7, apiErrors: 0,
    reconnects: 1, lastError: null, lastClose: null, handled: 34,
  });
  assert.ok(html.includes('<b>已连接</b>'), '连接状态要在');
  assert.ok(html.includes('群星低语（10001）'), '协议端登录的是哪个号要看得见');
  assert.ok(html.includes('<b>内置 WS</b>'), '要能区分内置 WS 与 HTTP 上报');
  assert.ok(html.includes('<b>12</b>') && html.includes('心跳'));
  assert.ok(html.includes('<b>34</b>') && html.includes('已处理'));

  // HTTP 上报模式：没有「连接」这个概念，不能显示成「未连接」
  const http = adPanel.adOnebotCells({
    transport: 'http', url: 'http://127.0.0.1:3000', connected: null,
    selfId: null, nickname: null, heartbeats: 0, events: 5, apiCalls: 0, apiErrors: 0,
    reconnects: 0, lastError: null, lastClose: null, handled: 5,
  });
  assert.ok(http.includes('不适用'), 'HTTP 模式要显示「不适用」而不是「未连接」');
  assert.ok(http.includes('<b>HTTP 上报</b>'));
  assert.ok(http.includes('<b>—</b>'), '拿不到协议端账号时给破折号');
});

test('后台面板：适配器拆成分类 + 子页（导航里点进去是对应的适配器）', async () => {
  const { adminPage } = await import('../src/admin/page.ts');
  const { PANELS } = await import('../src/admin/nav.ts');
  const html = adminPage();
  // 三个 section：总览页 + 两条通道各自的页面
  for (const id of ['tab-adapter', 'tab-adapter-onebot', 'tab-adapter-qq']) {
    assert.ok(html.includes('id="' + id + '"'), '页面缺少 #' + id);
  }
  // 总览页的入口卡片与未启用提示的容器
  for (const id of ['adCards', 'adChannels', 'adQqOff', 'adObOff']) {
    assert.ok(html.includes('id="' + id + '"'), '页面缺少 #' + id);
  }
  // OneBot 子页自己的状态格与两个按钮
  for (const id of ['adObLive', 'adObReconnect', 'adObVerify', 'adObMsg']) {
    assert.ok(html.includes('id="' + id + '"'), 'OneBot 子页缺少 #' + id);
  }
  // 导航注册表：两个适配器子页挂在「适配器」下面（分类）
  const sub = PANELS.filter((p) => p.parent === 'adapter').map((p) => p.id).sort();
  assert.deepEqual(sub, ['adapter-onebot', 'adapter-qq'], '两个适配器子页要挂在「适配器」下面');

  // 脚本侧：入口卡片与「未启用」提示都得在
  assert.ok(AD_JS.includes('function adRenderCards'), 'adapter.js 缺少入口卡片渲染');
  assert.ok(AD_JS.includes('function adRenderOffNotes'), '缺少「这条通道没启用」的提示');
  assert.ok(AD_JS.includes('data-go="adapter-'), '卡片要能跳到对应的适配器子页');
  assert.ok(AD_JS.includes('AD.available'), 'adapter.js 没读服务端给的通道清单');
  assert.ok(AD_JS.includes('adRenderOnebot()'), '刷新时要渲染 OneBot 的状态格');
 });
