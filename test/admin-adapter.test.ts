/**
 * 适配器面板（M2.51）。
 *
 * 守三件事：
 * 1. **热生效真的改变了行为**，不是只改了一个 getter —— 所以这里喂真实事件去撞白名单。
 * 2. **面板说的和进程做的是同一件事。** 面板原来显示的是 .env 里的值，而缺省时适配器
 *    有自己的默认（白名单缺省 ⇒ 只放行「创建」，不是全放行）—— 说的和做的不一样是最难查的。
 * 3. **白名单一个都不勾 ≠ 全禁**（适配器把空白名单当全放行），所以界面必须挡住这种提交。
 */
import assert from 'node:assert/strict';
import { createHarness } from './helpers/app.ts';
import { test } from 'node:test';
import { API_BASE_PROD, API_BASE_SANDBOX } from '../src/adapter/qq-official/gateway.ts';
import { QQOfficialAdapter, createQQOfficialAdapter } from '../src/adapter/qq-official/index.ts';
import { commandCatalogue, compareAdapter, patchFromForm } from '../src/admin/adapter.ts';

const NO_NET = {
  tokens: {
    get: async () => 'tok',
    snapshot: () => ({ appId: '1', hasToken: true, remainingSec: 100, refreshes: 0 }),
  } as never,
  fetch: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch,
};

/** 假网关：只记录被调用了什么，不连网 */
function fakeGateway() {
  return {
    ready: false,
    stats: {
      hellos: 0, identifies: 0, resumes: 0, heartbeats: 0,
      heartbeatAcks: 0, dispatches: 0, reconnects: 0, lastError: null,
    },
    connects: 0,
    closed: [] as string[],
    async connect() { this.connects += 1; },
    close(_code?: number, reason?: string) { this.closed.push(reason ?? ''); },
    async waitReady() { /* 立刻返回 */ },
  };
}

function makeAdapter(overrides: Record<string, unknown> = {}) {
  const gw = fakeGateway();
  const adapter = new QQOfficialAdapter(
    {
      appId: '1', clientSecret: 's', apiBase: API_BASE_PROD,
      markdown: false, buttons: false, allowedCommands: ['创建'], ...overrides,
    } as never,
    { ...NO_NET, gateway: gw as never },
  );
  return { adapter, gw };
}

const groupMsg = (text: string) => ({
  id: 'm1', group_openid: 'G1', content: text,
  author: { member_openid: 'U1', username: '甲' }, timestamp: Date.now(),
});

test('适配器：改白名单**立刻改变行为**（喂真实事件去撞，不是只看 getter）', async () => {
  const { adapter } = makeAdapter();

  // .状态 不在白名单里 → 被灰度开关拦下
  assert.equal(await adapter.handleDispatch('GROUP_AT_MESSAGE_CREATE', groupMsg('.状态')), null);
  assert.equal(adapter.stats.filteredByWhitelist, 1);

  adapter.reconfigure({ allowedCommands: ['*'] });
  const passed = await adapter.handleDispatch('GROUP_AT_MESSAGE_CREATE', groupMsg('.状态'));
  assert.ok(passed, '热改之后同一条消息必须放行');
  assert.equal(adapter.stats.filteredByWhitelist, 1, '不该再多一次拦截');
});

test('适配器：Markdown 改了要立刻同步发图能力（它是构造时烘进去的）', () => {
  const { adapter } = makeAdapter();
  assert.equal(adapter.runtimeStatus().supportsImages, false);

  const out = adapter.reconfigure({ markdown: true });
  assert.deepEqual(out.applied, ['markdown']);
  assert.deepEqual(out.needsReconnect, [], 'Markdown 每条消息都读，不该要求重连');
  // 这一条是关键：supportsImages 不在 #config 里，漏了同步就会「开了 MD 还是发不出图」
  assert.equal(adapter.supportsImages, true, 'supportsImages 没跟着变');
});

test('适配器：建连时才用的项改了要重连（但不用重启进程）', () => {
  const { adapter } = makeAdapter();
  const out = adapter.reconfigure({ buttons: true, apiBase: API_BASE_SANDBOX });

  assert.deepEqual([...out.needsReconnect].sort(), ['apiBase', 'buttons']);
  assert.deepEqual(out.applied, [], '这两项不是「每条消息都读」的');
  // 发按钮靠 keyboard.content，与订阅无关，所以立刻可用
  assert.equal(adapter.supportsButtons, true);
  const rt = adapter.runtimeStatus();
  assert.equal(rt.sandbox, true);
  assert.deepEqual([...rt.pendingReconnect].sort(), ['apiBase', 'buttons']);
});

test('适配器：改了 AppID 要连令牌管理器一起重建，否则取到的还是旧 AppID 的令牌', () => {
  // 这里**不注入** tokens：用真的 TokenManager（只有 get() 才会联网，构造不联网）
  const adapter = new QQOfficialAdapter(
    { appId: '1', clientSecret: 's', apiBase: API_BASE_PROD } as never,
    { fetch: NO_NET.fetch },
  );
  assert.equal(adapter.runtimeStatus().token.appId, '1');
  adapter.reconfigure({ appId: '2' });
  assert.equal(adapter.runtimeStatus().token.appId, '2', '令牌管理器没重建');
});

test('适配器：重连会关掉旧网关、清空待重连清单，并重新连接', async () => {
  const { adapter, gw } = makeAdapter();
  adapter.reconfigure({ buttons: true });
  assert.equal(adapter.runtimeStatus().pendingReconnect.length, 1);

  await adapter.reconnectGateway();
  assert.deepEqual(gw.closed, ['reconfigure'], '旧网关没关');
  assert.equal(gw.connects, 1, '没有重新连接');
  assert.deepEqual(adapter.runtimeStatus().pendingReconnect, [], '重连之后清单该清空');
});

test('面板提交的白名单写法与启动时读 .env 的口径**完全一致**', () => {
  /*
   * 不一致的后果：界面保存的值和下次启动读同一个 .env 得到的值不一样，
   * 平时看不出来，重启之后才现形 —— 最难查的一类。
   */
  for (const raw of ['*', '', '创建', '创建,状态', ' 创建 , 状态 ']) {
    const fromEnv = createQQOfficialAdapter({
      QQ_BOT_APPID: '1', QQ_BOT_SECRET: 's', QQ_BOT_ALLOWED_COMMANDS: raw,
    });
    const fromForm = patchFromForm({ allowedCommands: raw }).allowedCommands ?? [];
    assert.deepEqual(
      [...fromForm], [...fromEnv.allowedCommands],
      '写法 ' + JSON.stringify(raw) + ' 两边解析结果不一样',
    );
  }
});

test('磁盘 vs 运行中：不一样的项会被标出来，缺省时说出适配器真实的默认', () => {
  const { adapter } = makeAdapter({ allowedCommands: ['创建'] });
  const rt = adapter.runtimeStatus();

  const byKey = (d: ReturnType<typeof compareAdapter>) =>
    Object.fromEntries(d.map((x) => [x.key, x]));

  const same = byKey(compareAdapter(
    { QQ_BOT_APPID: '1', QQ_BOT_ALLOWED_COMMANDS: '创建', QQ_BOT_MARKDOWN: '0' }, rt,
  ));
  assert.equal(same['QQ_BOT_APPID']!.same, true);
  assert.equal(same['QQ_BOT_ALLOWED_COMMANDS']!.same, true);
  assert.equal(same['QQ_BOT_MARKDOWN']!.same, true);
  // 改了 .env 但进程还在跑旧值 → 必须标出来
  assert.equal(same['QQ_BOT_MARKDOWN']!.disk, '关');
  const stale = byKey(compareAdapter({ QQ_BOT_MARKDOWN: '1' }, rt));
  assert.equal(stale['QQ_BOT_MARKDOWN']!.same, false, '「改了没重启」必须现形');

  // 缺省：.env 里没写，而适配器的默认是只放行「创建」—— 不能显示成 *
  const dflt = byKey(compareAdapter({}, createQQOfficialAdapter({
    QQ_BOT_APPID: '1', QQ_BOT_SECRET: 's',
  }).runtimeStatus()));
  assert.match(dflt['QQ_BOT_ALLOWED_COMMANDS']!.disk, /只放行「创建」/);
  assert.equal(dflt['QQ_BOT_ALLOWED_COMMANDS']!.running, '创建');
  assert.equal(dflt['QQ_BOT_ALLOWED_COMMANDS']!.same, false);

  // 密钥不回显：只比「有没有」
  const secret = byKey(compareAdapter({ QQ_BOT_SECRET: 'abcdefgh1234' }, rt));
  assert.ok(!secret['QQ_BOT_SECRET']!.disk.includes('efgh'), '密钥不能整个回显');
  assert.equal(secret['QQ_BOT_SECRET']!.disk.startsWith('abcd'), true);
});

test('指令表：名字来自路由，说明来自 command-groups（唯一出处，不手抄）', () => {
  const names = ['状态', '创建', '不存在的指令'];
  const list = commandCatalogue(names);
  assert.deepEqual(list.map((c) => c.name), [...names].sort(), '一个都不能漏');
  const help = Object.fromEntries(list.map((c) => [c.name, c.help]));
  assert.ok(help['状态'] && help['状态'].length > 0, '状态的说明没摘到');
  // 说明现在来自 command-groups 的 brief（「创建一个角色（会问一句性别…）」）
  assert.ok(help['创建']!.includes('创建'), '创建的说明没摘到：' + String(help['创建']));
  assert.equal(help['不存在的指令'], '', '摘不到就留空，不要编一个');
  /*
   * ⚠️ **不能只查两个碰巧还在的名字**。
   *
   * 上一版就是那样，于是 `.帮助` 被精简、说明全摘不到的时候，这条用例**照样绿**。
   * 现在拿**全部已注册指令**去查：说明的覆盖率必须接近 100%（只有内部指令可以没有）。
   */
  const harness = createHarness();
  const all: string[] = (harness.app.router as unknown as { commands: string[] }).commands;
  harness.app.close();
  const full = commandCatalogue(all);
  const blank = full.filter((c) => c.help.length === 0 && c.name !== 'mdprobe' && c.name !== '探针');
  assert.deepEqual(blank.map((c) => c.name), [], '这些指令在后台没有说明：' + blank.map((c) => c.name).join('、'));
});
