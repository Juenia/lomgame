#! /usr/bin/env node
/**
 * ⚠️ **已被 scripts/m2-18-e-decompose.ts 取代（M2.18 · E 收尾）—— 不要再拿它取数。**
 *
 * 取代它的三条理由（都在新脚本里修掉了）：
 *   1. 批次号写死在这个文件里（下面的 ['m220a', 'm221a']），换一批要改代码；
 *      新脚本是 --batch / --baseline 参数化的。
 *   2. 仪式耗时读 rituals 的 started_at / resolved_at（状态表时间戳）；
 *      新脚本按任务书口径改读**事件流**（ritual_setup → ritual_success 的时间差），
 *      状态表时间戳只用来做「落库了没有」的交叉核对。
 *   3. 末尾那句「两者之差 ≈ ritual 修的单独贡献」是**跨 seed** 的比较，没有信息量
 *      （m220a 与 m221a 是两个 seed，+7 vs +7 的差不是 E3 的效果）。
 *      新脚本改成**单批内对照**：m221a 内部的 8→7 按「发起→融合成功是否跨过 30 分钟」分组。
 *
 * 保留这个文件只为「上一轮的数是这么算出来的」可追溯 —— tsc 仍然覆盖它。
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';

const content = loadContent();
const SHARDS = 8;
const BATCHES = ['m220a', 'm221a'];

interface SeqRec {
  shard: number;
  pid: number;
  even: boolean;
  sequence: number;
  dig: number;
  pathway: string | null;
  everReady?: boolean;
}
interface Collected {
  seq8: SeqRec[];
  seq7: SeqRec[];
  ritualSuccess: number[];
}

function collect(prefix: string): Collected {
  const out: Collected = { seq8: [], seq7: [], ritualSuccess: [] };
  for (let i = 0; i < SHARDS; i += 1) {
    let db: DatabaseSync;
    try { db = new DatabaseSync('data/' + prefix + '-shard-' + i + '.db', { readOnly: true }); } catch { continue; }
    const cs = db.prepare('SELECT id, user_id, pathway, sequence, dig FROM characters').all() as unknown as Array<{
      id: string; user_id: string; pathway: string | null; sequence: number | null; dig: number;
    }>;
    const evs = db.prepare('SELECT character_id, type, payload, created_at FROM domain_events ORDER BY created_at').all() as unknown as Array<{
      character_id: string; type: string; payload: string; created_at: number;
    }>;
    const gains = new Map<string, number>();
    for (const e of evs) {
      if (e.type !== 'item_gain') continue;
      let itemId = ''; let qty = 1;
      try {
        const p = JSON.parse(e.payload) as { itemId?: string; quantity?: number };
        itemId = String(p.itemId ?? ''); qty = Number(p.quantity ?? 1);
      } catch { /* 脏 JSON 当没拿到 */ }
      const k = e.character_id + '|' + itemId;
      gains.set(k, (gains.get(k) ?? 0) + qty);
    }
    for (const c of cs) {
      const pid = Number(String(c.user_id)) - 700000;
      const sequence = Number(c.sequence ?? 9);
      const rec: SeqRec = { shard: i, pid, even: pid % 2 === 0, sequence, dig: Number(c.dig), pathway: c.pathway };
      if (sequence === 8) {
        const recipe = content.recipes.find((r) => r.pathway === c.pathway && r.seq === 8);
        let everReady = false;
        if (recipe) {
          everReady = recipe.main.every((m) => (gains.get(c.id + '|' + m.itemId) ?? 0) >= m.qty * NUMERIC.promotion.mainMaterialMultiplier);
        }
        out.seq8.push({ ...rec, everReady });
      } else if (sequence <= 7) out.seq7.push(rec);
    }
    const rows = db.prepare('SELECT status, started_at, resolved_at FROM rituals').all() as unknown as Array<{
      status: string; started_at: number | null; resolved_at: number | null;
    }>;
    for (const r of rows) {
      if (r.status === 'success' && r.started_at && r.resolved_at) {
        out.ritualSuccess.push((Number(r.resolved_at) - Number(r.started_at)) / 3600000);
      }
    }
    db.close();
  }
  return out;
}

for (const prefix of BATCHES) {
  const d = collect(prefix);
  const e7 = d.seq7.filter((r) => r.even).length, o7 = d.seq7.length - e7;
  const e8 = d.seq8.filter((r) => r.even).length, o8 = d.seq8.length - e8;
  console.log('=== ' + prefix + ' ===');
  console.log('  序列 8：' + d.seq8.length + '（偶 ' + e8 + ' / 奇 ' + o8 + '）；≤7：' + d.seq7.length + '（偶 ' + e7 + ' / 奇 ' + o7 + '）');
  const ever = d.seq8.filter((r) => r.everReady);
  const everE = ever.filter((r) => r.even).length, everO = ever.length - everE;
  console.log('  **曾经凑齐过材料**的序列 8：' + ever.length + '（偶 ' + everE + ' / 奇 ' + everO + '）  ← 读事件流，不是期末快照');
  const su = d.ritualSuccess;
  if (su.length) {
    su.sort((x, y) => x - y);
    const q = (p: number): string => su[Math.min(su.length - 1, Math.floor(su.length * p))]!.toFixed(1);
    console.log('  仪式成功 ' + su.length + ' 条，发起→融合耗时（小时）：中位 ' + q(0.5) + ' / P25 ' + q(0.25) + ' / P75 ' + q(0.75) + ' / 最大 ' + su[su.length - 1]!.toFixed(1));
  }
}

const a = collect('m220a'), b = collect('m221a');
console.log('');
console.log('=== 拆 +14（≤7 的奇偶增量）—— 这个口径已被取代，见表头说明 ===');
const ae = a.seq7.filter((r) => r.even).length, ao = a.seq7.length - ae;
const be = b.seq7.filter((r) => r.even).length, bo = b.seq7.length - be;
console.log('  偶数号（依赖 ritual）：' + ae + ' → ' + be + '（+' + (be - ae) + '）');
console.log('  奇数号（不依赖 ritual，只吃 E1+E2）：' + ao + ' → ' + bo + '（+' + (bo - ao) + '）');
console.log('  ⚠️ 两者之差不是 E3 的贡献（跨 seed）—— 单批内对照见 scripts/m2-18-e-decompose.ts。');
