import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryAdapter } from '../src/adapter/memory.ts';
import type { CardRequest, CardService } from '../src/card/service.ts';
import { createHarness } from './helpers/app.ts';

/** 一张假 PNG：真实链路里这里是 PowerShell 画出来的字节 */
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeService(
  over: {
    fail?: boolean;
    usedAvatar?: boolean;
    publicUrl?: string;
    /** URL 的来源：自建托管 / GitHub（可控）还是第三方图床（真机破过图） */
    publicUrlSource?: 'self-hosted' | 'github' | 'upload';
  } = {},
): {
  service: CardService;
  calls: CardRequest[];
} {
  const calls: CardRequest[] = [];
  return {
    calls,
    service: {
      async generate(request: CardRequest) {
        calls.push(request);
        if (over.fail === true) throw new Error('渲染进程起不来（测试构造）');
        return {
          png: FAKE_PNG,
          path: '/tmp/fake-card.png',
          usedAvatar: over.usedAvatar ?? false,
          // 配了 CARD_PUBLIC_BASE_URL 时才存在；官方通道全靠它
          ...(over.publicUrl !== undefined ? { publicUrl: over.publicUrl } : {}),
          ...(over.publicUrl !== undefined
            ? { publicUrlSource: over.publicUrlSource ?? ('self-hosted' as const) }
            : {}),
        };
      },
    },
  };
}

test('.角色：通道发不出图时，回执给落盘路径 + 文字状态卡（内测通道的真实形态）', async () => {
  const { service } = fakeService();
  const h = createHarness({ card: service }); // 默认 MemoryAdapter：supportsImages 为假
  const who = await h.createCharacter('30001', '测试者');
  assert.ok(who.id);

  const sent = await h.send({ rawText: '.角色', userId: '30001' });
  const text = sent.map((m) => m.text).join('\n');
  assert.match(text, /发不出图片/, '要说清为什么没有图');
  assert.match(text, /\/tmp\/fake-card\.png/, '要给出文件路径');
  assert.match(text, /\*\*生命\*\*　▰/, '文字状态卡要跟在后面（玩家不能少拿信息）');
  assert.equal(sent.some((m) => m.image !== undefined), false, '这条通道不该有图');
  h.app.close();
});

test('.角色：图发出去之后，正文补上文字状态卡（图里没有地点与明细）', async () => {
  const { service } = fakeService({ usedAvatar: true });
  const adapter = new MemoryAdapter({ supportsImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30002', '测试者');

  const sent = await h.send({ rawText: '.角色', userId: '30002' });
  const withImage = sent.filter((m) => m.image !== undefined);
  assert.equal(withImage.length, 1, '恰好一张图');
  assert.deepEqual([...withImage[0]!.image!.bytes], [...FAKE_PNG]);
  assert.equal(withImage[0]!.image!.mediaType, 'image/png');
  assert.equal(withImage[0]!.scene, 'private', '图走私聊');
  /*
   * M2.45 第二十四版：**改了旧口径**。
   *
   * 旧口径是「出了图就不再发文字卡」，前提假设是「图里什么都有」——可图里没有地点、
   * 没有状态提示、没有数值明细。用户截图里的第二条消息因此是「头像 + 一大片空白 + 菜单」。
   * 现在文字状态卡要补上：图那条 + 文字那条，合起来才算一条完整回执。
   */
  const text = sent.map((m) => m.text).join('\n');
  assert.match(text, /\*\*生命\*\*/, '图发出去之后，文字状态卡仍要有（图里没有地点/提示/明细）');
  assert.match(text, /◉ /, '地点也要在文字那条里');
  h.app.close();
});

test('M2.45 第十三版：通道能把图片写进正文时，卡面与文字卡发成**一条**消息', async () => {
  /*
   * 用户原话：「还有角色卡，别人是合并一起发出来，你是分开来发的」。
   *
   * 官方 markdown 通道的图片就是正文里的一行，所以「卡面 + 文字状态卡 + 按钮」应当是**一条**消息。
   * 前提是拿到公网 URL（这里用 fakeService 的 publicUrl 模拟配好了 CARD_PUBLIC_BASE_URL）。
   */
  // URL 必须落在**平台白名单域名**里（*.myqcloud.com 是腾讯云 COS，在白名单内）
  const { service } = fakeService({
    usedAvatar: true,
    publicUrl: 'https://bucket.cos.ap-guangzhou.myqcloud.com/cards/c1.png',
  });
  const adapter = new MemoryAdapter({ supportsImages: true, supportsInlineImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30005', '测试者');

  const sent = await h.send({ rawText: '.角色', userId: '30005' });
  assert.equal(sent.length, 1, `图与文字要在同一条消息里，实际 ${sent.length} 条`);
  const text = sent[0]!.text;
  assert.match(
    text,
    /^!\[测试者 的角色卡 #\d+px #\d+px\]\(https:\/\/bucket\.cos\.ap-guangzhou\.myqcloud\.com/,
    '正文第一行是卡面（markdown 图片按显示尺寸内嵌）',
  );
  assert.match(text, /\*\*生命\*\*/, '文字状态卡跟在卡面后面，不是另发一条');
  assert.equal(sent[0]!.image, undefined, '图片不再单独发一条');
  h.app.close();
});

test('M2.86：没有公网 URL 时，**通道自己上传**也能合并成一条（零配置图床）', async () => {
  /*
   * 这是 M2.86 解开的死结。
   *
   * 官方 markdown 要一个「平台能抓到的公网图片 URL」，而外部图床与自建托管
   * **全都不在白名单里**（真机四次裂图）。于是此前只有两条路：
   *   ① 部署方配图床/公网托管 —— 要钱、要配置，且第三方图床照样裂；
   *   ② 平台富媒体直发 —— 图一定显示，但图和文字是**两条**。
   *
   * 现在多了第三条：**通道自己把字节交给官方上传接口**（`srv_send_msg: false`，只传不发），
   * 拿回的 `raw_url` 落在 `*.myqcloud.com`（白名单内）⇒ 图、文字、按钮合成一条，
   * 且零配置、零成本。
   */
  const { service } = fakeService({ usedAvatar: true }); // 注意：**没有** publicUrl
  const adapter = new MemoryAdapter({
    supportsImages: true,
    supportsInlineImages: true,
    inlineImageUrl: 'https://qqbot-file-upload-1.cos.accelerate.myqcloud.com/robot_upload/x/part_1?q-signature=abc',
  });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30021', '测试者');

  const sent = await h.send({ rawText: '.角色', userId: '30021' });
  assert.equal(sent.length, 1, `图与文字要在同一条消息里，实际 ${sent.length} 条`);
  const text = sent[0]!.text;
  // 用 startsWith/includes 而不是正则：这个断言的重点是「第一行就是图、且用的是自传 URL」
  assert.ok(text.startsWith('![测试者 的角色卡 #'), `正文第一行应当是卡面，实际：${text.slice(0, 60)}`);
  assert.ok(
    text.includes('](https://qqbot-file-upload-1.cos.accelerate.myqcloud.com/'),
    '卡面 URL 用的必须是通道自传回来的地址',
  );
  assert.match(text, /\*\*生命\*\*/, '文字状态卡跟在卡面后面，不是另发一条');
  assert.equal(sent[0]!.image, undefined, '图片不再单独发一条');
  assert.equal(adapter.uploads.length, 1, '通道应当被要求上传，且只上传一次');
  assert.deepEqual([...adapter.uploads[0]!.bytes], [...FAKE_PNG], '上传的必须是那张真实的卡面字节');
  assert.equal(adapter.uploads[0]!.mediaType, 'image/png');
  h.app.close();
});

test('M2.86：能摆按钮的通道，.角色 只发「图 + 常用按钮」（不要信息头、不要正文尾）', async () => {
  /*
   * 用户原话：
   *   「角色卡的情况下 不需要信息头和正文尾，只需要角色卡和几个常用指令的按钮」
   *
   * 「信息头」= 头像 + 昵称 + 途径/序列那一行（路由的 header）
   * 「正文尾」= 文字状态卡（◉ 地点 / 生命 / 灵性 / 理智 …）
   *
   * 两条都去掉之后，群里应当只剩**一条**消息：角色卡图，底下挂常用按钮。
   */
  const { service } = fakeService({ usedAvatar: true });
  const adapter = new MemoryAdapter({
    supportsImages: true,
    supportsInlineImages: true,
    supportsButtons: true,
    // 通道自传图（官方上传接口的 raw_url 等价物）——这条路要先拿到一个可嵌的 URL
    inlineImageUrl: 'https://qqbot-file-upload-1.cos.accelerate.myqcloud.com/robot_upload/x/part_1?q-signature=abc',
  });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30031', '测试者');

  const sent = await h.send({ rawText: '.角色', userId: '30031' });
  assert.equal(sent.length, 1, `只该有一条消息，实际 ${sent.length} 条`);
  const msg = sent[0]!;

  /*
   * 走的是 **markdown 正文 + keyboard** 那条（`sendInteractive`）——
   * 这是 M2.44 真机验证过「按钮真的显示」的形态（`msg_type: 2` + keyboard）。
   *
   * 早先走的 `sendImage`（`msg_type: 7`）有两个问题：真机上**根本没有按钮**；
   * 而且它用 `#post` **不带 `msg_id`** ⇒ 是**主动消息**（额度 1000 条/群/天，
   * 不是瓶颈，但用户关掉「允许主动发送」后一律失败 —— 见 docs/QQ官方机器人接入.md §2.1/§2.3）。
   */
  assert.ok(msg.interactive !== undefined, '要走带按钮的那条路');
  /*
   * ⚠️ M2.113：按钮从 `quickButtons` 改成 `options`。
   *
   * 前者是**指令按钮**（点了只把指令插进输入框，玩家还得再按一次发送），
   * 后者是**回调按钮**（点了平台回传 id，后端走 MENU_REPLY，**直接执行**）。
   * 用户问的「这些按钮是不是能执行下一步的按钮」就是这件事 —— `.菜单` 早改过了，
   * 角色卡这一处漏了。
   *
   * 口径差异：`InteractiveOption.command` **不带前导点号**（见 adapter/interactive.ts）。
   */
  assert.deepEqual(
    msg.interactive!.options.map((o) => o.command),
    ['状态', '今日', '背包'],
    '常用入口要在，而且是回调按钮',
  );
  assert.equal(msg.interactive!.quickButtons, undefined, '不该再用「插进输入框」那套');
  assert.equal(msg.interactive!.noHeader, true, '不要信息头（头像 + 昵称 + 途径序列）');
  assert.ok(msg.text.includes('!['), `正文里要有角色卡图片：\n${msg.text}`);
  assert.ok(msg.text.includes('myqcloud.com'), '图片用的是通道自传回来的 URL');
  assert.equal(
    sent.some((m) => m.image !== undefined),
    false,
    '不许再走 sendImage —— 那条不带 msg_id（主动消息），按钮也不会显示',
  );

  const text = sent.map((m) => m.text).join('\n');
  assert.ok(!text.includes('**生命**'), `不该再有正文尾（状态卡）：\n${text}`);
  assert.ok(!text.includes('◉'), `不该再有正文尾（地点行）：\n${text}`);
  h.app.close();
});

test('M2.86：没有原生按钮的通道（OneBot），.角色 仍然补文字状态卡', async () => {
  /*
   * 这一条守着「精简」的边界：**不能为了少发一条就把数值弄丢**。
   *
   * OneBot 没有原生按钮（supportsButtons 为假），图本身也不带数值明细 ——
   * 所以那条路必须继续发文字状态卡。判据是 supportsButtons，不是「统一精简」。
   */
  const { service } = fakeService({ usedAvatar: true });
  const adapter = new MemoryAdapter({ supportsImages: true, supportsInlineImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30032', '测试者');

  const sent = await h.send({ rawText: '.角色', userId: '30032' });
  const text = sent.map((m) => m.text).join('\n');
  assert.match(text, /\*\*生命\*\*/, '没有按钮的通道要靠文字卡给数值，不能一起砍掉');
  h.app.close();
});

test('M2.86：通道上传失败时回落富媒体直发，玩家不会因此少拿到东西', async () => {
  /*
   * 上传是**可降级的**一步：限流、网络抖动、配额用尽都可能失败。
   * 失败时不能什么都不发，也不能把 markdown 源码发出去（那是一个 ![](undefined)）。
   * 正确行为：回落到平台富媒体直发 + 文字状态卡 —— 与 M2.86 之前完全一致。
   */
  const { service } = fakeService({ usedAvatar: true });
  // 不给 inlineImageUrl ⇒ prepareInlineImage 返回 undefined（等价于真实通道的上传失败）
  const adapter = new MemoryAdapter({ supportsImages: true, supportsInlineImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30022', '测试者');

  const sent = await h.send({ rawText: '.角色', userId: '30022' });
  const text = sent.map((m) => m.text).join('\n');
  assert.ok(!text.includes('undefined'), `正文里不许出现 undefined 的图片地址：\n${text}`);
  assert.ok(sent.some((m) => m.image !== undefined), '图走平台富媒体直发（图一定显示）');
  assert.match(text, /\*\*生命\*\*/, '文字状态卡也要在');
  h.app.close();
});

test('M2.45 第二十四版：**白名单外的域名不许合并**（GitHub/jsDelivr 也一样）', async () => {
  /*
   * GitHub 是**唯一一条不需要部署方自建服务**的持久外链方案：
   * 一个仓库 + 一个 token，链接走 jsDelivr（国内有节点）。
   * 本机实测 cdn.jsdelivr.net/gh/… → 200 / **image/png** / 1.1s。
   * ⇒ 它和自建托管一样可以安全写进正文。
   */
  /*
   * 判据从「URL 来源可不可控」改成「**域名在不在平台白名单里**」。
   * jsDelivr 是稳定、HTTPS、无防盗链的全球 CDN —— 但它**不在白名单**，写进正文一定裂。
   * 所以这里必须回落到平台富媒体直发（图一定显示，代价是两条）。
   */
  const { service } = fakeService({
    usedAvatar: true,
    publicUrl: 'https://cdn.jsdelivr.net/gh/me/cards@main/cards/x.png',
    publicUrlSource: 'github',
  });
  const adapter = new MemoryAdapter({ supportsImages: true, supportsInlineImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30008', '测试者');

  const sent = await h.send({ rawText: '.角色', userId: '30008' });
  const text = sent.map((m) => m.text).join('\n');
  assert.ok(!text.includes('jsdelivr'), `白名单外的域名不许写进正文：\n${text}`);
  assert.ok(sent.some((m) => m.image !== undefined), '图走平台直发（一定显示）');
  h.app.close();
});

test('M2.45 第十八版：**第三方图床**的 URL 不合并（uguu / picui 真机实测都裂）', async () => {
  /*
   * 实测两个图床在真机上都是裂图（uguu 回读 200、picui 回读 200 / image/webp），
   * 而「QQ 的域名代理能不能取到」服务端无法自检 —— 所以这一类不写进正文，
   * 走平台富媒体直发：图一定显示，代价是两条消息。
   */
  const { service } = fakeService({
    usedAvatar: true,
    publicUrl: 'https://picui.ogmua.cn/s1/2026/09/30/x.webp',
    publicUrlSource: 'upload',
  });
  const adapter = new MemoryAdapter({ supportsImages: true, supportsInlineImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30007', '测试者');

  const sent = await h.send({ rawText: '.角色', userId: '30007' });
  const text = sent.map((m) => m.text).join('\n');
  assert.ok(!text.includes('picui.ogmua.cn'), `第三方图床外链不写进正文：\n${text}`);
  h.app.close();
});

test('.角色：没拿到头像时明说用的是首字纹章', async () => {
  const { service } = fakeService({ usedAvatar: false });
  const adapter = new MemoryAdapter({ supportsImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30003', '测试者');
  const sent = await h.send({ rawText: '.角色', userId: '30003' });
  assert.match(sent.map((m) => m.text).join('\n'), /首字纹章/);
  h.app.close();
});

test('.角色：出图失败不抛给玩家，回落成文字卡并留下日志线索', async () => {
  const { service } = fakeService({ fail: true });
  const h = createHarness({ card: service });
  await h.createCharacter('30004', '测试者');
  const sent = await h.send({ rawText: '.角色', userId: '30004' });
  const text = sent.map((m) => m.text).join('\n');
  assert.match(text, /没能画出卡/);
  assert.match(text, /\*\*生命\*\*　▰/, '失败也要给文字卡');
  h.app.close();
});

test('.角色：在群里发就在群里回图（与 M2.45「玩家在哪说话，完整内容就回哪里」一致）', async () => {
  const { service } = fakeService();
  const adapter = new MemoryAdapter({ supportsImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30005', '测试者');
  const sent = await h.send({ rawText: '.角色', userId: '30005', scene: 'group', groupId: '10001' });
  const withImage = sent.filter((m) => m.image !== undefined);
  assert.equal(withImage.length, 1, '恰好一张图');
  assert.equal(withImage[0]!.scene, 'group', '图回在群里');
  assert.equal(withImage[0]!.targetId, '10001', '目标是群号，不是个人');
  h.app.close();
});

test('.角色：没有角色时给建号提示（与 .状态 同一句话）', async () => {
  const { service } = fakeService();
  const h = createHarness({ card: service });
  const sent = await h.send({ rawText: '.角色', userId: '30009' });
  assert.match(sent.map((m) => m.text).join('\n'), /还没有角色/);
  h.app.close();
});

test('.角色：没注入假服务时用真实现 —— 真起 PowerShell 画出一张 PNG 并落盘（端到端）', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'card-e2e-'));
  try {
    const h = createHarness({ cardOutDir: dir });
    const created = await h.createCharacter('30010', '测试者');
    assert.ok(created.id);

    const sent = await h.send({ rawText: '.角色', userId: '30010' });
    const text = sent.map((m) => m.text).join('\n');
    assert.match(text, /发不出图片/, '默认通道不能发图，要走降级');
    const match = text.match(/文件在：(.+?\.png)/);
    assert.ok(match, `回执里要有落盘路径：${text.slice(0, 120)}`);

    // 真去读那个文件：PNG 魔数 + 非空，证明画的不是一张空图
    const bytes = readFileSync(match![1]!);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(bytes.length > 5000, `PNG 太小，可能是空图：${bytes.length} 字节`);
    h.app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.角色：传给渲染层的事实与角色数据同源（城市名 / 晋升率 / 失控闸门）', async () => {
  const { service, calls } = fakeService();
  const h = createHarness({ card: service });
  const created = await h.createCharacter('30011', '测试者');
  // 直接拿库里的状态，与调用点读的是同一份
  const character = h.repos.characters.findByUserId('30011');
  assert.equal(character?.id, created.id);

  await h.send({ rawText: '.角色', userId: '30011' });
  assert.equal(calls.length, 1, '恰好渲染一次');
  const request = calls[0]!;
  assert.equal(request.character.userId, '30011');
  // 城市名必须解析成中文，而不是把 city id 印在卡上
  assert.ok(
    request.facts.cityName === undefined || !/^[a-z_]+$/.test(request.facts.cityName),
    `城市名不该是 id：${request.facts.cityName}`,
  );
  if (request.character.pathway !== null && request.character.sequence !== null) {
    assert.equal(typeof request.facts.promotionSuccess, 'number', '已入途径要带上晋升率');
  }
  assert.ok(request.facts.lossGate, '闸门随序列走，必须有');
  h.app.close();
});

test('.角色：出图带公网 URL 时，把它交给通道（官方 markdown 只能靠这个字段）', async () => {
  const { service } = fakeService({ publicUrl: 'https://bot.example.com/cards/a_1_20260101.png' });
  const adapter = new MemoryAdapter({ supportsImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30012', '测试者');

  // h.send() 返回的就是这一轮发出去的消息（内部已经把 adapter.sent 取空了）
  const sent = await h.send({ rawText: '.角色', userId: '30012' });
  const withImage = sent.filter((m) => m.image !== undefined);
  assert.equal(withImage.length, 1);
  assert.equal(
    withImage[0]!.image!.url,
    'https://bot.example.com/cards/a_1_20260101.png',
    '通道没拿到公网 URL —— 官方那条路会静默降级成纯文字',
  );
  h.app.close();
});

test('.角色：出图没有公网 URL 时，交给通道的对象里就没有 url 字段（OneBot 用 bytes）', async () => {
  const { service } = fakeService();
  const adapter = new MemoryAdapter({ supportsImages: true });
  const h = createHarness({ card: service, adapter });
  await h.createCharacter('30013', '测试者');

  const sent = await h.send({ rawText: '.角色', userId: '30013' });
  const withImage = sent.filter((m) => m.image !== undefined);
  assert.equal(withImage.length, 1);
  assert.equal(withImage[0]!.image!.url, undefined, '不该凭空造一个 URL 出来');
  assert.ok(withImage[0]!.image!.bytes.length > 0, 'OneBot 那条路仍然有字节可用');
  h.app.close();
});
