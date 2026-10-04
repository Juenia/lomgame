/**
 * **日常遭遇**（M2.120）—— 取代 `.扮演` 的那条路的第一步（纯函数部分）。
 *
 * 用户两句话定死了方向：
 *   「扮演应该取消　取而代之改为途径专属事件卡　每天随机让玩家遇到几次　
 *    让他做出相对应的选择　然后涨消化度」
 *   「**扮演本来就是日常行为**，所以扮演指令没什么用」
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chosenOption, encounterMenuOf, needsChoice, remainingEncounters } from '../src/domain/play/encounter.ts';
import { parseCard } from '../src/cards/schema.ts';

/** 造一张最小的卡（只给这次要测的字段） */
function cardOf(extra: Record<string, unknown>) {
  const parsed = parseCard({
    id: 'path_seer_900',
    name: '灵摆停在中间',
    trigger: { type: 'daily', weight: 9, cond: ['pathway:seer'], min_seq: 9 },
    effects: [],
    texts: { priv: '你把银链绕在指上，让它自己停。' },
    ...extra,
  });
  assert.ok(parsed.ok, '卡要能解析：' + JSON.stringify(parsed.ok ? '' : parsed.issues));
  return parsed.card;
}

test('M2.120 没有 options 的卡自动生效（663 张老卡逐字不变）', () => {
  const card = cardOf({});
  assert.equal(needsChoice(card), false);
});

test('M2.120 有 options 的卡要摆给玩家选，且菜单的指令能被路由解析', () => {
  const card = cardOf({
    options: [
      { key: '1', label: '假装没看见', effects: [{ dig: 2 }], text: '你侧身让开。' },
      { key: '2', label: '跟上去', effects: [{ dig: 5, cor: 2 }], text: '你跟了上去。' },
    ],
  });
  assert.equal(needsChoice(card), true);
  const menu = encounterMenuOf({ card, nth: 1 });
  assert.equal(menu.title, '【灵摆停在中间】');
  assert.deepEqual(menu.options.map((o) => o.label), ['假装没看见', '跟上去']);
  /*
   * ⚠️ 菜单的 command 会被**当成玩家说的话再走一遍路由**（M2.107 踩过：
   * 菜单按钮带前导点号 ⇒ 回执成了「没有 .背包 这条指令」）。所以这里必须是
   * 「命令名 + 空格 + 参数」的形状，不能带点号。
   */
  for (const option of menu.options) {
    assert.match(option.command, /^遇见 path_seer_900 [12]$/, '菜单指令形状：' + option.command);
    assert.ok(!option.command.startsWith('.'), '不该带前导点号');
  }
  assert.equal(menu.allowFreeform, false, '这是要选一个的事，不给「自己写一个行为」');
});

test('M2.120 选中的那一支能取回来（取不到就是这张卡过期了）', () => {
  const card = cardOf({
    options: [{ key: '1', label: 'A', effects: [{ dig: 1 }] }],
  });
  assert.equal(chosenOption(card, '1')?.label, 'A');
  assert.equal(chosenOption(card, '9'), null);
});

test('M2.120 每天的次数是固定的（「随机」体现在抽到哪张，不是有没有）', () => {
  assert.equal(remainingEncounters(0, 2), 2);
  assert.equal(remainingEncounters(1, 2), 1);
  assert.equal(remainingEncounters(2, 2), 0);
  assert.equal(remainingEncounters(5, 2), 0, '超出也不给负数');
});
