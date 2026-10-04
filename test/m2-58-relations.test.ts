/**
 * M2.58 阶段一：生态关系网（物种 → 物种）。
 *
 * 这一份守的是「物种之间第一次有了关系」这件事，以及它的**兼容性**：
 *
 *   1. 关系命中时吃得到 —— 哪怕序列差本来不够（这正是关系网存在的理由）；
 *   2. 关系是**纯加法** —— 它只加边，不删边（序列差仍然是兜底）；
 *   3. **不写 relations 的物种行为逐位不变**（用户拍板的「不排斥现有数据」）；
 *   4. prey 是**唯一权威** —— predators 不参与判定（否则会出现双向捕食）；
 *   5. 内容表里 11 个物种的关系引用都指向真实存在的物种（loader 启动校验）。
 *
 * 第 3、4 两条各自的来处：
 *   - 第 3 条：第一版实现让关系网**取代**序列差，既有测试当场红了一条，
 *     根因是「关系网按物种声明、而生物按地点分布」，关门会让大批物种失去全部猎物。
 *   - 第 4 条：第二版让 predators 也参与判定，测试报 feeds.length 2 !== 1 ——
 *     一对物种互相捕食了。两次都是既有测试先发现的，所以这两条必须留在文件里。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CREATURE } from '../src/config/numeric.ts';
import { loadCreatures } from '../src/data/loader.ts';
import {
  canPreyOn,
  spawnInitialCreatures,
  tickCreatures,
  type Creature,
  type CreatureRelations,
  type CreatureSpecies,
} from '../src/domain/creature/index.ts';
import { createSeededRng } from '../src/domain/rng.ts';

const HOUR = 3_600_000;

const { creatures: SPECIES, issues: SPECIES_ISSUES } = loadCreatures();
const BY_ID = new Map(SPECIES.map((species: CreatureSpecies) => [species.id, species]));

function speciesOf(id: string): CreatureSpecies {
  const found = BY_ID.get(id);
  assert.ok(found, '内容表里没有物种 ' + id);
  return found;
}

/** 掷骰脚本：按给定序列依次返回，用完之后返回 0（与 m2-8.test.ts 同一手法） */
function scriptedRng(values: number[]): { next(): number } {
  let index = 0;
  return { next: () => values[index++] ?? 0 };
}

function makeCreature(species: CreatureSpecies, patch: Partial<Creature> = {}): Creature {
  return {
    id: species.id + '-test',
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

/** 造一个只在测试里存在的物种：显式控制 relations，不依赖内容表当前写了什么 */
function fakeSpecies(
  id: string,
  baseSequence: number,
  relations: CreatureRelations | undefined,
  habitat: string[] = ['test_loc'],
): CreatureSpecies {
  return {
    id,
    name: id,
    baseSequence,
    habitat,
    pathwayAffinity: [],
    drops: [],
    behaviors: [],
    habits: [],
    ...(relations === undefined ? {} : { relations }),
    tickRate: 'hourly',
    baseHp: 40,
    perception: { blur: 'b', silhouette: 's', full: 'f', advantage: 'a', essence: 'e' },
    flavor: '',
  };
}

/* ================================================================== *
 * 一、canPreyOn：关系命中看的是 prey，不是序列差
 * ================================================================== */

test('M2.58 关系网：关系命中时吃得到 —— 哪怕序列差本来不够', () => {
  // 序列 8 吃序列 9：只差 1 级，远低于 predatorSeqGap=3 —— 旧规则下必吃不到。
  // 这正是「雾鸦（8）吃普通乌鸦（9）」的形状，也是关系网存在的理由。
  const hawk = fakeSpecies('hawk', 8, {
    role: 'consumer', prey: ['sparrow'], predators: [], symbiosis: [], parasite: [],
  });
  const sparrow = fakeSpecies('sparrow', 9, {
    role: 'consumer', prey: [], predators: ['hawk'], symbiosis: [], parasite: [],
  });
  assert.ok(
    sparrow.baseSequence - hawk.baseSequence < CREATURE.ecology.predatorSeqGap,
    '这条用例的前提是序列差不足 —— 前提不成立时它测的就不是关系网了',
  );
  assert.equal(
    canPreyOn(hawk, sparrow, sparrow.baseSequence, hawk.baseSequence),
    true,
    '声明了吃它就该吃得到，与序列差无关',
  );
  // 反向：没声明的方向吃不到（sparrow 的 prey 是空的）
  assert.equal(
    canPreyOn(sparrow, hawk, hawk.baseSequence, sparrow.baseSequence),
    false,
    '没声明就不能反向吃 —— 关系是有方向的',
  );
});

test('M2.58 关系网：prey 是唯一权威 —— predators 不参与判定（防双向捕食）', () => {
  /*
   * 这条守的是一个真实踩过的坑：第二版实现让 predators 也参与判定，
   * 于是「A 吃 B」与「B 的 predators 里有 A」被当成两件事，一对物种互相捕食。
   * 下面这个构造正是它的最小复现：B 的 predators 点名了 A，但 A 从没声明吃 B。
   */
  const a = fakeSpecies('a', 9, {
    role: 'consumer', prey: [], predators: [], symbiosis: [], parasite: [],
  });
  const b = fakeSpecies('b', 8, {
    role: 'consumer', prey: [], predators: ['a'], symbiosis: [], parasite: [],
  });
  assert.equal(
    canPreyOn(a, b, b.baseSequence, a.baseSequence),
    false,
    'a 的 prey 里没有 b —— 只看 predators 就会误判成吃得到',
  );
});

test('M2.58 关系网：不写 relations 的物种逐位沿用 M2.8 的序列差规则', () => {
  const strong = fakeSpecies('strong', 5, undefined);
  const weak = fakeSpecies('weak', 9, undefined);
  const near = fakeSpecies('near', 7, undefined);
  // 差值 4 >= predatorSeqGap：吃得到（旧行为）
  assert.equal(canPreyOn(strong, weak, weak.baseSequence, strong.baseSequence), true);
  // 差值 2 < predatorSeqGap：吃不到（旧行为）
  assert.equal(canPreyOn(near, weak, weak.baseSequence, near.baseSequence), false);
  // 关系字段缺省与显式空关系对判定等价（纯加法的推论）
  const empty = fakeSpecies('empty', 5, {
    role: 'consumer', prey: [], predators: [], symbiosis: [], parasite: [],
  });
  assert.equal(
    canPreyOn(empty, weak, weak.baseSequence, empty.baseSequence),
    canPreyOn(strong, weak, weak.baseSequence, strong.baseSequence),
    '空关系与没有关系必须同一条路径 —— 否则同一个物种会因为「内容表写没写这一段」而行为不同',
  );
});

test('M2.58 关系网：纯加法 —— 关系网只加边，不删边', () => {
  /*
   * 关系命中时吃得到（第 1 条），而**关系没命中时不会因此吃不到**：
   * 序列差够就照吃。这就是与第一版「取代序列差」的分野。
   */
  const declared = fakeSpecies('declared', 5, {
    role: 'consumer', prey: ['someone_else'], predators: [], symbiosis: [], parasite: [],
  });
  const stranger = fakeSpecies('stranger', 9, undefined);
  assert.ok(
    stranger.baseSequence - declared.baseSequence >= CREATURE.ecology.predatorSeqGap,
  );
  assert.equal(
    canPreyOn(declared, stranger, stranger.baseSequence, declared.baseSequence),
    true,
    '声明过关系不等于对其它物种关门 —— 序列差仍然是兜底（第一版在这里红过测试）',
  );
});

/* ================================================================== *
 * 二、生态 tick 集成：关系真的改变了世界在动的方式
 * ================================================================== */

test('M2.58 关系网：生态 tick 里关系命中会产生一次真实捕食', () => {
  const hawk = fakeSpecies('hawk_t', 8, {
    role: 'consumer', prey: ['sparrow_t'], predators: [], symbiosis: [], parasite: [],
  }, ['loc_t']);
  const sparrow = fakeSpecies('sparrow_t', 9, {
    role: 'consumer', prey: [], predators: ['hawk_t'], symbiosis: [], parasite: [],
  }, ['loc_t']);
  assert.ok(sparrow.baseSequence - hawk.baseSequence < CREATURE.ecology.predatorSeqGap);

  const predator = makeCreature(hawk, {
    id: 'pred_t', locationId: 'loc_t', hp: 20, maxHp: 40, lastFedAt: 0, spawnedAt: 0,
  });
  const prey = makeCreature(sparrow, { id: 'prey_t', locationId: 'loc_t' });
  const world = {
    speciesById: new Map([[hawk.id, hawk], [sparrow.id, sparrow]]),
    locationIds: ['loc_t'],
    now: CREATURE.ecology.feedThresholdHours * HOUR + HOUR,
    hours: 1,
  };
  const result = tickCreatures([predator, prey], world, scriptedRng([0.99, 0.5]));
  assert.equal(result.feeds.length, 1, '关系命中就该在 tick 里真的吃一次');
  assert.equal(result.feeds[0]!.predatorId, 'pred_t');
  assert.equal(result.feeds[0]!.preyId, 'prey_t');
  const after = result.creatures.find((c) => c.id === 'pred_t')!;
  assert.ok(after.hp > predator.hp, '捕食之后要回血');
  assert.equal(after.feedCount, 1, '捕食次数要记着（进化条件之一）');
});

test('M2.58 关系网：一对物种不会互相捕食（tick 层面的回归）', () => {
  /*
   * 与上面 canPreyOn 那条同一件事，但走完整的 tick：
   * 双向捕食在 tick 里的表现是 feeds.length 变成 2（两次都吃成了）。
   */
  // 同级（都是序列 8）：同级捕食是常态，不能被任何门槛挡掉
  const a = fakeSpecies('aa', 8, {
    role: 'consumer', prey: ['bb'], predators: [], symbiosis: [], parasite: [],
  }, ['loc_x']);
  const b = fakeSpecies('bb', 8, {
    role: 'consumer', prey: [], predators: ['aa'], symbiosis: [], parasite: [],
  }, ['loc_x']);
  const one = makeCreature(a, { id: 'one', locationId: 'loc_x', hp: 20, maxHp: 40, lastFedAt: 0, spawnedAt: 0 });
  const two = makeCreature(b, { id: 'two', locationId: 'loc_x', hp: 20, maxHp: 40, lastFedAt: 0, spawnedAt: 0 });
  const world = {
    speciesById: new Map([[a.id, a], [b.id, b]]),
    locationIds: ['loc_x'],
    now: CREATURE.ecology.feedThresholdHours * HOUR + HOUR,
    hours: 1,
  };
  const result = tickCreatures([one, two], world, scriptedRng([0.99, 0.5, 0.99, 0.5]));
  assert.equal(result.feeds.length, 1, '单向关系只能吃一次 —— 2 次就是双向捕食');
  assert.equal(result.feeds[0]!.predatorId, 'one', '吃的一方必须是声明了 prey 的那个');
});

/* ================================================================== *
 * 三、内容表（真实数据）
 * ================================================================== */

test('M2.58 内容表：11 个物种都声明了关系，且引用都指向真实存在的物种', () => {
  assert.ok(SPECIES.length >= 11, '物种数不该比 M2.8 的 11 少，当前 ' + SPECIES.length);
  const ids = new Set(SPECIES.map((species) => species.id));
  const missing: string[] = [];
  for (const species of SPECIES as CreatureSpecies[]) {
    if (species.relations === undefined) { missing.push(species.id + ': 没有 relations'); continue; }
    const lists: Array<[string, readonly string[]]> = [
      ['prey', species.relations.prey],
      ['predators', species.relations.predators],
      ['symbiosis', species.relations.symbiosis],
      ['parasite', species.relations.parasite],
    ];
    for (const [field, list] of lists) {
      for (const other of list) {
        if (!ids.has(other)) missing.push(species.id + '.' + field + ' -> ' + other + '（物种不存在）');
        if (other === species.id) missing.push(species.id + '.' + field + ' 自引用');
      }
    }
  }
  assert.deepEqual(missing, [], '关系引用必须全部指向真实物种');
});

test('M2.58 内容表：每个物种至少有 3 条关系（吃谁 / 被谁吃 / 共生或寄生）', () => {
  /*
   * 这是用户给的设计约束原文：「每个物种至少挂 3 个关系」。
   * 少于 3 条 = 它在生态网里几乎是个孤立点，而那正是 M2.58 要修的病。
   */
  const thin: string[] = [];
  for (const species of SPECIES as CreatureSpecies[]) {
    const relations = species.relations;
    assert.ok(relations, species.id + ' 没有 relations');
    const total =
      relations.prey.length + relations.predators.length +
      relations.symbiosis.length + relations.parasite.length;
    if (total < 3) thin.push(species.id + ': 只有 ' + total + ' 条边');
  }
  assert.deepEqual(thin, [], '每个物种至少 3 条生态关系');
});

test('M2.58 内容表：prey 与 predators 双向一致（防止两条边只在一边写着）', () => {
  const inconsistent: string[] = [];
  for (const species of SPECIES as CreatureSpecies[]) {
    const relations = species.relations;
    if (relations === undefined) continue;
    for (const preyId of relations.prey) {
      const back = BY_ID.get(preyId)?.relations?.predators ?? [];
      if (!back.includes(species.id)) {
        inconsistent.push(species.id + ' 吃 ' + preyId + '，但 ' + preyId + '.predators 里没有它');
      }
    }
  }
  assert.deepEqual(inconsistent, [], 'prey 与 predators 必须互相印证');
});

test('M2.58 内容表：loader 的启动校验在真实内容上不报关系相关的错', () => {
  /*
   * 与 M2.35 同一条纪律：判据在真实内容上必须**安静**，否则它只是噪声源。
   * 这里只看关系相关的那几类 message，避免与其它校验的既有告警耦合。
   */
  const related = SPECIES_ISSUES.filter((issue: { level: string; message: string }) =>
    /relations\.|relations 但|声明吃/.test(issue.message),
  );
  assert.deepEqual(
    related.map((issue: { level: string; message: string }) => issue.message),
    [],
    '真实内容上关系校验不该报任何东西',
  );
  const errors = related.filter((issue: { level: string; message: string }) => issue.level === 'error');
  assert.equal(errors.length, 0);
});

test('M2.58 内容表：关系网不改变初始播种（播种只看栖息地与序列系数）', () => {
  /*
   * 「不排斥现有数据」的另一面：加了关系网之后，世界**初始化**必须一模一样。
   * 播种读的是 habitat 与 spawnSequenceBonus，与 relations 无关 ——
   * 这条断言把它钉住，防止以后有人把关系混进播种。
   */
  const before = spawnInitialCreatures(SPECIES, createSeededRng('m2-58-spawn'), 0);
  const stripped = SPECIES.map((species: CreatureSpecies) => {
    const { relations, ...rest } = species;
    void relations;
    return rest as CreatureSpecies;
  });
  const after = spawnInitialCreatures(stripped, createSeededRng('m2-58-spawn'), 0);
  assert.deepEqual(after, before, '去掉 relations 之后播种结果必须逐位相同');
  assert.ok(before.length > 0, '播种不能是空的 —— 否则这条断言什么也没测');
});
