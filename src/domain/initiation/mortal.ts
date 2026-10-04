/**
 * 普通人的判定层（M2.7.6）：**纯函数，无 IO**。
 *
 * 这一层回答三个问题：
 *   1. 他的属性上限是多少（保护期的唯一实现方式）；
 *   2. 他探索时世界对他做了什么修正（危险 ×1.3 / 掉落 ×0.4 / 换事件池）；
 *   3. 哪些动作他做不了，以及做不了的时候该说什么。
 *
 * 为什么不把这些判断散在各个命令里：普通人阶段是一段**有始有终的状态**，
 * 如果「能不能扮演」写在 play.ts、「能不能晋升」写在 promote.ts，
 * 那么将来新增第 30 条指令时没人会记得它也要挡一下。
 * 集中在这里之后，命令层只需要一句 mortalBlockReason(state, '扮演')。
 */
import { INITIATION, MORTAL_EVENTS } from '../../config/numeric.ts';
import type { StatCaps } from '../ability/ability.ts';
import type { CharacterState } from '../character/types.ts';

/** 尚未走上途径 */
export function isMortal(state: Pick<CharacterState, 'pathwayStatus'>): boolean {
  return state.pathwayStatus !== 'initiated';
}

/**
 * 普通人的属性上限。
 *
 * 这是**保护期**的实现方式，不是惩罚：mortalCaps.mad(20) / cor(10) 都低于
 * 失控闸门（NUMERIC.lossOfControl 的 65/65），于是普通人在数学上不可能失控 ——
 * 不需要在失控判定里写一句「if 普通人 return false」，那会变成一处会漂移的特例。
 *
 * 已入途径时返回空对象：能力的加成照旧由 capsFromAbilityEffects 提供，两条合并即可。
 */
export function mortalCapsFor(state: Pick<CharacterState, 'pathwayStatus'>): StatCaps {
  if (!isMortal(state)) return {};
  const caps = INITIATION.mortalCaps;
  return {
    hp: [0, caps.hp],
    mp: [0, caps.mp],
    mad: [0, caps.mad],
    cor: [0, caps.cor],
  };
}

export interface MortalExploreModifiers {
  dangerMultiplier: number;
  dropMultiplier: number;
}

/**
 * 未入途径的探索修正。
 *
 * 危险 ×1.3 / 掉落 ×0.4：没有能力的人进入同一片雾，代价更大、收获更少。
 * 这是「为什么玩家想入途径」的经济动机本身 —— 如果普通人探索与非凡者一样舒服，
 * 那「获得途径」就只是收集品，而不是一件事。
 *
 * 已入途径时返回中性值（1/1），所以调用点不需要分支。
 */
export function mortalExploreModifiers(
  state: Pick<CharacterState, 'pathwayStatus'>,
): MortalExploreModifiers {
  if (!isMortal(state)) return { dangerMultiplier: 1, dropMultiplier: 1 };
  return {
    dangerMultiplier: INITIATION.mortalExplore.dangerMultiplier,
    dropMultiplier: INITIATION.mortalExplore.dropMultiplier,
  };
}

/** 普通人专属事件池的 id 清单（与 src/cards/mortal/*.yaml 一一对应） */
export const MORTAL_EVENT_IDS: readonly string[] = MORTAL_EVENTS.pool;

/** 这张卡是不是普通人专属（用它把两个池子分开，两个方向都要过滤） */
export function isMortalCard(cardId: string): boolean {
  return MORTAL_EVENT_IDS.includes(cardId);
}

/**
 * 普通人做不了的动作 → 拒绝文案。
 *
 * 措辞口径（M2.7.6 §2.2）：这些拒绝**不能**说「因为你是普通人」——
 * 玩家还不知道「途径」是什么，系统也不该替他说破。
 * 每一条都在说他缺什么（没有序列 / 手上没有能占卜的东西），而不是他没有身份。
 */
export const MORTAL_ACTION_BLOCKS: Readonly<Record<string, string>> = {
  /*
   * M2.7.7：.魔药 以前**不在**这张表里 —— 于是普通人一路走到判定层，
   * 拿到的是一句「材料不足：主材料·灰雾结晶（需要 1，现有 0）」。
   * 那句回执比拒绝更糟：它暗示「凑齐材料就能调」，而他连配方是什么都还不知道。
   *
   * 例外（命令层用 allowWhen 放行）：手里**真有一张纸**的普通人必须能调 ——
   * 那是「自己找到配方」那条路的最后一步，见 router/commands/brew.ts。
   */
  魔药: '你还没有走上途径，不知道魔药为何物。',
  扮演: '你想模仿什么，但连自己在模仿什么都说不清。这条路要等你身上有了别的东西才走得通。',
  晋升: '你没有序列，也就没有下一个位置可去。',
  占卜: '你手上没有任何能用来占卜的东西，问了也不会有回答。',
  仪式: '你还没有资格举行仪式 —— 仪式需要先有一个身份。',
  干扰: '你看不见别人在做什么，也就无从干扰。',
};

/** 这个动作对普通人是被挡住的吗；是则给出理由，否则 null */
export function mortalBlockReason(
  state: Pick<CharacterState, 'pathwayStatus'>,
  action: string,
): string | null {
  if (!isMortal(state)) return null;
  return MORTAL_ACTION_BLOCKS[action] ?? null;
}

/** 可注入随机源（与 domain/character/types.ts 同一个约定） */
export interface MortalRng {
  next(): number;
}
