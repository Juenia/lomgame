#!/usr/bin/env node
/**
 * M2.17 任务 B/C 的跑批采集（两批 m218：现状 vs 关教会行为）。
 *
 * 用法：node scripts/m2-17-m218-report.ts
 *
 * 口径与前几轮逐条相同（scripts/m2-17-attribution.ts 的那批 SQL），另加三项本轮新增：
 *   1. church_taboo_violation —— 教义 flag 到底触发了几次、按判据拆开
 *   2. 教会技能解锁 —— 用 currentRank + unlockedChurchAbilities **复算**（不落库，与运行期同一个纯函数）
 *   3. 入教 / 捐献 / 升档 —— 教会行为的三件套（M2.16 起）
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadContent } from '../src/data/loader.ts';
import { unlockedChurchAbilities } from '../src/domain/ability/ability.ts';
import { currentRank } from '../src/domain/church/membership.ts';

const SHARDS = 8;
const content = loadContent();
const churchById = new Map(content.churches.map((church) => [church.id, church]));

interface Row {
  shard: number;
  characters: number;
  initiated: number;
  seq8: number;
  seq7: number;
  play: number;
  explore: number;
  churchJoin: number;
  churchContribute: number;
  churchRankUp: number;
  violations: number;
  violationByTaboo: Map<string, number>;
  joined: number;
  abilitiesUnlocked: number;
  rankHistogram: Map<number, number>;
  purify: number;
  rest: number;
  madAvg: number;
  corAvg: number;
}

function emptyRow(shard: number): Row {
  return {
    shard, characters: 0, initiated: 0, seq8: 0, seq7: 0, play: 0, explore: 0,
    churchJoin: 0, churchContribute: 0, churchRankUp: 0, violations: 0,
    violationByTaboo: new Map(), joined: 0, abilitiesUnlocked: 0, rankHistogram: new Map(),
    purify: 0, rest: 0, madAvg: 0, corAvg: 0,
  };
}

function readShard(prefix: string, shard: number): Row {
  const row = emptyRow(shard);
  const path = join('data', prefix + '-shard-' + shard + '.db');
  if (!existsSync(path)) return row;
  const db = new DatabaseSync(path, { readOnly: true });
  const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
  row.characters = one('SELECT COUNT(*) AS n FROM characters');
  row.initiated = one('SELECT COUNT(*) AS n FROM characters WHERE sequence IS NOT NULL');
  row.seq8 = one('SELECT COUNT(*) AS n FROM characters WHERE sequence = 8');
  row.seq7 = one('SELECT COUNT(*) AS n FROM characters WHERE sequence IS NOT NULL AND sequence <= 7');
  row.play = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'dig_delta' AND reason LIKE '%扮演%'");
  row.explore = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'ap_delta' AND reason LIKE '%探索%'");
  row.churchJoin = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'church_join'");
  row.churchContribute = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'church_contribute'");
  row.churchRankUp = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'church_rank_up'");
  row.violations = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'church_taboo_violation'");
  // 教义罚则的**间接**挤占路径：MAD/COR 升高 → 更多 .净化 / .休息 占掉动作位
  row.purify = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'ap_delta' AND reason = '净化'");
  row.rest = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'ap_delta' AND reason = '休息'");
  const stats = db.prepare('SELECT AVG(mad) AS mad, AVG(cor) AS cor FROM characters').get() as unknown as { mad: number | null; cor: number | null };
  row.madAvg = Number(stats.mad ?? 0);
  row.corAvg = Number(stats.cor ?? 0);
  const byTaboo = db.prepare("SELECT payload FROM domain_events WHERE type = 'church_taboo_violation'").all() as unknown as Array<{ payload: string }>;
  for (const entry of byTaboo) {
    let id = '(unparsed)';
    try { id = String((JSON.parse(entry.payload) as { tabooId?: string }).tabooId ?? id); } catch { /* 保持 unparsed */ }
    row.violationByTaboo.set(id, (row.violationByTaboo.get(id) ?? 0) + 1);
  }
  // 教会技能：用运行期同一个纯函数复算（解锁状态不落库）
  const members = db.prepare('SELECT church_id, church_contribution, sequence FROM characters WHERE church_id IS NOT NULL').all() as unknown as Array<{ church_id: string; church_contribution: number | null; sequence: number | null }>;
  row.joined = members.length;
  for (const member of members) {
    const church = churchById.get(member.church_id);
    if (!church) continue;
    const rank = currentRank({ churchContribution: member.church_contribution ?? 0, sequence: member.sequence }, church);
    row.rankHistogram.set(rank, (row.rankHistogram.get(rank) ?? 0) + 1);
    row.abilitiesUnlocked += unlockedChurchAbilities(rank, member.church_id, content.churchAbilities).length;
  }
  db.close();
  return row;
}

const BATCHES = [
  { key: 'm218a', label: 'A 现状（含教会行为）' },
  { key: 'm218b', label: 'B 关教会行为（M217_CHURCH=off）' },
  { key: 'm216', label: 'M2.16 交付批（对照）' },
  { key: 'm217a', label: 'M2.17 第 0 步 A 版（对照）' },
];

const data = new Map<string, Row[]>();
for (const batch of BATCHES) {
  data.set(batch.key, Array.from({ length: SHARDS }, (_, shard) => readShard(batch.key, shard)));
}

const sum = (rows: Row[], pick: (r: Row) => number): number => rows.reduce((acc, r) => acc + pick(r), 0);
const per = (rows: Row[], pick: (r: Row) => number): number => sum(rows, pick) / rows.length;
const rate = (rows: Row[]): number => {
  const base = sum(rows, (r) => r.initiated);
  return base > 0 ? (sum(rows, (r) => r.seq8) / base) * 100 : 0;
};
const f1 = (value: number): string => value.toFixed(1);

const out: string[] = [];
const P = (line = ''): void => { out.push(line); };

P('### 1 汇总（8 片合计）');
P();
P('| 批 | 角色 | 入途径 | 序列 8 | **入途径→8** | ≤7 | 扮演/片 | 探索/片 | 入教 | 捐献 | 升档 | 教义违反 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const batch of BATCHES) {
  const rows = data.get(batch.key)!;
  P('| ' + batch.key + ' | ' + sum(rows, (r) => r.characters) + ' | ' + sum(rows, (r) => r.initiated) + ' | ' +
    sum(rows, (r) => r.seq8) + ' | **' + f1(rate(rows)) + '%** | ' + sum(rows, (r) => r.seq7) + ' | ' +
    f1(per(rows, (r) => r.play)) + ' | ' + f1(per(rows, (r) => r.explore)) + ' | ' +
    sum(rows, (r) => r.churchJoin) + ' | ' + sum(rows, (r) => r.churchContribute) + ' | ' +
    sum(rows, (r) => r.churchRankUp) + ' | ' + sum(rows, (r) => r.violations) + ' |');
}
P();
P('### 2 教义违反（本轮新增）');
P();
for (const batch of BATCHES) {
  const rows = data.get(batch.key)!;
  const total = sum(rows, (r) => r.violations);
  const merged = new Map<string, number>();
  for (const row of rows) for (const [id, n] of row.violationByTaboo) merged.set(id, (merged.get(id) ?? 0) + n);
  const detail = [...merged.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => id + '=' + n).join('、') || '（无）';
  P('- **' + batch.key + '**：合计 ' + total + ' 条，每片均值 ' + f1(total / SHARDS) + ' —— ' + detail);
}
P();
P('### 3 教会技能解锁（用纯函数复算，不落库）');
P();
P('| 批 | 入教人数 | rank 分布 | 已解锁技能条数（人×条） |');
P('| --- | --- | --- | --- |');
for (const batch of BATCHES) {
  const rows = data.get(batch.key)!;
  const histogram = new Map<number, number>();
  for (const row of rows) for (const [rank, n] of row.rankHistogram) histogram.set(rank, (histogram.get(rank) ?? 0) + n);
  const dist = [...histogram.entries()].sort((a, b) => a[0] - b[0]).map(([rank, n]) => 'rank' + rank + '=' + n).join('、') || '（无）';
  P('| ' + batch.key + ' | ' + sum(rows, (r) => r.joined) + ' | ' + dist + ' | ' + sum(rows, (r) => r.abilitiesUnlocked) + ' |');
}
P();
P('### 4 逐片：入途径 → 8');
P();
P('| 批 | 片0 | 片1 | 片2 | 片3 | 片4 | 片5 | 片6 | 片7 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const batch of BATCHES) {
  const rows = data.get(batch.key)!;
  P('| ' + batch.key + ' | ' + rows.map((r) => (r.initiated > 0 ? f1((r.seq8 / r.initiated) * 100) : '0.0') + '%').join(' | ') + ' |');
}
P();
P('### 5 逐片：教义违反');
P();
P('| 批 | 片0 | 片1 | 片2 | 片3 | 片4 | 片5 | 片6 | 片7 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const batch of BATCHES) {
  const rows = data.get(batch.key)!;
  P('| ' + batch.key + ' | ' + rows.map((r) => r.violations).join(' | ') + ' |');
}
P();
P('### 6 教义罚则的间接挤占路径（净化 / 休息 / MAD / COR）');
P();
P('| 批 | 净化/片 | 休息/片 | 平均 MAD | 平均 COR |');
P('| --- | --- | --- | --- | --- |');
for (const batch of BATCHES) {
  const rows = data.get(batch.key)!;
  P('| ' + batch.key + ' | ' + f1(per(rows, (r) => r.purify)) + ' | ' + f1(per(rows, (r) => r.rest)) + ' | ' +
    f1(per(rows, (r) => r.madAvg)) + ' | ' + f1(per(rows, (r) => r.corAvg)) + ' |');
}
P();
P('### 7 逐片：扮演量（动作挤占的载体）');
P();
P('| 批 | 片0 | 片1 | 片2 | 片3 | 片4 | 片5 | 片6 | 片7 | 均值 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const batch of BATCHES) {
  const rows = data.get(batch.key)!;
  P('| ' + batch.key + ' | ' + rows.map((r) => r.play).join(' | ') + ' | ' + f1(per(rows, (r) => r.play)) + ' |');
}
P();
console.log(out.join('\n'));
