/**
 * 战斗技能（M2.85 RPG 化 C）—— `battle-skills.yaml` 的 schema。
 *
 * 与 domain/battle/skills.ts 的分工：那边是**读取与判定**（纯函数），这里是**内容形状**。
 * 技能名与依据来自原作能力表（source 指向能力 id），效果数值是项目派生值。
 */
import { z } from 'zod';

export const SKILL_KINDS = ['strike', 'guard', 'control', 'restore'] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

export const SKILL_KIND_LABELS: Record<SkillKind, string> = {
  strike: '强攻',
  guard: '防御',
  control: '控制',
  restore: '辅助',
};

export const SkillEffectSchema = z.object({
  /** 伤害加成（0.4 = +40%） */
  damageBonus: z.number().optional(),
  /** 命中加成 */
  hitBonus: z.number().optional(),
  /** 自己受到的伤害变化（负 = 减伤） */
  damageTaken: z.number().optional(),
  /** 失控抗性 */
  madResist: z.number().optional(),
  /** 让对手命中下降 */
  foeHitPenalty: z.number().optional(),
  /** 回复灵力 */
  mpRestore: z.number().optional(),
  /** 消化加成 */
  digBonus: z.number().optional(),
});

export type SkillEffect = z.infer<typeof SkillEffectSchema>;

export const BattleSkillSchema = z.object({
  id: z.string().min(1),
  pathway: z.string().min(1),
  /** 解禁序列（玩家序列必须 ≤ 它） */
  seq: z.number().int().min(0).max(9),
  name: z.string().min(1),
  mpCost: z.number().int().min(0),
  kind: z.enum(SKILL_KINDS),
  effect: SkillEffectSchema.default({}),
  /** 原文依据（那段能力描述） */
  text: z.string().default(''),
  /** 出处：pathway-abilities.yaml 里的能力 id —— 可追溯 */
  source: z.string().default(''),
});

export type BattleSkill = z.infer<typeof BattleSkillSchema>;
