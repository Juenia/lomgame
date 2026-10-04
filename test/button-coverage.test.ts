/**
 * **每条指令都要有适应化按钮**（M2.86，用户：「49条命令的按钮要做！严肃要做！这是运营发行包的前提」）。
 *
 * 原来全仓只有 4 个命令自己交了 `nextActions`，其余全部落到通用四件套 ——
 * 于是几乎每条指令下面都是「看线索 / 休息一下 / 查看状态 / 翻翻背包」，
 * 跟刚做完的事毫无关系。
 *
 * 修法是 `next-menu.ts` 里的一张集中表（`AFTER_ACTIONS`），本文件守住它三条：
 *
 *   ① **覆盖面**：权威清单里的每条指令都要有按钮 —— 新增命令忘了进表会红；
 *   ② **目标存在**：按钮指向的指令必须真实存在（打错一个字就是一个死按钮）；
 *   ③ **不许空表**：登记了却给空数组，等于还是没做。
 *
 * ⚠️ 第 ② 条特别重要：按钮点下去发的是 `command`，写错了平台不会报错，
 *    玩家只会看到「没有这条指令」—— 而且没人会去逐个点一遍。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentedNames, INTERNAL_COMMANDS } from '../src/domain/menu/command-groups.ts';
import { afterActionsOf } from '../src/domain/menu/next-menu.ts';

/** 权威清单（去掉内部指令：那两个不给玩家用，也不需要按钮） */
function playerCommands(): string[] {
  const internal = new Set<string>([...INTERNAL_COMMANDS]);
  return documentedNames().filter((name) => !internal.has(name));
}

test('每条指令都有适应化按钮（不许落到通用四件套）', () => {
  const missing = playerCommands().filter((name) => afterActionsOf(name) === null);
  assert.deepEqual(
    missing,
    [],
    '这些指令没有登记后续按钮，玩家会看到与场景无关的通用四件套：' +
      String.fromCharCode(10) + missing.join(' '),
  );
});

test('按钮指向的指令都真实存在（写错一个字就是死按钮）', () => {
  const all = new Set(playerCommands());
  const bad: string[] = [];
  for (const name of playerCommands()) {
    for (const action of afterActionsOf(name) ?? []) {
      const target = action.command.trim().split(/\s+/)[0] ?? '';
      if (!all.has(target)) bad.push(name + ' → "' + action.command + '"');
    }
  }
  assert.deepEqual(bad, [], '这些按钮指向了不存在的指令：' + String.fromCharCode(10) + bad.join(String.fromCharCode(10)));
});

test('登记的按钮不为空、且每条都有标签', () => {
  const bad: string[] = [];
  for (const name of playerCommands()) {
    const actions = afterActionsOf(name);
    if (actions === null) continue; // 覆盖面那条用例管它
    if (actions.length === 0) { bad.push(name + ' 登记了空表'); continue; }
    for (const action of actions) {
      if (action.label.trim().length === 0) bad.push(name + ' 有按钮没有标签');
      if (action.command.trim().length === 0) bad.push(name + ' 有按钮没有指令');
    }
  }
  assert.deepEqual(bad, [], bad.join(String.fromCharCode(10)));
});
