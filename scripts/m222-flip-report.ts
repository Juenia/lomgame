#! /usr/bin/env node
/**
 * M2.22 · 翻转取数（**地点级 + 事件级**）—— M2.19 拍板的口径。
 *
 * ## 口径（与 M2.18 B 的「翻转 0 次」同口径）
 *
 *   · 归属 = churchTerritoryAt 底图 **叠加** church_territory_contest 的增量，
 *     取「Σ 最高且达阈值」的那一家（contestedOwnerAt）；没达到就是 null（维持底图）。
 *   · **翻转事件** = 某 locationId 在某时刻的归属从 A 变成 B。
 *   · 计数：**地点级 + 事件级** —— 同一地点翻两次算 2 次。
 *
 * 复现的是 scripts/m2-18-territory-report.ts 的算法（按 created_at, id 重放全部增量），
 * 把它从「单批单文件」改成「8 片 + ShardKey」，并补上地点级的汇总。
 *
 * ⚠️ 与 M2.18 B 一致的一条取舍：**只数 after 非 null 的变化**
 * （fromNone 从无到有、handover 易主）；after 为 null（分数掉回阈值以下）
 * 不算翻转 —— 「没拿下」不是一次归属变更。
 *
 * ## 跨片 key
 * 每一片的 c-700000 都叫同一个名字（K3/K5），所以本脚本的跨片聚合一律走 ShardKey：
 * 片号进 key、片内 id 只做显示。
 *
 * 用法：node scripts/m222-flip-report.ts [--batch m222] [--shards 8]
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { contestedOwnerAt, type ContestRow } from '../src/domain/church/conflict.ts';
import { shardKey, type ShardKey } from '../src/infra/shard-key.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm222');
const SHARDS = Number(argOf('shards', '8'));
const THRESHOLD = NUMERIC.church.conflict.dominanceThreshold;

interface Row extends ContestRow { at: number; id: number; shardKey: ShardKey }
const rows: Row[] = [];
let shardsRead = 0;

for (let s = 0; s < SHARDS; s += 1) {
  let db: DatabaseSync;
  try { db = new DatabaseSync('data/' + BATCH + '-shard-' + s + '.db', { readOnly: true }); } catch { continue; }
  shardsRead += 1;
  const list = db.prepare(
    'SELECT location_id, winner_church_id, delta, created_at, id FROM church_territory_contest ORDER BY created_at, id',
  ).all() as unknown as Array<{ location_id: string; winner_church_id: string; delta: number; created_at: number; id: number }>;
  for (const r of list) {
    rows.push({
      // 跨片 key 必须带片号：八个片的行 id 会重号（K3/K5）
      shardKey: shardKey(s, String(r.id)),
      id: Number(r.id),
      locationId: String(r.location_id),
      winnerChurchId: String(r.winner_church_id),
      delta: Number(r.delta),
      at: Number(r.created_at),
    });
  }
  db.close();
}
rows.sort((a, b) => a.at - b.at || a.id - b.id);

if (shardsRead === 0) {
  console.error('批次 ' + BATCH + ' 一个分片都没打开 —— 先确认跑批产物在不在。');
  process.exit(2);
}

console.log('=== §0 输入 ===');
console.log('  批次 ' + BATCH + '，读到 ' + shardsRead + '/' + SHARDS + ' 片，增量行 ' + rows.length + ' 条');
console.log('  阈值 dominanceThreshold = ' + THRESHOLD + '，衰减 decayPerDay = ' + NUMERIC.church.conflict.decayPerDay);
const wins = rows.filter((r) => r.delta > 0);
const decay = rows.filter((r) => r.delta < 0);
console.log('  正分（PVP 胜利）' + wins.length + ' 条 / 衰减 ' + decay.length + ' 条');

if (rows.length === 0) {
  console.log('');
  console.log('  ⚠️ 增量表是**空的** —— 翻转必然是 0。这不是机制问题：没有任何一次「敌对教会成员之间」的 PVP 胜利被记下来。');
  console.log('     M2.18 B 的实测是「有 5—6 次胜利、但分散到翻不动」，与空表是两回事，要分清。');
  process.exit(0);
}

console.log('');
console.log('=== §1 翻转事件（逐条流水）===');
console.log('  口径：重放全部增量，数「归属从 A 变成 B」且 after 非 null 的次数');
console.log('');
console.log('  | # | 片:行 | 时刻 | 地点 | 变化 |');
console.log('  | --- | --- | --- | --- | --- |');
const ownerBefore = new Map<string, string | null>();
const flippedLocations = new Set<string>();
const perLocationTally = new Map<string, ContestRow[]>();
let fromNone = 0;
let handover = 0;
let index = 0;
for (const row of rows) {
  const tally = perLocationTally.get(row.locationId) ?? [];
  tally.push({ locationId: row.locationId, winnerChurchId: row.winnerChurchId, delta: row.delta });
  perLocationTally.set(row.locationId, tally);
  const before = ownerBefore.get(row.locationId) ?? null;
  const after = contestedOwnerAt(row.locationId, tally, THRESHOLD);
  const afterId = after === null ? null : after.churchId;
  if (afterId !== null && afterId !== before) {
    index += 1;
    if (before === null) fromNone += 1; else handover += 1;
    flippedLocations.add(row.locationId);
    console.log('  | ' + index + ' | ' + row.shardKey + ' | ' + new Date(row.at).toISOString().slice(0, 16) +
      ' | ' + row.locationId + ' | ' + (before === null ? '（底图）' : before) + ' → **' + afterId + '** |');
  }
  ownerBefore.set(row.locationId, afterId);
}

console.log('');
console.log('=== §2 汇总（验收口径）===');
console.log('  · **翻转事件数 = ' + index + '**（从无到有 ' + fromNone + ' + 易主 ' + handover + '）');
console.log('  · **发生归属变更的地点 = ' + flippedLocations.size + ' 个**' +
  (flippedLocations.size > 0 ? '（' + [...flippedLocations].join('、') + '）' : ''));
const byLoc = new Map<string, number>();
for (const r of wins) byLoc.set(r.locationId, (byLoc.get(r.locationId) ?? 0) + r.delta);
console.log('  · 单点累计正分：' + ([...byLoc.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join('、') || '（无）'));

console.log('');
console.log('=== §3 验收判定 ===');
console.log('  | # | 指标 | 门槛 | 实测 | 判定 |');
console.log('  | --- | --- | --- | --- | --- |');
console.log('  | 2 | 翻转事件数 | >= 1 | ' + index + ' | ' + (index >= 1 ? '**通过**' : '未达') + ' |');
console.log('  | 4 | 发生归属变更的地点 | >= 1 | ' + flippedLocations.size + ' | ' + (flippedLocations.size >= 1 ? '**通过**' : '未达') + ' |');
console.log('  | 3 | 翻转事件数（期望） | >= 3 | ' + index + ' | 观察项，不写验收 |');
console.log('  | 5 | 敌对教会间 PVP 胜利（过程） | >= 12 | ' + wins.length + ' | ' + (wins.length >= 12 ? '通过' : '未达（可选指标）') + ' |');
