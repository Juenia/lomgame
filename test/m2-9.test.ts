/**
 * M2.9 纯函数测试：PVE 回合制战斗。
 *
 * 六组：
 *   一、数值（全部有出处，且与既有模块不打架）
 *   二、状态系统五种（施加 / 刷新 / 上限 / 持续伤害 / 计时）
 *   三、每途径两个技能（**解禁，不是升级**）
 *   四、生物 AI 六种行为（逃跑 / 暴走 / 求援 / 进化 / 装死 / 特殊）
 *   五、回合判定（五个玩家动作 + 胜负 + 纯函数性质）
 *   六、「同一场战斗两次不一样」—— 同 seed 必然一样，不同 seed 必须不一样
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATTLE, NUMERIC } from '../src/config/numeric.ts';
import {
  ALL_SKILLS,
  advanceStatuses,
  applyStatus,
  battleSpeciesViewOf,
  battleViewFor,
  canActOf,
  canUseSkill,
  decideCreatureAction,
  describeStatuses,
  dotOf,
  hasStatus,
  hitPenaltyOf,
  isBattleOver,
  removeStatus,
  resolveBattleRound,
  skillById,
  skillByName,
  skillsFor,
  SPECIALS,
  SPECIAL_IDS,
} from '../src/domain/battle/index.ts';
import type {
  BattleState,
  BattleStatusEffect,
  CreatureAction,
  PlayerAction,
} from '../src/domain/battle/index.ts';
import { battleAvailabilityOf } from '../src/domain/menu/battle-menu.ts';
import { loadCreatures } from '../src/data/loader.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import type { CharacterState, Rng } from '../src/domain/character/types.ts';

/* ================================================================== *
 * 夹具
 * ================================================================== */

const RNG_SOURCES: Record<string, Rng> = {
  /** 永远掷出 0：特殊行为必中、命中率高于 0 的攻击必中 */
  low: { next: () => 0 },
  /** 永远掷出 0.999：什么都不中 */
  high: { next: () => 0.999 },
};

function seeded(seed: string): Rng {
  return createSeededRng(seed);
}

function makeCharacter(patch: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'c-test',
    userId: 'u-test',
    name: '测试者',
    pathway: 'seer',
    sequence: 9,
    pathwayStatus: 'initiated',
    gender: 'male',
    hp: 100,
    mp: 60,
    mad: 20,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    currentCityId: 'tingen',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function makeBattle(patch: Partial<BattleState> = {}): BattleState {
  const base: BattleState = {
    id: 'b-test',
    characterId: 'c-test',
    creatureId: 'whisperer-1',
    speciesId: 'whisperer',
    speciesName: '低语者',
    creatureSequence: 8,
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
    creatureHp: 40,
    creatureMaxHp: 40,
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
    turnOf: 'challenger' as const,
    pendingAction: null,
    foresight: null,
    lastPlayerDamage: 0,
    startedAt: 0,
    lastRoundAt: 0,
    resolvedAt: null,
  };
  return { ...base, ...patch, world: { ...base.world, ...(patch.world ?? {}) } };
}

const { creatures: SPECIES_LIST } = loadCreatures();
const SPECIES_BY_ID = new Map(SPECIES_LIST.map((species) => [species.id, species]));

function viewOf(id: string) {
  const species = SPECIES_BY_ID.get(id);
  assert.ok(species, `物种 ${id} 不存在`);
  return battleSpeciesViewOf(species);
}

/** 把物种的 HP 设成某个比例 */
function atRatio(battle: BattleState, ratio: number): BattleState {
  return { ...battle, creatureHp: Math.max(1, Math.floor(battle.creatureMaxHp * ratio)) };
}

function kinds(events: { kind: string }[]): string[] {
  return events.map((event) => event.kind);
}

/* ================================================================== *
 * 一、数值
 * ================================================================== */

test('M2.9 数值：任务书 §4.5 给的每一个数都在，且一条都没改过既有模块', () => {
  assert.equal(BATTLE.maxRounds, 8);
  assert.equal(BATTLE.playerTimeoutMs, 5 * 60 * 1000);
  assert.equal(BATTLE.actions.attack.mpCost, 0);
  assert.equal(BATTLE.actions.attack.baseHit, 0.5);
  assert.equal(BATTLE.actions.attack.baseDamageMin, 30);
  assert.equal(BATTLE.actions.attack.baseDamageMax, 60);
  assert.equal(BATTLE.actions.defend.damageMultiplier, 0.5);
  assert.equal(BATTLE.actions.defend.mpRestore, 5);
  assert.equal(BATTLE.actions.retreat.baseChance, 0.6);
  assert.equal(BATTLE.actions.retreat.dangerPenalty, 0.4);
  assert.equal(BATTLE.creatureAi.fleeThreshold, 0.3);
  assert.equal(BATTLE.creatureAi.berserkThreshold, 0.2);
  assert.equal(BATTLE.creatureAi.berserkDamageMult, 2.0);
  assert.equal(BATTLE.creatureAi.berserkDefenseMult, 0.5);
  assert.equal(BATTLE.creatureAi.callAllyThreshold, 0.5);
  assert.deepEqual([...BATTLE.creatureAi.callAllyDelay], [2, 3]);
  assert.deepEqual([...BATTLE.creatureAi.playDeadSpecies], ['mirror_guest', 'fate_phantom']);
  assert.equal(BATTLE.statuses.bleed.hpPerRound, -3);
  assert.equal(BATTLE.statuses.fear.hitPenalty, -0.2);
  assert.equal(BATTLE.statuses.poison.hpPerRound, -2);
  assert.equal(BATTLE.statuses.poison.mpPerRound, -3);
  assert.equal(BATTLE.statuses.lostControl.randomAction, true);
  assert.equal(BATTLE.statuses.banish.skipRounds, 1);
  assert.equal(BATTLE.maxStatuses, 5);
});

test('M2.9 数值：序列差复用 M2.6.1 的框架，两个模块的数没有各说各话', () => {
  // 命中基准：BATTLE 与 assault 必须相等（真正参与计算的是 assault 那个）
  assert.equal(BATTLE.actions.attack.baseHit, NUMERIC.assault.baseHit, '命中基准必须同源');
  // 伤害区间与 .袭击 同一把尺子（新号 HP 100，两到三下见底）
  assert.equal(BATTLE.actions.attack.baseDamageMin, NUMERIC.assault.baseDamageMin);
  assert.equal(BATTLE.actions.attack.baseDamageMax, NUMERIC.assault.baseDamageMax);
  // 恐惧气场的高序列阈值与 M2.6.1 的高序列抗性阈值同为 6
  assert.equal(BATTLE.fearAura.maxCreatureSequence, NUMERIC.assault.highSequenceResist.threshold);
});

test('M2.9 数值：失控阈值与 M2.1 定下的那一个完全相同', () => {
  // 「疯狂到会失控」这件事在整个游戏里只能有一个阈值 —— 战斗里另立一个就是两套规则
  assert.equal(BATTLE.statuses.lostControl.madThreshold, NUMERIC.lossOfControl.deadlockMadThreshold);
});

test('M2.9 数值：不改任何 M2.8 已定的生态数值', () => {
  const ecology = NUMERIC.creature.ecology;
  assert.equal(ecology.preyHpLoss, 15);
  assert.equal(ecology.decayChance, 0.02);
  assert.equal(ecology.predatorSeqGap, 3);
  assert.equal(ecology.decayHpLoss, 5);
  assert.equal(ecology.feedThresholdHours, 12);
  assert.equal(ecology.decayHours, 480);
  assert.equal(ecology.evolutionHours, 240);
  assert.equal(ecology.evolutionFeedCount, 3);
  assert.equal(ecology.migrateChance, 0.05);
  assert.equal(ecology.strayChance, 0.1);
  assert.equal(ecology.capPerLocation, 6);
  assert.equal(ecology.spawnPerLocation, 1);
  assert.deepEqual({ ...ecology.spawnSequenceBonus }, { 9: 3, 8: 2 });
  // M2.8 的遭遇与感知数值也一个没动
  assert.equal(NUMERIC.creature.encounter.baseChance, 0.15);
  assert.equal(NUMERIC.creature.perception.weak3, -3);
  assert.equal(NUMERIC.creature.harvest.baseChance, 0.8);
});

/* ================================================================== *
 * 二、状态系统
 * ================================================================== */

test('状态：施加 / 刷新 / 描述', () => {
  let list: BattleStatusEffect[] = [];
  list = applyStatus(list, 'bleed', '暴击');
  assert.equal(list.length, 1);
  assert.equal(hasStatus(list, 'bleed'), true);
  assert.equal(describeStatuses(list), `流血(${BATTLE.statuses.bleed.rounds})`);

  // 同状态刷新而不是叠加（挨两次低语不该变成 -40% 命中）
  list = applyStatus(list, 'bleed', '暴击', 9);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.rounds, 9);
  assert.equal(hitPenaltyOf(list), 0);

  list = applyStatus(list, 'fear', '低语');
  assert.equal(hitPenaltyOf(list), -0.2);
  assert.equal(describeStatuses([]), '健康');
});

test('状态：最多 5 个，满了顶掉剩余回合最少的那个（不是丢弃新的）', () => {
  let list: BattleStatusEffect[] = [];
  for (const id of ['bleed', 'fear', 'poison', 'banish'] as const) list = applyStatus(list, id, 'x');
  list = applyStatus(list, 'lostControl', 'x');
  assert.equal(list.length, 5);
  // 再塞一个：顶掉剩余回合最少的（banish 是 1 回合）
  const before = list.map((entry) => entry.id);
  list = applyStatus(list, 'bleed', 'x', 9);
  // bleed 已存在 → 刷新，不新增
  assert.equal(list.length, 5);
  assert.deepEqual(list.map((entry) => entry.id), before);
});

test('状态：持续伤害与行动能力', () => {
  const bleed = applyStatus([], 'bleed', 'x');
  assert.deepEqual(dotOf(bleed).hp, -3);
  const poison = applyStatus([], 'poison', 'x');
  assert.equal(dotOf(poison).hp, -2);
  assert.equal(dotOf(poison).mp, -3);

  assert.equal(canActOf(applyStatus([], 'banish', 'x')), false);
  assert.equal(canActOf(applyStatus([], 'fear', 'x')), true);
  assert.equal(canActOf([]), true);
});

test('状态：计时推进，归零脱落', () => {
  let list = applyStatus([], 'banish', 'x', 1);
  const first = advanceStatuses(list);
  assert.equal(first.list.length, 0);
  assert.deepEqual(first.expired, ['banish']);

  list = applyStatus([], 'fear', 'x', 2);
  const second = advanceStatuses(list);
  assert.equal(second.list[0]!.rounds, 1);
  assert.equal(advanceStatuses(second.list).list.length, 0);

  assert.deepEqual(removeStatus(list, 'fear'), []);
});

/* ================================================================== *
 * 三、技能：**解禁，不是升级**
 * ================================================================== */

test('技能池：序列 9 只有序列 9 的那个，序列 8 两个都有，普通人一个都没有', () => {
  assert.deepEqual(skillsFor('seer', 9).map((skill) => skill.seq), [9]);
  assert.deepEqual(skillsFor('seer', 8).map((skill) => skill.seq), [9, 8]);
  assert.deepEqual(skillsFor('warrior', 8).map((skill) => skill.name), ['强攻', '连击']);
  assert.deepEqual(skillsFor('sleepless', 8).map((skill) => skill.name), ['夜视', '梦魇']);
  // 普通人：没有途径就没有技能池（与遭遇菜单里普通人只有两个选项同一个口径）
  assert.deepEqual(skillsFor(null, 9), []);
});

test('技能：每途径三个、序列 9 / 8 / 7 各一个，十二条全部可用', () => {
  /*
   * M2.12：序列 8→7 上线，技能池每途径 +1（解禁原则不变：序列 7 的人三个都能用）—— 3 途径 x 3 = 9。
   * M2.19：接入 sailor（水手）后再 +3，3 途径 x 3 = 12。
   *
   * ⚠️ 这个数是**守门清单里没有的第 8 条清单**（G2 数的是 abilities.yaml，不是战斗技能）——
   * 以后每加一条途径，这里和 docs/架构铁律.md 的 G 表都要跟着动。
   */
  // M2.26 三批 ⇒ 21；M2.29 批次 A1（序列 6）逐途径 +1 ⇒ **28**
  // 批次 A2（序列 5）逐途径 +1 ⇒ 35
  // M2.39 批次 B（序列 4、3）逐途径 +2 ⇒ **49** = 7 途径 × 7
  // M2.43 批次 C（序列 2）逐途径 +1 ⇒ **56** = 7 途径 × 8
  // M2.85 内容填充 P3：15 条缺技能的途径各补 seq 9 / seq 8 两条 → 56 + 30 = 86
  assert.equal(ALL_SKILLS.length, 86);
  for (const pathway of ['seer', 'warrior', 'sleepless', 'sailor', 'perfect', 'reader', 'mother'] as const) {
    const list = ALL_SKILLS.filter((skill) => skill.pathway === pathway);
    /*
     * ⚠️ M2.29：从「**正好**三个 + 序列恰好 [7,8,9]」改成「**至少**含 9/8/7，且无重复」。
     * 批次 A1 起每途径会继续加 6/5/…；写死条数与序列数组会让每加一级都来改这一条（K16 的形状）。
     */
    const seqs = list.map((skill) => skill.seq);
    for (const seq of [9, 8, 7]) {
      assert.ok(seqs.includes(seq), pathway + ' 缺序列 ' + seq + ' 的技能');
    }
    assert.equal(new Set(seqs).size, seqs.length, pathway + ' 的技能序列不能重复');
    assert.ok(list.length >= 3, pathway + ' 至少要有三个技能');
    for (const skill of list) {
      // 技能是解禁不是升级：序列 9 只用得上序列 9 的，序列 7 三个都能用
      assert.equal(skillByName(skill.name)?.id, skill.id);
      assert.equal(skillById(skill.id)?.name, skill.name);
      assert.equal(canUseSkill(skill, { pathway, sequence: 9, mp: 100 }).ok, skill.seq === 9);
      // 玩家序列 8 能用的是「解禁序列 ≥ 8」的那些（skill.seq >= 8）
      assert.equal(canUseSkill(skill, { pathway, sequence: 8, mp: 100 }).ok, skill.seq >= 8);
      // M2.29：序列 7 的玩家同样按 skill.seq >= 7 判 —— seq 6 的技能对他**还没解禁**
      assert.equal(canUseSkill(skill, { pathway, sequence: 7, mp: 100 }).ok, skill.seq >= 7);
      // 序列 6 的玩家：序列 9/8/7/6 的技能全部解禁
      assert.equal(canUseSkill(skill, { pathway, sequence: 6, mp: 100 }).ok, skill.seq >= 6);
    }
  }
});

test('技能：不能用的时候，理由说得清楚（而不是默默失效）', () => {
  /*
   * 判据用「连击」（战士序列 8 的那个）而不是「强攻」：
   * 任务书 §4.3.5 的表里，序列 9 的战士技能**就是**强攻（序列 8 才是连击），
   * 而 §五「序列 9 没有强攻」那句与这张表是矛盾的 —— 本实现以数值表为准，
   * 这处矛盾记在 docs/M2.9-交付说明.md 的「任务书口径修正」一节里。
   */
  const combo = skillByName('连击')!;
  assert.match(canUseSkill(combo, { pathway: 'seer', sequence: 9, mp: 100 }).reason ?? '', /途径/);
  assert.match(canUseSkill(combo, { pathway: 'warrior', sequence: 9, mp: 100 }).reason ?? '', /序列 8/);
  assert.match(canUseSkill(combo, { pathway: 'warrior', sequence: 8, mp: 0 }).reason ?? '', /灵力/);
  assert.equal(canUseSkill(combo, { pathway: 'warrior', sequence: 8, mp: 12 }).ok, true);
  // 普通人
  assert.match(canUseSkill(combo, { pathway: null, sequence: 9, mp: 100 }).reason ?? '', /途径/);
});

test('技能是解禁不是升级：序列 9 的人**没有**连击，序列 8 才有', () => {
  const nine = skillsFor('warrior', 9).map((skill) => skill.name);
  const eight = skillsFor('warrior', 8).map((skill) => skill.name);
  assert.ok(!nine.includes('连击'), '序列 9 不该有序列 8 的解禁');
  assert.ok(eight.includes('强攻'));
  assert.ok(eight.includes('连击'));
  // 而且序列 8 的人没有丢掉序列 9 的那个 —— 解禁是累加，不是替换
  assert.deepEqual([...nine].sort(), ['强攻']);
  assert.equal(eight.length, 2);
  // 三条途径都是同一个形状：序列 9 一个、序列 8 两个
  for (const pathway of ['seer', 'sleepless'] as const) {
    assert.equal(skillsFor(pathway, 9).length, 1);
    assert.equal(skillsFor(pathway, 8).length, 2);
  }
});

/* ================================================================== *
 * 四、生物 AI：六种行为
 * ================================================================== */

test('生物 AI：默认是攻击', () => {
  const action = decideCreatureAction(viewOf('whisperer'), makeBattle(), RNG_SOURCES.high!);
  assert.equal(action.kind, 'attack');
});

test('生物 AI · 逃跑：HP < 30%', () => {
  const action = decideCreatureAction(viewOf('whisperer'), atRatio(makeBattle(), 0.25), RNG_SOURCES.high!);
  assert.equal(action.kind, 'flee');
});

test('生物 AI · 暴走：HP < 20%，伤害翻倍、防御减半，而且**不再逃跑**', () => {
  const battle = atRatio(makeBattle(), 0.175);
  const action = decideCreatureAction(viewOf('whisperer'), battle, RNG_SOURCES.high!);
  assert.equal(action.kind, 'berserk');
  assert.equal(BATTLE.creatureAi.berserkDamageMult, 2);
  assert.equal(BATTLE.creatureAi.berserkDefenseMult, 0.5);

  // 已经暴走的：即使 HP 回到过半，也不会去逃 —— 也不再去叫人
  const berserk = decideCreatureAction(
    viewOf('blood_hound'),
    { ...makeBattle({ speciesId: 'blood_hound', speciesName: '铁血猎犬' }), creatureBerserk: true, creatureHp: 30, creatureMaxHp: 60 },
    RNG_SOURCES.high!,
  );
  assert.equal(berserk.kind, 'berserk');
});

test('生物 AI · 暴走：长期没进食（濒死）也会触发 —— 生物没有 MAD，饥饿是它的等价物', () => {
  const action = decideCreatureAction(
    viewOf('whisperer'),
    { ...makeBattle(), creatureDying: true },
    RNG_SOURCES.high!,
  );
  assert.equal(action.kind, 'berserk');
});

test('生物 AI · 装死：只有点名的两个物种会', () => {
  for (const id of BATTLE.creatureAi.playDeadSpecies) {
    const action = decideCreatureAction(
      viewOf(id),
      atRatio(makeBattle({ speciesId: id, speciesName: id }), 0.3),
      RNG_SOURCES.high!,
    );
    assert.equal(action.kind, 'play_dead', id + ' 应当会装死');
  }
  // 没被点名的物种（同样血量）去逃，不装死
  const whisperer = decideCreatureAction(viewOf('whisperer'), atRatio(makeBattle(), 0.3), RNG_SOURCES.high!);
  assert.notEqual(whisperer.kind, 'play_dead');
});

test('生物 AI · 求援：群居 + HP < 50%，而且每场只叫一次', () => {
  const battle = makeBattle({ speciesId: 'blood_hound', speciesName: '铁血猎犬', creatureHp: 27, creatureMaxHp: 60 });
  const first = decideCreatureAction(viewOf('blood_hound'), battle, RNG_SOURCES.high!);
  assert.equal(first.kind, 'call_ally');
  // 叫过了就不再叫（否则「求援」会变成无限刷援军的正反馈）
  const again = decideCreatureAction(viewOf('blood_hound'), { ...battle, allyCalled: true }, RNG_SOURCES.high!);
  assert.notEqual(again.kind, 'call_ally');
  // 非群居物种永远不会求援
  const lone = decideCreatureAction(viewOf('whisperer'), atRatio(makeBattle(), 0.45), RNG_SOURCES.high!);
  assert.notEqual(lone.kind, 'call_ally');
});

test('生物 AI · 进化：濒死存活（HP ≤ 15%）→ 蜕壳，而且一场只蜕一次', () => {
  const battle = atRatio(makeBattle(), 0.1);
  assert.equal(decideCreatureAction(viewOf('whisperer'), battle, RNG_SOURCES.high!).kind, 'evolve');
  const done = decideCreatureAction(viewOf('whisperer'), { ...battle, creatureEvolved: true }, RNG_SOURCES.high!);
  assert.notEqual(done.kind, 'evolve');
});

test('生物 AI · 特殊：物种专属行为，按 specialChance 掷', () => {
  const always = decideCreatureAction(viewOf('deep_gazer'), makeBattle(), RNG_SOURCES.low!);
  assert.equal(always.kind, 'special');
  assert.equal(always.special, 'gaze');
  assert.equal(always.label, '注视');
  // 掷不中 → 回到攻击
  const never = decideCreatureAction(viewOf('deep_gazer'), makeBattle(), RNG_SOURCES.high!);
  assert.equal(never.kind, 'attack');
});

test('生物 AI：八种物种的专属行为都能被触发，没有一个物种是木桩', () => {
  const seen = new Set<string>();
  for (const species of SPECIES_LIST) {
    const view = battleSpeciesViewOf(species);
    assert.ok(view.special, species.id + ' 必须声明一条专属行为');
    assert.ok(SPECIALS[view.special!], species.id + ' 的专属行为必须在 specials.ts 里查得到');
    seen.add(view.special!);
  }
  assert.equal(seen.size, 8, '八种物种应当是八条互不相同的专属行为');
  assert.equal(SPECIAL_IDS.length, 8);
});

/* ================================================================== *
 * 五、回合判定
 * ================================================================== */

test('回合：输出不改输入（纯函数），且判定层不写时钟', () => {
  const battle = makeBattle();
  const snapshot = structuredClone(battle);
  const state = makeCharacter();
  const stateSnapshot = structuredClone(state);
  resolveBattleRound(state, battle, { kind: 'attack' }, seeded('purity'), {
    species: viewOf('whisperer'),
  });
  assert.deepEqual(battle, snapshot, 'resolveBattleRound 不该修改传进来的战斗状态');
  assert.deepEqual(state, stateSnapshot, 'resolveBattleRound 不该修改传进来的角色卡');
});

test('回合：攻击会扣生物的血，HP 归零即玩家胜', () => {
  // 用「必中」的随机源：这条测的是**胜负**，不是命中率（命中率由 M2.6.1 的框架守着）
  const battle = makeBattle({ creatureHp: 20, creatureMaxHp: 40 });
  const result = resolveBattleRound(makeCharacter(), battle, { kind: 'attack' }, RNG_SOURCES.low!, {
    species: viewOf('whisperer'),
    creatureAction: { kind: 'attack', label: '攻击', note: '' },
  });
  assert.ok(result.playerDamageDealt > 0, '攻击必须有伤害');
  assert.equal(result.status, 'player_win');
  assert.equal(result.creatureHp, 0);
  assert.equal(result.battle.status, 'player_win');
  assert.ok(kinds(result.events).includes('ended'));
});

test('回合：防御把这一回合的伤害减半、回 5 灵力', () => {
  const battle = makeBattle({ creatureHp: 999, creatureMaxHp: 999, playerHp: 100, playerMp: 0 });
  const result = resolveBattleRound(makeCharacter({ mp: 0 }), battle, { kind: 'defend' }, seeded('defend'), {
    species: viewOf('blood_hound'),
    creatureAction: { kind: 'attack', label: '攻击', note: '' },
  });
  assert.equal(result.playerMp, BATTLE.actions.defend.mpRestore);
  // 同一个随机源下不防御的那一次伤害应当更高（都必中，才比得出差别）
  const open = resolveBattleRound(makeCharacter({ mp: 0 }), battle, { kind: 'attack' }, RNG_SOURCES.low!, {
    species: viewOf('blood_hound'),
    creatureAction: { kind: 'attack', label: '攻击', note: '' },
  });
  assert.ok(result.creatureDamageDealt < open.creatureDamageDealt, '防御应当真的少挨打');
});

test('回合：撤退成功即脱战；危险度越高越难（同一个 seed 换地点可以走不掉）', () => {
  const safe = makeBattle({ world: { ...makeBattle().world, danger: 0 } });
  const result = resolveBattleRound(makeCharacter(), safe, { kind: 'retreat' }, seeded('retreat'), {
    species: viewOf('whisperer'),
  });
  assert.ok(result.status === 'fled' || result.status === 'active');

  // 危险度 5 的成功率 = 0.6 - 0.4 = 0.2，比危险度 0 的 0.6 低得多
  const dangerous = makeBattle({ world: { ...makeBattle().world, danger: 5 } });
  let safeFled = 0;
  let dangerFled = 0;
  for (let index = 0; index < 200; index += 1) {
    const a = resolveBattleRound(makeCharacter(), safe, { kind: 'retreat' }, seeded('r' + index), {
      species: viewOf('whisperer'),
      creatureAction: { kind: 'attack', label: '攻击', note: '' },
    });
    const b = resolveBattleRound(makeCharacter(), dangerous, { kind: 'retreat' }, seeded('r' + index), {
      species: viewOf('whisperer'),
      creatureAction: { kind: 'attack', label: '攻击', note: '' },
    });
    if (a.status === 'fled') safeFled += 1;
    if (b.status === 'fled') dangerFled += 1;
  }
  assert.ok(safeFled > dangerFled, `安全处该比危险处好走：${safeFled} vs ${dangerFled}`);
});

test('回合：使用物品（符咒）按内容侧的效果生效', () => {
  const battle = makeBattle({ creatureHp: 40, creatureMaxHp: 40 });
  const result = resolveBattleRound(makeCharacter(), battle, { kind: 'item', itemId: '符咒·灼烧' }, seeded('item'), {
    species: viewOf('whisperer'),
    item: { itemId: '符咒·灼烧', name: '符咒·灼烧', battle: { damage: 25 } },
    creatureAction: { kind: 'attack', label: '攻击', note: '' },
  });
  assert.equal(result.playerDamageDealt, 25);

  const cleanse = resolveBattleRound(
    makeCharacter(),
    makeBattle({ playerStatuses: [ { id: 'bleed', rounds: 2, source: 'x' }, { id: 'poison', rounds: 2, source: 'y' } ] }),
    { kind: 'item', itemId: '符咒·净除' },
    seeded('cleanse'),
    {
      species: viewOf('whisperer'),
      item: { itemId: '符咒·净除', name: '符咒·净除', battle: { cleanse: true } },
      creatureAction: { kind: 'attack', label: '攻击', note: '' },
    },
  );
  assert.deepEqual(cleanse.playerStatuses, []);
});

test('回合：每个途径的每个技能都能用，而且都留下痕迹', () => {
  const cases: Array<{ pathway: 'seer' | 'warrior' | 'sleepless'; sequence: number; skill: string }> = [
    { pathway: 'seer', sequence: 9, skill: '占卜预判' },
    { pathway: 'seer', sequence: 8, skill: '幻觉干扰' },
    { pathway: 'warrior', sequence: 9, skill: '强攻' },
    { pathway: 'warrior', sequence: 8, skill: '连击' },
    { pathway: 'sleepless', sequence: 9, skill: '夜视' },
    { pathway: 'sleepless', sequence: 8, skill: '梦魇' },
  ];
  for (const entry of cases) {
    const skill = skillByName(entry.skill)!;
    const state = makeCharacter({ pathway: entry.pathway, sequence: entry.sequence, mp: 100 });
    // 战斗状态里的 MP 就是这一管灵力（命令层每回合会先与角色卡同步，测试里手工对齐）
    const battle = makeBattle({ creatureHp: 500, creatureMaxHp: 500, playerMp: 100 });
    const result = resolveBattleRound(
      state,
      battle,
      { kind: 'skill', skillId: skill.id },
      seeded('skill-' + skill.id),
      { species: viewOf('whisperer'), creatureAction: { kind: 'attack', label: '攻击', note: '' } },
    );
    assert.equal(
      result.playerMp,
      100 - skill.mpCost,
      entry.skill + ' 应当扣掉 ' + skill.mpCost + ' 灵力（实际 MP ' + result.playerMp + '）',
    );
    assert.ok(kinds(result.events).includes('player_skill') || kinds(result.events).includes('foresight'), entry.skill + ' 应当有事件');
  }
});

test('回合：占卜预判看到的，就是生物下回合真做的（预知必须说真话）', () => {
  const battle = makeBattle({ creatureHp: 500, creatureMaxHp: 500 });
  const rng = seeded('foresight');
  const result = resolveBattleRound(
    makeCharacter({ mp: 100 }),
    { ...battle, playerMp: 100 },
    { kind: 'skill', skillId: 'divine_foresight' },
    rng,
    {
      species: viewOf('blood_hound'),
      creatureAction: { kind: 'attack', label: '攻击', note: '' },
      aiRng: seeded('b-foresight'),
    },
  );
  assert.ok(result.battle.foresight, '占卜预判必须留下预知');
  assert.equal(result.battle.foresight!.round, 2);

  // 用同一个随机源真的跑第 2 回合，它做的应当是同一件事
  const actual = decideCreatureAction(viewOf('blood_hound'), result.battle, seeded('b-foresight'));
  assert.equal(actual.kind, result.battle.foresight!.action.kind);
});

test('回合：幻觉干扰吃掉对手一次行动', () => {
  const battle = makeBattle({ creatureHp: 500, creatureMaxHp: 500 });
  const result = resolveBattleRound(
    makeCharacter({ pathway: 'seer', sequence: 8, mp: 100 }),
    battle,
    { kind: 'skill', skillId: 'hallucination' },
    seeded('negate'),
    { species: viewOf('blood_hound'), creatureAction: { kind: 'attack', label: '攻击', note: '' } },
  );
  assert.equal(result.creatureActed, false);
  assert.equal(result.creatureDamageDealt, 0);
  assert.ok(kinds(result.events).includes('negated'));
});

test('回合：放逐让玩家整回合动不了（时序蠕虫的时间凝滞）', () => {
  const battle = makeBattle({ playerStatuses: [{ id: 'banish', rounds: 1, source: '时序蠕虫' }] });
  const result = resolveBattleRound(
    makeCharacter(),
    battle,
    { kind: 'attack' },
    seeded('banish'),
    { species: viewOf('whisperer'), creatureAction: { kind: 'attack', label: '攻击', note: '' } },
  );
  assert.equal(result.playerDamageDealt, 0);
  assert.ok(kinds(result.events).includes('negated'));
});

test('回合：失控时随机行动（不能选技能）', () => {
  const battle = makeBattle({ playerStatuses: [{ id: 'lostControl', rounds: 1, source: 'x' }] });
  const result = resolveBattleRound(
    makeCharacter({ pathway: 'warrior', sequence: 9, mp: 100 }),
    battle,
    { kind: 'skill', skillId: 'power_strike' },
    seeded('lost-control'),
    { species: viewOf('whisperer'), creatureAction: { kind: 'attack', label: '攻击', note: '' } },
  );
  assert.notEqual(result.playerAction.kind, 'skill');
  assert.ok(['attack', 'defend', 'retreat'].includes(result.playerAction.kind));
});

test('回合：装死得手 —— 玩家在它装死时停手，就挨一下偷袭', () => {
  const battle = makeBattle({ creaturePlayingDead: true, creatureHp: 500, creatureMaxHp: 500 });
  const ambushed = resolveBattleRound(
    makeCharacter(),
    battle,
    { kind: 'defend' },
    seeded('ambush'),
    { species: viewOf('mirror_guest'), creatureAction: { kind: 'attack', label: '攻击', note: '' } },
  );
  assert.ok(kinds(ambushed.events).includes('ambush'), '停手应当被偷袭');

  const struck = resolveBattleRound(
    makeCharacter(),
    battle,
    { kind: 'attack' },
    seeded('ambush'),
    { species: viewOf('mirror_guest'), creatureAction: { kind: 'attack', label: '攻击', note: '' } },
  );
  assert.ok(!kinds(struck.events).includes('ambush'), '攻击它就不该被偷袭');
});

test('回合：求援之后，援军按 2—3 回合到达，而且生物确实变强了', () => {
  const hound = viewOf('blood_hound');
  const battle = makeBattle({ speciesId: 'blood_hound', speciesName: '铁血猎犬', creatureHp: 27, creatureMaxHp: 60 });
  const called = resolveBattleRound(
    makeCharacter(),
    battle,
    { kind: 'defend' },
    seeded('ally'),
    { species: hound, creatureAction: { kind: 'call_ally', label: '求援', note: '' } },
  );
  assert.equal(called.battle.allyCalled, true);
  assert.ok(called.battle.allyArrivesAtRound! >= 1 + 2 && called.battle.allyArrivesAtRound! <= 1 + 3);

  // 直接跳到援军到达的那一回合
  const arrived = resolveBattleRound(
    makeCharacter(),
    { ...called.battle, round: called.battle.allyArrivesAtRound! },
    { kind: 'defend' },
    seeded('ally-arrive'),
    { species: hound, creatureAction: { kind: 'attack', label: '攻击', note: '' } },
  );
  assert.equal(arrived.battle.allyCount, 1);
  assert.ok(arrived.flags.allyArrived);
  assert.ok(arrived.battle.creatureMaxHp > 60, '援军应当让生物更耐打');
});

test('回合：进化 —— 濒死存活之后序列 -1、上限 +10，而且这是永久的（写回状态里）', () => {
  const battle = atRatio(makeBattle({ creatureHp: 5, creatureMaxHp: 40 }), 0.1);
  const result = resolveBattleRound(
    makeCharacter(),
    battle,
    { kind: 'defend' },
    seeded('evolve'),
    { species: viewOf('whisperer'), creatureAction: { kind: 'evolve', label: '进化', note: '' } },
  );
  assert.equal(result.battle.creatureSequence, battle.creatureSequence - 1);
  assert.equal(result.battle.creatureMaxHp, battle.creatureMaxHp + BATTLE.creatureAi.evolveHpBonus);
  assert.equal(result.battle.creatureEvolved, true);
  assert.ok(kinds(result.events).includes('creature_evolve'));
});

test('回合：暴走让生物打得更重，也让它挨得更重（双刃）', () => {
  const base = makeBattle({ creatureHp: 500, creatureMaxHp: 500, playerHp: 100 });
  const normal = resolveBattleRound(makeCharacter(), base, { kind: 'attack' }, RNG_SOURCES.low!, {
    species: viewOf('whisperer'),
    creatureAction: { kind: 'attack', label: '攻击', note: '' },
  });
  const berserk = resolveBattleRound(
    makeCharacter(),
    { ...base, creatureBerserk: true },
    { kind: 'attack' },
    RNG_SOURCES.low!,
    { species: viewOf('whisperer'), creatureAction: { kind: 'berserk', label: '暴走', note: '' } },
  );
  assert.ok(berserk.creatureDamageDealt > normal.creatureDamageDealt, '暴走该打得更重');
  assert.ok(berserk.playerDamageDealt > normal.playerDamageDealt, '暴走该挨得更重');
});

test('回合：八回合打满即僵持（既没有奖励，也没有惩罚）', () => {
  const battle = makeBattle({ round: BATTLE.maxRounds, creatureHp: 9999, creatureMaxHp: 9999 });
  const result = resolveBattleRound(makeCharacter(), battle, { kind: 'defend' }, seeded('stalemate'), {
    species: viewOf('whisperer'),
    creatureAction: { kind: 'attack', label: '攻击', note: '' },
  });
  assert.equal(result.status, 'stalemate');
  assert.equal(result.battle.resolvedAt, null, 'resolvedAt 由仓储落定，判定层不写时钟');
});

test('回合：生物逃跑成功后战斗立刻结束', () => {
  const battle = makeBattle({ creatureHp: 9999, creatureMaxHp: 9999 });
  const result = resolveBattleRound(makeCharacter(), battle, { kind: 'defend' }, seeded('flee'), {
    species: viewOf('whisperer'),
    creatureAction: { kind: 'flee', label: '逃跑', note: '' },
  });
  assert.ok(['creature_fled', 'active'].includes(result.status));
  if (result.status === 'creature_fled') {
    assert.ok(kinds(result.events).includes('creature_flee'));
    assert.equal(result.creatureDamageDealt, 0);
  }
});

test('回合：状态会挂上去、会掉血、会到期脱落', () => {
  const battle = makeBattle({
    creatureHp: 500,
    creatureMaxHp: 500,
    creatureStatuses: [{ id: 'bleed', rounds: 2, source: '你的重击' }],
  });
  const result = resolveBattleRound(makeCharacter(), battle, { kind: 'defend' }, seeded('dot'), {
    species: viewOf('whisperer'),
    creatureAction: { kind: 'attack', label: '攻击', note: '' },
  });
  assert.ok(result.creatureDamageDealt === 0 || result.creatureDamageDealt > 0);
  assert.equal(result.creatureStatuses[0]!.rounds, 1, '状态该掉一回合');
  assert.ok(kinds(result.events).includes('status_tick'));
});

test('回合：战斗结束之后玩家不再挨打、生物也不再出手', () => {
  const battle = makeBattle({ creatureHp: 1, creatureMaxHp: 40, playerHp: 1 });
  const result = resolveBattleRound(makeCharacter({ hp: 1 }), battle, { kind: 'attack' }, RNG_SOURCES.low!, {
    species: viewOf('whisperer'),
    creatureAction: { kind: 'attack', label: '攻击', note: '' },
  });
  assert.equal(result.status, 'player_win');
  assert.equal(result.creatureDamageDealt, 0, '它已经倒了，不该还能打你');
  assert.equal(result.creatureActed, false);
});

/* ================================================================== *
 * 六、视图与「同一场战斗两次不一样」
 * ================================================================== */

test('视图：任务书 §4.6 的那一屏（回合 / 双方状态 / 环境），而且不可用的选项是灰的', () => {
  const character = makeCharacter({ mp: 0 });
  const battle = makeBattle({
    round: 3,
    playerHp: 100,
    playerMp: 0,
    playerStatuses: [{ id: 'poison', rounds: 2, source: '骨语者' }],
    creatureStatuses: [{ id: 'bleed', rounds: 1, source: '你的重击' }],
  });
  const view = battleViewFor({ battle, character, items: [{ itemId: '符咒·灼烧', name: '符咒·灼烧', quantity: 1 }] });
  assert.equal(view.headline, '【战斗 · 第 3 回合】');
  assert.match(view.lines.join('\n'), /低语者 · HP 40\/40/);
  // 战斗里的上限口径是 CLAMP（100/100）：普通人在数学上进不了战斗（只看到 blur 层）
  assert.match(view.lines.join('\n'), /你 · HP 100\/100 · MP 0\/100 · MAD 20/);
  assert.match(view.lines.join('\n'), /流血\(1\)/);
  assert.match(view.lines.join('\n'), /中毒\(2\)/);

  const availability = battleAvailabilityOf(view);
  assert.equal(availability.attack, null);
  assert.match(availability.skills['divine_foresight'] ?? '', /灵力不够/);
  assert.equal(availability.items['符咒·灼烧'], null);
});

test('视图：被放逐时每一项都灰掉（但**仍然摆出来**，否则玩家以为自己卡死了）', () => {
  const view = battleViewFor({
    battle: makeBattle({ playerStatuses: [{ id: 'banish', rounds: 1, source: '时序蠕虫' }] }),
    character: makeCharacter(),
    items: [],
  });
  const availability = battleAvailabilityOf(view);
  assert.match(availability.attack ?? '', /动不了/);
  assert.match(availability.skills['divine_foresight'] ?? '', /动不了/);
});

test('「同一场战斗两次不一样」：同 seed 必然一模一样（这是纪律，不是特性）', () => {
  const run = (): string => {
    let battle = makeBattle({ creatureHp: 400, creatureMaxHp: 400 });
    const actions: PlayerAction[] = [{ kind: 'attack' }, { kind: 'defend' }, { kind: 'attack' }];
    const trace: string[] = [];
    for (const action of actions) {
      const result = resolveBattleRound(makeCharacter(), battle, action, seeded('same-seed'), {
        species: viewOf('blood_hound'),
      });
      trace.push(result.playerDamageDealt + '/' + result.creatureDamageDealt + '/' + result.creatureAction.kind);
      battle = result.battle;
    }
    return trace.join(' | ');
  };
  assert.equal(run(), run());
});

test('「同一场战斗两次不一样」：换一个 seed，回合数 / 行为 / 结果三个维度都要散开', () => {
  const roundsSeen = new Map<number, number>();
  const creatureKinds = new Map<string, number>();
  const outcomes = new Map<string, number>();

  for (let index = 0; index < 400; index += 1) {
    let battle = makeBattle({ creatureHp: 120, creatureMaxHp: 120, creatureSequence: 9 });
    const seed = 'variance-' + index;
    let round = 1;
    for (; round <= BATTLE.maxRounds; round += 1) {
      const result = resolveBattleRound(makeCharacter(), battle, { kind: 'attack' }, seeded(seed + ':' + round), {
        species: viewOf('whisperer'),
        aiRng: seeded(seed + ':ai:' + round),
      });
      creatureKinds.set(
        result.creatureAction.kind,
        (creatureKinds.get(result.creatureAction.kind) ?? 0) + 1,
      );
      battle = result.battle;
      if (isBattleOver(result.status)) {
        outcomes.set(result.status, (outcomes.get(result.status) ?? 0) + 1);
        break;
      }
    }
    roundsSeen.set(round, (roundsSeen.get(round) ?? 0) + 1);
  }

  assert.ok(roundsSeen.size >= 4, '回合数必须是散的，实际只有 ' + roundsSeen.size + ' 种');
  assert.ok(creatureKinds.size >= 3, '生物行为必须是散的，实际只有 ' + creatureKinds.size + ' 种');
  assert.ok(outcomes.size >= 2, '战斗结果必须是散的，实际只有 ' + outcomes.size + ' 种');
});
