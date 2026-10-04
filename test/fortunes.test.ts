/**
 * M2.85：**奇遇**（用户问「没有奇遇吗？」）。
 *
 * 奇遇与掉落的区别：掉落给资源，奇遇给**一段事**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContent } from '../src/data/loader.ts';
import { FORTUNE_KINDS, pickFortune, renderFortune } from '../src/domain/world/fortune-schema.ts';

const content = loadContent();
const fortunes = content.fortunes;

test('奇遇：20 条、五类齐全、id 不重、权重都是正数', () => {
  assert.equal(fortunes.length, 20, '奇遇数量变了就来看一眼：' + fortunes.length);
  assert.equal(new Set(fortunes.map((f) => f.id)).size, fortunes.length);
  const kinds = new Set(fortunes.map((f) => f.kind));
  for (const k of FORTUNE_KINDS) assert.ok(kinds.has(k), '缺了 ' + k + ' 类奇遇');
  for (const f of fortunes) assert.ok(f.weight > 0, f.id + ' 的权重必须是正数');
});

test('奇遇：正文里不含模板占位、也不含「未给出」这种采集残留', () => {
  for (const f of fortunes) {
    assert.ok(!/\{\{|TODO|未给出/.test(f.text), f.id + ' 的正文有残留');
    assert.ok(f.text.length >= 15, f.id + ' 太短，不像一段事');
  }
});

test('奇遇：按权重抽，且分布随 roll 覆盖全部条目', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i += 1) {
    const f = pickFortune(fortunes, i / 400);
    assert.ok(f !== null, 'roll 在 [0,1) 里不该抽不到');
    seen.add(f!.id);
  }
  assert.equal(seen.size, fortunes.length, '每个 roll 区间都该抽得到一条：' + seen.size + '/' + fortunes.length);
  // roll=0 抽到第一条，roll 接近 1 抽到最后一条
  assert.equal(pickFortune(fortunes, 0)!.id, fortunes[0]!.id);
  assert.equal(pickFortune(fortunes, 0.9999)!.id, fortunes[fortunes.length - 1]!.id);
});

test('奇遇：每一条都有实际效果（不能只是好看的话）', () => {
  const withEffect = fortunes.filter((f) => {
    const e = f.effect;
    return (e.itemId !== undefined && (e.quantity ?? 0) > 0) || (e.affinity ?? 0) !== 0 || (e.hp ?? 0) !== 0 || (e.mad ?? 0) !== 0 || (e.cor ?? 0) !== 0 || (e.dig ?? 0) !== 0;
  });
  assert.ok(withEffect.length >= 15, '大部分奇遇该有可结算的效果（否则就是只写着没人读）：' + withEffect.length + '/' + fortunes.length);
});

test('奇遇：正文说得出「发生了什么」（.探索 的回执用它）', () => {
  const f = fortunes[0]!;
  const text = renderFortune(f);
  assert.ok(text.includes(f.title));
  assert.ok(text.includes(f.text));
  assert.ok(/【(捡到|目睹|偶遇|预兆|无妄之灾)/.test(text), '要有分类抬头');
});

test('奇遇：触发率与「每日探索次数」匹配（不能稀有到等于没有）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/router/commands/explore.ts', 'utf8');
  const m = /FORTUNE_RATE = ([0-9.]+)/.exec(src);
  assert.ok(m, '要能找到 FORTUNE_RATE');
  const rate = Number(m![1]);
  assert.ok(rate >= 0.01 && rate <= 0.05, '触发率要在 1%—5% 之间：' + rate);
  // .探索 每天 3 次 → 平均多少天碰上
  const daysPer = 1 / (rate * 3);
  assert.ok(daysPer <= 35, '平均要 ≤35 天碰上一次（否则玩家可能一辈子遇不上）：' + daysPer.toFixed(1) + ' 天');
  assert.ok(daysPer >= 7, '也不能太频繁（＜7 天就不叫奇遇了）：' + daysPer.toFixed(1) + ' 天');
});
