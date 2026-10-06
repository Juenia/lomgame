/**
 * M2.172：管理员指令与它的三组开关。
 *
 * 这一份守的是**判据本身**，不是文案：
 *
 *   · 名单解析（三种分隔符 + 去重）—— 解析错了表现是「配了却不生效」，不报错；
 *   · 开关的三层语义（全局 / 本群覆盖 / 跟随全局）—— 第二层写错会让「本群单独静音」变成全服静音；
 *   · **注册表与说明表对账** —— 新加一条管理员指令而忘了写说明，这张图里就没有它，
 *     而那是「图上看不到、实际能用」的静默缺口（AGENTS §3.1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AdminRegistry, parseAdminIds } from '../src/domain/admin/registry.ts';
import { ServerSwitchRepo, SWITCH_KEYS } from '../src/infra/db/server-switches.ts';
import { ADMIN_COMMAND_GROUPS } from '../src/domain/menu/admin-commands.ts';
import { CommandRouter, type RouterDeps } from '../src/router/index.ts';
import { registerW1Commands } from '../src/router/commands/index.ts';

test('管理员名单：换行 / 逗号 / 空格 / 分号都认，去重且去空', () => {
  const ids = parseAdminIds('10001\n10002, 10003 10004;10005；10006\n\n10001');
  assert.deepEqual(ids, ['10001', '10002', '10003', '10004', '10005', '10006']);
  assert.deepEqual(parseAdminIds(''), []);
  assert.deepEqual(parseAdminIds(null), []);
  assert.deepEqual(parseAdminIds(undefined), []);
});

test('管理员名单：.env 与上游上报取并集，任一方都不该抹掉另一方', () => {
  const registry = new AdminRegistry();
  registry.loadEnv({ ADMIN_IDS: '10001,10002', ADMIN_QQ: '10003' } as NodeJS.ProcessEnv);
  assert.equal(registry.isAdmin('10001'), true);
  assert.equal(registry.isAdmin('10003'), true);
  assert.equal(registry.isAdmin('10004'), false);
  registry.setRemote('koishi', ['20001', '20002']);
  assert.equal(registry.isAdmin('20001'), true);
  // .env 那一份不受影响 —— 这是「并集」的字面意思
  assert.equal(registry.isAdmin('10001'), true);
  const sources = registry.list().map((entry) => entry.source);
  assert.ok(sources.includes('env'));
  assert.ok(sources.includes('upstream:koishi'));
  // 重复上报 = 覆盖它自己那一路，不累积
  registry.setRemote('koishi', ['20003']);
  assert.equal(registry.isAdmin('20001'), false);
  assert.equal(registry.isAdmin('20003'), true);
});

test('上游名单按平台分开：一个插件改名单不该把另一个的抹掉', () => {
  const registry = new AdminRegistry();
  registry.loadEnv({} as NodeJS.ProcessEnv);
  registry.setRemote('bee', ['30001']);
  registry.setRemote('koishi', ['40001']);
  registry.setRemote('koishi', ['40002']);
  assert.equal(registry.isAdmin('30001'), true, 'bee 的名单被 koishi 的覆盖了');
  assert.equal(registry.isAdmin('40001'), false);
  assert.equal(registry.isAdmin('40002'), true);
});

test('开关默认全开 —— 新增开关不许改变既有行为', () => {
  const switches = new ServerSwitchRepo();
  for (const key of SWITCH_KEYS) {
    assert.equal(switches.globalOf(key), true, key + ' 的默认值不是开');
    assert.equal(switches.isOn(key), true);
    assert.equal(switches.isOn(key, '88888'), true, key + ' 在没有本群设定时应当跟随全局');
    assert.equal(switches.sceneOf(key, '88888'), null, '没设过的群不该有值');
  }
});

test('开关三层语义：全局 / 本群覆盖 / 清掉本群恢复跟随全局', () => {
  const switches = new ServerSwitchRepo();
  switches.set('push', null, false, 1);
  assert.equal(switches.isOn('push'), false);
  assert.equal(switches.isOn('push', '88888'), false, '本群没设过 ⇒ 跟随全局（关）');
  switches.set('push', '88888', true, 2);
  assert.equal(switches.isOn('push', '88888'), true, '本群设过 ⇒ 按本群的来');
  assert.equal(switches.isOn('push'), false, '全局仍然是关 —— 本群覆盖不该改全局');
  assert.equal(switches.isOn('push', '99999'), false, '另一个群仍然跟随全局');
  switches.clearScene('push', '88888');
  assert.equal(switches.isOn('push', '88888'), false, '清掉本群设定 ⇒ 重新跟随全局');
  assert.equal(switches.sceneOf('push', '88888'), null);
});

test('三个开关互不牵连', () => {
  const switches = new ServerSwitchRepo();
  switches.set('push_event', null, false, 1);
  assert.equal(switches.isOn('push_event'), false);
  assert.equal(switches.isOn('push'), true, '关掉事件推送把世界播报也关了');
  assert.equal(switches.isOn('game'), true, '关掉事件推送把游戏也关了');
});

test('快照把全局与本群都列出来（.游戏状态 与后台要看的）', () => {
  const switches = new ServerSwitchRepo();
  switches.set('game', '88888', false, 1);
  const snapshot = switches.snapshot();
  assert.equal(snapshot.length, SWITCH_KEYS.length);
  const game = snapshot.find((row) => row.key === 'game');
  assert.ok(game !== undefined);
  assert.equal(game.global, true);
  assert.deepEqual(game.scenes, { '88888': false });
});

test('对账：注册的管理员指令与卡片菜单里的说明**逐条一致**', () => {
  /*
   * 这一条是这张测试文件里最要紧的：注册表是**运行时真相**，说明表是**图上的内容**。
   * 两边一旦分叉，缺的那一边不会报错 —— 指令能用但图上没有，或者图上有但打了没反应。
   */
  const router = registerW1Commands(new CommandRouter({} as RouterDeps));
  const registered = [...router.adminCommands].sort();
  const documented = [...new Set(ADMIN_COMMAND_GROUPS.flatMap((group) => group.commands.map((command) => command.name)))].sort();
  assert.deepEqual(registered, documented);
  assert.ok(registered.length >= 18, '管理员指令至少要有 18 条（17 条 + .管理）');
});

test('卡片菜单分组不为空，且每条都有说明', () => {
  assert.ok(ADMIN_COMMAND_GROUPS.length >= 2, '管理员菜单至少要分两张');
  for (const group of ADMIN_COMMAND_GROUPS) {
    assert.ok(group.title.length > 0);
    assert.ok(group.hint.length > 0);
    assert.ok(group.commands.length > 0, group.id + ' 是空分组');
    for (const command of group.commands) {
      assert.ok(command.brief.length > 0, command.name + ' 没有说明');
    }
  }
});
