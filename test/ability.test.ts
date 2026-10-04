import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  abilityFlag,
  capsFromAbilityEffects,
  mergeAbilityEffects,
} from '../src/domain/ability/ability.ts';
import { apply, applyWithCaps } from '../src/domain/effect/apply.ts';
import { resolveExplore } from '../src/domain/explore/explore.ts';
import { loadAbilities, loadLocations } from '../src/data/loader.ts';
import { AbilityRepo } from '../src/infra/db/abilities.ts';
import { migrate, openDatabase } from '../src/infra/db/sqlite.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

const { abilities } = loadAbilities();
const { locations } = loadLocations();
const darkCellar = locations.find((l) => l.id === 'dark_cellar')!;

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1', userId: 'u1', name: '克莱恩', pathway: 'seer', pathwayStatus: 'initiated', gender: 'male', sequence: 8,
    hp: 100, mp: 100, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

function scriptedRng(values: number[]): { next(): number } {
  let index = 0;
  return { next: () => values[index++] ?? 0 };
}

test('能力数据：四条途径的序列 8 与序列 7 能力齐备，效果字段可解释', () => {
  // M2.12：每途径多一条序列 7 的能力（感知向），3 → 6
  // M2.19：接入 sailor（水手），6 → 8
  // M2.26 三批 ⇒ 14；M2.29 批次 A1（序列 6）逐途径 +1 ⇒ **21**（7 途径全部落地）
  // 批次 A2（序列 5）逐途径 +1 ⇒ 28
  // M2.39 批次 B（序列 4、3）逐途径 +2 ⇒ **42** = 7 途径 × 6
  /*
   * M2.43 批次 C（序列 2）逐途径 +1 ⇒ 49 = 7 途径 × 7。
   * M2.76：22 条途径全落地 ⇒ 154 = 22 × 7（15 条新途径各补 7 档，
   * 全部落在已有的 8 个 effect 字段上 —— 能力侧零新字段，与批次 A 同一条口径）。
   *
   * **M2.94：补上一直空着的两档 ⇒ 198 = 22 × 9** —— 序列 9（一入途径就是它）
   * 与序列 1（本版可达的顶）。这两档原来在表里没有定义，于是新手与走到顶的人
   * 在菜单里都看到「暂无能力」。
   */
  assert.equal(abilities.length, 198);
  // 22 途径 × 9 档**逐档齐全**（9/8/7/6/5/4/3/2/1）—— 这是这一批真正要守的东西
  const seqs = [...new Set(abilities.map((a) => a.seq))].sort((a, b) => b - a);
  assert.deepEqual(seqs, [9, 8, 7, 6, 5, 4, 3, 2, 1], '每一档都要有：' + seqs.join('、'));
  for (const seq of seqs) {
    const n = abilities.filter((a) => a.seq === seq).length;
    assert.equal(n, 22, '序列 ' + seq + ' 应当 22 条（每途径一条），实际 ' + n);
  }
  /*
   * ⚠️ 序列 9 **不许用倍率字段**：`mergeAbilityEffects` 对倍率是累乘的，
   * 而序列 9 在曲线最前面 —— 在那里乘一个系数等于把后面每一档一起改了。
   */
  for (const a of abilities.filter((x) => x.seq === 9)) {
    assert.equal(a.effect.exploreDangerMultiplier, undefined, a.id + ' 不该用倍率字段');
    assert.equal(a.effect.divinationCooldownMultiplier, undefined, a.id + ' 不该用倍率字段');
  }
  const seer = abilities.find((a) => a.pathway === 'seer' && a.seq === 8)!;
  assert.equal(seer.name, '小丑');
  assert.equal(seer.effect.divinationDailyBonus, 1);
  assert.equal(seer.effect.divinationCooldownMultiplier, 0.5);

  const warrior = abilities.find((a) => a.pathway === 'warrior' && a.seq === 8)!;
  assert.equal(warrior.name, '格斗家');
  assert.equal(warrior.effect.maxHpBonus, 10);
  assert.equal(warrior.effect.initiativeBonus, 2);

  const sleepless = abilities.find((a) => a.pathway === 'sleepless' && a.seq === 8)!;
  assert.equal(sleepless.name, '午夜诗人');
  assert.equal(sleepless.effect.exploreDangerMultiplier, 0.8);

  // ---- M2.12：序列 7 的三条能力（全部是**感知向**，不给数值加成）----
  const seer7 = abilities.find((a) => a.pathway === 'seer' && a.seq === 7)!;
  assert.equal(seer7.name, '魔术师');
  assert.equal(seer7.effect.divinationExtraOmen, 1, '命运碎片：多看到一条卜象');
  const warrior7 = abilities.find((a) => a.pathway === 'warrior' && a.seq === 7)!;
  assert.equal(warrior7.name, '黎明骑士');
  assert.equal(warrior7.effect.hostilitySense, true, '敌意感知');
  const sleepless7 = abilities.find((a) => a.pathway === 'sleepless' && a.seq === 7)!;
  assert.equal(sleepless7.name, '噩梦');
  assert.equal(sleepless7.effect.dreamGap, true, '梦隙');

  // ---- M2.19：水手（sailor）的两条。字段全部复用既有的，这一轮一个新效果字段都没造 ----
  const sailor8 = abilities.find((a) => a.pathway === 'sailor' && a.seq === 8)!;
  assert.equal(sailor8.name, '航海家');
  assert.equal(sailor8.effect.exploreDangerMultiplier, 0.85, '走得更稳：探索危险 ×0.85');
  const sailor7 = abilities.find((a) => a.pathway === 'sailor' && a.seq === 7)!;
  assert.equal(sailor7.name, '风眷者');
  assert.equal(sailor7.effect.hostilitySense, true, '风会先告诉他：敌意感知');
});

test('mergeAbilityEffects：加和与相乘', () => {
  const merged = mergeAbilityEffects([
    { id: 'a', pathway: 'warrior', seq: 8, name: 'x', effect: { maxHpBonus: 10, exploreDangerMultiplier: 0.8 } },
    { id: 'b', pathway: 'warrior', seq: 7, name: 'y', effect: { maxHpBonus: 5, exploreDangerMultiplier: 0.5 } },
  ]);
  assert.equal(merged.maxHpBonus, 15);
  assert.ok(Math.abs((merged.exploreDangerMultiplier ?? 0) - 0.4) < 1e-9);
  assert.deepEqual(mergeAbilityEffects([]), {});
});

test('能力上限进 apply：HP 在 110 截断，默认仍是 100', () => {
  const caps = capsFromAbilityEffects({ maxHpBonus: 10 });
  const withCaps = applyWithCaps(makeState({ hp: 105 }), [{ type: 'hp', value: 20 }], '测试', 0, 's', caps);
  assert.equal(withCaps.newState.hp, 110);
  const without = apply(makeState({ hp: 105 }), [{ type: 'hp', value: 20 }], '测试', 0, 's');
  assert.equal(without.newState.hp, 100);
});

test('能力查表：未解锁时无效果，写下 flag 后生效', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new AbilityRepo(db);
  repo.seed(abilities);
  assert.deepEqual(repo.effectsOf('char-1', 'warrior'), {});

  db.prepare('INSERT INTO users (id, qq_id, nickname, status, created_at) VALUES (?,?,?,?,?)').run(
    'u1',
    'u1',
    '正义',
    'active',
    0,
  );
  // M2.85：列清单里的 ap（值 5）随行动值一并删除
  db.prepare('INSERT INTO characters (id, user_id, name, pathway, sequence, hp, mp, mad, cor, dig, dp, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('char-1', 'u1', '正义', 'warrior', 8, 100, 100, 0, 0, 0, 0, 'active', 0, 0);
  db.prepare('INSERT INTO flags (character_id, flag, value, created_at) VALUES (?,?,?,?)').run(
    'char-1',
    abilityFlag('warrior', 8),
    null,
    0,
  );

  const effects = repo.effectsOf('char-1', 'warrior');
  assert.equal(effects.maxHpBonus, 10);
  assert.equal(repo.unlockedFor('char-1', 'warrior').length, 1);
  assert.equal(repo.unlockedFor('char-1', 'seer').length, 0, '别的途径的能力不会串味');
  db.close();
});

test('不眠者序列 8：探索危险触发概率降 20%', () => {
  const base = NUMERIC.explore.dangerTriggerBase * darkCellar.danger;
  const input = {
    state: makeState({ pathway: 'sleepless' as const, sequence: 8 }),
    location: darkCellar,
    seed: 's',
    todayCount: 0,
  };
  // 抽样落在 (0.8×base, base) 之间：无能力必触发，有能力不触发
  const roll = base * 0.9;
  const withoutAbility = resolveExplore({ ...input, rng: scriptedRng([0.1, 0.5, 0.5, 0.9, roll, 0.5]) });
  const withAbility = resolveExplore({
    ...input,
    rng: scriptedRng([0.1, 0.5, 0.5, 0.9, roll, 0.5]),
    dangerMultiplier: 0.8,
  });
  assert.equal(withoutAbility.ok && withoutAbility.danger.triggered, true);
  assert.equal(withAbility.ok && withAbility.danger.triggered, false);
});

test('能力效果真的进了指令链路：战士的 HP 上限在 .休息 里生效', async () => {
  const h = createHarness();
  const character = await h.createCharacter('20001', '正义', 'warrior');
  h.repos.flags.set(character.id, abilityFlag('warrior', 8), h.now());
  h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, hp: 100, updatedAt: h.now() });
  h.advance(11_000);
  await h.send({ rawText: '.休息', userId: '20001' });
  assert.equal(h.repos.characters.findById(character.id)!.hp, 110);
  h.app.close();
});
