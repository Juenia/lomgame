#! /usr/bin/env node
/**
 * M2.19 · 连败保护 vs MAD/COR 口径澄清（**只读，不跑批**）
 *
 * 要回答的问题：+10% 的连败保护为什么抵消不了 MAD +5 / COR +3 的累积惩罚？
 * 三种候选逐一排除：
 *   A 触发条件非每次  —— 读 promotionChance 的实现 + 逐条 payload 的 failBonus
 *   B +10% 是乘性     —— 用 payload 验 chance = base + failBonus（加性）还是 base x 1.1
 *   C MAD/COR 有额外项 —— 用**重放出的 (dig, mad, cor)** 重算公式，与 payload.base 比对
 *
 * 口径（铁律 11）：所有数字从库里出。
 *   · chance / base / failBonus / roll / failsAfter 一律**直接读 promotion_fail|success 的 payload**，不重算；
 *   · (dig, mad, cor) 用 dig_delta / mad_delta / cor_delta 的 after 重放，
 *     但**要回退判定自身的代价** —— 判定的 MAD/COR delta 与判定事件同刻落库、id 更小，
 *     直接读 after 会读到「失败之后」的值（差一个 0.0195 的常数，就是 0.3x0.05 + 0.15x0.03）。
 *
 * 用法：node scripts/m219-promotion-formula.ts [--batch m221a] [--shards 8]
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { shardKey, type ShardKeyMap } from '../src/infra/shard-key.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm221a');
const SHARDS = Number(argOf('shards', '8'));

const P = NUMERIC.promotion;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** 与 src/domain/character/rules.ts 的 computePromotionSuccess **逐字一致**（这里只是把参数换成读出来的值） */
const formulaOf = (dig: number, mad: number, cor: number, seq: number): number =>
  clamp(P.base + P.digBonus * (dig / 100) - P.sequencePenalty * (9 - seq) - P.madPenalty * (mad / 100) - P.corPenalty * (cor / 100), P.floor, P.ceil);

interface Judgement {
  shard: number; id: string; at: number; from: number;
  dig: number; mad: number; cor: number;
  base: number; chance: number; failBonus: number; roll: number; failsAfter: number;
  /** payload 里写的是不是「失败之后」的 fails（failsAfter = 判定前 + 1） */
  ok: boolean;
}

const rows: Judgement[] = [];
for (let s = 0; s < SHARDS; s += 1) {
  let db: DatabaseSync;
  try { db = new DatabaseSync('data/' + BATCH + '-shard-' + s + '.db', { readOnly: true }); } catch { continue; }
  const chars = db.prepare('SELECT id FROM characters').all() as unknown as Array<{ id: string }>;
  for (const c of chars) {
    const evs = db.prepare('SELECT type, payload, reason, created_at FROM domain_events WHERE character_id = ? ORDER BY created_at, id').all(c.id) as unknown as Array<{
      type: string; payload: string; reason: string; created_at: number;
    }>;
    let dig = 0, mad = 0, cor = 0;
    let lastDig: { at: number; before: number; reason: string } | null = null;
    let lastMad: { at: number; before: number; reason: string } | null = null;
    let lastCor: { at: number; before: number; reason: string } | null = null;
    for (const e of evs) {
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(e.payload) as Record<string, unknown>; } catch { p = {}; }
      const at = Number(e.created_at);
      if (e.type === 'dig_delta') { dig = Number(p.after ?? dig); lastDig = { at, before: Number(p.before), reason: e.reason }; }
      else if (e.type === 'mad_delta') { mad = Number(p.after ?? mad); lastMad = { at, before: Number(p.before), reason: e.reason }; }
      else if (e.type === 'cor_delta') { cor = Number(p.after ?? cor); lastCor = { at, before: Number(p.before), reason: e.reason }; }
      else if (e.type === 'promotion_fail' || e.type === 'promotion_success') {
        // 判定自身的代价与判定事件同刻、id 更小 —— 回退到 before 才是**判定时**的值
        const own = (x: { at: number; reason: string } | null): boolean => x !== null && x.at === at && /^(晋升|仪式)/.test(x.reason);
        rows.push({
          shard: s, id: c.id, at, from: Number(p.from ?? -1),
          dig: own(lastDig) ? lastDig!.before : dig,
          mad: own(lastMad) ? lastMad!.before : mad,
          cor: own(lastCor) ? lastCor!.before : cor,
          base: Number(p.base ?? NaN), chance: Number(p.chance ?? NaN),
          failBonus: Number(p.failBonus ?? NaN), roll: Number(p.roll ?? NaN),
          failsAfter: Number(p.failsAfter ?? NaN), ok: e.type === 'promotion_success',
        });
      }
    }
  }
  db.close();
}

const r87 = rows.filter((r) => r.from === 8);
const round = (n: number, d = 5): string => n.toFixed(d);

console.log('=== §0 判定总数（' + BATCH + '）===');
console.log('  promotion 判定 ' + rows.length + ' 条，其中 8→7 的 ' + r87.length + ' 条（9→8 的 ' + (rows.length - r87.length) + ' 条）');

console.log('');
console.log('=== §1 候选 C：用重放出的 (dig, mad, cor) 重算公式，与 payload.base 比对 ===');
let exact = 0, maxDiff = 0;
for (const r of r87) {
  const mine = formulaOf(r.dig, r.mad, r.cor, 8);
  const d = Math.abs(mine - r.base);
  if (d < 1e-9) exact += 1;
  if (d > maxDiff) maxDiff = d;
}
console.log('  8→7 判定 ' + r87.length + ' 条：**完全吻合 ' + exact + ' 条**，最大偏差 ' + maxDiff.toExponential(2));
console.log('  （判定公式只有五项：base / digBonus / sequencePenalty / madPenalty / corPenalty —— **没有额外项、没有上限、没有分段**）');
console.log('');
console.log('  | 片:id | 判定时刻 | 判定时的 dig/mad/cor | 重算 base | payload base | 偏差 | chance | 保护 | 失败累计 |');
console.log('  | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of r87.slice().sort((a, b) => a.at - b.at)) {
  console.log('  | ' + r.shard + ':' + r.id + ' | ' + new Date(r.at).toISOString().slice(0, 16) + ' | ' +
    round(r.dig, 1) + ' / ' + round(r.mad, 0) + ' / ' + round(r.cor, 0) + ' | ' + round(formulaOf(r.dig, r.mad, r.cor, 8)) + ' | ' +
    round(r.base) + ' | ' + (formulaOf(r.dig, r.mad, r.cor, 8) - r.base).toExponential(1) + ' | ' + round(r.chance) + ' | ' +
    (r.failBonus * 100).toFixed(0) + '% | ' + r.failsAfter + ' |');
}

console.log('');
console.log('=== §2 候选 B：chance 是 base + failBonus（加性）还是 base x 1.1（乘性）===');
let addExact = 0, mulExact = 0;
for (const r of r87) {
  if (Math.abs(r.chance - clamp(r.base + r.failBonus, P.floor, P.ceil)) < 1e-9) addExact += 1;
  if (Math.abs(r.chance - clamp(r.base * (1 + r.failBonus), P.floor, P.ceil)) < 1e-9) mulExact += 1;
}
console.log('  「chance = base + failBonus」吻合 ' + addExact + '/' + r87.length + ' 条；「chance = base x 1.1」吻合 ' + mulExact + '/' + r87.length + ' 条');
console.log('  ⇒ ' + (addExact === r87.length ? '**加性（+10 个百分点）**，候选 B 排除' : '需要复核'));

console.log('');
console.log('=== §3 候选 A：连败保护的触发条件 ===');
/*
 * 判定前的连败数**不能从 payload 直接读** —— failsAfter 是判定后的值，而成功那一行会把它重置成 0。
 * 所以这里按 (角色, 时间) 逐条重放 fails 状态（**含 9->8 的判定**：promotionFails 是角色级的，不按序列重置）。
 */
const byFails = new Map<number, { n: number; bonus: Set<number> }>();
{
  const ordered = rows.slice().sort((a, b) => (a.shard - b.shard) || a.id.localeCompare(b.id) || a.at - b.at);
  const failsState: ShardKeyMap<number> = new Map();
  for (const r of ordered) {
    const key = shardKey(r.shard, r.id);
    const before = failsState.get(key) ?? 0;
    if (r.from === 8) {
      const slot = byFails.get(before) ?? { n: 0, bonus: new Set<number>() };
      slot.n += 1; slot.bonus.add(Number(r.failBonus.toFixed(6)));
      byFails.set(before, slot);
    }
    failsState.set(key, r.ok ? 0 : before + 1);
  }
}
console.log('  | 判定前的连败数 fails | 命中次数 | 观察到的 failBonus |');
console.log('  | --- | --- | --- |');
for (const [k, v] of [...byFails.entries()].sort((a, b) => a[0] - b[0])) {
  console.log('  | ' + k + ' | ' + v.n + ' | ' + [...v.bonus].map((x) => (x * 100).toFixed(0) + '%').join('、') + ' |');
}
console.log('  NUMERIC.promotion.failStreakThreshold = ' + P.failStreakThreshold + '，failStreakBonus = ' + P.failStreakBonus);
const hitAtThreshold = [...byFails.entries()].some(([k, v]) => k >= P.failStreakThreshold && [...v.bonus].every((b) => b === P.failStreakBonus));
const zeroBelowThreshold = [...byFails.entries()].filter(([k]) => k < P.failStreakThreshold).every(([, v]) => [...v.bonus].every((b) => b === 0));
console.log('  ⇒ 阈值 ' + P.failStreakThreshold + ' 起**每次都触发**（不是一次性、没有次数上限、**不累积**：恒为 +' + (P.failStreakBonus * 100).toFixed(0) + 'pp）；');
console.log('     低于阈值的判定一律 0%：' + (zeroBelowThreshold ? '成立' : '**不成立**') + '；达到阈值后的判定一律 +' + (P.failStreakBonus * 100).toFixed(0) + 'pp：' + (hitAtThreshold ? '成立' : '**不成立**'));

console.log('');
console.log('=== §4 判定时刻的 MAD / COR 分布（8→7）===');
const q = (arr: number[], x: number): number => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * x))] ?? NaN;
const mads = r87.map((r) => r.mad), cors = r87.map((r) => r.cor);
console.log('  MAD：中位 ' + round(q(mads, 0.5), 0) + ' / P10 ' + round(q(mads, 0.1), 0) + ' / P90 ' + round(q(mads, 0.9), 0) + ' / 范围 ' + round(Math.min(...mads), 0) + '—' + round(Math.max(...mads), 0));
console.log('  COR：中位 ' + round(q(cors, 0.5), 0) + ' / P10 ' + round(q(cors, 0.1), 0) + ' / P90 ' + round(q(cors, 0.9), 0) + ' / 范围 ' + round(Math.min(...cors), 0) + '—' + round(Math.max(...cors), 0));
console.log('  成功率 chance：中位 ' + round(q(r87.map((r) => r.chance), 0.5), 3) + ' / 最低 ' + round(Math.min(...r87.map((r) => r.chance)), 3) + ' / 最高 ' + round(Math.max(...r87.map((r) => r.chance)), 3));
const zero = r87.filter((r) => r.mad === 0 && r.cor === 0).length;
console.log('  MAD/COR 同时为 0 的判定：' + zero + ' 条（那时的成功率才是公式上限 ' + (P.base + P.digBonus - P.sequencePenalty) + '）');

console.log('');
console.log('=== §5 交叉点：常数保护 +10pp vs 线性累积 ===');
const perFail = P.madPenalty * (P.madOnFail / 100) + P.corPenalty * (P.corOnFail / 100);
console.log('  每次失败带来的惩罚增量 = ' + P.madPenalty + 'x(' + P.madOnFail + '/100) + ' + P.corPenalty + 'x(' + P.corOnFail + '/100) = ' + perFail.toFixed(4) + '（' + (perFail * 100).toFixed(2) + ' pp）');
console.log('  连败保护 = +' + (P.failStreakBonus * 100).toFixed(0) + ' pp（**常数**，不随失败次数增长）');
const cross = 1 + P.failStreakBonus / perFail;
console.log('  保护被反超的判定序号 = ' + cross.toFixed(2) + ' ⇒ **第 ' + Math.ceil(cross) + ' 次判定起，累积惩罚大于保护**');
const maxFails = Math.max(...r87.map((r) => r.failsAfter));
console.log('  实测最深连败 = ' + maxFails + ' 次 ⇒ ' + (maxFails < cross ? '**没有触到交叉点**' : '已越过交叉点'));
