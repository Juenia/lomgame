/**
 * **生物名录里「什么算生物」**（M2.93）。
 *
 * 用户实测：「生物名录的底部数据依旧有乱七八糟的数据」。
 *
 * 根因：`bestiary.yaml` 544 条里混着四种东西（真生物 / 材料清单 / 神话生物形态 / 设定整理），
 * 而 `.图鉴 生物` 原先把整表**按 category 铺出来** ⇒ 玩家在「生物名录」底下读到：
 *
 *   【存疑记录】血月与红月的关系 · 「怪物」一词的两种用法
 *   【变异向量】红月 · 神弃之地的黑暗
 *   【普通物种与材料】红葡萄酒100毫升 · 纯水80毫升
 *
 * 它们共用一张表是对的（同一份原作资料、共用 materials/usedIn 两列），
 * 但**不该都出现在玩家的图鉴里**。判据在 `bestiaryKindOf`。
 *
 * 这份测试守两件事：
 *   ① 分类表**覆盖表里出现的每一个 category** —— 漏一个的后果是那一条**静默消失**
 *      （落到 other 去了），而这不报错；
 *   ② `.图鉴 生物` 的输出里**不再出现**材料清单与整理笔记。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BESTIARY_KIND_OF, bestiaryKindOf } from '../src/domain/world/bestiary.ts';
import { createHarness } from './helpers/app.ts';

test('M2.93 分类表覆盖表里出现的每一个 category，且三类各自不为空', () => {
  const h = createHarness();
  try {
    const bestiary = h.app.router.deps.bestiary;
    const cats = [...new Set(bestiary.map((b) => b.category))].sort();
    /*
     * ⚠️ 这是**写死的数量断言**（AGENTS §3.5）：category 一变就红，提醒人来看一眼。
     * 分类表里少一个键不会报错，只会让那一条从玩家图鉴里消失 —— 所以这里必须红。
     */
    assert.equal(cats.length, 12, 'category 的个数变了：' + cats.join('、'));
    const missing = cats.filter((c) => BESTIARY_KIND_OF[c] === undefined);
    assert.deepEqual(missing, [], '这些 category 没有分类（那一条会在图鉴里静默消失）：' + missing.join('、'));

    const byKind = { creature: 0, form: 0, other: 0 };
    for (const b of bestiary) byKind[bestiaryKindOf(b)] += 1;
    assert.ok(byKind.creature > 0 && byKind.form > 0 && byKind.other > 0, '三类都该有内容：' + JSON.stringify(byKind));
    assert.equal(byKind.creature + byKind.form + byKind.other, bestiary.length);
  } finally {
    h.app.close();
  }
});

test('M2.93 .图鉴 生物 不再列出材料清单与整理笔记，但总数如实', async () => {
  const h = createHarness();
  try {
    await h.send({ rawText: '.创建 克莱恩', userId: '91001', scene: 'private' });
    await h.send({ rawText: '1', userId: '91001', scene: 'private' });
    h.advance(6000);
    const out = await h.send({ rawText: '.图鉴 生物', userId: '91001', scene: 'private' });
    const text = out.map((r) => r.text).join('\n');

    const bestiary = h.app.router.deps.bestiary;
    const listed = bestiary.filter((b) => bestiaryKindOf(b) !== 'other').length;
    assert.match(text, new RegExp('【生物名录 · ' + listed + ' 条】'), '标题的条数要等于「真生物 + 形态」：' + listed);

    /*
     * 这几样是最刺眼的「乱七八糟」。
     *
     * ⚠️ 判据是**小节标题**（`— X（N）—`），不是裸词 —— 尾部那句说明里会举例
     * 「存疑记录、事件案例…」，用裸词判会把自家说明文字当成违规。
     */
    for (const bad of ['存疑记录', '变异向量', '事件案例', '失控机制', '按途径的怪物群', '植被环境', '普通物种与材料']) {
      assert.ok(!text.includes('— ' + bad + '（'), '生物图鉴里不该有「' + bad + '」这一节');
    }
    assert.ok(!text.includes('红葡萄酒') && !text.includes('纯水'), '材料清单不该混进生物名录');
    // 但要说明「没列出来的那些是什么」，否则读过旧版的人会以为内容丢了
    assert.match(text, /不是生物/, '要说清没列出来的那部分是什么');
    const hidden = bestiary.length - listed;
    assert.ok(text.includes(String(hidden)), '没列出来的条数要如实写出来：' + hidden);
  } finally {
    h.app.close();
  }
});
