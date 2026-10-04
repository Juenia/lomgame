/**
 * NPC 与玩家的关系（M2.85 RPG 化）—— **纯函数，无 IO**。
 *
 * ## 用户拍板
 *
 * > 「玩家的行为可能交恶或者交好 NPC，交恶的情况下就可能对玩家厌恶，
 * >   如果是更黑暗向的 NPC 则会对玩家不利；交好的 NPC 可能会在某个时刻帮助玩家，
 * >   可能赠送给玩家符合他自己身份可能拥有的物品」
 *
 * 于是这一层要回答三件事：**他怎么看玩家**、**他会做什么**、**他能给什么**。
 *
 * ## 态度不是开关，是一根轴
 *
 *   -100 死敌 …… -30 厌恶 …… 0 路人 …… +30 亲近 …… +100 挚友
 *
 * 之所以用连续值而不是「友好/敌对」两个标签：原著里的人情是**攒出来**的，
 * 而玩家的每一个选择都该往这根轴上添一点或减一点。
 */

import { z } from 'zod';

/**
 * 性情：由途径气质派生（见 `npc-dispositions.yaml` 与 `npc-cast.yaml`）。
 *
 * ⚠️ M2.164：清单**只能有一份**。在这之前，本文件手写了一遍联合类型，
 * 而 `npc-disposition-schema.ts` 又内联了一遍 `z.enum(['dark', 'neutral', 'kind'])` ——
 * 两处都不报错，可加一档性情时只有一处会红，另一处静默收旧值。
 * 现在 schema 从 `TEMPERAMENTS` 派生：改这里一处，两个读取点一起动。
 */
export const TEMPERAMENTS = ['dark', 'neutral', 'kind'] as const;
export type Temperament = (typeof TEMPERAMENTS)[number];
export const TemperamentSchema = z.enum(TEMPERAMENTS);

/** 赠礼档位（同一类「两份清单」的问题，顺手收敛 —— 见上面的注释） */
export const GIFT_TIERS = ['low', 'mid', 'high'] as const;
export type GiftTier = (typeof GIFT_TIERS)[number];
export const GiftTierSchema = z.enum(GIFT_TIERS);

/** 态度档位 */
export type Attitude = 'hated' | 'cold' | 'neutral' | 'warm' | 'close';

export const ATTITUDE_LABELS: Record<Attitude, string> = {
  hated: '仇视',
  cold: '冷淡',
  neutral: '无所谓',
  warm: '友善',
  close: '亲近',
};

export function clampAffinity(value: number): number {
  return Math.max(-100, Math.min(100, Math.round(value)));
}

export function attitudeOf(affinity: number): Attitude {
  if (affinity <= -60) return 'hated';
  if (affinity <= -25) return 'cold';
  if (affinity < 25) return 'neutral';
  if (affinity < 60) return 'warm';
  return 'close';
}

/**
 * 他会不会**主动算计**这个人。
 *
 * 三个条件缺一不可（用户那句「更黑暗向的 NPC 则会对玩家不利」的落地）：
 *   ① 态度够坏（cold 及以下）；② 性情黑暗；③ 序列够高（≤ 4 —— 低序列的人算计不了谁）
 */
export function willScheme(affinity: number, temperament: Temperament, sequence: number): boolean {
  if (temperament !== 'dark') return false;
  if (affinity > -25) return false;
  return sequence <= 4;
}

/** 交好的人**在关键时刻伸手**的概率（强度 × 态度） */
export function helpChance(affinity: number, temperament: Temperament, sequence: number): number {
  if (affinity < 25) return 0;
  const base = temperament === 'kind' ? 0.35 : temperament === 'neutral' ? 0.2 : 0.1;
  const intensity = (affinity - 25) / 75;   // 0 到 1
  const weight = sequence <= 4 ? 1 : 0.6;   // 高序列的人帮得上忙
  return Math.max(0, Math.min(0.9, base * intensity * weight));
}

/** 赠礼的档位（按他的序列：越强给得越重） */
export function giftTierOf(sequence: number): GiftTier {
  return sequence <= 3 ? 'high' : sequence <= 6 ? 'mid' : 'low';
}

/** 态度变化的一句子人话（回执用） */
export function attitudeChangeLine(name: string, before: number, after: number): string {
  if (after < before) return `${name}看你的眼神冷了一点。`;
  if (after > before) return `${name}多看了你一眼 —— 记下了这件事。`;
  return `${name}没有反应。`;
}
