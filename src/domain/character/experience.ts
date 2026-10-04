/**
 * 历练（M2.85 RPG 化 A）—— **纯函数，无 IO**。
 *
 * ## 用户对 A 的关键修正
 *
 * > 「不需要天赋树，因为技能都是序列自带的」
 *
 * 这条把 A 的形状定死了，而且它与**原著设定**是一致的：
 *
 *   · **序列就是等级** —— 升到哪一档，那一档的能力自然就有（不需要点技能）
 *   · 于是「成长」能做的只剩两件事：**你经历过什么**（历练），以及**它把你练成了什么样**（属性）
 *
 * 所以本文件**不提供**：技能点、天赋树、手动分配、第二套等级。
 * 它只回答一个问题：**这个人历练到什么程度了，以及这让他强了多少。**
 *
 * ## 经验从哪来
 *
 * 全部挂在**已经存在的动作**上（不新增玩法，只是给现有行为记账）：
 *
 *   play    扮演（一次角色扮演）    +1
 *   explore 探索（走进一个地方）    +2
 *   battle  战斗胜利（按对手强弱）  +（10 减去对手序列）
 *   digest  消化魔药（推进消化度）  +5
 *
 * 这些是**项目派生值**（原著没有经验值这种概念），放在 NUMERIC.growth 当旋钮。
 */
import { NUMERIC } from '../../config/numeric.ts';

/** 经验来源（挂点用字符串常量，避免各处手写） */
export const EXP_SOURCES = ['play', 'explore', 'battle', 'digest'] as const;
export type ExpSource = (typeof EXP_SOURCES)[number];

export const EXP_SOURCE_LABELS: Record<ExpSource, string> = {
  play: '扮演',
  explore: '探索',
  battle: '战斗',
  digest: '消化魔药',
};

interface GrowthConfig {
  perPlay: number;
  perExplore: number;
  perDigest: number;
  /** 战斗胜利：base 减去对手序列（越强越多） */
  battleBase: number;
  /** 历练档的步长：第 n 档的增量是 step 乘 growth 的 (n-2) 次方 */
  rankStep: number;
  rankGrowth: number;
  /** 每档的属性加成 */
  hpPerRank: number;
  mpPerRank: number;
  /** 每档减少的失控压力（0 到 1 的小数） */
  madResistPerRank: number;
}

function cfg(): GrowthConfig {
  const raw = (NUMERIC as unknown as { growth?: Partial<GrowthConfig> }).growth ?? {};
  return {
    perPlay: raw.perPlay ?? 1,
    perExplore: raw.perExplore ?? 2,
    perDigest: raw.perDigest ?? 5,
    battleBase: raw.battleBase ?? 10,
    rankStep: raw.rankStep ?? 20,
    rankGrowth: raw.rankGrowth ?? 2,
    hpPerRank: raw.hpPerRank ?? 5,
    mpPerRank: raw.mpPerRank ?? 3,
    madResistPerRank: raw.madResistPerRank ?? 0.02,
  };
}

/** 某一次行为给多少经验 */
export function expFor(source: ExpSource, context: { opponentSequence?: number } = {}): number {
  const c = cfg();
  switch (source) {
    case 'play': return c.perPlay;
    case 'explore': return c.perExplore;
    case 'digest': return c.perDigest;
    case 'battle': return Math.max(1, c.battleBase - (context.opponentSequence ?? 9));
  }
}

/**
 * 累计经验对应的**历练档**（1 起）。
 *
 * 阈值指数递增 ——「历练」本来就该越来越难：档 1 是 0 点，档 2 要 step 点，
 * 档 3 要在档 2 之上再加 step 乘 growth，以此类推。档位不封顶。
 */
export function rankOf(exp: number): number {
  const c = cfg();
  let rank = 1;
  let need = c.rankStep;
  let total = 0;
  while (total + need <= exp && rank < 99) {
    total += need;
    need *= c.rankGrowth;
    rank += 1;
  }
  return rank;
}

/** 升到下一档还差多少经验 */
export function expToNextRank(exp: number): number {
  const c = cfg();
  let rank = 1;
  let need = c.rankStep;
  let total = 0;
  while (total + need <= exp && rank < 99) {
    total += need;
    need *= c.rankGrowth;
    rank += 1;
  }
  return total + need - exp;
}

/** 这一档带来的属性加成（档 1 = 无加成） */
export function growthBonusOf(exp: number): { hp: number; mp: number; madResist: number } {
  const c = cfg();
  const steps = rankOf(exp) - 1;
  return {
    hp: steps * c.hpPerRank,
    mp: steps * c.mpPerRank,
    madResist: Math.min(0.5, steps * c.madResistPerRank),
  };
}

/** 一句人话（回执与 .属性 共用） */
export function growthLine(exp: number): string {
  return `历练 ${rankOf(exp)} 档（累计 ${exp} 点，距下一档还差 ${expToNextRank(exp)}）`;
}
