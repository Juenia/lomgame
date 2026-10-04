/**
 * 多阶段判定（M2.5）：纯函数，注入 rng。
 *
 * 三个阶段（任务书 §3.3）：
 *   1 布置  固定 80%   失败 → 材料损 30%，仪式中断
 *   2 引导  固定 70%   失败 → 继续，但阶段 3 成功率 -20%
 *   3 融合  最终成功率  失败 → 材料损 50% + 重伤 + MAD +10
 *
 * **为什么拆成两次调用（开始 / 融合）而不是一口气跑完**：
 * 任务书 §4 的干扰必须有一个真实的作用点 —— 如果 `.仪式 开始` 当场就把三个阶段判完，
 * 「群内匿名播报某处有人在举行仪式」就成了一句废话（别人还没看到，仪式已经结束了），
 * `.干扰` 也无从下手。所以本轮把阶段 3 拆到 `.仪式 融合`：
 * `.仪式 开始` 处理阶段 1/2 并进入 running，窗口期内别人可以来搅局，玩家再回来融合。
 * 阶段 1/2 用固定成功率正是为此 —— 干扰只该影响最后一哆嗦，而不是回头改已经发生的事。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { clamp } from '../character/rules.ts';
import type { CharacterStatus, Rng } from '../character/types.ts';
import type { EffectDelta } from '../effect/apply.ts';
import type { MaterialNeed } from '../potion/recipe.ts';
import { ritualChance } from './preview.ts';
import type { RitualProfile, RitualStageDef } from './profile.ts';
import {
  RITUAL_STAGE_LABELS,
  type RitualChanceInput,
  type RitualOutcome,
  type RitualStageNo,
  type RitualStageResult,
} from './types.ts';

const RITUAL = NUMERIC.ritual;
const PROMOTION = NUMERIC.promotion;

/** 按比例算材料损失（向上取整：损 30% 时，2 份要真的少 1 份，不能四舍五入成 0） */
export function materialLossOf(materials: readonly MaterialNeed[], rate: number): MaterialNeed[] {
  return materials
    .map((need) => ({ itemId: need.itemId, qty: Math.ceil(need.qty * rate) }))
    .filter((need) => need.qty > 0);
}

/**
 * 阶段的旁白。
 *
 * M2.76：优先用**内容表给的那两句**（`ok_note` / `fail_note`）——
 * 高序列档多出来的「结障」「封印」两关在代码里没有对应文案，**也不该有**
 * （它们是内容，不是分支）。不传阶段定义时回落到 M2.5 的三关文案，
 * 于是既有用例仍走原来那一支，一个字节都不变。
 */
function stageNote(stage: RitualStageNo, success: boolean, def?: RitualStageDef): string {
  if (def !== undefined) return success ? def.okNote : def.failNote;
  if (stage === 1) {
    return success ? '布置：阵脚扎稳了。' : '布置：材料摆错了一处，仪式散了。';
  }
  if (stage === 2) {
    return success ? '引导：气机顺着走。' : '引导：有点不稳，但撑住了。';
  }
  return success ? '融合：魔药找到了它要找的位置。' : '融合：药性反噬，你被掀了出去。';
}

/** 一关在判定层看到的形状（内容表来的与缺省来的统一成这一个） */
interface SetupStage {
  label: string;
  base: number;
  fusePenalty: number;
  interrupts: boolean;
  materialLoss: number;
  /** 内容表给的定义（旁白从它取）；缺省两关没有，走 stageNote 的回落 */
  def?: RitualStageDef;
}

/**
 * 融合关之前的几关。
 *
 * **不传档位 = M2.5 的固定两关**（0.8 / 0.7、损 30% / 失败 −20%）——
 * 这条兼容不是顺手写的：它让「改判定层」这件事在既有用例上可验证。
 */
function setupStageDefs(profile?: RitualProfile): SetupStage[] {
  if (profile !== undefined) {
    return profile.stages
      .filter((stage): stage is RitualStageDef & { base: number } => stage.base !== null)
      .map((stage) => ({
        label: stage.label,
        base: stage.base,
        fusePenalty: stage.fusePenalty,
        interrupts: stage.interrupts,
        materialLoss: stage.materialLoss,
        def: stage,
      }));
  }
  return [
    {
      label: RITUAL_STAGE_LABELS[1],
      base: RITUAL.stage1Base,
      fusePenalty: 0,
      interrupts: true,
      materialLoss: RITUAL.stage1FailMaterialLoss,
    },
    {
      label: RITUAL_STAGE_LABELS[2],
      base: RITUAL.stage2Base,
      fusePenalty: RITUAL.stage2FailPenalty,
      interrupts: false,
      materialLoss: 0,
    },
  ];
}

/* ---------------- 阶段 1/2：`.仪式 开始` ---------------- */

export interface RitualSetupInput {
  chance: RitualChanceInput;
  materials: readonly MaterialNeed[];
  rng: Rng;
  /**
   * M2.76：该序列对应的仪式档位。
   *
   * **不传 = M2.5 的固定两关**（0.8 / 0.7）—— 这条兼容是这次改动可验证的前提：
   * 既有用例与模拟器不传它，于是行为逐位不变；生产链路（命令层）传它。
   */
  profile?: RitualProfile;
}

export interface RitualSetupResult {
  stages: RitualStageResult[];
  /** 阶段 1 就挂了：仪式中断 */
  interrupted: boolean;
  /** 成功通过到第几阶段（0 = 阶段 1 挂了，1 = 阶段 2 没撑住，2 = 两关都过） */
  reachedStage: number;
  materialLoss: MaterialNeed[];
  /**
   * M2.76：到融合关为止**累积**的惩罚（档位自己那一份 + 每关失败给的那一份）。
   *
   * 不传档位时它等于 M2.5 的 `reachedStage >= 2 ? 0 : stage2FailPenalty` ——
   * 也就是说这个字段**取代**了原来那个靠 `reachedStage` 推出来的隐式判据。
   * 为什么取代：`reachedStage >= 2` 只在「固定两关」下成立，多一关就失去意义。
   */
  fusePenalty: number;
  narrative: string[];
}

export function resolveRitualSetup(input: RitualSetupInput): RitualSetupResult {
  const stages: RitualStageResult[] = [];
  const defs = setupStageDefs(input.profile);
  /*
   * 累积惩罚：档位自己那一份打底，每关失败再加它自己那一份。
   * 不传档位时 = 0 + (阶段 2 失败 ? −0.2 : 0)，与 M2.5 逐位一致。
   */
  let fusePenalty = input.profile?.fusePenalty ?? 0;
  let reached = 0;

  for (let i = 0; i < defs.length; i += 1) {
    const def = defs[i]!;
    const no = (i + 1) as RitualStageNo;
    const roll = input.rng.next();
    const ok = roll < def.base;
    stages.push({
      stage: no,
      label: def.label,
      chance: def.base,
      roll,
      success: ok,
      note: stageNote(no, ok, def.def),
    });
    if (ok) {
      reached = i + 1;
      continue;
    }
    fusePenalty += def.fusePenalty;
    if (def.interrupts) {
      return {
        stages,
        interrupted: true,
        reachedStage: 0,
        materialLoss: materialLossOf(input.materials, def.materialLoss),
        fusePenalty,
        narrative:
          input.profile === undefined
            ? [
                '第一笔就画歪了。你看着地上的痕迹慢慢淡下去。',
                '好在只是布置阶段 —— 魔药还没倒进去，代价只是材料。',
              ]
            : [
                '第一关就没扎住。你看着地上的痕迹慢慢淡下去。',
                '好在魔药还没倒进去 —— 这一档的代价只是材料。',
              ],
      };
    }
  }

  const allPassed = reached === defs.length;
  return {
    stages,
    interrupted: false,
    reachedStage: reached,
    materialLoss: [],
    fusePenalty,
    /*
     * 旁白按「缺省档 / 内容表档」分两支：
     *   缺省档保留 M2.5 那两句**一字不改**（既有用例读的就是它们）；
     *   内容表档说「前置几关」，因为高序列档不止两关 —— 说「两关都过了」就成了假话。
     */
    narrative:
      input.profile === undefined
        ? allPassed
          ? ['两关都过了。剩下的就是把魔药倒进去 —— 那才是真正决生死的一步。']
          : ['引导那一下没稳住。还能继续，但最后一哆嗦会更难。']
        : allPassed
          ? ['前置的几关都过了。剩下的就是把魔药倒进去 —— 那才是真正决生死的一步。']
          : ['中间有一关没稳住。还能继续，但最后一哆嗦会更难。'],
  };
}

/* ---------------- 阶段 3：`.仪式 融合` ---------------- */

export interface RitualFuseInput {
  chance: RitualChanceInput;
  /** `.仪式 开始` 时通过到第几阶段（缺省档：1 = 阶段 2 没稳住，要 -20%） */
  setupStage: number;
  /**
   * M2.76：`resolveRitualSetup` 给的**累积惩罚**。
   *
   * 传了就用它，**不再看 `setupStage`** —— 那个判据（`>= 2 ? 0 : −0.2`）只在
   * 「固定两关」下成立，多一关就没有意义（4 关的档里 `setupStage >= 2` 恒真）。
   * 不传则完全走旧判据，既有用例因此不受影响。
   */
  fusePenalty?: number;
  materials: readonly MaterialNeed[];
  targetSequence: number;
  flagsToSet: readonly string[];
  rng: Rng;
}

export interface RitualFuseResult {
  stage: RitualStageResult;
  outcome: RitualOutcome;
  finalChance: number;
  materialLoss: MaterialNeed[];
  deltas: EffectDelta[];
  status: CharacterStatus;
  flagsToSet: string[];
  narrative: string[];
}

export function resolveRitualFuse(input: RitualFuseInput): RitualFuseResult {
  const breakdown = ritualChance(input.chance);
  const setupPenalty =
    input.fusePenalty ?? (input.setupStage >= 2 ? 0 : RITUAL.stage2FailPenalty);
  const stage3Chance = clamp(
    breakdown.final + setupPenalty,
    PROMOTION.floor,
    RITUAL.successCap,
  );
  const roll = input.rng.next();
  const success = roll < stage3Chance;
  const stage: RitualStageResult = {
    stage: 3,
    label: RITUAL_STAGE_LABELS[3],
    chance: stage3Chance,
    roll,
    success,
    note: stageNote(3, success),
  };

  if (success) {
    return {
      stage,
      outcome: 'success',
      finalChance: stage3Chance,
      materialLoss: input.materials.map((need) => ({ ...need })),
      deltas: [
        { type: 'sequence', value: -1 },
        { type: 'mad', value: NUMERIC.promotion.madOnSuccess },
        { type: 'cor', value: NUMERIC.promotion.corOnSuccess },
      ],
      status: 'active' as CharacterStatus,
      flagsToSet: [...input.flagsToSet],
      narrative: [
        '你听见自己身体里有什么东西归位了。',
        '从今往后，你不是刚才那个人了。',
      ],
    };
  }

  return {
    stage,
    outcome: 'fail',
    finalChance: stage3Chance,
    materialLoss: materialLossOf(input.materials, RITUAL.stage3FailMaterialLoss),
    deltas: [
      { type: 'mad', value: RITUAL.stage3FailMad },
      { type: 'cor', value: RITUAL.stage3FailCor },
    ],
    status: 'injured' as CharacterStatus,
    flagsToSet: [],
    narrative: [
      '药性反噬。你被掀出去，后背撞在墙上一动不动。',
      '材料烧掉了大半，剩下的是你自己的伤。',
    ],
  };
}

/** 结局 → 私聊 / 群聊的一句话（群内一律匿名，任务书 §4.4） */
export function outcomeLine(outcome: RitualOutcome, name: string): { private: string; group: string } {
  if (outcome === 'success') {
    return {
      private: '仪式完成：你晋升了。',
      group: '【' + name + '】的气息变了 —— 某条途径上有人往上走了一格。',
    };
  }
  if (outcome === 'fail') {
    return { private: '仪式失败：融合没有成立。', group: '某处传来一声闷响，然后是很长的安静。' };
  }
  return { private: '仪式中断：布置没撑住。', group: '某处的仪式还没开始就散了。' };
}