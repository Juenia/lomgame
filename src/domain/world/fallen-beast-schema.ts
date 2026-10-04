/**
 * 堕落生物的 schema（`src/data/fallen-beasts.yaml`）。
 *
 * ⚠️ 与生物那套**共用同一份子 schema**（drop / behavior / battle / perception）——
 * 同一件事不写第二份（铁律 7）。所以「五层感知缺一层就报错」「special 写错名就报错」
 * 这两条纪律在这里自动成立，不需要再写一遍。
 *
 * `formId` 指向 `src/cards/lost-control.yaml` 的 forms —— 那张表是形态的**唯一出处**，
 * 本表不重复途径 / 形态名 / min_seq（AGENTS §3.1：两份清单会安静地少读一半）。
 */
import { z } from 'zod';
import {
  CreatureBattleSchema,
  CreatureBehaviorSchema,
  CreatureDropSchema,
  CreaturePerceptionSchema,
} from '../creature/schema.ts';

export const FallenBeastSchema = z.object({
  /** 指向 lost-control.yaml 的 forms[].id（加载器交叉校验它真的存在） */
  formId: z.string().min(1),
  /** 变成生物之后的强度基线：1（最强）—9（最弱），与 creatures.yaml 同一口径 */
  baseSequence: z.number().int().min(1).max(9),
  baseHp: z.number().int().positive(),
  /** 【原作】怪物是魔药材料的来源 —— 掉落必须是真实存在的物品（加载器会查） */
  drops: z.array(CreatureDropSchema).default([]),
  behaviors: z.array(CreatureBehaviorSchema).default([]),
  /** 战斗面**必填**：一个没有伤害数字的东西靠兜底也能打，但那是木桩，不是怪物 */
  battle: CreatureBattleSchema,
  perception: CreaturePerceptionSchema,
  flavor: z.string().default(''),
  /** 依据（原作条目 / 设计文档），给内容作者看的 */
  source: z.string().default(''),
});
export type FallenBeast = z.infer<typeof FallenBeastSchema>;

export const FallenBeastFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  fallen_beasts: z.array(FallenBeastSchema).default([]),
});
