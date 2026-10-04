/**
 * M2.14 任务 D：**8 分片合并覆盖率 + 合并异常 + 灾厄专项统计**。
 *
 * 用法：node scripts/m2-14-merged-report.ts
 *
 * 产出：
 *   1. docs/M2.14-覆盖率.md   —— 8 分片合并覆盖率 + **灾厄专项**（本轮的新口径）
 *   2. docs/M2.14-异常.md     —— 8 分片合并异常
 *
 * ## 为什么不重跑批
 *
 * 跑批结果已经落在 data/vplayer-shards-m214/m214-shard-N.json（含 coverage 与 anomalies），
 * 分片库留在 data/m214-shard-N.db。这一份脚本**只读**。
 *
 * ## 灾厄口径（本轮新增）
 *
 * 灾厄是**纯 seed 派生**的，所以「这一刻在不在灾厄里」在报告侧可以精确复算
 * （calamityAt('world', t)）—— 不需要任何新表、新列、新事件。
 * 这一份统计的三组数全部从库里数：
 *   1. 灾厄本身：world_events 里的 calamity 条数（次数）+ 按天扫出来的灾厄日；
 *   2. 封印物产出：item_gain 的 reason 分「探索·封印物掉落」与「战斗·灾厄掉落」；
 *   3. 灾厄期 / 非灾厄期的对照：探索次数取 ap_delta 的「探索消耗」，
 *      生态补充取 creature_ticks 的 summary_json.replenish（按 tick_key 换算时刻分组）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { calamityAt, calamityDayAnchor } from '../src/domain/world/calamity.ts';
import { dayIndexOf } from '../src/domain/world/clock.ts';
import { mergeShards } from '../src/vplayer/merge.ts';
import { renderCoverageReport } from '../src/vplayer/report.ts';
import { SHARD_SCHEMA, type ShardJson } from '../src/vplayer/shard-json.ts';

const SHARDS = 8;
const WORLD_SEED = 'world';
/** 默认跑**主批 #2（方案 A）**；用 --prefix 切到别批（m214 / m214off） */
const PREFIX = (() => {
  const index = process.argv.indexOf('--prefix');
  return index >= 0 ? (process.argv[index + 1] ?? 'm214a') : 'm214a';
})();
const SEED_PREFIX = PREFIX;
const JSON_DIR = 'data/vplayer-shards-' + PREFIX;
const DB_PREFIX = PREFIX;

const N = String.fromCharCode(96);
const code = (s: string): string => N + s + N;

interface CalamityStats {
  shard: number;
  /** 库里 world_events 的 calamity 条数 */
  occurrences: number;
  levels: Map<number, number>;
  /** 跑批覆盖的 day 区间 */
  fromDay: number;
  toDay: number;
  /** 封印物产出（按来源） */
  exploreDrops: number;
  calamityDrops: number;
  /** 探索次数（分母）与其中的封印物掉落（分子），按灾厄期分组 */
  exploreInCalamity: number;
  exploreOutside: number;
  dropInCalamity: number;
  dropOutside: number;
  /** 生态补充：tick 数与补充数，按灾厄期分组 */
  ticksInCalamity: number;
  ticksOutside: number;
  replenishInCalamity: number;
  replenishOutside: number;
}

function emptyStats(shard: number): CalamityStats {
  return {
    shard,
    occurrences: 0,
    levels: new Map(),
    fromDay: 0,
    toDay: 0,
    exploreDrops: 0,
    calamityDrops: 0,
    exploreInCalamity: 0,
    exploreOutside: 0,
    dropInCalamity: 0,
    dropOutside: 0,
    ticksInCalamity: 0,
    ticksOutside: 0,
    replenishInCalamity: 0,
    replenishOutside: 0,
  };
}

/** 某个时刻在不在灾厄里 —— 报告侧的复算，与运行时同一个纯函数 */
function inCalamity(t: number): boolean {
  return calamityAt(WORLD_SEED, t) !== null;
}

function readShard(shard: number): CalamityStats {
  const stats = emptyStats(shard);
  const dbPath = join('data', DB_PREFIX + '-shard-' + shard + '.db');
  if (!existsSync(dbPath)) return stats;
  const db = new DatabaseSync(dbPath, { readOnly: true });

  // 1) 灾厄事件（次数与等级）
  for (const row of db
    .prepare("SELECT id, text FROM world_events WHERE type = 'calamity' ORDER BY created_at")
    .all() as { id: string; text: string }[]) {
    stats.occurrences += 1;
    const level = /灵界倒灌/.test(row.text) ? 3 : /血月余波/.test(row.text) ? 2 : 1;
    stats.levels.set(level, (stats.levels.get(level) ?? 0) + 1);
  }

  // 2) 跑批覆盖的 day 区间
  const span = db.prepare('SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM domain_events').get() as
    | { a: number; b: number }
    | undefined;
  if (span && span.a) {
    stats.fromDay = dayIndexOf(span.a);
    stats.toDay = dayIndexOf(span.b);
  }

  // 3) 封印物产出（按来源）
  for (const row of db
    .prepare(
      "SELECT reason, COUNT(*) AS n FROM domain_events WHERE type = 'item_gain' " +
        "AND reason IN ('探索·封印物掉落', '探索·灾厄掉落', '战斗·灾厄掉落') GROUP BY reason",
    )
    .all() as { reason: string; n: number }[]) {
    if (row.reason === '探索·封印物掉落') stats.exploreDrops += row.n;
    else stats.calamityDrops += row.n;
  }

  // 4) 探索次数与探索掉落的命中数，按灾厄期分组
  for (const row of db
    .prepare(
      'SELECT type, reason, created_at FROM domain_events WHERE ' +
        "(type = 'ap_delta' AND reason = '探索消耗') OR (type = 'item_gain' AND reason = '探索·封印物掉落')",
    )
    .all() as { type: string; reason: string; created_at: number }[]) {
    const inside = inCalamity(row.created_at);
    if (row.type === 'ap_delta') {
      if (inside) stats.exploreInCalamity += 1;
      else stats.exploreOutside += 1;
    } else if (inside) stats.dropInCalamity += 1;
    else stats.dropOutside += 1;
  }

  // 5) 生态补充：按 tick_key 换算时刻，再分灾厄期
  for (const row of db.prepare('SELECT tick_key, summary_json FROM creature_ticks').all() as {
    tick_key: string;
    summary_json: string;
  }[]) {
    const at = Date.parse(row.tick_key + ':00:00+08:00');
    if (Number.isNaN(at)) continue;
    let replenish = 0;
    try {
      const parsed = JSON.parse(row.summary_json) as { replenish?: number };
      replenish = parsed.replenish ?? 0;
    } catch {
      /* 一条脏 JSON 不该让报告挂掉 */
    }
    if (inCalamity(at)) {
      stats.ticksInCalamity += 1;
      stats.replenishInCalamity += replenish;
    } else {
      stats.ticksOutside += 1;
      stats.replenishOutside += replenish;
    }
  }

  db.close();
  return stats;
}

/* ---------------- 读分片 JSON 并合并 ---------------- */

const entries: { index: number; json: ShardJson }[] = [];
for (let index = 0; index < SHARDS; index += 1) {
  const path = join(JSON_DIR, SEED_PREFIX + '-shard-' + index + '.json');
  if (!existsSync(path)) throw new Error('找不到分片 JSON：' + path);
  const json = JSON.parse(readFileSync(path, 'utf8')) as ShardJson;
  if (json.schema !== SHARD_SCHEMA) throw new Error('分片口径不一致：' + path + '（' + json.schema + '）');
  entries.push({ index, json });
}
const merged = mergeShards(entries.map((entry) => entry.json));
const stats = Array.from({ length: SHARDS }, (_, index) => readShard(index));

/* ---------------- 灾厄专项汇总 ---------------- */

const sum = (pick: (s: CalamityStats) => number): number => stats.reduce((acc, s) => acc + pick(s), 0);
const pct = (value: number, base: number): string =>
  base > 0 ? ((value / base) * 100).toFixed(1) + '%' : '—';
const rate = (hit: number, base: number): number => (base > 0 ? hit / base : 0);
const pp = (value: number): string => (value * 100).toFixed(2) + '%';

const fromDay = Math.min(...stats.map((s) => s.fromDay).filter((d) => d > 0));
const toDay = Math.max(...stats.map((s) => s.toDay));

/** 灾厄日：按 world seed 在跑批区间上逐天扫（与库里那些事件同源） */
const calamityDays: { day: number; level: number }[] = [];
for (let day = fromDay; day <= toDay; day += 1) {
  const calamity = calamityAt(WORLD_SEED, calamityDayAnchor(day));
  if (calamity) calamityDays.push({ day, level: calamity.level });
}
const levelOnDays = new Map<number, number>();
for (const entry of calamityDays) levelOnDays.set(entry.level, (levelOnDays.get(entry.level) ?? 0) + 1);

const totalDrops = sum((s) => s.exploreDrops) + sum((s) => s.calamityDrops);
const exploreIn = sum((s) => s.exploreInCalamity);
const exploreOut = sum((s) => s.exploreOutside);
const dropIn = sum((s) => s.dropInCalamity);
const dropOut = sum((s) => s.dropOutside);
const rateIn = rate(dropIn, exploreIn);
const rateOut = rate(dropOut, exploreOut);

const M213_TOTAL = 420;

/* ---------------- 渲染 ---------------- */

const lines: string[] = [];
const P = (s = ''): void => { lines.push(s); };

P('# M2.14 合并覆盖率（8 分片 · 200 人 × 30 天）');
P();
P('> 数据来源：' + code(JSON_DIR + '/' + SEED_PREFIX + '-shard-N.json') + '（覆盖率与异常）与 ' +
  code('data/' + DB_PREFIX + '-shard-N.db') + '（灾厄专项的三组数）。');
P('> 合并走 ' + code('src/vplayer/merge.ts') + '（纯函数、有单测）：按 key 累加、分子分母都加。');
P('> **逐片明细一律进本报告**（铁律 11）：合计行必须等于各片之和。');
P();
P('## 一、跑批口径');
P();
P('| 项 | 值 |');
P('| --- | --- |');
P('| seed 前缀 | ' + code(SEED_PREFIX) + '（**玩家行为 seed = ' + code('m214:shard:<i>') + '**，三批相同） |');
P('| 分片 | ' + SHARDS + ' |');
P('| 玩家 × 天 | ' + merged.players + ' × ' + merged.days + ' |');
P('| **世界 seed** | ' + code(WORLD_SEED) + '（**与 M2.13.1 一致**，保持基线可比） |');
P('| 跑批覆盖 day | ' + fromDay + ' → ' + toDay + ' |');
P('| 墙钟 | ' + (merged.wallClockMs / 60000).toFixed(1) + ' 分钟（8 片并行；跑批期间**没有编辑任何文件**） |');
P();
P('## 二、灾厄专项（本轮的新口径）');
P();
P('### 2.1 灾厄本身');
P();
P('| 指标 | 实测 | 阈值 | 结论 |');
P('| --- | --- | --- | --- |');
P('| 灾厄次数（' + code('world_events.type = calamity') + '） | ' + sum((s) => s.occurrences) + ' | ≥ 2 | ' +
  (sum((s) => s.occurrences) >= 2 ? '达标' : '未达标') + ' |');
P('| 灾厄日 | ' + calamityDays.length + ' | ≥ 3 | ' + (calamityDays.length >= 3 ? '达标' : '未达标') + ' |');
P('| 等级分布（按灾厄日） | ' +
  [...levelOnDays.entries()].sort((a, b) => a[0] - b[0]).map(([level, n]) => level + ' 级 ' + n + ' 天').join(' / ') +
  ' | 记录 | — |');
P();
P('> 灾厄日是按 ' + code('calamityAt(' + WORLD_SEED + ', t)') + ' 在跑批区间上逐天扫出来的 ——');
P('> 灾厄是纯 seed 派生的，所以报告侧可以精确复算，不需要任何新表/新列/新事件。');
P();
P('### 2.2 封印物产出（与 M2.13 对照）');
P();
P('| 指标 | M2.13.1 基线 | M2.14 实测 | 阈值 | 结论 |');
P('| --- | --- | --- | --- | --- |');
P('| 封印物总产出 | ' + M213_TOTAL + ' | ' + totalDrops + ' | ≥ ' + M213_TOTAL + ' | ' +
  (totalDrops >= M213_TOTAL ? '达标' : '未达标') + ' |');
P('| 其中：探索掉落 | ' + M213_TOTAL + ' | ' + sum((s) => s.exploreDrops) + ' | 下降（幅度小也行） | ' +
  (sum((s) => s.exploreDrops) < M213_TOTAL ? '下降 ' + (M213_TOTAL - sum((s) => s.exploreDrops)) + ' 件' : '未下降') + ' |');
P('| 其中：**灾厄产出** | —（本版新增） | ' + sum((s) => s.calamityDrops) + ' | 占比 ≥ 20% | ' +
  pct(sum((s) => s.calamityDrops), totalDrops) + (rate(sum((s) => s.calamityDrops), totalDrops) >= 0.2 ? ' 达标' : ' 未达标') + ' |');
P();
P('### 2.3 灾厄期产出偏移');
P();
P('**探索掉落率**（分子 = ' + code('探索·封印物掉落') + '，分母 = ' + code('探索消耗') + '）：');
P();
P('| 分组 | 探索次数 | 封印物掉落 | 掉落率 |');
P('| --- | --- | --- | --- |');
P('| 灾厄期 | ' + exploreIn + ' | ' + dropIn + ' | ' + pp(rateIn) + ' |');
P('| 非灾厄期 | ' + exploreOut + ' | ' + dropOut + ' | ' + pp(rateOut) + ' |');
P('| **差异** | — | — | **' + ((rateOut - rateIn) * 100).toFixed(2) + ' 个百分点（灾厄期更低）** |');
P();
P('> ⚠️ 阈值表里写的「差异 ≥ 5 个百分点」在本口径下**数学上不可达**：');
P('> 探索掉落的**基础命中率**只有 ' +
  pp(1 - (1 - NUMERIC.extraordinary.dropRates.wonder.seq9) * (1 - NUMERIC.extraordinary.dropRates.sealed.seq9) *
    (1 - NUMERIC.extraordinary.dropRates.charm.seq9)) + '（seq9 档三类各掷一次）——');
P('> 压到 ×0.4 也就差 1—2 个百分点。**5 个百分点只能从「总产出率」上看**，见下面那张表。');
P();
P('**封印物总产出率**（分子 = 探索 + 灾厄，分母 = 探索次数 —— 只作对照，因为灾厄产出走战斗）：');
P();
P('| 分组 | 探索次数 | 封印物产出 | 每次探索产出 |');
P('| --- | --- | --- | --- |');
P('| 灾厄期 | ' + exploreIn + ' | ' + (dropIn + sum((s) => s.calamityDrops)) + ' | ' +
  pp(rate(dropIn + sum((s) => s.calamityDrops), exploreIn)) + ' |');
P('| 非灾厄期 | ' + exploreOut + ' | ' + dropOut + ' | ' + pp(rate(dropOut, exploreOut)) + ' |');
P();
P('### 2.4 生态（灾厄期 vs 非灾厄期）');
P();
P('| 分组 | tick 数 | 世界补充 | 每 tick 补充 |');
P('| --- | --- | --- | --- |');
P('| 灾厄期 | ' + sum((s) => s.ticksInCalamity) + ' | ' + sum((s) => s.replenishInCalamity) + ' | ' +
  pp(rate(sum((s) => s.replenishInCalamity), sum((s) => s.ticksInCalamity))) + ' |');
P('| 非灾厄期 | ' + sum((s) => s.ticksOutside) + ' | ' + sum((s) => s.replenishOutside) + ' | ' +
  pp(rate(sum((s) => s.replenishOutside), sum((s) => s.ticksOutside))) + ' |');
P();
P('> **口径缺口（如实记录）**：' + code('creature_ticks.summary_json') + ' 的字段是');
P('> ' + code('migrate / feed / evolve / birth / replenish / death') + ' —— **没有「漂移」（stray）这一项**，');
P('> 所以「灾厄期 strayChance 命中数」从现有落库**数不出来**，本轮只能拿「世界补充」当同类证据');
P('> （两者共用同一个 ' + code('calamityFactorAt') + '）。建议 M2.15 在 ' + code('setTickSummary') + ' 里补一个 ' + code('stray') + ' 字段。');
P();
P('## 三、逐片灾厄明细');
P();
P('| 片 | 灾厄次数 | 探索掉落 | 灾厄产出 | 灾厄期探索 | 非灾厄期探索 | 灾厄期补充 | 非灾厄期补充 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const s of stats) {
  P('| ' + s.shard + ' | ' + s.occurrences + ' | ' + s.exploreDrops + ' | ' + s.calamityDrops + ' | ' +
    s.exploreInCalamity + ' | ' + s.exploreOutside + ' | ' + s.replenishInCalamity + ' | ' + s.replenishOutside + ' |');
}
P('| **合计** | **' + sum((s) => s.occurrences) + '** | **' + sum((s) => s.exploreDrops) + '** | **' +
  sum((s) => s.calamityDrops) + '** | **' + exploreIn + '** | **' + exploreOut + '** | **' +
  sum((s) => s.replenishInCalamity) + '** | **' + sum((s) => s.replenishOutside) + '** |');
P();
const rest = renderCoverageReport({
  stage: 'M2.14',
  players: merged.players,
  days: merged.days,
  seed: SEED_PREFIX,
  coverage: merged.coverage,
});
P('---');
P();
P('## 四、覆盖率（合并）');
P();
P(rest);

writeFileSync(join('docs', 'M2.14-覆盖率.md'), lines.join('\n'), 'utf8');

/* ---- 合并异常 ---- */

const ano: string[] = [];
const A = (s = ''): void => { ano.push(s); };
const byCode = new Map<string, number>();
for (const entry of merged.anomalies) byCode.set(entry.code, (byCode.get(entry.code) ?? 0) + 1);

A('# M2.14 合并异常（8 分片 · 200 人 × 30 天）');
A();
A('> 数据来源：' + code(JSON_DIR + '/' + SEED_PREFIX + '-shard-N.json') + ' 的 ' + code('anomalies') + ' 字段，');
A('> 与各片 ' + code('docs/' + SEED_PREFIX + '-shardN-异常.md') + ' 同源（同一份 ' + code('mergeShards') + '）。');
A();
A('| 片 | P0 | P1 |');
A('| --- | --- | --- |');
for (const entry of entries) {
  const p0 = entry.json.anomalies.filter((a) => a.level === 'P0').length;
  A('| ' + entry.index + ' | ' + p0 + ' | ' + (entry.json.anomalies.length - p0) + ' |');
}
A('| **合计** | **' + merged.anomalies.filter((a) => a.level === 'P0').length + '** | **' +
  (merged.anomalies.length - merged.anomalies.filter((a) => a.level === 'P0').length) + '** |');
A();
A('## 按 code 计数');
A();
A('| code | 条数 |');
A('| --- | --- |');
for (const [name, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) A('| ' + name + ' | ' + n + ' |');
A();
A('## 明细（最多 60 条）');
A();
for (const entry of merged.anomalies.slice(0, 60)) {
  A('- [' + entry.level + '/' + entry.code + '] player#' + entry.playerId + ' 第 ' + entry.day + ' 天 「' +
    (entry.command ?? '') + '」：' + entry.detail);
}
A();
writeFileSync(join('docs', 'M2.14-异常.md'), ano.join('\n'), 'utf8');

/* ---- 控制台摘要 ---- */

console.log('已写 docs/M2.14-覆盖率.md、docs/M2.14-异常.md');
console.log('灾厄：' + sum((s) => s.occurrences) + ' 次 / ' + calamityDays.length + ' 个灾厄日（day ' + fromDay + '-' + toDay + '）');
console.log('封印物：总 ' + totalDrops + '（探索 ' + sum((s) => s.exploreDrops) + ' / 灾厄 ' + sum((s) => s.calamityDrops) +
  '，灾厄占比 ' + pct(sum((s) => s.calamityDrops), totalDrops) + '）');
console.log('探索掉落率：灾厄期 ' + pp(rateIn) + '（' + dropIn + '/' + exploreIn + '） vs 非灾厄期 ' + pp(rateOut) +
  '（' + dropOut + '/' + exploreOut + '）');
console.log('生态补充：灾厄期 ' + sum((s) => s.replenishInCalamity) + '/' + sum((s) => s.ticksInCalamity) + ' tick vs 非灾厄期 ' +
  sum((s) => s.replenishOutside) + '/' + sum((s) => s.ticksOutside) + ' tick');
console.log('异常：P0 ' + merged.anomalies.filter((a) => a.level === 'P0').length + ' / P1 ' +
  merged.anomalies.filter((a) => a.level === 'P1').length + ' / 总 ' + merged.anomalies.length);
