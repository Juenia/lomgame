#! /usr/bin/env node
/**
 * M2.20 · 任务 0.6：K7 的**直接效果**重放（**不跑批、不动判定层、不建新库**）
 *
 * ## 要算什么
 * K7 把 `.晋升` 失败的扣料从「全额」改成「50%」。它的效果分两层：
 *   · **直接效果**（本脚本）：材料多留一半 —— 从 m221a 的既有事件流重放就能得到**确定数**；
 *   · **间接效果**（任务 2）：材料多了之后玩家会不会多做点事 —— 那个才需要跑批。
 *
 * ## 重放口径
 * 材料持有量的轨迹 = `item_gain` 累加 − `item_delta` 累减。
 * **唯一要替换的一步**：与 `promotion_fail`（from=8）同刻的那一次扣除 ——
 * 旧参数下它是"全额"（= 需求本身），新参数下是 `ceil(需求 × 0.5)`。
 * 其余扣除（交易、服用、净化…）原样保留。
 *
 * ⚠️ 重放**只改持有量**，不改「玩家会不会再试一次」—— 后者是间接效果，本脚本不碰。
 * 所以本脚本的数与任务 2 的跑批数**不是同一个量**，不要混着读。
 *
 * 用法：node scripts/m220-k7-replay.ts [--batch m221a] [--shards 8] [--loss 0.5]
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { materialLossOf } from '../src/domain/ritual/resolve.ts';
import { shardKey, type ShardKey } from '../src/infra/shard-key.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm221a');
const SHARDS = Number(argOf('shards', '8'));
const LOSS = Number(argOf('loss', '0.5'));
const SEQ8 = NUMERIC.sequence7.recipeSeq;

const content = loadContent();
const needOf = (pathway: string | null): Array<{ itemId: string; qty: number }> => {
  const recipe = content.recipes.find((r) => r.pathway === pathway && r.seq === SEQ8);
  if (!recipe) return [];
  return recipe.main.map((m) => ({ itemId: m.itemId, qty: m.qty * NUMERIC.promotion.mainMaterialMultiplier }));
};

interface Row {
  key: ShardKey; pathway: string | null; sequence: number | null;
  everReady: boolean; readyAt: number;
  /** 旧参数（实际）：状态表 inventory 的期末持有量够不够 */
  holdingOld: boolean;
  /** 新参数（重放）：同样的轨迹，但晋升失败只扣 50% */
  holdingNew: boolean;
  /** **旧参数（重放）** —— K7 的对照基线：同一套重放口径、不替换晋升失败的扣除 */
  holdingReplayBase: boolean;
  /** 重放出的期末各材料持有量（新参数） */
  newHold: Map<string, number>;
  fails87: number;
}

const rows: Row[] = [];
let shardsRead = 0;

for (let s = 0; s < SHARDS; s += 1) {
  let db: DatabaseSync;
  try { db = new DatabaseSync('data/' + BATCH + '-shard-' + s + '.db', { readOnly: true }); } catch { continue; }
  shardsRead += 1;
  const chars = db.prepare('SELECT id, pathway, sequence FROM characters').all() as unknown as Array<{
    id: string; pathway: string | null; sequence: number | null;
  }>;
  for (const c of chars) {
    const need = needOf(c.pathway);
    if (need.length === 0) continue;
    const events = db.prepare(
      'SELECT type, payload, reason, created_at FROM domain_events WHERE character_id = ? ORDER BY created_at, id',
    ).all(c.id) as unknown as Array<{ type: string; payload: string; reason: string; created_at: number }>;

    /** 曾经凑齐（事件流累加，**不减消耗** —— K4 的反向：判断「曾经」读事件流） */
    const gained = new Map<string, number>();
    const readyAtOf = new Map<string, number>();
    for (const e of events) {
      if (e.type !== 'item_gain') continue;
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(e.payload) as Record<string, unknown>; } catch { p = {}; }
      const itemId = String(p.itemId ?? '');
      const slot = need.find((n) => n.itemId === itemId);
      if (!slot) continue;
      const total = (gained.get(itemId) ?? 0) + Number(p.quantity ?? 1);
      gained.set(itemId, total);
      if (total >= slot.qty && !readyAtOf.has(itemId)) readyAtOf.set(itemId, Number(e.created_at));
    }
    const everReady = need.every((n) => (gained.get(n.itemId) ?? 0) >= n.qty);
    const readyAt = everReady ? Math.max(...[...readyAtOf.values()]) : 0;

    /* ---- 重放期末持有量：唯一替换的一步是「晋升失败」的那次扣除 ---- */
    const failAt = new Set<number>();
    for (const e of events) {
      if (e.type !== 'promotion_fail') continue;
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(e.payload) as Record<string, unknown>; } catch { p = {}; }
      if (Number(p.from) === SEQ8) failAt.add(Number(e.created_at));
    }
    /*
     * ⚠️ **两个重放，不是一个**（K11 的现场应用）：
     * 只跑「新参数重放」然后与**状态表**比，差里混着两种东西 —— K7 的效果，以及
     * 「重放 vs 状态表」的口径差（事件流不完整，K8 同型）。
     * 所以旧参数也要**用同一套重放**算一遍，两者相减才是 K7 的直接效果。
     */
    const hold = new Map<string, number>();
    const holdBase = new Map<string, number>();
    let fails87 = 0;
    for (const e of events) {
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(e.payload) as Record<string, unknown>; } catch { p = {}; }
      if (e.type === 'item_gain') {
        const itemId = String(p.itemId ?? '');
        if (need.some((n) => n.itemId === itemId)) {
          const add = Number(p.quantity ?? 1);
          hold.set(itemId, (hold.get(itemId) ?? 0) + add);
          holdBase.set(itemId, (holdBase.get(itemId) ?? 0) + add);
        }
      } else if (e.type === 'item_delta') {
        const itemId = String(p.itemId ?? '');
        const slot = need.find((n) => n.itemId === itemId);
        if (!slot) continue;
        const delta = Number(p.quantity ?? 0);
        if (delta >= 0) {
          hold.set(itemId, (hold.get(itemId) ?? 0) + delta);
          holdBase.set(itemId, (holdBase.get(itemId) ?? 0) + delta);
          continue;
        }
        const isOwnFail = failAt.has(Number(e.created_at)) && /^晋升/.test(e.reason);
        if (isOwnFail) {
          fails87 += 1;
          // 基线（旧参数）：全额扣 = delta 本身；新参数：materialLossOf 的向上取整
          holdBase.set(itemId, (holdBase.get(itemId) ?? 0) + delta);
          const lost = materialLossOf([{ itemId, qty: -delta }], LOSS)[0]?.qty ?? 0;
          hold.set(itemId, (hold.get(itemId) ?? 0) - lost);
        } else {
          hold.set(itemId, (hold.get(itemId) ?? 0) + delta);
          holdBase.set(itemId, (holdBase.get(itemId) ?? 0) + delta);
        }
      }
    }

    let holdingOld = true;
    let holdingNew = true;
    let holdingReplayBase = true;
    for (const n of need) {
      const old = Number((db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory WHERE character_id = ? AND item_id = ?')
        .get(c.id, n.itemId) as { n: number }).n);
      if (old < n.qty) holdingOld = false;
      if ((hold.get(n.itemId) ?? 0) < n.qty) holdingNew = false;
      if ((holdBase.get(n.itemId) ?? 0) < n.qty) holdingReplayBase = false;
    }
    rows.push({
      key: shardKey(s, c.id), pathway: c.pathway, sequence: c.sequence === null ? null : Number(c.sequence),
      everReady, readyAt, holdingOld, holdingNew, holdingReplayBase, newHold: hold, fails87,
    });
  }
  db.close();
}

if (shardsRead === 0) { console.error('批次 ' + BATCH + ' 读不到分片'); process.exit(2); }

const rate = (a: number, b: number): string => (b === 0 ? '—' : ((a / b) * 100).toFixed(1) + '%');
const ever = rows.filter((r) => r.everReady);
const holdingOldOk = ever.filter((r) => r.holdingOld).length;
const holdingNewOk = ever.filter((r) => r.holdingNew).length;
const holdingBaseOk = ever.filter((r) => r.holdingReplayBase).length;

console.log('=== §0 输入 ===');
console.log('  批次 ' + BATCH + '，' + shardsRead + '/' + SHARDS + ' 片；有 8→7 配方的人 ' + rows.length);
console.log('  K7 参数（重放用）：失败扣 ' + LOSS + '（旧参数是全额 = 1.0）');
console.log('');
console.log('=== §1 确定数（不是区间）===');
console.log('  曾经凑齐过 8→7 主材料的人数 = **' + ever.length + '**（事件流累加，不减消耗 —— 与参数无关）');
console.log('');
console.log('  | 口径 | 期末材料齐 | 比率（齐 / 曾经凑齐） |');
console.log('  | --- | --- | --- |');
console.log('  | 状态表 inventory（**实际**，旧参数） | ' + holdingOldOk + ' | ' + rate(holdingOldOk, ever.length) + ' |');
console.log('  | 重放 · **旧参数**（K7 的对照基线） | ' + holdingBaseOk + ' | ' + rate(holdingBaseOk, ever.length) + ' |');
console.log('  | 重放 · **新参数**（失败只扣 50%） | ' + holdingNewOk + ' | ' + rate(holdingNewOk, ever.length) + ' |');
console.log('');
console.log('  **K7 的直接效果 = 重放新 − 重放旧 = ' + (holdingNewOk - holdingBaseOk) + ' 人**（' +
  (ever.length === 0 ? '—' : (((holdingNewOk - holdingBaseOk) / ever.length) * 100).toFixed(1) + ' pp') + '）');
console.log('  ⚠️ 而「重放旧 − 状态表」= ' + (holdingBaseOk - holdingOldOk) + ' 人是**口径差，不是效果** ——');
console.log('     重放走事件流、状态表是权威快照，两者本来就不一致（K8 同型：事件流不完整）。');
console.log('     只跑新参数重放、直接与状态表比，会把这两种东西混成一个数（本轮先犯过这个错，已修）。');
console.log('');
console.log('=== §2 8→7 失败的逐人明细（重放口径）===');
const failed = rows.filter((r) => r.fails87 > 0).sort((a, b) => b.fails87 - a.fails87);
console.log('  判过 8→7 的人 ' + failed.length + ' 个，共 ' + failed.reduce((n, r) => n + r.fails87, 0) + ' 次判定');
console.log('');
console.log('  | 片:id | 途径 | 末序列 | 8→7 判定次数 | 曾经凑齐 | 旧参数期末齐 | 新参数期末齐 | 新参数期末持有 |');
console.log('  | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of failed) {
  const held = needOf(r.pathway).map((n) => n.itemId.replace('主材料·', '') + '=' + (r.newHold.get(n.itemId) ?? 0)).join('、');
  console.log('  | ' + r.key + ' | ' + (r.pathway ?? '—') + ' | ' + r.sequence + ' | ' + r.fails87 + ' | ' +
    (r.everReady ? '是' : '否') + ' | ' + (r.holdingOld ? '齐' : '**不齐**') + ' | ' + (r.holdingNew ? '齐' : '**不齐**') + ' | ' + held + ' |');
}
console.log('');
console.log('=== §3 读法 ===');
console.log('  · 「期末材料齐」在**旧参数**下就是 M2.18 那张互补表里的「期末料还齐」列（状态表口径）；');
console.log('  · 「新参数」那一列是**同样的轨迹、只把晋升失败的扣除改成 50%** —— 所以它是 K7 的**直接效果**，');
console.log('    它**不含**「材料多了之后玩家会多试几次」那一层（那是间接效果，要跑批）。');
console.log('  · 因此任务 3 的残差重分摊要**先减掉这一列给出的确定数**，剩下的才进「未识别项」。');
