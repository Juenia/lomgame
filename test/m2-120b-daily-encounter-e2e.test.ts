/**
 * **日常遭遇的端到端**（M2.120）—— 取代 `.扮演` 的那条路。
 *
 * 用户：「扮演本来就是**日常行为**，所以扮演指令没什么用」。
 *
 * 形态：每天 N 次，在玩家**做正事**时先弹一张「只有这条途径的人撞得到」的卡，
 * 玩家选一个 ⇒ 按那一支结算 ⇒ 涨消化度。
 *
 * ⚠️ 测试夹具默认把这个钩子关掉（`NUMERIC.play.dailyEncounters = 0`）——
 * 否则前两条正事会被遭遇占掉，几百条既有断言全要看运气。
 * 这个文件**自己把它打开**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { createHarness } from './helpers/app.ts';

test('M2.120 做正事时先遇到途径事件卡，选一个就涨消化度', async () => {
  const saved = NUMERIC.play.dailyEncounters;
  NUMERIC.play.dailyEncounters = 2;
  const h = createHarness();
  try {
    const created = await h.createCharacter('98201', '占卜的人');
    h.advance(3000);
    const first = await h.send({ rawText: '.探索 廷根市', userId: '98201' });
    const text = first.map((r) => r.text).join('\n');
    /*
     * ⚠️ 不写死卡名：途径池里现在**每张卡都有 options**（M2.122 铺开），
     * 抽到哪一张取决于当天的种子。判据守的是**形状**（弹了一张带选项的卡），不是某一张。
     */
    assert.match(text, /【[^】]+】/, '该弹出一张卡：' + text.slice(0, 200));
    /*
     * 选项文字**不写死**：72 张途径卡里既有手工写的（「收起来，不再看第二眼」），
     * 也有批量生成的（「顺着它来 / 按住不动」）—— 抽到哪张看当天的种子。
     * 判据守的是**形状**：卡标题 + 至少两个编号选项。
     */
    assert.match(text, /\n1\. /, '要给编号选项：' + text.slice(0, 240));
    assert.match(text, /\n2\. /, '要至少两个选项：' + text.slice(0, 240));
    // 探索被这次遭遇占掉了（设计如此：未决的事优先）
    assert.ok(!text.includes('【探索'), '探索该被遭遇挡住');

    // 选一支 ⇒ 结算 ⇒ 消化度涨
    h.advance(3000);
    const chosen = await h.send({ rawText: '1', userId: '98201' });
    const after = chosen.map((r) => r.text).join('\n');
    assert.match(after, /消化/, '要给出结算：' + after.slice(0, 200));
    const state = h.repos.characters.findById(created.id)!;
    assert.ok(state.dig > 0, '消化度要涨：' + state.dig);
  } finally {
    NUMERIC.play.dailyEncounters = saved;
    h.app.close();
  }
});

test('M2.120 查看类命令不触发遭遇（看一眼都不行的话，玩家会烦）', async () => {
  const saved = NUMERIC.play.dailyEncounters;
  NUMERIC.play.dailyEncounters = 2;
  const h = createHarness();
  try {
    await h.createCharacter('98202', '占卜的人');
    h.advance(3000);
    const out = await h.send({ rawText: '.状态', userId: '98202' });
    const text = out.map((r) => r.text).join('\n');
    assert.ok(text.includes('生命'), '状态页照常给：' + text.slice(0, 120));
    assert.ok(!text.includes('顺着它来'), '查看类不该被遭遇打断：' + text.slice(0, 160));
  } finally {
    NUMERIC.play.dailyEncounters = saved;
    h.app.close();
  }
});

test('M2.120 一天只遇到 dailyEncounters 次（弹出来就算一次，不选也不会重复弹）', async () => {
  const saved = NUMERIC.play.dailyEncounters;
  NUMERIC.play.dailyEncounters = 1;
  const h = createHarness();
  try {
    await h.createCharacter('98203', '占卜的人');
    h.advance(3000);
    const first = await h.send({ rawText: '.探索 廷根市', userId: '98203' });
    assert.match(first.map((r) => r.text).join('\n'), /【[^】]+】/, '第一次该遇到');
    // 不选，直接再发一条正事 —— 不该再弹（配额已用）
    h.advance(3000);
    const second = await h.send({ rawText: '.探索 廷根市', userId: '98203' });
    const text = second.map((r) => r.text).join('\n');
    assert.ok(!text.includes('顺着它来'), '配额用完了不该再弹：' + text.slice(0, 160));
  } finally {
    NUMERIC.play.dailyEncounters = saved;
    h.app.close();
  }
});
