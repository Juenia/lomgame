#! /usr/bin/env node
/**
 * M2.18 · E 部分收尾：拆 +14（**单批内对照**口径）
 *
 * 背景：m221a 的 8→7 = 32、m220a = 18，+14 是 E1（材料加量）/ E2（门槛 85→80）/
 * E3（仪式融合窗口 30min→12h）三笔的**净效果合计**。
 * ritual 的判定 seed 里含 now，而 now 由 vplayer 的时间线派生 ——
 * 所以「把 timeout 调回去再跑一批」会改 seed，回退批不成立，跨 seed 的奇偶增量差没有信息量。
 *
 * 改用**单批内对照**：m221a 内部，偶数号（走 .仪式）的 8→7 天然分成
 *   发起→融合成功 ≤ 30min → 旧窗口下也能成，与 E3 无关
 *   发起→融合成功 > 30min → **只有窗口修了才成**，是 E3 的可归因部分
 * 同 seed、同批、同 E1/E2 下的干净对照，不需要新批次。
 *
 * 三条口径（任务书硬约束）：
 *   · 耗时 = 「发起 → 融合成功」的**事件时间差**：ritual_setup.created_at → ritual_success.created_at
 *     —— 不读状态表时间戳（started_at / resolved_at 只做交叉核对，不参与计数）。
 *   · 「曾经」读 domain_events，「此刻」读状态表（K4）。
 *   · 奇偶按 user_id 的奇偶，不按片内 index。
 *
 * ⚠️ dig_delta 的载荷是 { before, after, delta }，**没有 value 字段** ——
 * 按 value 累加会得到恒 0（scripts/m2-18-e3-e2-tables.ts 就是这么写的）。
 * 这里直接用 after 的历史最大值，并与状态表 dig 对账（§0.1）。
 *
 * 用法：node scripts/m2-18-e-decompose.ts [--batch m221a] [--baseline m220a] [--shards 8]
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
const BATCH = argOf('batch', 'm221a');
const BASELINE = argOf('baseline', 'm220a');
/*
 * M2.21（铁律 10：脚本与产物一起改）：**窗口标签不能靠「谁是基线」推断。**
 *
 * 原来那行是 `name === BASELINE ? '30 分钟' : '12 小时'` —— 它假定基线批就是旧窗口那批
 * （m219c / m220a 确实如此）。M2.21 把基线换成 m223b 之后，两批**都是 12 小时窗口**
 * （差别是 K7 不是窗口），那一行就会给 m223b 标上「30 分钟」，**标签与事实相反**。
 *
 * 改成显式传：只有被点名的批才标 30 分钟，其余一律标当前代码的窗口值。
 *   node scripts/m2-18-e-decompose.ts --batch m220a --baseline m219c --old-window-batch m219c
 */
const OLD_WINDOW_BATCH = argOf('old-window-batch', '');
const SHARDS = Number(argOf('shards', '8'));

const HOUR = 3600000;
/** E3 的分界线：**旧**窗口 30 分钟（M2.18 之前的值，冻结在 test/m2-12 里） */
const OLD_WINDOW_H = 0.5;
/** 新窗口（从 NUMERIC 读，不手抄） */
const NEW_WINDOW_H = NUMERIC.ritual.runTimeoutMs / HOUR;
/** E2 的分界：[80, 85) = 「降门槛才够得着」的 DIG 区间 */
const DIG_LOW = 80;
const DIG_HIGH = 85;
/** 通向序列 7 的配方序号（8→7 用 seq = 8 的配方） */
const SEQ8 = NUMERIC.sequence7.recipeSeq;

const content = loadContent();

interface RitualMark {
  ritualId: string;
  setupAt: number | null;
  successAt: number | null;
  failAt: number | null;
  from: number | null;
  to: number | null;
}
interface Rec {
  shard: number;
  id: string;
  /** 跨片 key（M2.19 任务 4）：**不带裸 id** —— 八个片都有 c-700000，裸 id 会串人（K3/K5） */
  key: ShardKey;
  uid: number;
  even: boolean;
  sequence: number | null;
  dig: number;
  /** 期末 MAD / COR（状态表）—— .晋升 成功率的两项惩罚就来自它们 */
  mad: number;
  cor: number;
  pathway: string | null;
  /** dig_delta 的 after 历史最大值（「曾经」口径，读事件流） */
  digPeak: number;
  /** dig_delta 的 after 期末值（与状态表对照，自检用） */
  digByEvents: number;
  /** 曾经凑齐 8→7 主材料（事件流累加，**不减消耗**） */
  everReady: boolean;
  /** 期末持有量还够不够（读 inventory 状态表）—— 「曾经齐过、现在又不齐」= 被失败消耗掉了 */
  holdingNow: boolean;
  /** 凑齐时刻 = 最后一种材料到手的时刻 */
  readyAt: number;
  lastEventAt: number;
  rituals: Map<string, RitualMark>;
  /** sequence_delta 的事件（reason = 仪式:8->7 / 晋升:8->7 …）—— 哪条路把他送上来的 */
  seqPath: Array<{ before: number; after: number; reason: string; at: number }>;
  /**
   * .晋升 的判定（promotion_success + promotion_fail）。
   *
   * **必须带 from** —— 同一个玩家会判两次（9→8 用 60 的门槛、8→7 用 80），
   * 只数「次数」会把「他在序列 9 时的失败」算成「他卡在 8→7」的理由。
   * checkPromotion 被拒时**不落事件**，所以这里的每一条都是「真的判了」。
   */
  promotionTries: Array<{
    at: number; from: number; ok: boolean;
    /** 这一次判定当时的成功率 / 抽样 / 连败数 / 连败保护（都取自事件 payload，不重算） */
    chance: number; roll: number; failsAfter: number; failBonus: number;
  }>;
  /** .仪式 开始的次数（ritual_setup 条数）*/ 
  ritualSetups: number;
}

function loadBatch(prefix: string): { recs: Rec[]; batchEnd: number; ritualResults: Map<string, number> } {
  const out: Rec[] = [];
  let batchEnd = 0;
  const ritualResults = new Map<string, number>();
  for (let i = 0; i < SHARDS; i += 1) {
    let db: DatabaseSync;
    try { db = new DatabaseSync('data/' + prefix + '-shard-' + i + '.db', { readOnly: true }); } catch { continue; }
    const chars = db.prepare('SELECT id, user_id, pathway, sequence, dig, mad, cor FROM characters').all() as unknown as Array<{
      id: string; user_id: string; pathway: string | null; sequence: number | null; dig: number; mad: number; cor: number;
    }>;
    const events = db.prepare('SELECT character_id, type, payload, reason, created_at FROM domain_events ORDER BY created_at, id').all() as unknown as Array<{
      character_id: string; type: string; payload: string; reason: string; created_at: number;
    }>;
    const results = db.prepare('SELECT result, COUNT(*) AS n FROM rituals GROUP BY result').all() as unknown as Array<{ result: string | null; n: number }>;
    for (const r of results) {
      const key = r.result === null ? '（未决）' : String(r.result);
      ritualResults.set(key, (ritualResults.get(key) ?? 0) + Number(r.n));
    }
    const byChar = new Map<string, typeof events>();
    for (const e of events) {
      const list = byChar.get(e.character_id);
      if (list) list.push(e); else byChar.set(e.character_id, [e]);
      if (Number(e.created_at) > batchEnd) batchEnd = Number(e.created_at);
    }
    for (const c of chars) {
      const uid = Number(String(c.user_id));
      const rec: Rec = {
        shard: i, id: c.id, key: shardKey(i, c.id), uid, even: uid % 2 === 0,
        sequence: c.sequence === null ? null : Number(c.sequence), dig: Number(c.dig), mad: Number(c.mad), cor: Number(c.cor), pathway: c.pathway,
        digPeak: 0, digByEvents: 0, everReady: false, holdingNow: false, readyAt: 0, lastEventAt: 0,
        rituals: new Map(), seqPath: [], promotionTries: [], ritualSetups: 0,
      };
      const recipe = content.recipes.find((r) => r.pathway === c.pathway && r.seq === SEQ8);
      const need = new Map<string, { need: number; got: number; at: number }>();
      if (recipe) {
        for (const m of recipe.main) need.set(m.itemId, { need: m.qty * NUMERIC.promotion.mainMaterialMultiplier, got: 0, at: 0 });
      }
      for (const e of byChar.get(c.id) ?? []) {
        const at = Number(e.created_at);
        if (at > rec.lastEventAt) rec.lastEventAt = at;
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(e.payload) as Record<string, unknown>; } catch { payload = {}; }
        if (e.type === 'dig_delta') {
          // 载荷是 { before, after, delta } —— 取 after（权威值），不按 delta 累加
          const after = Number(payload.after ?? 0);
          rec.digByEvents = after;
          if (after > rec.digPeak) rec.digPeak = after;
        } else if (e.type === 'item_gain') {
          const slot = need.get(String(payload.itemId ?? ''));
          if (slot) {
            slot.got += Number(payload.quantity ?? 1);
            if (slot.got >= slot.need && slot.at === 0) slot.at = at;
          }
        } else if (e.type === 'promotion_success' || e.type === 'promotion_fail') {
          rec.promotionTries.push({
            at, from: Number(payload.from ?? -1), ok: e.type === 'promotion_success',
            chance: Number(payload.chance ?? NaN), roll: Number(payload.roll ?? NaN),
            failsAfter: Number(payload.failsAfter ?? NaN), failBonus: Number(payload.failBonus ?? NaN),
          });
        } else if (e.type === 'sequence_delta') {
          rec.seqPath.push({ before: Number(payload.before ?? -1), after: Number(payload.after ?? -1), reason: String(e.reason ?? ''), at });
        } else if (e.type === 'ritual_setup' || e.type === 'ritual_success' || e.type === 'ritual_fail') {
          const ritualId = String(payload.ritualId ?? '');
          if (!ritualId) continue;
          const mark = rec.rituals.get(ritualId) ?? { ritualId, setupAt: null, successAt: null, failAt: null, from: null, to: null };
          if (e.type === 'ritual_setup') { mark.setupAt = at; rec.ritualSetups += 1; }
          if (e.type === 'ritual_success') {
            mark.successAt = at;
            mark.from = payload.from === undefined ? null : Number(payload.from);
            mark.to = payload.to === undefined ? null : Number(payload.to);
          }
          if (e.type === 'ritual_fail') mark.failAt = at;
          rec.rituals.set(ritualId, mark);
        }
      }
      if (recipe) {
        let all = true;
        for (const slot of need.values()) {
          if (slot.at === 0) all = false;
          else if (slot.at > rec.readyAt) rec.readyAt = slot.at;
        }
        rec.everReady = all;
        if (!all) rec.readyAt = 0;
        rec.holdingNow = recipe.main.every((m) => Number((db.prepare(
          'SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory WHERE character_id = ? AND item_id = ?',
        ).get(c.id, m.itemId) as { n: number }).n) >= m.qty * NUMERIC.promotion.mainMaterialMultiplier);
      }
      out.push(rec);
    }
    db.close();
  }
  return { recs: out, batchEnd, ritualResults };
}

const round = (n: number, d = 2): string => n.toFixed(d);
const pct = (a: number, b: number): string => (b === 0 ? '—' : ((a / b) * 100).toFixed(1) + '%');

const MAIN = loadBatch(BATCH);
const BASE = BASELINE ? loadBatch(BASELINE) : { recs: [] as Rec[], batchEnd: 0, ritualResults: new Map<string, number>() };
const main = MAIN.recs, base = BASE.recs;

const seq7Of = (rs: Rec[]): Rec[] => rs.filter((r) => r.sequence !== null && r.sequence <= 7);
const seq8Of = (rs: Rec[]): Rec[] => rs.filter((r) => r.sequence === 8);
const successCount = (rs: Rec[]): number => rs.reduce((n, r) => n + [...r.rituals.values()].filter((m) => m.successAt !== null).length, 0);

/** 一次成功后，配对它的「发起」时刻 —— 事件流口径，不读状态表 */
function setupPairs(rs: Rec[]): Array<{ rec: Rec; mark: RitualMark; hours: number }> {
  const out: Array<{ rec: Rec; mark: RitualMark; hours: number }> = [];
  for (const r of rs) {
    for (const m of r.rituals.values()) {
      if (m.successAt === null || m.setupAt === null) continue;
      out.push({ rec: r, mark: m, hours: (m.successAt - m.setupAt) / HOUR });
    }
  }
  return out;
}
/** 某角色的某一层晋升是靠哪条路完成的（读 sequence_delta 的 reason） */
function pathTo(rec: Rec, before: number, after: number): { reason: string; at: number } | null {
  const hit = rec.seqPath.find((s) => s.before === before && s.after === after);
  return hit ? { reason: hit.reason, at: hit.at } : null;
}
/** 8→7 那次仪式成功的耗时（小时）；不是走仪式就返回 null */
function hoursOf8to7(rec: Rec): number | null {
  let best: number | null = null;
  for (const m of rec.rituals.values()) {
    if (m.successAt === null || m.setupAt === null) continue;
    if (Number(m.from) !== 8 || Number(m.to) !== 7) continue;
    const h = (m.successAt - m.setupAt) / HOUR;
    if (best === null || h > best) best = h;
  }
  return best;
}

/* ==================== §0 总览 ==================== */
console.log('=== §0 批次总览（' + SHARDS + ' 片合计）===');
console.log('| 批 | 建号 | 入途径 | 序列 8 | ≤7 | ≤7 偶 | ≤7 奇 | ritual_success 条数 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const entry of [[BASELINE, base], [BATCH, main]] as Array<[string, Rec[]]>) {
  const name = entry[0], rs = entry[1];
  if (!name || rs.length === 0) continue;
  const s7 = seq7Of(rs), s8 = seq8Of(rs);
  console.log('| ' + name + ' | ' + rs.length + ' | ' + rs.filter((r) => r.sequence !== null).length +
    ' | ' + s8.length + ' | **' + s7.length + '** | ' + s7.filter((r) => r.even).length + ' | ' + s7.filter((r) => !r.even).length +
    ' | ' + successCount(rs) + ' |');
}
const b7 = seq7Of(base).length, m7 = seq7Of(main).length;
const plus = m7 - b7;
const evenDelta = seq7Of(main).filter((r) => r.even).length - seq7Of(base).filter((r) => r.even).length;
const oddDelta = seq7Of(main).filter((r) => !r.even).length - seq7Of(base).filter((r) => !r.even).length;
console.log('');
console.log('差值 8→7：' + b7 + ' → ' + m7 + '（**+' + plus + '**）　偶数号 +' + evenDelta + ' / 奇数号 +' + oddDelta);

let mismatch = 0;
const mismatchSample: string[] = [];
for (const r of main) {
  if (r.sequence === null) continue;
  if (Math.abs(r.digByEvents - r.dig) > 0.01) {
    mismatch += 1;
    if (mismatchSample.length < 5) mismatchSample.push(r.key + '（表 ' + round(r.dig) + ' / 事件 ' + round(r.digByEvents) + '）');
  }
}
console.log('');
console.log('=== §0.1 自检：dig_delta 的 after vs 状态表 dig ===');
console.log('  已入途径 ' + main.filter((r) => r.sequence !== null).length + ' 人，不一致 ' + mismatch + ' 人' +
  (mismatchSample.length ? '（' + mismatchSample.join('、') + '）' : '（完全一致 —— 事件流可当 DIG 的权威轨迹）'));

/* ==================== §1 拆 +14 ==================== */
const mainS7 = seq7Of(main);
const even7 = mainS7.filter((r) => r.even);
const odd7 = mainS7.filter((r) => !r.even);

const e3Hit = even7.filter((r) => { const h = hoursOf8to7(r); return h !== null && h > OLD_WINDOW_H; });
const e3OverNew = even7.filter((r) => { const h = hoursOf8to7(r); return h !== null && h > NEW_WINDOW_H; });
const e3Loose = even7.filter((r) => [...r.rituals.values()].some((m) => m.successAt !== null && m.setupAt !== null && (m.successAt - m.setupAt) / HOUR > OLD_WINDOW_H));
const e2Pool = main.filter((r) => r.everReady && r.digPeak >= DIG_LOW && r.digPeak < DIG_HIGH);
const e2Hit = e2Pool.filter((r) => r.sequence !== null && r.sequence <= 7);
const e3 = e3Hit.length, e2 = e2Hit.length, e1 = plus - e3 - e2;

console.log('');
console.log('=== §1 拆 +' + plus + '（单批内对照）===');
console.log('| 项 | 人数 | 口径 |');
console.log('| --- | --- | --- |');
console.log('| **E3 贡献**（主口径） | **' + e3 + '** | ' + BATCH + ' 内、偶数号、最终 ≤7、**8→7 那次**仪式（ritual_success payload from=8 → to=7）的「发起→融合成功」> ' + round(OLD_WINDOW_H * 60, 0) + ' 分钟 |');
console.log('| E3 下界 | ' + e3OverNew.length + ' | 同上，但耗时 > ' + round(NEW_WINDOW_H, 0) + ' 小时（应 0 —— 窗口刚好兜住） |');
console.log('| E3 宽松口径（**不用**） | ' + e3Loose.length + ' | 任意一次仪式成功 > 30min（含 9→8）—— ' + (e3Loose.length > evenDelta ? '**超过偶数号增量 ' + evenDelta + '**，自相矛盾' : '未超过偶数号增量') + '，见 §2.1 |');
console.log('| **E2 贡献** | **' + e2 + '** | ' + BATCH + ' 内、曾经凑齐 8→7 主材料、DIG 峰值 ∈ [' + DIG_LOW + ', ' + DIG_HIGH + ')、最终 ≤7 |');
console.log('| **E1 贡献** | **' + e1 + '** | ' + plus + ' − E3 − E2（**余项**，见下） |');
console.log('');
console.log('结论：+' + plus + ' = E3 ' + e3 + ' + E2 ' + e2 + ' + E1 ' + e1 +
  (e3 + e2 + e1 === plus ? '（恰好闭合）' : '（**不闭合，缺口 ' + (plus - e3 - e2 - e1) + '**）'));
console.log('');
console.log('E3 口径的真正理由（**因果链**，不是数字大小）：');
console.log('  9→8 的仪式成功与「8→7 的增量」没有因果关系 —— 只有「救他过 8→7 的那一次」跨过的登录才贡献 +' + plus + '。');
console.log('  所以口径必须限定 from=8 → to=7；「任意一次 > 30min」那 ' + e3Loose.length + ' 人里有 ' + (e3Loose.length - e3) + ' 人属于这种错记。');
console.log('  （偶数号增量 ' + evenDelta + ' 是**跨 seed** 的差、含噪声，E3 ≤ 它只是启发式检查，不是自洽性证明。奇数号增量 ' + oddDelta + ' 与「偶数号里不依赖 E3 的增量」' + (evenDelta - e3) + ' 之差 ' + (oddDelta - (evenDelta - e3)) + ' 同样落在 ±5 人的噪声里。）');
console.log('');
console.log('对照侧（E3 的上界需要一个「被旧窗口掐死」的对照）：');
for (const entry of [[BASELINE, base], [BATCH, main]] as Array<[string, Rec[]]>) {
  const name = entry[0];
  if (!name) continue;
  const rr = name === BATCH ? MAIN.ritualResults : BASE.ritualResults;
  const tally = [...rr.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => k + '=' + n).join('、');
  console.log('  ' + name + '（窗口 ' + (name === OLD_WINDOW_BATCH ? round(OLD_WINDOW_H * 60, 0) + ' 分钟' : round(NEW_WINDOW_H, 0) + ' 小时') + '）rituals 终态：' + (tally || '（无）'));
}

/* ==================== §2 E3 明细 ==================== */
console.log('');
console.log('=== §2 E3 明细：偶数号 ≤7 逐人，8→7 是怎么过的（事件流口径）===');
console.log('| 片:id | 途径 | 末序列 | DIG | 仪式成功次数 | 8→7 路径 | 8→7 耗时(h) | 全部仪式成功耗时(h) | E3? |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of even7.slice().sort((a, b) => (hoursOf8to7(b) ?? -1) - (hoursOf8to7(a) ?? -1))) {
  const h87 = hoursOf8to7(r);
  const p87 = pathTo(r, 8, 7);
  const hours = [...r.rituals.values()].filter((m) => m.successAt !== null && m.setupAt !== null)
    .map((m) => (Number(m.successAt) - Number(m.setupAt)) / HOUR).sort((a, b) => a - b);
  const hit = h87 !== null && h87 > OLD_WINDOW_H;
  console.log('| ' + r.key + ' | ' + (r.pathway ?? '—') + ' | ' + r.sequence + ' | ' + round(r.dig, 1) + ' | ' +
    [...r.rituals.values()].filter((m) => m.successAt !== null).length + ' | ' + (p87 ? p87.reason : '（无）') + ' | ' +
    (h87 === null ? '—' : round(h87, 2)) + ' | ' + (hours.length ? hours.map((h) => round(h, 2)).join(', ') : '—') +
    ' | ' + (hit ? '**是**' : '否') + ' |');
}

console.log('');
console.log('=== §2.1 8→7 的路径分布（读 sequence_delta.reason）===');
const pathTally = new Map<string, number>();
for (const r of mainS7) {
  const p = pathTo(r, 8, 7);
  const key = p ? (p.reason.startsWith('仪式') ? '仪式' : p.reason.startsWith('晋升') ? '.晋升' : p.reason) : '（无 8→7 记录）';
  pathTally.set(key, (pathTally.get(key) ?? 0) + 1);
}
for (const entry of [...pathTally.entries()].sort((a, b) => b[1] - a[1])) console.log('  ' + entry[0].padEnd(14) + ' ' + entry[1] + ' 人');
console.log('  偶数号 ≤7 里走 .晋升 的：' + even7.filter((r) => (pathTo(r, 8, 7)?.reason ?? '').startsWith('晋升')).length + ' 人（应为 0 —— 偶数号走仪式）');
console.log('  奇数号 ≤7 里走仪式的：' + odd7.filter((r) => (pathTo(r, 8, 7)?.reason ?? '').startsWith('仪式')).length + ' 人（应为 0 —— 奇数号走 .晋升）');

/* ==================== §3 E2 复核 ==================== */
console.log('');
console.log('=== §3 E2 复核（曾经凑齐材料 + DIG 峰值 ∈ [80,85)）===');
const everMain = main.filter((r) => r.everReady);
console.log('  ' + BATCH + ' 全体：曾经凑齐 8→7 主材料 ' + everMain.length + ' 人（基线 ' + BASELINE + '：' + base.filter((r) => r.everReady).length + ' 人）');
console.log('  其中 DIG 峰值 ∈ [80,85)：**' + e2Pool.length + ' 人**（最终 ≤7 ' + e2Hit.length + ' 人 / 仍在序列 8 ' + e2Pool.filter((r) => r.sequence === 8).length + ' 人）');
for (const r of e2Pool) console.log('    ' + r.key + '（' + r.pathway + '）DIG 峰值 ' + round(r.digPeak, 2) + '，末 DIG ' + round(r.dig, 2) + '，末序列 ' + r.sequence);
console.log('');
console.log('  门槛口径核对（期末状态 + 期末持有量，与 m220 主表同一口径）：');
for (const entry of [[BASELINE, base], [BATCH, main]] as Array<[string, Rec[]]>) {
  const name = entry[0], rs = entry[1];
  if (!name || rs.length === 0) continue;
  const s8 = seq8Of(rs);
  console.log('    ' + name + '：序列 8 ' + s8.length + ' 人；末 DIG < 85 的 ' + s8.filter((r) => r.dig < DIG_HIGH).length +
      ' 人；末 DIG ∈ [80,85) 的 ' + s8.filter((r) => r.dig >= DIG_LOW && r.dig < DIG_HIGH).length + ' 人 ← 降门槛此刻能直接够着的');
}

console.log('');
console.log('=== §3.1 E2 的独立证据：已过线人群的末 DIG ===');
for (const entry of [[BASELINE, base], [BATCH, main]] as Array<[string, Rec[]]>) {
  const name = entry[0], rs = entry[1];
  if (!name || rs.length === 0) continue;
  const s7 = seq7Of(rs);
  for (const side of [['偶数号', true], ['奇数号', false]] as Array<[string, boolean]>) {
    const group = s7.filter((r) => r.even === side[1]);
    if (group.length === 0) continue;
    console.log('  ' + name + ' ' + side[0] + ' ≤7 ' + group.length + ' 人：末 DIG < 85 的 ' + group.filter((r) => r.dig < DIG_HIGH).length +
      ' 人 / < 80 的 ' + group.filter((r) => r.dig < DIG_LOW).length + ' 人 / 最小 ' + round(Math.min(...group.map((r) => r.dig)), 2));
  }
}
console.log('  → 门槛 85→80 只能帮到「DIG 停在 [' + DIG_LOW + ', ' + DIG_HIGH + ')」的人；过线人群里这样的人越少，E2 越接近 0。');

/* ==================== §4 仪式耗时分布 ==================== */
console.log('');
console.log('=== §4 仪式「发起→融合成功」耗时分布（事件流口径）===');
const buckets = [
  { label: '= 0（同一次登录内）', lo: -1e-9, hi: 1e-9 },
  { label: '(0, 30min]', lo: 1e-9, hi: 0.5 },
  { label: '(30min, 2h]', lo: 0.5, hi: 2 },
  { label: '(2h, 12h]', lo: 2, hi: 12 },
  { label: '> 12h', lo: 12, hi: Infinity },
];
const pairs = setupPairs(main);
console.log('  [' + BATCH + ' 全体，' + pairs.length + ' 条成功仪式]');
for (const b of buckets) {
  const n = pairs.filter((p) => p.hours > b.lo && p.hours <= b.hi).length;
  console.log('    ' + b.label.padEnd(22) + String(n).padStart(4) + ' 条' + (n ? '（' + pct(n, pairs.length) + '）' : ''));
}
const evenP = setupPairs(main.filter((r) => r.even));
const oddP = setupPairs(main.filter((r) => !r.even));
console.log('    偶数号 ' + evenP.length + ' 条 / 奇数号 ' + oddP.length + ' 条');
const hs = evenP.map((p) => p.hours).sort((a, b) => a - b);
if (hs.length) {
  const q = (x: number): string => round(hs[Math.min(hs.length - 1, Math.floor(hs.length * x))]!, 2);
  console.log('    偶数号耗时分位（h）：P25 ' + q(0.25) + ' / 中位 ' + q(0.5) + ' / P75 ' + q(0.75) + ' / 最大 ' + round(hs[hs.length - 1]!, 2));
}

/* ==================== §5 18 人分桶 ==================== */
const BATCH_END = MAIN.batchEnd;
console.log('');
console.log('=== §5 「曾经凑齐材料、仍在序列 8」的分桶 ===');
console.log('  期末时刻（本批最后一条 domain_events）= ' + new Date(BATCH_END).toISOString() + '（ms ' + BATCH_END + '）');
console.log('  分桶轴 = 「凑齐时刻（最后一种主材料到手）→ 期末」的小时差');

interface BucketRow { rec: Rec; gapH: number; bucket: string; ritualAfter: number; digOk: boolean }
const stalled = main.filter((r) => r.sequence === 8 && r.everReady && r.readyAt > 0);
const bucketOf = (gapH: number): string => (gapH < 1 ? '期末才凑齐(<1h)' : gapH <= 12 ? '窗口内(1-12h)' : '窗口外(>12h)');
const rows: BucketRow[] = stalled.map((r) => ({
  rec: r,
  gapH: (BATCH_END - r.readyAt) / HOUR,
  bucket: bucketOf((BATCH_END - r.readyAt) / HOUR),
  ritualAfter: [...r.rituals.values()].filter((m) => m.setupAt !== null && Number(m.setupAt) >= r.readyAt).length,
  digOk: r.dig >= DIG_LOW,
}));
for (const side of [['奇数号（走 .晋升，不受 ritual 影响）', false], ['偶数号（走 .仪式）', true]] as Array<[string, boolean]>) {
  const group = rows.filter((x) => x.rec.even === side[1]).sort((a, b) => a.gapH - b.gapH);
  console.log('');
  console.log('  [ ' + side[0] + ' ] 共 ' + group.length + ' 人');
  if (group.length === 0) continue;
  console.log('  | 片:id | 途径 | 末 DIG | DIG≥' + DIG_LOW + ' | 距期末(h) | 桶 | 期末料还齐 | 凑齐后发起仪式 | 凑齐后 **8→7** 的 .晋升判定 |');
  console.log('  | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const x of group) {
    // 只认 8→7 的判定（payload.from = 8）：9→8 的失败不能拿来解释「他为什么停在 8」
    const promo87 = x.rec.promotionTries.filter((t) => t.from === 8 && t.at >= x.rec.readyAt);
    console.log('  | ' + x.rec.key + ' | ' + (x.rec.pathway ?? '—') + ' | ' + round(x.rec.dig, 1) + ' | ' + (x.digOk ? '是' : '**否**') +
      ' | ' + round(x.gapH, 2) + ' | ' + x.bucket + ' | ' + (x.rec.holdingNow ? '齐' : '**不齐**') +
      ' | ' + x.ritualAfter + ' 次 | ' + promo87.length + ' 次' + (promo87.some((t) => t.ok) ? '（有成功）' : '') + ' |');
  }
  const byBucket = new Map<string, number>();
  for (const x of group) byBucket.set(x.bucket, (byBucket.get(x.bucket) ?? 0) + 1);
  console.log('  分桶：' + ['期末才凑齐(<1h)', '窗口内(1-12h)', '窗口外(>12h)'].map((b) => b + ' ' + (byBucket.get(b) ?? 0)).join(' / '));
  console.log('  DIG ≥ ' + DIG_LOW + ' 的 ' + group.filter((x) => x.digOk).length + ' 人 / DIG < ' + DIG_LOW + ' 的 ' + group.filter((x) => !x.digOk).length + ' 人');
  for (const b of ['期末才凑齐(<1h)', '窗口内(1-12h)', '窗口外(>12h)']) {
    const sub = group.filter((x) => x.bucket === b);
    if (sub.length === 0) continue;
    const promoAfter = (x: BucketRow): number => x.rec.promotionTries.filter((t) => t.from === 8 && t.at >= x.rec.readyAt).length;
    console.log('    ' + b + ' 内：DIG 达标 ' + sub.filter((x) => x.digOk).length + ' 人（凑齐后发起过仪式 ' + sub.filter((x) => x.ritualAfter > 0).length +
      ' 人、凑齐后判过 8→7 的 .晋升 ' + sub.filter((x) => promoAfter(x) > 0).length + ' 人）/ DIG 不达标 ' + sub.filter((x) => !x.digOk).length + ' 人');
  }
}
console.log('');
console.log('  口径：桶看的是「凑齐之后还剩多少时间」，不是「他为什么没升」——');
console.log('  「窗口外(>12h)」= 时间充裕却没升 ⇒ 卡点不在时间；「期末才凑齐」= 根本没机会动手。');

/* ==================== §5.1 8→7 判定的成功率明细 ==================== */
console.log('');
console.log('=== §5.1 「曾经凑齐 + 仍在序列 8」的人，8→7 的 .晋升 判定逐次明细 ===');
console.log('  （chance / roll 直接取自 promotion_fail|success 的 payload，**不重算**）');
const everStalled = main.filter((r) => r.sequence === 8 && r.everReady && r.readyAt > 0);
let anyDetail = false;
for (const r of everStalled) {
  const tries = r.promotionTries.filter((t) => t.from === 8 && t.at >= r.readyAt);
  if (tries.length === 0) continue;
  anyDetail = true;
  const allFail = tries.every((t) => !t.ok);
  let survive = 1;
  for (const t of tries) if (!t.ok) survive *= 1 - t.chance;
  console.log('  ' + r.key + '（' + (r.pathway ?? '—') + '，末 DIG ' + round(r.dig, 1) + '、末 MAD ' + round(r.mad, 1) + '、末 COR ' + round(r.cor, 1) + '）：判 ' + tries.length + ' 次，' +
    (allFail ? '**全部失败**' : '有成功') + '；这串全败的概率 = ' + survive.toExponential(2));
  for (const t of tries) {
    console.log('      ' + new Date(t.at).toISOString().slice(0, 16) + '  成功率 ' + (t.chance * 100).toFixed(1) + '%' +
      '（连败保护 ' + (t.failBonus * 100).toFixed(0) + '%）　抽样 ' + t.roll.toFixed(3) + '　→ ' + (t.ok ? '成功' : '失败') +
      '　失败累计 ' + t.failsAfter);
  }
}
if (!anyDetail) console.log('  （没有人在凑齐之后判过 8→7）');
console.log('');
console.log('  读法：成功率是**当时的实际值**（含 MAD/COR 惩罚与连败保护）——');
console.log('  若「5 连败」这类串在单次成功率 80%+ 的量级下发生，那就不是运气，是判定层还有别的项没进 DIG（铁律 8 同型）。');
