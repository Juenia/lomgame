/**
 * M2.14 任务 D：**三批归因**（同 seed · 同代码 · 只差灾厄开关与灾厄产出落点）。
 *
 * 用法：node scripts/m2-14-attribution.ts
 *
 *   主批 #1   data/m214-shard-N.db     seed m214，灾厄 on，灾厄产出**只挂战斗**（提交 616b31d）
 *   对照批    data/m214off-shard-N.db  seed m214，灾厄 **off**（提交 c7f1510 的开关）
 *   主批 #2   data/m214a-shard-N.db    seed m214，灾厄 on，灾厄产出**双挂**（方案 A）
 *
 * 三批的**玩家行为 seed 完全相同**（都是 m214:shard:i），所以差别只来自灾厄本身。
 * 这是 P1 归因、总产出归因、灾厄产出占比的唯一干净判据。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { calamityAt } from '../src/domain/world/calamity.ts';

const SHARDS = 8;
const WORLD_SEED = 'world';

interface Batch {
  prefix: string;
  label: string;
  p0: number;
  p1: number;
  calamityEvents: number;
  exploreDrops: number;
  calamityExploreDrops: number;
  calamityBattleDrops: number;
  explores: number;
  exploresOnCalamityDay: number;
  dropsOnCalamityDay: number;
}

function readBatch(prefix: string, label: string): Batch {
  const batch: Batch = {
    prefix,
    label,
    p0: 0,
    p1: 0,
    calamityEvents: 0,
    exploreDrops: 0,
    calamityExploreDrops: 0,
    calamityBattleDrops: 0,
    explores: 0,
    exploresOnCalamityDay: 0,
    dropsOnCalamityDay: 0,
  };
  for (let i = 0; i < SHARDS; i += 1) {
    const jsonPath = join('data/vplayer-shards-' + prefix, prefix + '-shard-' + i + '.json');
    if (!existsSync(jsonPath)) throw new Error('找不到分片 JSON：' + jsonPath);
    const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as { anomalies: { level: string }[] };
    for (const a of json.anomalies) {
      if (a.level === 'P0') batch.p0 += 1;
      else batch.p1 += 1;
    }

    const db = new DatabaseSync(join('data', prefix + '-shard-' + i + '.db'), { readOnly: true });
    const ev = db.prepare("SELECT COUNT(*) AS n FROM world_events WHERE type = 'calamity'").get() as { n: number };
    batch.calamityEvents += ev.n;

    for (const row of db
      .prepare(
        "SELECT reason, COUNT(*) AS n FROM domain_events WHERE type = 'item_gain' " +
          "AND reason IN ('探索·封印物掉落', '探索·灾厄掉落', '战斗·灾厄掉落') GROUP BY reason",
      )
      .all() as { reason: string; n: number }[]) {
      if (row.reason === '探索·封印物掉落') batch.exploreDrops += row.n;
      else if (row.reason === '探索·灾厄掉落') batch.calamityExploreDrops += row.n;
      else batch.calamityBattleDrops += row.n;
    }

    for (const row of db
      .prepare(
        'SELECT type, created_at FROM domain_events WHERE ' +
          "(type = 'ap_delta' AND reason = '探索消耗') OR (type = 'item_gain' AND reason = '探索·封印物掉落')",
      )
      .all() as { type: string; created_at: number }[]) {
      const onCalamityDay = calamityAt(WORLD_SEED, row.created_at) !== null;
      if (row.type !== 'ap_delta') {
        if (onCalamityDay) batch.dropsOnCalamityDay += 1;
        continue;
      }
      batch.explores += 1;
      if (onCalamityDay) batch.exploresOnCalamityDay += 1;
    }
    db.close();
  }
  return batch;
}

const BATCHES = [
  readBatch('m214', '主批 #1（灾厄 on · 只挂战斗）'),
  readBatch('m214off', '对照批（灾厄 off）'),
  readBatch('m214a', '主批 #2（灾厄 on · 方案 A 双挂）'),
];
const total = (b: Batch): number => b.exploreDrops + b.calamityExploreDrops + b.calamityBattleDrops;
const calamityTotal = (b: Batch): number => b.calamityExploreDrops + b.calamityBattleDrops;
const rate = (hit: number, base: number): string => (base > 0 ? ((hit / base) * 100).toFixed(2) + '%' : '—');

const lines: string[] = [];
const P = (s = ''): void => { lines.push(s); };
const K = '`';

P('# M2.14 对照批与方案 A 归因（三批 · 同 seed · 只差灾厄）');
P();
P('| 批次 | 数据 | 灾厄 | 灾厄产出落点 |');
P('| --- | --- | --- | --- |');
P('| 主批 #1 | ' + K + 'data/m214-shard-N.db' + K + ' | on | 只挂战斗胜利（提交 616b31d） |');
P('| 对照批 | ' + K + 'data/m214off-shard-N.db' + K + ' | **off** | —（开关 ' + K + 'M214_CALAMITY=off' + K + '，提交 c7f1510） |');
P('| 主批 #2 | ' + K + 'data/m214a-shard-N.db' + K + ' | on | **双挂**：每次探索 6.2% + 战斗胜利 30.2%（方案 A） |');
P();
P('> 三批的**玩家行为 seed 完全相同**（' + K + 'm214:shard:<i>' + K + '），差别只来自灾厄本身。');
P();
P('## 一、总览');
P();
P('| 指标 | ' + BATCHES.map((b) => b.label).join(' | ') + ' |');
P('| --- | ' + BATCHES.map(() => '---').join(' | ') + ' |');
const row = (name: string, pick: (b: Batch) => string): void => {
  P('| ' + name + ' | ' + BATCHES.map((b) => pick(b)).join(' | ') + ' |');
};
row('P0', (b) => String(b.p0));
row('**P1**', (b) => '**' + b.p1 + '**');
row('灾厄事件', (b) => String(b.calamityEvents));
row('封印物总产出', (b) => String(total(b)));
row('　其中：探索掉落（旧 9 个档位）', (b) => String(b.exploreDrops));
row('　其中：**灾厄产出**', (b) => String(calamityTotal(b)) + '（探索 ' + b.calamityExploreDrops + ' / 战斗 ' + b.calamityBattleDrops + '）');
row('　灾厄产出占比', (b) => (calamityTotal(b) / Math.max(1, total(b)) * 100).toFixed(1) + '%');
row('探索次数', (b) => String(b.explores));
row('探索掉落率', (b) => rate(b.exploreDrops, b.explores));
P();
P('> **开关验证**：对照批的灾厄事件必须是 0 —— 实测 ' + BATCHES[1]!.calamityEvents + ' 条。');
P();
P('## 二、P1 归因（第 1 步任务书的分层判据）');
P();
P('| 对照批 P1 | 判定 |');
P('| --- | --- |');
P('| 0 | 灾厄引起 |');
P('| 1—5 | 灾厄加剧，但基础存在 |');
P('| ≥ 10 | 与灾厄无关 |');
P();
const controlP1 = BATCHES[1]!.p1;
const verdict = controlP1 === 0
  ? '**灾厄引起**（已按任务书要求顺带查了行为差异，见 §四）'
  : controlP1 <= 5 ? '**灾厄加剧，但基础存在**' : '**与灾厄无关** —— M2.13.1 的 DEADLOCK 现象延续';
P('**对照批 P1 = ' + controlP1 + '（主批 #1 = ' + BATCHES[0]!.p1 + '，主批 #2 = ' + BATCHES[2]!.p1 + '）→ ' + verdict + '**');
P();
P('## 三、总产出归因');
P();
P('| 口径 | ' + BATCHES.map((b) => b.label).join(' | ') + ' |');
P('| --- | ' + BATCHES.map(() => '---').join(' | ') + ' |');
row('封印物总产出', (b) => String(total(b)));
row('与 M2.13 的 420 之差', (b) => String(total(b) - 420));
P();
P('> 对照批（灾厄完全关掉）的总产出是 ' + total(BATCHES[1]!) + ' —— 它与主批 #1 的 ' + total(BATCHES[0]!) +
  ' 相差 ' + Math.abs(total(BATCHES[1]!) - total(BATCHES[0]!)) + ' 件，');
P('> 说明「397 vs 420」这一截主要是**跨 seed 波动**（M2.13 用的是 ' + K + 'm213' + K + '，本轮是 ' + K + 'm214' + K + '），');
P('> 而不是灾厄压出来的。灾厄真正压掉的是探索掉落那一栏的差额。');
P();
P('## 四、灾厄日 vs 非灾厄日（同一批数据内对照）');
P();
P('| 批次 | 灾厄日探索 | 灾厄日掉落 | 灾厄日掉落率 | 非灾厄日掉落率 | 差异 |');
P('| --- | --- | --- | --- | --- | --- |');
for (const b of BATCHES) {
  const outExplores = b.explores - b.exploresOnCalamityDay;
  const outDrops = b.exploreDrops - b.dropsOnCalamityDay;
  const inRate = b.exploresOnCalamityDay > 0 ? b.dropsOnCalamityDay / b.exploresOnCalamityDay : 0;
  const outRate = outExplores > 0 ? outDrops / outExplores : 0;
  P('| ' + b.label + ' | ' + b.exploresOnCalamityDay + ' | ' + b.dropsOnCalamityDay + ' | ' +
    (inRate * 100).toFixed(2) + '% | ' + (outRate * 100).toFixed(2) + '% | ' + ((outRate - inRate) * 100).toFixed(2) + ' pp |');
}
P();

writeFileSync(join('docs', 'M2.14-对照批归因.md'), lines.join('\n').split(K).join(String.fromCharCode(96)), 'utf8');

console.log('已写 docs/M2.14-对照批归因.md');
for (const b of BATCHES) {
  console.log(b.label + '：P1=' + b.p1 + ' 总产出=' + total(b) + '（探索 ' + b.exploreDrops +
    ' / 灾厄 ' + calamityTotal(b) + '，占比 ' + (calamityTotal(b) / Math.max(1, total(b)) * 100).toFixed(1) + '%）探索 ' + b.explores + ' 次');
}
