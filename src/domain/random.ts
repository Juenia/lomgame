/**
 * 共享随机工具：所有按权重抽取只有这一个实现，保证「同一 seed → 同一结果」。
 */
import type { Rng } from './character/types.ts';

/** 按权重抽一个；池子为空或权重全为 0 时返回 null（调用方自己决定兜底） */
export function weightedPick<T>(pool: readonly T[], weightOf: (item: T) => number, rng: Rng): T | null {
  if (pool.length === 0) return null;
  const weights = pool.map((item) => Math.max(0, weightOf(item)));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return null;

  let roll = rng.next() * total;
  for (let i = 0; i < pool.length; i += 1) {
    roll -= weights[i] ?? 0;
    if (roll < 0) return pool[i] ?? null;
  }
  return pool[pool.length - 1] ?? null;
}

/** 闭区间随机整数 [min, max] */
export function randomInt(rng: Rng, min: number, max: number): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return low + Math.floor(rng.next() * (high - low + 1));
}

/** 概率命中 */
export function rollChance(rng: Rng, chance: number): boolean {
  return rng.next() < chance;
}
