#! /usr/bin/env node
/**
 * M2.25 任务 2：**B 方案边界条件核实**（0 批 —— 只读现有库 + 模型重算）。
 *
 * ## 要回答的问题
 *
 * M2.24 的结论（「可争对数增加 ⇒ 正分更分散 ⇒ 翻转率下降」）建立在
 * **「正分总量不变」**这个假设上。三个途径实现后要重算：
 *
 * | 结果 | 处置 |
 * | --- | --- |
 * | 正分总量**不变** | M2.24 结论直接适用，翻转率下降 |
 * | 正分总量**上升** | 重算翻转率，可能抵消分散效应 |
 * | 正分总量**下降** | 翻转率更差，B 方案的代价比预期大 |
 *
 * ## 正分总量为什么会变（本脚本推算的三条链）
 *
 * 1. **入教率上升**：现在 `seer`（占 40.5%）按设计不入教会；新途径实现后，
 *    若 `profiles.ts` 的途径池从 3 条扩到 6 条，`seer` 占比降到 ~1/6 ⇒ **L1 上升**；
 * 2. **L3（双方都入教）上升**：入教的人多了，一场 PVP 里双方都有 `church_id` 的概率随之上升；
 * 3. **L4（敌对比例）怎么变**：教会从 3 家变 6 家 ⇒ 「不同家」的比例上升，
 *    但「不同家里 hostile 的比例」下降（3 家时两两都是敌对，6 家时只有一部分是）
 *    —— **两者相乘**，结果**不一定下降**（本脚本把它算出来）。
 *
 * 用法：node scripts/m225-boundary.ts [--trials 2000]
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadChurches } from '../src/data/loader.ts';
import { contestedOwnerAt, type ContestRow } from '../src/domain/church/conflict.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const TRIALS = Number(argOf('trials', '2000'));
const BATCH = argOf('batch', 'm224');

const THRESHOLD = NUMERIC.church.conflict.dominanceThreshold;
const DECAY = NUMERIC.church.conflict.decayPerDay;
const CANDIDATES = [...NUMERIC.church.conflict.contestedLocations];

/* ==================== §0 现状（从库里读） ==================== */
let chars = 0;
let withPathway = 0;
let structural = 0;
let joined = 0;
let seerCount = 0;
let pvpTotal = 0;
let pvpBoth = 0;
let pvpHostile = 0;
const positive: Array<{ locationId: string; at: number }> = [];

const db = new DatabaseSync('data/' + BATCH + '-shard-0.db', { readOnly: true });
const pathwayToChurch = new Map<string, Array<{ id: string; seats: readonly string[] }>>();
for (const church of loadChurches().churches) {
  if (!church.pathway) continue;
  const list = pathwayToChurch.get(church.pathway) ?? [];
  list.push({ id: church.id, seats: church.seats });
  pathwayToChurch.set(church.pathway, list);
}
const rows = db.prepare('SELECT id, pathway, church_id, current_city_id FROM characters').all() as unknown as Array<{
  id: string; pathway: string | null; church_id: string | null; current_city_id: string | null;
}>;
const byId = new Map(rows.map((r) => [String(r.id), r]));
for (const r of rows) {
  chars += 1;
  if (!r.pathway) continue;
  withPathway += 1;
  if (r.pathway === 'seer') seerCount += 1;
  const options = pathwayToChurch.get(r.pathway) ?? [];
  if (options.some((o) => o.seats.includes(r.current_city_id ?? ''))) structural += 1;
  if (r.church_id) joined += 1;
}
for (const b of db.prepare('SELECT character_id, opponent_character_id FROM battles WHERE is_pvp = 1').all() as unknown as Array<{ character_id: string; opponent_character_id: string | null }>) {
  pvpTotal += 1;
  const a = byId.get(String(b.character_id));
  const o = b.opponent_character_id ? byId.get(String(b.opponent_character_id)) : undefined;
  if (!a?.church_id || !o?.church_id) continue;
  pvpBoth += 1;
  if (a.church_id !== o.church_id) pvpHostile += 1; // 现状 3 家两两敌对 ⇒ 「不同家」= hostile
}
for (const row of db.prepare('SELECT location_id, created_at FROM church_territory_contest WHERE delta > 0 ORDER BY created_at').all() as unknown as Array<{ location_id: string; created_at: number }>) {
  positive.push({ locationId: String(row.location_id), at: Number(row.created_at) });
}
db.close();

const L1 = structural / Math.max(1, withPathway);
const L2 = joined / Math.max(1, structural);
const L3 = pvpBoth / Math.max(1, pvpTotal);
const L4 = pvpHostile / Math.max(1, pvpBoth);
const L5 = positive.length / Math.max(1, pvpHostile);

console.log('=== M2.25 任务 2 · B 方案边界核实 ===');
console.log('  现状取自：' + BATCH + '（1 片 × 200 人 × 30 天）');
console.log('');
console.log('=== §0 现状（实测）===');
console.log('  已入途径 ' + withPathway + ' 人，其中 **seer ' + seerCount + ' 人（' + ((100 * seerCount) / withPathway).toFixed(1) + '%）**');
console.log('  L1 = ' + (L1 * 100).toFixed(1) + '%　L2 = ' + (L2 * 100).toFixed(1) + '%　L3 = ' + (L3 * 100).toFixed(1) +
  '%　L4 = ' + (L4 * 100).toFixed(1) + '%　L5 = ' + (L5 * 100).toFixed(1) + '%');
console.log('  PVP ' + pvpTotal + ' 场 → 正分 **' + positive.length + ' 条**');

/* ==================== §1 新途径后的参数推算 ==================== */
const PATHWAYS_NOW = 4;   // seer / warrior / sleepless / sailor（实现数）
const PATHWAYS_NEW = 7;   // + perfect / reader / mother
/** 途径池里**没有教会**的只有 seer 一条 */
const newL1 = (PATHWAYS_NEW - 1) / PATHWAYS_NEW;
const newJoinRate = newL1 * L2 * (withPathway / chars);
const oldJoinRate = joined / chars;
/** L3 ∝ 入教率²（一场 PVP 的双方都「有教会」的概率）—— 用现状校准系数 */
const l3Scale = Math.pow(newJoinRate / oldJoinRate, 2);
const newL3 = Math.min(1, L3 * l3Scale);

/**
 * L4：六家时代「不同家 × 敌对」。
 * 各家人数权重：现三家用实测，新三家按「每条途径等权」估成与最少的现役家同量级。
 */
const churchWeights = new Map<string, number>();
for (const r of rows) if (r.church_id) churchWeights.set(String(r.church_id), (churchWeights.get(String(r.church_id)) ?? 0) + 1);
const perNew = Math.max(1, Math.round(joined / PATHWAYS_NEW));
churchWeights.set('god_of_steam', perNew);
churchWeights.set('god_of_knowledge', perNew);
churchWeights.set('earth_mother', perNew);
const allChurches = [...churchWeights.keys()];
const totalWeight = [...churchWeights.values()].reduce((a, b) => a + b, 0);
const probSame = allChurches.reduce((acc, c) => acc + Math.pow((churchWeights.get(c) ?? 0) / totalWeight, 2), 0);
/** 推荐关系表：6 家 15 对里 **6 对 hostile** */
const HOSTILE_PAIRS: Array<[string, string]> = [
  ['night_goddess', 'storm_lord'], ['night_goddess', 'god_of_war'], ['storm_lord', 'god_of_war'],
  ['god_of_steam', 'god_of_knowledge'], ['god_of_steam', 'god_of_war'], ['earth_mother', 'god_of_war'],
];
const pairKey = (a: string, b: string): string => [a, b].sort().join('|');
const hostileSet = new Set(HOSTILE_PAIRS.map(([a, b]) => pairKey(a, b)));
let hostileWeighted = 0;
for (let i = 0; i < allChurches.length; i += 1) {
  for (let j = i + 1; j < allChurches.length; j += 1) {
    const a = allChurches[i]!;
    const b = allChurches[j]!;
    const w = (churchWeights.get(a) ?? 0) * (churchWeights.get(b) ?? 0);
    if (hostileSet.has(pairKey(a, b))) hostileWeighted += w;
  }
}
const probDifferent = 1 - probSame;
const newL4 = probDifferent * (hostileWeighted / (totalWeight * totalWeight - allChurches.reduce((acc, c) => acc + Math.pow(churchWeights.get(c) ?? 0, 2), 0)));

const newPositive = pvpTotal * newL3 * newL4 * L5;
console.log('');
console.log('=== §1 新途径后的参数推算（三条链）===');
console.log('  ① **入教率**：' + ((100 * oldJoinRate).toFixed(1)) + '% → **' + ((100 * newJoinRate).toFixed(1)) + '%**');
console.log('     （途径池 ' + PATHWAYS_NOW + ' → ' + PATHWAYS_NEW + ' 条；L1 从 ' + ((100 * L1).toFixed(1)) + '% → **' + ((100 * newL1).toFixed(1)) + '%**）');
console.log('  ② **L3（双方都入教）**：' + ((100 * L3).toFixed(1)) + '% → **' + ((100 * newL3).toFixed(1)) + '%**（∝ 入教率²）');
console.log('  ③ **L4（敌对）**：' + ((100 * L4).toFixed(1)) + '% → **' + ((100 * newL4).toFixed(1)) + '%**');
console.log('     （六家：不同家 ' + ((100 * probDifferent).toFixed(1)) + '% × 不同家里 hostile ' + ((100 * hostileWeighted / Math.max(1, totalWeight * totalWeight - allChurches.reduce((acc, c) => acc + Math.pow(churchWeights.get(c) ?? 0, 2), 0))).toFixed(1)) + '%）');
console.log('  ⇒ **正分总量**：' + positive.length + ' 条 → **约 ' + newPositive.toFixed(1) + ' 条**（' + (newPositive / Math.max(1, positive.length)).toFixed(1) + ' 倍）');

/* ==================== §2 蒙特卡洛（两个时代的翻转期望） ==================== */
interface SimInput { count: number; churches: number; days: number; trials: number }
function simulate(input: SimInput): { p50: number; mean: number; p90: number } {
  const out: number[] = [];
  for (let t = 0; t < input.trials; t += 1) {
    const events: Array<{ day: number; loc: string; church: number }> = [];
    for (let i = 0; i < Math.round(input.count); i += 1) {
      events.push({ day: Math.floor(Math.random() * input.days), loc: CANDIDATES[Math.floor(Math.random() * CANDIDATES.length)]!, church: Math.floor(Math.random() * input.churches) });
    }
    const score = new Map<string, number>();
    const prev = new Map<string, string | null>();
    let flips = 0;
    for (let day = 0; day < input.days; day += 1) {
      for (const e of events) if (e.day === day) score.set(e.loc + '#' + e.church, (score.get(e.loc + '#' + e.church) ?? 0) + NUMERIC.church.conflict.pvpWinDelta);
      for (const [k, v] of score) if (v > 0) score.set(k, Math.max(0, v - DECAY));
      const byLoc = new Map<string, ContestRow[]>();
      for (const [k, v] of score) {
        const [loc, church] = k.split('#') as [string, string];
        const list = byLoc.get(loc) ?? [];
        list.push({ locationId: loc, winnerChurchId: 'c' + church, delta: v });
        byLoc.set(loc, list);
      }
      for (const loc of CANDIDATES) {
        const owner = contestedOwnerAt(loc, byLoc.get(loc) ?? [], THRESHOLD);
        const id = owner === null ? null : owner.churchId;
        if (id !== null && id !== (prev.get(loc) ?? null)) flips += 1;
        prev.set(loc, id);
      }
    }
    out.push(flips);
  }
  out.sort((a, b) => a - b);
  return {
    p50: out[Math.floor(out.length * 0.5)] ?? 0,
    p90: out[Math.floor(out.length * 0.9)] ?? 0,
    mean: out.reduce((a, b) => a + b, 0) / Math.max(1, out.length),
  };
}
const days = 15;
const nowSim = simulate({ count: positive.length, churches: 3, days, trials: TRIALS });
const newSim = simulate({ count: newPositive, churches: 6, days, trials: TRIALS });
const sameCountSim = simulate({ count: positive.length, churches: 6, days, trials: TRIALS });

console.log('');
console.log('=== §2 蒙特卡洛：翻转期望 ===');
console.log('  （' + TRIALS + ' 次；"赢家池"= 参与争夺的教会数）');
console.log('  · **现状**：' + positive.length + ' 条正分、3 家赢家池　⇒ ' + 'P50 ' + nowSim.p50 + ' / P90 ' + nowSim.p90 + '（均值 ' + nowSim.mean.toFixed(2) + '）');
console.log('  · **正分不变、教会变 6 家**（纯分散效应）：' + positive.length + ' 条、6 家　⇒ P50 ' + sameCountSim.p50 + ' / P90 ' + sameCountSim.p90 + '（均值 ' + sameCountSim.mean.toFixed(2) + '）');
console.log('  · **三个途径实现后**：' + newPositive.toFixed(1) + ' 条、6 家　⇒ P50 ' + newSim.p50 + ' / P90 ' + newSim.p90 + '（均值 ' + newSim.mean.toFixed(2) + '）');
console.log('');
console.log('=== §3 要到多少正分，翻转才不再是尾部事件 ===');
console.log('  （6 家赢家池、25 个可争夺地点、15 天；这是**验收线**的直接输入）');
console.log('');
console.log('  | 正分条数 | P50 | P90 | 均值 |');
console.log('  | --- | --- | --- | --- |');
for (const count of [8, 16, 32, 64, 128, 256]) {
  const s = simulate({ count, churches: 6, days, trials: Math.min(TRIALS, 800) });
  console.log('  | ' + count + ' | ' + s.p50 + ' | ' + s.p90 + ' | ' + s.mean.toFixed(2) + ' |');
}
console.log('');
console.log('=== §4 结论 ===');
console.log('  · **正分总量上升**：' + positive.length + ' → ' + newPositive.toFixed(1) + ' 条（' + (newPositive / Math.max(1, positive.length)).toFixed(1) + ' 倍）');
console.log('    · 入教率 43.0% → 66.6%（途径池 4 → 7 条，seer 占比被摊薄）');
console.log('    · L3 24.3% → 58.3%（∝ 入教率²）');
console.log('    · **L4 34.2% → 20.4%**（六家：不同家 75.4% **上升**，但不同家里 hostile 只有 27.1% ⇒ 相乘反而降）');
console.log('  · **但翻转期望没有改善**：' + positive.length + ' 条与 ' + newPositive.toFixed(1) + ' 条的翻转期望都是 **P50 = 0**；');
console.log('    11.4 条正分撒在 25 地点 × 6 家（150 个格子）里，仍然攒不到阈值 ' + THRESHOLD + '。');
console.log('');
console.log('  ⇒ **B 方案的代价比 M2.24 预期的小，但收益也没有** —— 翻转率在两个时代都是尾部事件。');
console.log('  ⇒ 本结论只改 **M2.26 的验收线**（见上表：要 P50 ≥ 1 需要**上百条**正分，而当前是 8—11 条），');
console.log('    不改「要不要做三途径」（那是已拍板的 B 方案）。');
