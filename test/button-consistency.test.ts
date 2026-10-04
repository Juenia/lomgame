/**
 * **按钮一致性探针**（M2.86）。
 *
 * 一条消息交给通道的按钮（`interactive.options`）与后端存下来的菜单（`pending_menus`）
 * **必须是同一批选项**：同样的 id/key、同样的 command。
 *
 * 因为玩家点按钮时平台回传 `id`，后端拿它去 `pending_menus.pick()` 查 ——
 * 两边对不上，玩家的感受就是「按钮点了没反应」或「点出来是别的东西」，
 * 而这**不会有任何报错**。
 *
 * 本轮做菜单时这个形状的 bug 出现了三次：
 *   1. `.看` 自己塞 interactive 而 options 为空 ⇒ 被 router 丢掉（按钮完全不出现）
 *   2. `.菜单` 兜底没按钮也没 suppressMenu ⇒ 通用菜单掺进来（冒出「休息一下」）
 *   3. `.菜单` 内嵌图那条漏了 menuOpened ⇒ 我开的菜单被覆盖（点进去是「看线索」）
 *
 * 三次都是「我在某条分支里擅自决定了消息长什么样，而没告诉统一处理那一步」。
 * 这条用例把那个形状直接钉死。**第一次跑就抓到了 `.今日` 的 `key: ''``（四个选项 id 全空）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';

const CASES = [
  '.看', '.状态', '.背包', '.今日', '.委托', '.查', '.帮助', '.图鉴',
  '.菜单 1', '.菜单 3', '.菜单 6',
  '.走 迷雾街区', '.探索 迷雾街区', '.休息', '.装备栏', '.世界',
  '.扮演 摊开牌占卜', '.仪式', '.队伍',
];

interface Btn { id: string; label: string; command: string }
interface Pending { menu: { options: Array<{ key: string; label: string; command: string }> } }

test('按钮一致性：发出去的按钮都能在 pending_menus 里找到同名同令的选项', async () => {
  const harness = createHarness();
  const uid = 'bp-1';
  await harness.createCharacter(uid, '曾经', 'seer');
  const deps = harness.app.router.deps as unknown as {
    characters: { findByUserId: (id: string) => { id: string } | undefined };
    pendingMenus: { current: (id: string, now: number) => Pending | null };
    adapter?: { sendInteractive?: (s: string, t: string, m: { options: Btn[] }) => Promise<boolean> };
  };
  const captured: Array<{ options: Btn[] }> = [];
  const adapter = deps.adapter;
  if (adapter?.sendInteractive) {
    const orig = adapter.sendInteractive.bind(adapter);
    adapter.sendInteractive = (scene, target, message) => { captured.push(message); return orig(scene, target, message); };
  }
  const problems: string[] = [];
  for (const command of CASES) {
    captured.length = 0;
    await harness.send({ rawText: command, userId: uid, messageId: 'bp-' + command });
    const message = captured[captured.length - 1];
    if (message === undefined || message.options.length === 0) continue;
    const character = deps.characters.findByUserId(uid);
    const pending = character ? deps.pendingMenus.current(character.id, harness.now()) : null;
    if (pending === null) {
      problems.push(command + '：发了 ' + message.options.length + ' 个按钮但 pending_menus 是空的');
      continue;
    }
    for (const button of message.options) {
      if (button.id === '') { problems.push(command + '：按钮 id 为空（' + button.label + '）'); continue; }
      const option = pending.menu.options.find((entry) => entry.key === button.id);
      if (option === undefined) { problems.push(command + '：id=' + button.id + ' 在菜单里找不到'); continue; }
      if (option.command !== button.command) {
        problems.push(command + '：id=' + button.id + ' 按钮要发「' + button.command + '」，菜单里是「' + option.command + '」');
      }
    }
  }
  harness.app.close();
  assert.deepEqual(problems, [], '按钮与菜单对不上：' + String.fromCharCode(10) + problems.join(String.fromCharCode(10)));
});

test('按钮一致性：菜单里的 key 不许为空（空 key = 点了白点）', async () => {
  const harness = createHarness();
  const uid = 'bp-2';
  await harness.createCharacter(uid, '曾经', 'seer');
  const deps = harness.app.router.deps as unknown as {
    characters: { findByUserId: (id: string) => { id: string } | undefined };
    pendingMenus: { current: (id: string, now: number) => Pending | null };
  };
  const problems: string[] = [];
  for (const command of CASES) {
    await harness.send({ rawText: command, userId: uid, messageId: 'bk-' + command });
    const character = deps.characters.findByUserId(uid);
    const pending = character ? deps.pendingMenus.current(character.id, harness.now()) : null;
    if (pending === null) continue;
    for (const option of pending.menu.options) {
      if (option.key === '') problems.push(command + '：菜单里有空 key 的选项（' + option.label + '）');
    }
  }
  harness.app.close();
  assert.deepEqual(problems, [], '出现了空 key：' + String.fromCharCode(10) + problems.join(String.fromCharCode(10)));
});
