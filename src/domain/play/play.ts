/**
 * 一次 .扮演 的完整判定（纯函数，可注入 seed → 可复现）
 *
 * 对应需求方案 §4「扮演消化：消化度上升，疯狂/污染可能上升」：
 *   - 消化度按 §7 公式结算（文档给定，确定性）
 *   - “可能上升”由暴露判定承担：命中暴露时 exposure = 1（多涨 0.3 DIG），
 *     并允许上层从 random 卡池抽一张暴露卡（卡的 effects 才负责涨 MAD/COR）
 */
import { NUMERIC } from '../../config/numeric.ts';
import { computeDigNext } from '../character/rules.ts';
import type { CharacterState } from '../character/types.ts';
import type { EffectDelta } from '../effect/apply.ts';
import { createSeededRng } from '../rng.ts';
import { scorePlay, type PlayScoreBreakdown } from './score.ts';
import type { PathwayTags } from './tags.ts';

export const PLAY = {
  /** 暴露概率：W5 用模拟器按真实分布定终值（见 config/numeric.ts） */
  exposureChance: NUMERIC.play.exposureChance,
  /** 仪式辅助：接入仪式玩法后才有值 */
  ritual: NUMERIC.play.ritual,
} as const;

/**
 * 世界侧对扮演的影响（M2.2，全部来自 config/numeric.ts 的 world 段）：
 *   - 夜晚：不眠者消化 ×1.2，其他途径每次扮演 MAD +1
 *   - 天气：各自的 playMad / playDig（见 world.weather.effects）
 */
export interface PlayWorldInput {
  /** 每次扮演额外增加的 MAD（≥0 加罚，<0 减罚） */
  mad: number;
  /** 消化倍率（不眠者的夜晚加成、天气的 playDig） */
  digMultiplier: number;
}

export interface ResolvePlayInput {
  state: CharacterState;
  text: string;
  tags: PathwayTags;
  usage: ReadonlyMap<string, number>;
  seed: string;
  /** M2.2：不传 = 中性（模拟器与旧用例行为不变） */
  world?: PlayWorldInput;
}

export interface PlayOutcome {
  breakdown: PlayScoreBreakdown;
  /** rng 原始抽样值，留档便于排查“为什么这次没暴露” */
  exposureRoll: number;
  exposed: boolean;
  exposure: 0 | 1;
  pollutionPenalty: number;
  digBefore: number;
  digAfter: number;
  gained: number;
  /** M2.2：本次扮演由世界时钟 / 天气额外带来的 MAD（0 = 无） */
  worldMad: number;
  /** M2.2：世界给的消化倍率（1 = 无） */
  digMultiplier: number;
  deltas: EffectDelta[];
}

/**
 * 「激进行为 MAD 涨得更猛」（M2.2 §5.6 的补偿旋钮）：当天第 threshold 次之后的每次扮演额外 MAD。
 *
 * 本版**关闭**（`NUMERIC.play.escalation.madPerExtraPlay = 0` → 恒返回 0）：
 * 200×14 实测证明世界时钟单独就把激进型 / 稳健型的差距拉开了，不需要补偿。
 * 机制保留给后续分布变化时使用；依据与启用门槛写在 config/numeric.ts 的同名注释里。
 *
 * @param playedToday 本次之前当天已经完成的 .扮演 次数（0 = 今天第一次）
 */
/**
 * **今天第 N 次扮演的消化度乘数**（M2.118）—— 软上限，不是硬限制。
 *
 * > 用户：「主要在于可以**一天刷满**，但又**不想限制扮演的次数**」
 *
 * 前 `digSoftCap` 次全额；超出之后按 `digDiminishRate` 连乘：
 * 第 7 次 60%、第 8 次 36%、第 9 次 21.6% … —— **还能演，只是赚不到东西了**。
 *
 * `playedToday` 是**本次之前**已经演过的次数（调用方从 dailyCounters 取）。
 */
export function playDigDiminish(playedToday: number): number {
  const thisTime = playedToday + 1;
  const overflow = Math.max(0, thisTime - NUMERIC.play.digSoftCap);
  if (overflow <= 0) return 1;
  return Math.pow(NUMERIC.play.digDiminishRate, overflow);
}

export function playEscalationMad(playedToday: number): number {
  const cfg = NUMERIC.play.escalation;
  if (cfg.madPerExtraPlay <= 0) return 0;
  const thisPlay = playedToday + 1;
  return Math.max(0, thisPlay - cfg.threshold) * cfg.madPerExtraPlay;
}

export function resolvePlay(input: ResolvePlayInput): PlayOutcome {
  const { state, text, tags, usage, seed } = input;
  const breakdown = scorePlay(text, tags, usage);

  const rng = createSeededRng(seed);
  const exposureRoll = rng.next();
  const exposed = exposureRoll < PLAY.exposureChance;
  const exposure = exposed ? 1 : 0;

  // 污染越高，扮演越难消化（§7 的污染惩罚项）
  const pollutionPenalty = state.cor / 100;

  const digBefore = state.dig;
  const digAfter = computeDigNext(
    { dig: state.dig },
    { matchScore: breakdown.final, exposure, ritual: PLAY.ritual, pollutionPenalty },
  );

  // M2.2：世界加成只作用在「本次涨了多少」上，公式形状（computeDigNext）一个字没改
  const digMultiplier = input.world?.digMultiplier ?? 1;
  const rawGain = digAfter - digBefore;
  const gained = rawGain * digMultiplier;
  const worldMad = input.world?.mad ?? 0;

  const deltas: EffectDelta[] = [];
  if (gained !== 0) deltas.push({ type: 'dig', value: gained });
  if (worldMad !== 0) deltas.push({ type: 'mad', value: worldMad });

  return {
    breakdown,
    exposureRoll,
    exposed,
    exposure,
    pollutionPenalty,
    digBefore,
    digAfter: digBefore + gained,
    gained,
    worldMad,
    digMultiplier,
    deltas,
  };
}
