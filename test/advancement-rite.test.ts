/**
 * M2.85 内容填充 P6：晋升仪式要求（132 条原作数据）。
 *
 * 这张表的价值在于「原作怎么写就怎么显示」——所以判据是：
 *   1. 22 条途径 × 序列 5—0 全覆盖；
 *   2. 序列 6—9 **没有**条目（原作本来就没写，不许我们补）；
 *   3. 文本是原作原文（抽取关键句比对）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContent } from '../src/data/loader.ts';
import { advancementRiteOf } from '../src/domain/ritual/advancement-rite.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';

process.env.TEMP = process.env.TEMP ?? 'data/tmp';

const content = loadContent();
const rites = content.advancementRites;

test('晋升仪式要求：132 条，22 条途径 × 序列 5—0', () => {
  assert.equal(rites.length, 132, '条数 = 22 途径 × 6 档');
  const pathways = new Set(rites.map((rite) => rite.pathway));
  assert.equal(pathways.size, Object.keys(PATHWAY_LABELS).length, '每条途径都要有');
  for (const seq of [5, 4, 3, 2, 1, 0]) {
    assert.equal(rites.filter((rite) => rite.seq === seq).length, 22, `序列 ${seq} 应当 22 条`);
  }
});

test('晋升仪式要求：序列 6—9 没有条目 —— 那是原作的空白，不是我们的缺口', () => {
  for (const seq of [6, 7, 8, 9]) {
    assert.equal(rites.filter((rite) => rite.seq === seq).length, 0, `序列 ${seq} 不该有条目（原作未载）`);
  }
});

test('晋升仪式要求：文本是原作原文（抽查三格）', () => {
  const seer5 = advancementRiteOf(rites, 'seer', 5);
  assert.ok(seer5, '占卜家途径序列 5 要有仪式');
  assert.match(seer5.ritual, /美人鱼的歌声/, '愚者途径序列 5 的原文');

  const seer0 = advancementRiteOf(rites, 'seer', 0);
  assert.ok(seer0, '序列 0 要有仪式');
  assert.match(seer0.ritual, /愚弄/, '序列 0 的原文');

  const missing = advancementRiteOf(rites, 'seer', 9);
  assert.equal(missing, null, '低序列没有仪式 —— 读取点必须能区分「没有」与「空字符串」');
});
