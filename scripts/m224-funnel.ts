#! /usr/bin/env node
/**
 * M2.24 任务 1：**四道漏斗的后三层 + 理论期望翻转率**（只读，0 批）。
 *
 * ## 五层的定义（写死，报告里照抄）
 *
 * | 层 | 定义 | 口径 |
 * | --- | --- | --- |
 * | **L1** | 入途径 → **结构上可入教** | `结构上可入教人数 / 已入途径人数` |
 * | **L2** | 结构上可入教 → **实际入教** | `实际入教 / 结构上可入教` |
 * | **L3** | → **双方都入教** | 一场 PVP 里双方都有 `church_id` 的比例 |
 * | **L4** | → **敌对 + 同地点** | 双方入教的场次里，两家 `hostile` 的比例（**同地点由 PVP 蕴含**：`.挑战` 的入口就校验同地点） |
 * | **L5** | → **分出胜负** | 敌对场次里**记上增量**的比例（`recordTerritoryContest` 只在「分出胜负」时记） |
 *
 * ⚠️ **五层给的是「期望正分数」，不是「翻转次数」。**
 * 正分要变成翻转，还要过**第六步**：同一地点累积 ≥ 阈值，且**跑到衰减前面**
 * （阈值 `dominanceThreshold`、衰减 `decayPerDay`）——那一步用**蒙特卡洛**算（§4）。
 *
 * ## 为什么要有 §4：理论期望不能用实测值代替
 *
 * 实测翻转是 1—2 次 —— 那是**一个观测**。要判「它是不是正常值」，
 * 需要的是「**同样多的正分、同样的时空分布**下，翻转次数的**分布**」。
 * 所以 §4 做两件事：
 *   · **随机撒**（时间均匀 + 地点按可争夺集均匀）⇒ 正分「铺得最开」时的上界；
 *   · **实测分布**（保留实测的地点构成）⇒ 正分实际有多集中。
 * 两者一比就知道：**是正分太少，还是正分散得太开**。
 *
 * 用法：node scripts/m224-funnel.ts [--batch m224] [--shards 1] [--trials 2000]
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { ChurchIndex } from '../src/domain/church/index.ts';
import { contestedOwnerAt, type ContestRow } from '../src/domain/church/conflict.ts';
import { loadChurches, loadCities, loadLocations } from '../src/data/loader.ts';
import { shardKey } from '../src/infra/shard-key.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm224');
const SHARDS = Number(argOf('shards', '1'));
const TRIALS = Number(argOf('trials', '2000'));

const THRESHOLD = NUMERIC.church.conflict.dominanceThreshold;
const DECAY = NUMERIC.church.conflict.decayPerDay;
const CANDIDATES = NUMERIC.church.conflict.contestedLocations;
const index = new ChurchIndex(loadChurches().churches, loadCities().cities, loadLocations().locations);
const pathwayToChurch = new Map<string, Array<{ id: string; seats: readonly string[] }>>();
for (const church of loadChurches().churches) {
  if (!church.pathway) continue;
  const list = pathwayToChurch.get(church.pathway) ?? [];
  list.push({ id: church.id, seats: church.seats });
  pathwayToChurch.set(church.pathway, list);
}

interface CharRow {
  id: string; pathway: string | null; church_id: string | null; current_city_id: string | null;
}
interface PvpRow {
  character_id: string; opponent_character_id: string | null; location_id: string | null; status: string;
}

let totalChars = 0;
let initiated = 0;
let structuralOk = 0;
let joined = 0;
let pvpTotal = 0;
let pvpBoth = 0;
let pvpHostile = 0;
let pvpScored = 0;
const positive: Array<{ locationId: string; at: number }> = [];
const perShard: Array<{ shard: number; initiated: number; structuralOk: number; joined: number }> = [];

for (let s = 0; s < SHARDS; s += 1) {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync('data/' + BATCH + '-shard-' + s + '.db', { readOnly: true });
  } catch {
    continue;
  }
  const chars = db.prepare('SELECT id, pathway, church_id, current_city_id FROM characters').all() as unknown as CharRow[];
  const byId = new Map(chars.map((c) => [String(c.id), c]));
  let shInit = 0;
  let shStruct = 0;
  let shJoined = 0;
  for (const c of chars) {
    totalChars += 1;
    if (!c.pathway) continue;
    initiated += 1;
    shInit += 1;
    const options = pathwayToChurch.get(c.pathway) ?? [];
    if (options.some((o) => o.seats.includes(c.current_city_id ?? ''))) {
      structuralOk += 1;
      shStruct += 1;
    }
    if (c.church_id) {
      joined += 1;
      shJoined += 1;
    }
  }
  perShard.push({ shard: s, initiated: shInit, structuralOk: shStruct, joined: shJoined });

  for (const b of db.prepare(
    'SELECT character_id, opponent_character_id, location_id, status FROM battles WHERE is_pvp = 1',
  ).all() as unknown as PvpRow[]) {
    pvpTotal += 1;
    const a = byId.get(String(b.character_id));
    const o = b.opponent_character_id ? byId.get(String(b.opponent_character_id)) : undefined;
    if (!a?.church_id || !o?.church_id) continue;
    pvpBoth += 1;
    if (a.church_id === o.church_id) continue;
    if (index.relationOf(String(a.church_id), String(o.church_id)) !== 'hostile') continue;
    pvpHostile += 1;
  }

  // 正分：chuch_territory_contest 里 delta > 0 的行（= 记上增量的那些 PVP 胜利）
  for (const row of db.prepare(
    'SELECT location_id, delta, created_at FROM church_territory_contest WHERE delta > 0 ORDER BY created_at',
  ).all() as unknown as Array<{ location_id: string; delta: number; created_at: number }>) {
    positive.push({ locationId: String(row.location_id), at: Number(row.created_at) });
    pvpScored += 1;
  }
  void shardKey(s, 'probe');
  db.close();
}

const pct = (n: number, d: number): string => (d === 0 ? '—' : ((100 * n) / d).toFixed(1) + '%');

console.log('=== M2.24 任务 1 · 五层漏斗 ===');
console.log('  批：' + BATCH + '　片数：' + SHARDS + '　角色：' + totalChars);
console.log('');
console.log('=== §0 五层通过率 ===');
console.log('  | 层 | 从 → 到 | 分子 | 分母 | 通过率 |');
console.log('  | --- | --- | --- | --- | --- |');
console.log('  | **L1** | 入途径 → 结构上可入教 | ' + structuralOk + ' | ' + initiated + ' | **' + pct(structuralOk, initiated) + '** |');
console.log('  | **L2** | 结构上可入教 → 实际入教 | ' + joined + ' | ' + structuralOk + ' | **' + pct(joined, structuralOk) + '** |');
console.log('  | **L3** | → 双方都入教（一场 PVP） | ' + pvpBoth + ' | ' + pvpTotal + ' | **' + pct(pvpBoth, pvpTotal) + '** |');
console.log('  | **L4** | → 敌对 + 同地点 | ' + pvpHostile + ' | ' + pvpBoth + ' | **' + pct(pvpHostile, pvpBoth) + '** |');
console.log('  | **L5** | → 分出胜负（记上正分） | ' + pvpScored + ' | ' + pvpHostile + ' | **' + pct(pvpScored, pvpHostile) + '** |');
const l1 = initiated ? structuralOk / initiated : 0;
const l2 = structuralOk ? joined / structuralOk : 0;
const l3 = pvpTotal ? pvpBoth / pvpTotal : 0;
const l4 = pvpBoth ? pvpHostile / pvpBoth : 0;
const l5 = pvpHostile ? pvpScored / pvpHostile : 0;
console.log('');
console.log('  **五层相乘 = ' + ((l1 * l2 * l3 * l4 * l5) * 100).toFixed(3) + '%**（这是「一次 PVP 变成一条正分」的概率）');
console.log('  **每 ' + pvpTotal + ' 场 PVP 的期望正分数 = ' + (pvpTotal * l3 * l4 * l5).toFixed(1) + ' 条**（实测 ' + pvpScored + ' 条）');
console.log('');

console.log('=== §1 逐片分布（L1/L2 的分母写死）===');
console.log('  | 片 | 已入途径 | 结构上可入教 | 实际入教 | L1 | L2 |');
console.log('  | --- | --- | --- | --- | --- | --- |');
for (const s of perShard) {
  console.log('  | ' + s.shard + ' | ' + s.initiated + ' | ' + s.structuralOk + ' | ' + s.joined + ' | ' +
    pct(s.structuralOk, s.initiated) + ' | ' + pct(s.joined, s.structuralOk) + ' |');
}
console.log('');
console.log('  · L1 的分母 = **已入途径人数**（不是建号数）—— 未入途径的人谈不上入教；');
console.log('  · L1 的分子 = 途径有对应教会 **且** 当前城市在它的 seats 里（**终态城市**，是下界）；');
console.log('  · L2 的分母就是 L1 的分子（**结构上可入教**），不是全体。');

console.log('');
console.log('=== §2 正分的时空分布（实测）===');
const byLocation = new Map<string, number>();
const dayOf = (at: number): number => Math.floor((at - Math.min(...positive.map((p) => p.at))) / 86400000);
const byDay = new Map<number, number>();
for (const p of positive) {
  byLocation.set(p.locationId, (byLocation.get(p.locationId) ?? 0) + 1);
  const d = dayOf(p.at);
  byDay.set(d, (byDay.get(d) ?? 0) + 1);
}
console.log('  · 正分共 ' + positive.length + ' 条，落在 **' + byLocation.size + ' 个地点**上：' +
  [...byLocation.entries()].map(([k, v]) => k + '=' + v).join('、'));
console.log('  · 落在 ' + byDay.size + ' 个不同的日子上：' + [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => 'D' + k + '×' + v).join(' '));
console.log('  · 阈值 dominanceThreshold = ' + THRESHOLD + '　衰减 decayPerDay = ' + DECAY + '　可争地点 ' + CANDIDATES.length + ' 个');

/* ==================== §3 蒙特卡洛 ==================== */
interface SimInput {
  positiveCount: number;
  days: number;
  locations: string[];
  trials: number;
  /** 每条正分的地点抽样权重（不传就均匀） */
  locationWeights?: number[];
  /** 固定赢家（做「同一家教会连续赢」的对照；不传就三家随机） */
  fixedChurch?: string;
}

/** 重放：逐天「先记正分、再衰减」，每天末算一次归属，与前一天比 */
function simulate(input: SimInput): number[] {
  const out: number[] = [];
  const weights = input.locationWeights ?? input.locations.map(() => 1);
  const totalW = weights.reduce((a, b) => a + b, 0);
  for (let t = 0; t < input.trials; t += 1) {
    // 正分：(location, day) 抽样
    const events: Array<{ day: number; locationId: string; winnerChurchId: string }> = [];
    for (let i = 0; i < input.positiveCount; i += 1) {
      let r = Math.random() * totalW;
      let pick = input.locations[0]!;
      for (let k = 0; k < input.locations.length; k += 1) {
        r -= weights[k]!;
        if (r <= 0) { pick = input.locations[k]!; break; }
      }
      // 赢家：现三家教会里随机（PVP 谁赢是 50/50 的近似；`fixedChurch` 用来做「同一家连续赢」的对照）
      const churches = ['god_of_war', 'night_goddess', 'storm_lord'];
      events.push({
        day: Math.floor(Math.random() * input.days),
        locationId: pick,
        winnerChurchId: input.fixedChurch ?? churches[Math.floor(Math.random() * churches.length)]!,
      });
    }
    const score = new Map<string, number>(); // key = loc|church
    const prevOwner = new Map<string, string | null>();
    let flips = 0;
    for (let day = 0; day < input.days; day += 1) {
      for (const e of events) {
        if (e.day !== day) continue;
        const key = e.locationId + '|' + e.winnerChurchId;
        score.set(key, (score.get(key) ?? 0) + NUMERIC.church.conflict.pvpWinDelta);
      }
      // 衰减：只减 Σ > 0 的 (loc, church)
      for (const [key, value] of score) {
        if (value > 0) score.set(key, Math.max(0, value - DECAY));
      }
      // 算归属
      const byLoc = new Map<string, ContestRow[]>();
      for (const [key, value] of score) {
        const [loc, church] = key.split('|') as [string, string];
        const list = byLoc.get(loc) ?? [];
        list.push({ locationId: loc, winnerChurchId: church, delta: value });
        byLoc.set(loc, list);
      }
      for (const loc of input.locations) {
        const rows = byLoc.get(loc) ?? [];
        const owner = contestedOwnerAt(loc, rows, THRESHOLD);
        const id = owner === null ? null : owner.churchId;
        if (id !== null && id !== (prevOwner.get(loc) ?? null)) flips += 1;
        prevOwner.set(loc, id);
      }
    }
    out.push(flips);
  }
  return out;
}

const stat = (xs: number[]): { p10: number; p50: number; p90: number; mean: number } => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    p10: s[Math.floor(s.length * 0.1)] ?? 0,
    p50: s[Math.floor(s.length * 0.5)] ?? 0,
    p90: s[Math.floor(s.length * 0.9)] ?? 0,
    mean: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length),
  };
};
const fmt = (x: { p10: number; p50: number; p90: number; mean: number }): string =>
  'P10 ' + x.p10 + ' / **P50 ' + x.p50 + '** / P90 ' + x.p90 + '（均值 ' + x.mean.toFixed(2) + '）';

const days = positive.length ? Math.max(...positive.map((p) => dayOf(p.at))) + 1 : 30;
const weights = CANDIDATES.map((loc) => byLocation.get(loc) ?? 0);
const hasWeights = weights.some((w) => w > 0);

console.log('');
console.log('=== §3 蒙特卡洛：同样多的正分，翻转能到几次 ===');
console.log('  （' + TRIALS + ' 次试验；每次随机撒 ' + positive.length + ' 条正分、跨 ' + days + ' 天、赢家在现三家教会里随机）');
console.log('');
console.log('  · **随机撒**（地点在 ' + CANDIDATES.length + ' 个可争夺地点里均匀、天均匀）：');
console.log('      ' + fmt(stat(simulate({ positiveCount: positive.length, days, locations: [...CANDIDATES], trials: TRIALS }))));
if (hasWeights) {
  console.log('  · **实测地点构成**（只撒在实测出现过的 ' + byLocation.size + ' 个地点上，权重按实测条数）：');
  const locs = [...byLocation.keys()];
  console.log('      ' + fmt(stat(simulate({ positiveCount: positive.length, days, locations: locs, trials: TRIALS }))));
}
console.log('  · **正分翻倍**（' + positive.length * 2 + ' 条，随机撒）：');
console.log('      ' + fmt(stat(simulate({ positiveCount: positive.length * 2, days, locations: [...CANDIDATES], trials: TRIALS }))));
console.log('  · **正分 ×4**（' + positive.length * 4 + ' 条，随机撒）：');
console.log('      ' + fmt(stat(simulate({ positiveCount: positive.length * 4, days, locations: [...CANDIDATES], trials: TRIALS }))));
console.log('');
console.log('  · **集中度杠杆**：把同样多的正分**只撒在一个地点上**（这是「玩家有策略地打一处」的模型）：');
for (const loc of ['pritz_harbor', 'backlund_slum']) {
  console.log('      ' + loc.padEnd(16) + '8 条、三家随机：' +
    fmt(stat(simulate({ positiveCount: positive.length, days, locations: [loc], trials: TRIALS }))) +
    '　**同一家连赢**：' + fmt(stat(simulate({ positiveCount: positive.length, days, locations: [loc], trials: TRIALS, fixedChurch: 'god_of_war' }))));
}
console.log('      （32 条、同一地点、同一家连赢：' +
  fmt(stat(simulate({ positiveCount: positive.length * 4, days, locations: ['pritz_harbor'], trials: TRIALS, fixedChurch: 'god_of_war' }))) + '）');
console.log('');
console.log('  读法三条：');
console.log('    1. **随机撒 = 正分铺得最开时的上界**；实测落在它下面 ⇒ 集中度不是限制；');
console.log('    2. 随机撒与实测接近 ⇒ 限制因素是**正分条数**本身，不是它们的分布；');
console.log('    3. **「同一地点 + 同一家连续赢」是真正的杠杆** —— 它把翻转从「尾部事件」拉进 P50。');
