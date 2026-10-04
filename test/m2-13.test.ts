/**
 * M2.13 **主任务：封印物**的单测（前置四项在 test/m2-13-prereq.test.ts）。
 *
 * 两份分开是有意的：任务书 §5.12 要求「前置四项和主任务分开提交」，
 * 而测试文件跟着各自的提交走 —— 一份测试文件横跨两个提交会让「这一笔改了什么」变糊。
 *
 * 这一份守的是四件事：
 *   1. **12 件封印物全部可用**（内容齐、字段没被 zod 剥掉、判定层逐件认得）；
 *   2. **封印之刃真的能无视一次序列差拦截**（M2.6.1 的 `diff >= 3`）—— 这是核心；
 *   3. **命运骰子真的会重抽**（同 seed 可复现）；
 *   4. **掉落表按地点序列门槛分档，序列 7 的地点最高**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXTRAORDINARY, NUMERIC } from '../src/config/numeric.ts';
import { loadItems } from '../src/data/loader.ts';
import {
  dropRatesFor,
  dropTierOf,
  resolveExtraordinaryUse,
  rollExtraordinaryDrop,
} from '../src/domain/extraordinary/index.ts';
import { borrowedPowerChoice } from '../src/vplayer/decide.ts';
import { resolveAssault } from '../src/domain/wanted/assault.ts';
import { resolveBattleRound, type BattleState } from '../src/domain/battle/index.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import type { CharacterState, Rng } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

const ITEMS = loadItems().items;
const BY_ID = new Map(ITEMS.map((item) => [item.id, item]));

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
  return {
    id: 'b-test',
    characterId: 'c-test',
    creatureId: 'bone_choir-1',
    speciesId: 'bone_choir',
    speciesName: '骨唱诗班',
    creatureSequence: 6,
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
    creatureHp: 60,
    creatureMaxHp: 60,
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

/** 永远掷出一个固定值的随机源（用来把「命中 / 打空」钉死） */
function fixed(value: number): Rng {
  return { next: () => value };
}

/* ================================================================== *
 * 一、内容：12 件
 * ================================================================== */

test('封印物：12 件齐全，三类分别是 4 / 5 / 3，且字段没有被 zod 剥掉', () => {
  const wonder = ITEMS.filter((item) => item.type === 'wonder');
  const sealed = ITEMS.filter((item) => item.type === 'sealed');
  const charm = ITEMS.filter((item) => item.type === 'charm');
  assert.equal(wonder.length, 4, '神奇物品 4 件');
  assert.equal(sealed.length, 5, '封印物 5 件');
  assert.equal(charm.length, 3, '符咒 3 件');

  // id 前缀与 type 一一对应（任务书 §六 的命名约定）
  for (const item of [...wonder, ...sealed, ...charm]) {
    assert.ok(item.id.startsWith(item.type + '_'), item.id + ' 的前缀与 type 不一致');
    assert.ok(item.rarity >= 1 && item.rarity <= 5, item.id + ' 的稀有度越界');
  }

  // 每一件都要有「效果」—— 空效果就是一件摆设
  // M2.85 唯一例外：时间沙漏（原效果恢复行动点，随 AP 一并下线），见下方逐件清单后的摆设断言
  for (const item of sealed) {
    if (item.id === 'sealed_time_hourglass') continue;
    assert.ok(item.effect && Object.keys(item.effect).length > 0, item.id + ' 没有效果');
    assert.ok(typeof item.sealLevel === 'number', item.id + ' 缺封印等级');
  }

  /*
   * ⚠️ 这一条是 M2.12 §6.1 那个坑的守卫：zod 会**静默剥掉**未声明的字段，
   * 而剥掉之后的表现是「内容表里写了、运行期是 undefined、什么都不发生」。
   * 所以这里逐件把「它该有的那个机制字段」点出来。
   */
  const expectations: Array<[string, (item: (typeof ITEMS)[number]) => boolean]> = [
    ['wonder_divination_crystal', (i) => i.effect?.divinationBonus === 1],
    ['wonder_lucky_coin', (i) => i.effect?.tradeTaxMultiplier === 0.8],
    ['wonder_night_cloak', (i) => i.effect?.exploreDangerMultiplierNight === 0.85],
    ['wonder_record_notes', (i) => i.effect?.playDigMultiplier === 1.1],
    ['sealed_fate_dice', (i) => i.effect?.reroll === true],
    ['sealed_blade', (i) => i.effect?.ignoreSequenceGap === true && i.effect?.hitModifier === 1],
    ['sealed_grey_fog_eye', (i) => Array.isArray(i.effect?.reveal) && i.effect!.reveal!.length === 3],
    ['sealed_blood_moon_blade', (i) => i.effect?.damageMultiplier === 2],
    ['charm_exorcism', (i) => i.effect?.cor === -20],
    ['charm_invisibility', (i) => i.effect?.hideWantedHours === 1],
    ['charm_teleport', (i) => i.effect?.teleportToMarked === true],
  ];
  for (const [id, check] of expectations) {
    const item = BY_ID.get(id);
    assert.ok(item, '内容表里没有 ' + id);
    assert.ok(check(item!), id + ' 的机制字段被剥掉了');
  }
});

test('封印物：五件的代价与封印等级都在内容表里，且与 numeric 的 costs 同源', () => {
  const costs = EXTRAORDINARY.costs as unknown as Record<string, Record<string, number>>;
  assert.equal(BY_ID.get('sealed_fate_dice')!.sideEffect?.mad, costs.sealed_fate_dice.madOnReroll);
  assert.equal(BY_ID.get('sealed_blade')!.sideEffect?.cor, costs.sealed_blade.corOnUse);
  assert.equal(BY_ID.get('sealed_grey_fog_eye')!.sideEffect?.mad, costs.sealed_grey_fog_eye.madPerUse);
  assert.equal(BY_ID.get('sealed_blood_moon_blade')!.sideEffect?.cor, costs.sealed_blood_moon_blade.corOnUse);
  // M2.85：时间沙漏的 apRecoveryHalvedDays 代价随行动值机制移除，那一对断言一并下线
  // 封印等级：任务书写了 4 / 5 / 3 / 4，血月之刃没写（本轮取 3，理由在交付说明里）
  assert.equal(BY_ID.get('sealed_fate_dice')!.sealLevel, 4);
  assert.equal(BY_ID.get('sealed_blade')!.sealLevel, 5);
  assert.equal(BY_ID.get('sealed_grey_fog_eye')!.sealLevel, 3);
  assert.equal(BY_ID.get('sealed_time_hourglass')!.sealLevel, 4);
});

test('封印物：全部可交易（非绑定）—— 「序列 9 找序列 7 买封印物」这条经济流的前提', () => {
  for (const item of ITEMS.filter((i) => i.type !== 'material')) {
    assert.equal(item.tradeable, true, item.id + ' 不可交易');
    assert.notEqual(item.bindable, false, item.id + ' 永不绑定会让「可交易」失去意义');
  }
});

/* ================================================================== *
 * 二、掉落表
 * ================================================================== */

test('掉落表：按地点序列门槛分档，**序列 7 的地点最高**（三类都是）', () => {
  assert.equal(dropTierOf(9), 'seq9');
  assert.equal(dropTierOf(8), 'seq8');
  assert.equal(dropTierOf(7), 'seq7');
  // 更低门槛（内容表目前没有）按最高档算 —— 门槛越低越危险，这是同一件事的两面
  assert.equal(dropTierOf(5), 'seq7');

  for (const seq of [9, 8, 7]) {
    const rates = dropRatesFor(seq);
    assert.deepEqual(rates, {
      wonder: EXTRAORDINARY.dropRates.wonder[dropTierOf(seq)],
      sealed: EXTRAORDINARY.dropRates.sealed[dropTierOf(seq)],
      charm: EXTRAORDINARY.dropRates.charm[dropTierOf(seq)],
    });
  }
  const r9 = dropRatesFor(9);
  const r8 = dropRatesFor(8);
  const r7 = dropRatesFor(7);
  assert.ok(r7.wonder > r8.wonder && r8.wonder > r9.wonder, '神奇物品：7 > 8 > 9');
  assert.ok(r7.sealed > r8.sealed && r8.sealed > r9.sealed, '封印物：7 > 8 > 9');
  assert.ok(r7.charm > r8.charm && r8.charm > r9.charm, '符咒：7 > 8 > 9');
});

test('掉落判定：同 seed 同结果；序列 7 的地点掉得明显更多', () => {
  const sample = (minSeq: number, seed: string, rounds: number): number => {
    const rng = createSeededRng(seed);
    let hits = 0;
    for (let i = 0; i < rounds; i += 1) {
      if (rollExtraordinaryDrop({ minSeq, rng })) hits += 1;
    }
    return hits;
  };
  // 可复现
  assert.equal(sample(9, 'drop-seed', 2000), sample(9, 'drop-seed', 2000));
  // 三档的差距要看得见（2000 次抽样下 3% vs 0.5% 不可能撞在一起）
  const nine = sample(9, 'drop-a', 4000);
  const seven = sample(7, 'drop-a', 4000);
  assert.ok(seven > nine * 2, '序列 7 的掉落次数应当远多于序列 9：' + seven + ' vs ' + nine);
});

/* ================================================================== *
 * 三、封印之刃：无视一次序列差拦截（**这一轮的核心**）
 * ================================================================== */

test('封印之刃：不带它 → 被拦；带它 → 递得出去（M2.6.1 的 diff >= 3）', () => {
  const base = { attackerSeq: 9, targetSeq: 6, baseHit: 0.5, baseDamage: 40 };

  // 1) 原样：拦截，而且**一次骰都没掷**（不该掷骰时不掷）
  const blocked = resolveAssault(base, fixed(0));
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.blockedBy, 'sequence_gap');
  assert.equal(blocked.ignoredSequenceGap, false);
  assert.equal(blocked.roll, 0, '被拦时不该掷骰');
  assert.equal(blocked.hitChance, 0);

  // 2) 带封印之刃：不拦、必中（hitModifier +1.0）
  const blade = resolveAssault({ ...base, ignoreSequenceGap: true, hitModifier: 1 }, fixed(0.999));
  assert.equal(blade.blocked, false);
  assert.equal(blade.hit, true, '封印之刃的那一档命中率被抬到 1.0');
  assert.equal(blade.ignoredSequenceGap, true);
  assert.equal(blade.diff, 3, '真实序列差照实记（报告要它）');
  /*
   * 伤害按「**刚好没被拦**」的那一档算（diff 夹到 blockThreshold − 1 = 2）：
   * 0.5^2 = 0.25 → 40 × 0.25 = 10。
   * 不夹的话 formulaDiff 还是 3，damageMultiplierOf 返回 0，这一刀只有 1 点伤害 ——
   * 「无视了拦截，但打不动」等于什么都没做。
   */
  assert.equal(blade.damage, 10);
});

test('封印之刃：序列差没到拦截线时，它什么都不改变（不该无条件变强）', () => {
  const base = { attackerSeq: 9, targetSeq: 8, baseHit: 0.5, baseDamage: 40 };
  const plain = resolveAssault(base, createSeededRng('gap1'));
  const withFlag = resolveAssault({ ...base, ignoreSequenceGap: true }, createSeededRng('gap1'));
  assert.equal(withFlag.ignoredSequenceGap, false, '差 1 级本来就没被拦，谈不上「无视拦截」');
  assert.equal(withFlag.blocked, plain.blocked);
  assert.equal(withFlag.hit, plain.hit);
  assert.equal(withFlag.damage, plain.damage);
});

test('封印之刃（战斗里）：序列 9 打序列 6 的骨唱诗班，不带它一刀都递不出去', () => {
  const battle = makeBattle();
  const character = makeCharacter();

  /*
   * 1) 常规攻击：被序列差拦住，生物一滴血不掉。
   *
   * ⚠️ 随机源用 0.9 而不是 0：M2.6.1 的高序列抗性（目标序列 ≤ 6 时命中之后还要过一道，
   * 序列 6 的抗性是 0.6）会让「掷 0」的封印之刃被挡下来 —— 那测的就不是封印之刃了。
   * 0.9 同时满足「命中」（命中率被抬到 1.0）与「没被抵抗」（0.9 ≥ 0.6）。
   */
  const plain = resolveBattleRound(character, battle, { kind: 'attack' }, fixed(0.9));
  assert.equal(plain.creatureHp, battle.creatureHp, '被拦住时不该掉血');
  assert.ok(
    plain.events.some((event) => (event.text ?? '').includes('近不了')),
    '回执要说清为什么没打成',
  );

  // 2) 用封印之刃：这一刀递得出去，而且代价记在账上
  const withBlade = resolveBattleRound(
    character,
    battle,
    { kind: 'extraordinary', extraordinaryId: 'sealed_blade' },
    fixed(0.9),
    {
      extraordinary: {
        itemId: 'sealed_blade',
        name: '封印之刃',
        ignoreSequenceGap: true,
        hitModifier: 1,
        cost: { cor: 8 },
      },
    },
  );
  assert.ok(withBlade.creatureHp < battle.creatureHp, '用了封印之刃就该打得动');
  assert.equal(withBlade.ignoredSequenceGap, true);
  assert.equal(withBlade.itemCorDelta, 8, '代价是 COR +8，判定层只记账');
  assert.equal(withBlade.playerHp <= battle.playerHp, true);
});

test('血月之刃（战斗里）：这一回合的伤害 ×2', () => {
  const battle = makeBattle({ creatureSequence: 9, creatureHp: 400, creatureMaxHp: 400 });
  const character = makeCharacter();
  const plain = resolveBattleRound(character, battle, { kind: 'attack' }, createSeededRng('blood'));
  const powered = resolveBattleRound(
    character,
    battle,
    { kind: 'extraordinary', extraordinaryId: 'sealed_blood_moon_blade' },
    createSeededRng('blood'),
    {
      extraordinary: {
        itemId: 'sealed_blood_moon_blade',
        name: '血月之刃',
        damageMultiplier: 2,
        cost: { cor: 5 },
      },
    },
  );
  assert.equal(
    powered.playerDamageDealt,
    plain.playerDamageDealt * 2,
    '同一个随机源下，血月之刃的伤害应当正好翻倍：' +
      powered.playerDamageDealt +
      ' vs ' +
      plain.playerDamageDealt,
  );
  assert.equal(powered.itemCorDelta, 5);
});

test('命运骰子（战斗里）：打空之后重抽一次；第二次中了才采用', () => {
  const battle = makeBattle({ creatureSequence: 8, creatureHp: 400, creatureMaxHp: 400 });
  const character = makeCharacter();

  /*
   * 构造「第一次空、第二次中」。掷骰的顺序是固定的：
   *   ① rollRange（基准伤害）  ② resolveAssault 的命中骰  ③ 重抽的命中骰  ④ 暴击骰……
   * 所以序列是 [0.5, 0.9, 0.05, 0.999]：
   *   0.5 → 伤害取中位；0.9 → 空（命中率 0.2）；0.05 → 中；0.999 → 不暴击。
   * 命运骰子的重抽**只在「没被拦、也没中」时**发生（见 resolve.ts 的三条口径）。
   */
  let index = 0;
  const sequence: Rng = { next: () => [0.5, 0.9, 0.05, 0.999][index++] ?? 0.999 };
  const rerolled = resolveBattleRound(
    character,
    battle,
    { kind: 'extraordinary', extraordinaryId: 'sealed_fate_dice' },
    sequence,
    {
      extraordinary: {
        itemId: 'sealed_fate_dice',
        name: '命运骰子',
        reroll: true,
        cost: { mad: 5 },
      },
    },
  );
  assert.ok(rerolled.playerDamageDealt > 0, '重抽中了就该掉血');
  assert.equal(rerolled.rolls.rerollHit, 1, '留档里要能看到第二次中了');
  assert.equal(rerolled.itemMadDelta, 5, '重抽的代价是 MAD +5');

  // 反例：两次都空 → 不掉血，但**代价照付**（借的是运气，不是成功）
  let index2 = 0;
  const alwaysMiss: Rng = { next: () => [0.5, 0.9, 0.95, 0.999][index2++] ?? 0.999 };
  const missed = resolveBattleRound(
    character,
    battle,
    { kind: 'extraordinary', extraordinaryId: 'sealed_fate_dice' },
    alwaysMiss,
    {
      extraordinary: { itemId: 'sealed_fate_dice', name: '命运骰子', reroll: true, cost: { mad: 5 } },
    },
  );
  assert.equal(missed.playerDamageDealt, 0);
  assert.equal(missed.itemMadDelta, 5, '没打中也要付代价');
});

test('命运骰子：被序列差拦住时不会为它花掉（重抽对拦截一点用都没有）', () => {
  const battle = makeBattle({ creatureSequence: 5, creatureHp: 60, creatureMaxHp: 60 });
  const result = resolveBattleRound(
    makeCharacter(),
    battle,
    { kind: 'extraordinary', extraordinaryId: 'sealed_fate_dice' },
    fixed(0.5),
    {
      extraordinary: { itemId: 'sealed_fate_dice', name: '命运骰子', reroll: true, cost: { mad: 5 } },
    },
  );
  assert.equal(result.creatureHp, battle.creatureHp);
  /*
   * 判据是「**没有发生重抽**」，而不是「一次骰都没掷」：
   * 同一个随机源还要供生物 AI 与基准伤害用，那两次照常会发生 ——
   * 被拦时不该多出来的**只有重抽那一次**（resolveAssault 在拦截分支里不掷骰）。
   */
  assert.equal(result.rolls.reroll, undefined, '被拦时不该重抽');
  assert.equal(result.ignoredSequenceGap, false, '命运骰子不解拦截 —— 那是封印之刃的事');
});

/* ================================================================== *
 * 四、12 件全部可用（判定层逐件）
 * ================================================================== */

test('封印物：12 件逐个走判定层，每一件都给出明确的结果', () => {
  const state = makeCharacter();
  const target = { sequence: 8, hp: 40, maxHp: 60, name: '低语者', locationName: '老码头' };

  // 4 件神奇物品：**被动的**，主动使用会被明确告知（这是「可用」而不是「沉默失败」）
  for (const id of ['wonder_divination_crystal', 'wonder_lucky_coin', 'wonder_night_cloak', 'wonder_record_notes']) {
    const result = resolveExtraordinaryUse(state, BY_ID.get(id)!, target, fixed(0));
    assert.equal(result.ok, false, id + ' 是被动物品，不该「使用成功」');
    assert.match(result.reason ?? '', /带在身上/, id + ' 要告诉玩家它是被动的');
    assert.equal(result.action?.kind, 'passive');
  }

  // 5 件封印物 + 3 件符咒：都要 ok，而且 action 要各是各的那一支
  const expected: Record<string, string | null> = {
    sealed_fate_dice: 'reroll',
    sealed_blade: 'attack',
    sealed_grey_fog_eye: 'reveal',
    // M2.85：sealed_time_hourglass 原效果是恢复行动点，随 AP 一并下线 ——
    // 它现在是摆设（「只是一件摆设」回执），不再进这份「必须能用」的清单。
    sealed_blood_moon_blade: 'power_attack',
    charm_exorcism: null,
    charm_invisibility: 'hide_wanted',
    charm_teleport: 'teleport',
  };
  for (const [id, kind] of Object.entries(expected)) {
    const item = BY_ID.get(id)!;
    const result = resolveExtraordinaryUse(state, item, target, fixed(0));
    assert.equal(result.ok, true, id + ' 用不了：' + (result.reason ?? ''));
    assert.equal(result.action?.kind ?? null, kind, id + ' 的 action 不对');
    // 有副作用的物品，deltas 里必须带着它（代价是封印物的第二张脸）
    if (item.sideEffect?.cor) {
      assert.ok(result.deltas.some((delta) => delta.type === 'cor' && delta.value === item.sideEffect!.cor));
    }
    if (item.sideEffect?.mad) {
      assert.ok(result.deltas.some((delta) => delta.type === 'mad' && delta.value === item.sideEffect!.mad));
    }
  }

  // 时间沙漏：唯一没有效果的封印物 —— 用了要给「摆设」回执（不能一声不吭）
  const hourglass = resolveExtraordinaryUse(state, BY_ID.get('sealed_time_hourglass')!, target, fixed(0));
  assert.equal(hourglass.ok, false, '时间沙漏已无效果，应当被拒');
  assert.match(hourglass.reason ?? '', /摆设/);

  // 灰雾之眼要真的说得出那三项
  const eye = resolveExtraordinaryUse(state, BY_ID.get('sealed_grey_fog_eye')!, target, fixed(0));
  assert.deepEqual(eye.action && eye.action.kind === 'reveal' ? [...eye.action.fields] : [], [
    'location',
    'hp',
    'sequence',
  ]);
});

test('封印物：封印等级 ≥ 4 时会给出警告（不影响判定）', () => {
  const state = makeCharacter();
  assert.ok(resolveExtraordinaryUse(state, BY_ID.get('sealed_blade')!, null, fixed(0)).sealWarning);
  assert.ok(resolveExtraordinaryUse(state, BY_ID.get('sealed_fate_dice')!, null, fixed(0)).sealWarning);
  assert.equal(
    resolveExtraordinaryUse(state, BY_ID.get('sealed_grey_fog_eye')!, null, fixed(0)).sealWarning,
    null,
    '等级 3 不该报警',
  );
});

test('封印物：判定层不掷骰（这一轮的效果全是确定性的）', () => {
  let calls = 0;
  const counting: Rng = { next: () => { calls += 1; return 0.5; } };
  for (const item of ITEMS.filter((entry) => entry.type !== 'material')) {
    resolveExtraordinaryUse(makeCharacter(), item, null, counting);
  }
  assert.equal(calls, 0, '一次骰都不该掷 —— 掉落与重抽各有自己的随机源');
});

/* ================================================================== *
 * 五、端到端：.使用
 * ================================================================== */

const USER = '41399';

test('端到端：.使用 灰雾之眼 / 时间沙漏 / 驱邪符 都走真实路由', async () => {
  const h = createHarness({ deterministicIds: true });
  const created = await h.createCharacter(USER, '封印测试者');
  const give = (itemId: string): void => {
    h.repos.inventory.add(created.id, itemId, 1, 'unbound', h.now());
  };

  // ⚠️ .使用 走的是令牌桶限流（capacity 1、refill 1/10s）——
  //    同一个玩家连发几条会被「冷却中」挡回来。11 秒 << 1 小时，不会推进出新的世界 tick。
  const betweenUses = (): void => h.advance(11_000);

  // 灰雾之眼：没有目标时也要给一句人话，而不是沉默
  give('sealed_grey_fog_eye');
  let replies = await h.send({ rawText: '.使用 灰雾之眼', userId: USER });
  let text = replies.map((message) => message.text).join('\n');
  assert.match(text, /灰雾之眼/);
  // 代价照付：MAD +8
  assert.equal(h.repos.characters.findById(created.id)!.mad, 8, '用了灰雾之眼就该吃 MAD +8');

  // 时间沙漏（M2.85）：行动点机制移除后它不再有效果 —— 落到「没有写得出效果」那句
  give('sealed_time_hourglass');
  betweenUses();
  replies = await h.send({ rawText: '.使用 时间沙漏', userId: USER });
  text = replies.map((message) => message.text).join('\n');
  assert.match(text, /只是一件摆设/);

  // 驱邪符：纯数值符咒（COR -20），用完扣掉
  h.repos.characters.update({ ...h.repos.characters.findById(created.id)!, cor: 30, updatedAt: h.now() });
  give('charm_exorcism');
  betweenUses();
  await h.send({ rawText: '.使用 驱邪符', userId: USER });
  assert.equal(h.repos.characters.findById(created.id)!.cor, 10, 'COR 30 → 10');
  assert.equal(h.repos.inventory.count(created.id, 'charm_exorcism'), 0, '符咒是一次性的');

  // 传送符：没去过的地方去不了（「标记 = 去过」这条口径）
  give('charm_teleport');
  betweenUses();
  replies = await h.send({ rawText: '.使用 传送符 贝克兰德', userId: USER });
  text = replies.map((message) => message.text).join('\n');
  assert.match(text, /还没去过/);
  assert.equal(h.repos.inventory.count(created.id, 'charm_teleport'), 1, '用不成就不该扣');

  h.app.db.close();
});

test('端到端：封印物用完之后**还在**（它不是消耗品），代价写在 sideEffect 里', async () => {
  const h = createHarness({ deterministicIds: true });
  const created = await h.createCharacter(USER, '封印测试者');
  h.repos.inventory.add(created.id, 'sealed_grey_fog_eye', 1, 'unbound', h.now());
  await h.send({ rawText: '.使用 灰雾之眼', userId: USER });
  assert.equal(h.repos.inventory.count(created.id, 'sealed_grey_fog_eye'), 1, '封印物不消耗');
  // 但每一次使用都要留档（报告里的「封印物使用次数」靠它）
  const rows = h.app.db
    .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'extraordinary_used'")
    .get() as { n: number };
  assert.equal(rows.n, 1, '每一次使用都要写一条 extraordinary_used');
  h.app.db.close();
});

test('端到端：探索能掉出封印物，且落的是**非绑定**物品（可交易）', async () => {
  const h = createHarness({ deterministicIds: true });
  const created = await h.createCharacter(USER, '封印测试者');
  /*
   * 掉落是概率事件（序列 9 地点 0.1%—2%），不篡改数值 ——
   * 而是把概率**乘到确定**：直接反复探索同一个地点直到掉出一件为止。
   * 序列 9 地点的符咒是 2%，期望 50 次上下。
   */
  let found: string | null = null;
  for (let attempt = 0; attempt < 400 && !found; attempt += 1) {
    h.app.db.prepare('DELETE FROM explore_daily').run();
    const character = h.repos.characters.findById(created.id)!;
    h.repos.characters.update({ ...character, hp: 100, updatedAt: h.now() });
    h.advance(11_000);
    await h.send({ rawText: '.探索 廷根市', userId: USER });
    const rows = h.app.db
      .prepare(
        "SELECT payload FROM domain_events WHERE type = 'item_gain' AND reason = '探索·封印物掉落' LIMIT 1",
      )
      .all() as Array<{ payload: string }>;
    if (rows.length > 0) found = String(rows[0]!.payload);
  }
  assert.ok(found, '400 次探索一件封印物都没掉出来');
  const payload = JSON.parse(found!) as Record<string, unknown>;
  assert.equal(payload.bindType, 'unbound', '封印物必须是非绑定 —— 否则「找序列 7 玩家买」这条经济流不成立');
  assert.equal(payload.quantity, 1);
  assert.ok(['wonder', 'sealed', 'charm'].includes(String(payload.extraordinaryKind)));
  assert.equal(typeof payload.roll, 'number', '抽样值要留档（否则回答不了「为什么三十天没掉」）');
  h.app.db.close();
});

/* ================================================================== *
 * 五之二、序列差的方向（M2.13.1：这一条在 M2.13 里写反过）
 * ================================================================== */

test('封印物：borrowedPower 的序列差方向 —— **序列号越小越强**', () => {
  /*
   * M2.13 写的是 `gap = targetSequence − playerSequence`，两头的后果都是错的：
   *   PVE：序列 9 玩家打序列 8 生物（对手更强）→ gap = −1 → **从不触发**；
   *   PVP：序列 7 玩家打序列 8 对手（对手**更弱**）→ gap = +1 → **反向触发**。
   *
   * 200×30 的取证（scripts/m2-13-1-borrowed-power-trace.ts）数出来的是：
   *   战斗回合 1018 → 那一刻手里有那两件 **8** → 正确口径 8 / 写反的口径 **0**
   *   → 实际使用 0（PVE）。
   * 所以这一条必须由单测钉住，而且**两个方向都要断言**。
   */
  const blade = [{ itemId: 'sealed_blade', quantity: 1 }];
  const dice = [{ itemId: 'sealed_fate_dice', quantity: 1 }];
  const base = { cor: 0, mad: 0 };

  // ✅ 对方更强（序列号更小）→ 用
  assert.equal(
    borrowedPowerChoice({ ...base, playerSequence: 9, targetSequence: 8, inventory: blade }),
    'sealed_blade',
    '序列 9 打序列 8（弱 1 级）应当用封印之刃',
  );
  assert.equal(
    borrowedPowerChoice({ ...base, playerSequence: 9, targetSequence: 6, inventory: blade }),
    'sealed_blade',
    '序列 9 打序列 6（差 3、本来会被拦死）只有封印之刃有用',
  );
  assert.equal(
    borrowedPowerChoice({ ...base, playerSequence: 8, targetSequence: 7, inventory: dice }),
    'sealed_fate_dice',
  );

  // ❌ 对方更弱（序列号更大）→ 不用（打得过就是打得过）
  assert.equal(
    borrowedPowerChoice({ ...base, playerSequence: 7, targetSequence: 8, inventory: blade }),
    null,
    '序列 7 打序列 8 是我更强，不该花封印物',
  );
  assert.equal(
    borrowedPowerChoice({ ...base, playerSequence: 9, targetSequence: 9, inventory: blade }),
    null,
  );

  // 代价越线不用
  assert.equal(
    borrowedPowerChoice({ ...base, cor: 85, playerSequence: 9, targetSequence: 8, inventory: blade }),
    null,
    'COR ≥ 80 不用封印之刃',
  );
  assert.equal(
    borrowedPowerChoice({ ...base, mad: 85, playerSequence: 8, targetSequence: 7, inventory: dice }),
    null,
    'MAD ≥ 80 不用命运骰子',
  );
});

/* ================================================================== *
 * 六、冻结：M2.1—M2.12 的数值一个都没动
 * ================================================================== */

test('封印物：没有改动 M2.1—M2.12 的任何已定数值（冻结）', () => {
  // 序列差框架（M2.6.1）—— 封印之刃是**绕过**它，不是改它
  assert.equal(NUMERIC.assault.sequenceGating.blockThreshold, 3);
  assert.equal(NUMERIC.assault.sequenceGating.hitDecay, 0.4);
  assert.equal(NUMERIC.assault.sequenceGating.damageDecay, 0.5);
  assert.equal(NUMERIC.assault.baseHit, 0.5);
  // 战斗（M2.9 / M2.10）
  assert.equal(NUMERIC.battle.maxRounds, 8);
  assert.equal(NUMERIC.battle.actions.attack.baseDamageMin, 30);
  assert.equal(NUMERIC.battle.crit.chance, 0.15);
  // 交易税（M2.5）—— 幸运硬币是**乘**在上面，不是改它
  assert.equal(NUMERIC.trade.taxRate, 0.05);
  // 探索（W3）×
  assert.equal(NUMERIC.explore.dangerTriggerBase, 0.06);
  assert.equal(NUMERIC.explore.bonusDropChance, 0.06);
  // 晋升（W4 / M2.5 / M2.12）
  assert.equal(NUMERIC.promotion.digThreshold, 60);
  // M2.18（E2）：85 → 80。依据是 m220a 实测 —— 双缺 11 人里前 5 人的 DIG 挤在 82.5—84.1。
  // 9→8 的 60（上一行）**没有动**：digThresholdFor 按 recipe.seq 分流，两者本来就分开存。
  assert.equal(NUMERIC.sequence7.digThreshold, 80);
});
