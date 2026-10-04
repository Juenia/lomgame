/**
 * M2.71：**B2-3 那三个字段的裁决与落地**。
 *
 * ## 台账原文（`docs/框架现状解读.md` 的 B-2 表）
 *
 * > `region.pathways`、`city.factions`、`region.danger` ——
 * > 落库了但没有读取点；注释只说「没有任何判定读它」，**没写将来给谁用**
 *
 * 这一轮的裁决是**分开**的：一个接机制、两个接判据。
 *
 * | 字段 | 裁决 | 为什么 |
 * | --- | --- | --- |
 * | `region.danger` | **接机制**：折进路线危险 + 抵达时的陌生感文案 | 它的用途在类型注释与 regions.yaml 文件头里都写清楚了（「影响该区域内的路线危险与陌生感文案」）—— 缺的不是说法，是那一行代码 |
 * | `region.pathways` | **接判据**：城市开放的途径必须属于所属区域传承的途径 | 它是「设计记录」，不是机制；硬接进玩法会造出**第二份真相**（出生校验读城市那一份） |
 * | `city.factions` | **接判据**：与领地表双向一致 | 同上：领地表是「谁在哪儿」的唯一定义 |
 *
 * ## 判据立刻抓到的东西（5 条，全是真漂移）
 *
 * 判据一（区域途径）抓到 **4 座城市**：backlund 开 perfect、pritz 开 sailor、
 * trier 开 reader、byron 开 mother —— 这四条途径是 M2.19 / M2.26 **实现**的，
 * 而实现时只改了城市那份，区域那份设计记录**没人读、也就没人同步**。
 *
 * 判据二（城市势力）抓到 **trier 少了 church**：M2.39 批次 B 给特里尔加了
 * `trier_ossuary` 与 `trier_war_crypt`（归教会），同样没人同步。
 *
 * ⇒ **「没有读取点的字段会腐烂」不是一句修辞**：这两处内容漂了大半年，
 * 直到有人去读它才显形。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { checkGeoConsistency, checkLinks } from '../src/data/link-check.ts';
import { GeoIndex } from '../src/domain/geo/index.ts';
import {
  REGION_DANGER_NEUTRAL,
  effectiveRouteDanger,
  regionUneaseLine,
} from '../src/domain/geo/travel.ts';
import { OPEN_PATHWAYS } from '../src/domain/character/rules.ts';

const CONTENT = loadContent();
const GEO = new GeoIndex(CONTENT.regions, CONTENT.cities, CONTENT.routes);
const TERRITORY = NUMERIC.factionTerritory as Readonly<Record<string, readonly string[]>>;

/* ================================================================== *
 * 一、判据一：区域传承的途径 ⊇ 城市开放的途径
 * ================================================================== */

test('M2.71 判据一：真实内容里 0 条违反（四座城市的漂移已经修好）', () => {
  const report = checkGeoConsistency({
    regions: CONTENT.regions,
    cities: CONTENT.cities,
    territory: TERRITORY,
  });
  assert.deepEqual(
    report.issues.map((issue) => issue.message),
    [],
    '地理一致性判据报错了 —— 见 docs/M2.71 交付说明',
  );
  const rows = report.rows.filter((row) => row.check === 'region-pathways');
  assert.equal(rows.length, CONTENT.cities.length, '每座城市都要有一行');
  assert.ok(rows.every((row) => row.pass));
});

test('M2.71 判据一（K23 反向用例）：城市开了一条区域不传承的途径 → 报 error', () => {
  const report = checkGeoConsistency({
    regions: [{ id: 'r1', pathways: ['seer'] }],
    cities: [{ id: 'city_x', region_id: 'r1', locations: [], factions: [], pathways: ['seer', 'warrior'] }],
    territory: {},
  });
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0]!.level, 'error');
  assert.equal(report.issues[0]!.check, 'geo-consistency');
  assert.match(report.issues[0]!.message, /warrior/);
  assert.match(report.issues[0]!.message, /regions[.]yaml/);
});

test('M2.71 判据一：四座城市各自补上的那条途径，正是这次修的四条', () => {
  /*
   * 这条守的是**修复本身**：如果谁把 regions.yaml 那几行删回去，
   * 这里会红，而上面那条（判据 0 违反）也会红 —— 两条互为对照。
   */
  const expect: Array<[string, string, string]> = [
    ['backlund', 'loen', 'perfect'],
    ['pritz', 'loen', 'sailor'],
    ['trier', 'intez', 'reader'],
    ['byron', 'south', 'mother'],
  ];
  for (const [cityId, regionId, pathway] of expect) {
    const city = CONTENT.cities.find((entry) => entry.id === cityId);
    const region = CONTENT.regions.find((entry) => entry.id === regionId);
    assert.ok(city !== undefined && region !== undefined, cityId + ' / ' + regionId + ' 必须存在');
    assert.ok(city.pathways.includes(pathway as never), cityId + ' 开着 ' + pathway);
    assert.ok(
      region.pathways.includes(pathway as never),
      regionId + ' 的 pathways 里必须有 ' + pathway + '（M2.71 补的）',
    );
  }
});

/* ================================================================== *
 * 二、判据二：城市声明的势力 ↔ 领地表
 * ================================================================== */

test('M2.71 判据二：真实内容里双向一致（trier 漏掉的 church 已经补上）', () => {
  const report = checkGeoConsistency({
    regions: CONTENT.regions,
    cities: CONTENT.cities,
    territory: TERRITORY,
  });
  const rows = report.rows.filter((row) => row.check === 'city-factions');
  assert.equal(rows.length, CONTENT.cities.length);
  assert.ok(rows.every((row) => row.pass), '有城市与领地表对不上：' + JSON.stringify(rows.filter((r) => !r.pass)));
  const trier = CONTENT.cities.find((city) => city.id === 'trier')!;
  assert.ok(trier.factions.includes('church'), '特里尔有教会的地点（M2.39 批次 B 的墓室与圣堂）');
});

test('M2.71 判据二（K23 反向用例）：两个方向都要抓得住', () => {
  const base = {
    regions: [{ id: 'r1', pathways: [] }],
    cities: [{ id: 'c1', region_id: 'r1', locations: ['loc_a', 'loc_b'], factions: [], pathways: [] }],
  };
  // 漏：领地表说 loc_a 归 police，而城市没声明
  const missing = checkGeoConsistency({ ...base, territory: { police: ['loc_a'] } });
  assert.equal(missing.issues.length, 1);
  assert.match(missing.issues[0]!.message, /漏了 police/);
  // 多：城市声明了 church，而它在城里一个地点都没有
  const extra = checkGeoConsistency({
    ...base,
    cities: [{ ...base.cities[0]!, factions: ['church'] }],
    territory: { police: ['loc_a'] },
  });
  assert.equal(extra.issues.length, 1);
  assert.match(extra.issues[0]!.message, /多了 church/);
  // 对照侧：一致时不报
  const ok = checkGeoConsistency({
    ...base,
    cities: [{ ...base.cities[0]!, factions: ['police', 'none'] }],
    territory: { police: ['loc_a'], none: ['loc_b'] },
  });
  assert.deepEqual(ok.issues, []);
});

test('M2.71 判据二：none 不是特例 —— 它与另外三家走同一条规则', () => {
  /*
   * ⚠️ 第一版把 none 当成 pseudo-势力单独判（「当且仅当该城有无人管的地点时声明」），
   * 结果 tingen 同时报出「漏了 none」与「没有无主地点却声明了 none」两句自相矛盾的话。
   * 根因：`factionTerritory.none` 本来就有一份地点名单 —— 安全区的定义就是那些地点。
   */
  const report = checkGeoConsistency({
    regions: [{ id: 'r1', pathways: [] }],
    cities: [{ id: 'c1', region_id: 'r1', locations: ['loc_a'], factions: ['none'], pathways: [] }],
    territory: { none: ['loc_a'] },
  });
  assert.deepEqual(report.issues, [], 'none 与领地表一致时不该报');
  const wrong = checkGeoConsistency({
    regions: [{ id: 'r1', pathways: [] }],
    cities: [{ id: 'c1', region_id: 'r1', locations: ['loc_a'], factions: [], pathways: [] }],
    territory: { none: ['loc_a'] },
  });
  assert.equal(wrong.issues.length, 1, '领地表说是无主、城市却没声明 → 要报');
});

/* ================================================================== *
 * 三、Region.danger：折进路线危险 + 陌生感文案
 * ================================================================== */

test('M2.71 区域危险：中性值 0.5 不改变任何东西（不排斥现有数据）', () => {
  assert.equal(REGION_DANGER_NEUTRAL, 0.5, '与 RegionSchema.danger 的默认值同一个数');
  assert.equal(effectiveRouteDanger(0.5, null), 0.5, '区域没登记 → 原样');
  assert.equal(effectiveRouteDanger(0.5, REGION_DANGER_NEUTRAL), 0.5, '中性区域 → 原样');
  assert.ok(effectiveRouteDanger(0.5, 0.8) > 0.5, '凶的区域 → 更危险');
  assert.ok(effectiveRouteDanger(0.5, 0.2) < 0.5, '安稳的区域 → 更好走');
  // 两端夹住
  assert.equal(effectiveRouteDanger(1, 1), 1);
  assert.equal(effectiveRouteDanger(0, 0), 0);
});

test('M2.71 区域危险（真实内容）：去南大陆比去鲁恩更不安', () => {
  const routes = CONTENT.routes;
  const toByron = routes.find((route) => route.to === 'byron');
  const toBacklund = routes.find((route) => route.to === 'backlund');
  assert.ok(toByron !== undefined && toBacklund !== undefined, '对照前提：这两条航线存在');
  const south = GEO.regionOfCity('byron');
  const loen = GEO.regionOfCity('backlund');
  assert.ok(south !== null && loen !== null, 'regionOfCity 拿得到区域对象');
  assert.ok(south.danger > loen.danger, '对照前提：南大陆比鲁恩危险');
  assert.ok(
    effectiveRouteDanger(toByron.danger, south.danger) > effectiveRouteDanger(toBacklund.danger, loen.danger),
    '去南大陆那条路的实际危险必须更高',
  );
  // 逐条：把区域偏移加回去，等于原值
  assert.ok(
    Math.abs(effectiveRouteDanger(toBacklund.danger, loen.danger) - (toBacklund.danger + (loen.danger - 0.5) * 0.3)) < 1e-9,
    '形状是 route.danger + (region.danger − 0.5) × 0.3',
  );
});

test('M2.71 陌生感文案：只在两端说一句，中间静默', () => {
  assert.match(regionUneaseLine(0.8) ?? '', /空气比来处重/);
  assert.match(regionUneaseLine(0.7) ?? '', /空气比来处重/, '阈值含等号');
  assert.match(regionUneaseLine(0.3) ?? '', /顺得反常/);
  assert.equal(regionUneaseLine(0.5), null, '中性区域不该有感慨 —— 每趟都感慨等于没感慨');
  assert.equal(regionUneaseLine(0.6), null);
  assert.equal(regionUneaseLine(0.4), null);
  // 真实内容里三种情况各至少一个区域
  const dangers = CONTENT.regions.map((region) => region.danger);
  assert.ok(dangers.some((d) => regionUneaseLine(d) !== null), '至少有一个区域会触发文案');
  assert.ok(dangers.some((d) => regionUneaseLine(d) === null), '至少有一个区域不触发');
});

/* ================================================================== *
 * 四、判据进了检查器（而不是只活在这份测试里）
 * ================================================================== */

test('M2.71 第 5 项：checkLinks 的剖面里有 geoConsistency，且真实内容 0 error', () => {
  const report = checkLinks({
    pathways: OPEN_PATHWAYS,
    recipes: CONTENT.recipes,
    cities: CONTENT.cities,
    factions: CONTENT.factions,
    churches: CONTENT.churches,
    creatures: CONTENT.creatures,
    regions: CONTENT.regions,
    geoCities: CONTENT.cities,
  });
  assert.ok(report.geoConsistency.rows.length > 0, '剖面里要有逐城的结果行');
  assert.deepEqual(report.geoConsistency.issues, []);
  assert.deepEqual(
    report.issues.filter((issue) => issue.check === 'geo-consistency'),
    [],
  );
});
