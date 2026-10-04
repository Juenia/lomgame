#! /usr/bin/env node
/**
 * M2.23 任务 3：**真人数据回收脚本**（交付给用户执行，本轮不跑真人库）。
 *
 * 与 `scripts/real-player-contest.ts` 的分工：
 *   · 那一个只回答「跨教会 PVP 与翻转」（争夺机制那一条线）；
 *   · **这一个回答「入教率」那一整条线** —— 它是 M2.22 认证的瓶颈，
 *     而且它的**分子分母必须取全**，否则会重复 M2.23 里那种「分母不同、结论相反」的坑。
 *
 * ## 入教率的三个分母（**必须三个都报**）
 *
 * | 口径 | 分母 | vplayer 侧参考（m224 / m223a） |
 * | --- | --- | --- |
 * | 全体 | 建号数 | 43.0% / 52.5% |
 * | 已入途径者 | 建号 − 未入途径 | 46.2% / 57.7% |
 * | **结构上可入教** | 途径有对应教会 **且** 当前城市在 `seats` 里 | **83.5% / 86.1%** |
 *
 * ⚠️ **第三个才是「机制在自己的设计范围内做得怎么样」**。
 * 只报第一个会让人以为「入教率低 = 机制有问题」—— M2.23 证明那是**覆盖范围**的问题
 * （`seer` 按设计不入七正神教会）。
 *
 * ## 「想入但没入」这一格 —— 脚本取不到，由问卷补
 *
 * 库里只有**成功**的 `church_join`（失败不落事件，见 `docs/架构铁律.md` §2.4 的登记）。
 * 真人侧「他试过但被拒」「他想入但不知道怎么做」这两类**只能由问卷回答** ——
 * 脚本会把这一格**留空并标出来**，不猜。
 *
 * 用法：
 *   node scripts/real-player-recall.ts --db data/beta.db --json docs/真人小样本-回收.json
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { loadChurches } from '../src/data/loader.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const DB = argOf('db', 'data/beta.db');
const JSON_OUT = argOf('json', '');

const churches = loadChurches().churches;
const pathwayToChurch = new Map<string, Array<{ id: string; seats: readonly string[] }>>();
for (const church of churches) {
  if (!church.pathway) continue;
  const list = pathwayToChurch.get(church.pathway) ?? [];
  list.push({ id: church.id, seats: church.seats });
  pathwayToChurch.set(church.pathway, list);
}

let db: DatabaseSync;
try {
  db = new DatabaseSync(DB, { readOnly: true });
} catch (error) {
  console.error('打不开库 ' + DB + '：' + String(error));
  process.exit(2);
}

const chars = db.prepare(
  'SELECT id, user_id, name, pathway, sequence, church_id, church_contribution, current_city_id, status FROM characters',
).all() as unknown as Array<{
  id: string; user_id: string; name: string; pathway: string | null; sequence: number | null;
  church_id: string | null; church_contribution: number; current_city_id: string | null; status: string;
}>;

console.log('=== 真人数据回收（M2.23 任务 3）===');
console.log('  库：' + DB + '　角色：' + chars.length);
const span = db.prepare('SELECT MIN(created_at) a, MAX(created_at) b FROM domain_events').get() as { a: number | null; b: number | null };
let days = 0;
if (span?.a && span?.b) {
  days = (Number(span.b) - Number(span.a)) / 86400000;
  console.log('  时段：' + new Date(Number(span.a)).toISOString().slice(0, 10) + ' → ' +
    new Date(Number(span.b)).toISOString().slice(0, 10) + '（' + days.toFixed(1) + ' 天）');
  if (days < 14) console.log('  ⚠️ **不足 14 天** —— 按协议 §六，结论只能记为「轶事」，不进决策。');
}
console.log('');

/* ==================== §1 入教率（三个分母） ==================== */
console.log('=== §1 入教率（**三个分母都要报**）===');
const initiated = chars.filter((c) => c.pathway !== null);
let structuralOk = 0;
let noChurchForPathway = 0;
let cityMiss = 0;
const pathwayTally = new Map<string, { total: number; joined: number }>();
for (const c of chars) {
  const key = c.pathway ?? '（未入途径）';
  const bucket = pathwayTally.get(key) ?? { total: 0, joined: 0 };
  bucket.total += 1;
  if (c.church_id) bucket.joined += 1;
  pathwayTally.set(key, bucket);
  if (!c.pathway) continue;
  const options = pathwayToChurch.get(c.pathway) ?? [];
  if (options.length === 0) noChurchForPathway += 1;
  else if (options.some((o) => o.seats.includes(c.current_city_id ?? ''))) structuralOk += 1;
  else cityMiss += 1;
}
const joined = chars.filter((c) => c.church_id !== null);
const pct = (n: number, d: number): string => (d === 0 ? '—' : ((100 * n) / d).toFixed(1) + '%');
console.log('  | 分母口径 | 分母 | 分子（已入教） | 入教率 |');
console.log('  | --- | --- | --- | --- |');
console.log('  | 全体 | ' + chars.length + ' | ' + joined.length + ' | **' + pct(joined.length, chars.length) + '** |');
console.log('  | 已入途径者 | ' + initiated.length + ' | ' + joined.length + ' | **' + pct(joined.length, initiated.length) + '** |');
console.log('  | **结构上可入教** | ' + structuralOk + ' | ' + joined.length + ' | **' + pct(joined.length, structuralOk) + '** |');
console.log('');
console.log('  · 未入途径：' + (chars.length - initiated.length) + ' 人');
console.log('  · **途径没有对应教会**（seer 这一类，设计边界）：**' + noChurchForPathway + ' 人**');
console.log('  · 有教会但当前城市不在 `seats` 里：' + cityMiss + ' 人');
console.log('');
console.log('  · 教会分布：');
const byChurch = new Map<string, number>();
for (const c of joined) byChurch.set(String(c.church_id), (byChurch.get(String(c.church_id)) ?? 0) + 1);
for (const [id, n] of [...byChurch.entries()].sort((a, b) => b[1] - a[1])) {
  const def = churches.find((c) => c.id === id);
  console.log('      ' + id.padEnd(22) + n + ' 人' + (def ? '　（pathway=' + String(def.pathway) + '）' : ''));
}
console.log('  · 按途径：');
for (const [pathway, b] of [...pathwayTally.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log('      ' + pathway.padEnd(16) + '共 ' + String(b.total).padStart(3) + ' 人，入教 ' + String(b.joined).padStart(3) + '（' + pct(b.joined, b.total) + '）');
}
console.log('');
console.log('  · 贡献点：中位 ' + (() => {
  const list = joined.map((c) => Number(c.church_contribution)).sort((a, b) => a - b);
  return list.length ? list[Math.floor(list.length / 2)] : 0;
})() + '，最大 ' + Math.max(0, ...joined.map((c) => Number(c.church_contribution))));
console.log('');
console.log('  ⚠️ **「想入但没入」这一格脚本取不到** —— 库里只有成功的 `church_join`（失败不落事件）。');
console.log('     它由问卷 Q1 / Q3 / Q4 回答，交叉口径见 docs/真人小样本-回收口径.md §四。');

/* ==================== §2 跨教会 PVP 与翻转 ==================== */
console.log('');
console.log('=== §2 争夺线（口径与 real-player-contest.ts 相同，这里只报汇总）===');
const has = (t: string): boolean =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t) !== undefined;
const byId = new Map(chars.map((c) => [String(c.id), c]));
let pvp = 0;
let both = 0;
let cross = 0;
if (has('battles')) {
  for (const row of db.prepare('SELECT character_id, opponent_character_id FROM battles WHERE is_pvp = 1').all() as unknown as Array<{ character_id: string; opponent_character_id: string | null }>) {
    pvp += 1;
    const a = byId.get(String(row.character_id));
    const b = row.opponent_character_id ? byId.get(String(row.opponent_character_id)) : undefined;
    if (!a?.church_id || !b?.church_id) continue;
    both += 1;
    if (a.church_id !== b.church_id) cross += 1;
  }
}
console.log('  PVP 总场次：' + pvp + '　双方都入教：' + both + '　**跨教会：' + cross + '**');
const contests = has('church_territory_contest')
  ? (db.prepare('SELECT COUNT(*) n FROM church_territory_contest').get() as { n: number }).n
  : 0;
console.log('  `church_territory_contest` 增量行：' + contests + (contests === 0 ? '（**空的 ⇒ 翻转必然是 0**）' : ''));
console.log('  （翻转的逐条流水请跑：node scripts/real-player-contest.ts --db ' + DB + '）');

/* ==================== §3 活跃度 ==================== */
console.log('');
console.log('=== §3 玩家活跃度（**真人独有的一格**：vplayer 没有留存概念）===');
const perChar = db.prepare('SELECT character_id, COUNT(*) n, MAX(created_at) last FROM domain_events GROUP BY character_id').all() as unknown as Array<{ character_id: string; n: number; last: number }>;
const active = new Map(perChar.map((r) => [String(r.character_id), r]));
const activeChars = chars.filter((c) => (active.get(String(c.id))?.n ?? 0) > 0);
console.log('  · 有事件的角色：' + activeChars.length + ' / ' + chars.length);
const counts = [...active.values()].map((r) => Number(r.n)).sort((a, b) => a - b);
if (counts.length) {
  console.log('  · 每人事件数：中位 ' + counts[Math.floor(counts.length / 2)] + '，最多 ' + counts[counts.length - 1]);
}
const lastHour = span?.b ? Number(span.b) - 86400000 : 0;
const alive = chars.filter((c) => (active.get(String(c.id))?.last ?? 0) >= lastHour).length;
console.log('  · **最后 24 小时仍有动作的**（粗口径留存）：**' + alive + ' / ' + chars.length + '**');
console.log('  · 失控（status = lost_control）：' + chars.filter((c) => c.status === 'lost_control').length);
console.log('');
console.log('  ⚠️ 报告口径（写死在 src/vplayer/merge.ts）：「分片只能验机制跑通」；');
console.log('     而留存 / 手感 / 付费意愿**vplayer 证明不了**，只有这一格能回答。');

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    db: DB, days,
    characters: chars.length, initiated: initiated.length, joined: joined.length,
    structuralOk, noChurchForPathway, cityMiss,
    joinRate: {
      all: chars.length ? joined.length / chars.length : 0,
      initiated: initiated.length ? joined.length / initiated.length : 0,
      structural: structuralOk ? joined.length / structuralOk : 0,
    },
    pvp: { total: pvp, bothInChurch: both, crossChurch: cross },
    contests,
  }, null, 2), 'utf8');
  console.log('');
  console.log('结构化结果已写入：' + JSON_OUT);
}

db.close();
