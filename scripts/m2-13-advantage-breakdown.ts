/**
 * M2.13 前置 3：**advantage 拆表**（玩家序列 × 生物序列 → 触发次数）。
 *
 * 用法：node scripts/m2-13-advantage-breakdown.ts [片数] [输出路径] [库前缀]
 *   例：node scripts/m2-13-advantage-breakdown.ts 8 docs/M2.13-advantage拆表.md m213
 *
 * ## 这一份报告要回答什么
 *
 * M2.12 实测 advantage 30 次，但**没有拆开**：
 *   - 有多少来自「序列 7 玩家打序列 8 生物」（M2.12 新解锁的路径）？
 *   - 有多少来自「序列 8 玩家打序列 9 生物（灰雾游魂）」（M2.8 起理论上也能发生）？
 *
 * 如果 30 次里大多数是后者，那 M2.12 序列 7 上线的实际作用就比看起来小。
 * 拆开才知道真相 —— 这是为了下一轮的决策。
 *
 * ## 两个口径（必须写清楚，否则这张表会被误读）
 *
 * | 口径 | 数据来源 | 覆盖 |
 * | --- | --- | --- |
 * | **精确** | `domain_events` 的 `creature_sighting_roll`（M2.13 前置 3 起写入） | 判定当时的双方序列 |
 * | 近似 | `sightings` JOIN `characters` / `creatures`（M2.12 及以前的库） | **现在**的双方序列 |
 *
 * 为什么要分两个：感知层次是 `delta = 生物序列 − 玩家序列` 的函数，而两边的序列**都会变**
 * （玩家晋升、生物进化）。而 advantage 那一层的宽度只有 2（delta ∈ [1,2]）——
 * 差 1 就整层挪位。所以对老库只能给近似值，并把偏差来源写在报告里。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';

const SHARDS = Number(process.argv[2] ?? 8);
const OUT = process.argv[3] ?? join('docs', 'M2.13-advantage拆表.md');
const PREFIX = process.argv[4] ?? 'm213';

interface Breakdown {
  /** key = playerSeq + '→' + creatureSeq */
  matrix: Map<string, number>;
  /** 物种分布 */
  species: Map<string, number>;
  /** 每一层各出现几次（对照用，确认 advantage 不是孤立的一个数） */
  layers: Map<string, number>;
  total: number;
  /** 命中的遭遇里有几条带精确口径 */
  exact: number;
  byPlayerSeq: Map<string, number>;
  byCreatureSeq: Map<string, number>;
  /** 生物序列是从哪来的：creature_row（实例行）/ species_base（物种基线） */
  sources: Map<string, number>;
}

function empty(): Breakdown {
  return {
    matrix: new Map(),
    species: new Map(),
    layers: new Map(),
    total: 0,
    exact: 0,
    byPlayerSeq: new Map(),
    byCreatureSeq: new Map(),
    sources: new Map(),
  };
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function collectExact(db: ReturnType<typeof openDatabase>, out: Breakdown): boolean {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare("SELECT payload FROM domain_events WHERE type = 'creature_sighting_roll'").all() as Array<
      Record<string, unknown>
    >;
  } catch {
    return false;
  }
  if (rows.length === 0) return false;
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const layer = String(payload.layer ?? '?');
    bump(out.layers, layer);
    if (layer !== 'advantage') continue;
    const playerSeq = Number(payload.playerSeq);
    const creatureSeq = Number(payload.creatureSeq);
    if (!Number.isFinite(playerSeq) || !Number.isFinite(creatureSeq)) continue;
    out.total += 1;
    out.exact += 1;
    bump(out.matrix, playerSeq + ' → ' + creatureSeq);
    bump(out.byPlayerSeq, String(playerSeq));
    bump(out.byCreatureSeq, String(creatureSeq));
    bump(out.species, String(payload.speciesName ?? payload.speciesId ?? '?'));
  }
  return true;
}

/**
 * 近似口径（M2.12 及以前的库）：`sightings` 里 layer='advantage' 的行，
 * JOIN 出**现在**的玩家序列与生物序列。物种是精确的（species_id 不会变）。
 *
 * 生物序列分两级取，因为`那句「那只生物早就没了`在 30 天窗口里很常见：
 *   1. `creatures.sequence` —— 那只实例还在（**现在**的序列，进化过的会差 1）；
 *   2. `creature_species.base_sequence` —— 实例已经被打死了 / 衰亡了，退回物种基线。
 * 两级的占比会单独统计（`sources`），否则「退回基线」这件事会被当成精确值读。
 */
function collectApprox(db: ReturnType<typeof openDatabase>, out: Breakdown): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .prepare(
        'SELECT s.species_id AS species_id, c.sequence AS player_seq, ' +
          'COALESCE(cr.sequence, sp.base_sequence) AS creature_seq, ' +
          "CASE WHEN cr.id IS NULL THEN 'species_base' ELSE 'creature_row' END AS seq_source " +
          'FROM sightings s ' +
          'JOIN characters c ON c.id = s.character_id ' +
          'LEFT JOIN creatures cr ON cr.id = s.creature_id ' +
          'LEFT JOIN creature_species sp ON sp.id = s.species_id ' +
          "WHERE s.layer = 'advantage'",
      )
      .all() as Array<Record<string, unknown>>;
  } catch {
    return;
  }
  for (const row of rows) {
    const playerSeq = Number(row.player_seq);
    const creatureSeq = Number(row.creature_seq);
    out.total += 1;
    bump(out.layers, 'advantage');
    bump(out.sources, String(row.seq_source ?? 'unknown'));
    if (Number.isFinite(playerSeq) && Number.isFinite(creatureSeq)) {
      bump(out.matrix, playerSeq + ' → ' + creatureSeq);
      bump(out.byPlayerSeq, String(playerSeq));
      bump(out.byCreatureSeq, String(creatureSeq));
    } else {
      bump(out.matrix, playerSeq + ' → ？（查不到）');
    }
    bump(out.species, String(row.species_id ?? '?'));
  }
  try {
    for (const row of db
      .prepare('SELECT layer, COUNT(*) AS n FROM sightings GROUP BY layer')
      .all() as Array<Record<string, unknown>>) {
      const layer = String(row.layer);
      if (layer === 'advantage') continue;
      bump(out.layers, layer, Number(row.n));
    }
  } catch {
    /* 忽略 */
  }
}

/** 用「物种 id → 中文名」补一层可读性（物种表可能不存在） */
function speciesNames(db: ReturnType<typeof openDatabase>): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const row of db.prepare('SELECT id, name FROM creature_species').all() as Array<
      Record<string, unknown>
    >) {
      map.set(String(row.id), String(row.name));
    }
  } catch {
    /* 忽略 */
  }
  return map;
}

const exact = empty();
const approx = empty();
const names = new Map<string, string>();
const perShard: Array<{ path: string; exact: number; approx: number }> = [];

for (let index = 0; index < SHARDS; index += 1) {
  const path = join('data', PREFIX + '-shard-' + index + '.db');
  if (!existsSync(path)) {
    console.log('跳过不存在的库：' + path);
    continue;
  }
  const db = openDatabase(path);
  for (const [id, name] of speciesNames(db)) names.set(id, name);
  const before = { exact: exact.total, approx: approx.total };
  const usedExact = collectExact(db, exact);
  if (usedExact) {
    try {
      for (const row of db
        .prepare('SELECT layer, COUNT(*) AS n FROM sightings GROUP BY layer')
        .all() as Array<Record<string, unknown>>) {
        bump(exact.layers, String(row.layer), Number(row.n));
      }
    } catch {
      /* 忽略 */
    }
  } else {
    collectApprox(db, approx);
  }
  perShard.push({
    path,
    exact: exact.total - before.exact,
    approx: approx.total - before.approx,
  });
  db.close();
}

const isExact = exact.total > 0;
const data = isExact ? exact : approx;

const rowsOf = (map: Map<string, number>): string =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, value]) => '| ' + key + ' | ' + value + ' |')
    .join('\n') || '| （无） | 0 |';

const displayName = (key: string): string => (names.has(key) ? names.get(key)! + '（' + key + '）' : key);

/** 玩家序列 × 生物序列 的二维表 */
function matrixTable(map: Map<string, number>): string[] {
  const parsed: Array<{ p: number; c: string; n: number }> = [];
  for (const [key, n] of map.entries()) {
    const parts = key.split(' → ');
    parsed.push({ p: Number(parts[0]), c: parts[1] ?? '?', n });
  }
  const players = [...new Set(parsed.map((e) => e.p))].sort((a, b) => a - b);
  const creatures = [...new Set(parsed.map((e) => e.c))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const lines: string[] = [];
  if (players.length === 0) {
    lines.push('| 玩家序列 \\ 生物序列 | （无） |');
    lines.push('| --- | --- |');
    return lines;
  }
  lines.push('| 玩家序列 \\ 生物序列 | ' + creatures.join(' | ') + ' | 合计 |');
  lines.push('| --- | ' + creatures.map(() => '---').join(' | ') + ' | --- |');
  for (const p of players) {
    const cells = creatures.map((c) => String(parsed.find((e) => e.p === p && e.c === c)?.n ?? 0));
    const rowTotal = parsed.filter((e) => e.p === p).reduce((sum, e) => sum + e.n, 0);
    lines.push('| **序列 ' + p + '** | ' + cells.join(' | ') + ' | ' + rowTotal + ' |');
  }
  return lines;
}

const lines: string[] = [];
lines.push('# M2.13 advantage 拆表（玩家序列 × 生物序列）');
lines.push('');
lines.push('> 数据来源：' + SHARDS + ' 个分片库（`data/' + PREFIX + '-shard-N.db`），从库里数出来，不靠人抄 stdout。');
lines.push('>');
lines.push(
  '> **口径：' +
    (isExact
      ? '精确**（`domain_events` 的 `creature_sighting_roll`，逐条记下判定当时的双方序列）'
      : '近似**（`sightings` JOIN `characters` / `creatures`，读到的是**现在**的序列 —— 见文末的偏差说明）'),
);
lines.push('');
lines.push('## 一、advantage 总次数');
lines.push('');
lines.push('| 项 | 次数 |');
lines.push('| --- | --- |');
lines.push('| **advantage 触发** | **' + data.total + '** |');
lines.push('| 其中带精确口径的记录 | ' + data.exact + ' |');
lines.push('');
lines.push('## 二、二维拆表：玩家序列 × 生物序列');
lines.push('');
lines.push(...matrixTable(data.matrix));
lines.push('');
lines.push('## 三、按玩家序列 / 按生物序列');
lines.push('');
lines.push('| 玩家序列 | advantage 次数 |');
lines.push('| --- | --- |');
lines.push(rowsOf(data.byPlayerSeq));
lines.push('');
lines.push('| 生物序列 | advantage 次数 |');
lines.push('| --- | --- |');
lines.push(rowsOf(data.byCreatureSeq));
lines.push('');
lines.push('## 四、advantage 里的物种分布');
lines.push('');
lines.push('| 物种 | 次数 |');
lines.push('| --- | --- |');
lines.push(
  [...data.species.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => '| ' + displayName(key) + ' | ' + value + ' |')
    .join('\n') || '| （无） | 0 |',
);
lines.push('');
if (!isExact) {
  lines.push('## 四之二、生物序列是从哪来的（近似口径专有）');
  lines.push('');
  lines.push('| 来源 | 次数 | 含义 |');
  lines.push('| --- | --- | --- |');
  lines.push('| creature_row | ' + (data.sources.get('creature_row') ?? 0) + ' | 那只实例还在 creatures 表里（读的是**现在**的序列） |');
  lines.push('| species_base | ' + (data.sources.get('species_base') ?? 0) + ' | 实例已被打死 / 衰亡，退回物种基线序列 |');
  lines.push('');
}
lines.push('## 五、五层各自出现几次（对照）');
lines.push('');
lines.push('| 层 | 次数 |');
lines.push('| --- | --- |');
lines.push(rowsOf(data.layers));
lines.push('');
lines.push('## 六、逐片');
lines.push('');
lines.push('| 分片 | advantage（精确） | advantage（近似） |');
lines.push('| --- | --- | --- |');
for (const shard of perShard) {
  lines.push('| ' + shard.path + ' | ' + shard.exact + ' | ' + shard.approx + ' |');
}
lines.push('');
if (!isExact) {
  lines.push('## 七、偏差说明（这一节必须读）');
  lines.push('');
  lines.push('这一轮的库里**没有** `creature_sighting_roll` 事件（它是 M2.13 前置 3 才补上的），');
  lines.push('所以上表是**近似口径**：玩家序列读的是 `characters.sequence`（**现在**的值），');
  lines.push('生物序列读的是 `creatures.sequence`（**现在**的值，进化过的会差 1）。');
  lines.push('');
  lines.push('偏差的方向是可以推出来的：30 天窗口里玩家会从 9 升到 8、7，');
  lines.push('所以「现在序列」**只会比判定当时小**（更强）——');
  lines.push('也就是说，上表里落在「序列 7 打序列 8」那一格的一部分，');
  lines.push('判定当时可能是「序列 8 打序列 9」，反之不会。下一轮的 200×30 用精确口径复核。');
  lines.push('');
}

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已写出 ' + OUT);
console.log('口径：' + (isExact ? '精确' : '近似') + '；advantage ' + data.total + ' 次');
console.log('拆表：' + JSON.stringify([...data.matrix.entries()].sort((a, b) => b[1] - a[1])));
console.log('物种：' + JSON.stringify([...data.species.entries()].sort((a, b) => b[1] - a[1])));
