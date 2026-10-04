/**
 * M2.8 生物覆盖统计（交付物：docs/M2.8-生物覆盖.md）。
 *
 *   node scripts/m28-creature-report.ts --db-match m28long-shard- --out docs/M2.8-生物覆盖.md
 *
 * 它不跑虚拟玩家，只**读跑完的库** —— 与其他报告脚本同一手法：
 * 生物的数据（谁遇到了什么、看到哪一层、世界做了哪些事）需要 raw 记录才算得准，
 * 塞进分片 JSON 里既装不下也不该装。
 *
 * 报告要回答的正是任务书 §4.9 要求的那五行：
 *   遭遇次数 / 感知分层分布 / 各物种触发次数 / 迁移次数 / 进化次数。
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { loadCreatures } from '../src/data/loader.ts';
import { LAYER_LABELS } from '../src/domain/creature/perception.ts';
import type { PerceptionLayer } from '../src/domain/creature/types.ts';

function argOf(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const dbDir = argOf('db-dir', 'data');
const dbMatch = argOf('db-match', 'm28long-shard-');
const outPath = argOf('out', 'docs/M2.8-生物覆盖.md');
const title = argOf('title', 'M2.8 生物覆盖');

const dbFiles = readdirSync(dbDir)
  .filter((name) => name.endsWith('.db') && name.includes(dbMatch))
  .sort()
  .map((name) => join(dbDir, name));

if (dbFiles.length === 0) {
  console.error('没有找到匹配的分片库：' + join(dbDir, '*') + '（含 ' + dbMatch + '）');
  process.exit(1);
}

const speciesById = new Map(loadCreatures().creatures.map((species) => [species.id, species]));

interface Totals {
  rolls: number;
  hits: number;
  sightings: number;
  resolved: number;
  harvest: number;
}

const totals: Totals = { rolls: 0, hits: 0, sightings: 0, resolved: 0, harvest: 0 };
const layerCount = new Map<string, number>();
const actionCount = new Map<string, number>();
const speciesSightings = new Map<string, number>();
const tickTotals = new Map<string, number>();
const aliveBySpecies = new Map<string, number>();
const harvestItems = new Map<string, number>();
const usedShards: string[] = [];
/** 每个分片最后一次生态 tick 的摘要（报告里说明世界确实在动） */
let lastTickSummary = '';

for (const file of dbFiles) {
  if (!existsSync(file)) continue;
  usedShards.push(file);
  const db = openDatabase(file);
  const has = (table: string): boolean =>
    Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  if (!has('creatures')) { db.close(); continue; }

  const rollRow = db
    .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'creature_encounter_roll'")
    .get() as { n: number };
  const hitRow = db
    .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'creature_encounter_roll' AND reason = '遭遇命中'")
    .get() as { n: number };
  totals.rolls += rollRow.n;
  totals.hits += hitRow.n;

  for (const row of db.prepare('SELECT layer, COUNT(*) AS n FROM sightings GROUP BY layer').all() as Array<{ layer: string; n: number }>) {
    layerCount.set(row.layer, (layerCount.get(row.layer) ?? 0) + row.n);
    totals.sightings += row.n;
  }
  for (const row of db.prepare('SELECT action, COUNT(*) AS n FROM sightings GROUP BY action').all() as Array<{ action: string | null; n: number }>) {
    const key = row.action ?? '(未处置)';
    actionCount.set(key, (actionCount.get(key) ?? 0) + row.n);
    if (row.action !== null) totals.resolved += row.n;
  }
  for (const row of db.prepare('SELECT species_id, COUNT(*) AS n FROM sightings GROUP BY species_id').all() as Array<{ species_id: string; n: number }>) {
    speciesSightings.set(row.species_id, (speciesSightings.get(row.species_id) ?? 0) + row.n);
  }
  for (const row of db.prepare('SELECT species_id, COUNT(*) AS n FROM creatures GROUP BY species_id').all() as Array<{ species_id: string; n: number }>) {
    aliveBySpecies.set(row.species_id, (aliveBySpecies.get(row.species_id) ?? 0) + row.n);
  }
  for (const row of db.prepare('SELECT summary_json FROM creature_ticks').all() as Array<{ summary_json: string }>) {
    try {
      const summary = JSON.parse(row.summary_json) as Record<string, number>;
      for (const [key, value] of Object.entries(summary)) {
        if (typeof value !== 'number') continue;
        tickTotals.set(key, (tickTotals.get(key) ?? 0) + value);
      }
      if (row.summary_json !== '{}') lastTickSummary = row.summary_json;
    } catch { /* 坏行跳过 */ }
  }
  for (const row of db.prepare("SELECT harvest_json FROM sightings WHERE harvest_json IS NOT NULL").all() as Array<{ harvest_json: string }>) {
    try {
      const items = JSON.parse(row.harvest_json) as Array<{ itemId: string }>;
      for (const item of items) {
        totals.harvest += 1;
        harvestItems.set(item.itemId, (harvestItems.get(item.itemId) ?? 0) + 1);
      }
    } catch { /* 坏行跳过 */ }
  }
  db.close();
}

const pct = (value: number, base: number): string =>
  base === 0 ? '—' : ((value / base) * 100).toFixed(1) + '%';

const lines: string[] = [];
lines.push('# ' + title);
lines.push('');
lines.push('> 数据来源：' + usedShards.length + ' 个分片库（' + usedShards.join(' / ') + '）。');
lines.push('> 口径与判定层一致：每一次遭遇判定都写了一条带 seed 的 domain_events，每一次遭遇都落一行 sightings。');
lines.push('');

lines.push('## 一、遭遇总览');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('| --- | --- |');
lines.push('| 遭遇判定次数（每次探索掷一次） | ' + totals.rolls + ' |');
lines.push('| 命中次数 | ' + totals.hits + '（' + pct(totals.hits, totals.rolls) + '） |');
lines.push('| 遭遇记录（sightings） | ' + totals.sightings + ' |');
lines.push('| 已处置 | ' + totals.resolved + '（' + pct(totals.resolved, totals.sightings) + '） |');
lines.push('| 采集到的物品件数 | ' + totals.harvest + ' |');
lines.push('');

lines.push('## 二、感知分层分布（本轮最重要的一张表）');
lines.push('');
lines.push('同一只生物，玩家序列不同 → 看到的东西不同。这张表就是那件事的证据。');
lines.push('');
lines.push('| 层次 | 含义 | 次数 | 占比 |');
lines.push('| --- | --- | --- | --- |');
const layerOrder: PerceptionLayer[] = ['blur', 'silhouette', 'full', 'advantage', 'essence'];
for (const layer of layerOrder) {
  const n = layerCount.get(layer) ?? 0;
  lines.push('| ' + layer + ' | ' + LAYER_LABELS[layer] + ' | ' + n + ' | ' + pct(n, totals.sightings) + ' |');
}
lines.push('');
const distinctLayers = layerOrder.filter((layer) => (layerCount.get(layer) ?? 0) > 0);
lines.push(distinctLayers.length >= 2
  ? '**出现了 ' + distinctLayers.length + ' 种层次** —— 感知分层真的在起作用（不是所有玩家看到同一句话）。'
  : '⚠️ 只出现了 ' + distinctLayers.length + ' 种层次。窗口太短时可能全是 blur（玩家大多还是普通人），短窗口下这不一定是问题。');
lines.push('');

lines.push('## 三、各物种被遇到的次数');
lines.push('');
lines.push('| 物种 | 序列 | 遭遇次数 | 世界现存 | 栖息地数 |');
lines.push('| --- | --- | --- | --- | --- |');
const speciesRows = [...speciesById.values()]
  .map((species) => ({
    species,
    seen: speciesSightings.get(species.id) ?? 0,
    alive: aliveBySpecies.get(species.id) ?? 0,
  }))
  .sort((a, b) => b.seen - a.seen);
for (const row of speciesRows) {
  lines.push(
    '| ' + row.species.name + ' | ' + row.species.baseSequence + ' | ' + row.seen +
    ' | ' + row.alive + ' | ' + row.species.habitat.length + ' |',
  );
}
lines.push('');

lines.push('## 四、玩家对遭遇做了什么');
lines.push('');
lines.push('| 动作 | 次数 |');
lines.push('| --- | --- |');
for (const [action, n] of [...actionCount.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push('| ' + action + ' | ' + n + ' |');
}
lines.push('');
lines.push('「未处置」= 玩家还没选动作就被别的事打断了（下一天、跑批结束）。');
lines.push('遭遇是个未决状态，它不会自己消失 —— 那只生物还站在那里。');
lines.push('');

lines.push('## 五、生态 tick：世界自己做了什么');
lines.push('');
lines.push('| 行为 | 次数 |');
lines.push('| --- | --- |');
const tickLabels: Array<[string, string]> = [
  ['migrate', '迁移（含漂移）'],
  ['feed', '捕食'],
  ['evolve', '进化（序列 -1）'],
  ['birth', '繁衍'],
  ['death', '衰亡 / 被捕食'],
];
for (const [key, label] of tickLabels) {
  lines.push('| ' + label + ' | ' + (tickTotals.get(key) ?? 0) + ' |');
}
lines.push('');
lines.push('这些数字来自 creature_ticks 的逐小时摘要 —— 是**发生过什么**的账，');
lines.push('不是从当前状态反推的（反推推不出「迁移过几次」）。');
lines.push('');
if (lastTickSummary) {
  lines.push('最后一次生态 tick 的原始摘要：`' + lastTickSummary + '`');
  lines.push('');
}

lines.push('## 六、采集到的东西');
lines.push('');
if (harvestItems.size === 0) {
  lines.push('这一轮没有采集记录 —— 采集只在**强 3 级及以上**（看见本质）时才发生，');
  lines.push('而窗口内大多数玩家的序列还够不到那一层。这是预期的，不是缺陷。');
} else {
  lines.push('| 物品 | 件数 |');
  lines.push('| --- | --- |');
  for (const [itemId, n] of [...harvestItems.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push('| ' + itemId + ' | ' + n + ' |');
  }
}
lines.push('');

writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log('生物覆盖报告已写入：' + outPath);
console.log('  判定 ' + totals.rolls + ' 次、命中 ' + totals.hits + ' 次、分层 ' + JSON.stringify(Object.fromEntries(layerCount)));