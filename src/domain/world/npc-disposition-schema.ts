/**
 * NPC 立场（M2.85 RPG 化）—— `npc-dispositions.yaml` 的 schema。
 *
 * 这张表回答三个问题：**他是哪种人**（temperament）、**他与谁对立**（hostilePathways）、
 * **他手里有什么**（giftTier）。
 */
import { z } from 'zod';
import { GiftTierSchema, TemperamentSchema } from './npc-relation.ts';

export const NpcDispositionSchema = z.object({
  npcId: z.string().min(1),
  name: z.string().min(1),
  sequence: z.number().int().min(0).max(9).nullable().default(null),
  pathways: z.array(z.string()).default([]),
  /** 性情：dark = 交恶时会主动算计；kind = 交恶时克制、交好时伸手；neutral = 按利害行事 */
  temperament: TemperamentSchema.default('neutral'),
  /** 阵营对立（对应途径的人在这里会被他针对） */
  hostilePathways: z.array(z.string()).default([]),
  /** 赠礼档位（按身份能给多重的礼） */
  giftTier: GiftTierSchema.default('low'),
  note: z.string().default(''),
});

export type NpcDisposition = z.infer<typeof NpcDispositionSchema>;
