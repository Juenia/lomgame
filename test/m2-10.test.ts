/**
 * M2.10 纯函数测试。
 *
 * 第一节是**前置 2：低序列保护信号**（不改数值，只给信号）；
 * 第二节是主任务 PVP 的部分（见文件末尾）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATTLE, NUMERIC } from '../src/config/numeric.ts';
import { buildEncounterMenu, canStartBattle } from '../src/domain/menu/encounter-menu.ts';
import { battleViewFor, resolveBattleRound, sequenceGapHint } from '../src/domain/battle/index.ts';
import type { BattleState } from '../src/domain/battle/index.ts';
import { loadCreatures } from '../src/data/loader.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

const SPECIES = new Map(loadCreatures().creatures.map((species) => [species.id, species]));

function makeCharacter(patch: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'c-1',
    userId: 'u-1',
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
    id: 'b-1',
    characterId: 'c-1',
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

function menuFor(gap: number) {
  const species = SPECIES.get('deep_gazer')!;
  return buildEncounterMenu({
    locationName: '老码头',
    weatherLabel: '雾天',
    text: species.perception.full,
    layer: 'full',
    allowedActions: ['observe', 'confront', 'interact'],
    behaviorText: null,
    mortal: false,
    sequenceGap: gap,
  });
}

/* ================================================================== *
 * 一、前置 2：低序列保护信号
 * ================================================================== */

test('前置 2：序列差的人话分四档，措辞与 M2.6.1 的三条分支一一对应', () => {
  // 弱 3 级及以上：M2.6.1 直接拦截 —— 这里也必须说「近不了身」
  assert.match(sequenceGapHint(3), /你根本近不了它的身/);
  assert.match(sequenceGapHint(5), /你根本近不了它的身/);
  // 弱 1—2 级：命中 ×0.4、伤害 ×0.5
  assert.match(sequenceGapHint(1), /你比它弱 1 个序列，命中与伤害都被大幅压制/);
  assert.match(sequenceGapHint(2), /你比它弱 2 个序列/);
  // 同序列
  assert.equal(sequenceGapHint(0), '你们序列相同，势均力敌');
  // 强 1 级及以上
  assert.match(sequenceGapHint(-1), /你比它强 1 个序列/);

  // 门槛必须与 M2.6.1 的拦截线**同一个数**（两处漂移会让这句话骗人）
  assert.equal(NUMERIC.assault.sequenceGating.blockThreshold, 3);
});

test('前置 2：遭遇菜单的「动手」写着你比它弱几个序列（这才是玩家做决定时要看的）', () => {
  for (const gap of [5, 3, 2, 1]) {
    const menu = menuFor(gap);
    const fight = menu.options.find((option) => option.command === '战斗 开始');
    assert.ok(fight, '看得清就该有「动手」');
    assert.match(fight!.preview ?? '', new RegExp('你比它弱 ' + gap + ' 个序列'), `gap=${gap} 的预览`);
  }
  const equal = menuFor(0).options.find((option) => option.command === '战斗 开始');
  assert.match(equal!.preview ?? '', /势均力敌/);
  const strong = menuFor(-2).options.find((option) => option.command === '战斗 开始');
  assert.match(strong!.preview ?? '', /你比它强 2 个序列/);

  // 不给序列差（M2.8 的既有调用点）时不显示这一句，但仍然有「最多 N 回合」
  const silent = buildEncounterMenu({
    locationName: '老码头',
    weatherLabel: '雾天',
    text: 'x',
    layer: 'full',
    allowedActions: ['observe'],
    behaviorText: null,
    mortal: false,
  });
  const silentFight = silent.options.find((option) => option.command === '战斗 开始');
  assert.match(silentFight!.preview ?? '', /最多 8 回合/);
  assert.doesNotMatch(silentFight!.preview ?? '', /序列/);
});

test('前置 2：战斗回执的对手行下面就是序列差（每一回合都看得见）', () => {
  // 玩家序列 9 打序列 8 的低语者 → 弱 1 级
  const view = battleViewFor({
    battle: makeBattle({ creatureSequence: 8 }),
    character: makeCharacter({ sequence: 9 }),
    items: [],
  });
  const text = view.lines.join('\n');
  assert.match(text, /你比它弱 1 个序列，命中与伤害都被大幅压制/);
  // 位置：紧跟对手那一行（玩家一眼能看到「这一架打不打得动」）
  const creatureLine = view.lines.findIndex((line) => line.startsWith('低语者 ·'));
  assert.equal(view.lines[creatureLine + 1], '你比它弱 1 个序列，命中与伤害都被大幅压制');

  // 序列 8 的玩家打序列 8 的低语者 → 势均力敌
  const even = battleViewFor({
    battle: makeBattle({ creatureSequence: 8 }),
    character: makeCharacter({ sequence: 8 }),
    items: [],
  });
  assert.match(even.lines.join('\n'), /势均力敌/);
});

test('前置 2：撤退的代价说清楚（M2.85：什么都不花 —— 行动值已下线）', () => {
  const species = SPECIES.get('whisperer')!;
  const view = {
    id: species.id,
    name: species.name,
    habits: species.habits,
    special: species.battle!.special,
    specialName: species.battle!.specialName,
    damage: species.battle!.damage,
    hit: species.battle!.hit,
  };
  // 危险度 0 + 必中的随机源 → 一定退得掉
  let fled: string | null = null;
  for (let index = 0; index < 40 && fled === null; index += 1) {
    const result = resolveBattleRound(
      makeCharacter(),
      makeBattle({ world: { ...makeBattle().world, danger: 0 } }),
      { kind: 'retreat' },
      createSeededRng('retreat-' + index),
      { species: view, creatureAction: { kind: 'attack', label: '攻击', note: '' } },
    );
    if (result.status === 'fled') {
      fled = result.events.map((event) => event.text).join('\n');
    }
  }
  assert.ok(fled, '危险度 0 时应当退得掉');
  /* M2.85：原来这里还断言「撤退只花 1 点行动点」—— 行动值下线后撤退什么都不花 */
  assert.match(fled!, /不掉血、不掉 MAD、不丢东西/);

  // 危险度 5 → 大概率退不掉；退不掉的那次必须说清「行动点也没有扣」
  let failed: string | null = null;
  for (let index = 0; index < 60 && failed === null; index += 1) {
    const result = resolveBattleRound(
      makeCharacter(),
      makeBattle({ world: { ...makeBattle().world, danger: 5 } }),
      { kind: 'retreat' },
      createSeededRng('retreat-' + index),
      { species: view, creatureAction: { kind: 'attack', label: '攻击', note: '' } },
    );
    if (result.status === 'active') {
      const lines = result.events.map((event) => event.text).join('\n');
      if (lines.includes('没能甩掉')) failed = lines;
    }
  }
  assert.ok(failed, '危险度 5 时应当有退不掉的情况');
  assert.match(failed!, /没能甩掉/);
});

test('前置 2：一个数值都没改（冻结断言）', () => {
  // 战斗数值：M2.9 定稿值原样
  assert.equal(BATTLE.maxRounds, 8);
  assert.equal(BATTLE.playerTimeoutMs, 5 * 60 * 1000);
  assert.equal(BATTLE.actions.attack.baseHit, 0.5);
  assert.equal(BATTLE.actions.attack.baseDamageMin, 30);
  assert.equal(BATTLE.actions.attack.baseDamageMax, 60);
  assert.equal(BATTLE.actions.defend.damageMultiplier, 0.5);
  assert.equal(BATTLE.actions.defend.mpRestore, 5);
  assert.equal(BATTLE.actions.retreat.baseChance, 0.6);
  assert.equal(BATTLE.actions.retreat.dangerPenalty, 0.4);
  assert.equal(BATTLE.creatureAi.fleeThreshold, 0.3);
  assert.equal(BATTLE.creatureAi.berserkThreshold, 0.2);
  assert.equal(BATTLE.statuses.fear.hitPenalty, -0.2);
  assert.equal(BATTLE.maxStatuses, 5);
  // 序列差框架：M2.6.1 定稿值原样（前置 2 是显示层，不该碰它）
  assert.equal(NUMERIC.assault.baseHit, 0.5);
  assert.equal(NUMERIC.assault.baseDamageMin, 30);
  assert.equal(NUMERIC.assault.baseDamageMax, 60);
  assert.equal(NUMERIC.assault.sequenceGating.blockThreshold, 3);
  assert.equal(NUMERIC.assault.sequenceGating.hitDecay, 0.4);
  assert.equal(NUMERIC.assault.sequenceGating.damageDecay, 0.5);
  assert.equal(NUMERIC.assault.sequenceGating.bonusHit, 1.2);
  assert.equal(NUMERIC.assault.sequenceGating.bonusDamage, 1.1);
});
