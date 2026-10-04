#! /usr/bin/env node
/**
 * M2.18 任务 B 的参数扫描（**不跑批**）。
 *
 * 用法：node scripts/m2-18-conflict-sweep.ts --prefix m219a
 *
 * 为什么不用跑批：阈值与衰减都是**读取时**的参数（contestedOwnerAt / decayEntries 的入参），
 * 而增量表里已经存着「谁在哪儿赢过、什么时候赢的」—— 换参数只是换一次重放。
 *
 * 扫描维度：阈值 2/3/4/5 × 衰减 0.3/0.5/0.8/1 × 扩触发面倍率 1.0 / 1.5（袭击算入）。
 */
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const index = argv.indexOf('--' + name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};
const PREFIX = argOf('prefix', 'm219a');
const SHARDS = 8;
const DAYS = 30;

/* ---- 读原始胜利事件（**只取正 delta**：负的是已发生的衰减，不能拿来做基线） ---- */
interface Win { locationId: string; winnerChurchId: string; at: number }
const wins: Win[] = [];
let start = Number.POSITIVE_INFINITY;
for (let shard = 0; shard < SHARDS; shard += 1) {
  let db: DatabaseSync;
  try { db = new DatabaseSync('data/' + PREFIX + '-shard-' + shard + '.db', { readOnly: true }); } catch { continue; }
  const rows = db
    .prepare('SELECT location_id, winner_church_id, created_at FROM church_territory_contest WHERE delta > 0')
    .all() as unknown as Array<{ location_id: string; winner_church_id: string; created_at: number }>;
  for (const row of rows) {
    const at = Number(row.created_at);
    wins.push({ locationId: row.location_id, winnerChurchId: row.winner_church_id, at });
    if (at < start) start = at;
  }
  db.close();
}
console.log('原始胜利（PVP，seed ' + PREFIX + '）：' + wins.length + ' 次，落在 ' + new Set(wins.map((w) => w.locationId)).size + ' 个地点');

/* ---- 按倍率扩展：复制出来的事件放在原事件次日（保守：不集中到同一天） ---- */
function expand(winsIn: readonly Win[], ratio: number): Win[] {
  const out = [...winsIn];
  const extra = Math.round(winsIn.length * (ratio - 1));
  for (let i = 0; i < extra; i += 1) {
    const base = winsIn[i % winsIn.length];
    if (!base) break;
    out.push({ ...base, at: base.at + 86400000 });
  }
  return out;
}

const DAY_MS = 86400000;
function dayOf(at: number): number {
  const d = Math.floor((at - start) / DAY_MS);
  return d < 0 ? 0 : d >= DAYS ? DAYS - 1 : d;
}

interface SimInput { locationId: string; winnerChurchId: string; day: number }
function ownerOf(churches: Map<string, number>, threshold: number): string | null {
  const tally = [...churches.entries()].sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]));
  const top = tally[0];
  if (!top) return null;
  if (top[1] < threshold) return null;
  if (tally[1] && tally[1][1] === top[1]) return null;
  return top[0];
}

function simulate(inputs: readonly SimInput[], threshold: number, decay: number): { flips: number; finalOwned: number } {
  const byDay = new Map<number, SimInput[]>();
  for (const input of inputs) {
    const list = byDay.get(input.day) ?? [];
    list.push(input);
    byDay.set(input.day, list);
  }
  const tally = new Map<string, Map<string, number>>();
  const owner = new Map<string, string | null>();
  let flips = 0;
  for (let day = 0; day < DAYS; day += 1) {
    for (const input of byDay.get(day) ?? []) {
      const churches = tally.get(input.locationId) ?? new Map<string, number>();
      churches.set(input.winnerChurchId, (churches.get(input.winnerChurchId) ?? 0) + 1);
      tally.set(input.locationId, churches);
      const next = ownerOf(churches, threshold);
      const before = owner.get(input.locationId) ?? null;
      if (next !== before) flips += 1;
      owner.set(input.locationId, next);
    }
    // 日终衰减：所有 Σ > 0 的教会各减 decay（作用域见 conflict.ts 的注释）
    for (const churches of tally.values()) {
      for (const [churchId, score] of churches) {
        if (score > 0) churches.set(churchId, score - decay);
      }
    }
  }
  return { flips, finalOwned: [...owner.values()].filter((value) => value !== null).length };
}

const THRESHOLDS = [2, 3, 4, 5];
const DECAYS = [0.3, 0.5, 0.8, 1];
const RATIOS = [1, 1.5];

for (const ratio of RATIOS) {
  const inputs: SimInput[] = expand(wins, ratio).map((w) => ({
    locationId: w.locationId,
    winnerChurchId: w.winnerChurchId,
    day: dayOf(w.at),
  }));
  console.log('');
  console.log('### 倍率 ×' + ratio + '（扩触发面后 ' + inputs.length + ' 次胜利）—— 格子里是「30 天翻转次数 / 末态有归属的地点数」');
  console.log('');
  console.log('| 阈值 \\ 衰减 | ' + DECAYS.join(' | ') + ' |');
  console.log('| --- |' + DECAYS.map(() => ' --- |').join(''));
  for (const threshold of THRESHOLDS) {
    const cells = DECAYS.map((decay) => {
      const result = simulate(inputs, threshold, decay);
      return result.flips + ' / ' + result.finalOwned;
    });
    console.log('| 阈值 ' + threshold + ' | ' + cells.join(' | ') + ' |');
  }
}

/* ---- 单点分布：为什么翻不动 ---- */
const perLocation = new Map<string, number>();
for (const win of wins) perLocation.set(win.locationId, (perLocation.get(win.locationId) ?? 0) + 1);
console.log('');
console.log('### 原始胜利的地点分布');
for (const [loc, n] of [...perLocation.entries()].sort((a, b) => b[1] - a[1])) {
  console.log('  ' + loc + '：' + n + ' 次');
}
