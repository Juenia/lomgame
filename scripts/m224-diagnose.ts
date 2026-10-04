#! /usr/bin/env node
/**
 * M2.22 任务 1：**不分片诊断**的主取数（1 片 × 200 人 × 30 天）。
 *
 * 它回答 `docs/m219_框架.md` §4.6 左边那一列 ——「机制在更大的相遇池里能不能稳定翻转」，
 * 并**只**回答这一列（右边那一列是玩家行为，见 `docs/对照规范.md` §八）。
 *
 * ## 三个量里，两个能取、一个取不到（这一条本身就是结论）
 *
 * | 量 | 取数 | 结果 |
 * | --- | --- | --- |
 * | 翻转事件数（地点级 + 事件级） | `scripts/m222-flip-report.ts --batch <批> --shards 1` | ✅ |
 * | 跨教会 PVP 战斗数 | `scripts/real-player-contest.ts --db data/<批>-shard-0.db` | ✅ |
 * | **敌对教会成员同地点相遇数** | —— | ❌ **事件流里没有位置轨迹** |
 *
 * **为什么第三个取不到**：位置只写在 `flags` 表的 `loc` 键上
 * （`FLAG_LOCATION`，写入点是 `arrival.ts` 与 `wanted-hooks.ts`），
 * 而它在 `INTERNAL_FLAGS` 里 —— **内部 flag 不落 `flag_set` 事件**。
 * 所以 `domain_events` 里一条位置记录都没有，重建不出停留区间。
 * （登记：与铁律 8 同型 —— 「判定需要的数据当场落库」，这次缺的是**位置历史**。）
 *
 * **替代口径**（本脚本 §2 给的）：**跨教会 PVP 发生的地点，落在可争夺地点集里吗**。
 * 这一格直接回答「为什么翻不动」：`recordTerritoryContest` 的三条前置里，
 * 「地点必须在 `contestedLocations` 里」是**唯一一个不由玩家决定的**。
 *
 * 用法：node scripts/m224-diagnose.ts --batch m224 --shards 1
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { ChurchIndex } from '../src/domain/church/index.ts';
import { loadChurches, loadCities, loadLocations } from '../src/data/loader.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm224');
const SHARDS = Number(argOf('shards', '1'));

const index = new ChurchIndex(loadChurches().churches, loadCities().cities, loadLocations().locations);
const CONTESTED = NUMERIC.church.conflict.contestedLocations;
const THRESHOLD = NUMERIC.church.conflict.dominanceThreshold;

let chars = 0;
let inChurch = 0;
const byChurch = new Map<string, number>();
const byCityOfChurch = new Map<string, number>();
let flagSetLoc = 0;
let pvpTotal = 0;
let pvpBothInChurch = 0;
let pvpCrossChurch = 0;
let pvpHostile = 0;
let pvpHostileContested = 0;
const locationTally = new Map<string, number>();
const blockers = { notBothInChurch: 0, sameChurch: 0, notHostile: 0, notContested: 0 };
const hostileRows: string[] = [];

for (let s = 0; s < SHARDS; s += 1) {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync('data/' + BATCH + '-shard-' + s + '.db', { readOnly: true });
  } catch {
    console.error('打不开 data/' + BATCH + '-shard-' + s + '.db —— 先确认跑批产物在不在。');
    process.exit(2);
  }

  const rows = db.prepare('SELECT id, name, church_id, current_city_id FROM characters').all() as unknown as Array<{
    id: string; name: string; church_id: string | null; current_city_id: string | null;
  }>;
  const byId = new Map<string, { name: string; church: string | null }>();
  for (const row of rows) {
    chars += 1;
    byId.set(String(row.id), { name: String(row.name), church: row.church_id ?? null });
    if (row.church_id) {
      inChurch += 1;
      byChurch.set(String(row.church_id), (byChurch.get(String(row.church_id)) ?? 0) + 1);
    }
  }

  // 位置轨迹可得性（实测，不是推测）
  flagSetLoc += Number(
    (db.prepare("SELECT COUNT(*) n FROM domain_events WHERE type='flag_set' AND json_extract(payload,'$.flag')='loc'").get() as { n: number }).n,
  );

  const battles = db.prepare(
    'SELECT character_id, opponent_character_id, location_id, status FROM battles WHERE is_pvp = 1',
  ).all() as unknown as Array<{ character_id: string; opponent_character_id: string | null; location_id: string | null; status: string }>;

  for (const battle of battles) {
    pvpTotal += 1;
    const a = byId.get(String(battle.character_id));
    const b = battle.opponent_character_id ? byId.get(String(battle.opponent_character_id)) : undefined;
    const loc = battle.location_id ?? '—';
    locationTally.set(loc, (locationTally.get(loc) ?? 0) + 1);
    if (!a || !b || !a.church || !b.church) {
      blockers.notBothInChurch += 1;
      continue;
    }
    pvpBothInChurch += 1;
    if (a.church === b.church) {
      blockers.sameChurch += 1;
      continue;
    }
    pvpCrossChurch += 1;
    if (index.relationOf(a.church, b.church) !== 'hostile') {
      blockers.notHostile += 1;
      continue;
    }
    pvpHostile += 1;
    const contested = CONTESTED.includes(loc);
    if (!contested) blockers.notContested += 1;
    else pvpHostileContested += 1;
    if (hostileRows.length < 25) {
      hostileRows.push(
        '  | ' + a.name + '（' + a.church + '） | ' + b.name + '（' + b.church + '） | ' + loc +
          ' | ' + (contested ? '**在可争夺集里**' : '不在可争夺集里') + ' | ' + battle.status + ' |',
      );
    }
  }
  db.close();
}

console.log('=== 不分片诊断（M2.22 任务 1）===');
console.log('  批：' + BATCH + '　片数：' + SHARDS + '（**不分片与分片不可直接比** —— 报告口径：分片只能验机制跑通，绝对值一律用不分片轮）');
console.log('');
console.log('=== §0 规模与「第三个量取不到」的实测 ===');
console.log('  角色：' + chars + '　入教：' + inChurch);
for (const [church, n] of [...byChurch.entries()].sort((a, b) => b[1] - a[1])) {
  console.log('    · ' + church + '：' + n + ' 人');
}
console.log('  `flag_set` 里 flag = loc 的事件：**' + flagSetLoc + ' 条**');
console.log('  ⇒ 位置只写在 flags 表的 loc 键（INTERNAL_FLAGS 之一），**不落事件** ——');
console.log('    「敌对教会成员同地点相遇数」在事件流里**取不到**（登记为技术债，与铁律 8 同型）。');
console.log('');
console.log('=== §1 PVP 与争夺漏斗（替代口径）===');
console.log('  PVP 总场次（is_pvp = 1）：' + pvpTotal);
console.log('  双方都入教：' + pvpBothInChurch);
console.log('  **跨教会：' + pvpCrossChurch + '**');
console.log('  其中**敌对教会**：**' + pvpHostile + '**');
console.log('  其中地点**在可争夺集里**：**' + pvpHostileContested + '**（这一格才是「能记增量」的）');
console.log('');
console.log('  漏斗（每一格是「被它挡掉」的场次）：');
console.log('    · 有一方没入教：' + blockers.notBothInChurch);
console.log('    · 同一家教会：' + blockers.sameChurch);
console.log('    · 两家不是 hostile：' + blockers.notHostile);
console.log('    · **地点不在 contestedLocations：' + blockers.notContested + '** ← 唯一不由玩家决定的那一格');
console.log('');
if (hostileRows.length) {
  console.log('  敌对教会 PVP 逐场（前 ' + hostileRows.length + ' 场）：');
  console.log('  | 发起者 | 对手 | 地点 | 可争夺？ | 状态 |');
  console.log('  | --- | --- | --- | --- | --- |');
  for (const line of hostileRows) console.log(line);
  console.log('');
}
console.log('=== §2 PVP 地点分布 ===');
for (const [loc, n] of [...locationTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('    ' + loc + '：' + n + ' 场' + (CONTESTED.includes(loc) ? '　**可争夺**' : ''));
}
console.log('  可争夺地点集共 ' + CONTESTED.length + ' 个');
console.log('');
console.log('=== §3 判读（三档，任务书原文）===');
console.log('  翻转的取数在另一条命令里：node scripts/m222-flip-report.ts --batch ' + BATCH + ' --shards ' + SHARDS);
console.log('  阈值 dominanceThreshold = ' + THRESHOLD);
console.log('');
console.log('  | 结果 | 结论 |');
console.log('  | 翻转 > 0 | 分片切断跨教会交互是限制因素 |');
console.log('  | 翻转 = 0、跨教会 PVP > 0 | 机制在打但翻不动（阈值 / 衰减 / 或集中度） |');
console.log('  | 翻转 = 0、跨教会 PVP = 0 | vplayer 行为是限制因素，与分片无关 |');
console.log('');
console.log('  ⚠️ **无论落哪一档，都不能用它推断玩家行为**（docs/对照规范.md §八）。');
