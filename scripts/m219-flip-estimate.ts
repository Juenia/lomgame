#! /usr/bin/env node
/**
 * M2.19 · 翻转上界估算（**只读既有跑批产物**，不跑新批）
 *
 * M2.18 B 的跑批翻转 0，但「为什么是 0」与「换 3 对教会会是多少」没有基数。
 * 本脚本从 church_territory_contest 的现成增量行里把那个基数算出来。
 *
 * ## 判据（与 src/domain/church/conflict.ts 的口径一致）
 * 一个地点要翻转，需要它对某家教会的**净分**在某一刻达到阈值：
 *
 *     净分(窗口) = 窗口内的正分之和 − 窗口跨越的天数 × decayPerDay
 *     翻转条件   = max over 窗口 of 净分 >= dominanceThreshold
 *
 * 阈值与衰减**都从 NUMERIC 读**（M2.18 B 的「阈值 5 / 衰减 1」是历史值，
 * 建议 1+3 已落地 —— 现在实际是 2 / 0.3；照文档抄旧值会算出完全不同的结论）。
 *
 * 所以破坏翻转的不是「分不够」，而是「分分得太散」—— 这是 M2.18 文档没写到的那一层。
 *
 * 用法：node scripts/m219-flip-estimate.ts [--batch m220a] [--shards 8] [--pair 3]
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm220a');
const SHARDS = Number(argOf('shards', '8'));
const PAIRS_NOW = Number(argOf('pairNow', '1'));
const PAIRS_NEXT = Number(argOf('pair', '3'));
const DAY = 86400000;
const THRESHOLD = NUMERIC.church.conflict.dominanceThreshold;
const DECAY = NUMERIC.church.conflict.decayPerDay;

interface Win { locationId: string; at: number; delta: number }
const wins: Win[] = [];
for (let s = 0; s < SHARDS; s += 1) {
  let db: DatabaseSync;
  try { db = new DatabaseSync('data/' + BATCH + '-shard-' + s + '.db', { readOnly: true }); } catch { continue; }
  const rows = db.prepare('SELECT location_id, delta, created_at FROM church_territory_contest ORDER BY created_at').all() as unknown as Array<{
    location_id: string; delta: number; created_at: number;
  }>;
  for (const r of rows) {
    if (Number(r.delta) > 0) wins.push({ locationId: String(r.location_id), at: Number(r.created_at), delta: Number(r.delta) });
  }
  db.close();
}
wins.sort((a, b) => a.at - b.at);

const groupBy = (list: Win[]): Map<string, Win[]> => {
  const map = new Map<string, Win[]>();
  for (const w of list) {
    const arr = map.get(w.locationId);
    if (arr) arr.push(w); else map.set(w.locationId, [w]);
  }
  return map;
};

/** 最大净分：穷举窗口 [i, j]（净分 = 窗口内正分 − 窗口天数 × 衰减） */
function bestNetScore(list: Win[]): { net: number; gained: number; days: number } {
  let best = { net: -Infinity, gained: 0, days: 0 };
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i; j < list.length; j += 1) {
      let gained = 0;
      for (let k = i; k <= j; k += 1) gained += list[k]!.delta;
      const days = Math.floor((list[j]!.at - list[i]!.at) / DAY) + 1;
      const net = gained - days * DECAY;
      if (net > best.net) best = { net, gained, days };
    }
  }
  return best;
}

const show = (list: Win[], label: string): number => {
  const byLoc = groupBy(list);
  console.log('  | 地点 | 胜利次数 | 总正分 | 跨度(天) | 最佳窗口净分 | 够不够翻转 |');
  console.log('  | --- | --- | --- | --- | --- | --- |');
  let flips = 0;
  for (const [loc, arr] of [...byLoc.entries()].sort((a, b) => bestNetScore(b[1]).net - bestNetScore(a[1]).net)) {
    const best = bestNetScore(arr);
    const gained = arr.reduce((n, w) => n + w.delta, 0);
    const spanDays = Math.floor((arr[arr.length - 1]!.at - arr[0]!.at) / DAY) + 1;
    const hit = best.net >= THRESHOLD;
    if (hit) flips += 1;
    console.log('  | ' + loc + ' | ' + arr.length + ' | ' + gained + ' | ' + spanDays + ' | **' + best.net.toFixed(2) + '** | ' +
      (hit ? '**是**' : '否（差 ' + (THRESHOLD - best.net).toFixed(2) + '）') + ' |');
  }
  console.log('  ⇒ ' + label + '：翻转 **' + flips + ' 次**（阈值 ' + THRESHOLD + ' / 衰减 ' + DECAY + '/天）');
  return flips;
};

console.log('=== §0 ' + BATCH + ' 的争夺增量（只读）===');
console.log('  正分（PVP 胜利）行数 ' + wins.length + '；涉及地点 ' + groupBy(wins).size + ' 个');
console.log('  参数（从 NUMERIC 读）：dominanceThreshold = ' + THRESHOLD + '，decayPerDay = ' + DECAY);
console.log('');
console.log('=== §1 现在（' + PAIRS_NOW + ' 对可争教会）===');
const now = show(wins, '现状');
console.log('');
console.log('=== §2 阈值扫描（纯函数参数，不需要重跑批）===');
console.log('  | 阈值 | 会翻转的地点 | 翻转数 |');
console.log('  | --- | --- | --- |');
for (const t of [1, 1.5, 2, 3, 5]) {
  const hits = [...groupBy(wins).entries()].filter(([, arr]) => bestNetScore(arr).net >= t).map(([loc]) => loc);
  console.log('  | ' + t + ' | ' + (hits.length ? hits.join('、') : '（无）') + ' | **' + hits.length + '** |');
}
console.log('');
console.log('=== §3 外推到 ' + PAIRS_NEXT + ' 对可争教会（**同一时间分布，倍数放大**）===');
console.log('  做法：把每一次胜利的 delta 乘 ' + (PAIRS_NEXT / PAIRS_NOW) + '（时间点不动）—— 相当于「同样的集中度、' +
  PAIRS_NEXT + ' 倍的频率」，比「只放大总数」更保守，也比行为模型更诚实');
const scaled = wins.map((w) => ({ ...w, delta: w.delta * (PAIRS_NEXT / PAIRS_NOW) }));
console.log('');
const next = show(scaled, PAIRS_NEXT + ' 对教会的外推');
console.log('');
console.log('=== §4 结论 ===');
/*
 * ⚠️ 这一句原来把 m220a 的数（「pritz_harbor 拿到 5 分、跨 13 天」）**硬编码在模板里** ——
 * 换成 m221a 跑出来就是错的（那边是 3 分 / 10 天）。铁律 10/11 同型：
 * 报告模板里出现的数字必须来自当次的数据，否则产物会带着另一个批次的数流出去。
 * 现在从 wins 里现算「分最多的那个地点」。
 */
const topEntry = [...groupBy(wins).entries()].sort((a, b) => bestNetScore(b[1]).net - bestNetScore(a[1]).net)[0];
const topLoc = topEntry ? topEntry[0] : '（没有地点拿到过分）';
const topWins = topEntry ? topEntry[1] : [];
const topGained = topWins.reduce((n, w) => n + w.delta, 0);
const topSpan = topWins.length > 0 ? Math.floor((topWins[topWins.length - 1]!.at - topWins[0]!.at) / DAY) + 1 : 0;
console.log('  · 现状翻转 ' + now + ' 次 —— 不是「分不够」（' + topLoc + ' 拿到 ' + topGained + ' 分），' +
  '而是**分分得太散**（跨 ' + topSpan + ' 天，衰减吃掉 ' + (topSpan * DECAY).toFixed(1) + ' 分）');
const bestNow = Math.max(...[...groupBy(wins).values()].map((arr) => bestNetScore(arr).net), -Infinity);
const bestNext = Math.max(...[...groupBy(scaled).values()].map((arr) => bestNetScore(arr).net), -Infinity);
console.log('  · 单点最佳窗口净分：现状 ' + bestNow.toFixed(2) + ' → 外推 ' + bestNext.toFixed(2) + '（阈值 ' + THRESHOLD + '）');
console.log('  · 乐观上界（所有胜利挤在同一天）= floor(' + (wins.length * PAIRS_NEXT / PAIRS_NOW) + ' / ' + THRESHOLD + ') = ' +
  Math.floor(wins.length * PAIRS_NEXT / PAIRS_NOW / THRESHOLD) + ' 次 —— 这是**理论极值**，等于要求每一次胜利都用在刀刃上');
console.log('  · 外推（保持实测集中度）翻转 ' + next + ' 次');
