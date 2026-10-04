#! /usr/bin/env node
/**
 * M2.18 任务 B 的跑批采集：三项争夺指标。
 *
 * 用法：node scripts/m2-18-territory-report.ts --prefix m219a
 *
 *   1. church_territory_contest 行数
 *   2. **翻转次数** —— 按 created_at 重放全部增量，数「归属发生变化」的次数
 *      （分「从无到有」与「易主」两种，判定表看的是总数）
 *   3. **争夺地点覆盖率** —— 落在 contestedLocations 里的探索次数占比
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { contestedOwnerAt, type ContestRow } from '../src/domain/church/conflict.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const index = argv.indexOf('--' + name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};
const PREFIX = argOf('prefix', 'm219a');
const SHARDS = 8;
const THRESHOLD = NUMERIC.church.conflict.dominanceThreshold;
const contested = new Set(NUMERIC.church.conflict.contestedLocations);
const content = loadContent();

/* ---- 1 + 2：增量表与翻转眼 ---- */
interface TimedRow extends ContestRow { createdAt: number; seq: number }
const timed: TimedRow[] = [];
for (let shard = 0; shard < SHARDS; shard += 1) {
  let db: DatabaseSync;
  try { db = new DatabaseSync('data/' + PREFIX + '-shard-' + shard + '.db', { readOnly: true }); } catch { continue; }
  const rows = db
    .prepare('SELECT location_id, winner_church_id, delta, created_at, id FROM church_territory_contest ORDER BY created_at, id')
    .all() as unknown as Array<{ location_id: string; winner_church_id: string; delta: number; created_at: number; id: number }>;
  for (const row of rows) {
    timed.push({
      locationId: row.location_id,
      winnerChurchId: row.winner_church_id,
      delta: Number(row.delta),
      createdAt: Number(row.created_at),
      seq: Number(row.id),
    });
  }
  db.close();
}
timed.sort((a, b) => (a.createdAt === b.createdAt ? a.seq - b.seq : a.createdAt - b.createdAt));

const byLocation = new Map<string, ContestRow[]>();
const ownerNow = new Map<string, string | null>();
let flipsFromNone = 0;
let flipsHandover = 0;
const flipLog: string[] = [];
for (const row of timed) {
  const applied = byLocation.get(row.locationId) ?? [];
  applied.push({ locationId: row.locationId, winnerChurchId: row.winnerChurchId, delta: row.delta });
  byLocation.set(row.locationId, applied);
  const before = ownerNow.get(row.locationId) ?? null;
  const after = contestedOwnerAt(row.locationId, applied, THRESHOLD)?.churchId ?? null;
  if (after !== before) {
    if (before === null && after !== null) flipsFromNone += 1;
    else if (before !== null && after !== null) flipsHandover += 1;
    flipLog.push(row.locationId + ':' + (before ?? '底图') + '->' + (after ?? '底图'));
  }
  ownerNow.set(row.locationId, after);
}

/* ---- 3：争夺地点覆盖率（从行为日志数 .探索） ---- */
const locationByName = new Map(content.locations.map((l) => [l.name, l.id]));
let exploreTotal = 0;
let exploreContested = 0;
const exploredAll = new Map<string, number>();
for (let shard = 0; shard < SHARDS; shard += 1) {
  let text = '';
  try { text = readFileSync('docs/' + PREFIX + '-shard' + shard + '-行为日志.jsonl', 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: { command?: string };
    try { rec = JSON.parse(line) as { command?: string }; } catch { continue; }
    const m = /^\.探索\s+(.+)$/.exec(rec.command ?? '');
    if (!m) continue;
    exploreTotal += 1;
    const id = locationByName.get((m[1] ?? '').trim());
    if (!id) continue;
    exploredAll.set(id, (exploredAll.get(id) ?? 0) + 1);
    if (contested.has(id)) exploreContested += 1;
  }
}

console.log('批：' + PREFIX);
console.log('');
console.log('### 1 增量表');
console.log('- 行数：' + timed.length + '（每片均值 ' + (timed.length / SHARDS).toFixed(1) + '）');
console.log('- 涉及地点：' + byLocation.size + ' 个');
console.log('- 正 delta：' + timed.filter((r) => r.delta > 0).length + '，负 delta（衰减）：' + timed.filter((r) => r.delta < 0).length);
console.log('');
console.log('### 2 翻转');
console.log('- **总翻转次数：' + (flipsFromNone + flipsHandover) + '**（30 天窗口）');
console.log('- 从无到有 ' + flipsFromNone + '，易主 ' + flipsHandover);
console.log('- 末态有归属的地点：' + [...ownerNow.values()].filter((v) => v !== null).length + ' 个');
console.log('- 翻转流水（前 20）：' + flipLog.slice(0, 20).join(' | '));
console.log('');
console.log('### 3 争夺地点覆盖率');
console.log('- 探索总数 ' + exploreTotal + '，落在可争夺集里 ' + exploreContested + ' = **' + ((exploreContested / Math.max(1, exploreTotal)) * 100).toFixed(1) + '%**');
console.log('- 可争夺集 ' + contested.size + ' 个地点，被探索过的 ' + [...exploredAll.keys()].filter((id) => contested.has(id)).length + ' 个');
