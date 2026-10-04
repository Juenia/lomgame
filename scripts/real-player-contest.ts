#! /usr/bin/env node
/**
 * M2.22 任务 2b：**真人小样本的取数脚本**（协议见 docs/真人小样本协议.md）。
 *
 * 与跑批脚本的区别只有一个：**它读真人库，不跑批**。
 * 表结构与跑批库相同（同一套 migrations），所以口径可以直接对齐：
 *
 *   · 跨教会 PVP —— `battles` 里 is_pvp = 1 且双方 church_id 都非 null 且不同；
 *   · 敌对教会 —— 上面那一批里 relationOf(a, b) === 'hostile' 的那些
 *     （判定一律走 ChurchIndex，与 recordTerritoryContest 同一套，不重实现）；
 *   · 翻转 —— **与 m222 同口径**：重放 church_territory_contest，数「归属从 A 变成 B」
 *     且 after 非 null 的次数（地点级 + 事件级）。
 *
 * 用法：
 *   node scripts/real-player-contest.ts --db data/beta.db
 *   node scripts/real-player-contest.ts --db data/beta.db --json docs/真人小样本-取数.json
 *
 * 只读打开，不改任何库。
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { NUMERIC } from '../src/config/numeric.ts';
import { ChurchIndex } from '../src/domain/church/index.ts';
import { contestedOwnerAt, type ContestRow } from '../src/domain/church/conflict.ts';
import { loadChurches, loadCities, loadLocations } from '../src/data/loader.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const DB = argOf('db', 'data/beta.db');
const JSON_OUT = argOf('json', '');

const churches = loadChurches().churches;
const index = new ChurchIndex(churches, loadCities().cities, loadLocations().locations);
const THRESHOLD = NUMERIC.church.conflict.dominanceThreshold;

let db: DatabaseSync;
try {
  db = new DatabaseSync(DB, { readOnly: true });
} catch (error) {
  console.error('打不开库 ' + DB + '：' + String(error));
  process.exit(2);
}

const has = (table: string): boolean => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
};

interface CharRow { id: string; name: string; church_id: string | null }

const chars = new Map<string, CharRow>();
for (const row of db.prepare('SELECT id, name, church_id FROM characters').all() as unknown as CharRow[]) {
  chars.set(String(row.id), { id: String(row.id), name: String(row.name), church_id: row.church_id ?? null });
}

console.log('=== §0 输入 ===');
console.log('  库：' + DB);
console.log('  角色 ' + chars.size + ' 人');
const span = db.prepare('SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM domain_events').get() as
  | { a: number | null; b: number | null }
  | undefined;
if (span && span.a && span.b) {
  const days = (Number(span.b) - Number(span.a)) / 86400000;
  console.log(
    '  事件时段：' + new Date(Number(span.a)).toISOString().slice(0, 10) + ' → ' +
      new Date(Number(span.b)).toISOString().slice(0, 10) + '（' + days.toFixed(1) + ' 天）',
  );
  if (days < 14) console.log('  ⚠️ **时长不足 14 天** —— 按协议第 6 节，结论只能记为「轶事」，不能当数据用。');
}
console.log('');

/* ==================== §1 跨教会 PVP ==================== */
console.log('=== §1 跨教会 PVP（协议的主指标）===');
interface PvpRow {
  id: number;
  character_id: string;
  opponent_character_id: string | null;
  location_id: string | null;
  status: string;
  started_at: number;
}
const pvps: PvpRow[] = has('battles')
  ? (db.prepare(
      'SELECT id, character_id, opponent_character_id, location_id, status, started_at FROM battles WHERE is_pvp = 1 ORDER BY started_at, id',
    ).all() as unknown as PvpRow[])
  : [];
if (!has('battles')) console.log('  （这个库没有 battles 表 —— 旧库或还没打过架）');
if (pvps.length === 0 && has('battles')) console.log('  （一场 PVP 都没有）');

let bothInChurch = 0;
let crossChurch = 0;
let hostile = 0;
let neutral = 0;
let ally = 0;
let sameChurch = 0;
let oneSideNoChurch = 0;
const crossRows: string[] = [];
const participants = new Set<string>();

for (const row of pvps) {
  const a = chars.get(String(row.character_id));
  const b = row.opponent_character_id ? chars.get(String(row.opponent_character_id)) : undefined;
  if (!a || !b) continue;
  if (!a.church_id || !b.church_id) {
    oneSideNoChurch += 1;
    continue;
  }
  bothInChurch += 1;
  if (a.church_id === b.church_id) {
    sameChurch += 1;
    continue;
  }
  crossChurch += 1;
  const relation = index.relationOf(a.church_id, b.church_id);
  if (relation === 'hostile') hostile += 1;
  else if (relation === 'ally') ally += 1;
  else neutral += 1;
  participants.add(a.id);
  participants.add(b.id);
  crossRows.push(
    '  | ' + new Date(Number(row.started_at)).toISOString().slice(0, 16) +
      ' | ' + a.name + '（' + a.church_id + '） | ' + b.name + '（' + b.church_id + '） | ' +
      relation + ' | ' + (row.location_id ?? '—') + ' | ' + row.status + ' |',
  );
}

console.log('  PVP 总场次（is_pvp = 1）：' + pvps.length);
console.log('  双方都入教：' + bothInChurch + '　其中**跨教会**：**' + crossChurch + '**（敌对 ' + hostile + ' / 中立 ' + neutral + ' / 同盟 ' + ally + '）');
console.log('  同教会：' + sameChurch + '　有一方没入教：' + oneSideNoChurch);
console.log('  参与者：' + participants.size + ' 人');
console.log('');
if (crossRows.length) {
  console.log('  | 时刻 | 发起者 | 对手 | 关系 | 地点 | 状态 |');
  console.log('  | --- | --- | --- | --- | --- | --- |');
  for (const line of crossRows) console.log(line);
  console.log('');
}

/* ==================== §2 争夺记账与翻转 ==================== */
console.log('=== §2 势力争夺（记账与翻转，与 m222 同口径）===');
const contests: Array<ContestRow & { id: number; at: number }> = has('church_territory_contest')
  ? (
      db.prepare('SELECT id, location_id, winner_church_id, delta, created_at FROM church_territory_contest ORDER BY created_at, id')
        .all() as unknown as Array<{ id: number; location_id: string; winner_church_id: string; delta: number; created_at: number }>
    ).map((r) => ({
      id: Number(r.id),
      at: Number(r.created_at),
      locationId: String(r.location_id),
      winnerChurchId: String(r.winner_church_id),
      delta: Number(r.delta),
    }))
  : [];
console.log('  church_territory_contest 行数：' + contests.length);
console.log('  阈值 dominanceThreshold = ' + THRESHOLD);

if (contests.length === 0) {
  console.log('  ⚠️ 增量表是空的 ⇒ **翻转必然是 0**。这不是机制问题：');
  console.log('     没有任何一次「敌对教会成员之间」的 PVP 胜利被记下来（§1 的敌对那一格是它的上游）。');
} else {
  // 与 scripts/m222-flip-report.ts **逐字同口径**（照抄那一段的循环，不重实现）
  const perLocationTally = new Map<string, ContestRow[]>();
  const ownerBefore = new Map<string, string | null>();
  const flips: string[] = [];
  const flipLocations = new Set<string>();
  let fromNone = 0;
  let handover = 0;
  for (const row of contests) {
    const tally = perLocationTally.get(row.locationId) ?? [];
    tally.push({ locationId: row.locationId, winnerChurchId: row.winnerChurchId, delta: row.delta });
    perLocationTally.set(row.locationId, tally);
    const before = ownerBefore.get(row.locationId) ?? null;
    const after = contestedOwnerAt(row.locationId, tally, THRESHOLD);
    const afterId = after === null ? null : after.churchId;
    if (afterId !== null && afterId !== before) {
      if (before === null) fromNone += 1;
      else handover += 1;
      flipLocations.add(row.locationId);
      flips.push(
        '  | ' + new Date(row.at).toISOString().slice(0, 16) + ' | ' + row.locationId + ' | ' +
          (before ?? '（底图）') + ' → **' + afterId + '** |',
      );
    }
    ownerBefore.set(row.locationId, afterId);
  }
  console.log('  **翻转事件数 = ' + flips.length + '**（地点级 + 事件级；从无到有 ' + fromNone + ' + 易主 ' + handover + '）');
  console.log('  **发生归属变更的地点 = ' + flipLocations.size + ' 个**');
  if (flips.length) {
    console.log('  | 时刻 | 地点 | 变化 |');
    console.log('  | --- | --- | --- |');
    for (const line of flips) console.log(line);
  }
}
console.log('');

/* ==================== §3 判读 ==================== */
console.log('=== §3 判读（协议第 5 节的假设）===');
if (crossChurch === 0) {
  console.log('  **跨教会 PVP = 0** ⇒ 玩家没有自发发起跨教会 PVP。');
  console.log('  ⇒ 按协议的失效判据：需要**定向引导**（公布敌对关系）之后再观察一季；');
  console.log('    若引导后仍然为 0，结论是「这台机制在真人行为层不可自发」，属于产品设计要回答的问题。');
} else if (hostile === 0) {
  console.log('  **有跨教会 PVP，但没有一次发生在敌对教会之间**（' + crossChurch + ' 场全是中立/同盟）。');
  console.log('  ⇒ 玩家会跨教会动手，但**不知道/不在意**敌对关系 —— 引导的落点是「关系可见性」。');
} else {
  console.log('  **' + hostile + ' 场敌对教会 PVP** ⇒ 行为层活跃。');
  console.log('  ⇒ 下一篇要回答的变成「为什么没有翻转」：看 §2 的增量行数与地点是否在 contestedLocations 里。');
}
console.log('');
console.log('  协议第 6 节：样本 < 10 人或时长 < 2 周 ⇒ **结论降为轶事**，不进决策。');

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify({ db: DB, pvp: { total: pvps.length, bothInChurch, crossChurch, hostile, neutral, ally, sameChurch, oneSideNoChurch }, contests: contests.length }, null, 2),
    'utf8',
  );
  console.log('');
  console.log('结构化结果已写入：' + JSON_OUT);
}

db.close();
