/**
 * NPC 处理世界事件（M2.85 世界演化）—— **纯函数，无 IO**。
 *
 * ## 用户拍板
 *
 * > 「NPC 相当于一个有智慧的人机，事件也有可能被 NPC 解决」
 *
 * 在此之前，世界事件**只作用于玩家** —— 它们是背景噪音，到点自己过期，
 * 没有人会「回应」它们。这一层让 NPC 认领并处理事件。
 *
 * ## 「有智慧」体现在两处
 *
 *   1. **够不够格**：不同事件要不同层次的人来处理（传闻谁都能接，神话级灾厄只有高序列敢碰）
 *   2. **对不对路**：**同一件事，走在对应途径上的人优先** ——
 *      灾厄由战士 / 太阳 / 审判者处理，发现由阅读者 / 门处理，势力动向由黑皇帝 / 审判者处理
 *
 * 第 2 条正是「NPC 要做出符合自己途径的行为」在事件层的落地。
 */
import type { WorldEventType } from './events.ts';

/** 每类事件至少要多高的序列（数字越小越强） */
export const EVENT_MIN_SEQUENCE: Record<WorldEventType, number> = {
  calamity: 6,
  power: 4,
  faction: 6,
  environment: 7,
  discovery: 8,
  rumor: 9,
};

/** 这一类事件「最该由谁处理」——优先选走在这些途径上的人 */
export const EVENT_PREFERRED_PATHWAYS: Record<WorldEventType, readonly string[]> = {
  calamity: ['warrior', 'sun', 'arbiter', 'hunter'],
  power: ['lawyer', 'arbiter', 'seer'],
  faction: ['lawyer', 'spectator', 'arbiter'],
  environment: ['mother', 'sailor', 'sun'],
  discovery: ['reader', 'door', 'perfect', 'mystery_pryer'],
  rumor: ['spectator', 'seer', 'mystery_pryer', 'corpse_collector'],
};

/** 这一类事件值多少功绩（成神要看履历） */
export const EVENT_MERIT: Record<WorldEventType, number> = {
  calamity: 8,
  power: 6,
  faction: 4,
  environment: 3,
  discovery: 3,
  rumor: 1,
};

/** 这个人够不够格处理这一类事件 */
export function canHandleEvent(sequence: number, type: WorldEventType): boolean {
  return sequence <= EVENT_MIN_SEQUENCE[type];
}

/**
 * 在够格的人里挑**最对路**的那一位。
 *
 * 排序：先看途径是否在「最该由谁处理」里（对路的排前面），再比序列（强的优先），最后按 id 稳定排序。
 * 传进来的 `candidates` 应当已经过 `canHandleEvent` 过滤。
 */
export function pickHandler<T extends { npcId: string; sequence: number; pathways: readonly string[] }>(
  candidates: readonly T[],
  type: WorldEventType,
  roll = 0,
): T | null {
  if (candidates.length === 0) return null;
  const preferred = EVENT_PREFERRED_PATHWAYS[type];
  const onPath = candidates.filter((c) => c.pathways.some((p) => preferred.includes(p)));
  /*
   * ⚠️ 第一版在这里按序列排序（强的优先），实测结果是**永远同一个人**：
   * 300 天里 64 件事全部由安提哥努斯处理掉了 —— 那不是「有智慧的人机」，
   * 那是「一个全知全能的保姆」。改成：**在对路的人里随机挑**（roll 抽一个），
   * 只有对路的人一个都没有时才退回全体 —— 于是各有各的活。
   */
  const pool = onPath.length > 0 ? onPath : candidates;
  // 排序保证同一 roll 下结果稳定（可复现），再按 roll 取一位
  const sorted = [...pool].sort((a, b) => a.npcId.localeCompare(b.npcId));
  return sorted[Math.min(sorted.length - 1, Math.floor(roll * sorted.length))]!;
}

/** 处理完写进世界事件的那句话 */
export function handlingText(handlerName: string, type: WorldEventType, headline: string): string {
  const verb: Record<WorldEventType, string> = {
    calamity: '把这件事压了下去',
    power: '介入了这件事',
    faction: '出面调停了这件事',
    environment: '把那一带清理干净了',
    discovery: '先一步查清了这件事',
    rumor: '把这件事查实了',
  };
  return `${handlerName}${verb[type]} ——${headline}`;
}
