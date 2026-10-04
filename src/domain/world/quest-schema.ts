/**
 * 委托（M2.85 RPG 化 D）—— `quests.yaml` 的 schema。
 *
 * 用户选定 D 任务系统。这里的做法是**不新造世界观**，而是把已有的机制接起来：
 *   · 委托人 = 与你**交好**的 NPC（好感门槛）
 *   · 完成条件 = 已有的动作（击败某途径生物 / 到过某地）
 *   · 奖励 = 好感 + 便士（并写进 npc_deeds —— 他会记着）
 */
import { z } from 'zod';

export const QUEST_KINDS = ['hunt', 'explore', 'deliver'] as const;
export type QuestKind = (typeof QUEST_KINDS)[number];

export const QUEST_KIND_LABELS: Record<QuestKind, string> = {
  hunt: '猎杀',
  explore: '探路',
  deliver: '跑腿',
};

export const QUEST_STATUSES = ['taken', 'done', 'failed'] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];

export const QUEST_STATUS_LABELS: Record<QuestStatus, string> = {
  taken: '进行中',
  done: '已完成',
  failed: '已放弃',
};

export const QuestRewardSchema = z.object({
  affinity: z.number().int(),
  penny: z.number().int().min(0),
  note: z.string().default(''),
  /**
   * 给一件**非凡物品**的概率（0 = 不给）。
   *
   * ⚠️ 用户拍板：「委托给非凡物品不该很频繁，**非凡物品不是大白菜**」。
   * 所以默认很低（6%—12%），而且只有**猎杀类**才开 ——
   * 「替我除掉那个东西」才有理由拿出一件非凡物品当谢礼。
   */
  equipmentChance: z.number().min(0).max(1).default(0),
});

export const QuestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(QUEST_KINDS),
  /** 委托人是谁（按身份说，不绑定到具体 NPC —— 他得先跟你好） */
  from: z.string().min(1),
  /** 接委托的门槛：好感（与 npc-relation.ts 的亲近档位对齐） */
  minAffinity: z.number().int().min(-100).max(100),
  minSequence: z.number().int().min(0).max(9),
  title: z.string().min(1),
  text: z.string().default(''),
  condition: z.string().default(''),
  /** 猎杀类：要打的是哪个途径的生物 */
  targetPathway: z.string().optional(),
  reward: QuestRewardSchema,
  tier: z.number().int().min(1).max(3),
});

export type Quest = z.infer<typeof QuestSchema>;

/** 他能不能接这份委托（好感够不够、序列够不够） */
export function canTakeQuest(quest: Quest, input: { affinity: number; sequence: number }): { ok: boolean; reason?: string } {
  if (input.affinity < quest.minAffinity) {
    return { ok: false, reason: `他还信不过你（要 ${quest.minAffinity}，你现在 ${input.affinity}）。` };
  }
  if (input.sequence > quest.minSequence) {
    return { ok: false, reason: '这件事你自己就能办，用不着他开口。' };
  }
  return { ok: true };
}

/** 一句话把委托说清楚（.委托 与 .接 共用） */
export function renderQuest(quest: Quest, giverName: string): string {
  return [
    `【${quest.title}】`,
    `${giverName}：${quest.text}`,
    `要做的事：${quest.condition}`,
    `报酬：好感 +${quest.reward.affinity}、${quest.reward.penny} 便士${quest.reward.note.length > 0 ? `（${quest.reward.note}）` : ''}`,
  ].join('\n');
}
