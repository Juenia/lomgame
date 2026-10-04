/**
 * 本地势力权重（M2.7.6 引入；M2.85 起职责收窄）。**纯函数，无 IO**。
 *
 * M2.85：势力引导那条玩法线（「有人注意到你」的邀约、任务、每日掷骰）整体下线。
 * 这份内容表（factions.yaml）留下来只剩一个职责：
 * 决定「在这座城市翻到的线索，指向哪条途径」——
 * 你在一座城市里翻到的东西，自然是这座城市里流传的东西。
 *
 * 原来的 todayGuidedChance / rollGuided / pickGuidedTask / isTaskDone /
 * offerExpiresAt / stageAfter / guidedContactText / guidedRecipeText
 * 都随引导玩法一并删除；保底改由 NUMERIC.initiation.cluePityDays 承接
 * （见 ./initiate.ts 的 resolveExplore）。
 */
import { INITIATION } from '../../config/numeric.ts';
import { weightedPick } from '../random.ts';
import type { Rng } from '../character/types.ts';
import type { GuidedFaction } from './types.ts';

/** 一天多少毫秒（与世界时钟无关，只用来数「第几天」） */
const DAY_MS = 86_400_000;

/**
 * 角色出生以来的第几天（创建当天 = 第 1 天）。
 *
 * 用 UTC 日界切分，与 infra/date.ts 的 dateKey 同一口径 ——
 * 两处口径不一致的话，会出现「tick 说是第 3 天、判定说是第 2 天」这类
 * 只在跨零点前后复现的错位。M2.85 起它服务于线索保底（cluePityDays）。
 */
export function mortalDayOf(bornAt: number, now: number): number {
  const born = Math.floor(bornAt / DAY_MS);
  const today = Math.floor(now / DAY_MS);
  return today - born + 1;
}

/**
 * 从一座城市的势力里按权重挑一家 —— 线索的途径就落在他头上。
 *
 * 权重来自 NUMERIC.initiation.factionPriority（primary 0.7 / secondary 0.3）——
 * 它表达的是「这座城市里谁的东西更常流传」，不是配额：一家 primary 势力
 * 不会独占线索，只是更常出现。白银之城那种「三家都隐秘」的样本因此可以表达成
 * 「三家都是 secondary」而完全不需要改代码。
 */
export function pickGuidedFaction(
  factions: readonly GuidedFaction[],
  rng: Rng,
): GuidedFaction | null {
  if (factions.length === 0) return null;
  const picked = weightedPick(
    factions,
    (faction) =>
      faction.priority === 'primary'
        ? INITIATION.factionPriority.primary
        : INITIATION.factionPriority.secondary,
    rng,
  );
  return picked ?? null;
}
