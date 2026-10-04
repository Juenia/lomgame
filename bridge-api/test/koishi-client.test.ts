/**
 * Koishi 侧桥接逻辑（零 Koishi 依赖的那一半）。
 *
 * 这里最有价值的一条是**对拍**：上游把 `interactive` 渲染成文本时，
 * 排版必须与判定层自己的 `renderInteractiveText` **逐字一致** ——
 * 否则同一个菜单在"声明按钮"前后会变成两种样子，而玩家只会觉得菜单坏了。
 *
 * 插件本体（index.ts）需要 Koishi 运行时才能加载，本仓库没有那个依赖；
 * 所以它只剩接线，逻辑全在这边被测到。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderInteractiveText } from '../../src/adapter/interactive.ts';
import { BridgeClient, BridgeError, imageSrc, isBlockedGroup, parseBlockedGroups, renderOutbound, startOutboundLoop } from '../integrations/koishi/src/client.ts';
import type { OutboundItem } from '../src/protocol.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('inbound：请求体与鉴权头（字段名一个都不能错）', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, accepted: true } }));
  const client = new BridgeClient({ apiBase: 'http://127.0.0.1:3200/', token: 'secret', platform: 'koishi', fetchImpl: impl });
  await client.inbound({
    scene: 'group',
    sceneId: '901',
    userId: '20001',
    nickname: '克莱恩',
    text: '.状态',
    messageId: 'm-1',
  });
  const call = calls[0]!;
  assert.equal(call.url, 'http://127.0.0.1:3200/api/v1/inbound', 'apiBase 末尾的斜杠要被吃掉，不能拼出 //');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['authorization'], 'Bearer secret');
  assert.deepEqual(JSON.parse(call.body), {
    platform: 'koishi',
    scene: 'group',
    sceneId: '901',
    userId: '20001',
    nickname: '克莱恩',
    text: '.状态',
    messageId: 'm-1',
  });
});

test('outbound：查询参数（游标、平台、长轮询秒数）', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, items: [], cursor: 7 } }));
  const client = new BridgeClient({ apiBase: 'http://127.0.0.1:3200', platform: 'koishi', fetchImpl: impl });
  const batch = await client.outbound(7, 25);
  assert.equal(batch.cursor, 7);
  const parsed = new URL(calls[0]!.url);
  assert.equal(parsed.pathname, '/api/v1/outbound');
  assert.equal(parsed.searchParams.get('cursor'), '7');
  assert.equal(parsed.searchParams.get('platform'), 'koishi');
  assert.equal(parsed.searchParams.get('wait'), '25');
  assert.equal(parsed.searchParams.get('limit'), '20');
});

test('错误：服务端说的话要原样带出来（401 与 400 的修法完全不同）', async () => {
  const { impl } = fakeFetch(() => ({ status: 401, body: { ok: false, error: 'unauthorized' } }));
  const client = new BridgeClient({ apiBase: 'http://127.0.0.1:3200', fetchImpl: impl });
  await assert.rejects(
    () => client.outbound(0, 0),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal((error as BridgeError).status, 401);
      assert.match((error as Error).message, /401/);
      return true;
    },
  );
});

test('渲染：text / image 两种形态', () => {
  const text: OutboundItem = { seq: 1, kind: 'text', scene: 'private', targetId: 'u1', text: '正文', createdAt: 0 };
  assert.equal(renderOutbound(text).text, '正文');

  const image: OutboundItem = {
    seq: 2,
    kind: 'image',
    scene: 'private',
    targetId: 'u1',
    text: '',
    image: { mediaType: 'image/png', base64: 'AAAA', alt: '角色卡' },
    createdAt: 0,
  };
  const rendered = renderOutbound(image);
  assert.equal(rendered.image?.mediaType, 'image/png');
  assert.equal(rendered.image?.base64, 'AAAA');
});

test('渲染对拍：interactive 的排版必须与判定层的 renderInteractiveText 逐字一致', () => {
  const item: OutboundItem = {
    seq: 3,
    kind: 'interactive',
    scene: 'private',
    targetId: 'u1',
    text: '【下一步】',
    options: [
      { id: '1', label: '去码头', command: '走 码头', preview: '危险 ×1.2' },
      { id: '2', label: '睡觉', command: '休息', disabled: true, disabledReason: '天亮了' },
    ],
    createdAt: 0,
  };
  const mine = renderOutbound(item).text;
  const theirs = renderInteractiveText({
    text: item.text,
    options: item.options!.map((o) => ({
      id: o.id,
      label: o.label,
      command: o.command,
      ...(o.preview !== undefined ? { preview: o.preview } : {}),
      ...(o.disabled === true ? { disabled: true, disabledReason: o.disabledReason } : {}),
    })),
  });
  assert.equal(mine, theirs);
});

test('渲染对拍：freeformLabel = null 时两边都不出「0. 自己写一个行为」', () => {
  const item: OutboundItem = {
    seq: 4,
    kind: 'interactive',
    scene: 'private',
    targetId: 'u1',
    text: '【下一步】',
    options: [{ id: '1', label: '去码头', command: '走 码头' }],
    freeformLabel: null,
    createdAt: 0,
  };
  const mine = renderOutbound(item).text;
  const theirs = renderInteractiveText({
    text: item.text,
    options: [{ id: '1', label: '去码头', command: '走 码头' }],
    freeformLabel: null,
  });
  assert.equal(mine, theirs);
  assert.ok(!mine.includes('自己写一个行为'));
});

test('出站循环：游标推进、逐条投递、stop 之后不再取', async () => {
  const delivered: number[] = [];
  const batches = [
    { ok: true as const, items: [{ seq: 1 }, { seq: 2 }] as unknown as OutboundItem[], cursor: 2 },
    { ok: true as const, items: [{ seq: 3 }] as unknown as OutboundItem[], cursor: 3 },
  ];
  let calls = 0;
  const client = {
    outbound: async (cursor: number) => {
      calls += 1;
      return batches.shift() ?? { ok: true as const, items: [], cursor };
    },
  } as unknown as BridgeClient;
  const logs: string[] = [];
  const loop = startOutboundLoop({
    client,
    waitSec: 0,
    idleMs: 5,
    sleep: async () => undefined,
    logger: { info: () => undefined, warn: (m) => logs.push(m), error: () => undefined },
    deliver: async (item) => {
      delivered.push(item.seq);
      if (item.seq === 2) loop.stop(); // 第 2 条之后就停（模拟 dispose）
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(delivered, [1, 2]);
  assert.ok(calls >= 1);
  assert.equal(loop.cursor(), 2);
});

test('出站循环：gap 要报警（队列被裁剪过 = 有回执永远丢了）', async () => {
  const warnings: Array<Record<string, unknown>> = [];
  const client = {
    outbound: async (cursor: number) => ({ ok: true as const, items: [], cursor, gap: true, earliest: 42 }),
  } as unknown as BridgeClient;
  let stopped = false;
  const loop = startOutboundLoop({
    client,
    // waitSec=0 时循环靠 idleMs 退让（配置里写 0 也不会变成死循环）
    waitSec: 0,
    idleMs: 5,
    sleep: async () => {
      stopped = true;
      loop.stop();
    },
    logger: { info: () => undefined, warn: (m, meta) => warnings.push({ m, ...(meta ?? {}) }), error: () => undefined },
    deliver: async () => undefined,
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(stopped, true);
  assert.ok(warnings.some((w) => String(w.m).includes('裁剪')), '必须报出来，实际：' + JSON.stringify(warnings));
});

test('出站循环：单条投递失败不打断整条桥（下一个群还要用）', async () => {
  const delivered: number[] = [];
  const errors: string[] = [];
  const batches = [
    { ok: true as const, items: [{ seq: 1 }, { seq: 2 }] as unknown as OutboundItem[], cursor: 2 },
  ];
  const client = {
    outbound: async (cursor: number) => batches.shift() ?? { ok: true as const, items: [], cursor },
  } as unknown as BridgeClient;
  const loop = startOutboundLoop({
    client,
    waitSec: 0,
    idleMs: 5,
    sleep: async () => loop.stop(),
    logger: { info: () => undefined, warn: () => undefined, error: (m) => errors.push(m) },
    deliver: async (item) => {
      delivered.push(item.seq);
      if (item.seq === 1) throw new Error('这个群发不出去');
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(delivered, [1, 2], '第 1 条失败后第 2 条仍要发');
  assert.equal(errors.length, 1);
});

/*
 * ── 图片 src（一条真机 bug 留下来的判据）────────────────────────────
 *
 * 现场：koishi + **QQ 官方通道**，按钮正常、markdown 正常，**图一张都出不来**。
 *
 * 断在元素工厂那一步：Satori 的 createAssetFactory（`@satorijs/element`）
 * 对**非字符串**的 src 用的默认前缀是 `base64://`：
 *
 *     h.image(buffer)   →   src = "base64://<base64>"
 *
 * 而 QQ 官方适配器（`@satorijs/adapter-qq` 的 `sendFile`）只认
 *
 *     /^data:([\w/.+-]+);base64,(.*)$/
 *
 * 前缀对不上、又不是 http(s)，于是掉进「本地资源」那条分支，图被静默丢掉
 * （适配器把错误收进 this.errors，消息照发、只是没有图）。
 *
 * 所以判据钉死：**拼出来必须是 `data:…;base64,…`，且绝不能带 `base64://`。**
 */
test('图片 src：base64 拼成 data: URI —— 这正是官方适配器唯一认得的前缀', () => {
  const src = imageSrc({ base64: 'AAEC', mediaType: 'image/png' });
  assert.equal(src, 'data:image/png;base64,AAEC');
  assert.ok(src !== undefined && !src.startsWith('base64://'), '绝不能是 Satori 的默认前缀 base64://');
});

test('图片 src：只有 url 时原样用它；两样都没有时 undefined（调用方退回纯文字）', () => {
  assert.equal(imageSrc({ url: 'https://x.example/a.png', mediaType: 'image/png' }), 'https://x.example/a.png');
  assert.equal(imageSrc({ mediaType: 'image/png' }), undefined);
  assert.equal(imageSrc({ base64: '', url: '', mediaType: 'image/png' }), undefined);
});

/*
 * ── 屏蔽群 ──────────────────────────────────────────────────────
 *
 * 用户口径：「加个屏蔽群，一行一个，被屏蔽的群不会主动推送，也不会处理指令」。
 * 入站与出站**两条路都要挡**（只挡一半 = 世界还在为这个群跑，播报照样灌进去），
 * 这里钉的是判断本身：名单怎么解析，以及「只挡群」这条边界。
 */
test('屏蔽群：一行一个，空行与 # 注释忽略，前后空白吃掉', () => {
  const blocked = parseBlockedGroups(' 12345 \n\n# 这个群太吵\n67890\r\n   \n');
  assert.deepEqual([...blocked].sort(), ['12345', '67890']);
});

test('屏蔽群：只挡群 —— 私聊与频道不受影响（屏蔽群 ≠ 封玩家）', () => {
  const blocked = parseBlockedGroups('12345');
  assert.equal(isBlockedGroup(blocked, 'group', '12345'), true);
  assert.equal(isBlockedGroup(blocked, 'group', '99999'), false);
  assert.equal(isBlockedGroup(blocked, 'private', '12345'), false, '私聊不过滤：他私聊还能照玩');
  assert.equal(isBlockedGroup(blocked, 'channel', '12345'), false);
});

test('屏蔽群：没配（空串 / undefined）时谁都不挡', () => {
  assert.equal(parseBlockedGroups('').size, 0);
  assert.equal(parseBlockedGroups(undefined).size, 0);
  assert.equal(isBlockedGroup(parseBlockedGroups(''), 'group', '12345'), false);
});
