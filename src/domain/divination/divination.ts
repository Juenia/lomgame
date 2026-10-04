/**
 * 占卜（W4）：愚者序列 8 能力「占卜冷却减半、每日多 1 次」的落点。
 * 纯函数：只负责抽一段卜象文本，消耗与限制由指令层按能力效果结算。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { AbilityEffect } from '../ability/ability.ts';
import type { Rng } from '../character/types.ts';
import type { TarotCard } from './tarot.ts';

export const DIVINATION_COUNTER_KEY = 'divination';

export function divinationDailyLimit(effects: AbilityEffect): number {
  return NUMERIC.divination.dailyLimit + (effects.divinationDailyBonus ?? 0);
}

export function divinationMpCost(): number {
  return NUMERIC.divination.mpCost;
}

export interface DivinationOutcome {
  ok: true;
  seed: string;
  roll: number;
  index: number;
  text: string;
  /**
   * M2.85 内容填充 P1：这一次摊开的**塔罗牌**（大阿卡那）。
   * 牌池为空时为 null —— 判定层不隐含默认，调用方必须显式处理「没有牌」这种情况。
   */
  tarot: {
    number: number;
    name: string;
    nameEn: string;
    pathwayName: string;
    symbolism: string;
  } | null;
}

/** 从卜象池里按 seed 抽一条；文本里的 {{片段}} 由通用模板渲染 */
export function resolveDivination(input: {
  texts: readonly string[];
  rng: Rng;
  seed: string;
  /** M2.85 内容填充 P1：塔罗牌池（RouterDeps.tarot）。缺省 = 不抽牌 */
  cards?: readonly TarotCard[];
}): DivinationOutcome {
  const pool = input.texts.length > 0 ? input.texts : ['雾太厚了，什么也看不清。'];
  const roll = input.rng.next();
  const index = Math.min(pool.length - 1, Math.floor(roll * pool.length));
  /*
   * M2.85 内容填充 P1：**再取一次随机数抽牌**。
   *
   * ⚠️ 用第二个取值而不是复用 `roll`：复用会让既有卜象文本与牌面绑死
   * （改了牌池就平移所有卜象）。第二次取值对既有行为零影响 ——
   * 没有牌池时这一次取值根本不会发生。
   */
  const cards = input.cards ?? [];
  let tarot: DivinationOutcome['tarot'] = null;
  if (cards.length > 0) {
    const cardRoll = input.rng.next();
    const card = cards[Math.min(cards.length - 1, Math.floor(cardRoll * cards.length))] ?? cards[0]!;
    tarot = {
      number: card.number,
      name: card.name,
      nameEn: card.nameEn,
      pathwayName: card.pathwayName,
      symbolism: card.symbolism,
    };
  }
  return { ok: true, seed: input.seed, roll, index, text: pool[index] ?? pool[0]!, tarot };
}
