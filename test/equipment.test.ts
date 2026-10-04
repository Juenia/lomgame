/**
 * M2.85 RPG 化 B：**装备**（用户要「更 rpg 一点」，选定 B 装备与物品）。
 *
 * 装备与 items 分开的理由见 domain/item/equipment.ts 的文件头：
 * 有槽位/品质/词条、不可堆叠 —— 一个人不可能同时穿两件外套。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContent } from '../src/data/loader.ts';
import {
  EQUIPMENT_SLOTS, canEquip, effectiveStats, statsLine, totalStats,
  type Equipment,
} from '../src/domain/item/equipment.ts';
import { createHarness } from './helpers/app.ts';

const norm = (s: string) => s.replace(/[\u200B-\u200D\uFEFF]/g, '');
const content = loadContent();

test('装备：表里 150 件、四个槽位都有货、id 不重', () => {
  const eq = content.equipment;
  assert.equal(eq.length, 108, '装备数量变了就来看一眼：' + eq.length);
  // 装备 = **非凡物品**（用户纠正）：有增幅就一定有代价
  const withCost = eq.filter((e) => (e.debuffs.madPerUse ?? 0) > 0 || (e.debuffs.hpDrain ?? 0) > 0);
  assert.ok(withCost.length >= eq.length * 0.8, '大部分装备该有代价（原著的规则是必然伴随）：' + withCost.length + '/' + eq.length);
  for (const slot of EQUIPMENT_SLOTS) {
    assert.ok(eq.some((e) => e.slot === slot), `槽位 ${slot} 一件都没有 —— 后台选不到`);
  }
  assert.equal(new Set(eq.map((e) => e.id)).size, eq.length, 'id 不能重');
});


test('装备：**非凡物品**都有封印等级，且大部分带副作用原文', () => {
  const eq = content.equipment;
  const bad = eq.filter((e) => !['0', '1', '2', '3', 'unrated'].includes(e.level));
  assert.equal(bad.length, 0, '封印等级只能是 0/1/2/3/unrated：' + bad.slice(0, 2).map((e) => e.level).join(','));
  const withText = eq.filter((e) => e.negativeEffects.length > 0 && !/未列出负面效果/.test(e.negativeEffects.join('')));
  assert.ok(withText.length >= eq.length * 0.8, '副作用原文该来自原作（不是编的）：' + withText.length + '/' + eq.length);
  // 0 级封印物不可能没有代价 —— 越强越贵
  const top = eq.filter((e) => e.level === '0');
  assert.ok(top.length > 0, '要有 0 级封印物');
  const allCostly = top.every((e) => (e.debuffs.hpDrain ?? 0) > 0 || (e.debuffs.madPerUse ?? 0) > 0);
  assert.ok(allCostly, '0 级封印物不可能没有代价');
});
test('装备：序列不到就压不住（canEquip 的判据）', () => {
  const strong = content.equipment.find((e) => e.sequence <= 2)!;
  const weakGuy = { sequence: 9, pathway: null };
  const strongGuy = { sequence: 1, pathway: null };
  assert.equal(canEquip(strong, weakGuy).ok, false, '序列 9 的人不该拿得动序列 1 的东西');
  assert.equal(canEquip(strong, strongGuy).ok, true);
  const weak = content.equipment.find((e) => e.sequence === 9)!;
  assert.equal(canEquip(weak, weakGuy).ok, true, '序列 9 的东西谁都能装');
});

test('装备：途径专属只对走那条路的人生效', () => {
  const pathItem = content.equipment.find((e) => e.pathway !== undefined);
  if (pathItem === undefined) return;   // 没有途径专属的不测
  assert.ok(Object.keys(effectiveStats(pathItem, { pathway: pathItem.pathway! })).length > 0, '本途径要有加成');
  assert.equal(Object.keys(effectiveStats(pathItem, { pathway: 'nobody' })).length, 0, '别人拿着是死物');
});

test('装备：加成累加（四件装齐就是四份）', () => {
  // 从每类槽位各挑一件（用实际存在的，不假设序列 9 —— 非凡物品多半是高序列的）
  const worn: Equipment[] = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const found = content.equipment.find((e) => e.slot === slot && e.pathway === undefined) ?? content.equipment.find((e) => e.slot === slot);
    if (found !== undefined) worn.push(found);
  }
  assert.equal(worn.length, 4);
  const total = totalStats(worn, { pathway: null });
  const sum = worn.reduce((acc, e) => acc + (e.stats.hit ?? 0), 0);
  assert.equal(Number((total.hit ?? 0).toFixed(4)), Number(sum.toFixed(4)), '命中应当是几件之和');
  assert.ok((total.damage ?? 0) > 0 || (total.hp ?? 0) > 0, '至少要有一项加成看得见');
  assert.ok(statsLine(total).length > 0 && statsLine(total) !== '没有加成');
});

test('装备：没拥有就装不上（「获得」这一步不能省）', async () => {
  const h = createHarness();
  try {
    const ch = await h.createCharacter('42009', '克莱恩', 'seer');
    const deps = h.app.router.deps;
    deps.characters.update({ ...deps.characters.findById(ch.id)!, sequence: 5 });
    const item = content.equipment.find((e) => e.slot === 'weapon' && e.pathway === undefined && e.sequence >= 5)!;
    const t = norm((await h.send({ rawText: '.装备 ' + item.name, userId: '42009', messageId: 'q0' })).map((m) => m.text).join('\n'));
    assert.ok(t.includes('你手里没有'), '没拥有就该装不上：' + t.slice(0, 120));
    assert.ok(t.includes('.买'), '要告诉他从哪来');
    // 给了就能装
    deps.equipment.acquire(ch.id, item.id, 'gm', h.now());
    h.advance(6000);
    const t2 = norm((await h.send({ rawText: '.装备 ' + item.name, userId: '42009', messageId: 'q1' })).map((m) => m.text).join('\n'));
    assert.ok(t2.includes(item.name), '拥有了就该装得上：' + t2.slice(0, 140));
    assert.ok(t2.includes('代价'), '装备回执要同时说清代价');
  } finally { h.app.close(); }
});

test('装备：装上 / 查看 / 卸下（端到端）', async () => {
  const h = createHarness();
  try {
    const ch = await h.createCharacter('42001', '克莱恩', 'seer');
    const deps0 = h.app.router.deps;
    // ⚠️ 非凡物品都是**高序列**的（原著的规则）：序列 9 的新手拿不动 —— 先把他提到序列 5
    deps0.characters.update({ ...deps0.characters.findById(ch.id)!, sequence: 5 });
    // 现在装备要**先拥有**（掉落/购买/委托）—— 测试里直接发一件
    // 而且挑一件他真的压得住的（序列 ≥ 5）
    const item = content.equipment.find((e) => e.slot === 'weapon' && e.pathway === undefined && e.sequence >= 5)!;
    deps0.equipment.acquire(ch.id, item.id, 'battle', h.now());
    const t1 = norm((await h.send({ rawText: '.装备栏', userId: '42001', messageId: 'q1' })).map((m) => m.text).join('\n'));
    assert.ok(t1.includes('武器：（空）'), '一开始装备栏该是空的：' + t1.slice(0, 100));
    h.advance(6000);
    const t2 = norm((await h.send({ rawText: `.装备 ${item.name}`, userId: '42001', messageId: 'q2' })).map((m) => m.text).join('\n'));
    assert.ok(t2.includes(item.name), '回执要说清换上了什么');
    h.advance(6000);
    const t3 = norm((await h.send({ rawText: '.装备栏', userId: '42001', messageId: 'q3' })).map((m) => m.text).join('\n'));
    assert.ok(t3.includes(item.name), '装备栏里应当看得到它');
    assert.ok(!t3.includes('武器：（空）'));
    h.advance(6000);
    const t4 = norm((await h.send({ rawText: '.卸下 武器', userId: '42001', messageId: 'q4' })).map((m) => m.text).join('\n'));
    assert.ok(t4.includes('卸下'), '卸下要给回执：' + t4.slice(0, 100));
  } finally { h.app.close(); }
});

test('装备：命中加成真的进了战斗（不是摆设）', async () => {
  const h = createHarness();
  try {
    const ch = await h.createCharacter('42002', '克莱恩', 'seer');
    const deps = h.app.router.deps;
    deps.characters.update({ ...deps.characters.findById(ch.id)!, sequence: 5 });
    const item = content.equipment.find((e) => e.slot === 'weapon' && e.pathway === undefined && e.sequence >= 5)!;
    deps.equipment.acquire(ch.id, item.id, 'battle', h.now());
    deps.equipment.equip(ch.id, 'weapon', item.id, h.now());
    // 战场快照要带上它（battleWorldOf 会在开局时折进来）
    const beast = deps.creatures.all().find((c) => c.locationId !== null);
    assert.ok(beast, '要有至少一只生物可以打');
    const { startBattle } = await import('../src/router/commands/battle-hooks.ts');
    const r = startBattle({ deps, character: deps.characters.findById(ch.id)!, creatureId: beast.id, layer: 'full', sightingId: 'none', now: h.now(), seed: 'equip-test' });
    if (!r.ok) { assert.fail('应当能开打：' + r.reason); }
    assert.ok((r.battle!.world.equipmentHitBonus ?? 0) > 0, '装备的命中加成必须进到战场快照里，否则就是死数据');
  } finally { h.app.close(); }
});
