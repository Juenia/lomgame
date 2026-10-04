/**
 * **扮演的消化度软上限**（M2.118）—— 用户要的形态：
 *
 * > 「主要在于可以**一天刷满**，但又**不想限制扮演的次数**」
 *
 * 所以走**软上限**（与 `.探索` 同一个形状）：不禁止，只是越刷越薄。
 * 前 6 次全额，之后连乘 60%：第 7 次 60%、第 8 次 36%、第 9 次 21.6% …
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayLengthOf } from '../src/adapter/text-tags.ts';
import { playDigDiminish } from '../src/domain/play/play.ts';
import { NUMERIC } from '../src/config/numeric.ts';
import { readFileSync } from 'node:fs';

test('M2.118 前 6 次扮演全额（不限制次数，只是不衰减）', () => {
  const cap = NUMERIC.play.digSoftCap;
  for (let i = 0; i < cap; i += 1) {
    assert.equal(playDigDiminish(i), 1, '第 ' + (i + 1) + ' 次应当全额');
  }
});

test('M2.118 第 7 次起按 60% 连乘衰减（还能演，只是赚不到）', () => {
  const rate = NUMERIC.play.digDiminishRate;
  assert.equal(playDigDiminish(6), rate, '第 7 次 = ' + rate);
  assert.equal(playDigDiminish(7), rate * rate, '第 8 次 = ' + rate * rate);
  assert.ok(playDigDiminish(15) < 0.03, '第 16 次基本归零：' + playDigDiminish(15));
  // 单调不增：越往后越少（这是「刷不上去」的判据）
  for (let i = 0; i < 20; i += 1) {
    assert.ok(playDigDiminish(i + 1) <= playDigDiminish(i), '第 ' + (i + 2) + ' 次不该比上一次多');
  }
});

test('M2.118 接线：消化倍率乘上了衰减，且回执里会说明', () => {
  const src = readFileSync(new URL('../src/router/commands/play.ts', import.meta.url), 'utf8');
  assert.match(src, /\* playDigDiminish\(playedToday\)/, 'digMultiplier 要乘衰减');
  assert.match(src, /今天已经演了 \$\{playedToday \+ 1\} 次/, '衰减时要告诉玩家（不说他会以为坏了）');
});

test('M2.117 三角块只表示方向：状态页的危险不再用 ▼（那读起来像「降了」）', () => {
  const src = readFileSync(new URL('../src/router/commands/status.ts', import.meta.url), 'utf8');
  assert.match(src, /state\.mad >= 50 \? 'alarm'/, '疯狂高位用 alarm（红 !），不是 ▼');
  assert.match(src, /state\.dig > 0 \? 'up' : 'ok'/, '消化为 0 时不挂上箭头（没进展别说涨）');
  assert.ok(!/state\.dig\), 'gain'/.test(src), '消化不该固定 gain（▲）');
});
