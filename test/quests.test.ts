/**
 * M2.85 RPG 化 D：**委托**（用现有机制组合出的任务系统）。
 *
 * 不新造世界观：委托人 = 与你交好的 NPC，报酬 = 好感 + 便士。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContent } from '../src/data/loader.ts';
import { QUEST_KINDS, canTakeQuest, renderQuest } from '../src/domain/world/quest-schema.ts';
import { createHarness } from './helpers/app.ts';

const norm = (s: string) => s.replace(/[\u200B-\u200D\uFEFF]/g, '');
const content = loadContent();

test('委托：24 条、三种类型齐全、id 不重', () => {
  assert.equal(content.quests.length, 24, '委托数量变了就来看一眼：' + content.quests.length);
  assert.equal(new Set(content.quests.map((q) => q.id)).size, content.quests.length);
  const kinds = new Set(content.quests.map((q) => q.kind));
  for (const k of QUEST_KINDS) assert.ok(kinds.has(k), `缺了 ${k} 类委托`);
});


test('委托：**非凡物品不是大白菜**（只有猎杀类，而且概率很低）', () => {
  const withEquip = content.quests.filter((q) => (q.reward.equipmentChance ?? 0) > 0);
  assert.ok(withEquip.length > 0, '猎杀类委托该有概率给非凡物品');
  // 只有猎杀类才开 —— 「替我除掉那个东西」才有理由拿出非凡物品当谢礼
  const nonHunt = withEquip.filter((q) => q.kind !== 'hunt');
  assert.equal(nonHunt.length, 0, '探路 / 跑腿不该给非凡物品：' + nonHunt.map((q) => q.id).join(','));
  // 概率必须低 —— 用户拍板「不该很频繁」
  const maxChance = Math.max(...withEquip.map((q) => q.reward.equipmentChance ?? 0));
  assert.ok(maxChance <= 0.12, '给的概率不能超过 12%：' + maxChance);
  const avg = withEquip.reduce((n, q) => n + (q.reward.equipmentChance ?? 0), 0) / withEquip.length;
  assert.ok(avg <= 0.1, '平均也要低：' + avg.toFixed(3));
});
test('委托：好感不够就接不到（这条是任务系统的门槛）', () => {
  const q = content.quests.find((x) => x.kind === 'hunt')!;
  assert.equal(canTakeQuest(q, { affinity: 0, sequence: 9 }).ok, false, '陌生人不该给你活干');
  assert.equal(canTakeQuest(q, { affinity: q.minAffinity, sequence: 9 }).ok, true);
  assert.ok((canTakeQuest(q, { affinity: 0, sequence: 9 }).reason ?? '').length > 0, '拒绝要说清为什么');
});

test('委托：一句话说得清（谁托的、做什么、给什么）', () => {
  const q = content.quests[0]!;
  const text = renderQuest(q, '某位占卜师');
  assert.ok(text.includes('某位占卜师'));
  assert.ok(text.includes(q.condition));
  assert.ok(text.includes(`${q.reward.affinity}`));
});

test('委托：好感够时 .委托 列得出、.接 接得下、.交 交得掉（端到端闭环）', async () => {
  const h = createHarness();
  try {
    const ch = await h.createCharacter('44000', '克莱恩', 'seer');
    const deps = h.app.router.deps;
    // 先把「交情」做出来：找一位 seer 途径的 NPC 把好感拉满
    const giver = deps.npcDispositions.find((d) => (d.pathways ?? []).includes('seer'))!;
    assert.ok(giver, '要有走占卜家途径的 NPC');
    deps.npcRelations.bump(giver.npcId, ch.id, 80, h.now());
    // 不接交情时先看一眼：没有委托
    const cold = createHarness();
    try {
      await cold.createCharacter('44001', '甲');
      const t0 = norm((await cold.send({ rawText: '.委托', userId: '44001', messageId: 'q0' })).map((m) => m.text).join('\n'));
      assert.ok(t0.includes('没有人找你办事'), '没有交情就不该有委托：' + t0.slice(0, 120));
    } finally { cold.app.close(); }
    const t1 = norm((await h.send({ rawText: '.委托', userId: '44000', messageId: 'q1' })).map((m) => m.text).join('\n'));
    assert.ok(t1.includes('愿意托付你一件事'), '交情到了就该有委托：' + t1.slice(0, 200));
    h.advance(6000);
    const t2 = norm((await h.send({ rawText: '.接 1', userId: '44000', messageId: 'q2' })).map((m) => m.text).join('\n'));
    assert.ok(t2.includes('你应下了'), '接下要给回执：' + t2.slice(0, 150));
    const active = deps.quests.activeOf(ch.id);
    assert.equal(active.length, 1, '接下之后该有一条进行中的');
    h.advance(6000);
    const before = deps.npcRelations.of(active[0]!.npcId, ch.id)!.affinity;
    const t3 = norm((await h.send({ rawText: `.交 ${active[0]!.questId}`, userId: '44000', messageId: 'q3' })).map((m) => m.text).join('\n'));
    assert.ok(t3.includes('交了差'), '交付要给回执：' + t3.slice(0, 150));
    const after = deps.npcRelations.of(active[0]!.npcId, ch.id)!.affinity;
    assert.ok(after > before, `交付该涨好感：${before} → ${after}`);
    assert.equal(deps.quests.activeOf(ch.id).length, 0, '交付之后就不在「手上压着的」里了');
  } finally { h.app.close(); }
});
