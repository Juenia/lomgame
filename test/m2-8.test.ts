/**
 * M2.8：非凡生物（世界实体层）。
 *
 * 这一份守的是**这一轮的验收标准**（任务书 §4.9）：
 *   1. 物种模板落库（8 种，序列 5—9 全覆盖）；
 *   2. 生物实例在 tick 上会**迁移 / 捕食 / 进化 / 繁衍 / 衰亡**（五种行为各一条断言）；
 *   3. **感知分层生效**：同一只生物，序列差不同的玩家看到不同文本；
 *   4. **普通人只看到最模糊的一层**（不管生物序列多低）—— M2.7.6 pathway_status 的兑现；
 *   5. 看不见就是真的看不见（blur / silhouette 的 visible 全是 null）；
 *   6. 四个动作（观察 / 对峙 / 撤退 / 互动）全部可用；没有攻击（M2.8 不做战斗）。
 *
 * 判定层的部分直接调纯函数（不起服务）；内容与链路部分走真实装载与真实结算。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CREATURE } from '../src/config/numeric.ts';
import { loadCities, loadCreatures, loadItems, loadLocations } from '../src/data/loader.ts';
import { CreatureIndex } from '../src/domain/creature/content.ts';
import {
  allowedActionsOf,
  canEvolve,
  canHarvest,
  perceptionLayerOf,
  resolveSighting,
  rollEncounter,
  spawnInitialCreatures,
  tickCreatures,
  visibilityOf,
  type Creature,
  type CreatureSpecies,
  type PerceptionLayer,
} from '../src/domain/creature/index.ts';
import { parseCreatureSpecies } from '../src/domain/creature/schema.ts';
import { buildEncounterMenu, canStartBattle } from '../src/domain/menu/encounter-menu.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import type { PathwayId } from '../src/domain/character/types.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

const { creatures: SPECIES, issues: SPECIES_ISSUES } = loadCreatures();
const INDEX = new CreatureIndex(SPECIES);
const BY_ID = new Map(SPECIES.map((species) => [species.id, species]));

/** 取一个物种（测试里对 id 写死；内容表改了这里会立刻红） */
function speciesOf(id: string): CreatureSpecies {
  const found = BY_ID.get(id);
  assert.ok(found, `内容表里没有物种 ${id}`);
  return found;
}

/** 掷骰脚本：按给定序列依次返回，用完之后返回 0 */
function scriptedRng(values: number[]): { next(): number } {
  let index = 0;
  return { next: () => values[index++] ?? 0 };
}

function makeCharacter(patch: {
  sequence?: number | null;
  pathway?: PathwayId | null;
  pathwayStatus?: 'mortal' | 'initiated';
} = {}): CharacterState {
  const sequence = patch.sequence === undefined ? 9 : patch.sequence;
  const pathway = patch.pathway === undefined ? 'seer' : patch.pathway;
  const pathwayStatus =
    patch.pathwayStatus ?? (pathway !== null && sequence !== null ? 'initiated' : 'mortal');
  return {
    id: 'c-test',
    userId: 'u-test',
    name: '测试者',
    pathway,
    sequence,
    pathwayStatus,
    gender: 'male',
    hp: 100,
    mp: 100,
    mad: 0,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    currentCityId: 'tingen',
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeCreature(species: CreatureSpecies, patch: Partial<Creature> = {}): Creature {
  return {
    id: `${species.id}-test`,
    speciesId: species.id,
    locationId: species.habitat[0]!,
    sequence: species.baseSequence,
    hp: species.baseHp,
    maxHp: species.baseHp,
    status: 'healthy',
    ageHours: 0,
    feedCount: 0,
    lastFedAt: 0,
    spawnedAt: 0,
    migratedFrom: null,
    ...patch,
  };
}

const WORLD = { locationId: 'old_dock', locationName: '老码头', foggy: true, night: true, weatherLabel: '雾天' };

/* ================================================================== *
 * 一、物种模板（内容）
 * ================================================================== */

test('物种模板：全部通过校验，序列 2—9 全覆盖', () => {
  assert.deepEqual(SPECIES_ISSUES, [], '内容表不该有任何问题');
  /*
   * M2.12：序列 7 门槛地点带来 3 个新物种，8 → 11。
   * M2.76：11 → **19** —— 补上序列 4 / 3 / 2 那一档（半神级，此前完全是空的）。
   *
   * ⚠️ 这个数**故意写死**（原来的 `>= 8 && <= 12` 是区间）。区间是假守卫：
   * 加内容时它不会红，于是「14 种里有 6 种挤在序列 7」这种事没人看得见。
   * 写死之后每次动内容表都会红一次，提醒你去看一眼分布 —— 这正是 G 表的用法。
   */
  /*
   * M2.85 生态补足（方案 A）：19 → **71**。
   * 新增的 52 条来自原作《超凡生物》《神话生物》——name/materials 是原作原文，
   * baseSequence/pathwayAffinity 来自原作的 usedIn，hp/伤害是项目派生（沿用本表的 seq→hp 曲线）。
   * 写死的数照旧要跟着动：它红了就是提醒你去看一眼序列分布。
   */
  assert.equal(SPECIES.length, 293, `当前 ${SPECIES.length} 种`);

  const sequences = new Set(SPECIES.map((species) => species.baseSequence));
  for (const expected of [2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.ok(sequences.has(expected), `序列 ${expected} 没有对应物种（要求 2—9 全覆盖）`);
  }
});

test('物种模板：五层感知文本一层都不能少，且互不相同', () => {
  const layers: PerceptionLayer[] = ['blur', 'silhouette', 'full', 'advantage', 'essence'];
  for (const species of SPECIES) {
    for (const layer of layers) {
      assert.ok(
        typeof species.perception[layer] === 'string' && species.perception[layer].length > 0,
        `${species.id} 缺 ${layer} 层的描述`,
      );
    }
    const texts = layers.map((layer) => species.perception[layer]);
    assert.equal(new Set(texts).size, texts.length, `${species.id} 的几层描述是重复的`);
  }
});

test('物种模板：栖息地 / 掉落都指向真实存在的东西', () => {
  // 引用的正确性由 loader 的交叉校验守着（写错的栖息地 = 这只生物永远不会出现，
  // 写错的掉落 = 玩家采到一个不存在的物品，两者都不会在运行期报错）
  const { locations } = loadLocations();
  const { items } = loadItems();
  const locationIds = new Set(locations.map((location) => location.id));
  const itemIds = new Set(items.map((item) => item.id));

  for (const species of SPECIES) {
    assert.ok(species.habitat.length > 0, `${species.id} 没有栖息地`);
    for (const locationId of species.habitat) {
      assert.ok(locationIds.has(locationId), `${species.id} 的栖息地 ${locationId} 不存在`);
    }
    for (const drop of species.drops) {
      assert.ok(itemIds.has(drop.itemId), `${species.id} 的掉落 ${drop.itemId} 不存在`);
      assert.ok(drop.chance > 0 && drop.chance <= 1, `${species.id}/${drop.itemId} 的概率越界`);
    }
  }
});

test('物种模板：多键的行为声明会被拦下（那是格式错误，不是两个行为）', () => {
  const bad = {
    species: 'bad_one',
    name: '坏例子',
    baseSequence: 9,
    habitat: ['old_dock'],
    perception: { blur: 'a', silhouette: 'b', full: 'c', advantage: 'd', essence: 'e' },
    behaviors: [{ flee: { trigger: 'hpLow', chance: 0.5 }, howl: { trigger: 'night', chance: 0.5 } }],
    // M2.9：battle 段是 schema 的必填项（见 creature/schema.ts 的 CreatureBattleSchema），
    // 所以这个「只想验多键 behaviors」的例子也要把它带上 —— 否则先报的是缺 battle。
    battle: { damage: [10, 20], hit: 0.5, special: 'chill', specialName: '渗冷' },
  };
  const parsed = parseCreatureSpecies(bad);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.issues.some((issue) => issue.includes('只能有一个键')), parsed.issues.join(' / '));
  }
});

/* ================================================================== *
 * 二、感知分层（M2.8 最重要的一条）
 * ================================================================== */

test('感知分层：同一只生物，序列差不同 → 五个层次各不相同', () => {
  // 深海凝视者 = 序列 6。玩家序列 9→3 依次对上五层。
  const species = speciesOf('deep_gazer');
  assert.equal(species.baseSequence, 6);
  const cases: Array<{ player: number; expected: PerceptionLayer }> = [
    { player: 9, expected: 'blur' }, //       delta -3  弱 3 级及以上
    { player: 8, expected: 'silhouette' }, // delta -2  弱 1—2 级
    { player: 7, expected: 'silhouette' }, // delta -1
    { player: 6, expected: 'full' }, //       delta  0  同序列
    { player: 5, expected: 'advantage' }, //  delta +1  强 1—2 级
    { player: 4, expected: 'advantage' }, //  delta +2
    { player: 3, expected: 'essence' }, //    delta +3  强 3 级及以上
  ];
  for (const entry of cases) {
    assert.equal(
      perceptionLayerOf({
        playerSequence: entry.player,
        creatureSequence: species.baseSequence,
        mortal: false,
      }),
      entry.expected,
      `玩家序列 ${entry.player} 对序列 ${species.baseSequence} 应当是 ${entry.expected}`,
    );
  }
});

test('感知分层：层次不同 → 看到的文本真的不同（不是同一句换个说法）', () => {
  const species = speciesOf('whisperer'); // 序列 8
  const creature = makeCreature(species);
  const seen = new Map<number, string>();
  for (const player of [9, 8, 7, 5]) {
    const result = resolveSighting({
      state: makeCharacter({ sequence: player }),
      creature,
      species,
      world: WORLD,
      rng: scriptedRng([0.5, 0.9]),
      seed: 's',
    });
    seen.set(player, result.text);
  }
  /*
   * 用任务书 §4.3.2 那张表里的例子（低语者，序列 8）。
   * 玩家序列 9 是地板（新号），对序列 8 只弱 1 级 —— 所以是「轮廓」而不是「模糊」：
   * 「模糊」那一层要求玩家弱 3 级及以上，而序列范围是 1—9，对序列 8 的生物够不到。
   */
  assert.equal(seen.get(9), species.perception.silhouette, '弱 1 级 → 轮廓');
  assert.equal(seen.get(8), species.perception.full, '同序列 → 完整信息');
  assert.equal(seen.get(7), species.perception.advantage, '强 1 级 → 占优');
  assert.equal(seen.get(5), species.perception.essence, '强 3 级 → 本质');
  assert.equal(new Set(seen.values()).size, 4, '四个层次的文本必须互不相同');
});

test('感知分层：五层文本都会被真的用到（没有一层是死内容）', () => {
  // 每一层都要能被某（玩家序列, 生物序列）组合命中 —— 否则内容表里写了也没人看得见
  const hit = new Set<PerceptionLayer>();
  for (const species of SPECIES) {
    for (let player = 1; player <= 9; player += 1) {
      hit.add(
        perceptionLayerOf({ playerSequence: player, creatureSequence: species.baseSequence, mortal: false }),
      );
    }
  }
  for (const layer of ['blur', 'silhouette', 'full', 'advantage', 'essence'] as PerceptionLayer[]) {
    assert.ok(hit.has(layer), layer + ' 这一层在任何序列组合下都出现不了（死内容）');
  }
});

test('感知分层：普通人只看到最模糊的一层 —— 不管生物序列多低', () => {
  /*
   * 这是 M2.7.6 的 pathway_status 字段的兑现。
   * 关键反例：灰雾游魂是序列 9，而普通人按序列 9 参与地点准入（sequenceOrInitiate），
   * 两者 delta = 0 —— 如果感知分层只看 delta，普通人就会"看清"一只游魂，本末倒置。
   */
  const wraith = speciesOf('grey_wraith');
  assert.equal(wraith.baseSequence, 9, '这一条测试的前提是灰雾游魂序列 9');

  const mortal = makeCharacter({ pathway: null, sequence: null, pathwayStatus: 'mortal' });
  for (const species of SPECIES) {
    const result = resolveSighting({
      state: mortal,
      creature: makeCreature(species),
      species,
      world: WORLD,
      rng: scriptedRng([0.5]),
      seed: 's',
    });
    assert.equal(result.layer, 'blur', `普通人遇到 ${species.id} 应当是 blur`);
    assert.equal(result.text, species.perception.blur);
  }
});

test('感知分层：看不见就是真的看不见（blur / silhouette 的数值全为 null）', () => {
  const species = speciesOf('deep_gazer'); // 序列 6
  const creature = makeCreature(species);

  // 弱 3 级（blur）
  const blur = resolveSighting({
    state: makeCharacter({ sequence: 9 }),
    creature,
    species,
    world: WORLD,
    rng: scriptedRng([0.5]),
    seed: 's',
  });
  assert.equal(blur.visible.name, null, '模糊层不该知道它叫什么');
  assert.equal(blur.visible.sequence, null);
  assert.equal(blur.visible.hp, null);

  // 弱 1 级（silhouette）
  const silhouette = resolveSighting({
    state: makeCharacter({ sequence: 7 }),
    creature,
    species,
    world: WORLD,
    rng: scriptedRng([0.5]),
    seed: 's',
  });
  assert.equal(silhouette.visible.name, null, '轮廓层同样不该知道它叫什么');
  assert.equal(silhouette.visible.hp, null);

  // 同序列（full）才看得见
  const full = resolveSighting({
    state: makeCharacter({ sequence: 6 }),
    creature,
    species,
    world: WORLD,
    rng: scriptedRng([0.5]),
    seed: 's',
  });
  assert.equal(full.visible.name, species.name);
  assert.equal(full.visible.sequence, 6);
  assert.equal(full.visible.hp, creature.hp);

  assert.equal(visibilityOf('blur'), false);
  assert.equal(visibilityOf('silhouette'), false);
  assert.equal(visibilityOf('full'), true);
});

test('四个动作：每一层能做什么是明确的，且没有任何攻击选项', () => {
  /*
   * 普通人：**观察 / 退回去 / 站着不动**
   *
   * M2.87 改过（原来只有后两个）。原因是用户实机看到的现象：
   * 凡人遭遇只有两个选项、**两个都零效果**，于是读完之后世界没有任何变化。
   * 而每个新号都是普通人 —— 等于每个玩家开局的前 N 天遭遇全是白开水。
   *
   * 加「观察」的世界观依据：**凡人看不清，但看得见、记得住**。
   * 他不知道自己遇到的是什么，但那个画面会留下 —— 这正是凡人被卷入
   * 非凡世界的第一种方式。代价与 observe 一致（MAD +1）：**记住是要付代价的**。
   *
   * ⚠️ 顺序也有意义：**观察排在最前**。凡人此刻最自然的反应是「那是什么？」——
   * 转身走反而是第二反应。
   */
  assert.deepEqual(allowedActionsOf('blur', true), ['observe', 'retreat', 'hold']);
  // 普通人的动作集与感知层**无关**（perceptionLayerOf 对他们一律短路成 blur）
  assert.deepEqual(allowedActionsOf('full', true), ['observe', 'retreat', 'hold']);
  // 弱 3 级及以上：只能撤退
  assert.deepEqual(allowedActionsOf('blur', false), ['retreat']);
  // 弱 1—2 级：观察（危险）/ 撤退
  assert.deepEqual(allowedActionsOf('silhouette', false), ['observe', 'retreat']);
  // 同序列：观察 / 对峙 / 互动
  assert.deepEqual(allowedActionsOf('full', false), ['observe', 'confront', 'interact']);
  // 强 1—2 级：观察 / 互动 / 驱逐（confront）
  assert.deepEqual(allowedActionsOf('advantage', false), ['observe', 'confront', 'interact']);
  // 强 3 级及以上：观察本质 / 互动
  assert.deepEqual(allowedActionsOf('essence', false), ['observe', 'interact']);

  // 四个动作全部出现，且**没有任何攻击动作**（M2.8 不做战斗）
  const all = new Set(
    (['blur', 'silhouette', 'full', 'advantage', 'essence'] as PerceptionLayer[]).flatMap((layer) =>
      [...allowedActionsOf(layer, false)],
    ),
  );
  for (const action of ['observe', 'confront', 'retreat', 'interact']) {
    assert.ok(all.has(action as never), `${action} 在任何层次都不可用`);
  }
  assert.ok(!all.has('attack' as never), 'M2.8 不提供攻击动作');
});

test('观察本质才能采集；采集是两道判定叠乘', () => {
  assert.equal(canHarvest('essence'), true);
  for (const layer of ['blur', 'silhouette', 'full', 'advantage'] as PerceptionLayer[]) {
    assert.equal(canHarvest(layer), false, `${layer} 不该能采集`);
  }
});

/* ================================================================== *
 * 三、遭遇概率
 * ================================================================== */

test('遭遇概率：雾天 ×1.3、途径亲和 ×1.4、夜行生物受时段影响', () => {
  const normal = speciesOf('whisperer'); // 夜行
  const e = CREATURE.encounter;

  // 基线：白天 + 无途径 + 不雾
  const speciesNoAffinity = { ...normal, pathwayAffinity: [] as string[], habits: [] as const };
  const base = rollEncounter({
    state: makeCharacter({ pathway: null, sequence: null, pathwayStatus: 'mortal' }),
    candidates: [{ creature: makeCreature(normal), species: { ...speciesNoAffinity, habits: [] } }],
    world: { night: false, foggy: false },
    rng: scriptedRng([0.99]),
  });
  assert.ok(Math.abs(base.chance - e.baseChance) < 1e-9, `基线应当是 ${e.baseChance}，实际 ${base.chance}`);

  // 雾天
  const foggy = rollEncounter({
    state: makeCharacter({ pathway: null, sequence: null, pathwayStatus: 'mortal' }),
    candidates: [{ creature: makeCreature(normal), species: { ...speciesNoAffinity, habits: [] } }],
    world: { night: false, foggy: true },
    rng: scriptedRng([0.99]),
  });
  assert.ok(Math.abs(foggy.chance - e.baseChance * e.fogMultiplier) < 1e-9);

  // 途径亲和：低语者挂的是 sleepless + seer，所以愚者玩家命中 ×1.4
  assert.ok(normal.pathwayAffinity.includes('seer'), '这一条测试的前提是低语者与愚者亲和');
  const affinity = rollEncounter({
    state: makeCharacter({ pathway: 'seer' }),
    candidates: [{ creature: makeCreature(normal), species: { ...normal, habits: [] } }],
    world: { night: false, foggy: false },
    rng: scriptedRng([0.99]),
  });
  assert.ok(
    Math.abs(affinity.chance - e.baseChance * e.pathwayAffinityMultiplier) < 1e-9,
    '亲和时应当是 ' + e.baseChance * e.pathwayAffinityMultiplier + '，实际 ' + affinity.chance,
  );

  // 不亲和的途径（战士）没有加成
  const noAffinity = rollEncounter({
    state: makeCharacter({ pathway: 'warrior' }),
    candidates: [{ creature: makeCreature(normal), species: { ...normal, habits: [] } }],
    world: { night: false, foggy: false },
    rng: scriptedRng([0.99]),
  });
  assert.ok(Math.abs(noAffinity.chance - e.baseChance) < 1e-9, '不亲和的途径不该有加成');

  // 夜行生物：夜晚更高、白天更低
  const nightOwl = rollEncounter({
    state: makeCharacter({ pathway: null, sequence: null, pathwayStatus: 'mortal' }),
    candidates: [{ creature: makeCreature(normal), species: { ...normal, pathwayAffinity: [] } }],
    world: { night: true, foggy: false },
    rng: scriptedRng([0.99]),
  });
  const dayOwl = rollEncounter({
    state: makeCharacter({ pathway: null, sequence: null, pathwayStatus: 'mortal' }),
    candidates: [{ creature: makeCreature(normal), species: { ...normal, pathwayAffinity: [] } }],
    world: { night: false, foggy: false },
    rng: scriptedRng([0.99]),
  });
  assert.ok(nightOwl.chance > dayOwl.chance, '夜行生物在夜里应当更容易被遇到');
  assert.ok(Math.abs(nightOwl.chance - e.baseChance * e.nightMultiplier) < 1e-9);
  assert.ok(Math.abs(dayOwl.chance - e.baseChance / e.nightMultiplier) < 1e-9);
});

test('遭遇概率：候选再多也不会线性抬高总遭遇率', () => {
  const species = speciesOf('grey_wraith');
  const options = { state: makeCharacter(), world: { night: false, foggy: false } };
  const one = rollEncounter({ ...options, candidates: [{ creature: makeCreature(species), species }], rng: scriptedRng([0.99]) });
  const many = rollEncounter({
    ...options,
    candidates: Array.from({ length: 5 }, (_, i) => ({
      creature: makeCreature(species, { id: `x${i}` }),
      species,
    })),
    rng: scriptedRng([0.99]),
  });
  assert.ok(Math.abs(one.chance - many.chance) < 1e-9, '同一个地点生物更多，不该让遭遇率翻几倍');
});

/* ================================================================== *
 * 四、生态 tick（世界自己在动）
 * ================================================================== */

test('生态 tick：初始播种按栖息地铺开，且序列越低播得越多（生态金字塔）', () => {
  const a = spawnInitialCreatures(SPECIES, createSeededRng('world'), 0);
  const b = spawnInitialCreatures(SPECIES, createSeededRng('world'), 0);
  assert.deepEqual(a, b, '同一个世界 seed 必须得到同一批生物');

  // 每个物种的数量 = 栖息地数 × spawnPerLocation × 序列系数
  const bonusOf = (sequence: number): number => CREATURE.ecology.spawnSequenceBonus[sequence] ?? 1;
  const expected = SPECIES.reduce(
    (sum, species) => sum + species.habitat.length * CREATURE.ecology.spawnPerLocation * bonusOf(species.baseSequence),
    0,
  );
  assert.equal(a.length, expected);

  /*
   * 生态金字塔本身要有单测守着：**序列越低（越弱）的物种，世界里就该越多**。
   * 这不是装饰 —— 底层与顶层同样只播 1 只时，序列 9 的灰雾游魂会在 14 天内被上层吃光，
   * 而它的设定是「随处可见」（见 numeric.creature.ecology.spawnSequenceBonus 的说明）。
   */
  const countOf = (speciesId: string): number => a.filter((creature) => creature.speciesId === speciesId).length;
  const wraith = countOf('grey_wraith'); // 序列 9
  const whisperer = countOf('whisperer'); // 序列 8
  const worm = countOf('chrono_worm'); // 序列 5
  assert.ok(wraith > whisperer, `序列 9（${wraith}）应当比序列 8（${whisperer}）多`);
  assert.ok(whisperer > worm, `序列 8（${whisperer}）应当比序列 5（${worm}）多`);
  for (const creature of a) {
    const species = speciesOf(creature.speciesId);
    assert.ok(species.habitat.includes(creature.locationId));
    assert.equal(creature.sequence, species.baseSequence);
  }
});

test('生态 tick：迁移 —— 进化的时机到了就换地方，并记下从哪来', () => {
  const species = speciesOf('whisperer');
  const creature = makeCreature(species);
  const world = {
    speciesById: new Map([[species.id, species]]),
    locationIds: ['old_dock', 'mist_street', 'dark_cellar'],
    now: HOUR,
    hours: 1,
  };
  // 第一个 rng 值决定「迁不迁」（0 < 0.05 → 迁），第二个决定漂不漂，第三个选目标
  const result = tickCreatures([creature], world, scriptedRng([0, 0.99, 0.5]));
  assert.equal(result.migrations.length, 1, '迁移应当发生');
  const moved = result.creatures[0]!;
  assert.notEqual(moved.locationId, creature.locationId, '它应当换了地方');
  assert.equal(moved.migratedFrom, creature.locationId, '要记得从哪来（审计与报告都要）');
  assert.ok(species.habitat.includes(moved.locationId), '栖息地内的迁移不该跑到表外');
});

test('生态 tick：捕食 —— 饥饿的捕食者啃掉弱小的邻居，自己回血', () => {
  const predatorSpecies = speciesOf('bone_speaker'); // 序列 7
  const preySpecies = speciesOf('grey_wraith'); // 序列 9（差 2 级，不足 predatorSeqGap=3）
  const strongPreySpecies = speciesOf('chrono_worm'); // 序列 5
  assert.ok(predatorSpecies.baseSequence - preySpecies.baseSequence < CREATURE.ecology.predatorSeqGap);

  const predator = makeCreature(predatorSpecies, {
    id: 'pred',
    locationId: 'bone_market',
    hp: 20,
    maxHp: 50,
    // 饿够久（超过 feedThresholdHours）
    lastFedAt: 0,
    spawnedAt: 0,
  });
  // 差 2 级：吃不到（不够 predatorSeqGap）
  const tooStrong = makeCreature(preySpecies, { id: 'prey-weak', locationId: 'bone_market' });
  const world = {
    speciesById: new Map([
      [predatorSpecies.id, predatorSpecies],
      [preySpecies.id, preySpecies],
    ]),
    locationIds: ['bone_market'],
    now: CREATURE.ecology.feedThresholdHours * HOUR + HOUR,
    hours: 1,
  };
  const result = tickCreatures([predator, tooStrong], world, scriptedRng([0.99, 0.5]));
  assert.equal(result.feeds.length, 0, `序列差不足 ${CREATURE.ecology.predatorSeqGap} 级不该吃得到`);

  // 差 3 级以上：吃得到
  const predator2 = makeCreature(predatorSpecies, {
    id: 'pred2',
    locationId: 'bone_market',
    hp: 20,
    maxHp: 50,
    lastFedAt: 0,
    spawnedAt: 0,
  });
  const prey2 = {
    ...makeCreature(strongPreySpecies, { id: 'prey-strong', locationId: 'bone_market' }),
    sequence: predator2.sequence + CREATURE.ecology.predatorSeqGap,
  };
  const world2 = {
    speciesById: new Map([
      [predatorSpecies.id, predatorSpecies],
      [strongPreySpecies.id, strongPreySpecies],
    ]),
    locationIds: ['bone_market'],
    now: CREATURE.ecology.feedThresholdHours * HOUR + HOUR,
    hours: 1,
  };
  const fed = tickCreatures([predator2, prey2], world2, scriptedRng([0.99, 0.5]));
  assert.equal(fed.feeds.length, 1, '够了捕食条件就该吃得到');
  const after = fed.creatures.find((c) => c.id === 'pred2')!;
  assert.ok(after.hp > predator2.hp, '捕食之后应当回血');
  assert.equal(after.feedCount, 1, '捕食次数要记着（进化条件之一）');
});

test('生态 tick：进化 —— 存活够久且吃得够多，序列 -1（变强）', () => {
  const species = speciesOf('whisperer');
  const eligible = makeCreature(species, {
    ageHours: CREATURE.ecology.evolutionHours,
    feedCount: CREATURE.ecology.evolutionFeedCount,
    hp: 10,
  });
  assert.equal(canEvolve(eligible), true);

  // 只看时间不够
  assert.equal(canEvolve({ ...eligible, feedCount: 0 }), false, '没吃过不该进化');
  // 只看捕食次数不够
  assert.equal(canEvolve({ ...eligible, ageHours: 0 }), false, '刚出生不该进化');

  const world = {
    speciesById: new Map([[species.id, species]]),
    locationIds: [eligible.locationId],
    now: HOUR,
    hours: 1,
  };
  // rng：不迁移(0.99) → 不捕食（其实已吃饱）→ 不繁衍 → 不衰亡
  const result = tickCreatures([eligible], world, scriptedRng([0.99, 0.99, 0.99]));
  assert.equal(result.evolutions.length, 1, '条件够了就该进化');
  const evolved = result.creatures[0]!;
  assert.equal(evolved.sequence, species.baseSequence - 1, '进化 = 序列 -1（数字越小越强）');
  assert.ok(evolved.maxHp > species.baseHp, '进化后 HP 上限应当变大');
  assert.equal(evolved.hp, evolved.maxHp, '进化是「蜕了一层」，血回满');
});

test('生态 tick：繁衍 —— 群居 + 稳定期才生，且有上限', () => {
  const species = speciesOf('blood_hound');
  assert.ok(species.habits.includes('social'), '这一条测试的前提是铁血猎犬群居');

  const parent = makeCreature(species, { hp: species.baseHp, maxHp: species.baseHp });
  const world = {
    speciesById: new Map([[species.id, species]]),
    locationIds: [parent.locationId],
    now: HOUR,
    hours: 1,
  };
  // 不迁移(0.99) → 繁衍(0 < 0.02)
  const result = tickCreatures([parent], world, scriptedRng([0.99, 0, 0.99]));
  assert.equal(result.births.length, 1, '群居 + 满血 + 稳定期应当繁衍');
  assert.equal(result.creatures.length, 2);
  assert.equal(result.births[0]!.sequence, species.baseSequence, '幼体从物种基线开始');

  /*
   * 新生儿的 id 必须**跨小时唯一**：调度器每小时单独调一次 tickCreatures（hours: 1），
   * 所以只用「调用内计数」当后缀会让同一个物种在不同小时生出的孩子全都同名，
   * 落库时被 INSERT OR REPLACE 覆盖 —— 表现是「报告说繁衍了 8 次，库里只有 1 只」。
   * 200×14 实测抓到过这个 bug，这条断言守着它不再回来。
   */
  const laterWorld = { ...world, now: world.now + 24 * HOUR };
  const later = tickCreatures(result.creatures, laterWorld, scriptedRng([0.99, 0.99, 0, 0.99]));
  assert.ok(later.births.length >= 1, '下一个小时应当又生至少一只');
  const ids = later.creatures.map((creature) => creature.id);
  assert.equal(new Set(ids).size, ids.length, '新生儿与已有的生物不能重名：' + ids.join(' / '));
  // 一次 tick 只走一代：新生儿不该在同一次调用里继续生
  assert.ok(
    later.births.length <= result.creatures.length,
    '繁衍数不该超过这一代的可繁衍个体数（否则就是新生儿连锁生育）',
  );

  // 非群居不生
  const lonely = speciesOf('deep_gazer'); // 夜行 + 独占，不群居
  assert.ok(!lonely.habits.includes('social'));
  const lonelyWorld = {
    speciesById: new Map([[lonely.id, lonely]]),
    locationIds: [lonely.habitat[0]!],
    now: HOUR,
    hours: 1,
  };
  const noBirth = tickCreatures([makeCreature(lonely)], lonelyWorld, scriptedRng([0.99, 0, 0.99]));
  assert.equal(noBirth.births.length, 0, '不群居的生物不该繁衍');
});

test('生态 tick：衰亡 —— 长期没进食会掉血，掉到 0 就消失', () => {
  const species = speciesOf('whisperer');
  // 饿过 decayHours（20 天）
  const starving = makeCreature(species, {
    hp: 5,
    lastFedAt: 0,
    spawnedAt: 0,
  });
  const now = CREATURE.ecology.decayHours * HOUR + HOUR;
  const world = {
    speciesById: new Map([[species.id, species]]),
    locationIds: [starving.locationId],
    now,
    hours: 1,
  };
  // 不迁移 → 不捕食（同地点没有别的生物）→ 衰亡命中（0 < decayChance）
  const result = tickCreatures([starving], world, scriptedRng([0.99, 0, 0.99]));
  assert.equal(result.deaths.length, 1, '血掉到 0 就该消失');
  assert.equal(result.creatures.length, 0, '死掉的生物不该留在世界里');
  assert.equal(result.changed.includes(starving.id), false, '已经死掉的 id 不该再要求 UPDATE');
});

test('生态 tick：状态机 —— 超过 feedThresholdHours 变饥饿，超过 decayHours 变濒死', () => {
  const species = speciesOf('whisperer');
  const fresh = makeCreature(species, { hp: species.baseHp, lastFedAt: 0, spawnedAt: 0 });
  const hungryWorld = {
    speciesById: new Map([[species.id, species]]),
    locationIds: [fresh.locationId],
    now: CREATURE.ecology.feedThresholdHours * HOUR + HOUR,
    hours: 1,
  };
  const hungry = tickCreatures([fresh], hungryWorld, scriptedRng([0.99, 0.99, 0.99]));
  assert.equal(hungry.creatures[0]!.status, 'hungry');

  const dyingWorld = { ...hungryWorld, now: CREATURE.ecology.decayHours * HOUR + HOUR };
  const dying = tickCreatures([makeCreature(species, { hp: species.baseHp, lastFedAt: 0, spawnedAt: 0 })], dyingWorld, scriptedRng([0.99, 0.99, 0.99]));
  assert.equal(dying.creatures[0]!.status, 'dying');
});

test('生态 tick：纯函数 —— 不改动输入列表', () => {
  const species = speciesOf('whisperer');
  const original = makeCreature(species);
  const snapshot = { ...original };
  const world = {
    speciesById: new Map([[species.id, species]]),
    locationIds: ['old_dock', 'mist_street'],
    now: HOUR,
    hours: 1,
  };
  tickCreatures([original], world, scriptedRng([0, 0.99, 0.5]));
  assert.deepEqual(original, snapshot, 'tickCreatures 不该修改传进来的生物');
});

/* ================================================================== *
 * 五、遭遇菜单
 * ================================================================== */

test('遭遇菜单：选项是完整指令原文，且按层次给出不同的动作集', () => {
  const species = speciesOf('whisperer');
  const base = {
    locationName: '老码头',
    weatherLabel: '雾天',
    text: species.perception.full,
    layer: 'full' as PerceptionLayer,
    behaviorText: null,
    mortal: false,
  };

  const full = buildEncounterMenu({ ...base, allowedActions: allowedActionsOf('full', false) });
  // 与探索 / 扮演 / 今日同一套括号（渲染层只输出 title，括号由生成器自己带）
  assert.equal(full.title, '【遭遇 · 老码头 · 雾天】');
  assert.ok(full.context.includes(species.perception.full));
  /*
   * M2.9：全序列层的菜单多了最后一项「动手」（战斗入口）。
   * 断言拆成两段而不是改成一个更长的数组 —— 因为两段守的是**不同**的东西：
   *   前一段：M2.8 的四个动作各自对应哪条完整指令（原样，一个字没改）
   *   后一段：M2.9 追加的那一项是什么、摆在哪个位置
   */
  assert.deepEqual(
    full.options.slice(0, 3).map((option) => option.command),
    ['遭遇 观察', '遭遇 对峙', '遭遇 互动'],
    '每个选项的 command 必须是完整指令原文（菜单只是入口）',
  );
  assert.deepEqual(
    full.options.slice(3).map((option) => option.command),
    ['战斗 开始'],
    'M2.9：看清了就可以动手，而且它排在最后一位（不该是手滑点到的那个）',
  );
  assert.deepEqual(full.options.map((option) => option.key), ['1', '2', '3', '4']);

  /*
   * 普通人：**观察 / 撤退 / 站着不动**（M2.87 起是三个）。
   *
   * 原来只有后两个，而原注释写的理由是「他连那是什么都不知道」——
   * 那个理由**是对的**（他确实不知道），但它推出的结论错了：
   * 「不知道那是什么」不等于「不能看」。**凡人看得见、也记得住**，
   * 他只是叫不出名字 —— 而这正是凡人被卷入非凡世界的第一种方式。
   *
   * 用户实机看到的后果：两个选项都零效果，遭遇读完没有任何变化。
   */
  const mortal = buildEncounterMenu({
    ...base,
    text: species.perception.blur,
    layer: 'blur',
    mortal: true,
    allowedActions: allowedActionsOf('blur', true),
  });
  assert.deepEqual(mortal.options.map((option) => option.label), ['观察', '撤退', '站着不动']);
  // 每个选项都必须是完整指令原文（凡人这条路上也一样）
  assert.deepEqual(
    mortal.options.map((option) => option.command),
    ['遭遇 观察', '遭遇 撤退', '遭遇 站着不动'],
    '凡人的三个选项同样要是完整指令原文',
  );

  // 强 1—2 级：同一件事实说法不同（conform → 驱逐）
  const advantage = buildEncounterMenu({ ...base, layer: 'advantage', allowedActions: allowedActionsOf('advantage', false) });
  assert.deepEqual(advantage.options.map((option) => option.label), ['观察', '驱逐', '互动', '动手']);

  // 强 3 级及以上：观察本质
  const essence = buildEncounterMenu({ ...base, layer: 'essence', allowedActions: allowedActionsOf('essence', false) });
  assert.deepEqual(essence.options.map((option) => option.label), ['观察本质', '互动', '动手']);

  // 弱 1—2 级（看得到轮廓）：**有「动手」** —— 这是 M2.9 唯一真正可得的战斗入口
  const silhouette = buildEncounterMenu({
    ...base,
    layer: 'silhouette',
    allowedActions: allowedActionsOf('silhouette', false),
  });
  assert.deepEqual(silhouette.options.map((option) => option.label), ['观察', '撤退', '动手']);

  // 只看到模糊一团 / 普通人：**没有「动手」**（连那是个活物都谈不上）
  const blur = buildEncounterMenu({ ...base, layer: 'blur', allowedActions: allowedActionsOf('blur', false) });
  assert.deepEqual(blur.options.map((option) => option.label), ['撤退']);
});

/**
 * M2.9 改写了这条断言（原话是「遭遇菜单：没有攻击选项（M2.8 不做战斗）」）。
 *
 * 它守的那条约束**到期了**：M2.8 不做战斗，M2.9 就是战斗。
 * 门槛是 **silhouette 及以上**（见 encounter-menu.ts 里那段实测修正的说明：
 * 任务书 §4.7 写的 full 在实测里只占 1.6%，照做会得到 0 场战斗）。
 * 而 `blur` 与普通人**依然没有「动手」** —— 那条一个字没动。
 *
 * 另外必须守住：四个遭遇动作里**一个战斗语义都没有**（动手是独立的一项）。
 * 否则「对峙」会慢慢长成「攻击」，而那是 M2.8 明确不做的越权。
 */
test('遭遇菜单：动手选项只在 silhouette 以上出现，四个遭遇动作里没有任何战斗语义', () => {
  for (const layer of ['blur', 'silhouette', 'full', 'advantage', 'essence'] as PerceptionLayer[]) {
    for (const mortal of [true, false]) {
      const menu = buildEncounterMenu({
        locationName: '某处',
        weatherLabel: '夜',
        text: 'x',
        layer,
        behaviorText: null,
        mortal,
        allowedActions: allowedActionsOf(layer, mortal),
      });
      const fight = menu.options.filter((option) => option.command === '战斗 开始');
      const expectFight = canStartBattle(layer, mortal);
      assert.equal(fight.length, expectFight ? 1 : 0, `${layer} / mortal=${mortal} 的动手选项`);
      if (expectFight) {
        assert.equal(menu.options.at(-1)?.command, '战斗 开始', '动手永远是最后一项');
      }
      // 四个遭遇动作本身：一个战斗语义都不许有
      for (const option of menu.options.filter((entry) => entry.command.startsWith('遭遇 '))) {
        assert.ok(!/攻击|战斗|杀|打/.test(option.label), `遭遇动作里出现了战斗语义：${option.label}`);
        assert.ok(!/攻击|战斗|杀|打/.test(option.command));
      }
    }
  }
});

/* ================================================================== *
 * 六、数值与内容索引
 * ================================================================== */

test('数值：感知分层的阈值自洽（弱 3 < 弱 1—2 < 同序列 < 强 1—2 < 强 3）', () => {
  const p = CREATURE.perception;
  assert.ok(p.weak3 < p.weak12);
  assert.ok(p.weak12 < p.equal);
  assert.ok(p.equal < p.strong12);
  assert.ok(p.strong12 < p.strong3);
  assert.equal(p.equal, 0, '同序列的 delta 必须是 0');
});

test('内容索引：每个地点都能查到可能有哪几种生物', () => {
  assert.equal(INDEX.count(), SPECIES.length);
  const dock = INDEX.atLocation('old_dock');
  assert.ok(dock.length > 0, '老码头应当有生物');
  assert.ok(INDEX.hasAtLocation('old_dock'));
  assert.ok(!INDEX.hasAtLocation('这个地方不存在'));
  assert.equal(INDEX.byId('whisperer')?.name, '低语者');
  assert.equal(INDEX.byId('nope'), null);
});

test('内容索引：每个能出生的城市都有至少一种生物落脚', () => {
  /*
   * 这条守的是「内容表把某座城漏了」——它不会报错，只会让那里的玩家一辈子遇不到生物。
   * M2.8 写内容时正是这条抓到了普利兹港（出生权重 20，却一个物种都没有）。
   */
  const { cities } = loadCities();
  const birthCities = cities.filter((city) => city.birth_weight > 0);
  assert.ok(birthCities.length > 0);
  for (const city of birthCities) {
    const reachable = SPECIES.filter((species) =>
      species.habitat.some((locationId) => city.locations.includes(locationId)),
    );
    assert.ok(reachable.length > 0, `${city.id} 是出生城市，却没有任何物种落脚`);
  }
});
