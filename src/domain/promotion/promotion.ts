/**
 * 晋升判定（W4：纯函数，注入 rng）
 *
 * 复现：seed = messageId:characterId:now:promote，写进 domain_events.seed。
 * 防卡死：连续失败达到 failStreakThreshold 后，下一次成功率 +failStreakBonus。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { abilityFlag } from '../ability/ability.ts';
/*
 * M2.20（K7）：失败扣料的比例与算法**复用仪式那一份**（materialLossOf，向上取整）。
 * 依赖方向是 promotion → ritual 单向的（ritual 不 import promotion），不会成环。
 */
import { materialLossOf } from '../ritual/resolve.ts';
import { clamp, computePromotionSuccess } from '../character/rules.ts';
import type { CharacterState, InitiatedCharacter, Rng } from '../character/types.ts';
import type { EffectDelta } from '../effect/apply.ts';
import type { MaterialNeed, RecipeDef } from '../potion/recipe.ts';

export interface PromotionRequirement {
  digThreshold: number;
  /** 晋升材料 = 本途径配方主材料 × mainMaterialMultiplier */
  materials: MaterialNeed[];
  /** 必须先服下本序列的魔药（解锁 ability_<途径>_<序列>） */
  requiredFlag: string;
  targetSequence: number;
}

/**
 * 晋升需求。
 *
 * M2.7.6：入途径本身走的是**另一条路**（.调制 + .服用 序列 9 魔药，见 router/commands/drink.ts），
 * 所以这里要求「已经入途径」—— 类型上是初级的守卫，调用点也已经挡过。
 */
/**
 * 这条配方通向的序列要多少消化度。
 *
 * M2.12：**门槛不再是一个定值**。序列 9→8 是 60（W4 定的，没有变），序列 8→7 是 85 ——
 * 判据写在配方自己身上（recipe.seq），而不是由调用方传进来：
 * 「哪一号配方通向哪一层」本来就是一条内容事实，散在命令层会漂移。
 */
/**
 * P4 落地（M2.33）：按**配方 seq** 取 DIG 门槛。
 *
 * 为什么单独开一个「按 seq」的入口：vplayer 的决策层（`src/vplayer/decide.ts`）手上
 * 只有配方的**局部视图**（id / seq / main / aux …，不含 ritual 等字段），
 * 以前它因此**自己抄了一份两档分支** —— P4 改成五档之后那一份不会跟着变，
 * 症状是「vplayer 磨到 80 就停手、反复撞需要 85」（K18：一端有人守、另一端没有）。
 * ⇒ 给它一个只需要 seq 的入口，同源就从「人工保证」变成「同一个函数」。
 */
export function digThresholdForSeq(seq: number): number {
  const threshold = (NUMERIC.promotion.digLadder as Record<number, number>)[seq];
  if (threshold === undefined) {
    /*
     * P4 落地（M2.33）：**缺失键报错，不隐含一个默认门槛。**
     *
     * 旧实现是 `recipe.seq <= 8 ? 80 : 60` —— 一个**闭区间分支**，任何没预料到的 seq
     * 都会被静默吞进某一档（K19 的形状：读者无法区分「设计值」与「忘了写」）。
     * 现在阶梯是一张显式表，没有的键就是**真的没有**。
     */
    throw new Error(
      `DIG 阶梯里没有配方 seq=${seq} 的档 —— 不隐含一个默认门槛（K19）。` +
        '要么在 numeric.promotion.digLadder 里补这一档，要么确认那张配方该不该存在。',
    );
  }
  return threshold;
}

/** 按配方取门槛（内容表里的调用方用这个；两边最终走同一个 `digThresholdForSeq`） */
export function digThresholdFor(recipe: RecipeDef): number {
  return digThresholdForSeq(recipe.seq);
}

/**
 * P6 落地（M2.33）：**`sequenceGating.planned` 的生产读取点。**
 *
 * `docs/M2.28-拍板清单.md` 的 P6 拍的是「与批次 A 同批启用」，而那张表**一直没有读取点** ——
 * 它是 K19 的标本（有类型、有冻结测试、注释写着设计意图，就是没人读）。M2.33 接上它。
 *
 * ## 键是**目标序列**，不是当前序列
 *
 * 任务书里写的是 `planned[character.sequence]`，**那是错的**，现场有三条证据：
 *
 *   1. 同段的 `active` 注释写死了「key = 晋升后的目标序列」（`numeric.ts` 的 sequenceGating 段）；
 *   2. 表的键域是 **0—8**（M2.31 补全的九个键）—— 那正是**目标序列**的域；
 *      若键是当前序列，域必须是 0—9，而**表里没有 9** ⇒ 序列 9 的玩家（所有人入途径后的第一次晋升）
 *      一进来就撞「缺失键报错」；
 *   3. 设计意图表（README「高序列晋升惩罚」）写的是「8→7 成功率 ×0.9」——
 *      `planned[7] = 0.9` 与之对得上；按当前序列读会得到 `planned[8] = 1.0`（不惩罚），矛盾。
 *
 * ⇒ 读 `planned[state.sequence - 1]`，即 `planned[targetSequence]`。
 *
 * ## 缺失键报错（K19）
 *
 * 不回退到一个默认值 —— 「没写」与「写了 0.5」必须能被区分开。
 */
export function sequenceGatingFor(targetSequence: number): number {
  const planned = NUMERIC.promotion.sequenceGating.planned as Record<number, number>;
  const multiplier = planned[targetSequence];
  if (multiplier === undefined) {
    throw new Error(
      `sequenceGating.planned 里没有目标序列 ${targetSequence} 的键 —— 不隐含 0（K19）。` +
        '（0—8 九个键必须全部显式写出，见 docs/M2.31-批次B前置.md §一）',
    );
  }
  return multiplier;
}

export function promotionRequirement(recipe: RecipeDef, state: InitiatedCharacter): PromotionRequirement {
  return {
    digThreshold: digThresholdFor(recipe),
    materials: recipe.main.map((need) => ({
      itemId: need.itemId,
      qty: need.qty * NUMERIC.promotion.mainMaterialMultiplier,
    })),
    requiredFlag: abilityFlag(recipe.pathway, state.sequence),
    targetSequence: Math.max(0, state.sequence - 1),
  };
}

export interface PromotionCheckInput {
  /** M2.7.6：晋升的前提是**已经入途径**（普通人没有序列可晋升） */
  state: InitiatedCharacter;
  requirement: PromotionRequirement;
  /** 当前拥有的材料数量查询 */
  ownedOf: (itemId: string) => number;
  hasRequiredFlag: boolean;
}

export type PromotionCheck = { ok: true } | { ok: false; reason: string };

export function checkPromotion(input: PromotionCheckInput): PromotionCheck {
  const { state, requirement } = input;

  if (state.sequence <= 0) return { ok: false, reason: '你已经到序列 0 了，没有更高的位置。' };
  /*
   * ⚠️ **P6 的「关闭」判定不在这里**（M2.33 实测踩到，写在代码里免得下一个人再放回来）：
   *
   * `checkPromotion` 是 `.晋升` 与 `.仪式` **共用**的资格检查 —— `ritual.ts:105` 也调它。
   * 把 `planned[target] <= 0 ⇒ 拒绝` 写进这个函数，`planned[5] = 0` 时会把**两条路一起关掉**，
   * 而那正是 P7 警告过的形状：玩家（vplayer 尤其）永久卡住、一直撞同一条拒绝（K13）。
   * 设计意图是「`.晋升` 关闭 ⇒ `.仪式` 是**唯一路径**」，不是「两条路都断」。
   *
   * ⇒ 关闭判定在**命令层**（`promote.ts`，只作用于 `.晋升`），这一层只管资格。
   */
  if (state.status === 'lost_control') {
    return { ok: false, reason: '你现在处于失控状态，先 .休息 或 .净化 稳住自己。' };
  }
  if (!input.hasRequiredFlag) {
    return { ok: false, reason: '你还没有服下本序列的魔药，晋升无从谈起（先 .魔药 再 .服用）。' };
  }
  if (state.dig < requirement.digThreshold) {
    return {
      ok: false,
      reason: `消化度不足（需要 ${requirement.digThreshold}，当前 ${state.dig.toFixed(1)}），继续扮演。`,
    };
  }

  const missing = requirement.materials.filter((need) => input.ownedOf(need.itemId) < need.qty);
  if (missing.length > 0) {
    const detail = missing
      .map((need) => `${need.itemId}（需要 ${need.qty}，现有 ${input.ownedOf(need.itemId)}）`)
      .join('、');
    return { ok: false, reason: `晋升材料不足：${detail}` };
  }
  return { ok: true };
}

export interface PromotionChance {
  base: number;
  failBonus: number;
  /** P6 落地（M2.33）：`sequenceGating.planned[目标序列]` —— `.晋升` 的高序列惩罚乘数 */
  gating: number;
  chance: number;
}

/**
 * 连续失败保护在这里生效；公式本身仍来自 W1 的 `computePromotionSuccess`。
 *
 * **P6 落地（M2.33）**：`.晋升` 的成功率还要乘上 `sequenceGating.planned[目标序列]`。
 *
 *     chance = clamp(base × gating + failBonus, floor, ceil)
 *
 * 两点口径：
 *   · `gating` 只乘 **base** —— 「连续失败保护」是一个**绝对加成**（+10 个百分点），
 *     它的语义是「防卡死」，不该被高序列惩罚折算掉；
 *   · `.仪式` **不走这里** —— 仪式有自己的 `RitualChanceInput`，
 *     而 `planned` 那张表的名字就叫「高序列**晋升**惩罚」（README 里 `.仪式` 那一列写的是「唯一路径」）。
 */
export function promotionChance(
  state: Pick<CharacterState, 'dig' | 'mad' | 'cor'> & { sequence: number },
  fails: number,
  /** 目标序列（= `requirement.targetSequence`）：乘数按它取，不是按当前序列 */
  targetSequence: number,
): PromotionChance {
  const base = computePromotionSuccess(state);
  const failBonus = fails >= NUMERIC.promotion.failStreakThreshold ? NUMERIC.promotion.failStreakBonus : 0;
  const gating = sequenceGatingFor(targetSequence);
  return {
    base,
    failBonus,
    gating,
    chance: clamp(base * gating + failBonus, NUMERIC.promotion.floor, NUMERIC.promotion.ceil),
  };
}

export interface PromotionOutcome {
  ok: true;
  seed: string;
  chance: PromotionChance;
  roll: number;
  success: boolean;
  consumed: MaterialNeed[];
  deltas: EffectDelta[];
  status: CharacterState['status'];
  flagsToSet: string[];
  targetSequence: number;
  narrative: string[];
}

export function resolvePromotion(input: {
  /** M2.7.6：只有已入途径的角色有序列可升 */
  state: InitiatedCharacter;
  requirement: PromotionRequirement;
  fails: number;
  rng: Rng;
  seed: string;
}): PromotionOutcome {
  const chance = promotionChance(input.state, input.fails, input.requirement.targetSequence);
  const roll = input.rng.next();
  const success = roll < chance.chance;

  const deltas: EffectDelta[] = success
    ? [
        { type: 'sequence', value: -1 },
        { type: 'mad', value: NUMERIC.promotion.madOnSuccess },
        { type: 'cor', value: NUMERIC.promotion.corOnSuccess },
      ]
    : [
        { type: 'mad', value: NUMERIC.promotion.madOnFail },
        { type: 'cor', value: NUMERIC.promotion.corOnFail },
      ];

  const narrative = success
    ? [
        '魔药在你体内找到了它要找的位置。',
        `你听不见自己的心跳了，但你听得见更远的东西。序列 ${input.requirement.targetSequence}。`,
      ]
    : [
        '你差一点就摸到了。',
        '失败的东西留在体内，它不会自己离开。',
      ];

  return {
    ok: true,
    seed: input.seed,
    chance,
    roll,
    success,
    /*
     * M2.20（K7）：**成功全额扣，失败只扣一半**。
     *
     * 旧实现是两种情况都 `consumed: input.requirement.materials`（全额），
     * 而 .仪式 阶段 3 失败只损 50% —— 同一个失败两条路收两种费，
     * 与「两条等效的路」这个设计前提冲突（见 docs/m219_K7决定.md §2.1）。
     */
    consumed: success
      ? input.requirement.materials
      : materialLossOf(input.requirement.materials, NUMERIC.promotion.failMaterialLoss),
    deltas,
    status: success ? 'active' : 'injured',
    flagsToSet: success ? [abilityFlag(input.state.pathway, input.requirement.targetSequence)] : [],
    targetSequence: input.requirement.targetSequence,
    narrative,
  };
}
