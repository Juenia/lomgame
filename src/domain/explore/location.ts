import { z } from 'zod';
import { BindTypeSchema } from '../item/bind.ts';

export const LootEntrySchema = z.object({
  itemId: z.string().min(1),
  weight: z.number().positive(),
  minQty: z.number().int().positive().default(1),
  maxQty: z.number().int().positive().default(1),
  bindType: BindTypeSchema.default('unbound'),
});

export const LocationDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 数字越小要求越高：9 = 新号可进 */
  min_seq: z.number().int().min(0).max(9).default(9),
  max_seq: z.number().int().min(0).max(9).default(0),
  /** 危险度 0—5，参与危险判定 */
  danger: z.number().int().min(0).max(5).default(0),
  loot: z.array(LootEntrySchema).min(1),
  events: z.array(z.string()).default([]),
  /** M2.2：相邻地点 id（天气按这张图在 2 小时内扩散）；单向声明即可，扩散时两边都看 */
  adjacent: z.array(z.string()).default([]),
  /*
   * M2.167：**堕落源** —— 这个地方本身会把人变成怪物。
   *
   * 【原作】「神弃之地的黑暗本身就存在危险，会让生物**堕落为怪物**」；
   *        「深渊的入口位于迷雾海，那是会**腐蚀一切、让所有生灵堕落**的地方」。
   *
   * 判定读它：堕落者站在堕落源上时，异变概率 ×3（见 domain/world/fallen-beast.ts
   * 的 mutationMultiplier）。不标的后果不是报错，而是那一条环境因子**永远是假的**。
   */
  corruption_source: z.boolean().default(false),
  /*
   * ===== M2.85 内容填充 P2：原作地点的设定字段（全部可选，缺省为空）=====
   * 执行点：`.世界 <地点名>` 的地点档案（类型 / 神祇 / 角色 / 事迹）。
   */
  /** 原名注记（原作 name_note：同一地点的异名 / 存疑说明） */
  name_note: z.string().default(''),
  /** 原作地点类型：church / ruin / government_site / military_site / organization_site / undefined… */
  place_type: z.string().default(''),
  /** 与它相关的神祇（原作 deity） */
  deity: z.string().default(''),
  /** 原作口径的国家 */
  country: z.string().default(''),
  /** 它在故事里的角色（原作 role） */
  role: z.string().default(''),
  /** 曾在它这里发生的事（原作 notable_events） */
  notable_events: z.array(z.string()).default([]),
  /** 原作口径的存续状态 */
  status: z.string().default(''),
  sources: z.array(z.string()).default([]),
  confidence: z.string().default(''),
});

export type LootEntry = z.infer<typeof LootEntrySchema>;
export type LocationDef = z.infer<typeof LocationDefSchema>;

export function parseLocation(raw: unknown): { ok: true; location: LocationDef } | { ok: false; issues: string[] } {
  const result = LocationDefSchema.safeParse(raw);
  if (result.success) return { ok: true, location: result.data };
  return { ok: false, issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`) };
}

/** 序列是否满足地点要求（序列号越小越高） */
export function sequenceAllowed(location: LocationDef, sequence: number): boolean {
  return sequence <= location.min_seq && sequence >= location.max_seq;
}

/**
 * 失控当天的探索候选（M2.1 方案 E）：把该地点挂着的 lost_* 卡直接塞进候选池。
 *
 * 为什么不靠卡自己的 cond：卡的 cond 是 status:lost_control，而玩家当天的第一条指令
 * 通常就是解除失控（实测 80 个失控日里 80/80 都是这样），等他们探索的时候 status 早已回到 active。
 * 这里改用**今天有没有失控过**这个按天留档的事实（lost_control_events，见 LostControlRepo.hasOn），
 * 于是「失控当天 → 普通卡 + 该地点的 1—2 张失控卡」「没失控过 → 一张都不多」。
 * 普通日卡池完全不受影响：这些 id 只在 lostToday 为真时才进池。
 */
export function lostDayCandidates(location: LocationDef, lostToday: boolean): readonly string[] {
  if (!lostToday) return [];
  return location.events.filter((id) => id.startsWith('lost_'));
}
