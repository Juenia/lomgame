#! /usr/bin/env node
/**
 * M2.20 · 任务 2：K7 落地的跑批取数（六项口径 + 与基线的比例对比）
 *
 * ## 为什么用比例判，不吃绝对差
 * K7 改了 `.晋升` 失败的扣料 → 材料持有量变 → vplayer「材料齐了才调」的判断变 →
 * 指令条数变 → `messageId`（vp-{id}-{day}-{login}-{step}）变 → **seed 变**（任务 0 的判定：情况 B）。
 * 所以**即使同 seed 参数，两批也不是同一套 messageId**，绝对差里混着噪声。
 * 主判据用**比例**（与 E1 的「材料齐率」同型），绝对人数只报出来做参照。
 *
 * ## 六项口径（任务书给定）
 *   1. 8→7 过线人数          状态表（characters.sequence）
 *   2. 曾经凑齐材料人数       事件流（item_gain 累加，**不减消耗** —— K4：判断「曾经」读事件流）
 *   3. 期末材料齐人数         状态表（inventory）
 *   4. 判多次的人数分布       事件流（promotion_*，payload.from = 8）
 *   5. 材料被清空次数         事件流（晋升扣料后持有量跌破需求）
 *   6. 失败后再没试过的人数   事件流（最后一次 8→7 失败之后没有再次判定）
 *
 * 用法：node scripts/m223-k7-report.ts --batch m223a --baseline m221a [--shards 8]
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { shardKey, type ShardKey } from '../src/infra/shard-key.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm223a');
const BASELINE = argOf('baseline', 'm221a');
const SHARDS = Number(argOf('shards', '8'));
const SEQ8 = NUMERIC.sequence7.recipeSeq;

const content = loadContent();
const needOf = (pathway: string | null): Array<{ itemId: string; qty: number }> => {
  const recipe = content.recipes.find((r) => r.pathway === pathway && r.seq === SEQ8);
  return recipe ? recipe.main.map((m) => ({ itemId: m.itemId, qty: m.qty * NUMERIC.promotion.mainMaterialMultiplier })) : [];
};

interface Stat {
  seq7: number; everReady: number; holdingNow: number;
  triesHist: Map<number, number>;
  emptied: number; gaveUp: number; judged: number;
  key: ShardKey;
}
function collect(batch: string): { stat: Stat; shards: number } {
  const stat: Stat = { seq7: 0, everReady: 0, holdingNow: 0, triesHist: new Map(), emptied: 0, gaveUp: 0, judged: 0, key: shardKey(0, batch) };
  let shards = 0;
  for (let s = 0; s < SHARDS; s += 1) {
    let db: DatabaseSync;
    try { db = new DatabaseSync('data/' + batch + '-shard-' + s + '.db', { readOnly: true }); } catch { continue; }
    shards += 1;
    const chars = db.prepare('SELECT id, pathway, sequence FROM characters').all() as unknown as Array<{ id: string; pathway: string | null; sequence: number | null }>;
    for (const c of chars) {
      if (c.sequence !== null && Number(c.sequence) <= 7) stat.seq7 += 1;
      const need = needOf(c.pathway);
      if (need.length === 0) continue;
      const events = db.prepare('SELECT type, payload, reason, created_at FROM domain_events WHERE character_id = ? ORDER BY created_at, id')
        .all(c.id) as unknown as Array<{ type: string; payload: string; reason: string; created_at: number }>;
      const gained = new Map<string, number>();
      let everReady = false;
      let hold = new Map<string, number>();
      let tries = 0;
      let lastFailAt = -1;
      let triedAfterFail = false;
      for (const e of events) {
        let p: Record<string, unknown> = {};
        try { p = JSON.parse(e.payload) as Record<string, unknown>; } catch { p = {}; }
        const itemId = String(p.itemId ?? '');
        if (e.type === 'item_gain' && need.some((n) => n.itemId === itemId)) {
          gained.set(itemId, (gained.get(itemId) ?? 0) + Number(p.quantity ?? 1));
        } else if (e.type === 'item_delta' && need.some((n) => n.itemId === itemId)) {
          hold.set(itemId, (hold.get(itemId) ?? 0) + Number(p.quantity ?? 0));
        } else if ((e.type === 'promotion_fail' || e.type === 'promotion_success') && Number(p.from) === SEQ8) {
          tries += 1; stat.judged += 1;
          if (lastFailAt >= 0) triedAfterFail = true;
          if (e.type === 'promotion_fail') lastFailAt = Number(e.created_at);
          // 「清空」：这次扣料之后，持有量跌破了需求
          if (e.type === 'promotion_fail' && need.some((n) => (hold.get(n.itemId) ?? 0) < n.qty)) stat.emptied += 1;
        }
      }
      everReady = need.every((n) => (gained.get(n.itemId) ?? 0) >= n.qty);
      if (everReady) stat.everReady += 1;
      if (everReady) {
        stat.triesHist.set(tries, (stat.triesHist.get(tries) ?? 0) + 1);
        if (lastFailAt >= 0 && !triedAfterFail) stat.gaveUp += 1;
      }
      let holding = true;
      for (const n of need) {
        const owned = Number((db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory WHERE character_id = ? AND item_id = ?').get(c.id, n.itemId) as { n: number }).n);
        if (owned < n.qty) holding = false;
      }
      if (holding) stat.holdingNow += 1;
    }
    db.close();
  }
  return { stat, shards };
}

const A = collect(BATCH);
const B = collect(BASELINE);
const pct = (a: number, b: number): string => (b === 0 ? '—' : ((a / b) * 100).toFixed(1) + '%');
const rate = (a: number, b: number): string => (b === 0 ? '—' : ((a / b) * 100).toFixed(1) + '%');

console.log('=== §0 输入 ===');
console.log('  主批 ' + BATCH + '（' + A.shards + ' 片） / 基线 ' + BASELINE + '（' + B.shards + ' 片）');

console.log('');
console.log('=== §1 六项口径并排 ===');
console.log('  | # | 量 | 口径 | ' + BASELINE + ' | ' + BATCH + ' | 差 |');
console.log('  | --- | --- | --- | --- | --- | --- |');
const row = (i: number, name: string, how: string, a: number, b: number): void => {
  console.log('  | ' + i + ' | ' + name + ' | ' + how + ' | ' + a + ' | ' + b + ' | ' + (b - a >= 0 ? '+' : '') + (b - a) + ' |');
};
row(1, '8→7 过线人数', '状态表', B.stat.seq7, A.stat.seq7);
row(2, '曾经凑齐材料', '事件流', B.stat.everReady, A.stat.everReady);
row(3, '期末材料齐', '状态表', B.stat.holdingNow, A.stat.holdingNow);
row(4, '8→7 判定总次数', '事件流', B.stat.judged, A.stat.judged);
row(5, '材料被清空次数', '事件流', B.stat.emptied, A.stat.emptied);
row(6, '失败后再没试过', '事件流', B.stat.gaveUp, A.stat.gaveUp);

console.log('');
console.log('=== §2 主判据：**比例**（不吃绝对差 —— 两批不是同一套 messageId，任务 0 已判定）===');
console.log('  | 比率 | 定义 | ' + BASELINE + ' | ' + BATCH + ' | 差 |');
console.log('  | --- | --- | --- | --- | --- |');
const r1a = rate(B.stat.holdingNow, B.stat.everReady), r1b = rate(A.stat.holdingNow, A.stat.everReady);
console.log('  | **期末材料齐率** | 期末材料齐 / 曾经凑齐 | ' + r1a + ' | ' + r1b + ' | ' + ((A.stat.holdingNow / Math.max(1, A.stat.everReady)) - (B.stat.holdingNow / Math.max(1, B.stat.everReady)) >= 0 ? '+' : '') + (((A.stat.holdingNow / Math.max(1, A.stat.everReady)) - (B.stat.holdingNow / Math.max(1, B.stat.everReady))) * 100).toFixed(1) + ' pp |');
const r2a = rate(B.stat.emptied, B.stat.judged), r2b = rate(A.stat.emptied, A.stat.judged);
console.log('  | **每次判定被清空率** | 材料被清空 / 8→7 判定数 | ' + r2a + ' | ' + r2b + ' | — |');
console.log('  | **放弃率** | 失败后再没试过 / 曾经凑齐 | ' + rate(B.stat.gaveUp, B.stat.everReady) + ' | ' + rate(A.stat.gaveUp, A.stat.everReady) + ' | — |');
console.log('  | 8→7 过线率 | 过线 / 曾经凑齐 | ' + rate(B.stat.seq7, B.stat.everReady) + ' | ' + rate(A.stat.seq7, A.stat.everReady) + ' | — |');

console.log('');
console.log('=== §3 判多次的人数分布（曾经凑齐的人，按 8→7 判定次数）===');
console.log('  | 判定次数 | ' + BASELINE + ' | ' + BATCH + ' |');
console.log('  | --- | --- | --- |');
for (const k of [...new Set([...B.stat.triesHist.keys(), ...A.stat.triesHist.keys()])].sort((x, y) => x - y)) {
  console.log('  | 判 ' + k + ' 次 | ' + (B.stat.triesHist.get(k) ?? 0) + ' | ' + (A.stat.triesHist.get(k) ?? 0) + ' |');
}

console.log('');
console.log('=== §4 读法 ===');
console.log('  · 绝对差**不能**当日志的净效果（任务 0：材料量间接进 messageId ⇒ 两批不同 seed）；');
console.log('  · 主判据是 §2 的**比率**；§1 的绝对数只做量级参照；');
console.log('  · K7 的**直接效果**是确定数，见 docs/m220_K7直接效果.md（+6 人，口径 = 期末材料齐人数）。');
console.log('    本脚本 §1 第 3 行是它在**新一批**上的独立读数，两者可以对账。');
console.log('  · 注意指标不同：+6 是「材料齐人数」，不是「8→7 过线人数」。');
