/**
 * 扮演打分（W2 §3.1）
 *
 * 流水线：关键词命中 → 每日上限过滤 → 递减惩罚 → 多样性加成 → clamp 到 0—1
 * 每个环节都保留中间值，方便 .扮演 回复里告诉玩家「为什么只涨这么多」。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { PathwayTags } from './tags.ts';

export const PLAY_SCORE = NUMERIC.playScore;

export interface PlayScoreBreakdown {
  /** 关键词命中的原始分（未扣上限、未递减） */
  raw: number;
  matchedCore: string[];
  matchedSecondary: string[];
  matchedForbidden: string[];
  /** 因为当日已达上限而不计分的标签 */
  cappedTags: string[];
  /** 命中标签里当日重复最多的次数，递减分母用它 */
  dominantRepeat: number;
  afterRepeat: number;
  /** 今日（含本次）命中过的不同标签数 */
  distinctTagsToday: number;
  diversity: number;
  /** 最终 matchScore，喂给 computeDigNext */
  final: number;
}

/** 纯关键词包含匹配；不认识 input 的语法，也不做任何推断 */
export function computeMatchScore(input: string, tags: PathwayTags): number {
  let score = 0;
  for (const tag of tags.core) if (input.includes(tag)) score += PLAY_SCORE.coreWeight;
  for (const tag of tags.secondary) if (input.includes(tag)) score += PLAY_SCORE.secondaryWeight;
  for (const tag of tags.forbidden) if (input.includes(tag)) score += PLAY_SCORE.forbiddenWeight;
  return clamp01(score);
}

/** 复读惩罚：同一标签当日用得越多，收益越低 */
export function applyRepeatPenalty(score: number, todayCount: number): number {
  return score / (PLAY_SCORE.repeatDivisorBase + todayCount);
}

/** 多样性加成：今天玩的标签种类越多，收益越高 */
export function diversityMultiplier(distinctTagsToday: number): number {
  if (distinctTagsToday <= 1) return 1;
  return Math.min(
    PLAY_SCORE.diversityMax,
    1 + PLAY_SCORE.diversityPerTag * (distinctTagsToday - 1),
  );
}

export function usageCount(usage: ReadonlyMap<string, number>, tag: string): number {
  return usage.get(tag) ?? 0;
}

/**
 * 完整打分。usage = 该角色今日已用的 标签→次数。
 * 注意：forbidden 标签不受每日上限影响，永远计负分。
 */
export function scorePlay(
  input: string,
  tags: PathwayTags,
  usage: ReadonlyMap<string, number> = new Map(),
): PlayScoreBreakdown {
  const matchedCore: string[] = [];
  const matchedSecondary: string[] = [];
  const matchedForbidden: string[] = [];
  const cappedTags: string[] = [];

  let raw = 0;
  const counted: string[] = [];

  const consider = (tag: string, weight: number, positive: boolean): void => {
    if (!input.includes(tag)) return;
    if (positive && usageCount(usage, tag) >= PLAY_SCORE.tagDailyCap) {
      cappedTags.push(tag);
      return;
    }
    raw += weight;
    counted.push(tag);
    if (weight > 0) {
      if (weight >= PLAY_SCORE.coreWeight) matchedCore.push(tag);
      else matchedSecondary.push(tag);
    } else {
      matchedForbidden.push(tag);
    }
  };

  for (const tag of tags.core) consider(tag, PLAY_SCORE.coreWeight, true);
  for (const tag of tags.secondary) consider(tag, PLAY_SCORE.secondaryWeight, true);
  for (const tag of tags.forbidden) consider(tag, PLAY_SCORE.forbiddenWeight, false);

  raw = clamp01(raw);

  const dominantRepeat = counted.reduce(
    (max, tag) => Math.max(max, usageCount(usage, tag)),
    0,
  );
  const afterRepeat = clamp01(applyRepeatPenalty(raw, dominantRepeat));

  const distinctTagsToday = new Set([...usage.keys(), ...counted]).size;
  const diversity = diversityMultiplier(distinctTagsToday);
  const final = clamp01(afterRepeat * diversity);

  return {
    raw,
    matchedCore,
    matchedSecondary,
    matchedForbidden,
    cappedTags,
    dominantRepeat,
    afterRepeat,
    distinctTagsToday,
    diversity,
    final,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
