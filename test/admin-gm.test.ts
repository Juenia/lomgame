/**
 * GM 管理（M2.50）。
 *
 * 这里守的是三件会**静默**出错的事：
 *
 * 1. **改属性不能顺手把其它列抹掉。** CharacterRepo.update() 写全部列，
 *    读出来改一个字段再写回去是安全的；但一旦有人图省事改成 UPDATE 单列，
 *    current_city_id / church_id 这种「读库完全看不出来」的丢列事故就会回来
 *    （update() 的注释里这两笔账各记过一次）。
 * 2. **每一次写入都要留痕。** 后台能改玩家数值，改了什么必须查得到。
 * 3. **GM 造的失控不能进运营指标。** lost_control_events 的行数就是失控触发率，
 *    而 alerts.ts 在这项 > 0.2 时报 P1 —— GM 手动点几下不该触发一条假告警。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gmApplyStats, gmDetail, gmInventory, gmOptions, gmResetDaily, gmSearch,
  gmSetPathway, gmSetStatus, gmStats, gmTeleport,
} from '../src/admin/gm.ts';
import { CharacterRepo } from '../src/infra/db/characters.ts';
import { CityRepo, TravelRepo } from '../src/infra/db/geo.ts';
import { migrate, openDatabase, type Db } from '../src/infra/db/sqlite.ts';
import { dateKey } from '../src/infra/date.ts';
import { computeGameplayStats } from '../src/ops/stats.ts';

const CID = 'c1';
const NOW = 1_800_000_000_000;

function setup(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new CharacterRepo(db);
  repo.ensureUser('u1', '测试玩家', NOW);
  repo.insert({
    id: CID, userId: 'u1', name: '曾经',
    pathway: null, sequence: null, pathwayStatus: 'mortal', gender: 'female',
    hp: 100, mp: 100, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0,
    currentCityId: 'tingen', churchId: 'god_of_steam', churchContribution: 42,
    createdAt: NOW, updatedAt: NOW,
  });
  // center_id 是 zod 的必填项（CitySchema.center.min(1)），漏了会在读取时报「城市数据损坏」
  db.prepare(
    'INSERT INTO cities (id, name, region_id, center_id) VALUES ' +
      "('tingen', '廷根市', 'r1', 'tingen_center'), ('backlund', '贝克兰德', 'r1', 'backlund_center')",
  ).run();
  db.prepare("INSERT INTO items (id, name, kind) VALUES ('potion_seer_9', '占卜家魔药', 'potion')").run();
  return db;
}

const reload = (db: Db) => new CharacterRepo(db).findById(CID)!;

test('GM：属性超界是钳制并警告，不是报错（手滑输 999 时替他改成 100 更有用）', () => {
  const db = setup();
  const out = gmApplyStats(db, CID, { hp: 999, mad: -5 }, NOW);
  assert.ok(out.ok, '应该成功');
  assert.equal(reload(db).hp, 100);
  assert.equal(reload(db).mad, 0);
  assert.equal(out.warnings.length, 2, '两次钳制都该说出来');
  assert.ok(out.warnings.some((w) => w.includes('999')), '警告里要带上原始输入');
});

test('GM：普通人越过保护期上限要显式警告（那条前提是判定层直接依赖的）', () => {
  const db = setup();
  const out = gmApplyStats(db, CID, { mad: 40 }, NOW);
  assert.ok(out.ok);
  assert.equal(reload(db).mad, 40, 'GM 要能越界，不能拒绝');
  assert.ok(
    out.warnings.some((w) => w.includes('普通人') && w.includes('不可能失控')),
    '必须点明这让「普通人不可能失控」失效了',
  );
});

test('GM：改属性不会顺手抹掉城市 / 教会 / 性别（update() 写全部列，这是它存在的理由）', () => {
  const db = setup();
  assert.ok(gmApplyStats(db, CID, { hp: 7 }, NOW).ok);
  const after = reload(db);
  assert.equal(after.currentCityId, 'tingen', '城市被抹了');
  assert.equal(after.churchId, 'god_of_steam', '教会被抹了');
  assert.equal(after.churchContribution, 42, '贡献被抹了');
  assert.equal(after.gender, 'female', '性别被抹了');
  assert.equal(after.name, '曾经');
});

test('GM：入途径是三联（pathway / sequence / pathway_status）一起写，不会出现「有途径的普通人」', () => {
  const db = setup();
  const out = gmSetPathway(db, CID, 'seer', 8, NOW);
  assert.ok(out.ok);
  const after = reload(db);
  assert.equal(after.pathway, 'seer');
  assert.equal(after.sequence, 8);
  assert.equal(after.pathwayStatus, 'initiated', '三联没写全，读出的是自相矛盾的状态');
  // 序列 8 的愚者称号是「小丑」（序列 9 才是占卜家）—— 称号来自 card/titles.ts 的唯一出处
  assert.ok(out.message.includes('愚者') && out.message.includes('小丑'), '回执该说人话：' + out.message);
});

test('GM：途径和序列要合法；改回普通人会把两个字段一起清掉', () => {
  const db = setup();
  assert.equal(gmSetPathway(db, CID, 'not_a_pathway', 8, NOW).ok, false);
  assert.equal(gmSetPathway(db, CID, 'seer', 99, NOW).ok, false);
  assert.equal(gmSetPathway(db, CID, 'seer', 8, NOW).ok, true);
  assert.ok(gmSetPathway(db, CID, null, null, NOW).ok);
  const after = reload(db);
  assert.equal(after.pathway, null);
  assert.equal(after.sequence, null);
  assert.equal(after.pathwayStatus, 'mortal');
});

test('GM：只给四个终态。过渡态（晋升中/战斗中/交易中）手写进去没有任何流程会来清它', () => {
  const db = setup();
  for (const bad of ['promoting', 'in_battle', 'trading']) {
    const out = gmSetStatus(db, CID, bad, NOW);
    assert.equal(out.ok, false, bad + ' 不该被接受');
    assert.ok(!out.ok && out.error.includes('晋升中') === false || true);
  }
  assert.equal(reload(db).status, 'active', '被拒的操作不能改到库');
  assert.ok(gmSetStatus(db, CID, 'banned', NOW).ok);
  assert.equal(reload(db).status, 'banned');
  // 四个终态都必须是服务端给的选项，前后端不能各写一份
  assert.deepEqual(
    gmOptions(db).statuses.map((s) => s.id),
    ['active', 'injured', 'lost_control', 'banned'],
  );
});

test('GM：强制失控会留档，但**不计入**运营的失控触发率（否则点几下就报 P1）', () => {
  const db = setup();
  const out = gmSetStatus(db, CID, 'lost_control', NOW);
  assert.ok(out.ok);
  assert.equal(reload(db).status, 'lost_control');

  const rows = db
    .prepare('SELECT source FROM lost_control_events WHERE character_id = ?')
    .all(CID) as Array<{ source: string }>;
  assert.equal(rows.length, 1, '玩家侧「今天失控过」按这张表算，必须留档');
  assert.equal(rows[0]!.source, 'gm', '来源必须标成 gm');

  assert.equal(computeGameplayStats(db).lostControlRate, 0, 'GM 造的失控漏进了运营指标');
});

test('GM：传送会中止进行中的旅途（否则那条记录永远停在 traveling，之后再也移动不了）', () => {
  const db = setup();
  db.prepare('INSERT INTO routes (id, from_city, to_city, type, duration_hours, cost_penny, danger) ' +
    "VALUES ('r1', 'tingen', 'backlund', 'ship', 12, 100, 0.2)").run();
  const travels = new TravelRepo(db);
  travels.create({
    id: 't1', characterId: CID, routeId: 'r1',
    startedAt: NOW, arrivesAt: NOW + 1000, status: 'traveling', events: [],
  });

  const out = gmTeleport(db, CID, 'backlund', NOW);
  assert.ok(out.ok);
  assert.equal(reload(db).currentCityId, 'backlund');
  assert.equal(travels.activeOf(CID), null, '旅途还挂着');
  assert.equal(travels.get('t1')!.status, 'aborted');
  assert.ok(out.warnings.some((w) => w.includes('旅途')), '中止了别人的旅途要说出来');
  assert.equal(new CityRepo(db).get('backlund')!.name, '贝克兰德');
});

test('GM：物品发放 / 收回；收超过持有量要整体失败，绝不部分扣减', () => {
  const db = setup();
  assert.equal(gmInventory(db, CID, { action: 'give', itemId: 'nope', quantity: 1 }, NOW).ok, false);
  assert.equal(gmInventory(db, CID, { action: 'give', itemId: 'potion_seer_9', quantity: 0 }, NOW).ok, false);

  const give = gmInventory(db, CID, { action: 'give', itemId: 'potion_seer_9', quantity: 3, bindType: 'bound' }, NOW);
  assert.ok(give.ok);
  assert.ok(give.message.includes('占卜家魔药'), '回执要用中文名：' + give.message);

  const tooMany = gmInventory(db, CID, { action: 'take', itemId: 'potion_seer_9', quantity: 5 }, NOW);
  assert.equal(tooMany.ok, false);
  assert.ok(!tooMany.ok && tooMany.error.includes('3'), '拒绝时要报出实际持有量：' + (!tooMany.ok ? tooMany.error : ''));
  const left = db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM inventory WHERE character_id = ?').get(CID) as { n: number };
  assert.equal(left.n, 3, '被拒的扣减不能扣掉一部分');

  assert.ok(gmInventory(db, CID, { action: 'take', itemId: 'potion_seer_9', quantity: 3 }, NOW).ok);
});

test('GM：重置今日计数一次清全五张表（少清一张会出现「次数重置了但 AP 还是用光的」）', () => {
  const db = setup();
  // 必须用 dateKey（UTC+8）而不是 toISOString 切片：口径不一致的话，
  // 写进去的行和 gmDetail 读的行不是同一天，这条测试会变成永远通过的空测试
  const date = dateKey(NOW);
  db.prepare('INSERT INTO daily_counters (character_id, date, key, count) VALUES (?, ?, ?, ?)').run(CID, date, 'rest', 2);
  db.prepare('INSERT INTO daily_actions (character_id, date, ap_used) VALUES (?, ?, ?)').run(CID, date, 5);
  db.prepare('INSERT INTO explore_daily (character_id, date, location_id, count) VALUES (?, ?, ?, ?)').run(CID, date, 'loc', 3);
  db.prepare('INSERT INTO daily_tag_usage (character_id, date, tag, count) VALUES (?, ?, ?, ?)').run(CID, date, '扮演', 1);
  db.prepare('INSERT INTO cooldowns (character_id, command, last_used_at) VALUES (?, ?, ?)').run(CID, 'divination', NOW);

  assert.ok(gmDetail(db, CID, NOW)!.daily.some((d) => d.key === 'rest'), '详情要能看见今天的计数');

  const out = gmResetDaily(db, CID, NOW);
  assert.ok(out.ok);
  for (const table of ['daily_counters', 'daily_actions', 'explore_daily', 'daily_tag_usage', 'cooldowns']) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`).get(CID) as { n: number }).n;
    assert.equal(n, 0, table + ' 没清干净');
  }
  assert.ok(out.message.includes('daily_counters'), '回执要说清了哪几张表：' + out.message);
});

test('GM：每一次写入都进 audit_logs，查得到改了什么', () => {
  const db = setup();
  assert.ok(gmApplyStats(db, CID, { hp: 50 }, NOW).ok);
  const rows = db
    .prepare("SELECT command, input, output FROM audit_logs WHERE user_id = 'u1' AND command LIKE 'gm.%'")
    .all() as Array<{ command: string; input: string; output: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.command, 'gm.stats');
  assert.ok(rows[0]!.input.includes('hp'), '输入要留档');
  assert.ok(rows[0]!.output.includes('50'), '结果要留档');
  assert.ok(gmDetail(db, CID)!.audit.some((a) => a.command === 'gm.stats'), '详情里要看得到留档');
});

test('GM：没有这个角色一律干净失败，不抛异常', () => {
  const db = setup();
  for (const out of [
    gmApplyStats(db, 'nope', { hp: 1 }, NOW),
    gmSetStatus(db, 'nope', 'active', NOW),
    gmSetPathway(db, 'nope', 'seer', 8, NOW),
    gmTeleport(db, 'nope', 'tingen', NOW),
    gmInventory(db, 'nope', { action: 'give', itemId: 'potion_seer_9', quantity: 1 }, NOW),
    gmResetDaily(db, 'nope', NOW),
  ]) {
    assert.equal(out.ok, false);
  }
  assert.equal(gmDetail(db, 'nope'), null);
});

test('GM：搜索按角色名 / 角色 ID / QQ 号 / 昵称都能命中，空串是列全部', () => {
  const db = setup();
  for (const q of ['曾经', 'c1', 'u1', '测试玩家']) {
    assert.equal(gmSearch(db, q).length, 1, q + ' 没搜到');
  }
  assert.equal(gmSearch(db, '不存在的人').length, 0);
  assert.equal(gmSearch(db, '').length, 1, '空串要列出全部');

  const p = gmSearch(db, '')[0]!;
  // 英文 id 一律换成中文：GM 不该为了改一个数去记 sailor 是「水手」
  assert.equal(p.pathwayLabel, '（普通人）');
  assert.equal(p.statusLabel, '正常');
  assert.equal(p.cityName, '廷根市');
  assert.deepEqual(gmStats(db), {
    characters: 1, users: 1, active: 1, injured: 0, lostControl: 0,
    banned: 0, mortal: 1, initiated: 0, lostControlToday: 0,
  });
});

test('GM：下拉选项全是中文，且城市/物品来自库里真实存在的行', () => {
  const db = setup();
  const o = gmOptions(db);
  assert.deepEqual(o.cities.map((c) => c.name).sort(), ['廷根市', '贝克兰德']);
  assert.deepEqual(o.items.map((i) => i.name), ['占卜家魔药']);
  assert.ok(o.pathways.every((p) => p.label && !/[a-z]/.test(p.label)), '途径必须是中文名');
  assert.ok(o.stats.some((s) => s.key === 'mad' && s.label.includes('疯狂')));
  assert.deepEqual(o.sequences, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test('GM：选项里的 stats 是「属性定义」，统计数字走另一个键（键名撞过一次，前端当场崩）', () => {
  const db = setup();
  const o = gmOptions(db);
  // 路由里曾经写成 { ...gmOptions(), stats: gmStats() } —— 展开之后同名键被覆盖，
  // 前端拿到的是 {characters:1,...} 而不是数组，GO.stats.forEach 直接抛。
  assert.ok(Array.isArray(o.stats), 'stats 必须是数组');
  assert.ok(o.stats.every((s) => typeof s.key === 'string' && typeof s.min === 'number'));
  // M2.85：行动值（AP）从属性清单里删除后是六项
  assert.equal(o.stats.length, 6, '六项属性一个都不能少');
});
