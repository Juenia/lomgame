/**
 * 判定层：全部为纯函数，无 IO、无副作用、无硬编码随机源（S1 §3.1）
 * 数值来源：《诡秘之主：群星低语》需求方案 §7，失控公式按 S1 §9 决策改为软启动。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { CharacterState, PathwayId, Rng } from './types.ts';

/**
 * 途径的中文名（玩家看到的那个）。
 *
 * ## 两种口径混着用，这是历史账（M2.76 登记，不强行统一）
 *
 * | 口径 | 取值 | 用它的途径 |
 * | --- | --- | --- |
 * | **序列 0 名**（＝原作途径名） | 愚者 / 完美者 / 母亲 / 门 / 太阳 / 死神… | 大多数 |
 * | **序列 9 名** | 战士 / 不眠者 / 水手 / 阅读者 | 这四条是 M2.7—M2.26 期间定的 |
 *
 * 为什么不统一：这四个名字出现在存档、内容表、回执与卡面上，
 * 改名要动整条链路，而收益只是「表里看着整齐」——**代价大于收益，所以记账不改**。
 * 新落的 15 条一律取**序列 0 名**（与 `诡秘之主原作数据/01-途径与序列/途径总表.yaml` 的 `途径名` 一致）。
 */
export const PATHWAY_LABELS: Record<PathwayId, string> = {
  // —— 已实现的 7 条 ——
  seer: '愚者',
  warrior: '战士',
  sleepless: '不眠者',
  sailor: '水手',
  perfect: '完美者',
  reader: '阅读者',
  mother: '母亲',
  // —— M2.76 落地的 15 条（序列 0 名）——
  door: '门',
  sun: '太阳',
  corpse_collector: '死神',
  error: '错误',
  mystery_pryer: '隐者',
  spectator: '空想家',
  apothecary: '月亮',
  arbiter: '审判者',
  assassin: '魔女',
  criminal: '深渊',
  hunter: '红祭司',
  lawyer: '黑皇帝',
  monster: '命运之轮',
  prisoner: '被缚者',
  secrets_supplicant: '倒吊人',
};

/**
 * 开放的途径白名单。
 *
 * **M2.76：22 条正途径全部开放** —— 这一栏从「三条试水」一路扩到全集。
 * 现在它与 `ALL_PATHWAYS` 是同一份清单，保留它是为了两件事：
 *   1. `create.ts` 与出生池读的是它（语义是「本版可玩」），而 `ALL_PATHWAYS` 是「有称号表」；
 *   2. 将来若要临时关掉某条途径做灰度，改这一处即可，不用动称号表。
 * ⚠️ 它与 `ALL_PATHWAYS` 应该保持一致；不一致时以**本清单**为准（它是玩法口径）。
 */
export const OPEN_PATHWAYS: PathwayId[] = Object.keys(PATHWAY_LABELS) as PathwayId[];

/**
 * 玩家输入 → 途径 id。
 *
 * M2.76：**从 `PATHWAY_LABELS` 派生**，不手抄第二份 ——
 * 22 条途径手抄两遍（中文名一遍、英文 id 一遍）必然会漏掉一条，
 * 而漏掉的症状是「这条途径玩家打不出来」（`.创建 死神` 返回「不认识的途径」），
 * 那在 22 条里很难被注意到。
 *
 * 额外补充的是**原作译名的别名**：数据集里的途径名与项目用语有时不同
 * （如 `corpse_collector` 项目叫「死神」、原作序列 9 叫「收尸人」），
 * 两个都收，玩家打哪个都认。
 */
export const PATHWAY_ALIASES: Record<string, PathwayId> = {
  ...Object.fromEntries(
    (Object.keys(PATHWAY_LABELS) as PathwayId[]).flatMap((id) => [
      [PATHWAY_LABELS[id], id],
      [id, id],
    ]),
  ),
  // 原作用语别名（序列 9 名与途径名不一致的那几条）
  收尸人: 'corpse_collector',
  偷盗者: 'error',
  学徒: 'door',
  歌颂者: 'sun',
  观众: 'spectator',
  秘祈人: 'secrets_supplicant',
  窥秘人: 'mystery_pryer',
  药师: 'apothecary',
  仲裁人: 'arbiter',
  刺客: 'assassin',
  罪犯: 'criminal',
  猎人: 'hunter',
  律师: 'lawyer',
  怪物: 'monster',
  囚犯: 'prisoner',
  通识者: 'perfect',
  耕种者: 'mother',
};

/* ------------------------------------------------------------------ *
 * 消化度：DIG_next = DIG + 0.6×扮演匹配 + 0.3×事件暴露
 *                        + 0.1×仪式辅助 - 0.5×污染惩罚
 * ------------------------------------------------------------------ */
export const DIG_WEIGHTS = NUMERIC.digWeights;

export interface DigInputs {
  /** 0—1 扮演匹配 */
  matchScore: number;
  /** 0—1 事件暴露 */
  exposure: number;
  /** 0—1 仪式辅助 */
  ritual: number;
  /** 0—1 污染惩罚 */
  pollutionPenalty: number;
}

export function computeDigNext(state: Pick<CharacterState, 'dig'>, input: DigInputs): number {
  const next =
    state.dig +
    DIG_WEIGHTS.matchScore * input.matchScore +
    DIG_WEIGHTS.exposure * input.exposure +
    DIG_WEIGHTS.ritual * input.ritual -
    DIG_WEIGHTS.pollution * input.pollutionPenalty;
  return clamp(next, 0, 100);
}

/* ------------------------------------------------------------------ *
 * 晋升成功率：P = 70% + 20%×DIG - 5%×(9-序列) - 15%×MAD - 10%×COR
 * 结果限制在 5%—95%
 * ------------------------------------------------------------------ */
export const PROMOTION = NUMERIC.promotion;

export function computePromotionSuccess(
  // M2.7.6：sequence 用交叉类型收紧到 number —— 普通人没有序列，也就没有晋升可言，
  // 调用点在命令层已经用 isInitiated() 挡过，类型上再挡一次
  state: Pick<CharacterState, 'dig' | 'mad' | 'cor'> & { sequence: number },
): number {
  const p =
    PROMOTION.base +
    PROMOTION.digBonus * (state.dig / 100) -
    PROMOTION.sequencePenalty * (9 - state.sequence) -
    PROMOTION.madPenalty * (state.mad / 100) -
    PROMOTION.corPenalty * (state.cor / 100);
  return clamp(p, PROMOTION.floor, PROMOTION.ceil);
}

/* ------------------------------------------------------------------ *
 * 失控：S1 §9 决策改为软启动
 *   P = (max(MAD-Tm,0) + max(COR-Tc,0)) / divisor（闸门与 divisor 在 config/numeric.ts）
 *   硬闸门保留：MAD < Tm 且 COR < Tc 时连骰子都不掷
 * W5 旧闸门 80/70 在实测分布下是空闸门（实测各画像 MAD P90 ≤ 76）；
 * M2.1 按实测分布回灌重定为 50/45 + divisor 90，依据见 docs/M2-失控重定报告.md。
 * ------------------------------------------------------------------ */
/** 调参旋钮在 config/numeric.ts；W5 用真实分布定 divisor 终值 */
export const LOSS_OF_CONTROL = NUMERIC.lossOfControl;

/**
 * P5 落地（M2.33）：序列 `sequence` 的失控闸门。
 *
 * **缺失键报错**（与 `planned` / `digLadder` 同一条纪律，K19）：不回退到一个默认档 ——
 * 「这一档忘了写」与「这一档就是 65」必须能分开。
 *
 * `sequence === null` = **普通人**（没有序列）⇒ 按**最低序列那一档**读：他还没有往上走过，
 * 而那一档正是 M2.1 的 65 —— 所以普通人的行为一个字都不变。
 */
export function lossOfControlThresholdFor(sequence: number | null): { mad: number; cor: number } {
  const table = LOSS_OF_CONTROL.thresholdBySequence as Record<number, { mad: number; cor: number }>;
  const key = sequence ?? 9;
  const threshold = table[key];
  if (threshold === undefined) {
    throw new Error(
      `lossOfControl.thresholdBySequence 里没有序列 ${key} 的档 —— 不隐含一个默认闸门（K19）。` +
        '（0—9 十个键必须全部显式写出）',
    );
  }
  return threshold;
}

export function computeLossOfControlProbability(
  state: Pick<CharacterState, 'mad' | 'cor'> & { sequence: number | null },
): number {
  // 只统计「超出阈值」的部分：低于本序列的闸门不累积任何风险
  const threshold = lossOfControlThresholdFor(state.sequence);
  const excess = Math.max(0, state.mad - threshold.mad) + Math.max(0, state.cor - threshold.cor);
  return clamp(excess / LOSS_OF_CONTROL.divisor, 0, 1);
}

export function rollLossOfControl(
  state: Pick<CharacterState, 'mad' | 'cor'> & { sequence: number | null },
  rng: Rng,
): boolean {
  return rollLossOfControlWith(state, rng, 1);
}

/**
 * 同上，但允许乘一个外部倍率（M2.2：月圆失控概率 +10%、天气失控倍率）。
 * 硬闸门保持：MAD 与 COR 都没过阈时连骰子都不掷 —— 倍率不会把空闸门变成有风险。
 */
export function rollLossOfControlWith(
  state: Pick<CharacterState, 'mad' | 'cor'> & { sequence: number | null },
  rng: Rng,
  multiplier = 1,
): boolean {
  // P5 落地：硬闸门也按序列取 —— 与概率公式同一个门槛，不能一处全局一处分序列
  const threshold = lossOfControlThresholdFor(state.sequence);
  if (state.mad < threshold.mad && state.cor < threshold.cor) {
    return false;
  }
  return rng.next() < clamp(computeLossOfControlProbability(state) * multiplier, 0, 1);
}

/* ------------------------------------------------------------------ */

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 只读采样，用于调参与交付说明取证；不改变任何数值 */
export function lossOfControlCurve(
  points: ReadonlyArray<readonly [number, number]>,
): Array<{ mad: number; cor: number; probability: number }> {
  return points.map(([mad, cor]) => ({
    mad,
    cor,
    /*
     * P5 落地（M2.33）：曲线工具是**取证用的固定尺子**（跨版本比同一条曲线），
     * 所以它固定按**最低序列那一档**读（`sequence: null` = 普通人档 = M2.1 的 65）。
     * 这不是「默认值」，是「这把尺子量的是哪一档」—— 写死在这里，不随调用方变。
     */
    probability: computeLossOfControlProbability({ mad, cor, sequence: null }),
  }));
}
