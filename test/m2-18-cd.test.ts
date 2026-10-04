/**
 * M2.18 任务 C/D：势力关系的战斗修正 + 敌对拒绝 + 换字段。
 *
 * 三段：
 *   §A 三层透传（types → resolve → pvp）：**默认行为逐位不变** + 加成真的生效
 *   §B 敌对拒绝（交易 / 组队）—— 真指令
 *   §C 换字段（god_of_war_2_first_strike）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { resolveBattleRound, type BattleState } from '../src/domain/battle/index.ts';
import type { Rng } from '../src/domain/character/types.ts';
import { createHarness, DEFAULT_USER } from './helpers/app.ts';

const content = loadContent();

/** 永远掷一个固定值（把命中/伤害钉死，好让「只差一个 relation」可比） */
function fixed(value: number): Rng {
  return { next: () => value };
}

/* 与 test/m2-13.test.ts 的 makeBattle 同形（那份是文件私有的，这里复制一份最小的） */
function makeBattle(characterId: string, patch: Partial<BattleState> = {}): BattleState {
  return {
    id: 'b-test',
    characterId,
    creatureId: 'bone_choir-1',
    speciesId: 'bone_choir',
    speciesName: '骨唱诗班',
    creatureSequence: 9,
    creatureDying: false,
    world: {
      locationId: 'old_dock',
      locationName: '老码头',
      night: false,
      danger: 2,
      weatherHitPenalty: 0,
      weatherLabel: '晴',
    },
    round: 1,
    status: 'active',
    playerHp: 100,
    playerMp: 60,
    playerStatuses: [],
    playerDefensePenalty: 0,
    creatureHp: 500,
    creatureMaxHp: 500,
    creatureStatuses: [],
    creatureBerserk: false,
    creatureEvolved: false,
    creatureShield: false,
    allyCalled: false,
    allyArrivesAtRound: null,
    allyCount: 0,
    creaturePlayingDead: false,
    negateCreatureActions: 0,
    negatePlayerActions: 0,
    isPvp: false,
    opponentCharacterId: null,
    opponentName: null,
    turnOf: 'challenger',
    pendingAction: null,
    foresight: null,
    lastPlayerDamage: 0,
    startedAt: 0,
    lastRoundAt: 0,
    resolvedAt: null,
    ...patch,
  };
}

async function makeFighter(): Promise<{ h: Awaited<ReturnType<typeof createHarness>>; id: string }> {
  const h = createHarness({ deterministicIds: true });
  const created = await h.createCharacter(DEFAULT_USER, '克莱恩', 'warrior');
  return { h, id: created.id };
}

/* ==================== §A 三层透传 ==================== */

test('M2.18-CD-A1：**不传 relation 与传全零，判定结果逐位相同**（默认行为不变）', async () => {
  const { h, id } = await makeFighter();
  const character = h.repos.characters.findById(id)!;
  const battle = makeBattle(id);
  /*
   * 随机源取 0.1（**偏小**）：命中判定是 `roll < 命中率`，掷大了会「挥空」，
   * 那测的就不是 relation 而是运气了。伤害那边同样是 0.1 —— 落在 rollRange 的下沿，
   * 一个固定值让三次调用**完全可比**。
   */
  const plain = resolveBattleRound(character, battle, { kind: 'attack' }, fixed(0.1));
  const zeroed = resolveBattleRound(
    character,
    battle,
    { kind: 'attack' },
    fixed(0.1),
    { relation: { hit: 0, damage: 0 } },
  );
  assert.equal(zeroed.playerDamageDealt, plain.playerDamageDealt, '伤害逐位相同');
  assert.equal(zeroed.creatureHp, plain.creatureHp, '生物血量逐位相同');
  assert.deepEqual(zeroed.rolls, plain.rolls, '掷点序列逐位相同');
  h.app.close();
});

test('M2.18-CD-A2：敌对惩罚与同教会协同**真的改变伤害**（方向对）', async () => {
  const { h, id } = await makeFighter();
  const character = h.repos.characters.findById(id)!;
  const battle = makeBattle(id);
  const plain = resolveBattleRound(character, battle, { kind: 'attack' }, fixed(0.1));
  const hostile = resolveBattleRound(character, battle, { kind: 'attack' }, fixed(0.1), {
    relation: { hit: NUMERIC.church.conflict.hostilePenalty.hit, damage: NUMERIC.church.conflict.hostilePenalty.damage },
  });
  const same = resolveBattleRound(character, battle, { kind: 'attack' }, fixed(0.1), {
    relation: { hit: NUMERIC.church.conflict.sameChurchBonus.hit, damage: NUMERIC.church.conflict.sameChurchBonus.damage },
  });
  assert.ok(hostile.playerDamageDealt < plain.playerDamageDealt, '敌对：伤害更低');
  assert.ok(same.playerDamageDealt > plain.playerDamageDealt, '同教会：伤害更高');
  h.app.close();
});

/* ==================== §B 敌对拒绝 ==================== */

test('M2.18-CD-B1：敌对教会之间**不能交易**，且回执说明原因', async () => {
  const h = createHarness({ deterministicIds: true });
  const a = await h.createCharacter(DEFAULT_USER, '甲', 'sleepless');
  const b = await h.createCharacter('700001', '乙', 'warrior');
  for (const [created, city] of [[a, 'backlund'], [b, 'backlund']] as const) {
    const state = h.repos.characters.findById(created.id)!;
    h.repos.characters.update({ ...state, currentCityId: city, updatedAt: h.now() });
  }
  await h.send({ rawText: '.加入教会 night_goddess', scene: 'private', userId: DEFAULT_USER });
  await h.send({ rawText: '.加入教会 god_of_war', scene: 'private', userId: '700001' });
  const replies = await h.send({ rawText: '.交易 @700001 夜香草 1 10', scene: 'private', userId: DEFAULT_USER });
  const text = replies.map((m) => m.text).join('\n');
  assert.match(text, /不共戴天/, '回执要说清是教义原因：' + text.slice(0, 120));
  h.app.close();
});

/* ==================== §C 换字段 ==================== */

test('M2.18-CD-C1：god_of_war_2_first_strike 同 id、语义已变（先手 → 硬骨头）', () => {
  const ability = content.churchAbilities.find((entry) => entry.id === 'god_of_war_2_first_strike');
  assert.ok(ability, 'id 必须保留（M2.17 的 domain_events 引用它）');
  assert.equal(ability.name, '硬骨头');
  assert.equal(ability.effect.maxHpBonus, 5, 'effect 换成有读者的 maxHpBonus');
  assert.equal(ability.effect.initiativeBonus, undefined, '不再是先攻');
});
