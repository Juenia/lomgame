/**
 * M2.85 内容填充 P1 —— 塔罗牌（大阿卡那 22 张，原作数据直出）。
 *
 * 这份用例守三件事：
 *   1. **表本身**：22 张、编号 0—21、途径双向覆盖（22 条途径恰好各一张牌）；
 *   2. **来源**：每条都带 evidence（可溯源到原作数据），且 5 处「原作 id → 项目 id」转换正确；
 *   3. **读取点**：`.占卜` 的回执里真的摊开一张牌（不许有「只写着没人读」的表）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContentOrThrow, loadTarot } from '../src/data/loader.ts';
import { tarotCardOf } from '../src/domain/divination/tarot.ts';
import { ALL_PATHWAYS } from '../src/card/titles.ts';
import { createHarness } from './helpers/app.ts';

test('塔罗：22 张大阿卡那，编号 0—21，途径双向覆盖', () => {
  const { tarot, issues } = loadTarot();
  assert.deepEqual(issues.filter((issue) => issue.level === 'error'), [], '塔罗表不许有 error');
  assert.equal(tarot.length, 22, '大阿卡那必须 22 张');
  assert.deepEqual(
    tarot.map((card) => card.number).sort((a, b) => a - b),
    [...Array(22).keys()],
    '编号必须恰好是 0—21',
  );
  // 双向覆盖：每张牌一条途径 + 项目 22 条途径各有牌
  assert.equal(new Set(tarot.map((card) => card.pathway)).size, 22, '牌与途径必须一一对应');
  for (const pathway of ALL_PATHWAYS) {
    assert.ok(tarotCardOf(tarot, pathway), pathway + ' 没有对应的塔罗牌');
  }
  for (const card of tarot) {
    assert.ok(card.evidence.length > 0, card.id + ' 缺 evidence（无法溯源）');
    assert.ok(card.symbolism.length > 0, card.id + ' 缺象征意义');
  }
});

test('塔罗：原作 id → 项目 id 的 5 处转换正确（同一途径不同名）', () => {
  const { tarot } = loadTarot();
  // 原作取「序列 9 英文名」，项目 id 有 5 处不同名（见 docs/内容填充计划-原作复刻.md §二）
  assert.equal(tarotCardOf(tarot, 'door')?.nameEn, 'The Magician', 'apprentice（学徒）→ door');
  assert.equal(tarotCardOf(tarot, 'perfect')?.nameEn, 'The High Priestess（原作口径 The Priestess）', 'savant（通识者）→ perfect');
  assert.equal(tarotCardOf(tarot, 'error')?.nameEn, 'The Lovers', 'marauder（偷盗者）→ error');
  assert.equal(tarotCardOf(tarot, 'sun')?.nameEn, 'The Sun', 'bard（歌颂者）→ sun');
  assert.equal(tarotCardOf(tarot, 'mother')?.nameEn, 'The World', 'planter（耕种者）→ mother');
  assert.equal(tarotCardOf(tarot, 'seer')?.name, '愚者', '愚者是 0 号牌');
});

test('塔罗：装载进 ContentBundle（.占卜 的牌池来源）', () => {
  const bundle = loadContentOrThrow();
  assert.equal(bundle.tarot.length, 22);
});

test('塔罗：.占卜 的回执里摊开一张牌（读取点存在）', async () => {
  const h = createHarness();
  try {
    const userId = '910001';
    const character = await h.createCharacter(userId, '占卜的人', 'seer');
    h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, mp: 120, updatedAt: h.now() });
    h.advance(11_000);
    const sent = await h.send({ rawText: '.占卜 明天会下雨吗', userId });
    const text = sent.map((message) => message.text).join('\n');
    assert.match(text, /你摊开了牌：\*\*.+\*\*（\d+ · .+）—— .+途径/, '回执里要有牌名 / 编号 / 英文名 / 对应途径：' + text.slice(0, 200));
  } finally {
    h.app.close();
  }
});
