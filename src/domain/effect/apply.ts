/**
 * 唯一数值入口（S1 §3.3 / W3-W4 硬约束）——禁止业务代码直接改 state。
 *
 * 语义：
 *  1) 先整体校验硬约束（DP 不可透支），任一被击穿 → 整批作废，返回 rejected；
 *  2) 再逐条应用，软约束按区间截断（区间可被能力覆盖，例如战士序列 8 的 HP 上限 +10）；
 *  3) 只有真正发生变化的字段才产生事件，无变化的 delta 静默丢弃；
 *  4) item 类型的 delta 不在这里改状态，只产出 item_delta 事件（物品账在 InventoryRepo）。
 *
 * W4 扩展：NumericField 增加 sequence，让「序列变化」也走唯一入口并留事件。
 */
import type { CharacterState, DomainEvent } from '../character/types.ts';
import type { StatCaps } from '../ability/ability.ts';
import { clamp } from '../character/rules.ts';

export type NumericField = 'hp' | 'mp' | 'mad' | 'cor' | 'dig' | 'dp' | 'sequence';

export type EffectDelta =
  | { type: NumericField; value: number }
  | { type: 'item'; itemId: string; quantity: number };

export interface ApplyResult {
  newState: CharacterState;
  events: DomainEvent[];
  /** 整批被拒时的原因；成功时为 undefined */
  rejected?: string;
}

export const CLAMP: Record<NumericField, readonly [number, number]> = {
  hp: [0, 100],
  mp: [0, 100],
  mad: [0, 100],
  cor: [0, 100],
  dig: [0, 100],
  dp: [0, 10],
  sequence: [0, 9],
};

/** 硬约束：不可透支（M2.85 起只剩命运点 DP） */
export const HARD_FLOOR: readonly NumericField[] = ['dp'];

function clampOf(field: NumericField, caps: StatCaps): readonly [number, number] {
  return caps[field] ?? CLAMP[field];
}

export function apply(
  state: CharacterState,
  deltas: readonly EffectDelta[],
  reason: string,
  /**
   * 事件时间戳 —— **必填，没有默认值**（M2.21 任务 6，铁律 1）。
   *
   * 此前是 `now: number = Date.now()`：一个**隐式时钟入口**。铁律 1 说「判定层纯函数，
   * 无 IO、无时钟硬编码」，而默认参数让「忘了传 now」不报错、只让那次调用依赖运行时刻 ——
   * 症状是最难查的一种：单跑绿、全量跑时两条用例互相轮流红（M2.20 §7.1）。
   * 去掉默认值之后，漏传在 `tsc` 处就暴露，不靠人记住。
   */
  now: number,
  /** 判定 seed：写进事件日志，复现时用同一 seed 重建 RNG（W2 §3.3） */
  seed?: string,
): ApplyResult {
  return applyWithCaps(state, deltas, reason, now, seed, {});
}

/** 带能力上限覆盖的 apply：能力只改上下限，不改结算规则 */
export function applyWithCaps(
  state: CharacterState,
  deltas: readonly EffectDelta[],
  reason: string,
  /** 同上：**必填**（M2.21 任务 6）。`caps` 保留默认值 —— 它是配置不是时钟。 */
  now: number,
  seed?: string,
  caps: StatCaps = {},
): ApplyResult {
  for (const delta of deltas) {
    if (delta.type === 'item') continue;
    if (!HARD_FLOOR.includes(delta.type)) continue;
    const [min] = clampOf(delta.type, caps);
    // M2.7.6：sequence 允许为 null（普通人没有序列）。null 按 0 读，
    // 于是「普通人扣序列」会走到下面的不足分支而不是 NaN —— 静默变 NaN 才是最难查的。
    const current = state[delta.type] ?? 0;
    if (current + delta.value < min) {
      return {
        newState: state,
        events: [],
        rejected: `${reason}: ${delta.type} 不足（当前 ${current}，需要 ${-delta.value}）`,
      };
    }
  }

  const newState: CharacterState = { ...state };
  const events: DomainEvent[] = [];

  for (const delta of deltas) {
    if (delta.type === 'item') {
      if (delta.quantity === 0) continue;
      events.push({
        type: 'item_delta',
        characterId: state.id,
        payload: { itemId: delta.itemId, quantity: delta.quantity },
        reason,
        ...(seed ? { seed } : {}),
        createdAt: now,
      });
      continue;
    }

    const [min, max] = clampOf(delta.type, caps);
    // 同上：sequence 为 null 时按 0 读，写回时一定是数字（晋升写的就是数字）
    const before = newState[delta.type] ?? 0;
    const after = clamp(before + delta.value, min, max);
    if (after === before) continue;

    newState[delta.type] = after;
    events.push({
      type: `${delta.type}_delta`,
      characterId: state.id,
      payload: { before, after, delta: delta.value },
      reason,
      ...(seed ? { seed } : {}),
      createdAt: now,
    });
  }

  newState.updatedAt = now;
  return { newState, events };
}
