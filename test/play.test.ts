import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePlay } from '../src/domain/play/play.ts';
import {
  applyRepeatPenalty,
  computeMatchScore,
  diversityMultiplier,
  scorePlay,
} from '../src/domain/play/score.ts';
import { PATHWAY_TAGS } from '../src/domain/play/tags.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

const seer = PATHWAY_TAGS.seer;

function usageOf(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1',
    userId: 'u1',
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
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test('关键词包含匹配：核心 1.0 / 次要 0.5 / 禁忌 -0.5，clamp 到 0—1', () => {
  assert.equal(computeMatchScore('我观察了一会儿', seer), 0.5);
  assert.equal(computeMatchScore('我按占卜的结果行事', seer), 1);
  assert.equal(computeMatchScore('我占卜并观察命运', seer), 1, '超过 1 也只算 1');
  assert.equal(computeMatchScore('我用蛮力砸开', seer), 0, '禁忌单独出现时被 clamp 到 0');
  assert.equal(computeMatchScore('毫无关系的一句话', seer), 0, '不认识的输入不猜');
});

test('复读惩罚：score / (1 + 当日次数)', () => {
  assert.equal(applyRepeatPenalty(1, 0), 1);
  assert.equal(applyRepeatPenalty(1, 1), 0.5);
  assert.equal(applyRepeatPenalty(1, 2), 1 / 3);
});

test('多样性加成：种类越多越高，封顶 1.3', () => {
  assert.equal(diversityMultiplier(0), 1);
  assert.equal(diversityMultiplier(1), 1);
  assert.equal(diversityMultiplier(2), 1.1);
  assert.equal(diversityMultiplier(4), 1.3);
  assert.equal(diversityMultiplier(9), 1.3);
});

test('同一标签每日上限 3 次，超出后不再计分', () => {
  const third = scorePlay('占卜', seer, usageOf({ 占卜: 2 }));
  assert.deepEqual(third.matchedCore, ['占卜']);
  assert.equal(third.dominantRepeat, 2);
  assert.ok(Math.abs(third.final - 1 / 3) < 1e-9);

  const fourth = scorePlay('占卜', seer, usageOf({ 占卜: 3 }));
  assert.deepEqual(fourth.matchedCore, []);
  assert.deepEqual(fourth.cappedTags, ['占卜']);
  assert.equal(fourth.raw, 0);
  assert.equal(fourth.final, 0);
});

test('多样性让「换着花样来」比复读更划算', () => {
  const repeated = scorePlay('观察', seer, usageOf({ 观察: 1 }));
  const varied = scorePlay('观察', seer, usageOf({ 推算: 1 }));
  assert.equal(repeated.final, 0.25, '复读：0.5 ÷ 2 = 0.25');
  assert.ok(Math.abs(varied.final - 0.55) < 1e-9, '换了标签：0.5 × 1.1 = 0.55');
  assert.ok(varied.final > repeated.final);
});

test('禁忌标签参与扣分并单独列出', () => {
  const breakdown = scorePlay('占卜之后我用蛮力解决', seer, usageOf({}));
  assert.deepEqual(breakdown.matchedCore, ['占卜']);
  assert.deepEqual(breakdown.matchedForbidden, ['蛮力']);
  assert.equal(breakdown.raw, 0.5, '1.0 - 0.5 = 0.5');
});

test('resolvePlay：同 seed 完全复现，不同 seed 抽样不同', () => {
  const input = {
    state: makeState({ dig: 10, cor: 20 }),
    text: '占卜',
    tags: seer,
    usage: usageOf({}),
    seed: 'msg-1:char-1:1000',
  };
  const first = resolvePlay(input);
  const again = resolvePlay(input);
  assert.deepEqual(first, again);
  assert.equal(first.exposureRoll, createSeededRng(input.seed).next(), '抽样值来自注入的 seed');
  assert.equal(first.exposed, first.exposureRoll < 0.3);

  const other = resolvePlay({ ...input, seed: 'msg-2:char-1:1000' });
  assert.notEqual(other.exposureRoll, first.exposureRoll);
});

test('resolvePlay：消化按 §7 公式结算，污染越高越难消化', () => {
  const base = resolvePlay({
    state: makeState({ dig: 0, cor: 0 }),
    text: '占卜',
    tags: seer,
    usage: usageOf({}),
    seed: 'fixed',
  });
  const polluted = resolvePlay({
    state: makeState({ dig: 0, cor: 100 }),
    text: '占卜',
    tags: seer,
    usage: usageOf({}),
    seed: 'fixed',
  });
  // §7 公式：0.6×扮演匹配 + 0.3×事件暴露 - 0.5×污染惩罚
  const expected = 0.6 + (base.exposed ? 0.3 : 0);
  assert.ok(Math.abs(base.gained - expected) < 1e-9, `裸公式应为 ${expected}，实际 ${base.gained}`);
  assert.ok(polluted.gained < base.gained, '污染 100 时要被 0.5 惩罚拖下来');
});

test('resolvePlay：命中暴露时 exposure=1，DIG 额外 +0.3', () => {
  // 找一个必然暴露的种子，避免测试依赖运气
  let seed = 'probe';
  for (let i = 0; i < 200; i += 1) {
    if (createSeededRng(seed).next() < 0.3) break;
    seed = `probe${i}`;
  }
  const outcome = resolvePlay({
    state: makeState({ dig: 0, cor: 0 }),
    text: '占卜',
    tags: seer,
    usage: usageOf({}),
    seed,
  });
  assert.equal(outcome.exposed, true);
  assert.equal(outcome.exposure, 1);
  assert.ok(Math.abs(outcome.gained - 0.9) < 1e-9, `0.6×1 + 0.3×1 = 0.9，实际 ${outcome.gained}`);
});
