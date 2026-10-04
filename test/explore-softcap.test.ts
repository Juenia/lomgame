/**
 * M2.85：**探索的硬上限改软上限**（用户拍板）。
 *
 * > 「探索每日三次是不合理的机制，起码在 QQ 群文字游戏里」
 *
 * QQ 群是异步碎片化的：玩家想起来发一句，不该被「今日 3 次配额」挡在门外。
 * 但也不能白送资源 —— 所以硬上限换成两条边际约束：越刷越亏。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { overflowFactors } from '../src/domain/explore/explore.ts';
import { createHarness } from './helpers/app.ts';

const norm = (s: string) => s.replace(/[\u200B-\u200D\uFEFF]/g, '');

test('软上限：前 3 次完全不衰减（软上限不是硬上限）', () => {
  for (const n of [1, 2, 3]) {
    const f = overflowFactors(n);
    assert.equal(f.diminish, 1, '第 ' + n + ' 次不该衰减');
    assert.equal(f.danger, 1, '第 ' + n + ' 次不该加危险');
  }
});

test('软上限：第 4 次才是第一次超出 —— 收益掉、危险涨', () => {
  const f4 = overflowFactors(4);
  assert.equal(Number(f4.diminish.toFixed(3)), NUMERIC.explore.diminishRate, '第 4 次的收益该正好是 diminishRate');
  assert.ok(f4.danger > 1, '危险该涨（这是递减的对价）');
  const f5 = overflowFactors(5);
  assert.ok(f5.diminish < f4.diminish, '越刷越低');
  assert.ok(f5.danger > f4.danger, '越刷越危险');
});

test('软上限：刷到后面基本等于白跑（收益趋近 0）', () => {
  const late = overflowFactors(12);
  assert.ok(late.diminish < 0.02, '第 12 次的收益该低于 2%：' + late.diminish.toFixed(4));
  assert.ok(late.danger > 2, '但危险已经翻倍以上：' + late.danger.toFixed(2));
});

test('软上限：真到 hardCap 才拒绝（而且那个数远大于 3）', () => {
  assert.ok(NUMERIC.explore.hardCapPerLocation > NUMERIC.explore.dailyCapPerLocation * 3,
    '硬上限该远大于软上限，否则又变回「不让玩」：' + NUMERIC.explore.hardCapPerLocation);
});

test('软上限：同一地点连探 5 次都不会被拒（QQ 群里不该被配额挡住）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('48001', '克莱恩', 'seer');
    let ran = 0;
    for (let i = 1; i <= 5; i += 1) {
      h.advance(6000);
      const t = norm((await h.send({ rawText: '.探索 迷雾街区', userId: '48001', messageId: 's' + i })).map((m) => m.text).join('\n'));
      assert.ok(!/换个地方吧|都翻遍了/.test(t), '第 ' + i + ' 次就被拒了：' + t.slice(0, 100));
      if (t.includes('迷雾街区')) ran += 1;
    }
    assert.equal(ran, 5, '5 次都该真的执行：' + ran);
  } finally { h.app.close(); }
});
