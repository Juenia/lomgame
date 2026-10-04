/**
 * M2.13：**神奇物品的被动效果**（在背包里就生效，不需要 `.使用`）。
 *
 * ## 为什么单独一个文件
 *
 * 四件神奇物品的效果散落在四条既有链路上（交易税 / 探索危险 / 扮演消化 / 占卜次数），
 * 而它们问的是**同一个问题**：「这个人包里现在有哪些被动物品，加起来是什么效果」。
 * 把那个问题收在这里，四条链路各自只加一行 —— 而不是各自去遍历一遍背包
 * （四份实现会漂，而「同一件披风在两个地方给不同的倍率」是最难查的一类 bug）。
 *
 * ## 为什么是「读背包」而不是「落一排 flag」
 *
 * 被动物品的存活状态**就是背包**：丢了、卖了、被抢了，效果自然消失。
 * 另写一份 flag 会多出「背包与 flag 不同步」这个状态（卖出去了但 flag 还亮着），
 * 而那正是 M2.5 货币改造时特意避开的那类账目 bug。
 * 代价是每次要查一遍背包（背包最多几十格），这个开销在文字游戏里可以忽略。
 */
import { timeOfDay } from '../../domain/world/clock.ts';
import type { RouterDeps } from '../index.ts';

export interface WonderEffects {
  /** 占卜次数 +N（占卜水晶） */
  divinationBonus: number;
  /** 交易税的倍率（幸运硬币 0.8 = -20%） */
  tradeTaxMultiplier: number;
  /** 探索危险的倍率（夜行披风：夜 0.85 / 昼 1.1），已按当前时段算好 */
  exploreDangerMultiplier: number;
  /** .扮演 的消化度倍率（记录笔记 1.1） */
  playDigMultiplier: number;
  /** 每日结算时额外增加的 MAD（占卜水晶每天 +1） */
  madPerDay: number;
}

/** 中性值：没有带任何神奇物品时的效果（**与 M2.12 的行为逐位一致**） */
export function neutralWonderEffects(): WonderEffects {
  return {
    divinationBonus: 0,
    tradeTaxMultiplier: 1,
    exploreDangerMultiplier: 1,
    playDigMultiplier: 1,
    madPerDay: 0,
  };
}

/**
 * 算出这个人此刻的被动物品效果。
 *
 * 多个同类物品**乘算**（两枚幸运硬币 = 0.8 × 0.8），而不是取最大值 ——
 * 取最大值会让「第二件完全没用」，而封印物与神奇物品是**可交易**的，
 * 那种规则会让玩家在交易后发现自己白买了。
 */
/*
 * M2.13 的 FLAG_AP_HALVED_DAYS / apRecoveryHalvedOf / decayApHalved
 * （时间沙漏的「接下来几天 AP 恢复减半」标记与每日递减）随 M2.85 的行动值移除一起删除。
 */

export function wonderEffectsOf(deps: RouterDeps, characterId: string, now: number): WonderEffects {
  const out = neutralWonderEffects();
  const night = timeOfDay(now) === 'night';
  for (const slot of deps.inventory.list(characterId)) {
    if (slot.quantity <= 0) continue;
    const item = deps.items.get(slot.itemId);
    if (!item || item.type !== 'wonder') continue;
    const effect = item.effect ?? {};
    if (typeof effect.divinationBonus === 'number') out.divinationBonus += effect.divinationBonus;
    if (typeof effect.tradeTaxMultiplier === 'number') {
      out.tradeTaxMultiplier *= effect.tradeTaxMultiplier;
    }
    const dangerMultiplier = night
      ? effect.exploreDangerMultiplierNight
      : effect.exploreDangerMultiplierDay;
    if (typeof dangerMultiplier === 'number') out.exploreDangerMultiplier *= dangerMultiplier;
    if (typeof effect.playDigMultiplier === 'number') {
      out.playDigMultiplier *= effect.playDigMultiplier;
    }
    if (typeof item.sideEffect?.mad === 'number') out.madPerDay += item.sideEffect.mad;
  }
  return out;
}
