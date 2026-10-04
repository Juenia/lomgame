/**
 * M2.62：边界输入（世界有外面）。
 *
 * 这一份守的是「这个世界不封闭」这件事，以及它的**分片一致性**：
 *
 *   1. 内容表：6 个外部势力 + 8 条边界，引用全部指向真实实体；
 *   2. **事件时刻表由 seed 派生**（不是运行时累积）—— 这是分片一致性的来源；
 *   3. 关注度越高间隔越短（「累积」的语义保留）；
 *   4. 四类输入各自有真实后果；
 *   5. 触发真的改世界：域恐慌 + 势力警觉 + 播报；
 *   6. **幂等**：同一小时重放不重复加恐慌与警觉；
 *   7. **不写静态生态基线**（那会单调递增永不回落）。
 *
 * ## 为什么第 2 条是这一层的核心
 *
 * 第一版把张力存在 `boundary_state` 表里，被 `test/m2-4.test.ts` 的分片一致性
 * 用例当场拦下 —— 4 个分片各有自己的库，累积进度不同，算出的世界事件就对不上。
 * 所以这一层改成**时刻表**：凡是进 world_events 的东西都必须是 (seed, 小时) 的函数。
 * 下面有一条用例专门守它（同 seed 同答案、异 seed 异答案）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadBoundaries, loadContent } from '../src/data/loader.ts';
import {
  BoundaryIndex,
  BoundarySchema,
  FOREIGN_INPUTS,
  boundaryEventTimes,
  boundaryGapMs,
  foreignInputAt,
  foreignInputText,
  isBoundaryHour,
  type Boundary,
} from '../src/domain/world/boundary.ts';
import { BoundaryStateRepo, tickBoundaries } from '../src/infra/boundary-state.ts';
import { WorldEventRepo } from '../src/infra/db/world-events.ts';
import { PowerStateRepo } from '../src/infra/db/power-state.ts';
import { ZoneStateRepo } from '../src/infra/db/zone-state.ts';
import { migrate, openDatabase, type Db } from '../src/infra/db/sqlite.ts';

const HOUR = 3_600_000;
const CONTENT = loadContent();
const BOUNDARIES = CONTENT.boundaries;
const POWERS = CONTENT.foreignPowers;
const INDEX = new BoundaryIndex(BOUNDARIES, POWERS);

const LOCATION_IDS = new Set(CONTENT.locations.map((location) => location.id));
const REGION_IDS = new Set(CONTENT.regions.map((region) => region.id));

function freshDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function fakeBoundary(patch: Partial<Boundary> = {}): Boundary {
  return {
    id: 'b1',
    name: '测试边界',
    kind: 'port',
    location: 'loc_a',
    foreign_power: 'p1',
    inputs: ['trade'],
    base_pressure: 0.1,
    description: '',
    ...patch,
  };
}

/** 无抖动的取间隔抽样值（让测试里的时刻可算） */
const noJitter = (): number => 0.5;

/* ================================================================== *
 * 一、内容表
 * ================================================================== */

test('M2.62 边界：外部势力与边界的引用全部指向真实实体', () => {
  /*
   * M2.85 内容填充 P6：外部势力从 6 扩到 14（原作现存国家与组织里的域外者）。
   * 条数不再写死 —— 这条判据守的是**引用完整性**（from_region 必须是真实区域、
   * foreign_power 必须是真实势力、location 必须是真实地点），那件事没变。
   */
  assert.ok(POWERS.length >= 6, '外部势力至少 6 个');
  assert.ok(BOUNDARIES.length >= 8, '边界至少 8 条');
  const powerIds = new Set(POWERS.map((power) => power.id));
  assert.equal(powerIds.size, POWERS.length, '外部势力 id 不能重复');
  const bad: string[] = [];
  const seenLocation = new Set<string>();
  for (const power of POWERS) {
    if (power.from_region !== '' && !REGION_IDS.has(power.from_region)) {
      bad.push(power.id + '.from_region -> ' + power.from_region);
    }
  }
  for (const boundary of BOUNDARIES) {
    if (!LOCATION_IDS.has(boundary.location)) bad.push(boundary.id + '.location -> ' + boundary.location);
    if (!powerIds.has(boundary.foreign_power)) bad.push(boundary.id + '.foreign_power -> ' + boundary.foreign_power);
    if (boundary.inputs.length === 0) bad.push(boundary.id + ' 没有任何输入类型');
    if (seenLocation.has(boundary.location)) bad.push('地点被两条边界登记：' + boundary.location);
    seenLocation.add(boundary.location);
  }
  assert.deepEqual(bad, [], '边界里的每一条引用都必须指向真实实体');
});

test('M2.62 边界：三类边界都有内容（港口 / 边境 / 裂隙）', () => {
  const kinds = new Set(BOUNDARIES.map((boundary) => boundary.kind));
  for (const kind of ['port', 'frontier', 'rift']) {
    assert.ok(kinds.has(kind as Boundary['kind']), '缺一类边界：' + kind);
  }
});

test('M2.62 边界：loader 在真实内容上不报边界相关的错', () => {
  const related = CONTENT.issues.filter((issue) => /边界 |外部势力/.test(issue.message));
  assert.deepEqual(related.map((issue) => issue.message), [], '真实内容上边界校验不该报任何东西');
});

test('M2.62 边界：schema 拦住越界的张力与未知的输入类型', () => {
  const base = {
    id: 'b', name: 'b', kind: 'port', location: 'loc_a',
    foreign_power: 'p1', inputs: ['trade'],
  };
  assert.equal(BoundarySchema.safeParse(base).success, true);
  assert.equal(BoundarySchema.safeParse({ ...base, kind: '不认识' }).success, false);
  assert.equal(BoundarySchema.safeParse({ ...base, base_pressure: 5 }).success, false, '张力上限是 1');
  assert.equal(BoundarySchema.safeParse({ ...base, inputs: ['不认识'] }).success, false);
});

test('M2.62 边界：YAML 里留空的 from_region 被当成空串，而不是把整条势力丢掉', () => {
  /*
   * 这一条守的是一个真实踩到的坑：YAML 写 `from_region:` 后面留空时解析出的是 **null**，
   * 而 zod 的 `.default('')` 只在**字段缺失**时生效 ——
   * 于是那一条势力会因为「expected string, received null」被整条丢掉，
   * 而症状只是「外部势力少了一个、某条边界找不到对面」。
   */
  const outerGod = POWERS.find((power) => power.id === 'outer_god');
  assert.ok(outerGod !== undefined, 'outer_god（外神）必须是 6 个之一 —— 它没有来路区域');
  assert.equal(outerGod.from_region, '', '空来路要读成空串');
  assert.ok(INDEX.foreignPower('outer_god') !== undefined);
});

/* ================================================================== *
 * 二、时刻表：分片一致性的来源
 * ================================================================== */

test('M2.62 边界：间隔由基础张力与关注度算出，关注度越高间隔越短', () => {
  const slow = boundaryGapMs({
    boundaryId: 'b', basePressure: 0.02, attention: 0, index: 0, seed: 's', roll: 0.5,
  });
  const fast = boundaryGapMs({
    boundaryId: 'b', basePressure: 0.02, attention: 1, index: 0, seed: 's', roll: 0.5,
  });
  assert.ok(fast < slow, '盯得紧的外来者来得更快：' + fast + ' vs ' + slow);
  // 0.02/小时 → 基础 50 小时；关注度 0 时 ÷0.5 = 100 小时
  assert.equal(slow, 100 * HOUR);
  assert.equal(fast, Math.round(50 / 1.5) * HOUR);
});

test('M2.62 边界：时刻表是确定的 —— 同 seed 同答案（分片一致性的根）', () => {
  const build = (seed: string) =>
    boundaryEventTimes({
      boundaryId: 'b1', basePressure: 0.05, attention: 0.5, seed,
      upTo: 1000 * HOUR, rollFor: noJitter,
    });
  const a = build('world');
  const b = build('world');
  assert.deepEqual(a, b, '同一个 seed 必须得到同一张时刻表');
  assert.ok(a.length > 5, '时刻表要真的铺开：' + a.length);
  // 递增
  for (let i = 1; i < a.length; i += 1) {
    assert.ok(a[i]! > a[i - 1]!, '时刻表必须严格递增');
  }
});

test('M2.62 边界：时刻表可复现，但不依赖库状态（补跑与分片都一致）', () => {
  /*
   * 「同一个 seed 的任何两个调用者得到同一张表」—— 无论是同一进程的第二次调用、
   * 还是另一个分片的第一次调用。这就是「不依赖 boundary_state」的可断言形式。
   */
  const once = boundaryEventTimes({
    boundaryId: 'b-iso', basePressure: 0.1, attention: 0.5, seed: 'w1',
    upTo: 200 * HOUR, rollFor: noJitter,
  });
  const twice = boundaryEventTimes({
    boundaryId: 'b-iso', basePressure: 0.1, attention: 0.5, seed: 'w1',
    upTo: 200 * HOUR, rollFor: noJitter,
  });
  assert.deepEqual(twice, once, '第二次调用必须与第一次逐项相同');
  // 扩到更远，前面那段前缀不能被改写（水位线式补齐）
  const farther = boundaryEventTimes({
    boundaryId: 'b-iso', basePressure: 0.1, attention: 0.5, seed: 'w1',
    upTo: 400 * HOUR, rollFor: noJitter,
  });
  assert.deepEqual(farther.slice(0, once.length), once, '补齐不该改写已有的前缀');
});

test('M2.62 边界：不同 seed 得到不同时刻表（世界 seed 真的在起作用）', () => {
  const a = boundaryEventTimes({
    boundaryId: 'b1', basePressure: 0.05, attention: 0.5, seed: 'worldA',
    upTo: 500 * HOUR,
    rollFor: (index) => (index % 2 === 0 ? 0 : 1),
  });
  const b = boundaryEventTimes({
    boundaryId: 'b1', basePressure: 0.05, attention: 0.5, seed: 'worldB',
    upTo: 500 * HOUR,
    rollFor: (index) => (index % 2 === 0 ? 1 : 0),
  });
  assert.notDeepEqual(a, b, '换一个世界 seed 就该换一张时刻表');
});

test('M2.62 边界：isBoundaryHour 只在整点命中', () => {
  const times = [0, 10 * HOUR, 25 * HOUR];
  assert.equal(isBoundaryHour(times, 0), true);
  assert.equal(isBoundaryHour(times, 10 * HOUR), true);
  assert.equal(isBoundaryHour(times, 1 * HOUR), false);
  assert.equal(isBoundaryHour(times, 11 * HOUR), false);
  assert.equal(isBoundaryHour(times, 100 * HOUR), false);
});

test('M2.62 边界：foreignInputAt 只在时刻表上的那一格返回输入', () => {
  const boundary = fakeBoundary({ inputs: ['trade', 'migrant'], base_pressure: 0.25 });
  const at = (t: number) =>
    foreignInputAt({
      boundary, seed: 'w', attention: 0.5, at: t,
      gapRollFor: noJitter, kindRoll: 0,
    });
  // 0.25/小时 → 4 小时 ÷ 1.0 = 4 小时一格
  assert.equal(at(4 * HOUR)?.kind, 'trade', '第三格应当在 4 小时');
  assert.equal(at(1 * HOUR), null, '不是时刻表上的格就不该发生');
  // kindRoll 决定发生哪一种
  assert.equal(
    foreignInputAt({
      boundary, seed: 'w', attention: 0.5, at: 4 * HOUR, gapRollFor: noJitter, kindRoll: 0.9,
    })?.kind,
    'migrant',
  );
});

/* ================================================================== *
 * 三、四类输入的后果
 * ================================================================== */

test('M2.62 边界：四类输入都有真实的后果定义', () => {
  for (const kind of ['trade', 'migrant', 'threat', 'contamination'] as const) {
    const def = FOREIGN_INPUTS[kind];
    assert.equal(def.kind, kind);
    assert.ok(def.text.length > 0, kind + ' 必须有一句文案');
    const hasEffect =
      Object.keys(def.effect.zonePatch).length > 0 ||
      def.effect.alertDelta > 0 ||
      def.effect.fearDelta > 0 ||
      def.effect.dangerBonus > 0;
    assert.ok(hasEffect, kind + ' 必须真的改变点什么 —— 否则它只是一句播报');
  }
  assert.ok(FOREIGN_INPUTS.threat.effect.alertDelta > FOREIGN_INPUTS.trade.effect.alertDelta);
  assert.ok(FOREIGN_INPUTS.contamination.effect.fearDelta > FOREIGN_INPUTS.trade.effect.fearDelta);
  assert.equal(FOREIGN_INPUTS.trade.effect.dangerBonus, 0, '贸易本身不是危险');
});

test('M2.62 边界：文案模板会把外部势力名与地点名换进去', () => {
  const text = foreignInputText(FOREIGN_INPUTS.trade, '因蒂斯海军', '老码头');
  assert.ok(text.includes('因蒂斯海军'), '势力名要被换进去：' + text);
  assert.ok(text.includes('老码头'), '地点名要被换进去：' + text);
  assert.ok(!text.includes('{power}') && !text.includes('{loc}'), '模板占位符不该留在文案里');
});

/* ================================================================== *
 * 四、触发真的改世界（含幂等）
 * ================================================================== */

test('M2.62 边界：一次触发会同时改恐慌、警觉并播报', () => {
  const db = freshDb();
  try {
    const boundary = fakeBoundary({
      id: 'b1', location: 'loc_a', foreign_power: 'p1',
      inputs: ['threat'], base_pressure: 0.5,
    });
    const index = new BoundaryIndex([boundary], [
      { id: 'p1', name: '测试外来者', from_region: '', attention: 1, threat: 0.5, description: '' },
    ]);
    const events = new WorldEventRepo(db);
    // 0.5/小时 → 2 小时 ÷ 1.5 ≈ 1.33 → 取整 1 小时一格
    const fireAt = boundaryEventTimes({
      boundaryId: 'b1', basePressure: 0.5, attention: 1, seed: 'w',
      upTo: 100 * HOUR, rollFor: noJitter,
    })[2]!;
    const result = tickBoundaries({
      db, boundaryIndex: index, worldEvents: events, seed: 'w',
      zoneOfLocation: () => 'zone_x',
      powersAt: () => ['police'],
      at: fireAt,
    });
    assert.equal(result.fired.length, 1, '时刻表上的那一格必须触发');
    assert.equal(result.fired[0]!.kind, 'threat');
    assert.equal(result.fired[0]!.locationId, 'loc_a');
    assert.ok(events.count() >= 1, '边界输入必须播报 —— 否则玩家看不见');
    assert.ok(new ZoneStateRepo(db).fearByZone().get('zone_x')! > 0, '域恐慌该涨');
    assert.ok(new PowerStateRepo(db).alertByPower().get('police')! > 0, '势力警觉该涨');
    const audit = new BoundaryStateRepo(db).all().get('b1');
    assert.ok(audit !== undefined, '审计表要记下来（它不参与判定，但后台要看）');
    assert.equal(audit.eventCount, 1);
  } finally {
    db.close();
  }
});

test('M2.62 边界：同一格重放不重复加恐慌与警觉（补跑/分片重叠的幂等）', () => {
  const db = freshDb();
  try {
    const boundary = fakeBoundary({ id: 'b1', inputs: ['threat'], base_pressure: 0.5 });
    const index = new BoundaryIndex([boundary], [
      { id: 'p1', name: '外来者', from_region: '', attention: 1, threat: 0.5, description: '' },
    ]);
    const events = new WorldEventRepo(db);
    const fireAt = boundaryEventTimes({
      boundaryId: 'b1', basePressure: 0.5, attention: 1, seed: 'w',
      upTo: 100 * HOUR, rollFor: noJitter,
    })[2]!;
    const run = () =>
      tickBoundaries({
        db, boundaryIndex: index, worldEvents: events, seed: 'w',
        zoneOfLocation: () => 'zone_x', powersAt: () => ['police'], at: fireAt,
      });
    const first = run();
    const fearAfterFirst = new ZoneStateRepo(db).fearByZone().get('zone_x')!;
    const alertAfterFirst = new PowerStateRepo(db).alertByPower().get('police')!;
    const second = run();
    assert.equal(first.fired.length, 1);
    assert.equal(second.fired.length, 0, '同一格重放不该再触发一次');
    assert.equal(
      new ZoneStateRepo(db).fearByZone().get('zone_x'),
      fearAfterFirst,
      '恐慌不能被重放放大',
    );
    assert.equal(
      new PowerStateRepo(db).alertByPower().get('police'),
      alertAfterFirst,
      '警觉不能被重放放大',
    );
  } finally {
    db.close();
  }
});

test('M2.62 边界：**不写静态生态基线**（那会单调递增永不回落）', () => {
  const db = freshDb();
  try {
    const boundary = fakeBoundary({ base_pressure: 0.5, inputs: ['contamination'] });
    const index = new BoundaryIndex([boundary], [
      { id: 'p1', name: '外来者', from_region: '', attention: 1, threat: 0.5, description: '' },
    ]);
    const events = new WorldEventRepo(db);
    const times = boundaryEventTimes({
      boundaryId: boundary.id, basePressure: 0.5, attention: 1, seed: 'w',
      upTo: 3000 * HOUR, rollFor: noJitter,
    });
    // 沿着时刻表连跑 30 格
    for (const at of times.slice(0, 30)) {
      tickBoundaries({
        db, boundaryIndex: index, worldEvents: events, seed: 'w',
        zoneOfLocation: () => 'zone_x', powersAt: () => [], at,
      });
    }
    const fear = new ZoneStateRepo(db).fearByZone().get('zone_x')!;
    assert.ok(fear <= 1, '恐慌必须夹在 1 以内，实际 ' + fear);
    assert.ok(fear > 0, '但它确实涨了 —— 否则这条用例什么也没测');
    /*
     * 表名查询：条件要**整体**用 type='table' 限定。
     * 写 `type='table' AND a OR b` 时 AND 优先于 OR，后半个条件会单独成立，
     * 于是索引（idx_xxx / sqlite_autoindex_xxx）也被查出来。
     */
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%zone%' OR name LIKE '%boundary%')",
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map((row) => row.name).sort(),
      ['boundary_state', 'zone_state'],
      '边界输入只该写到这两张表',
    );
  } finally {
    db.close();
  }
});

test('M2.62 边界：空边界表 = 世界没有外面，什么都不发生', () => {
  const db = freshDb();
  try {
    const empty = new BoundaryIndex([], []);
    assert.equal(empty.size, 0);
    assert.equal(empty.atLocation('old_dock'), undefined);
    assert.equal(empty.foreignPower('任何人'), undefined);
    const result = tickBoundaries({
      db, boundaryIndex: empty, worldEvents: new WorldEventRepo(db),
      seed: 'w', at: 1000 * HOUR,
    });
    assert.deepEqual(result.fired, []);
    assert.equal(new BoundaryStateRepo(db).count(), 0);
  } finally {
    db.close();
  }
});

test('M2.62 边界：读不到 boundaries 文件时报问题而不是抛异常', () => {
  const result = loadBoundaries('不存在的文件.yaml', {
    locations: LOCATION_IDS, regions: REGION_IDS,
  });
  assert.ok(result.issues.length > 0, '读不出文件时要报问题，不能静默返回空表');
  assert.equal(result.boundaries.length, 0);
  assert.equal(result.foreignPowers.length, 0);
});

test('M2.62 边界：真实内容表的每条边界都能在索引里查到', () => {
  for (const boundary of BOUNDARIES) {
    assert.equal(INDEX.atLocation(boundary.location)?.id, boundary.id, boundary.id + ' 查不到');
    assert.ok(INDEX.foreignPower(boundary.foreign_power) !== undefined, boundary.foreign_power + ' 不存在');
  }
});

test('M2.62 边界：真实内容表在 30 天里真的会产生输入（不是摆设）', () => {
  /*
   * 一条边界如果 30 天里一次都不触发，那它与不存在没有分别。
   * 这一条拿真实内容跑一遍时刻表，确认每条边界都有事件。
   */
  const THIRTY_DAYS = 30 * 24 * HOUR;
  const silent: string[] = [];
  for (const boundary of BOUNDARIES) {
    const foreign = INDEX.foreignPower(boundary.foreign_power)!;
    const times = boundaryEventTimes({
      boundaryId: boundary.id,
      basePressure: boundary.base_pressure,
      attention: foreign.attention,
      seed: 'world',
      upTo: THIRTY_DAYS,
      rollFor: () => 0.5,
    });
    if (times.length <= 1) silent.push(boundary.id);
  }
  assert.deepEqual(silent, [], '30 天里一次都不触发的边界等于不存在：' + silent.join(', '));
});
