import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../src/domain/effect/apply.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1',
    userId: 'user-1',
    name: '克莱恩',
    pathway: 'seer', pathwayStatus: 'initiated', gender: 'male',
    sequence: 9,
    hp: 100,
    mp: 100,
    mad: 0,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active', promotionFails: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test('数值改动产生带 before/after 的事件', () => {
  const result = apply(makeState(), [{ type: 'mad', value: 7 }], '测试', 2000);
  assert.equal(result.rejected, undefined);
  assert.equal(result.newState.mad, 7);
  assert.equal(result.newState.updatedAt, 2000);
  assert.deepEqual(result.events, [
    {
      type: 'mad_delta',
      characterId: 'char-1',
      payload: { before: 0, after: 7, delta: 7 },
      reason: '测试',
      createdAt: 2000,
    },
  ]);
});

test('软约束截断，且事件记录的是原始 delta', () => {
  const result = apply(makeState({ hp: 95 }), [{ type: 'hp', value: 20 }], '测试', 2000);
  assert.equal(result.newState.hp, 100);
  assert.deepEqual(result.events[0]?.payload, { before: 95, after: 100, delta: 20 });
});

test('无实际变化的 delta 不产生事件', () => {
  const result = apply(makeState({ hp: 100 }), [{ type: 'hp', value: 10 }], '测试', 2000);
  assert.equal(result.events.length, 0);
  assert.equal(result.newState.hp, 100);
});

test('硬约束：DP 同样不可透支', () => {
  const result = apply(makeState({ dp: 0 }), [{ type: 'dp', value: -1 }], '重抽', 2000);
  assert.match(String(result.rejected), /dp 不足/);
  assert.equal(result.events.length, 0);
});

test('item delta 只产出事件，不改角色数值', () => {
  const result = apply(makeState(), [{ type: 'item', itemId: '便士', quantity: 2 }], '事件奖励', 2000);
  assert.equal(result.newState.updatedAt, 2000);
  assert.deepEqual(result.events[0]?.payload, { itemId: '便士', quantity: 2 });
  assert.equal(result.events[0]?.type, 'item_delta');
});

test('数量为 0 的 item delta 静默丢弃', () => {
  const result = apply(makeState(), [{ type: 'item', itemId: '便士', quantity: 0 }], '空奖励', 2000);
  assert.equal(result.events.length, 0);
});
