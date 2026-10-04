import type { Rng } from './character/types.ts';

/**
 * mulberry32：小而快、同种子同序列。
 * 用途：玩家投诉「我 DIG 满了还失败」时，用日志里的 seed 精确复现（S1 §3.2）。
 */
export function createSeededRng(seed: string): Rng {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** 判定日志用的 seed 拼装：seed = 角色:指令:时间戳:随机盐 */
export function seedFrom(parts: Array<string | number>): string {
  return parts.join(':');
}
