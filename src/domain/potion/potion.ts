/**
 * 魔药调制与服用（W3：纯函数，注入 rng，无 IO）
 *
 * 成功率公式：base_success - corPenaltyWeight × COR/100，clamp 5%—95%
 * 失控判定与需求方案 §8 共用 computeLossOfControlProbability（不重复实现公式）
 */
import { NUMERIC } from '../../config/numeric.ts';
import { clamp, computeLossOfControlProbability, rollLossOfControlWith } from '../character/rules.ts';
import type { CharacterState, Rng } from '../character/types.ts';
import type { EffectDelta } from '../effect/apply.ts';
import { potionProductId, recipeMaterials, type MaterialNeed, type RecipeDef } from './recipe.ts';

/** COR 越高，调制越容易失败 */
export function computePotionSuccess(recipe: RecipeDef, state: Pick<CharacterState, 'cor'>): number {
  const raw = recipe.base_success - NUMERIC.potion.corPenaltyWeight * (state.cor / 100);
  return clamp(raw, NUMERIC.potion.successFloor, NUMERIC.potion.successCeil);
}

export function potionMpCost(): number {
  return NUMERIC.potion.mpCost;
}

export interface BrewOutcome {
  ok: true;
  seed: string;
  successChance: number;
  successRoll: number;
  success: boolean;
  /** 需要扣除的材料（命令层先校验后扣） */
  consumed: MaterialNeed[];
  productItemId: string;
  deltas: EffectDelta[];
  narrative: string[];
}

/** M2.2 世界侧对魔药的影响（月圆的 +15% 成功率 / ×1.1 失控概率、天气的同类项） */
export interface PotionWorldInput {
  /** 成功率增量（绝对百分点） */
  successBonus: number;
  /** 失控概率倍率 */
  lossOfControlMultiplier: number;
}

export function resolveBrew(input: {
  state: CharacterState;
  recipe: RecipeDef;
  rng: Rng;
  seed: string;
  /** M2.2：不传 = 中性 */
  world?: PotionWorldInput;
}): BrewOutcome {
  // 月圆 +15%（任务书第二节）：加成加在成功率上，仍然夹在 successFloor—successCeil 之间
  const successChance = clamp(
    computePotionSuccess(input.recipe, input.state) + (input.world?.successBonus ?? 0),
    NUMERIC.potion.successFloor,
    NUMERIC.potion.successCeil,
  );
  const successRoll = input.rng.next();
  const success = successRoll < successChance;

  const deltas: EffectDelta[] = [{ type: 'mp', value: -NUMERIC.potion.mpCost }];
  if (!success) {
    deltas.push({ type: 'cor', value: input.recipe.cor_on_fail + NUMERIC.potion.failExtraCor });
    const mad = input.recipe.mad_on_fail + NUMERIC.potion.failExtraMad;
    if (mad !== 0) deltas.push({ type: 'mad', value: mad });
  }

  const narrative = success
    ? [
        `仪式走完了：${input.recipe.ritual}。`,
        '液体安静下来，颜色停在它该停的地方。',
      ]
    : [
        '仪式走到一半就散了，关键的那一步你没有做对。',
        '失败的东西不会消失，它只是换个地方待着。',
      ];

  return {
    ok: true,
    seed: input.seed,
    successChance,
    successRoll,
    success,
    consumed: recipeMaterials(input.recipe),
    productItemId: potionProductId(input.recipe),
    deltas,
    narrative,
  };
}

export interface DrinkOutcome {
  ok: true;
  seed: string;
  deltas: EffectDelta[];
  lossOfControl: boolean;
  controlChance: number;
  controlRoll: number;
  firstTime: boolean;
  narrative: string[];
}

/** 服用：DIG 上涨、MAD 上升，随后按 §8 做一次失控判定 */
export function resolveDrink(input: {
  state: CharacterState;
  potionItemId: string;
  rng: Rng;
  seed: string;
  firstTime: boolean;
  /** M2.2：月圆 / 天气给的失控概率倍率 */
  world?: PotionWorldInput;
}): DrinkOutcome {
  const deltas: EffectDelta[] = [
    { type: 'dig', value: NUMERIC.potion.digOnDrink },
    { type: 'mad', value: NUMERIC.potion.madOnDrink },
  ];
  const narrative: string[] = ['魔药下肚。先是极冷，然后是最熟悉的那个声音开始说话。'];
  if (input.firstTime) narrative.push('你第一次听见自己体内有别人的回声。');

  let lossOfControl = false;
  let controlChance = 0;
  let controlRoll = 0;

  if (NUMERIC.potion.controlCheckOnDrink) {
    // 用服药后的 MAD/COR 投影做判定：同一个公式，不另写一套
    const projected = {
      mad: input.state.mad + NUMERIC.potion.madOnDrink,
      cor: input.state.cor,
      // M2.33（P5）：闸门按序列取 —— 服药的失控判定与每日 tick 必须用同一档
      sequence: input.state.sequence,
    };
    // M2.2：倍率（月圆 ×1.1、天气倍率）只乘概率，硬闸门与公式本身不动
    const multiplier = input.world?.lossOfControlMultiplier ?? 1;
    controlChance = clamp(computeLossOfControlProbability(projected) * multiplier, 0, 1);
    const probe: Rng = {
      next: () => {
        controlRoll = input.rng.next();
        return controlRoll;
      },
    };
    lossOfControl = rollLossOfControlWith(projected, probe, multiplier);
    if (lossOfControl) {
      deltas.push({ type: 'mad', value: NUMERIC.potion.controlMadBonus });
      deltas.push({ type: 'cor', value: NUMERIC.potion.controlCorBonus });
      narrative.push('有一瞬间，你的手不是你的手。等你夺回来时，地上多了些东西。');
    }
  }

  return {
    ok: true,
    seed: input.seed,
    deltas,
    lossOfControl,
    controlChance,
    controlRoll,
    firstTime: input.firstTime,
    narrative,
  };
}

/** 首次服用的解锁标记：按途径区分，为 W4 晋升预留 */
export function abilityFlag(recipe: Pick<RecipeDef, 'pathway' | 'seq'>): string {
  return `ability_${recipe.pathway}_${recipe.seq}`;
}

export const FIRST_POTION_FLAG = 'first_potion_taken';
