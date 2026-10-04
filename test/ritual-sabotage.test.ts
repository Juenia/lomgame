/**
 * M2.85：**交恶的高序列会破坏你的晋升仪式**（用户拍板）。
 *
 * 这条挑的时刻最狠：晋升仪式是玩家把全部材料与前途押上去的那一刻。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sabotageChance, sabotagePenalty, sabotageResultLine, sabotageTextFor } from '../src/domain/ritual/sabotage.ts';

test('仪式破坏：没交恶就不会来搅（这条是前提）', () => {
  assert.equal(sabotageChance(2, 0, 9), 0, '路人不会搅你的仪式');
  assert.equal(sabotageChance(2, -20, 9), 0, '只是冷淡也不至于');
  assert.ok(sabotageChance(2, -40, 9) > 0, '交恶了就该有可能');
});

test('仪式破坏：他自己得看得懂仪式（序列 ≤ 6）', () => {
  assert.equal(sabotageChance(8, -100, 9), 0, '低序列看不懂高序列的仪式，搅不了');
  assert.ok(sabotageChance(6, -100, 9) > 0);
});

test('仪式破坏：恨得越深、差得越多，越可能来', () => {
  const light = sabotageChance(4, -30, 7);
  const heavy = sabotageChance(2, -90, 9);
  assert.ok(heavy > light, '死敌半神应当比冷淡同侪更可能动手：' + light + ' vs ' + heavy);
  assert.ok(heavy <= 0.85, '但不能高到必来 —— 否则玩家没有准备的空间');
});

test('仪式破坏：惩罚量级要让「配置拉满也可能翻车」，但不是必翻', () => {
  const small = sabotagePenalty(6, 9);
  const big = sabotagePenalty(1, 9);
  assert.ok(small >= 20 && small <= 45, '小惩罚在 20—45 之间，实际 ' + small);
  assert.ok(big >= 40 && big <= 45, '半神的惩罚应当接近上限，实际 ' + big);
  assert.ok(big > small);
  assert.ok(95 - big >= 50, '被搅之后仍要留有余地（否则玩家做什么都没用）');
});

test('仪式破坏：手笔按序列分档，且低序列那一档不像「有人在针对你」', () => {
  const low = sabotageTextFor(6);
  const high = sabotageTextFor(2);
  assert.notEqual(low, high, '低序列与半神的手笔不该一样');
  assert.ok(!low.includes('你'), '低序列的手笔是「图案被改了一笔」——不出现「你」，因为玩家察觉不到');
});

test('仪式破坏：看得出来与看不出来是两句不同的话', () => {
  const seen = sabotageResultLine('某位', true);
  const blind = sabotageResultLine('某位', false);
  assert.notEqual(seen, blind);
  assert.ok(seen.includes('看出来'));
  assert.ok(blind.includes('没有看出来'));
});
