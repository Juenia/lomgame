/**
 * M2.66：**三个「只落数据」的字段接上判定**。
 *
 * ## 这一份守什么
 *
 * M2.58 / M2.59 有几处内容写了、而判定层一个字节都没读的字段。它们与 M2.65 那批
 * 「行动效果没有下家」是同一形状（K10：配置里有、玩法里没有），只是这次是**域参数**与**能力字段**：
 *
 * | 字段 | 内容在哪 | 原本的处境 | 这一轮的落点 |
 * | --- | --- | --- | --- |
 * | `madness` 疯狂度 | zones.yaml 6 个域 | `resolveEcologyParams` 根本没带它（连读都读不到） | 传闻**失真**（信息生态） |
 * | `order` 秩序度 | zones.yaml 6 个域 | 同上 | 人间干预 → 生态**衰亡加快** |
 * | `initiativeBonus` 先手 | abilities.yaml 5 条能力 | `ability.ts` 自注「当前未接入战斗系统」 | 第一回合双方的**命中修正** |
 *
 * 四条纪律照旧：不排斥现有数据（缺省值 = 中性）、判定层纯函数、数值进 NUMERIC、
 * 每一项都有端到端证据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BATTLE, CREATURE } from '../src/config/numeric.ts';
import { loadContent, loadCreatures } from '../src/data/loader.ts';
import { checkCreatureBehaviors, checkLinks } from '../src/data/link-check.ts';
import {
  decayChanceOf,
  spawnInitialCreatures,
  tickCreatures,
  type CreatureSpecies,
} from '../src/domain/creature/index.ts';
import { NARRATED_BEHAVIORS, behaviorText } from '../src/domain/creature/perception.ts';
import { battleSpeciesViewOf, resolveBattleRound } from '../src/domain/battle/index.ts';
import type { BattleState } from '../src/domain/battle/types.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import {
  ZoneIndex,
  distortionChanceOf,
  orderPressure,
  resolveEcologyParams,
  type ResolvedEcologyParams,
} from '../src/domain/world/zone.ts';
import { noteSightingForEcology } from '../src/infra/info-ecology.ts';
import { OPEN_PATHWAYS } from '../src/domain/character/rules.ts';
import { createHarness } from './helpers/app.ts';

const HOUR = 3_600_000;
const NL = String.fromCharCode(10);

const CONTENT = loadContent();
const SPECIES = CONTENT.creatures;
const ZONE_INDEX = new ZoneIndex(CONTENT.zones);
const ZONE_BY_ID = new Map(CONTENT.zones.map((zone) => [zone.id, zone]));

/** 全部中性的一份域参数（每一项对比实验都从它出发，只动一个字段） */
function neutral(patch: Partial<ResolvedEcologyParams> = {}): ResolvedEcologyParams {
  return {
    carryingCapacity: 20,
    migrateMultiplier: 1,
    reproduceMultiplier: 1,
    replenishMultiplier: 1,
    decayMultiplier: 1,
    spirituality: 0,
    pollution: 0,
    madness: 0,
    order: 0,
    fear: 0,
    ...patch,
  };
}

/* ================================================================== *
 * 一、参数解析：两个字段真的被带上来了
 * ================================================================== */

test('M2.66 域参数：`madness` / `order` 进了 ResolvedEcologyParams（之前连读都读不到）', () => {
  const base = resolveEcologyParams(undefined);
  assert.equal(base.madness, 0, '没登记在任何域里 → 0（与加这两个字段之前逐位相同）');
  assert.equal(base.order, 0);

  const withValues = resolveEcologyParams({ madness: 0.8, order: 0.05 });
  assert.equal(withValues.madness, 0.8);
  assert.equal(withValues.order, 0.05);
});

test('M2.66 域参数：域索引按地点取到这两个值，历史伤痕叠加也算数', () => {
  // 灵界重叠区：madness 0.8 / order 0.05；城市雾区：madness 0.2 / order 0.8
  const rift = ZONE_INDEX.paramsOf('above_grey_fog');
  const city = ZONE_INDEX.paramsOf('tingen');
  assert.equal(rift.madness, 0.8);
  assert.equal(city.order, 0.8);
  assert.ok(rift.madness > city.madness, '灵界重叠区应当比城市雾区疯');
  assert.ok(city.order > rift.order, '城市雾区的秩序应当比灵界重叠区高');
});

/* ================================================================== *
 * 二、疯狂度 → 传闻失真
 * ================================================================== */

test('M2.66 失真：概率随疯狂度线性上升，基线 0 → 不动任何东西', () => {
  assert.equal(distortionChanceOf(0), 0, '疯狂度 0 时失真概率必须为 0 —— 否则既有传闻全变样');
  assert.ok(distortionChanceOf(0.8) > distortionChanceOf(0.2));
  assert.equal(distortionChanceOf(1), 0.6, '满值 0.6');
  // 端点之外夹住（内容侧写 1.4 也不该算出 >100% 的概率）
  assert.equal(distortionChanceOf(1.4), 0.6);
  assert.equal(distortionChanceOf(-1), 0);
});

test('M2.66 失真（端到端）：疯狂度 0.8 的域会传出失真的传闻，0.2 的域一条都没有', () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const deps = h.app.router.deps;
    const scan = (locationId: string, locationName: string) => {
      const out: Array<{ rumored: boolean; distorted: boolean; text: string }> = [];
      for (let i = 0; i < 160; i += 1) {
        const sightingId = locationId + '-sighting-' + i;
        const result = noteSightingForEcology({
          db: h.app.db,
          zoneIndex: deps.zoneIndex,
          worldEvents: deps.worldEvents,
          locationId,
          locationName,
          sightingId,
          worldSeed: 'm2-66',
          now: h.now(),
        });
        const text = deps.worldEvents.all().find((row) => row.id === result.rumorEventId)?.text ?? '';
        out.push({ rumored: result.rumored, distorted: result.distorted, text });
      }
      return out;
    };

    // 灵界重叠区（madness 0.8，失真概率 48%）
    const rift = scan('above_grey_fog', '灰雾之上');
    const riftRumored = rift.filter((row) => row.rumored);
    const riftDistorted = riftRumored.filter((row) => row.distorted);
    assert.ok(riftRumored.length > 0, '对照侧：这个域至少要有传闻传出去（否则下面那条是空转）');
    assert.ok(riftDistorted.length > 0, '疯狂度 0.8 的域必须能传出失真的传闻');
    assert.ok(
      riftDistorted.length < riftRumored.length,
      '也不该是「全都失真」—— 那样概率就没意义了',
    );
    // 失真的那条文案来自另一个池子，且长度/口气都不同 —— 断言它**不是**普通池里的句子
    for (const row of riftDistorted) {
      assert.ok(row.text.length > 0, '失真传闻也要有正文');
    }

    // 城市雾区（madness 0.2，失真概率 12%）—— 要能观察到「不是每条都失真」
    const city = scan('tingen', '廷根市');
    const cityRumored = city.filter((row) => row.rumored);
    assert.ok(cityRumored.length > 0, '对照侧：城市雾区也要有传闻');
    assert.ok(
      cityRumored.filter((row) => row.distorted).length < cityRumored.length,
      '城市雾区不该整片失真',
    );
  } finally {
    h.app.close();
  }
});

/* ================================================================== *
 * 三、秩序度 → 人间干预（衰亡加快）
 * ================================================================== */

test('M2.66 秩序：倍率形状正确，基线 0 → ×1（不改变任何东西）', () => {
  assert.equal(orderPressure(neutral({ order: 0 })), 1);
  assert.equal(orderPressure(neutral({ order: 0.8 })), 1.4);
  assert.equal(orderPressure(neutral({ order: 1 })), 1.5);
  assert.ok(orderPressure(neutral({ order: 0.8 })) > orderPressure(neutral({ order: 0.05 })));
});

test('M2.66 秩序：衰亡概率里真的乘了它（四个因子一处合成）', () => {
  assert.equal(decayChanceOf(neutral({ order: 0 })), CREATURE.ecology.decayChance);
  assert.ok(
    Math.abs(decayChanceOf(neutral({ order: 1 })) / decayChanceOf(neutral({ order: 0 })) - 1.5) < 1e-9,
    '秩序满值应当是 1.5 倍衰亡',
  );
});

test('M2.66 秩序（端到端）：同样的 seed、只改 order，高秩序那一边掉的血更多', () => {
  const byId = new Map(SPECIES.map((species: CreatureSpecies) => [species.id, species]));
  const locationIds = [...new Set(SPECIES.flatMap((species) => species.habitat))];
  /*
   * ⚠️ 衰亡那一步**只对 `status === 'dying'` 的生物生效**（20 天没进食才开始掉血）。
   * 所以这一条不能拿刚出生的生态跑 48 小时 —— 那时几乎没有一只进入 dying，
   * 两边都是 0 次衰亡，断言会退化成「2 vs 2」这种什么都证明不了的数。
   * 把 `lastFedAt` 往前推 40 天，让它们一上来就是濒死的，再比。
   */
  const now0 = 40 * 24 * HOUR;
  /*
   * 血量给得很大（10000）：这一条要量的是**衰亡掉了多少血**，
   * 而不是「谁先被打死」—— 让任何一只都不会真的死掉，测量就只剩衰亡那一项
   *（实测：血量正常时 200 小时的死亡数 37 vs 28，方向是对的，但里面混着捕食与补充，
   *  读起来分不清是哪一项在起作用）。
   */
  const starters = spawnInitialCreatures(SPECIES, createSeededRng('m2-66-order-spawn'), 0).map((creature) => ({
    ...creature,
    lastFedAt: 0,
    hp: 10000,
  }));
  /*
   * ⚠️ 除了 order，两份参数**逐字段相同**（连 carryingCapacity 都一样）——
   * 否则「死得更多」可能来自任何一个别的字段，这条断言就证明不了什么。
   */
  const run = (order: number) =>
    tickCreatures(
      starters.map((creature) => ({ ...creature })),
      {
        speciesById: byId,
        locationIds,
        zoneOf: () =>
          neutral({ decayMultiplier: 1, order, migrateMultiplier: 0, reproduceMultiplier: 0, replenishMultiplier: 0 }),
        now: now0,
        hours: 200,
      },
      createSeededRng('m2-66-order-diff'),
    );
  const calm = run(0);
  const policed = run(1);
  // ⚠️ 参数用**结构类型**而不是 ReturnType<typeof calm> —— 后者是「值的类型」不是函数，
  //    node --test 会照跑（它只剥类型），而 tsc 会红。发行检查就是为了抓这种「跑得起来但类型不过」。
  const totalHp = (run: { creatures: ReadonlyArray<{ hp: number }> }): number =>
    run.creatures.reduce((sum, creature) => sum + creature.hp, 0);

  /*
   * ⚠️ 断言的是**总血量**，不是死亡数。
   *
   * 衰亡每次只掉 5 点血，而生物的 HP 上限是几十到一百 —— 200 个 tick 的落差
   * （0.02 vs 0.03 的概率）远不足以把大多数生物打死。实测：两边死亡数都是 0，
   * 而总血量的差是 430 点（预期 48 只 × 200 tick × 0.01 × 5 = 480，对得上）。
   * 拿死亡数当判据的话，这条断言会退化成「0 > 0」——什么都证明不了。
   */
  assert.equal(calm.creatures.length, policed.creatures.length, '对照前提：两边的只数必须一样');
  assert.ok(totalHp(calm) > 0 && totalHp(policed) > 0, '对照侧：两边都要有活着的生物');
  assert.ok(
    totalHp(policed) < totalHp(calm),
    '高秩序的地方应当掉更多血（' + totalHp(calm) + ' vs ' + totalHp(policed) + '）',
  );
});

/* ================================================================== *
 * 四、先手 → 第一回合的命中
 * ================================================================== */

const RNG_ALWAYS_HIT = { next: () => 0 };
/** 恒定的抽样值：用来卡在「基线命中」与「被先手压下去的命中」之间 */
const rngAt = (value: number) => ({ next: () => value });

function makeCharacter(patch: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'c-m266', userId: 'u-m266', name: '试的人', pathway: 'warrior', sequence: 5,
    pathwayStatus: 'initiated', gender: 'male', hp: 100, mp: 60, mad: 20, cor: 0, dig: 0,
    dp: 0, status: 'active', promotionFails: 0, currentCityId: 'tingen',
    createdAt: 0, updatedAt: 0, ...patch,
  };
}

function makeBattle(patch: Partial<BattleState> = {}): BattleState {
  const base: BattleState = {
    id: 'b-m266', characterId: 'c-m266', creatureId: 'whisperer-1', speciesId: 'whisperer',
    speciesName: '低语者', creatureSequence: 8, creatureDying: false,
    world: { locationId: 'old_dock', locationName: '老码头', night: false, danger: 2, weatherHitPenalty: 0, weatherLabel: '晴' },
    round: 1, status: 'active', playerHp: 100, playerMp: 60, playerStatuses: [], playerDefensePenalty: 0,
    creatureHp: 999, creatureMaxHp: 999, creatureStatuses: [], creatureBerserk: false,
    creatureEvolved: false, creatureShield: false, allyCalled: false, allyArrivesAtRound: null,
    allyCount: 0, creaturePlayingDead: false, negateCreatureActions: 0, negatePlayerActions: 0,
    isPvp: false, opponentCharacterId: null, opponentName: null, turnOf: 'challenger' as const,
    pendingAction: null, foresight: null, lastPlayerDamage: 0, startedAt: 0, lastRoundAt: 0, resolvedAt: null,
  };
  return { ...base, ...patch, world: { ...base.world, ...(patch.world ?? {}) } };
}

const WHISPERER = loadCreatures().creatures.find((species) => species.id === 'whisperer')!;
const CREATURE_ATTACKS = { kind: 'attack' as const, label: '攻击', note: '' };

test('M2.66 先手：数值进 NUMERIC，基线不传 = 中性', () => {
  assert.ok(BATTLE.initiative.perPoint > 0, '每点先手要有正的命中加成');
  assert.equal(BATTLE.initiative.rounds, 1, '先手只该管开场那几个回合');
  const plain = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_ALWAYS_HIT, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
  });
  const zero = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_ALWAYS_HIT, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
    initiative: 0,
  });
  assert.deepEqual(zero.rolls, plain.rolls, '先手 0 必须与不传逐位相同');
  assert.ok(
    !plain.events.some((event) => event.text.includes('先动了手')),
    '没有这个能力的人不该多出任何一句回执',
  );
});

test('M2.66 先手：第一回合你更容易命中，它更难命中（且回执说得出这句话）', () => {
  const plain = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_ALWAYS_HIT, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
  });
  const quick = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_ALWAYS_HIT, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
    initiative: 4,
  });
  assert.ok(
    Number(quick.rolls.hitChance) > Number(plain.rolls.hitChance),
    '先手 4 → 命中加成 +0.2（' + quick.rolls.hitChance + ' vs ' + plain.rolls.hitChance + '）',
  );
  assert.ok(
    quick.events.some((event) => event.text.includes('你先动了手')),
    '先手要在回执里看得见',
  );
});

test('M2.66 先手：两侧取差值 —— 对手更快时反过来（PVP 的对称性）', () => {
  const mine = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_ALWAYS_HIT, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
    initiative: 2,
  });
  const theirs = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_ALWAYS_HIT, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
    initiative: 2,
    initiativeFoe: 2,
  });
  assert.equal(theirs.rolls.hitChance, resolveBattleRound(
    makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_ALWAYS_HIT,
    { species: battleSpeciesViewOf(WHISPERER), creatureAction: CREATURE_ATTACKS },
  ).rolls.hitChance, '两边一样快 = 没有先手优势（差值 0）');
  assert.ok(
    Number(mine.rolls.hitChance) > Number(theirs.rolls.hitChance),
    '对手也快时，你的加成要被抵掉一部分',
  );

  const slower = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_ALWAYS_HIT, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
    initiativeFoe: 4,
  });
  assert.ok(
    slower.events.some((event) => event.text.includes('它比你快')),
    '对手更快时回执要说得出来',
  );
});

test('M2.66 先手：第二回合起不再生效（它是开场的事，不是常驻加成）', () => {
  const plain = resolveBattleRound(makeCharacter(), makeBattle({ round: 2 }), { kind: 'attack' }, RNG_ALWAYS_HIT, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
  });
  const quick = resolveBattleRound(makeCharacter(), makeBattle({ round: 2 }), { kind: 'attack' }, RNG_ALWAYS_HIT, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
    initiative: 4,
  });
  assert.equal(quick.rolls.hitChance, plain.rolls.hitChance, '第二回合不该还带着先手');
  assert.ok(!quick.events.some((event) => event.text.includes('先动了手')), '第二回合不该再提先手');
});

test('M2.66 先手（可观察）：它本来打得到你，你先动了手它就扑空', () => {
  /*
   * 断言「它更难命中」不能只看玩家的 rolls（生物那一侧不记账）——
   * 用一个卡在两条命中线之间的恒定抽样值把它照出来：
   *   基线命中 0.5 → 0.4 命中；先手 4 之后 0.3 → 0.4 落空。
   */
  const rng = () => rngAt(0.4);
  /*
   * ⚠️ 玩家的序列必须与生物**同级**：M2.6.1 的序列差框架里，
   * 强 3 级直接让对方近不了身 —— 那样它本来就打不到你，这条断言就证不了先手。
   */
  const me = () => makeCharacter({ sequence: 8 });
  const plain = resolveBattleRound(me(), makeBattle(), { kind: 'defend' }, rng(), {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
  });
  const quick = resolveBattleRound(me(), makeBattle(), { kind: 'defend' }, rng(), {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
    initiative: 4,
  });
  assert.ok(plain.creatureDamageDealt > 0, '对照侧：它本来打得到你');
  assert.equal(quick.creatureDamageDealt, 0, '你先动了手，它这一下该落空');
});

/* ================================================================== *
 * 五、行为旁白：不再漏英文给玩家
 * ================================================================== */

test('M2.66 行为旁白：内容表里每一个行为名都有专属文案（link-check 第 4 项）', () => {
  const report = checkLinks({
    pathways: OPEN_PATHWAYS,
    recipes: CONTENT.recipes,
    cities: CONTENT.cities,
    factions: CONTENT.factions,
    churches: CONTENT.churches,
    creatures: CONTENT.creatures,
    // M2.71 第 5 项：地理一致性判据要读区域与城市
    regions: CONTENT.regions,
    geoCities: CONTENT.cities,
  });
  assert.deepEqual(
    report.creatureBehavior.issues.map((issue) => issue.message),
    [],
    '有行为名没有旁白 —— 玩家会读到半句英文',
  );
  assert.ok(report.creatureBehavior.rows.length > 0, '对照侧：真的扫到了行为名');
  for (const row of report.creatureBehavior.rows) {
    assert.ok(row.narrated, row.kind + ' 没有旁白');
    assert.ok(!behaviorText(row.kind).includes('它做了些什么'), row.kind + ' 落到兜底文案上了');
  }
});

test('M2.66 行为旁白（K23 反向用例）：没登记的行为名会被抓出来', () => {
  const broken = [{ id: 'probe_beast', behaviors: [{ kind: '这个行为没登记' }] }];
  const report = checkCreatureBehaviors(broken);
  assert.equal(report.issues.length, 1, '没登记的行为名必须报出来');
  assert.equal(report.issues[0]!.level, 'error');
  assert.equal(report.issues[0]!.check, 'creature-behavior');
  assert.match(report.issues[0]!.message, /这个行为没登记/);
  // 对照侧：真实内容 0 error
  assert.deepEqual(checkCreatureBehaviors(CONTENT.creatures).issues, []);
  assert.ok(NARRATED_BEHAVIORS.includes('lurk') && NARRATED_BEHAVIORS.includes('chant'));
});
