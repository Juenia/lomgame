import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfficialAdapter } from '../src/adapter/official.ts';
import { QQOfficialAdapter } from '../src/adapter/qq-official/index.ts';
import type { HttpPost } from '../src/adapter/onebot.ts';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function capture(): { post: HttpPost; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    post: (async (url: string, body: unknown) => {
      calls.push({ url, body: body as Record<string, unknown> });
      return { status: 'ok' };
    }) as unknown as HttpPost,
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

test('官方通道：有公网 URL 时发 markdown 图片（msg_type=2、content 必须为空）', async () => {
  const { post, calls } = capture();
  const adapter = new OfficialAdapter({ appId: '1', accessToken: 't' }, post);
  const sent = await adapter.sendImage('group', 'g1', {
    bytes: PNG,
    mediaType: 'image/png',
    alt: '克莱恩的角色卡',
    url: 'https://bot.example.com/cards/x_1_20260101.png',
  });

  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  const body = calls[0]!.body;
  // 官方原文：传了 markdown 之后 content 必须为空。这一条是硬约束，写错整条消息被拒。
  assert.equal(body.msg_type, 2);
  assert.equal(body.content, '');
  const md = (body.markdown as { content: string }).content;
  assert.match(md, /^!\[克莱恩的角色卡 #600px #968px\]\(https:\/\/bot\.example\.com\/cards\/x_1_20260101\.png\)$/);
  assert.ok(calls[0]!.url.includes('/v2/groups/g1/messages'), `发到群的接口：${calls[0]!.url}`);
});

test('官方通道：只给字节没有 URL 时返回 false（本地字节对平台没用）', async () => {
  const { post, calls } = capture();
  const adapter = new OfficialAdapter({ appId: '1', accessToken: 't' }, post);
  const sent = await adapter.sendImage('group', 'g1', { bytes: PNG, mediaType: 'image/png' });
  assert.equal(sent, false);
  assert.equal(calls.length, 0, '不该发出任何请求');
});

test('官方通道：单聊图片走 users 接口', async () => {
  const { post, calls } = capture();
  const adapter = new OfficialAdapter({ appId: '1', accessToken: 't' }, post);
  await adapter.sendImage('private', 'u1', {
    bytes: PNG,
    mediaType: 'image/png',
    alt: '卡',
    url: 'https://bot.example.com/cards/a.png',
  });
  assert.ok(calls[0]!.url.includes('/v2/users/u1/messages'), calls[0]!.url);
});

test('官方通道：supportsImages 为真时才有能力（图片是 markdown 的一行）', () => {
  const adapter = new OfficialAdapter({ appId: '1', accessToken: 't' }, capture().post);
  assert.equal(adapter.supportsImages, true);
  // 观测计数：出图后可用于真机核对「平台到底收到几条图消息」
  assert.equal(adapter.imagesSent, 0);
});

test('官方通道：图片尺寸写死在标签里（不写会让竖版卡占满整屏）', async () => {
  const { post, calls } = capture();
  const adapter = new OfficialAdapter({ appId: '1', accessToken: 't' }, post);
  await adapter.sendImage('group', 'g1', {
    bytes: PNG, mediaType: 'image/png', alt: '卡', url: 'https://x/y.png',
  });
  const md = (calls[0]!.body.markdown as { content: string }).content;
  assert.match(md, /#600px #968px/, '缺尺寸标注');
});

/** 官方富媒体上传的假 fetch：记录方法 / 路径 / body / headers，四步都回 200 */
function fakeMediaFetch(
  calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const input = String(url);
    const method = init?.method ?? 'GET';
    // PUT 的 body 是分片字节，只有 JSON 请求才解析
    const isJson = typeof init?.body === 'string';
    calls.push({
      url: input,
      method,
      body: isJson ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    /*
     * 真实 Response **一定**带 headers（`#postOnce` 会读 `X-Tps-trace-ID`）。
     * 早先的假 fetch 没造 headers —— sendImage 改走 `#post` 之后，
     * `response.headers.get` 直接把用例打成了 TypeError。**假对象要与真对象同形**。
     */
    const headers = { get: () => null };
    if (method === 'PUT') return { ok: true, status: 200, headers, text: async () => '' } as any;
    if (input.includes('upload_prepare')) {
      return {
        ok: true, status: 200, headers,
        text: async () => JSON.stringify({
          upload_id: 'up_1',
          block_size: '4',
          parts: [{ index: 1, presigned_url: 'https://cos.example/part1' }],
        }),
      } as any;
    }
    if (input.includes('/files')) {
      return {
        ok: true, status: 200, headers,
        text: async () => JSON.stringify({
          file_info: 'FILE_INFO_BLOB',
          // M2.86：raw_url 是「通道自传图」那条路用得上的字段
          raw_url: 'https://qqbot-file-upload-1.cos.accelerate.myqcloud.com/robot_upload/p?q-signature=x',
          ttl: 86400,
        }),
      } as any;
    }
    return { ok: true, status: 200, headers, text: async () => '{}' } as any;
  }) as unknown as typeof fetch;
}

test('官方通道：群聊走富媒体（prepare → PUT → part_finish → merge → msg_type=7）', async () => {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = fakeMediaFetch(calls);

  const adapter = new QQOfficialAdapter(
    { appId: '1', clientSecret: 's', apiBase: 'https://api.example', markdown: true, buttons: false, allowedCommands: ['*'] },
    { tokens: { get: async () => 'tok' } as never, fetch: fetchImpl },
  );

  const ok = await adapter.sendImage('group', 'G1', { bytes: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png', alt: '卡' });
  assert.equal(ok, true, '群聊应当走富媒体并返回 true');

  const seq = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  assert.deepEqual(seq, [
    'POST /v2/groups/G1/upload_prepare',
    'PUT /part1',
    'POST /v2/groups/G1/upload_part_finish',
    'POST /v2/groups/G1/files',
    'POST /v2/groups/G1/messages',
  ]);
  // 发送那一步必须是富媒体类型，且带 file_info
  const send = calls[calls.length - 1]!;
  assert.equal(send.body.msg_type, 7);
  assert.equal(send.body.media.file_info, 'FILE_INFO_BLOB');
  /*
   * ⚠️⚠️ M2.86 的**核心断言**：PUT 分片必须带 content-type。
   *
   * 不带时 COS 把对象存成 `application/octet-stream`，平台抓到**不认** ⇒ markdown 里裂图
   * （真机实验A）；带上 `image/png` 才被平台转存（实验C，真机显示）。
   * 这一条丢了，图会**静默**变裂 —— 所以钉在测试里。
   */
  assert.equal(
    calls[1]!.headers['content-type'],
    'image/png',
    'PUT 分片必须带 content-type（否则对象存成 octet-stream，平台不转存）',
  );
  // PUT 分片不带 Authorization（COS 认签名，预签名只覆盖 host）
  assert.equal(calls[1]!.headers['authorization'], undefined, 'PUT 不该带 Authorization');
  /*
   * M2.86：富媒体那条路**必须挂上常用按钮**。
   * 用户口径是「角色卡 + 几个常用指令的按钮」—— 按钮丢了，那条消息就只剩一张图，
   * 玩家得自己回想指令怎么打。所以把按钮标签逐字钉住。
   */
  const keyboard = send.body.keyboard as { content: { rows: Array<{ buttons: Array<{ render_data: { label: string } }> }> } };
  assert.ok(keyboard, '富媒体消息要带 keyboard');
  assert.deepEqual(
    keyboard.content.rows.flatMap((row) => row.buttons.map((b) => b.render_data.label)),
    ['角色', '状态', '背包', '帮助'],
    '常用按钮要齐（这是「图 + 按钮」里的那一半）',
  );
  assert.equal(adapter.stats.imagesSent, 1);
});

test('M2.86：单聊也走富媒体上传（真机实测 /v2/users/{openid}/… 四步通）', async () => {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const adapter = new QQOfficialAdapter(
    { appId: '1', clientSecret: 's', apiBase: 'https://api.example', markdown: true, buttons: false, allowedCommands: ['*'] },
    { tokens: { get: async () => 'tok' } as never, fetch: fakeMediaFetch(calls) },
  );

  const ok = await adapter.sendImage('private', 'U1', { bytes: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png', alt: '卡' });
  assert.equal(ok, true, '单聊现在也能发图（M2.86 之前这里返回 false）');
  const seq = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  assert.deepEqual(seq, [
    'POST /v2/users/U1/upload_prepare',
    'PUT /part1',
    'POST /v2/users/U1/upload_part_finish',
    'POST /v2/users/U1/files',
    'POST /v2/users/U1/messages',
  ]);

  // 空字节仍然不发（不产生任何请求）
  const before = calls.length;
  assert.equal(await adapter.sendImage('group', 'G1', { bytes: new Uint8Array(0), mediaType: 'image/png' }), false);
  assert.equal(calls.length, before, '空图不该发请求');
  // 频道（guild）是另一套 API，仍未接
  assert.equal(await adapter.sendImage('channel', 'C1', { bytes: new Uint8Array([1]), mediaType: 'image/png' }), false);
});

test('M2.86：prepareInlineImage 返回 raw_url，且同一张图不重复上传（缓存）', async () => {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const adapter = new QQOfficialAdapter(
    { appId: '1', clientSecret: 's', apiBase: 'https://api.example', markdown: true, buttons: false, allowedCommands: ['*'] },
    { tokens: { get: async () => 'tok' } as never, fetch: fakeMediaFetch(calls) },
  );

  const image = { bytes: new Uint8Array([9, 9, 9, 9]), mediaType: 'image/png' as const, alt: '卡' };
  const first = await adapter.prepareInlineImage('group', 'G1', image);
  assert.equal(
    first,
    'https://qqbot-file-upload-1.cos.accelerate.myqcloud.com/robot_upload/p?q-signature=x',
    '要把 raw_url 原样交出去（它落在 *.myqcloud.com，在白名单里）',
  );
  const uploadsAfterFirst = calls.filter((c) => c.url.includes('upload_prepare')).length;
  assert.equal(uploadsAfterFirst, 1);
  assert.equal(adapter.stats.imagesUploaded, 1);

  // 同一张图（内容相同）再要一次：命中缓存，**不再上传**
  const second = await adapter.prepareInlineImage('group', 'G1', image);
  assert.equal(second, first);
  assert.equal(
    calls.filter((c) => c.url.includes('upload_prepare')).length,
    uploadsAfterFirst,
    '同一张图不该重复上传（官方接口有频次限制）',
  );
  assert.equal(adapter.stats.imagesUploaded, 1, '缓存命中不该计进「上传了几张」');

  // 换一张图（内容不同）：键变了，必须重新上传
  await adapter.prepareInlineImage('group', 'G1', { ...image, bytes: new Uint8Array([7, 7, 7, 7]) });
  assert.equal(calls.filter((c) => c.url.includes('upload_prepare')).length, uploadsAfterFirst + 1);
});

test('M2.86：上传失败时 prepareInlineImage 返回 undefined（不抛，调用方走降级）', async () => {
  const adapter = new QQOfficialAdapter(
    { appId: '1', clientSecret: 's', apiBase: 'https://api.example', markdown: true, buttons: false, allowedCommands: ['*'] },
    {
      tokens: { get: async () => 'tok' } as never,
      // upload_prepare 直接 500
      fetch: (async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' })) as unknown as typeof fetch,
    },
  );
  assert.equal(
    await adapter.prepareInlineImage('group', 'G1', { bytes: new Uint8Array([1]), mediaType: 'image/png' }),
    undefined,
  );
  // 频道与空图也不进上传
  assert.equal(await adapter.prepareInlineImage('channel', 'C1', { bytes: new Uint8Array([1]), mediaType: 'image/png' }), undefined);
  assert.equal(await adapter.prepareInlineImage('group', 'G1', { bytes: new Uint8Array(0), mediaType: 'image/png' }), undefined);
});
