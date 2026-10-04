/**
 * API 通道：能力协商、降级契约、出站定向。
 *
 * 这一层最容易出错的三处（都在既有通道上踩过）：
 *   1. `sendInteractive` 该返回 false 的时候返回了 true ⇒ 调用方以为发出去了，
 *      玩家看到一条**没有选项**的消息（选项只在按钮里，而按钮没发）；
 *   2. 出站没标记来源 ⇒ 两条上游同时在线时，A 的回复被 B 发出去；
 *   3. `noHeader` 被忽略 ⇒ 世界里说话的消息顶着某个玩家的头像。
 *
 * ⚠️ 能力与头像模板是**按上游**算的，而"这条上游"由处理上下文决定 ——
 * 所以下面凡是依赖它的断言都写在 `within()` 里（那就是判定层真实的位置）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InternalMessage } from '../../src/adapter/types.ts';
import { silentLogger } from '../../src/infra/logger.ts';
import { ApiChannel } from '../src/channel.ts';
import { Outbox } from '../src/outbox.ts';
import type { OutboundItem } from '../src/protocol.ts';

function build(options: { imageMode?: 'base64' | 'url' | 'both'; inlineUploadTtlMs?: number } = {}) {
  const outbox = new Outbox(50);
  const channel = new ApiChannel({
    outbox,
    logger: silentLogger,
    ...(options.imageMode !== undefined ? { imageMode: options.imageMode } : {}),
    ...(options.inlineUploadTtlMs !== undefined ? { inlineUploadTtlMs: options.inlineUploadTtlMs } : {}),
    now: () => 1_700_000_000_000,
  });
  return { outbox, channel };
}

const msg = (over: Partial<InternalMessage> = {}): InternalMessage => ({
  messageId: 'm1',
  platform: 'bridge',
  scene: 'private',
  sceneId: 'u1',
  userId: 'u1',
  nickname: '克莱恩',
  rawText: '.状态',
  timestamp: 1_700_000_000_000,
  ...over,
});

/** 在"这条上游正在处理消息"的上下文里跑一段（能力 / 头像模板都按那条上游算） */
async function within<T>(channel: ApiChannel, platform: string, fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  let called = false;
  channel.onMessage(async () => {
    result = await fn();
    called = true;
  });
  await channel.deliver(msg(), platform);
  assert.equal(called, true, 'handler 应该被调用');
  return result as T;
}

test('能力：默认最保守（不摆按钮 / 能发图 / 不内联 / 不富文本）', () => {
  const { channel } = build();
  assert.equal(channel.supportsButtons, false);
  assert.equal(channel.supportsImages, true);
  assert.equal(channel.supportsInlineImages, false);
  assert.equal(channel.supportsRichText, false);
});

test('sendInteractive：不支持按钮时返回 false（让调用方降级，而不是抛异常）', async () => {
  const { outbox, channel } = build();
  const sent = await channel.sendInteractive('private', 'u1', {
    text: '【下一步】',
    options: [{ id: '1', label: '去码头', command: '走 码头' }],
  });
  assert.equal(sent, false);
  assert.equal(outbox.stats.size, 0, '说不支持就不该偷偷塞一条进队列');
});

test('能力改口后立刻生效：按钮能摆了，选项也进了队列', async () => {
  const { outbox, channel } = build();
  channel.setCapabilities('koishi', { buttons: true });
  assert.equal(channel.supportsButtons, false, '不在那条上游的上下文里时仍是缺省档');
  const sent = await within(channel, 'koishi', () =>
    channel.sendInteractive('private', 'u1', {
      text: '【下一步】',
      options: [{ id: '1', label: '去码头', command: '走 码头', preview: '危险 ×1.2' }],
    }),
  );
  assert.equal(channel.supportsButtons, false, '出了上下文就回到缺省档');
  assert.equal(sent, true);
  const item = outbox.take({ cursor: 0, limit: 10 }).items[0]!;
  assert.equal(item.kind, 'interactive');
  assert.equal(item.platform, 'koishi', '出站必须标上"回给哪条上游"');
  assert.equal(item.options?.[0]?.id, '1');
  assert.equal(item.options?.[0]?.preview, '危险 ×1.2');
});

test('sendInteractive：一个可点的东西都没有时也返回 false（与 canUseButtons 同一条判据）', async () => {
  const { channel } = build();
  channel.setCapabilities('koishi', { buttons: true });
  const sent = await within(channel, 'koishi', () =>
    channel.sendInteractive('private', 'u1', { text: '只有正文', options: [] }),
  );
  assert.equal(sent, false);
});

test('noHeader：世界播报那种消息不许顶玩家头像', async () => {
  const { outbox, channel } = build();
  channel.setCapabilities('koishi', { buttons: true });
  await within(channel, 'koishi', () =>
    channel.sendInteractive('private', 'u1', {
      text: '图 + 按钮',
      options: [{ id: '1', label: '看', command: '看' }],
      noHeader: true,
    }),
  );
  const item = outbox.take({ cursor: 0, limit: 10 }).items[0]!;
  assert.equal(item.header, undefined);
});

test('出站定向：入站触发的回执带来源，主动推送不带（于是谁都拿得到）', async () => {
  const { outbox, channel } = build();
  await within(channel, 'bee', async () => {
    await channel.sendPrivate('u1', '这是回执');
  });
  await channel.sendGroup('g1', '这是世界在说话', null);
  const items = outbox.take({ cursor: 0, limit: 10 }).items;
  assert.equal(items[0]?.platform, 'bee');
  assert.equal(items[1]?.platform, undefined);
  assert.equal(items[1]?.header, undefined, '主动推送传了 null 就不要信息头');
});

test('并发：两条上游同时进来，回执各自定向回自己那条', async () => {
  const { outbox, channel } = build();
  channel.onMessage(async (m) => {
    if (m.userId === 'bee-user') {
      await channel.sendPrivate('bee-user', 'A');
      return;
    }
    // 故意慢一点，制造"两条同时在飞"的时序
    await new Promise((r) => setTimeout(r, 5));
    await channel.sendPrivate('koishi-user', 'B');
  });
  await Promise.all([
    channel.deliver(msg({ userId: 'bee-user' }), 'bee'),
    channel.deliver(msg({ userId: 'koishi-user', messageId: 'm2' }), 'koishi'),
  ]);
  const items = outbox.take({ cursor: 0, limit: 10 }).items;
  const platformOf = new Map(items.map((i) => [i.text, i.platform]));
  assert.equal(platformOf.get('A'), 'bee');
  assert.equal(platformOf.get('B'), 'koishi');
});

test('头像：模板里的 {userId} / {size} 会被替换；没模板就没有头像', async () => {
  const { channel } = build();
  // 头像模板是**这条上游的**属性，所以要在处理这条上游的消息时才问得到
  await within(channel, 'probe', async () => {
    assert.equal(channel.avatarUrlForUser('20001'), undefined);
  });
  channel.setCapabilities('koishi', { avatarTemplate: 'https://q1.qlogo.cn/g?b=qq&nk={userId}&s={size}' });
  await within(channel, 'koishi', async () => {
    assert.equal(
      channel.avatarUrlForUser('20001', 640),
      'https://q1.qlogo.cn/g?b=qq&nk=20001&s=640',
    );
  });
});

test('消息头：把 avatarUserId 换成直链（通道知道怎么拼，判定层只知道是谁）', async () => {
  const { outbox, channel } = build();
  channel.setCapabilities('koishi', {
    avatarTemplate: 'https://q1.qlogo.cn/g?b=qq&nk={userId}&s={size}',
  });
  await within(channel, 'koishi', async () => {
    await channel.sendPrivate('u1', '正文', {
      nickname: '克莱恩',
      genderTag: '♂',
      pathwayLine: '愚者 · 序列 9',
      avatarUserId: '20001',
    });
  });
  const item = outbox.take({ cursor: 0, limit: 10 }).items[0]!;
  assert.equal(item.header?.nickname, '克莱恩');
  assert.equal(item.header?.genderTag, '♂');
  assert.equal(item.header?.avatarUrl, 'https://q1.qlogo.cn/g?b=qq&nk=20001&s=100');
});

test('图片：默认给 base64；切到 url 模式就只给 url', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const base = build();
  const ok = await base.channel.sendImage('private', 'u1', {
    bytes,
    mediaType: 'image/png',
    alt: '角色卡',
    url: 'https://example.com/card.png',
  });
  assert.equal(ok, true);
  const item = base.outbox.take({ cursor: 0, limit: 10 }).items[0]!;
  assert.equal(item.kind, 'image');
  assert.equal(item.image?.base64, Buffer.from(bytes).toString('base64'));
  assert.equal(item.image?.url, undefined, 'base64 模式下不给 url —— 免得上游拿了个访问不了的地址');
  assert.equal(item.image?.alt, '角色卡');

  const byUrl = build({ imageMode: 'url' });
  await byUrl.channel.sendImage('private', 'u1', {
    bytes,
    mediaType: 'image/png',
    url: 'https://example.com/card.png',
  });
  const urlItem = byUrl.outbox.take({ cursor: 0, limit: 10 }).items[0]!;
  assert.equal(urlItem.image?.base64, undefined);
  assert.equal(urlItem.image?.url, 'https://example.com/card.png');
});

test('图片：这条通道不能发图时返回 false（调用方回退文本）', async () => {
  const { channel } = build();
  channel.setCapabilities('koishi', { images: false });
  const ok = await within(channel, 'koishi', () =>
    channel.sendImage('private', 'u1', { bytes: new Uint8Array([1]), mediaType: 'image/png' }),
  );
  assert.equal(ok, false);
});

/*
 * ── 反向通道：请上游把图换成公网 URL（协议里唯一一条反向的路）──
 *
 * 用户口径：「图片又没和按钮做一条消息发送了，老坑」。官方通道下富媒体图片与
 * markdown 正文**互斥**，要合成一条只能让图变成 markdown 里的一行 ——
 * 也就是必须拿到一个能写进正文的公网 URL。字节在服务端、上传凭据在上游，
 * 所以只能来回这一趟；而这里的四条断言钉的就是这一趟的四个出口。
 */
test('反向通道：声明 inlineUpload 后，图会走「请上游换 URL」并拿到它', async () => {
  const { outbox, channel } = build();
  channel.setCapabilities('koishi', { inlineUpload: true });
  const url = await within(channel, 'koishi', async () => {
    const pending = channel.prepareInlineImage('group', 'g1', {
      bytes: new Uint8Array([137, 80, 78, 71]),
      mediaType: 'image/png',
      alt: '角色卡',
    });
    const item = outbox.take({ cursor: 0, limit: 10 }).items.find((i) => i.kind === 'upload');
    assert.ok(item !== undefined, '应该有一条 kind=upload 的请求');
    assert.ok(item.requestId !== undefined && item.requestId !== '', '要带一个回执号');
    assert.equal(item.image?.base64, Buffer.from([137, 80, 78, 71]).toString('base64'));
    assert.equal(channel.resolveInlineUpload(item.requestId, 'https://x.myqcloud.com/a.png'), true);
    return pending;
  });
  assert.equal(url, 'https://x.myqcloud.com/a.png');
});

test('反向通道：没声明 inlineUpload 的通道直接回落，且一个字节都不往队列里塞', async () => {
  const { outbox, channel } = build();
  const url = await within(channel, 'onebot', () =>
    channel.prepareInlineImage('group', 'g1', { bytes: new Uint8Array([1]), mediaType: 'image/png' }),
  );
  assert.equal(url, undefined);
  assert.equal(outbox.take({ cursor: 0, limit: 10 }).items.length, 0);
});

test('反向通道：上游不回传就按时限回落（图还能单独发一条，不会把命令卡死）', async () => {
  const { channel } = build({ inlineUploadTtlMs: 30 });
  channel.setCapabilities('koishi', { inlineUpload: true });
  const url = await within(channel, 'koishi', () =>
    channel.prepareInlineImage('group', 'g1', { bytes: new Uint8Array([1]), mediaType: 'image/png' }),
  );
  assert.equal(url, undefined);
});

test('反向通道：上游回一句空 url，按「换不到」处理（空串不能被当成有效直链）', async () => {
  const { outbox, channel } = build();
  channel.setCapabilities('koishi', { inlineUpload: true });
  const url = await within(channel, 'koishi', async () => {
    const pending = channel.prepareInlineImage('group', 'g1', {
      bytes: new Uint8Array([1]),
      mediaType: 'image/png',
    });
    const item = outbox.take({ cursor: 0, limit: 10 }).items.find((i) => i.kind === 'upload')!;
    channel.resolveInlineUpload(item.requestId!, '   ');
    return pending;
  });
  assert.equal(url, undefined);
});

test('反向通道：号对不上时返回 false（不是错误，只是没人等了）', () => {
  const { channel } = build();
  assert.equal(channel.resolveInlineUpload('不存在的号', 'https://x/a.png'), false);
});

test('ready：还没装上处理器时不许说"已受理"', async () => {
  const { channel } = build();
  assert.equal(channel.ready, false);
  assert.deepEqual(await channel.deliver(msg(), 'bee'), [], '没人接就返回空，不能假装处理了');
  const seen: string[] = [];
  channel.onMessage((m) => {
    seen.push(m.rawText);
  });
  assert.equal(channel.ready, true);
  await channel.deliver(msg({ rawText: '.世界' }), 'bee');
  assert.deepEqual(seen, ['.世界']);
});

test('上游台账：谁在动、动了多少，看得见（排查"它是不是断了"）', async () => {
  const { channel } = build();
  await channel.deliver(msg(), 'bee');
  await channel.deliver(msg({ messageId: 'm2' }), 'bee');
  channel.touch('koishi');
  const rows = channel.upstreams().sort((a, b) => a.platform.localeCompare(b.platform));
  assert.deepEqual(rows.map((r) => [r.platform, r.inbound]), [['bee', 2], ['koishi', 0]]);
  assert.equal(channel.isAnyUpstreamAlive(), true);
});

test('同步捕获：本次入站触发的回执会被单独记一份（但队列里也有）', async () => {
  const { outbox, channel } = build();
  channel.onMessage(async () => {
    await channel.sendPrivate('u1', '第一条');
    await channel.sendPrivate('u1', '第二条');
  });
  const captured: OutboundItem[] = await channel.deliver(msg(), 'bee');
  assert.deepEqual(captured.map((i) => i.text), ['第一条', '第二条']);
  assert.deepEqual(outbox.take({ cursor: 0, limit: 10 }).items.map((i) => i.text), ['第一条', '第二条']);
});
