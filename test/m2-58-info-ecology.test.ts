/**
 * M2.58 阶段三：信息生态（目击 → 传闻 → 恐慌 → 抑制繁衍）。
 *
 * 这一份守的是「生态与信息真的咬合了」这件事：
 *
 *   1. **隐秘度决定传不传得出去** —— 城里藏不住，地下墓穴几乎没人知道；
 *   2. **恐慌会累积也会衰减** —— 有涨有落的量，不是单调计数器；
 *   3. **恐慌抑制繁衍** —— 这是闭环的那一半：信息反过来影响物种生存；
 *   4. **没登记在任何域里的地点什么都不做** —— 兼容落点；
 *   5. **恐慌为 0 时逐位等于阶段二** —— 同样是兼容落点。
 *
 * 第 3 条是这一阶段区别于「单向播报」的地方：
 * 没有它，目击只是多了一条世界事件，物种该生还是生。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadContent } from '../src/data/loader.ts';
import { spawnInitialCreatures, tickCreatures, type CreatureSpecies } from '../src/domain/creature/index.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import {
  ZoneIndex,
  decayFear,
  fearDeltaOf,
  fearLevelOf,
  fearReproduceFactor,
  resolveEcologyParams,
  rumorChanceOf,
  type ResolvedEcologyParams,
} from '../src/domain/world/zone.ts';

const HOUR = 3_600_000;
const CONTENT = loadContent();
const ZONES = CONTENT.zones;
const SPECIES = CONTENT.creatures;
const ZONE_INDEX = new ZoneIndex(ZONES);

function paramsWith(patch: Partial<ResolvedEcologyParams> = {}): ResolvedEcologyParams {
  return { ...resolveEcologyParams(undefined), ...patch };
}

/* ================================================================== *
 * 一、传播概率：隐秘度决定传不传得出去
 * ================================================================== */

test('M2.58 信息生态：隐秘度越高，目击越传不出去', () => {
  const params = paramsWith();
  const open = rumorChanceOf(params, 0);
  const mid = rumorChanceOf(params, 0.5);
  const secret = rumorChanceOf(params, 1);
  assert.ok(open > mid, '不隐秘的地方比一般地方更容易传出去：' + open + ' vs ' + mid);
  assert.ok(mid > secret, '一般地方比极隐秘的地方更容易传出去：' + mid + ' vs ' + secret);
  assert.equal(secret, 0, '隐秘度满值 = 完全传不出去');
  assert.ok(open > 0 && open <= 1, '概率必须在 (0, 1] 内，当前 ' + open);
});

test('M2.58 信息生态：没配 hidden 的域用中性默认值，而不是「一律传出去」', () => {
  /*
   * 这一条守的是一个很容易写错的方向：
   * 如果缺省 hidden 被当成 0，那么**什么都没配的域反而最吵** ——
   * 一个「不写参数最有戏剧性」的默认值是错的。
   */
  const params = paramsWith();
  const missing = rumorChanceOf(params, undefined);
  assert.ok(missing > 0, '缺省不能是「完全传不出去」');
  assert.ok(missing < rumorChanceOf(params, 0), '缺省也不能是「一律传出去」—— 那比不写更吵');
});

test('M2.58 信息生态：隐秘度越高，传出去的那一次越吓人', () => {
  const open = fearDeltaOf(0);
  const secret = fearDeltaOf(1);
  assert.ok(secret > open, '少而重的传闻比天天见的东西更吓人：' + secret + ' vs ' + open);
  assert.ok(open > 0 && secret <= 0.2, '单次涨幅要小 —— 恐慌是靠次数攒起来的');
});

/* ================================================================== *
 * 二、恐慌：累积、衰减、合成
 * ================================================================== */

test('M2.58 信息生态：恐慌会衰减 —— 是有涨有落的量，不是单调计数器', () => {
  const start = 0.8;
  const afterHour = decayFear(start, 1);
  const afterDay = decayFear(start, 24);
  assert.ok(afterHour < start, '一小时后就该掉一点：' + start + ' -> ' + afterHour);
  assert.ok(afterHour > afterDay, '衰减是累积的：一天后比一小时后更低');
  assert.ok(afterDay > 0, '一天之后不该归零 —— 恐慌不是开关');
  assert.equal(decayFear(0, 10), 0, '0 衰减还是 0');
  assert.equal(decayFear(start, 0), start, '0 小时不变');
});

test('M2.58 信息生态：域恐慌 = 基线气质 + 累积，并夹在 0—1', () => {
  assert.equal(fearLevelOf(0.2, 0.3), 0.5, '两者相加');
  assert.equal(fearLevelOf(0.8, 0.8), 1, '超过 1 要夹住');
  assert.equal(fearLevelOf(undefined, 0.4), 0.4, '没配基线的域只用累积值');
  assert.equal(fearLevelOf(undefined, 0), 0, '都没配就是 0');
});

test('M2.58 信息生态：恐慌抑制繁衍，且恐慌为 0 时倍率恰好是 1', () => {
  assert.equal(fearReproduceFactor(0), 1, '恐慌 0 不加抑制 —— 这是与阶段二逐位相同的保证');
  assert.ok(fearReproduceFactor(0.5) < 1, '恐慌过半要真的压住繁衍');
  assert.ok(fearReproduceFactor(1) < fearReproduceFactor(0.5), '越慌压得越狠');
  assert.ok(fearReproduceFactor(1) > 0, '压到 0 就等于灭绝 —— 那不是抑制，是开关');
});

/* ================================================================== *
 * 三、生态闭环：恐慌真的改变了世界
 * ================================================================== */

test('M2.58 信息生态：恐慌抑制繁衍 —— 同样的种子，慌的地方生得少', () => {
  /*
   * 这是整阶段的验收核心：**信息反过来影响物种生存**。
   * 造两次完全相同的 tick，只有 fear 不同，繁衍次数必须不同。
   */
  const byId = new Map(SPECIES.map((species: CreatureSpecies) => [species.id, species]));
  const locationIds = [...new Set(SPECIES.flatMap((species) => species.habitat))];
  const starters = spawnInitialCreatures(SPECIES, createSeededRng('m2-58-info-spawn'), 0);
  // 只保留群居物种（只有它们会繁衍），让信号不被别的行为淹没
  const social = new Set(SPECIES.filter((s) => s.habits.includes('social')).map((s) => s.id));
  const only = starters.filter((c) => social.has(c.speciesId)).map((c) => ({ ...c }));
  assert.ok(only.length > 0, '内容表里必须有群居物种 —— 否则这条用例什么也没测');

  const run = (fear: number) =>
    tickCreatures(
      only.map((c) => ({ ...c })),
      {
        speciesById: byId,
        locationIds,
        zoneOf: () => paramsWith({ fear, reproduceMultiplier: 1 }),
        now: 12 * HOUR,
        hours: 240,
      },
      createSeededRng('m2-58-info-run'),
    );
  const calm = run(0);
  const scared = run(1);
  assert.ok(
    scared.births.length < calm.births.length,
    '恐慌满值的地方繁衍次数必须更少：' + calm.births.length + ' -> ' + scared.births.length,
  );
});

test('M2.58 信息生态：恐慌为 0 时生态逐位等于阶段二（不传 fear 的路径）', () => {
  const byId = new Map(SPECIES.map((species: CreatureSpecies) => [species.id, species]));
  const locationIds = [...new Set(SPECIES.flatMap((species) => species.habitat))];
  const starters = spawnInitialCreatures(SPECIES, createSeededRng('m2-58-info-spawn'), 0);
  const run = (zoneOf: ((id: string) => ResolvedEcologyParams) | undefined) =>
    tickCreatures(
      starters.map((c) => ({ ...c })),
      {
        speciesById: byId,
        locationIds,
        ...(zoneOf === undefined ? {} : { zoneOf }),
        now: 12 * HOUR,
        hours: 24,
      },
      createSeededRng('m2-58-info-compat'),
    );
  const bare = run(undefined);
  const zeroFear = run(() => paramsWith({ fear: 0 }));
  assert.deepEqual(
    zeroFear.creatures,
    bare.creatures,
    '恐慌为 0 的域必须与完全不用域参数逐位相同',
  );
});

/* ================================================================== *
 * 四、内容表：真实域的隐秘度分布合理
 * ================================================================== */

test('M2.58 信息生态：真实内容表里，最隐秘的域确实传不出去', () => {
  const params = paramsWith();
  const secret = ZONES.filter((zone) => (zone.hidden ?? 0) >= 0.9);
  const open = ZONES.filter((zone) => (zone.hidden ?? 1) <= 0.5);
  assert.ok(secret.length > 0, '内容表里应当有高隐秘度的域（地下墓穴 / 灵界重叠区）');
  assert.ok(open.length > 0, '也应当有低隐秘度的域（港口 / 城市），否则永远是同一个结果');
  for (const zone of secret) {
    assert.ok(
      rumorChanceOf(params, zone.hidden) < 0.1,
      zone.id + ' 隐秘度 ' + zone.hidden + ' 却还很容易传出去',
    );
  }
});

test('M2.58 信息生态：没登记在任何域里的地点不做任何事（兼容落点）', () => {
  assert.equal(ZONE_INDEX.of('这个地点不存在'), undefined);
  // 生态 tick 对没登记的域拿到的是全局基线 —— fear 为 0，不抑制繁衍
  const params = ZONE_INDEX.paramsOf('这个地点不存在');
  assert.equal(params.fear, 0);
  assert.equal(fearReproduceFactor(params.fear), 1);
});
