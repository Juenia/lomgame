/**
 * 途径行为（M2.85 世界演化）—— **纯函数，无 IO**。
 *
 * ## 用户拍板
 *
 * > 「NPC 也要会做出符合自己途径的行为」
 *
 * 在此之前，NPC 干的事只有三种：**晋升、猎杀、化解灾厄** —— 全是通用的。
 * 一个走「愚者」途径的天使和一个走「红祭司」途径的天使，除了数值没有任何区别。
 *
 * ## 本文件做什么
 *
 * 把 `pathway-deeds.yaml` 的 44 条行为（22 途径 × 2）按 NPC 的途径挑出来，
 * 让他在世界 tick 里做**符合本途径**的事：愚者占卜、猎人猎杀、死神收尸、阅读者研读……
 *
 * ## 效果只有 6 种，而且都能被验证
 *
 *   hunt      猎杀生物（真的从生态里减一只）
 *   calm      化解灾厄 / 平息混乱
 *   tend      养育 / 补充（真的给生态加一只）
 *   foretell  占卜 / 预言（写一条「明天会怎样」的世界事件）
 *   observe   观察 / 洞察（把某件事写进世界事件）
 *   gather    搜寻 / 发现（带回东西 → 记功绩）
 *
 * ⚠️ 为什么不多设几种：**多一种效果就多一处没人验的代码**。
 * 这 6 种里前三种有真实世界影响，后三种是信息与功绩 —— 都有读取点、都能断言。
 * 22 条途径的气质差异体现在**文案与触发条件**上，不靠堆效果类型。
 */
import { z } from 'zod';

/** 六种可验证的效果 */
export const DEED_EFFECTS = ['hunt', 'calm', 'tend', 'foretell', 'observe', 'gather'] as const;
export type DeedEffect = (typeof DEED_EFFECTS)[number];

export const DEED_EFFECT_LABELS: Record<DeedEffect, string> = {
  hunt: '猎杀',
  calm: '平息',
  tend: '养育',
  foretell: '占卜',
  observe: '洞察',
  gather: '搜寻',
};

export const PathwayDeedSchema = z.object({
  id: z.string().min(1),
  /** 属于哪条途径（project 口径 id） */
  pathway: z.string().min(1),
  name: z.string().min(1),
  /** 世界大事记里的文案；`{name}` 会替换成 NPC 的名字 */
  text: z.string().min(1),
  effect: z.enum(DEED_EFFECTS),
  /** 至少要走到哪一档才会做这件事（序列越小越强） */
  minSequence: z.number().int().min(0).max(9),
  /** 抽签权重（同一条途径的多个行为之间比） */
  weight: z.number().int().positive().default(30),
});

export type PathwayDeed = z.infer<typeof PathwayDeedSchema>;

/** 这个人现在做得了哪些事（按途径 + 序列过滤） */
export function deedsFor(deeds: readonly PathwayDeed[], pathway: string, sequence: number): PathwayDeed[] {
  return deeds.filter((d) => d.pathway === pathway && sequence <= d.minSequence);
}

/**
 * 按权重抽一条。
 *
 * `roll` 是 0—1 的随机数（判定层不认识随机源，与 npc-advance 同一手法）。
 */
export function pickDeed(pool: readonly PathwayDeed[], roll: number): PathwayDeed | null {
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, d) => sum + d.weight, 0);
  let cursor = roll * total;
  for (const deed of pool) {
    cursor -= deed.weight;
    if (cursor <= 0) return deed;
  }
  return pool[pool.length - 1]!;
}

/** 把文案里的 `{name}` 换成 NPC 的名字 */
export function renderDeedText(deed: PathwayDeed, name: string): string {
  return deed.text.replace(/\{name\}/g, name);
}

/** 这条行为值多少功绩（成神要看履历，所以「做了什么」都算数） */
export function deedMerit(effect: DeedEffect): number {
  switch (effect) {
    // 有真实世界影响的最值钱
    case 'hunt': return 4;
    case 'calm': return 6;
    case 'tend': return 5;
    // 信息与发现类次之
    case 'foretell': return 3;
    case 'observe': return 2;
    case 'gather': return 3;
  }
}
