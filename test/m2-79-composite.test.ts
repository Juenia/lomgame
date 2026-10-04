/**
 * M2.79：**两条通道一起开**。
 *
 * 用户要的是「自己挑一条」或「两条一起登录」，而不是二选一。
 * 这一层最难的地方只有一个：**回复必须回到它来的那条通道** ——
 * 而业务层（router）只认 scene + targetId，按架构铁律它**不认识通道**。
 * 所以路由表留在这里：收到消息时记「这个会话来自哪条通道」，发送时查回去。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { CompositeAdapter } from '../src/adapter/composite.ts';
import type {
  Adapter, InternalMessage, MessageHandler, MessageHeader, Scene,
} from '../src/adapter/types.ts';

/** 记账用的假适配器：谁收到了什么，一目了然 */
class FakeAdapter implements Adapter {
  readonly name: string;
  readonly sent: Array<{ kind: string; target: string; text: string }> = [];
  buttons: boolean;
  images: boolean;
  /** 故意让两个通道对同一个 userId 给出不同的头像地址，用来验「先问谁」 */
  avatar: ((userId: string) => string | undefined) | undefined = undefined;
  #handler: MessageHandler | null = null;

  constructor(name: string, opts: { buttons?: boolean; images?: boolean } = {}) {
    this.name = name;
    this.buttons = opts.buttons ?? false;
    this.images = opts.images ?? false;
  }
  get supportsButtons(): boolean { return this.buttons; }
  get supportsImages(): boolean { return this.images; }
  onMessage(handler: MessageHandler): void { this.#handler = handler; }
  async feed(msg: InternalMessage): Promise<void> { await this.#handler?.(msg); }
  async sendPrivate(userId: string, text: string, _h?: MessageHeader): Promise<void> {
    this.sent.push({ kind: 'private', target: userId, text });
  }
  async sendGroup(groupId: string, text: string, _h?: MessageHeader): Promise<void> {
    this.sent.push({ kind: 'group', target: groupId, text });
  }
  async sendChannel(channelId: string, text: string, _h?: MessageHeader): Promise<void> {
    this.sent.push({ kind: 'channel', target: channelId, text });
  }
  async sendInteractive(scene: Scene, targetId: string, _m: unknown, _h?: MessageHeader): Promise<boolean> {
    if (!this.buttons) return false;
    this.sent.push({ kind: 'interactive', target: targetId, text: scene });
    return true;
  }
  async sendImage(_scene: Scene, targetId: string, _i: unknown, _h?: MessageHeader): Promise<boolean> {
    if (!this.images) return false;
    this.sent.push({ kind: 'image', target: targetId, text: '' });
    return true;
  }
  avatarUrlForUser(userId: string): string | undefined {
    return this.avatar?.(userId);
  }
}

function msg(over: Partial<InternalMessage> = {}): InternalMessage {
  return {
    messageId: 'm1', platform: 'onebot', scene: 'group', sceneId: '901',
    userId: '20001', nickname: '甲', rawText: '.状态', timestamp: 1,
    ...over,
  };
}

function setup(): { composite: CompositeAdapter; onebot: FakeAdapter; qq: FakeAdapter; got: InternalMessage[] } {
  const onebot = new FakeAdapter('onebot', { images: true });
  const qq = new FakeAdapter('qq', { buttons: true, images: true });
  const composite = new CompositeAdapter([
    { name: 'onebot', adapter: onebot },
    { name: 'qq', adapter: qq },
  ]);
  const got: InternalMessage[] = [];
  composite.onMessage((m) => { got.push(m); });
  return { composite, onebot, qq, got };
}

test('多通道：回复回到它来的那条通道（业务层不认识通道，路由表在这一层）', async () => {
  const { composite, onebot, qq, got } = setup();

  // 先从 OneBot 来一条群消息
  await onebot.feed(msg({ sceneId: '901', userId: '20001' }));
  assert.equal(got.length, 1);
  await composite.sendGroup('901', '回执');
  assert.deepEqual(onebot.sent.map((s) => s.target), ['901'], 'OneBot 来的消息，回复必须走 OneBot');
  assert.equal(qq.sent.length, 0, '不许发到另一条通道去');

  // 再从官方通道来一条**同一个群号**（真实场景里不会撞，这里故意撞一下）
  await qq.feed(msg({ platform: 'official', sceneId: '901', userId: 'openid-A' }));
  await composite.sendGroup('901', '回执 2');
  assert.deepEqual(qq.sent.map((s) => s.target), ['901'], '后一条消息把路由更新到官方通道');
  assert.equal(onebot.sent.length, 1, 'OneBot 那条不受影响');

  // 私聊按 userId 定位（sceneId 与 userId 在私聊里是同一个值，但通道可能不同）
  await onebot.feed(msg({ scene: 'private', sceneId: '20001', userId: '20001' }));
  await composite.sendPrivate('20001', '私聊回执');
  assert.equal(onebot.sent.filter((s) => s.kind === 'private').length, 1);
});

test('多通道：没收到过消息的会话按默认通道发，并记一笔 unrouted', async () => {
  const onebot = new FakeAdapter('onebot');
  const qq = new FakeAdapter('qq');
  const composite = new CompositeAdapter(
    [{ name: 'onebot', adapter: onebot }, { name: 'qq', adapter: qq }],
    { defaultChannel: 'qq' },
  );
  composite.onMessage(() => { /* 业务层这次不做事 */ });

  // 世界播报往一个从没收到过消息的群发 —— 只能按默认通道
  await composite.sendGroup('777', '世界播报');
  assert.deepEqual(qq.sent.map((s) => s.target), ['777'], '按 defaultChannel 发');
  assert.equal(onebot.sent.length, 0);
  assert.equal(composite.snapshot().unrouted, 1, '猜着发的次数要能被看见');

  // 默认通道没指定时用第一条
  const c2 = new CompositeAdapter([{ name: 'onebot', adapter: onebot }, { name: 'qq', adapter: qq }]);
  c2.onMessage(() => {});
  await c2.sendGroup('888', 'x');
  assert.deepEqual(onebot.sent.map((s) => s.target), ['888']);
});

test('多通道：能力位是合成的，但真正不支持的那条会返回 false 让调用方降级', async () => {
  const { composite, onebot, qq } = setup();
  composite.onMessage(() => {});
  assert.equal(composite.supportsButtons, true, '有一条支持就算支持（业务层该走按钮那条路）');
  assert.equal(composite.supportsImages, true);

  // 消息从 OneBot 来（它不支持按钮）→ sendInteractive 返回 false → 调用方降级成文本
  await onebot.feed(msg({ sceneId: '901' }));
  const okOnOnebot = await composite.sendInteractive('group', '901', { text: 'x', options: [] } as never);
  assert.equal(okOnOnebot, false, '不支持按钮的通道要如实返回 false（降级是正常路径）');
  assert.equal(onebot.sent.filter((s) => s.kind === 'interactive').length, 0);

  // 同一条消息从官方通道来 → 真的摆按钮
  await qq.feed(msg({ platform: 'official', sceneId: '902' }));
  const okOnQq = await composite.sendInteractive('group', '902', { text: 'x', options: [] } as never);
  assert.equal(okOnQq, true);
  assert.equal(qq.sent.filter((s) => s.kind === 'interactive').length, 1);
});

test('多通道：头像先问「这个用户从哪条通道来过」，不许把 QQ 号拼进官方地址', async () => {
  const onebot = new FakeAdapter('onebot');
  const qq = new FakeAdapter('qq');
  // OneBot 只认纯数字 QQ 号；官方对任何 openid 都能拼出地址（这正是危险之处）
  onebot.avatar = (id) => (/^\d+$/.test(id) ? 'onebot-avatar:' + id : undefined);
  qq.avatar = (id) => 'qq-avatar:' + id;
  const composite = new CompositeAdapter([{ name: 'onebot', adapter: onebot }, { name: 'qq', adapter: qq }]);
  composite.onMessage(() => {});

  // 没见过这个用户时：先问 OneBot（它严格），拿不到再问官方 ——
  // 反过来先问官方的话，一个 QQ 号会被拼成 qq-avatar:20001（看起来正常但打不开）
  assert.equal(composite.avatarUrlForUser('20001'), 'onebot-avatar:20001');

  // 见过之后按来源通道走
  await qq.feed(msg({ platform: 'official', userId: 'openid-A', sceneId: '901' }));
  assert.equal(composite.avatarUrlForUser('openid-A'), 'qq-avatar:openid-A');
});

test('多通道：统计按通道分开数（面板上要能看出哪条在干活）', async () => {
  const { composite, onebot, qq } = setup();
  await onebot.feed(msg({ sceneId: '1' }));
  await onebot.feed(msg({ sceneId: '2' }));
  await qq.feed(msg({ platform: 'official', sceneId: '3' }));
  const snap = composite.snapshot();
  assert.deepEqual(snap.received, { onebot: 2, qq: 1 });
  assert.deepEqual(snap.channels, ['onebot', 'qq']);
  assert.equal(snap.routed, 0, '还没发过东西');
});

test('多通道：没有通道时直接拒绝构造（配置错要在启动时就炸）', () => {
  assert.throws(() => new CompositeAdapter([]), /至少要一条通道/);
});

test('后台面板：两条通道各自的按钮都在（双通道下要能分别操作）', async () => {
  const js = readFileSync('src/admin/adapter.js', 'utf8');
  assert.ok(js.includes('AD.available'), '面板要读服务端给的通道清单');
  assert.ok(js.includes('adRenderCards'), '要有入口卡片（点进去是对应的适配器）');
  const { adminPage } = await import('../src/admin/page.ts');
  const html = adminPage();
  assert.ok(html.includes('id="adCards"'), '总览页要有卡片容器');
  assert.ok(html.includes('id="adObLive"'), 'OneBot 子页要有状态格');
  for (const id of ['adReconnect', 'adVerify', 'adObReconnect', 'adObVerify']) {
    assert.ok(html.includes('id="' + id + '"'), '缺少按钮 #' + id);
  }
});

test('后台面板：通道总览要把「没启用的通道」也列出来（否则等于把选择权藏起来）', async () => {
  const js = readFileSync('src/admin/adapter.js', 'utf8');
  assert.ok(js.includes('function adRenderChannels'), 'adapter.js 缺少通道总览渲染');
  assert.ok(js.includes('AD.available'), '总览要读服务端给的通道清单');
  assert.ok(js.includes('adRenderChannels()'), '刷新时要真的调用它');

  const { adminPage } = await import('../src/admin/page.ts');
  const html = adminPage();
  assert.ok(html.includes('id="adChannels"'), '页面缺少通道总览容器');

  // 服务端：live 路由要返回「有哪些通道 + 怎么启用」，而不只是「已启用的通道」
  const routes = readFileSync('src/admin/index.ts', 'utf8');
  assert.ok(routes.includes('adapterMode:'), 'live 路由要报出当前模式（onebot / qq / both）');
  assert.ok(routes.includes('available: ['), 'live 路由要返回全部通道');
  // M2.83：文案改成「点按钮启用、凭证在自己子页填」——用户不该被教去编辑文件
  assert.ok(routes.includes('点下面这个按钮启用'), '未启用的通道要说清怎么开');
  assert.ok(routes.includes('needsSetup'), '缺凭证要给前端一个标记（否则给一个点了必然失败的按钮）');
});

/* ------------------------------------------------------------------ *
 * M2.83：运行期启用 / 停用一条通道（后台卡片上那两个按钮）
 * ------------------------------------------------------------------ */

test('多通道：运行期增删通道（后台的启用/停用按钮靠它）', async () => {
  const onebot = new FakeAdapter('onebot');
  const qq = new FakeAdapter('qq');
  const composite = new CompositeAdapter([{ name: 'onebot', adapter: onebot }]);
  const got: string[] = [];
  composite.onMessage((m) => { got.push(m.rawText); });

  // 运行期挂上第二条：业务层的 handler 必须自动接上
  // （只 push 不注册的话，这条通道收得到消息也**没人处理** —— 静默丢消息）
  assert.deepEqual(composite.addSlot({ name: 'qq', adapter: qq }), { ok: true, reason: null });
  await qq.feed(msg({ platform: 'official', sceneId: '901' }));
  assert.equal(got.length, 1, '新挂上来的通道要立刻能被处理');

  // 重复挂：拒绝而不是静默替换（替换会把手上的那条连接丢掉）
  assert.equal(composite.addSlot({ name: 'qq', adapter: qq }).ok, false);

  // 摘掉之后：路由表里指向它的条目也要清掉
  await composite.sendGroup('901', 'x');
  assert.equal(qq.sent.length, 1, '摘之前，回复走 qq');
  assert.equal(composite.removeSlot('qq'), true);
  assert.equal(composite.hasSlot('qq'), false);
  await composite.sendGroup('901', 'y');
  assert.equal(qq.sent.length, 1, '摘掉之后不该再发给 qq');
  assert.equal(onebot.sent.length, 1, '落到默认通道 —— 而不是把消息丢掉');
});

test('后台：启用/停用通道的按钮、路由、热装钩子三样都在', () => {
  const js = readFileSync('src/admin/adapter.js', 'utf8');
  assert.ok(js.includes("api('/adapter/channel'"), '前端要打启用接口');
  assert.ok(js.includes('data-ch='), '卡片上要有启用/停用按钮');
  const routes = readFileSync('src/admin/index.ts', 'utf8');
  assert.ok(routes.includes("'/admin/api/adapter/channel'"), '服务端要有这个路由');
  assert.ok(routes.includes('channelControl'), '路由要调热装钩子');
  // .env 也要跟着写 —— 否则「界面点的」和「重启后的」不是同一个状态
  assert.ok(routes.includes("envSet(file, 'ADAPTER'"), '启用动作要写 .env 的 ADAPTER');
  const main = readFileSync('src/main.ts', 'utf8');
  assert.ok(main.includes('channelControl'), 'main 要提供热装实现');
  assert.ok(main.includes('function singleChannel'), '单通道也要包合成器，否则运行期没法加通道');
});

test('导航：面板 id 不许重复，分类默认收起、进入子页自动展开', async () => {
  const { PANELS } = await import('../src/admin/nav.ts');
  const ids = PANELS.map((p) => p.id);
  const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  // 重复 id 的现场症状：导航里一次点亮两个（用户报的「点中会同时选中」）
  assert.deepEqual(dup, [], '面板 id 重复：' + dup.join('、'));
  for (const p of PANELS.filter((x) => x.parent !== undefined)) {
    assert.ok(ids.includes(p.parent!), p.id + ' 指向的父面板不存在：' + p.parent);
  }
  const js = readFileSync('src/admin/console.js', 'utf8');
  assert.ok(js.includes('function navSetExpanded'), '导航要有展开 / 收起');
  assert.ok(js.includes('navsub hide'), '分类默认收起 —— 点开才显示子项');
  assert.ok(js.includes('navSetExpanded(p.parent, true)'), '进入子页要自动展开它所属的分类');
});
