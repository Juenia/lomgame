#! /usr/bin/env node
/**
 * M2.18 · m221 前的两张表（**0 批**）：
 *   A 「材料齐 + DIG 够」的 6 人卡在哪（E3）—— 时间窗口？没发起？失败了？
 *   B E2 的影响面 —— 门槛降到 80 / 77 / 75 / 70 各能救几个人（分「材料齐」与「双缺」两类）
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { digThresholdFor } from '../src/domain/promotion/promotion.ts';

const content = loadContent();
const SHARDS = 8;
const PREFIX = 'm220a';
const DAY = 86400000;

const CLASS = { ready: 'ready', digShort: 'digShort', matShort: 'matShort', both: 'both' };
interface Rec { id: string; pathway: string; dig: number; cls: string; matAt: number; digAt: number; attempts: number; fails: number; success: number; endAt: number }
const recs: Rec[] = [];
let t0 = Number.POSITIVE_INFINITY;

for (let i = 0; i < SHARDS; i += 1) {
  let db: DatabaseSync;
  try { db = new DatabaseSync('data/' + PREFIX + '-shard-' + i + '.db', { readOnly: true }); } catch { continue; }
  const rows = db.prepare('SELECT id, pathway, dig FROM characters WHERE sequence = 8').all() as unknown as Array<{ id: string; pathway: string; dig: number }>;
  const all = db.prepare('SELECT character_id, type, payload, created_at FROM domain_events ORDER BY created_at').all() as unknown as Array<{ character_id: string; type: string; payload: string; created_at: number }>;
  for (const r of all) if (Number(r.created_at) < t0) t0 = Number(r.created_at);
  for (const c of rows) {
    const recipe = content.recipes.find((x) => x.pathway === c.pathway && x.seq === 8);
    if (!recipe) continue;
    const threshold = digThresholdFor(recipe);
    // DIG 累加到门槛的时刻
    let dig = 0; let digAt = 0;
    for (const e of all) {
      if (e.character_id !== c.id || e.type !== 'dig_delta') continue;
      let v = 0; try { v = Number((JSON.parse(e.payload) as { value?: number }).value ?? 0); } catch { /* keep */ }
      dig += v;
      if (digAt === 0 && dig >= threshold) digAt = Number(e.created_at);
    }
    // 材料齐的时刻（最后一种材料到手的那一刻）
    const need = new Map<string, { need: number; got: number; at: number }>();
    for (const m of recipe.main) need.set(m.itemId, { need: m.qty * NUMERIC.promotion.mainMaterialMultiplier, got: 0, at: 0 });
    for (const e of all) {
      if (e.character_id !== c.id || e.type !== 'item_gain') continue;
      let itemId = ''; let qty = 0;
      try { const p = JSON.parse(e.payload) as { itemId?: string; quantity?: number }; itemId = String(p.itemId ?? ''); qty = Number(p.quantity ?? 1); } catch { /* keep */ }
      const slot = need.get(itemId); if (!slot) continue;
      slot.got += qty;
      if (slot.got >= slot.need) slot.at = Number(e.created_at);
    }
    /*
     * 「材料齐」用**期末持有量**（与 data/m220-classes.mjs 同一口径）——
     * 事件流累加**不减消耗**，会把「拿过但已经用掉/卖掉」的人也算进来，那是假数。
     * `matAt`（什么时候凑齐的）只能从事件流近似 —— 它是「最后一次让某一种到手」的时刻。
     */
    let matAt = 0;
    let missing = 0;
    for (const m of recipe.main) {
      const owned = Number((db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory WHERE character_id = ? AND item_id = ?').get(c.id, m.itemId) as { n: number }).n);
      if (owned < m.qty * NUMERIC.promotion.mainMaterialMultiplier) missing += 1;
    }
    for (const slot of need.values()) { if (slot.at > matAt) matAt = slot.at; }
    const digOk = Number(c.dig) >= threshold;
    const cls = missing === 0 && digOk ? CLASS.ready : missing === 0 ? CLASS.digShort : digOk ? CLASS.matShort : CLASS.both;
    let attempts = 0; let fails = 0; let success = 0;
    for (const e of all) {
      if (e.character_id !== c.id) continue;
      if (e.type === 'promotion_fail') fails += 1;
      else if (e.type === 'promotion_success') success += 1;
      else if (e.type === 'promotion_attempt') attempts += 1;
    }
    const end = all.filter((e) => e.character_id === c.id).reduce((a, e) => Math.max(a, Number(e.created_at)), 0);
    recs.push({ id: c.id, pathway: c.pathway, dig: Number(c.dig), cls, matAt, digAt, attempts, fails, success, endAt: end });
  }
  db.close();
}

console.log('=== A：「材料齐 + DIG 够」的人卡在哪（E3 的目标人群）===');
const ready = recs.filter((r) => r.cls === CLASS.ready);
console.log('共 ' + ready.length + ' 人（判据：期末材料齐 且 期末 DIG >= 85）');
for (const r of ready) {
  const both = Math.max(r.matAt, r.digAt);
  const windowDays = both > 0 ? ((r.endAt - both) / DAY).toFixed(1) : '?';
  const acts = r.success > 0 ? '已晋升' : r.fails > 0 ? ('失败 ' + r.fails + ' 次') : r.attempts > 0 ? '发起过' : '**一次都没发起**';
  console.log('  ' + r.id + '（' + r.pathway + '，DIG ' + r.dig.toFixed(1) + '）：两项都满足后有 ' + windowDays + ' 天窗口；' + acts);
}

console.log('');
console.log('=== B：E2 的影响面（门槛 × 能救人数）===');
console.log('| 门槛 | 材料齐且 DIG 够（E2 单独就能救） | 双缺里 DIG 达标（补上材料就能过） | 合计潜力 |');
console.log('| --- | --- | --- | --- |');
for (const t of [85, 80, 77, 75, 70]) {
  const a = recs.filter((r) => r.cls === CLASS.ready && r.dig >= t).length + recs.filter((r) => r.cls === CLASS.digShort && r.dig >= t).length;
  const b = recs.filter((r) => r.cls === CLASS.both && r.dig >= t).length;
  console.log('| ' + t + (t === 85 ? '（现状）' : '') + ' | ' + a + ' | ' + b + ' | ' + (a + b) + ' |');
}
console.log('');
console.log('（序列 8 共 ' + recs.length + ' 人：材料齐 ' + recs.filter((r) => r.cls === CLASS.ready || r.cls === CLASS.digShort).length + '、材料不齐 ' + recs.filter((r) => r.cls === CLASS.matShort || r.cls === CLASS.both).length + '）');
