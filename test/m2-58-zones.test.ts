/**
 * M2.58 阶段二：生态域（地点分组 + 域参数）。
 *
 * 这一份守的是「不同地方的世界不一样」这件事，以及它的**兼容性**：
 *
 *   1. 内容表：6 个域覆盖全部 58 个地点，无重复、无悬空引用；
 *   2. 索引：地点 → 域 → 有效参数，没登记的地点回落到全局基线；
 *   3. **不传 zoneOf 时生态 tick 逐位等于加这一层之前**（兼容落点）；
 *   4. **传了 zoneOf 时不同域的行为真的不同**（这一层存在的理由）；
 *   5. 参数解析：域没写的键取全局基线，写了的键生效。
 *
 * 第 3 条是「不排斥现有数据」的第二次兑现，第 4 条是这一层的验收本身 ——
 * 两条缺一条，这个阶段就没有意义（只有 1—3 就成了一个永远不生效的开关）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CREATURE } from '../src/config/numeric.ts';
import { loadContent, loadZones } from '../src/data/loader.ts';
import { spawnInitialCreatures, tickCreatures, type CreatureSpecies } from '../src/domain/creature/index.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import {
  ZoneIndex,
  resolveEcologyParams,
  spiritualityActivity,
  pollutionDecay,
  type ResolvedEcologyParams,
  type Zone,
} from '../src/domain/world/zone.ts';

const HOUR = 3_600_000;

const CONTENT = loadContent();
const ZONES = CONTENT.zones;
const LOCATIONS = CONTENT.locations;
const SPECIES = CONTENT.creatures;
const ZONE_INDEX = new ZoneIndex(ZONES);

/** 造一个最小的域（只用来测参数解析，不依赖内容表当前写了什么） */
function fakeZone(patch: Partial<Zone> = {}): Zone {
  return { id: 'z', name: 'z', description: '', locations: ['loc_a'], ...patch };
}

/* ================================================================== *
 * 一、内容表（真实数据）
 * ================================================================== */

test('M2.58 生态域：6 个域覆盖全部 58 个地点，且没有地点被登记两次', () => {
  assert.equal(ZONES.length, 6, '域数应当是 6 —— 内容表改了要先想清楚为什么');
  const all = ZONES.flatMap((zone) => zone.locations);
  assert.equal(all.length, new Set(all).size, '同一个地点不能被两个域登记（loader 也会报）');
  const known = new Set(LOCATIONS.map((location) => location.id));
  for (const id of all) assert.ok(known.has(id), '域引用了不存在的地点：' + id);
  assert.equal(
    all.length,
    known.size,
    '每个地点都要落在某个域里，否则它在生态上是一个没有脾气的地方',
  );
});

test('M2.58 生态域：loader 在真实内容上不报生态域相关的错', () => {
  const related = CONTENT.issues.filter((issue) => /域 |同时被两个域登记/.test(issue.message));
  assert.deepEqual(related.map((issue) => issue.message), [], '真实内容上生态域校验不该报任何东西');
});

test('M2.58 生态域：每个域的参数都在合法区间（比率 0—1、倍数非负）', () => {
  for (const zone of ZONES) {
    for (const key of ['spirituality', 'pollution', 'madness', 'hidden', 'order', 'fear'] as const) {
      const value = zone[key];
      if (value === undefined) continue;
      assert.ok(value >= 0 && value <= 1, zone.id + '.' + key + ' = ' + value + ' 超出 0—1');
    }
    for (const key of ['migrateMultiplier', 'reproduceMultiplier', 'replenishMultiplier', 'decayMultiplier'] as const) {
      const value = zone[key];
      if (value === undefined) continue;
      assert.ok(value >= 0, zone.id + '.' + key + ' 不能为负');
    }
    if (zone.carryingCapacity !== undefined) {
      assert.ok(Number.isInteger(zone.carryingCapacity) && zone.carryingCapacity > 0);
    }
  }
});

/* ================================================================== *
 * 二、索引与参数解析
 * ================================================================== */

test('M2.58 生态域：没登记在任何域里的地点回落到全局基线', () => {
  const params = ZONE_INDEX.paramsOf('这个地点不存在');
  const base = CREATURE.ecology;
  assert.equal(params.carryingCapacity, base.capPerLocation);
  assert.equal(params.migrateMultiplier, 1);
  assert.equal(params.reproduceMultiplier, 1);
  assert.equal(params.replenishMultiplier, 1);
  assert.equal(params.decayMultiplier, 1);
  assert.equal(params.spirituality, 0);
  assert.equal(params.pollution, 0);
  assert.equal(ZONE_INDEX.of('这个地点不存在'), undefined);
});

test('M2.58 生态域：域没写的键取全局基线，写了的键生效', () => {
  const params = resolveEcologyParams(fakeZone({ decayMultiplier: 2.5 }));
  assert.equal(params.decayMultiplier, 2.5, '写了的键要生效');
  assert.equal(params.carryingCapacity, CREATURE.ecology.capPerLocation, '没写的键回落基线');
  assert.equal(params.migrateMultiplier, 1);
  assert.equal(params.spirituality, 0);
  const bare = resolveEcologyParams(undefined);
  assert.equal(bare.decayMultiplier, 1);
  assert.equal(bare.carryingCapacity, CREATURE.ecology.capPerLocation);
});

test('M2.58 生态域：灵性与污染的比例被换算成倍率，基线为 1', () => {
  const none = resolveEcologyParams(undefined);
  assert.equal(spiritualityActivity(none), 1, '灵性 0 时不加成（与加这一层之前相同）');
  assert.equal(pollutionDecay(none), 1, '污染 0 时不加成');
  const full = resolveEcologyParams(fakeZone({ spirituality: 1, pollution: 1 }));
  assert.ok(spiritualityActivity(full) > 1, '灵性满值必须真的抬活跃度');
  assert.ok(pollutionDecay(full) > 1, '污染满值必须真的加快衰亡');
});

/* ================================================================== *
 * 三、生态 tick：兼容性与差异（这一层的两个验收面）
 * ================================================================== */

/** 跑一次生态 tick；zoneOf 为 undefined 时就是加这一层之前 */
function runEcology(zoneOf?: (id: string) => ResolvedEcologyParams, hours = 12) {
  const byId = new Map(SPECIES.map((species: CreatureSpecies) => [species.id, species]));
  const locationIds = [...new Set(SPECIES.flatMap((species) => species.habitat))];
  const starters = spawnInitialCreatures(SPECIES, createSeededRng('m2-58-zone-spawn'), 0);
  return tickCreatures(
    starters,
    {
      speciesById: byId,
      locationIds,
      ...(zoneOf === undefined ? {} : { zoneOf }),
      now: 12 * HOUR,
      hours,
    },
    createSeededRng('m2-58-zone-run'),
  );
}

test('M2.58 生态域：不传 zoneOf 时生态逐位等于加这一层之前', () => {
  const bare = runEcology(undefined);
  const baseline = runEcology(() => resolveEcologyParams(undefined));
  assert.deepEqual(
    baseline.creatures,
    bare.creatures,
    '域表全空与不传 zoneOf 必须是同一件事',
  );
  assert.equal(baseline.migrations.length, bare.migrations.length);
  assert.equal(baseline.deaths.length, bare.deaths.length);
  assert.ok(bare.creatures.length > 0, '生态不能是空的 —— 否则这条断言什么也没测');
});

test('M2.58 生态域：两个参数相反的域会产生不同的生态（这一层存在的理由）', () => {
  const byId = new Map(SPECIES.map((species: CreatureSpecies) => [species.id, species]));
  const locationIds = [...new Set(SPECIES.flatMap((species) => species.habitat))];
  const starters = spawnInitialCreatures(SPECIES, createSeededRng('m2-58-zone-spawn'), 0);
  // M2.66：ResolvedEcologyParams 多了 madness / order（同样是域参数，基线 0 = 不改变任何东西）
  const calm: ResolvedEcologyParams = {
    carryingCapacity: 20, migrateMultiplier: 0.1, reproduceMultiplier: 2,
    replenishMultiplier: 1, decayMultiplier: 0.1, spirituality: 0, pollution: 0, fear: 0,
    madness: 0, order: 0,
  };
  const harsh: ResolvedEcologyParams = {
    carryingCapacity: 2, migrateMultiplier: 3, reproduceMultiplier: 0.2,
    replenishMultiplier: 1, decayMultiplier: 3, spirituality: 0, pollution: 1, fear: 0,
    madness: 1, order: 1,
  };
  const run = (params: ResolvedEcologyParams) =>
    tickCreatures(
      starters.map((c) => ({ ...c })),
      { speciesById: byId, locationIds, zoneOf: () => params, now: 12 * HOUR, hours: 48 },
      createSeededRng('m2-58-zone-diff'),
    );
  const a = run(calm);
  const b = run(harsh);
  const differ =
    a.migrations.length !== b.migrations.length ||
    a.deaths.length !== b.deaths.length ||
    a.births.length !== b.births.length ||
    a.creatures.length !== b.creatures.length;
  assert.ok(
    differ,
    '两个参数相反的域必须产生不同的生态 —— 结果相同说明域参数没接进判定：' +
      ' 迁移 ' + a.migrations.length + '/' + b.migrations.length +
      ' 死亡 ' + a.deaths.length + '/' + b.deaths.length +
      ' 繁衍 ' + a.births.length + '/' + b.births.length +
      ' 存活 ' + a.creatures.length + '/' + b.creatures.length,
  );
});

test('M2.58 生态域：真实内容表的域参数能被 ZoneIndex 正确解析', () => {
  const cityFog = ZONES.find((zone) => zone.id === 'city_fog');
  const underCrypt = ZONES.find((zone) => zone.id === 'under_crypt');
  assert.ok(cityFog && underCrypt, '内容表里应当有城市雾区与地下墓穴两个域');
  const city = ZONE_INDEX.paramsOf(cityFog.locations[0]!);
  const crypt = ZONE_INDEX.paramsOf(underCrypt.locations[0]!);
  assert.equal(city.migrateMultiplier, cityFog.migrateMultiplier);
  assert.equal(crypt.migrateMultiplier, underCrypt.migrateMultiplier);
  assert.notEqual(
    city.migrateMultiplier,
    crypt.migrateMultiplier,
    '城市与地下墓穴的迁移倍率本来就该不同（这正是这一层要表达的东西）',
  );
  assert.ok(crypt.migrateMultiplier < city.migrateMultiplier, '地下比城里留得住东西');
});

test('M2.58 生态域：空域表也能建索引（内容缺失时不许崩）', () => {
  const empty = new ZoneIndex([]);
  assert.equal(empty.zones.length, 0);
  assert.equal(empty.size, 0);
  assert.equal(empty.of('tingen'), undefined);
  assert.equal(empty.paramsOf('tingen').migrateMultiplier, 1, '空表一律回落基线');
});

test('M2.58 生态域：读不到 zones 文件时报问题而不是抛异常', () => {
  /*
   * 与 M2.35 同一条纪律：内容缺失时判据要说出来，不能静默返回空表 ——
   * 静默的话「生态域根本没用上」这件事在报告里和「域表是空的」长得一样。
   */
  const result = loadZones('不存在的文件.yaml', new Set(['loc_a']));
  assert.ok(result.issues.length > 0, '读不出文件时要报问题，不能静默返回空表');
  assert.equal(result.zones.length, 0);
});
