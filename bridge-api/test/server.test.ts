/**
 * 端到端：真起 HTTP 服务，真走判定层（`createApp`），只看 HTTP 上发生了什么。
 *
 * 为什么必须是真判定层而不是一个假的 handler：这一版最容易错的地方不是协议解析，
 * 而是"回执到底有没有从判定层走到队列里"。用假 handler 就永远测不到那一段 ——
 * 而它恰好是这次改动里唯一被换掉的东西（适配器 → API 通道）。
 *
 * 库用 `:memory:`：跑得快，也不会碰开发库。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { AppConfig } from '../../src/app.ts';
import { silentLogger } from '../../src/infra/logger.ts';
import type { BridgeConfig } from '../src/config.ts';
import { loadBridgeConfig } from '../src/config.ts';
import { buildBridge, type BridgeRuntime } from '../src/main.ts';
import type { InboundResponse, OutboundItem, OutboundResponse } from '../src/protocol.ts';

const TOKEN = 'bridge-test-token';
let runtime: BridgeRuntime;
let port = 0;

const url = (path: string): string => `http://127.0.0.1:${port}${path}`;
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function post(path: string, body: unknown, headers: Record<string, string> = auth) {
  const res = await fetch(url(path), { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string, headers: Record<string, string> = auth) {
  const res = await fetch(url(path), { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

before(async () => {
  const bridge: BridgeConfig = {
    ...loadBridgeConfig({}),
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    dbPath: ':memory:',
    longPollMaxMs: 2_000,
    capabilities: { buttons: false, images: true, inlineImages: false, richText: false },
  };
  const appConfig: AppConfig = {
    dbPath: ':memory:',
    port: 0,
    onebotApiBase: '',
    detailToPrivate: true,
    // 跑批/测试里不启动运维定时器（世界照常在每条指令前惰性推进）
    startOps: false,
    runTickOnStart: false,
  };
  runtime = buildBridge({ bridge, appConfig, logger: silentLogger });
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  port = (runtime.server.address() as AddressInfo).port;
});

after(() => {
  runtime.server.close();
  runtime.app.close();
});

test('鉴权：没带口令的 /api/v1/* 一律 401；带上就通', async () => {
  const denied = await post('/api/v1/inbound', { platform: 'probe' }, { 'content-type': 'application/json' });
  assert.equal(denied.status, 401);
  // ?token= 也认（浏览器 EventSource 带不了 header）
  const viaQuery = await fetch(url(`/api/v1/outbound?token=${TOKEN}&cursor=0`));
  assert.equal(viaQuery.status, 200);
  await viaQuery.json();
});

test('/health 不需要口令（探活用），并且能看出上游与队列状态', async () => {
  const res = await get('/health', {});
  assert.equal(res.status, 200);
  const body = res.body as { ok: boolean; characters: number; bridge: { outbox: { size: number } } };
  assert.equal(body.ok, true);
  assert.equal(typeof body.characters, 'number');
  assert.equal(typeof body.bridge.outbox.size, 'number');
});

test('入站 → 判定 → 出站：同步模式拿回执，队列里也有一份', async () => {
  const res = await post('/api/v1/inbound', {
    platform: 'probe',
    scene: 'private',
    sceneId: 'u-help',
    userId: 'u-help',
    nickname: '测试员',
    text: '.帮助',
    messageId: 'probe-1',
    sync: true,
  });
  assert.equal(res.status, 200);
  const body = res.body as unknown as InboundResponse;
  assert.equal(body.ok, true);
  assert.equal(body.accepted, true);
  const replies = body.replies ?? [];
  assert.ok(replies.length > 0, '同步模式必须把这条消息触发的回执带回来');
  assert.equal(replies[0]!.scene, 'private');
  assert.equal(replies[0]!.targetId, 'u-help');
  assert.equal(replies[0]!.platform, 'probe');
  assert.ok(replies[0]!.text.length > 0);
  assert.equal(body.cursor, replies[replies.length - 1]!.seq);
});

test('幂等：同一条 messageId 再投一次，判定层当它是重复的（不再产生回执）', async () => {
  const payload = {
    platform: 'probe',
    scene: 'private',
    sceneId: 'u-idem',
    userId: 'u-idem',
    text: '.帮助',
    messageId: 'probe-idem-1',
    sync: true,
  };
  const first = await post('/api/v1/inbound', payload);
  const firstReplies = (first.body as unknown as InboundResponse).replies ?? [];
  assert.ok(firstReplies.length > 0);
  const second = await post('/api/v1/inbound', payload);
  const secondReplies = (second.body as unknown as InboundResponse).replies ?? [];
  assert.equal(secondReplies.length, 0, '重发不该产生第二条回执');
});

test('轮询：不带 sync 时回执仍在队列里，按游标取得到', async () => {
  const before = await get('/api/v1/outbound?cursor=0&limit=1&platform=probe');
  const cursor = (before.body as unknown as OutboundResponse).cursor;
  const posted = await post('/api/v1/inbound', {
    platform: 'probe',
    scene: 'private',
    sceneId: 'u-poll',
    userId: 'u-poll',
    text: '.帮助',
    messageId: 'probe-poll-1',
  });
  assert.equal(posted.status, 200);
  const pulled = await get(`/api/v1/outbound?cursor=${cursor}&limit=20&platform=probe`);
  const batch = pulled.body as unknown as OutboundResponse;
  assert.equal(batch.ok, true);
  const mine = batch.items.filter((i: OutboundItem) => i.targetId === 'u-poll');
  assert.ok(mine.length > 0, '轮询必须能取到刚才那条回执');
  assert.ok(batch.cursor >= mine[mine.length - 1]!.seq);
});

test('长轮询：没有数据时会挂住，期间来了数据立刻返回', async () => {
  /*
   * 先把队列里已有的回执取干净。
   *
   * 不这么做的话，长轮询会**立刻**拿到前面用例留下的旧回执并返回 ——
   * 那样这条测试就没有测到"挂住"这一步（第一次写就是这么失败的：
   * 断言说没有新数据，其实是长轮询压根没等）。
   */
  const drain = await get('/api/v1/outbound?cursor=0&limit=200&platform=probe');
  const cursor = (drain.body as unknown as OutboundResponse).cursor;
  const started = Date.now();
  const pending = get(`/api/v1/outbound?cursor=${cursor}&limit=20&platform=probe&wait=2`);
  // 给它 150ms 挂上去，再送一条消息
  await new Promise((r) => setTimeout(r, 150));
  await post('/api/v1/inbound', {
    platform: 'probe',
    scene: 'private',
    sceneId: 'u-wait',
    userId: 'u-wait',
    text: '.帮助',
    messageId: 'probe-wait-1',
  });
  const pulled = await pending;
  const cost = Date.now() - started;
  const batch = pulled.body as unknown as OutboundResponse;
  assert.ok(
    batch.items.some((i: OutboundItem) => i.targetId === 'u-wait'),
    '长轮询必须被新数据唤醒',
  );
  assert.ok(cost < 1900, '应该是被唤醒而不是等满 2 秒，实际 ' + cost + 'ms');
});

test('入参不合法：400 并指出是哪个字段（不许静默丢掉拼错的字段）', async () => {
  const bad = await post('/api/v1/inbound', {
    platform: 'probe',
    scene: 'private',
    sceneId: 'u1',
    userid: 'u1',
    text: '.帮助',
  });
  assert.equal(bad.status, 400);
  const body = bad.body as { ok: boolean; issues?: string[] };
  assert.equal(body.ok, false);
  assert.ok((body.issues ?? []).length > 0, '400 里要说清楚哪个字段不对');
  const notJson = await fetch(url('/api/v1/inbound'), {
    method: 'POST',
    headers: auth,
    body: '{ 这不是 json',
  });
  assert.equal(notJson.status, 400);
  await notJson.json();
});

test('能力协商：POST 声明后 GET 读得到，且立刻按新能力走', async () => {
  const before = await get('/api/v1/capabilities?platform=probe');
  assert.equal((before.body as { capabilities: { buttons: boolean } }).capabilities.buttons, false);
  const set = await post('/api/v1/capabilities', {
    platform: 'probe',
    buttons: true,
    avatarTemplate: 'https://example.com/avatar/{userId}?s={size}',
  });
  assert.equal(set.status, 200);
  const after = await get('/api/v1/capabilities?platform=probe');
  const caps = (after.body as { capabilities: { buttons: boolean; avatarTemplate?: string } }).capabilities;
  assert.equal(caps.buttons, true);
  assert.equal(caps.avatarTemplate, 'https://example.com/avatar/{userId}?s={size}');
  // 拼错的键必须报错（inlineImage 少个 s）
  const typo = await post('/api/v1/capabilities', { platform: 'probe', inlineImage: true });
  assert.equal(typo.status, 400);
});

test('format=text：同步模式下响应体就是纯文本（易语言那类客户端免解析）', async () => {
  const res = await fetch(url('/api/v1/inbound?sync=true&format=text'), {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      platform: 'probe',
      scene: 'private',
      sceneId: 'u-text',
      userId: 'u-text',
      nickname: '探针',
      text: '.帮助',
      messageId: 'probe-text-1',
      sync: true,
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const text = await res.text();
  assert.ok(text.length > 0);
  assert.ok(!text.startsWith('{'), '纯文本模式不许返回 JSON：' + text.slice(0, 60));
  assert.match(text, /诡秘之主|帮助|创建/);
});

test('SSE：`/api/v1/stream` 是事件流，连上就有握手行', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url(`/api/v1/stream?token=${TOKEN}&platform=probe`), {
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value ?? new Uint8Array());
    assert.match(text, /: connected/);
    await reader.cancel();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
});
