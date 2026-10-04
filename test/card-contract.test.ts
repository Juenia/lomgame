import assert from 'node:assert/strict';
import { test } from 'node:test';
import { characterCardData } from '../src/card/contract.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

function state(over: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'c1', userId: 'u1', name: '测试者', pathway: 'seer', sequence: 8, pathwayStatus: 'initiated',
    gender: 'male', hp: 61, mp: 40, mad: 50, cor: 11, dig: 8.5999999, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

test('卡面数值一律取整（浮点 dig 不许印成 8.5999999）', () => {
  const data = characterCardData(state({ dig: 8.5999999, cor: 12.300000000000001 }));
  const dig = data.costs?.find((c) => c.label.includes('消化'));
  const cor = data.costs?.find((c) => c.label.includes('污染'));
  assert.equal(dig?.value, '9');
  assert.equal(cor?.value, '12');
});

test('卡面字段全部来自 CharacterState，且标签与数值同在一个条目里', () => {
  const data = characterCardData(state());
  const labels = [
    ...(data.bars ?? []).map((b) => b.label),
    ...(data.costs ?? []).map((c) => c.label),
    ...(data.fields ?? []).map((f) => f.label),
  ];
  // 参照卡上的「神秘 / 幸运 / 灰雾回响 / 3-7」在项目里没有任何字段，不该出现
  for (const ghost of ['神秘', '幸运', '灰雾回响']) {
    assert.ok(!labels.some((l) => l.includes(ghost)), `卡面出现了没有来源的字段：${ghost}`);
  }
  // M2.85：卡面原来还有一条「✦ 行动」（行动值）—— 随行动值一并删除
  assert.deepEqual(labels, ['† 生命', '◈ 灵性', '☾ 理智', '✜ 疯狂', '✠ 污染', '⚗ 消化', '❖ 命运']);
});

test('普通人：没有途径、没有序列，卡面不许出现序列徽章', () => {
  const data = characterCardData(
    state({ pathway: null, sequence: null, pathwayStatus: 'mortal', mp: 40 }),
    { cityName: '廷根市' },
  );
  assert.equal(data.pathwayLine, '还没有途径');
  assert.equal(data.seqLabel, undefined);
  assert.equal(data.title, undefined);
  assert.equal(data.pathway, 'mortal');
  // 普通人的灵性上限是 50（与 renderStatus 同口径）
  assert.equal(data.bars.find((b) => b.label.includes('灵性'))?.max, 50);
});

test('序列徽章：称号来自 titles 表，不可达序列带标注', () => {
  const reachable = characterCardData(state({ sequence: 8 }));
  assert.equal(reachable.seqLabel, '序列 8');
  assert.equal(reachable.title, '小丑');
  assert.equal(reachable.seqNote, undefined);

  const unreachable = characterCardData(state({ sequence: 1 }));
  assert.equal(unreachable.title, '诡秘侍者');
  assert.match(String(unreachable.seqNote), /本版不可达/);
});

test('派生值只由传入的事实决定，卡面层不自己算', () => {
  const bare = characterCardData(state());
  assert.equal(bare.footnote, undefined);
  // ⚠️ 虔诚（churchContribution）是**角色数据**，不是外部事实 —— 它必须从 CharacterState 来
  const withFacts = characterCardData(state({ churchContribution: 120 }), {
    cityName: '廷根市', churchName: '黑夜女神教会',
    promotionSuccess: 0.713, lossGate: { mad: 65, cor: 60 },
  });
  assert.match(String(withFacts.footnote), /晋升成功率 71%/);
  assert.match(String(withFacts.footnote), /MAD 65 \/ COR 60/);
  // 城市走独立字段（卡面上它有自己的一行 + 定位图标），不再挤在 identity 里 —— 见 M2.48
  assert.equal(withFacts.city, '廷根市');
  assert.doesNotMatch(String(withFacts.identity), /廷根市/);
  assert.match(String(withFacts.identity), /黑夜女神教会/);
  assert.match(String(withFacts.identity), /虔诚 120/);
});
