/**
 * M2.76：网关会话的**跨进程续接**。
 *
 * 这一条守的是一个很具体的运营场景：**重启**（改配置 / 发版 / 崩了自动拉起）。
 * 没有落盘会话时，每次重启都是「重新登录」：
 *   · 白烧一次 session_start_limit 配额（一天 1500 次）；
 *   · **重启那几十秒里玩家发的消息永远不会被处理**，而机器人看起来一切正常。
 *
 * 所以判据也分两层：
 *   1. QQSessionStore 自己：节流、原子写、损坏文件不许把启动搞崩；
 *   2. 真的重启一遍（停掉适配器 → 新建一个读同一份文件）：
 *      第二次连接必须发 op 6 RESUME，而不是 op 2 IDENTIFY。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QQSessionStore } from '../src/infra/qq-session-store.ts';
import { QQOfficialAdapter } from '../src/adapter/qq-official/index.ts';
import { API_BASE_PROD } from '../src/adapter/qq-official/gateway.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（重启/建连这类跨 tick 的动作只能这样等） */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error('等不到：' + what);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'qq-sess-'));
}

/* ------------------------------------------------------------------ *
 * 一、落盘本身
 * ------------------------------------------------------------------ */

test('会话落盘：存 → 读往返，节流合并写，clear 之后文件真的没了', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'qq-session.json');
    let now = 1_000;
    const store = new QQSessionStore(file, { throttleMs: 30, now: () => now });

    assert.equal(store.load(), null, '还没有文件时是 null，不是抛异常');

    // 连续存三次：节流窗口内只应该落一次盘
    store.save({ sessionId: 's-1', seq: 10, url: 'wss://a', savedAt: 0 });
    store.save({ sessionId: 's-1', seq: 11, url: 'wss://a', savedAt: 0 });
    store.save({ sessionId: 's-1', seq: 12, url: 'wss://a', savedAt: 0 });
    store.flush();
    assert.equal(store.writes, 1, '三次 save 只该落一次盘');
    assert.equal(store.load()?.seq, 12, '落的是**最后**那个值，不是第一个');

    // flush 之后没有待写内容：再 flush 不该再写
    store.flush();
    assert.equal(store.writes, 1);

    now = 2_000;
    store.save({ sessionId: 's-1', seq: 20, url: 'wss://a', savedAt: 0 });
    store.flush();
    assert.equal(store.load()?.seq, 20);
    assert.equal(store.load()?.savedAt, 2_000, 'savedAt 是落盘那一刻的时钟');

    assert.ok(!existsSync(file + '.tmp'), '临时文件必须已经被 rename 掉（不然是半截文件）');

    store.clear();
    assert.equal(existsSync(file), false, 'clear 之后文件必须没了');
    assert.equal(store.load(), null);
    store.clear(); // 再清一次不该抛
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话落盘：文件损坏 / 字段不对时一律当「没有会话」，绝不把启动搞崩', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'qq-session.json');
    const store = new QQSessionStore(file, { throttleMs: 5 });

    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    assert.equal(store.load(), null, 'JSON 坏了要当没有');

    writeFileSync(file, JSON.stringify({ sessionId: '', seq: 3 }), 'utf8');
    assert.equal(store.load(), null, 'sessionId 是空串等于没有');

    writeFileSync(file, JSON.stringify({ sessionId: 's', seq: '3' }), 'utf8');
    assert.equal(store.load()?.seq, null, 'seq 是字符串就当没有 seq（宁可 identify，也不要带着脏 seq 去 resume）');

    writeFileSync(file, JSON.stringify({ sessionId: 's', seq: 3, url: 42 }), 'utf8');
    assert.equal(store.load()?.url, null);
    assert.equal(store.load()?.sessionId, 's', '其余字段仍然可用');

    // 目录不存在也要能写（第一次启动时 data/ 可能还没建）
    const nested = join(dir, 'a', 'b', 'session.json');
    const store2 = new QQSessionStore(nested, { throttleMs: 5 });
    store2.save({ sessionId: 's', seq: 1, url: null, savedAt: 0 });
    store2.flush();
    assert.equal(store2.load()?.sessionId, 's');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 二、真的重启一遍
 * ------------------------------------------------------------------ */

/** 可控的假 WebSocket（与 m2-75 里那份同源，这里只需要用到几个动作） */
class FakeWs {
  static instances: FakeWs[] = [];
  static reset(): void { FakeWs.instances = []; }
  readyState = 0;
  sent: string[] = [];
  #listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor(url: string) { this.url = url; FakeWs.instances.push(this); }
  url: string;
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
  hello(): void { this.frame({ op: 10, d: { heartbeat_interval: 40_000 } }); }
  ready(sessionId: string): void {
    this.frame({ op: 0, t: 'READY', s: 1, d: { session_id: sessionId, user: { id: '1', username: 'bot' } } });
  }
  opcodes(): number[] { return this.sent.map((raw) => (JSON.parse(raw) as { op: number }).op); }
  framesWith(op: number): Array<Record<string, unknown>> {
    return this.sent
      .map((raw) => JSON.parse(raw) as { op: number; d?: Record<string, unknown> })
      .filter((f) => f.op === op)
      .map((f) => f.d ?? {});
  }
}


/** 把全局 WebSocket 换成假的、把全局 fetch 换成**会抛错**的（任何绕过注入的调用当场炸） */
function sealFakeNetwork(): () => void {
  const savedWs = globalThis.WebSocket;
  const savedFetch = globalThis.fetch;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWs as unknown as typeof WebSocket;
  (globalThis as { fetch: unknown }).fetch = (() => {
    throw new Error('测试里不许打真实网络：这个调用没有走注入的 fetch');
  }) as unknown as typeof fetch;
  return () => {
    (globalThis as { WebSocket: unknown }).WebSocket = savedWs;
    (globalThis as { fetch: unknown }).fetch = savedFetch;
  };
}

/** 假 fetch：换 token + 取网关地址（适配器与令牌管理器共用这一个） */
function fakeFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (/getAppAccessToken/.test(url)) {
      return new Response(JSON.stringify({ access_token: 'tk-0123456789abcdef', expires_in: '7200' }), { status: 200 });
    }
    if (/gateway/.test(url)) {
      return new Response(JSON.stringify({ url: 'wss://fake.invalid/websocket' }), { status: 200 });
    }
    throw new Error('测试没有为这个 URL 准备响应：' + url);
  }) as unknown as typeof fetch;
}

async function bootAdapter(sessionFile: string): Promise<{ adapter: QQOfficialAdapter; ws: FakeWs }> {
  const adapter = new QQOfficialAdapter(
    { appId: '1020', clientSecret: 's', apiBase: API_BASE_PROD, sessionFile } as never,
    { fetch: fakeFetch() },
  );
  const starting = adapter.start();
  await waitFor('网关 socket 建立', () => FakeWs.instances.length > 0);
  const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
  ws.open();
  await starting;
  return { adapter, ws };
}

test('重启续接：第一次跑完把会话落盘，第二次启动发的是 RESUME 而不是 IDENTIFY', async () => {
  const dir = tempDir();
  const restore = sealFakeNetwork();
  try {
    const file = join(dir, 'qq-session.json');

    // ── 第一次启动 ──────────────────────────────────────────
    FakeWs.reset();
    const first = await bootAdapter(file);
    first.ws.hello();
    await sleep(20);
    assert.ok(first.ws.opcodes().includes(2), '第一次启动当然要 identify');

    first.ws.ready('sess-abc');
    first.ws.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 42, d: {} });
    await sleep(20);
    first.adapter.stop();   // stop() 会 flush —— 相当于优雅退出

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { sessionId: string; seq: number };
    assert.equal(onDisk.sessionId, 'sess-abc', '会话必须落盘，否则下次重启没法续');
    assert.equal(onDisk.seq, 42, 'seq 是「从哪之后补发」的依据，必须落下来');

    // ── 第二次启动（模拟重启：新的适配器、新的 socket、同一个文件）──
    FakeWs.reset();
    const second = await bootAdapter(file);
    second.ws.hello();
    await sleep(20);

    const opcodes = second.ws.opcodes();
    assert.ok(opcodes.includes(6), '重启后应当 resume（op 6）—— 这是这一整块存在的理由');
    assert.ok(!opcodes.includes(2), '重启后不该再 identify（白烧一次配额）');
    const resume = second.ws.framesWith(6)[0]!;
    assert.equal(resume.session_id, 'sess-abc');
    assert.equal(resume.seq, 42, 'resume 要带上次收到的 seq，平台据此补发漏掉的事件');

    // 平台确认恢复：这次重启既没烧配额，也没丢事件
    second.ws.frame({ op: 0, t: 'RESUMED', s: 43, d: {} });
    await sleep(20);
    assert.equal(second.adapter.gateway.stats.resumedFromDisk, true);
    assert.equal(second.adapter.gateway.stats.identifies, 0, '整个第二次启动一次 identify 都没有');

    second.adapter.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
});

test('重启续接：只有 sessionId 没有 seq 时不许假装能 resume（那会换来一次 4007）', async () => {
  const dir = tempDir();
  const restore = sealFakeNetwork();
  try {
    const file = join(dir, 'qq-session.json');
    // 造一份「有 sessionId 但没有 seq」的落盘（现实中出现在：连上过、但一条带序号的事件都没收到）
    writeFileSync(file, JSON.stringify({ sessionId: 'sess-x', seq: null, url: null, savedAt: Date.now() }), 'utf8');

    FakeWs.reset();
    const { adapter, ws } = await bootAdapter(file);
    ws.hello();
    await sleep(20);
    assert.ok(ws.opcodes().includes(2), '没有 seq 就只能 identify');
    assert.ok(!ws.opcodes().includes(6), '带着 null 的 seq 去 resume 会被平台回 4007');
    adapter.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
});

test('会话作废时盘上那份也要删掉（否则下次重启还会拿死会话去 resume）', async () => {
  const dir = tempDir();
  const restore = sealFakeNetwork();
  try {
    const file = join(dir, 'qq-session.json');
    FakeWs.reset();
    const { adapter, ws } = await bootAdapter(file);
    ws.hello();
    ws.ready('sess-dead');
    ws.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 7, d: {} });
    await sleep(20);
    adapter.stop();
    assert.ok(existsSync(file), '先确认它真的落过盘');

    // 重启一次，然后让平台回 4006（无效 session）
    FakeWs.reset();
    const second = await bootAdapter(file);
    second.ws.hello();
    await sleep(20);
    assert.ok(second.ws.opcodes().includes(6), '这一次应当先试着 resume');
    second.ws.close(4006, 'invalid session');
    await waitFor('盘上的会话被清掉', () => !existsSync(file));
    second.adapter.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
});
