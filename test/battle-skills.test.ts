/**
 * M2.85 RPG 化 C：**战斗深度** —— 技能从原作能力表派生。
 *
 * 技能名与 text 逐条来自 pathway-abilities.yaml（source 指向能力 id），不是编造。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContent } from '../src/data/loader.ts';
import { ALL_SKILLS, contentSkillsOf, skillByName, skillsFor } from '../src/domain/battle/skills.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';

const content = loadContent();
const table = content.battleSkills;

test('战斗技能：110 条、22 条途径每条都有、id 不重', () => {
  assert.equal(table.length, 110, '技能数量变了就来看一眼：' + table.length);
  assert.equal(new Set(table.map((s) => s.id)).size, table.length, 'id 不能重');
  const pathways = new Set(table.map((s) => s.pathway));
  assert.equal(pathways.size, Object.keys(PATHWAY_LABELS).length, '每条途径都该有技能（少了就是漏了途径）');
});

test('战斗技能：名字与依据都来自原作（source 指得到能力）', async () => {
  const fs = await import('node:fs');
  const yaml = await import('yaml');
  const raw = yaml.parse(fs.readFileSync('src/data/pathway-abilities.yaml', 'utf8'));
  const ids = new Set(raw.pathway_abilities.map((a: { id: string }) => a.id));
  const missing = table.filter((s) => !ids.has(s.source));
  assert.equal(missing.length, 0, '每条技能都要指得到一条真实能力：' + missing.slice(0, 3).map((s) => s.source).join(','));
  // 名字不该是半句话（第一版踩过「获得灵视能力」这种）
  const suspicious = table.filter((s) => s.name.length < 2 || /凭借|因此|任何$|获得/.test(s.name));
  assert.equal(suspicious.length, 0, '技能名不该是半句话：' + suspicious.slice(0, 3).map((s) => s.name).join('、'));
});

test('战斗技能：序列越低做得越多（技能是解禁，不是升级）', () => {
  const high = skillsFor('seer', 9, table).length;      // 序列 9
  const low = skillsFor('seer', 1, table).length;       // 序列 1
  assert.ok(low > high, `序列 1 的技能池该比序列 9 大：${low} vs ${high}`);
  assert.ok(high > 0, '序列 9 也该有技能');
});

test('战斗技能：内容表与 numeric 的技能池会合并', () => {
  const ownOnly = skillsFor('seer', 5, []).length;
  const merged = skillsFor('seer', 5, table).length;
  assert.ok(merged > ownOnly, `合并后应当更多：${merged} vs ${ownOnly}`);
  const fromContent = contentSkillsOf(table).filter((s) => s.pathway === 'seer' && 5 <= s.seq);
  assert.ok(fromContent.length > 0);
  // 不合途径的人拿不到技能
  assert.equal(skillsFor(null, 9, table).length, 0, '普通人（没有途径）技能池为空');
});

test('战斗技能：按名字查得到内容表里的技能', () => {
  const sample = table[0]!;
  assert.equal(skillByName(sample.name, table)?.id, sample.id, '内容表的技能要能被 .战斗 技能 <名> 查到');
  assert.equal(skillByName('绝对没有这个技能', table), null);
  // 不传内容表时退回 numeric（旧行为不变）
  const legacy = ALL_SKILLS[0]!;
  assert.equal(skillByName(legacy.name)?.id, legacy.id);
});

test('战斗技能：四类效果都有落点', () => {
  const kinds = new Set(table.map((s) => s.kind));
  for (const k of ['strike', 'guard', 'control', 'restore']) assert.ok(kinds.has(k as never), `缺了 ${k} 类`);
  const strike = table.find((s) => s.kind === 'strike')!;
  assert.ok((strike.effect.damageBonus ?? 0) > 0, '强攻该有伤害加成');
  const control = table.find((s) => s.kind === 'control')!;
  assert.ok((control.effect.foeHitPenalty ?? 0) > 0, '控制该让对手命中下降');
  const restore = table.find((s) => s.kind === 'restore')!;
  assert.ok((restore.effect.mpRestore ?? 0) > 0 || (restore.effect.digBonus ?? 0) > 0, '辅助该回灵或给消化');
});
