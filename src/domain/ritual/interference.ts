/**
 * 干扰判定（M2.5）：纯函数，注入 rng。
 *
 * 设计意图（任务书 §4.3）：**每日 1 次 + 消耗材料**，让干扰是「决策」而不是「骚扰」。
 * 所以这里的公式很短，真正的约束在命令层（每日计数 + 背包扣减）。
 *
 *   成功率 = 0.4 + 0.3 × (对方 MAD / 100)，clamp 0.1—0.8
 *   成功   → 对方仪式阶段成功率 -20%
 *   失败   → 干扰者 COR +5
 */
import { NUMERIC } from '../../config/numeric.ts';
import { clamp } from '../character/rules.ts';
import type { Rng } from '../character/types.ts';
import type { InterferenceResult } from './types.ts';

const CFG = NUMERIC.interference;

/** 对方越疯，越容易被搅 —— 这也是「别顶着高 MAD 做仪式」的又一条理由 */
export function interferenceChance(targetMad: number): number {
  const raw = CFG.baseSuccess + CFG.madFactor * (Math.max(0, targetMad) / 100);
  return clamp(raw, CFG.successMin, CFG.successCap);
}

export interface ResolveInterferenceInput {
  /** 被打扰者的 MAD（越高越好下手） */
  targetMad: number;
  rng: Rng;
}

export function resolveInterference(input: ResolveInterferenceInput): InterferenceResult {
  const chance = interferenceChance(input.targetMad);
  const roll = input.rng.next();
  const success = roll < chance;
  return {
    success,
    chance,
    roll,
    deltas: success ? [] : [{ type: 'cor', value: CFG.failCorPenalty }],
    narrative: success
      ? [
          '你把一小撮盐撒在他的圈外。',
          '那边念咒的声音顿了一下 —— 他察觉到了，但已经晚了。',
        ]
      : [
          '你刚靠近就被发现了。',
          '他头也没回，你却觉得有什么东西顺着你的目光爬了回来。',
        ],
  };
}