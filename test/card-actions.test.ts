/**
 * 角色卡底部按钮：**按当下的处境给**。
 *
 * 用户口径：「重伤情况下要显示休息按钮和求医的按钮」。
 * 重伤（`status === 'injured'`）时能做的事本来就只剩两件 —— 休息、就医，
 * 所以它们排在最前面；其余入口照给，别把人锁死在一个按钮上。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardActionsFor } from '../src/router/commands/card.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

const character = (status: string): CharacterState => ({ status } as CharacterState);

test('平时：查看类入口，不含休息/就医', () => {
  const names = cardActionsFor(character('alive')).map((a) => a.command);
  assert.deepEqual(names, ['状态', '今日', '背包']);
});

test('重伤：休息与就医排在最前面（那是这种状态下唯一还能做的事）', () => {
  const names = cardActionsFor(character('injured')).map((a) => a.command);
  assert.deepEqual(names, ['休息', '就医', '状态', '今日', '背包']);
  assert.equal(names[0], '休息', '休息要排第一');
});

test('按钮上的指令**不带前导点号** —— 这是 InteractiveOption 的口径', () => {
  for (const action of cardActionsFor(character('injured'))) {
    assert.ok(!action.command.startsWith('.'), action.command + ' 不该带点号');
    assert.ok(action.label !== '', '按钮要有文字');
  }
});