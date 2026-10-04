/**
 * 袭击判定（M2.6.1）：**纯函数，无 IO**。
 *
 * M2.6 的 `.袭击` 是无差别命中 —— 序列 9 打序列 5 和 9 打 9 一样容易。
 * 这不符合原作，也让「序列」这个核心资源失去意义。
 * 本模块把序列差做成三档判定：
 *
 *   diff = attackerSeq − targetSeq      （**正数 = 攻击者序列低，更弱**。序列 9 最低、0 最高）
 *
 *   diff ≥ +3   直接不可行，回执「你根本近不了他的身。」
 *   diff 1—2    命中率 × 0.4^diff、伤害 × 0.5^diff（双重衰减）
 *   diff 0      标准
 *   diff ≤ −1   命中率 × 1.2^(−diff)、伤害 × 1.1^(−diff)（加成）
 *   目标序列 ≤ 6 时，**命中了**还要过一道抗性判定（高序列的「非凡层面存在感」）
 *
 * 四条纪律（其中两条是 M2.6 踩过坑之后写下来的）：
 *
 *   1. **不该掷骰时不掷**：序列差 ≥ 3 被拦时 `rng.next()` 一次都不调用，
 *      否则同 seed 下别的判定会跟着漂。同理，抗性只在**真的命中**之后才掷。
 *   2. **命中率 clamp 到 1.0**：公式在 diff = −8 时给 2.15，不 clamp 的话
 *      「命中率 215%」会流进回执与报告。
 *   3. **判定层负责一切序列语义**：命令层拿到结果只做渲染 / 扣 AP / 落库，
 *      **不允许出现任何 `if (attackerSeq > targetSeq)`**。连「谁比谁强」这句人话
 *      都是本模块给出的（`gapLabel`），命令层不需要认识序列。
 *   4. **接口形状按任务书 §四**：`resolveAssault(input, rng) → AssaultResult`。
 *      `attackerState` / `targetState` 当前判定不读，保留给 M2.7 的封印物与状态加成。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { clamp } from '../character/rules.ts';
import type { CharacterState, Rng } from '../character/types.ts';

const CFG = NUMERIC.assault;

/** 序列差门控的配置形状 */
export type AssaultGating = typeof CFG.sequenceGating;

export interface AssaultInput {
  /** 攻击者序列（9 最低、0 最高） */
  attackerSeq: number;
  targetSeq: number;
  /** 当前判定不读；保留给 M2.7 的封印物 / 状态加成 */
  attackerState?: CharacterState;
  targetState?: CharacterState;
  /** 基础命中率（同序列时），由调用方从 numeric 取 */
  baseHit: number;
  /** **本次**袭击的基准伤害（调用方已按区间抽好），判定层只乘倍率 */
  baseDamage: number;
  /** 基准伤害上限（用于算「这一击最多能打多少」）；缺省 = baseDamage */
  baseDamageMax?: number;
  /**
   * **M2.9 追加的可选字段**：本次判定的命中修正（加性，-0.2 = 命中 -20%）。
   *
   * 战斗的「恐惧 -20%」「雾天 -10%」「夜视 +20%」都走这一个入口 ——
   * 它们与序列差是**两件独立的事**，加性叠加而不是互相乘进去，
   * 否则「弱 1 级 ×0.4 命中」再叠一个 -20% 会变成 0.2，而那是两个旋钮各管一半的结果。
   *
   * 默认 0 = 与 M2.6.1 的行为**逐位一致**（既有调用点一个都不用改）。
   */
  hitModifier?: number;
  /**
   * **M2.13 追加的可选字段**：本次判定**无视一次序列差拦截**（封印之刃）。
   *
   * M2.6.1 的文件头写着「`attackerState` / `targetState` 当前判定不读，
   * 保留给 M2.7 的封印物与状态加成」—— 这一位就是那个接口的兑现，
   * 只不过落点不是状态，而是**这一档拦截**。
   *
   * 它做两件事，缺一不可：
   *   1. 跳过 `diff >= blockThreshold` 的那道提前返回；
   *   2. 把**参与公式的 diff** 夹到「刚好没被拦」的那一档。
   *
   * 为什么第 2 条是必须的：`hitChanceOf` 与 `damageMultiplierOf` 的第一行都是
   * `if (diff >= blockThreshold) return 0` —— 只跳过拦截、仍然拿真实 diff 去算的话，
   * 结果是「命中率 0%、伤害 1 点」，等于什么都没做。
   *
   * 默认 false = 与 M2.6.1 的行为**逐位一致**（既有调用点一个都不用改）。
   */
  ignoreSequenceGap?: boolean;
  /**
   * **M2.85（挑战神）**：这一击**不受高序列抗性影响**。
   *
   * 为什么必须有：`resistChanceOf(targetSeq)` 对序列 0 的目标给出接近 100% 的抗性 ——
   * 实测玩家（序列 1）对着神打了 **40 回合一次都没命中**，全部是「被挡下了」。
   * 那不是「神很强」，那是**公式上不可能**。原著里天使之王挑战真神是可能的，
   * 所以神战豁免这一层，胜负交回给命中、伤害与回合数。
   *
   * 默认 false = 与既有行为逐位一致。
   */
  ignoreResist?: boolean;
}

/** 被拦的两种原因（统计与报告按它分类） */
export type AssaultBlockReason = 'sequence_gap' | 'resist';

export interface AssaultResult {
  blocked: boolean;
  /** blocked 时必填；其他情况为 undefined */
  reason?: string;
  blockedBy?: AssaultBlockReason;
  hit?: boolean;
  damage?: number;
  hitChance: number;
  /** 按序列差缩放后的伤害上限（报告里的"伤害期望上界"） */
  damageMax: number;
  /** 序列差：正数 = 攻击者序列低（更弱） */
  diff: number;
  /** 序列差的人话（回执直接用；命令层不做任何比较） */
  gapLabel: string;
  /** 命中判定的抽样值（写进 domain_events 供复现） */
  roll: number;
  /** 是否掷过抗性骰 */
  resistChecked: boolean;
  /** 抗性是否挡住了这一击 */
  resisted: boolean;
  resistChance: number;
  /** 抗性骰的抽样值；没掷过则为 null */
  resistRoll: number | null;
  /** 高打低时要覆盖的通缉等级；null = 用默认（触发源对应的 1 级） */
  wantedLevelOverride: number | null;
  /** 赏金缩放倍率（1 = 不缩放） */
  bountyMultiplier: number;
  /**
   * M2.13：这一次判定**真的用上了「无视序列差拦截」**没有。
   *
   * 与入参那两个字段是**两件事**：入参说「带着封印之刃」，
   * 这一位说「这一刀确实是因为它才递出去的」——
   * 序列差本来就没到拦截线时，它是 false（回执就不该夸功）。
   * 报告里「封印之刃救了几次」直接数它。
   */
  ignoredSequenceGap: boolean;
  /**
   * M2.85 世界演化（**挑战神**）：这一击**不受高序列抗性影响**。
   *
   * 为什么必须有这个开关：`resistChanceOf(targetSeq)` 对抗序列 0 的目标会给出接近 100% 的抗性
   * —— 实测玩家（序列 1）对着神打了 **40 回合，一次都没命中**，全部被判「被挡下了」。
   * 那样「神明并非不可战胜」就只是句话：不是玩家不够强，是**公式上根本不可能**。
   * 原著里天使之王挑战真神是可能的，所以神战把这一层豁免掉，胜负交回给数值与回合。
   *
   * ⚠️ 这是**结果**里的字段（「这一次真的豁免了没有」），与入参的 `ignoreResist` 是两件事 ——
   * 与 `ignoredSequenceGap` 同一口径。
   */
  ignoredResist: boolean;
}

/* ------------------------------------------------------------------ *
 * 查表与公式（全部只读 numeric，本文件不写任何常数）
 * ------------------------------------------------------------------ */

/** 命中率：clamp 到 [0, 1] */
export function hitChanceOf(diff: number, gating: AssaultGating = CFG.sequenceGating): number {
  if (diff >= gating.blockThreshold) return 0;
  const raw =
    diff > 0
      ? CFG.baseHit * Math.pow(gating.hitDecay, diff)
      : diff < 0
        ? CFG.baseHit * Math.pow(gating.bonusHit, -diff)
        : CFG.baseHit;
  return clamp(raw, 0, 1);
}

/** 伤害倍率：diff > 0 衰减、diff < 0 加成、diff = 0 为 1 */
export function damageMultiplierOf(diff: number, gating: AssaultGating = CFG.sequenceGating): number {
  if (diff >= gating.blockThreshold) return 0;
  if (diff > 0) return Math.pow(gating.damageDecay, diff);
  if (diff < 0) return Math.pow(gating.bonusDamage, -diff);
  return 1;
}

/** 高序列抗性概率：目标序列 > threshold 时为 0 */
export function resistChanceOf(targetSeq: number): number {
  const cfg = CFG.highSequenceResist;
  if (targetSeq > cfg.threshold) return 0;
  // 用 threshold + 1 表达任务书公式里的那个 7 —— threshold 一改，公式仍然自洽
  const raw = cfg.base + (cfg.threshold + 1 - targetSeq) * cfg.perLevelBonus;
  return clamp(raw, 0, 1);
}

/**
 * **抗性概率饱和**（= 1.0）的序列上界 —— **派生量，不写死**（M2.38 任务 3）。
 *
 * 公式 `clamp(base + (threshold + 1 − seq) × perLevelBonus, 0, 1)` 在括号里 ≥ 1 时被 clamp 到 1：
 *
 *     seq ≤ threshold + 1 − ceil((1 − base) / perLevelBonus)
 *
 * 代入现值（threshold 6 / base 0.5 / perLevelBonus 0.1）⇒ **2**。
 *
 * ## 为什么它值得单独存在（K14 的形状）
 *
 * 序列 ≤ 2 时「命中之后再过一道抗性」**永远过** —— 判据跑了、随机数也消耗了，
 * 但**结论恒定**。这与「DIG 阶梯在高序号恒真」是**同一族**：
 * **判据在定义域边界外恒真**，而定义域（threshold = 6）是按当时的内容边界（最高序列 8）划的。
 *
 * ⚠️ 本版可达序列 ≥ 8 ⇒ **够不到那两档**，所以它现在没有实际影响；
 * 批次 B 把内容推到序列 2 之后就会被踩到 —— 由 `test/m2-38-resist-boundary.test.ts` 守着
 * （它拿 `CONTENT_MAX_SEQUENCE` 当边界，内容一推就红）。
 *
 * ⚠️ **判定照掷**（铁律 6：「该掷就掷、结果恒真」）—— 本函数只用来**改文案与报数**，
 * **不动随机流**（少掷一次会让同 seed 的后续轨迹整体错位）。
 */
export function resistSaturatedAtOrBelow(): number {
  const cfg = CFG.highSequenceResist;
  return cfg.threshold + 1 - Math.ceil((1 - cfg.base) / cfg.perLevelBonus);
}

/** 这一档的抗性是不是**必然**（概率已饱和到 1）—— 文案与报数用它，判定不用 */
export function resistIsCertain(targetSeq: number): boolean {
  return targetSeq <= resistSaturatedAtOrBelow();
}

/** 序列差的人话 */
export function gapLabelOf(diff: number): string {
  if (diff === 0) return '你们序列相同';
  if (diff > 0) return '你比他弱 ' + diff + ' 个序列';
  return '你比他强 ' + -diff + ' 个序列';
}

/** 高打低的赏金缩放：bounty × (1 + (9 − 目标序列) × 系数) */
export function bountyMultiplierFor(targetSeq: number): number {
  return 1 + Math.max(0, 9 - targetSeq) * CFG.reverseWanted.bountySequenceScale;
}

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

export function resolveAssault(input: AssaultInput, rng: Rng): AssaultResult {
  const gating = CFG.sequenceGating;
  const diff = input.attackerSeq - input.targetSeq;
  const overGap = diff >= gating.blockThreshold;
  /*
   * M2.13（封印之刃）：**这一刀是不是因为「无视序列差」才递得出去的**。
   *
   * 只有「本来会被拦」时才让它生效 —— 序列差没到拦截线时，它什么都不改变
   * （否则封印之刃会变成「无条件 +1.0 命中」的通用强化，而那不是它的定位）。
   */
  const ignoredSequenceGap = overGap && input.ignoreSequenceGap === true;
  /*
   * 参与公式的 diff：无视拦截时**夹到「刚好没被拦」的那一档**（blockThreshold − 1 = 2）。
   * 见 AssaultInput.ignoreSequenceGap 的注释 —— 不夹的话命中率与伤害倍率都还是 0。
   */
  const formulaDiff = ignoredSequenceGap ? Math.min(diff, gating.blockThreshold - 1) : diff;
  /*
   * M2.9：命中修正加在序列差算出的那个值之上，**不参与序列差的公式**。
   * 于是「弱 1 级打不动」与「吓到手抖」是两条可以分别观察、分别调的线。
   */
  const modifiedHit = clamp(hitChanceOf(formulaDiff) + (input.hitModifier ?? 0), 0, 1);
  const base: AssaultResult = {
    blocked: false,
    hitChance: modifiedHit,
    damageMax: 0,
    diff,
    gapLabel: ignoredSequenceGap
      ? gapLabelOf(diff) + ' —— 但这一击无视了序列差。'
      : gapLabelOf(diff),
    roll: 0,
    resistChecked: false,
    resisted: false,
    resistChance: input.ignoreResist === true ? 0 : resistChanceOf(input.targetSeq),
    resistRoll: null,
    wantedLevelOverride: null,
    bountyMultiplier: 1,
    ignoredSequenceGap,
    ignoredResist: input.ignoreResist === true,
  };

  // 1) 弱 3 级及以上：直接不可行。**一次骰都不掷**（不该掷骰时不掷）
  if (overGap && !ignoredSequenceGap) {
    return {
      ...base,
      blocked: true,
      blockedBy: 'sequence_gap',
      reason: '你根本近不了他的身。',
    };
  }

  const damageMultiplier = damageMultiplierOf(formulaDiff, gating);
  const damageMax = Math.max(
    1,
    Math.round((input.baseDamageMax ?? input.baseDamage) * damageMultiplier),
  );
  const hitChance = base.hitChance;

  // 2) 命中判定
  const roll = rng.next();
  if (roll >= hitChance) {
    return { ...base, damageMax, roll, hit: false };
  }

  // 3) 高序列被动抗性：**命中了**才有这一道。没抵抗住就照常结算
  let resistChecked = false;
  let resistRoll: number | null = null;
  if (input.targetSeq <= CFG.highSequenceResist.threshold) {
    resistChecked = true;
    resistRoll = rng.next();
    if (resistRoll < base.resistChance) {
      return {
        ...base,
        blocked: true,
        blockedBy: 'resist',
        reason: '伤害被什么东西挡下了。',
        hit: true,
        damageMax,
        roll,
        resistChecked,
        resisted: true,
        resistRoll,
      };
    }
  }

  // 4) 伤害
  const damage = Math.max(1, Math.round(input.baseDamage * damageMultiplier));

  // 5) 反向限制：高打低的代价。**这不只是惩罚，是保护** ——
  //    高序列玩家没必要去欺负新号：收益低、代价高
  const gap = -diff;
  const highAttacksLow = CFG.reverseWanted.highAttacksLow;
  const isHighAttacksLow = gap >= highAttacksLow.minLevelGap;
  const wantedLevelOverride = isHighAttacksLow ? highAttacksLow.wantedLevelOverride : null;
  const bountyMultiplier = isHighAttacksLow ? bountyMultiplierFor(input.targetSeq) : 1;

  return {
    ...base,
    damageMax,
    hit: true,
    damage,
    roll,
    resistChecked,
    resistRoll,
    wantedLevelOverride,
    bountyMultiplier,
  };
}
