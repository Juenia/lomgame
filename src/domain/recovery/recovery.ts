/**
 * 失控恢复（W4：纯函数计划）
 *   .休息：MAD-5、HP+20，每日 1 次
 *   .净化：COR-15、MAD-5，消耗材料，每日 1 次（M2.85：行动值已移除）
 * 两者都会解除失控状态（与每日 tick 的自然解除并列的第二条恢复路径）。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { CharacterState } from '../character/types.ts';
import type { EffectDelta } from '../effect/apply.ts';
import type { MaterialNeed } from '../potion/recipe.ts';

export type RecoveryKey = 'rest' | 'purify';

export const REST_COUNTER_KEY = 'rest';
export const PURIFY_COUNTER_KEY = 'purify';

export interface RecoveryPlan {
  key: RecoveryKey;
  dailyLimit: number;
  deltas: EffectDelta[];
  /** 注意：这是可变字段，应急开关会在指令层把数量减半 */
  materials: MaterialNeed[];
  clearsLostControl: boolean;
  privateText: string[];
  groupText: string;
}

export function planRest(state: CharacterState): RecoveryPlan {
  const config = NUMERIC.recovery.rest;
  return {
    key: 'rest',
    dailyLimit: config.dailyLimit,
    deltas: [
      { type: 'mad', value: config.mad },
      { type: 'hp', value: config.hp },
    ],
    materials: [],
    clearsLostControl: state.status === 'lost_control',
    privateText: [
      '你把自己关在屋里，睡了很久。',
      '醒来时耳朵里的声音退到了更远的地方。',
    ],
    groupText: '【{name}】去休息了。',
  };
}

export function planPurify(state: CharacterState): RecoveryPlan {
  const config = NUMERIC.recovery.purify;
  return {
    key: 'purify',
    dailyLimit: config.dailyLimit,
    deltas: [
      { type: 'cor', value: config.cor },
      { type: 'mad', value: config.mad },
    ],
    materials: config.materials.map((need) => ({ itemId: need.itemId, qty: need.qty })),
    clearsLostControl: state.status === 'lost_control',
    privateText: [
      '你按规程把圣盐与银粉摆成一个闭合的圈。',
      '污染被逼出来一点，落在纸上，像烧过的边。',
    ],
    groupText: '【{name}】做了一次净化。',
  };
}

export function recoveryCounterKey(plan: RecoveryPlan): string {
  return plan.key === 'rest' ? REST_COUNTER_KEY : PURIFY_COUNTER_KEY;
}
