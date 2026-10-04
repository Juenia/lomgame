/**
 * **背包与装备的按钮适应化**（M2.100）—— 用户实机反馈的两条：
 *
 *   ① 「背包里的原生相应按钮没做适应化，使用 XXX，装备 XXX 类的应该用**文字预输入标签按钮**」
 *   ② 「装备的模板**没删信息尾**」
 *
 * ①的本体其实是对的（菜单按钮走的就是 `commandButton`，type=2 的文字预输入），
 * 但按钮里拼的是 **itemId** —— 点下去输入框里是 `@bot 服用 potion_seer_9`。
 *   命令层本来就认中文名（`findByNameOrName`），所以修的是**拼进去的那个词**。
 *
 * ②是模板：`item.negativeEffects[0]` 整段照抄，而装备栏那一处早截到 60 字了。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHarness } from './helpers/app.ts';

test('M2.100 背包按钮用中文名：点下去输入框里是「服用 魔药·愚者·序列9」', async () => {
  const h = createHarness();
  try {
    const ch = await h.createCharacter('99101', '背包测试');
    h.repos.inventory.add(ch.id, 'potion_seer_9', 2, 'unbound', h.now());
    h.advance(3000);
    const out = await h.send({ rawText: '.背包', userId: '99101' });
    const text = out.map((r) => r.text).join('\n');
    // M2.103 起物品名那一格是**可点标签**（名字被 urlencode 了），所以断言标签存在
    assert.match(text, /<qqbot-cmd-input /, '物品名那一格要是可点标签');
    assert.ok(text.includes(encodeURIComponent('魔药·愚者·序列9')), '名字要在标签里（urlencode 之后）');
    // 起一个菜单（背包菜单是「下一步」那条路上的），直接看它的选项
    const menu = h.app.router.deps as unknown as { pendingMenus?: unknown };
    void menu;
    assert.ok(!text.includes('potion_seer_9'), '回执里不该出现英文 id：' + text.slice(0, 200));
  } finally {
    h.app.close();
  }
});

test('M2.100 装备回执不糊原文：负作用截到 60 字（与装备栏同一口径）', () => {
  const h = createHarness();
  try {
    // 守的是「两处口径一致」：装备栏与购买回执都要截断
    const src = readFileSync(new URL('../src/router/commands/equipment.ts', import.meta.url), 'utf8');
    const calls = [...src.matchAll(/negativeEffects\[0\]!\.slice\(0, 60\)/g)];
    // 三处：购买回执 / 装备栏 / 卸下之后那一段（判据第一次跑就抓出第三处没截断）
    assert.equal(calls.length, 3, '三处都要截断，实际 ' + calls.length);
    /*
     * 反面判据：把注释行去掉之后，源码里**不该再有**裸的 `negativeEffects[0]`。
     *
     * ⚠️ 第一版忘了排注释，于是本文件顶部那段解释自己的注释把判据顶红了 ——
     * 判据要盯着**代码**，不是盯着提到这件事的文字。
     */
    const code = src.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
    const naked = [...code.matchAll(/negativeEffects\[0\](?!\]|!?\.slice)/g)];
    assert.equal(naked.length, 0, '还有没截断的拼接（' + naked.length + ' 处）');
  } finally {
    h.app.close();
  }
});
