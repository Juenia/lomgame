/**
 * **世界历史有了玩家入口**（M2.96）。
 *
 * `history.yaml` 的 27 条（含最近几批补的远古段：「最初」苏醒 / 九份源质 / 西大陆封印 /
 * 八大古神 / 夜之国 / 亵渎石板 / 黑铁纪元）在这之前**只影响机制** ——
 * 它们给出危险度加成、埋下封印物、写下势力旧仇，而玩家在任何地方都读不到：
 *
 *   `.图鉴 历史` → 「没有『历史』这一类」
 *   `.世界 地点 X` → 只有天气与危险度
 *
 * ⇒ 玩家脚下的每一寸地都带着几千年的因果，而他看不见。
 * （这是「显示个文本但没机制」的反面，同样是缺口。）
 *
 * 这份测试守三件事：
 *   ① 列表里有全部 27 条（写死的数量断言）；
 *   ② 详查把 id 译成中文名（`涉及地方：霍纳奇斯峰`，不是 `hornacis_peak`）；
 *   ③ ⚠️ **`taboo_knowledge` 只报条数，不报内容** —— 那是「不该被知道的事」，
 *      写出来设定就塌了。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';

test('M2.96 .图鉴 历史：27 条有入口，详查给出因果，但 taboo 只报条数', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('98001', '读史的人');
    const list = (await h.send({ rawText: '.图鉴 历史', userId: '98001' })).map((r) => r.text).join('\n');
    assert.match(list, /【世界历史 · 27 条】/, '条数写死 —— 历史一变就红');
    assert.match(list, /夜之国/, '最近补的远古段也要在里面');
    assert.match(list, /黑铁纪元的开始/, '远古段最年轻的一条');

    const detail = (await h.send({ rawText: '.图鉴 历史 夜之国', userId: '98001' })).map((r) => r.text).join('\n');
    assert.match(detail, /【夜之国】王朝 · 4200 年前/);
    assert.match(detail, /涉及地方：霍纳奇斯峰/, '地点 id 要译成中文名，不能把 hornacis_peak 摆给玩家');
    assert.match(detail, /它留下的：/, '历史要能回答「它改了什么」');

    // ⚠️ 这一条是这份文件最要紧的判据
    const taboo = h.app.router.deps.historyIndex
      .events.find((e) => e.id === 'night_country')!.effects.taboo_knowledge;
    assert.ok(taboo.length > 0, '前置：这条历史确实按着一件事');
    assert.match(detail, new RegExp(taboo.length + ' 件事至今被按着'), '只报条数');
    for (const item of taboo) {
      assert.ok(!detail.includes(item.what), '「不该被知道的事」的内容不许出现在图鉴里：' + item.what);
    }

    // 首页的计数与点进去看到的要对得上（M2.93 之后生物名录只列真生物）
    const index = (await h.send({ rawText: '.图鉴', userId: '98001' })).map((r) => r.text).join('\n');
    assert.match(index, /历史 27 条/);
    assert.match(index, /生物 342 条（另有 202 条/, '首页说 544、点进去 342 是最容易被用户抓住的不一致');
  } finally {
    h.app.close();
  }
});
