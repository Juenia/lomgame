#!/usr/bin/env node
/**
 * M2.16：**8 分片合并覆盖率 + 合并异常 + 教会专项**。
 *
 * 用法：node scripts/m2-16-merged-report.ts
 *
 * 产出：
 *   1. docs/M2.16-覆盖率.md —— 教会专项（本轮的新口径）+ 8 分片合并覆盖率
 *   2. docs/M2.16-异常.md   —— 8 分片合并异常
 *
 * ## 为什么不重跑批
 *
 * 结果已经落在 data/m216-shards/m216-shard-N.json 与 data/m216-shard-N.db。这一份脚本**只读**。
 *
 * ## 教会专项的三组数（全部从库里数，不手抄 stdout —— 铁律 11）
 *
 *   1. **入教**：characters.church_id 非空的人数 ÷「本可以入教」的人数。
 *      「本可以」= 途径已实现（sleepless / warrior）**且**他此刻所在城市在那家教会的 seats 里 ——
 *      与服务端 canJoin 的第 3—5 条同源（**比分母更严**，所以它是更保守的口径）。
 *   2. **捐献与升档**：church_contribute / church_rank_up 的条数、金额、贡献，以及 source 分布。
 *   3. **档位分布**：用 domain/church/membership.ts 的 currentRank **复算** —— 与运行时同一个纯函数。
 *
 * 外加两条如实记录的口径：「升过档的人」与「拿过赏金的人」的重合度；
 * 以及 seer 人口与上一轮（m214a）基线的对照。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadChurches } from '../src/data/loader.ts';
import { currentRank } from '../src/domain/church/membership.ts';
import { mergeShards } from '../src/vplayer/merge.ts';
import { renderCoverageReport } from '../src/vplayer/report.ts';
import { SHARD_SCHEMA, type ShardJson } from '../src/vplayer/shard-json.ts';

const SHARDS = 8;
const PREFIX = 'm216';
const JSON_DIR = 'data/m216-shards';
const BASELINE_PREFIX = 'm214a';

const churchById = new Map(loadChurches().churches.map((church) => [church.id, church]));
const N = String.fromCharCode(96);
const code = (s: string): string => N + s + N;

interface ChurchStats {
  shard: number;
  characters: number;
  byPathway: Map<string, number>;
  joined: number;
  /** 途径已实现（sleepless / warrior）的人数 —— 任务书 F 的分母 */
  pathwayJoinable: number;
  /** 此刻城市也在堂口城市里的人（辅助口径的分母） */
  joinableNow: number;
  /** 已入教、且此刻站在自己教会的堂口城市里（辅助口径的分子） */
  joinedNow: number;
  /** 已入教、但此刻不在堂口城市 —— **正常**：入教之后走动过 */
  joinedAway: number;
  joins: number;
  contributes: number;
  rankUps: number;
  rankUpBySource: Map<string, number>;
  donatedPenny: number;
  gainedContribution: number;
  rankHistogram: Map<number, number>;
  joinedWithBounty: number;
  rankedWithBounty: number;
  seer: number;
  initiated: number;
}

function emptyStats(shard: number): ChurchStats {
  return {
    shard, characters: 0, byPathway: new Map(), joined: 0, pathwayJoinable: 0, joinableNow: 0,
    joinedNow: 0, joinedAway: 0,
    joins: 0, contributes: 0, rankUps: 0, rankUpBySource: new Map(), donatedPenny: 0,
    gainedContribution: 0, rankHistogram: new Map(), joinedWithBounty: 0, rankedWithBounty: 0,
    seer: 0, initiated: 0,
  };
}

/** 可以入教的人：途径已实现，且此刻所在城市在那家教会的 seats 里 */
function joinableChurchOf(pathway: string | null, cityId: string | null): string | null {
  if (!pathway || !cityId) return null;
  for (const church of churchById.values()) {
    if (church.pathway === pathway && church.seats.includes(cityId)) return church.id;
  }
  return null;
}

function readShard(shard: number, prefix = PREFIX, collect = true): ChurchStats {
  const stats = emptyStats(shard);
  const dbPath = join('data', prefix + '-shard-' + shard + '.db');
  if (!existsSync(dbPath)) return stats;
  const db = new DatabaseSync(dbPath, { readOnly: true });

  /*
   * 基线库（m214a）**没有** church_id / church_contribution 两列 —— 那是 M2.16 的迁移加的。
   * 所以数人口学时用一个不含新列的 SELECT（基线只用来对照 seer 与入途径人数）。
   */
  const columns = collect
    ? 'id, pathway, sequence, pathway_status, current_city_id, church_id, church_contribution'
    : 'id, pathway, sequence, pathway_status, current_city_id';
  const rows = db.prepare('SELECT ' + columns + ' FROM characters').all() as Array<{
    id: string; pathway: string | null; sequence: number | null; pathway_status: string | null;
    current_city_id: string | null; church_id?: string | null; church_contribution?: number | null;
  }>;

  const bountyUsers = new Set(
    (db.prepare("SELECT DISTINCT character_id AS id FROM domain_events WHERE type = 'bounty_claimed'").all() as Array<{ id: string }>)
      .map((row) => row.id),
  );
  const rankedUsers = new Set(
    (db.prepare("SELECT DISTINCT character_id AS id FROM domain_events WHERE type = 'church_rank_up'").all() as Array<{ id: string }>)
      .map((row) => row.id),
  );

  for (const row of rows) {
    stats.characters += 1;
    const pathway = row.pathway === null ? '(mortal)' : String(row.pathway);
    stats.byPathway.set(pathway, (stats.byPathway.get(pathway) ?? 0) + 1);
    if ((row.pathway_status ?? (row.pathway ? 'initiated' : 'mortal')) === 'initiated') stats.initiated += 1;
    if (pathway === 'seer') stats.seer += 1;
    if (!collect) continue;

    /*
     * 两个分母要分开数，否则会算出 >100% 的入教率：
     *   - **任务书口径**：途径已实现的人数（不管他此刻在哪）——
     *     入教是一次性动作，玩家完全可以入完教再走去别的城市；
     *   - **此刻口径**（辅助）：此刻站在堂口城市里的人 —— 它回答的是
     *     「现在这一刻，有多少人够得着教会」，那是 M2.17 势力争夺关心的数。
     */
    if (row.pathway === 'sleepless' || row.pathway === 'warrior') stats.pathwayJoinable += 1;
    const expected = joinableChurchOf(row.pathway, row.current_city_id);
    if (expected) stats.joinableNow += 1;
    const churchId = row.church_id === null ? null : String(row.church_id);
    if (churchId) {
      stats.joined += 1;
      if (expected) stats.joinedNow += 1;
      else stats.joinedAway += 1;
      const church = churchById.get(churchId);
      if (church) {
        const rank = currentRank({ churchContribution: Number(row.church_contribution ?? 0), sequence: row.sequence }, church);
        stats.rankHistogram.set(rank, (stats.rankHistogram.get(rank) ?? 0) + 1);
      }
      if (bountyUsers.has(row.id)) stats.joinedWithBounty += 1;
    }
    if (rankedUsers.has(row.id) && bountyUsers.has(row.id)) stats.rankedWithBounty += 1;
  }

  const groupSql =
    "SELECT type, COUNT(*) AS n, " +
    "COALESCE(SUM(json_extract(payload, '$.penny')), 0) AS penny, " +
    "COALESCE(SUM(json_extract(payload, '$.contribution')), 0) AS contribution " +
    "FROM domain_events WHERE type LIKE 'church%' GROUP BY type";
  for (const row of db.prepare(groupSql).all() as Array<{ type: string; n: number; penny: number; contribution: number }>) {
    if (row.type === 'church_join') stats.joins += Number(row.n);
    if (row.type === 'church_contribute') {
      stats.contributes += Number(row.n);
      stats.donatedPenny += Number(row.penny);
      stats.gainedContribution += Number(row.contribution);
    }
    if (row.type === 'church_rank_up') stats.rankUps += Number(row.n);
  }
  const sourceSql =
    "SELECT COALESCE(json_extract(payload, '$.source'), '(缺失)') AS source, COUNT(*) AS n " +
    "FROM domain_events WHERE type = 'church_rank_up' GROUP BY source";
  for (const row of db.prepare(sourceSql).all() as Array<{ source: string; n: number }>) {
    stats.rankUpBySource.set(row.source, Number(row.n));
  }
  db.close();
  return stats;
}

/* ---------------- 读分片 ---------------- */

const entries: { index: number; json: ShardJson }[] = [];
for (let index = 0; index < SHARDS; index += 1) {
  const path = join(JSON_DIR, PREFIX + '-shard-' + index + '.json');
  if (!existsSync(path)) throw new Error('找不到分片 JSON：' + path);
  const json = JSON.parse(readFileSync(path, 'utf8')) as ShardJson;
  if (json.schema !== SHARD_SCHEMA) throw new Error('分片口径不一致：' + path);
  entries.push({ index, json });
}
const merged = mergeShards(entries.map((entry) => entry.json));
const stats = Array.from({ length: SHARDS }, (_, index) => readShard(index));
const baseline = Array.from({ length: SHARDS }, (_, index) => readShard(index, BASELINE_PREFIX, false));

const sum = (pick: (s: ChurchStats) => number): number => stats.reduce((acc, s) => acc + pick(s), 0);
const bsum = (pick: (s: ChurchStats) => number): number => baseline.reduce((acc, s) => acc + pick(s), 0);
const pct = (value: number, base: number): string => (base > 0 ? ((value / base) * 100).toFixed(1) + '%' : '—');

const joinable = sum((s) => s.pathwayJoinable);
const joinableNow = sum((s) => s.joinableNow);
const joinedNow = sum((s) => s.joinedNow);
const joined = sum((s) => s.joined);
const rankUps = sum((s) => s.rankUps);
const rankHistogram = new Map<number, number>();
for (const s of stats) for (const [rank, count] of s.rankHistogram) rankHistogram.set(rank, (rankHistogram.get(rank) ?? 0) + count);
const sourceHistogram = new Map<string, number>();
for (const s of stats) for (const [source, count] of s.rankUpBySource) sourceHistogram.set(source, (sourceHistogram.get(source) ?? 0) + count);
const pathwayHistogram = new Map<string, number>();
for (const s of stats) for (const [pathway, count] of s.byPathway) pathwayHistogram.set(pathway, (pathwayHistogram.get(pathway) ?? 0) + count);

/* ---------------- 渲染 ---------------- */

const lines: string[] = [];
const P = (s = ''): void => { lines.push(s); };

P('# M2.16 合并覆盖率（8 分片 · 200 人 × 30 天）');
P();
P('> 数据来源：' + code(JSON_DIR + '/m216-shard-N.json') + '（覆盖率与异常）与 ' + code('data/m216-shard-N.db') + '（教会专项）。');
P('> 合并走 ' + code('src/vplayer/merge.ts') + '；档位分布用 ' + code('domain/church/membership.ts') + ' 的 ' +
  code('currentRank') + ' **复算**（与运行时同一个纯函数）。');
P('> **逐片明细一律进本报告**（铁律 11）：合计行必须等于各片之和。');
P();
P('## 一、跑批口径');
P();
P('- 玩家行为 seed：' + code('m216:shard:<i>') + '（按片派生）；世界 seed：' + code('world') + '（全片同一个）');
P('- 片内玩家数：25 × 8；天数：30');
P('- 基线对照：' + code(BASELINE_PREFIX) + '（M2.14 交付批，同世界 seed、同人数口径）');
P();
P('## 二、入教覆盖');
P();
P('| 项 | 值 |');
P('| --- | --- |');
P('| 角色总数 | ' + sum((s) => s.characters) + ' |');
P('| **途径已实现**（' + code('sleepless') + ' + ' + code('warrior') + '） | **' + joinable + '** |');
P('| **实际入教** | **' + joined + '** |');
P('| **入教率（任务书口径）** | **' + pct(joined, joinable) + '** |');
P();
P('辅助口径（**此刻**这一刻够不够得着教会 —— M2.17 势力争夺关心的那个数）：');
P();
P('| 项 | 值 |');
P('| --- | --- |');
P('| 此刻站在某家教会堂口城市的玩家 | ' + joinableNow + ' |');
P('| 其中已入教 | ' + joinedNow + ' |');
P('| 已入教但此刻不在堂口城市 | ' + sum((s) => s.joinedAway) + ' |');
P();
P('> 任务书 F 的门槛是「' + code('sleepless') + ' + ' + code('warrior') + ' 玩家中 ≥ 50% 入教」——');
P('> 上式就是那个口径。**两个分母不能混用**：入教是一次性动作，玩家完全可以入完教再走去别的城市，');
P('> 拿「此刻站在堂口城市」当分母会算出 > 100% 的入教率（第一版就是这么错的）。');
P('> 「已入教但此刻不在堂口城市」是**正常**现象，不是异常。');
P();
P('途径分布（合并）：');
P();
P('| 途径 | 人数 |');
P('| --- | --- |');
for (const [pathway, count] of [...pathwayHistogram.entries()].sort((a, b) => b[1] - a[1])) {
  P('| ' + code(pathway) + ' | ' + count + ' |');
}
P();
P('### 2.1 ' + code('seer') + ' 的对照（「引导完成率不因本轮下降」）');
P();
P('| 项 | ' + BASELINE_PREFIX + '（上一轮基线） | m216（本轮） |');
P('| --- | --- | --- |');
P('| 角色总数 | ' + bsum((s) => s.characters) + ' | ' + sum((s) => s.characters) + ' |');
P('| 已入途径 | ' + bsum((s) => s.initiated) + '（' + pct(bsum((s) => s.initiated), bsum((s) => s.characters)) + '） | ' +
  sum((s) => s.initiated) + '（' + pct(sum((s) => s.initiated), sum((s) => s.characters)) + '） |');
P('| 其中 ' + code('seer') + ' | ' + bsum((s) => s.seer) + ' | ' + sum((s) => s.seer) + ' |');
P();
P('> ' + code('seer') + ' 玩家在七正神里没有落点，走的是引导路径 —— 本轮**没有**动那条链路，');
P('> 所以这两行应当持平（差异由虚拟玩家的行为随机性解释，不是机制变化）。');
P();
P('## 三、捐献与教内等级');
P();
P('| 项 | 值 |');
P('| --- | --- |');
P('| ' + code('church_join') + ' 事件 | ' + sum((s) => s.joins) + ' |');
P('| ' + code('church_contribute') + ' 事件 | ' + sum((s) => s.contributes) + ' |');
P('| **' + code('church_rank_up') + ' 事件** | **' + rankUps + '** |');
P('| 捐献总额（便士） | ' + sum((s) => s.donatedPenny) + ' |');
P('| 换到的贡献点合计 | ' + sum((s) => s.gainedContribution) + ' |');
P();
P('> 任务书 F 的门槛：' + code('church_rank_up') + ' **≥ 50 且 ≤ 500**。');
P();
P('升档按触发点拆开（「双触发」在跑批里的可见形式）：');
P();
P('| source | 条数 |');
P('| --- | --- |');
for (const [source, count] of [...sourceHistogram.entries()].sort((a, b) => b[1] - a[1])) {
  P('| ' + code(source) + ' | ' + count + ' |');
}
P();
P('> ' + code('donate') + ' = 捐款当场升的；' + code('daily_tick') + ' = **捐款时序列不够、后来序列补上了**，由每日结算认的。');
P('> 后者为 0 不算错（窗口里可能没人卡在序列门槛上），但**两处都写对了**才可能有它。');
P();
P('档位分布（已入教的人，按 ' + code('currentRank') + ' 复算）：');
P();
P('| 档位 | 人数 |');
P('| --- | --- |');
for (const rank of [...rankHistogram.keys()].sort((a, b) => a - b)) {
  P('| 第 ' + (rank + 1) + ' 档（索引 ' + rank + '） | ' + rankHistogram.get(rank) + ' |');
}
P();
P('### 3.1 「升过档的人」与「拿过赏金的人」的重合度');
P();
P('| 项 | 值 |');
P('| --- | --- |');
P('| 入过教且拿过赏金 | ' + sum((s) => s.joinedWithBounty) + ' |');
P('| 升过档且拿过赏金 | ' + sum((s) => s.rankedWithBounty) + ' |');
P();
P('> M2.16 交付说明 §5.1 声明过：本版**唯一的贡献来源是钱**，而钱的最大来源是赏金 ——');
P('> 所以档位分布会与「举报过通缉犯的那批人」高度重合。这一行就是那件事的取证。');
P('> 它不是 bug；M2.17 加了非金钱来源之后这一行会变。');
P();
P('## 四、逐片明细');
P();
P('| 片 | 角色 | 途径已实现 | 入教 | 此刻可入教 | 捐献次数 | 捐献便士 | 升档 | 每日结算触发 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const s of stats) {
  P('| ' + s.shard + ' | ' + s.characters + ' | ' + s.pathwayJoinable + ' | ' + s.joined + ' | ' +
    s.joinableNow + ' | ' + s.contributes + ' | ' + s.donatedPenny + ' | ' + s.rankUps + ' | ' +
    (s.rankUpBySource.get('daily_tick') ?? 0) + ' |');
}
P('| **合计** | **' + sum((s) => s.characters) + '** | **' + joinable + '** | **' + joined + '** | **' +
  joinableNow + '** | **' + sum((s) => s.contributes) + '** | **' + sum((s) => s.donatedPenny) + '** | **' +
  rankUps + '** | **' + (sourceHistogram.get('daily_tick') ?? 0) + '** |');
P();
P('---');
P();
P('## 五、覆盖率（合并）');
P();
P(renderCoverageReport({ stage: 'M2.16', players: merged.players, days: merged.days, seed: PREFIX, coverage: merged.coverage }));
writeFileSync(join('docs', 'M2.16-覆盖率.md'), lines.join('\n'), 'utf8');

/* ---------------- 合并异常 ---------------- */

const byCode = new Map<string, number>();
for (const entry of merged.anomalies) byCode.set(entry.code, (byCode.get(entry.code) ?? 0) + 1);
const ano: string[] = [];
const A = (s = ''): void => { ano.push(s); };
A('# M2.16 合并异常（8 分片 · 200 人 × 30 天）');
A();
A('| 代码 | 条数 |');
A('| --- | --- |');
for (const [entryCode, count] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) A('| ' + entryCode + ' | ' + count + ' |');
A();
A('| **合计** | **' + merged.anomalies.length + '** |');
A();
A('## 逐条明细（前 50 条）');
A();
A('| 级别 | 代码 | 玩家 | 天 | 指令 | 说明 |');
A('| --- | --- | --- | --- | --- | --- |');
for (const entry of merged.anomalies.slice(0, 50)) {
  A('| ' + entry.level + ' | ' + entry.code + ' | ' + entry.playerId + ' | ' + entry.day + ' | ' +
    code(String(entry.command ?? '—')) + ' | ' + String(entry.detail ?? '').slice(0, 90).split('|').join('/') + ' |');
}
A();
A('> 异常口径与逐条字段沿用 ' + code('src/vplayer/anomaly.ts') + '；本轮没有新增异常类型。');
writeFileSync(join('docs', 'M2.16-异常.md'), ano.join('\n'), 'utf8');

console.log('已写出 docs/M2.16-覆盖率.md 与 docs/M2.16-异常.md');
console.log('入教 ' + joined + ' / 可入教 ' + joinable + '（' + pct(joined, joinable) + '）；church_rank_up ' + rankUps);
