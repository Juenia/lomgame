/**
 * 经验投影（M2.1）：把**实测 MAD/COR 分布**当作输入，替换 W5 模拟器里那条
 * 「玩家会把 MAD 顶到 90+」的假设，用来给失控闸门扫参。
 *
 * 做法（每一步都用真实纯函数，不复制任何规则）：
 *   1) 从实测分布里取「逐角色逐天」的 MAD / COR / DIG 轨迹，按画像分池；
 *   2) 角色级 bootstrap：每个虚拟角色从一条实测轨迹起步，逐日重采样「当日增量」
 *      （窗口内按第几天取同一位置的增量池，窗口外用末段增量池外推）；
 *   3) 每天的失控判定调用 computeLossOfControlProbability —— 与线上 tick 同一个函数，
 *      候选闸门通过 applyNumericOverrides 临时拧进去，跑完 resetNumeric()；
 *   4) 触发后按真实规则结算：MAD + NUMERIC.tick.lostControlMad，且次日不再判定
 *      （与 planCharacterTick 的「刚恢复当天不判定」一致）。
 *
 * 已知边界（报告里必须写明）：实测窗口内**没有发生过失控**，所以轨迹是「未失控玩家」的轨迹；
 * 「失控之后玩家会去净化/休息」这一环没有实测样本，本投影不建模 → 对稳健/完美主义画像偏高。
 */
import { NUMERIC, applyNumericOverrides, resetNumeric } from '../config/numeric.ts';
import { computeLossOfControlProbability } from '../domain/character/rules.ts';
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import { mean, percentile, type DailySample, type MeasuredDistribution } from './measured.ts';

export interface ProjectionConfig {
  charactersPerPersona: number;
  days: number;
  seed: string;
  divisor: number;
  madThreshold: number;
  corThreshold: number;
  personas?: readonly string[];
  /**
   * 窗口外的推演方式：
   *   - 'saturate'（默认）：实测窗口外增量视为 0，即按观测到的平台处理。
   *     保守、可解释：实测显示各画像的 MAD 曲线在窗口后段已明显减速
   *     （激进型 day 3→13 日均 +0.5/天，稳健型 day 5 见顶后回落）。
   *   - 'drift'：继续重采样末段增量（会把 7 天窗口的画像外推到不合理的水平，只作敏感性对照）。
   */
  tailMode?: 'saturate' | 'drift';
  /**
   * M2.2 §5.6 的补偿旋钮（与 `NUMERIC.play.escalation` 同一口径）：
   * 当天第 threshold 次之后的每次 .扮演额外 MAD + madPerExtraPlay。
   * 「当天扮演了几次」按实测的**每角色日扮演次数直方图**抽样（激进/完美主义的高强度玩家日多，
   * 稳健型的绝大多数玩家日落在阈值以下 → 天然「只加激进型」）。
   */
  escalation?: { threshold: number; madPerExtraPlay: number };
}

export interface PersonaProjection {
  persona: string;
  characters: number;
  days: number;
  /** N 天内至少失控一次的角色比例 */
  lostControlRate: number;
  /** 人均失控次数 */
  lostControlPerCharacter: number;
  /** 每天新触发失控的角色比例（第 0 天无判定，恒为 0） */
  byDay: number[];
  /** 模拟轨迹的逐日 MAD 均值 / P90 —— 用来和实测对照，验证「输入换对了」 */
  madMeanByDay: number[];
  madP90ByDay: number[];
  /** 期末 MAD ≥ 80 且 COR ≥ 70 的比例（固定尺子，死循环上界） */
  dangerShare: number;
  /** 期末仍卡在序列 9 且 DIG 达标且 MAD ≥ 80 且 COR ≥ 70（与模拟器同一把尺子） */
  deadlockShare: number;
}

interface Trajectory {
  persona: string;
  mad: number[];
  cor: number[];
  dig: number[];
  sequence: number[];
}

/** 把逐天样本按角色拼成轨迹（同一角色 id 的记录已按天排序） */
export function buildTrajectories(samples: readonly DailySample[]): Map<string, Trajectory[]> {
  const grouped = new Map<string, DailySample[]>();
  for (const sample of samples) {
    const list = grouped.get(sample.characterId) ?? [];
    list.push(sample);
    grouped.set(sample.characterId, list);
  }
  const byPersona = new Map<string, Trajectory[]>();
  for (const list of grouped.values()) {
    const sorted = [...list].sort((a, b) => a.day - b.day);
    const first = sorted[0]!;
    const trajectory: Trajectory = {
      persona: first.persona,
      mad: sorted.map((row) => row.mad),
      cor: sorted.map((row) => row.cor),
      dig: sorted.map((row) => row.dig),
      sequence: sorted.map((row) => row.sequence),
    };
    const pool = byPersona.get(first.persona) ?? [];
    pool.push(trajectory);
    byPersona.set(first.persona, pool);
  }
  return byPersona;
}

interface DeltaPool {
  /** dayIndex → 该位置的增量样本（同一批天里不同角色的增量） */
  byDay: Array<Array<{ mad: number; cor: number; dig: number }>>;
  /** 末段（最后 3 个观测天）的合并池，用于窗口外推 */
  tail: Array<{ mad: number; cor: number; dig: number }>;
}

function buildDeltaPool(trajectories: readonly Trajectory[]): DeltaPool {
  const byDay: Array<Array<{ mad: number; cor: number; dig: number }>> = [];
  for (const trajectory of trajectories) {
    for (let index = 1; index < trajectory.mad.length; index += 1) {
      const slot = (byDay[index] ??= []);
      slot.push({
        mad: trajectory.mad[index]! - trajectory.mad[index - 1]!,
        cor: trajectory.cor[index]! - trajectory.cor[index - 1]!,
        dig: trajectory.dig[index]! - trajectory.dig[index - 1]!,
      });
    }
  }
  const lastIndex = byDay.length - 1;
  const tail = byDay.slice(Math.max(1, lastIndex - 2)).flat();
  return { byDay, tail: tail.length > 0 ? tail : byDay.flat() };
}

const clamp01 = (value: number, max = 100): number => Math.max(0, Math.min(max, value));

/** 从直方图里抽一个「当天扮演了几次」（roll ∈ [0,1)） */
export function samplePlaysPerDay(histogram: readonly number[], roll: number): number {
  const total = histogram.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  let acc = roll * total;
  for (let index = 0; index < histogram.length; index += 1) {
    acc -= histogram[index] ?? 0;
    if (acc < 0) return index;
  }
  return histogram.length - 1;
}

/**
 * 「激进行为 MAD 涨得更猛」与游戏规则完全同形：
 *   额外 MAD = max(0, 当天第 k 次 - threshold) × madPerExtraPlay
 * 这里 k 由直方图抽样得到，因此不需要假设「玩家每天都扮演均值那么多次」。
 */
export function escalationMadOf(playsToday: number, config: ProjectionConfig['escalation']): number {
  if (!config) return 0;
  return Math.max(0, playsToday - config.threshold) * config.madPerExtraPlay;
}

/** 对单个画像做一次投影（判定走真实纯函数） */
export function projectPersona(
  persona: string,
  trajectories: readonly Trajectory[],
  config: ProjectionConfig,
  /** M2.2：该画像的「每角色日扮演次数」直方图（不给则不加压） */
  playsHistogram?: readonly number[],
): PersonaProjection {
  const pool = buildDeltaPool(trajectories);
  const characters = config.charactersPerPersona;
  const days = config.days;

  const triggeredEver: boolean[] = new Array(characters).fill(false);
  const triggers: number[] = new Array(characters).fill(0);
  const byDay = new Array(days).fill(0);
  const madByDay: number[][] = Array.from({ length: days }, () => []);
  const finals: Array<{ mad: number; cor: number; dig: number; sequence: number }> = [];

  for (let index = 0; index < characters; index += 1) {
    const rng = createSeededRng(seedFrom(['empirical', config.seed, persona, index]));
    const start = trajectories[Math.floor(rng.next() * trajectories.length)] ?? trajectories[0]!;
    let mad = start.mad[0] ?? 0;
    let cor = start.cor[0] ?? 0;
    let dig = start.dig[0] ?? 0;
    let sequence = start.sequence[0] ?? 9;
    let recovering = false;
    madByDay[0]!.push(mad);

    for (let day = 1; day < days; day += 1) {
      if (!recovering) {
        // M2.33（P5）：仿真里的闸门也按各条轨迹自己的序列取（9—7 冻结 65）
        const probability = computeLossOfControlProbability({ mad, cor, sequence });
        if (probability > 0 && rng.next() < probability) {
          triggeredEver[index] = true;
          triggers[index] = (triggers[index] ?? 0) + 1;
          byDay[day] = (byDay[day] ?? 0) + 1;
          mad = clamp01(mad + NUMERIC.tick.lostControlMad);
          recovering = true;
        }
      } else {
        recovering = false;
      }
      const observed = pool.byDay[day];
      const deltaPool = observed ?? (config.tailMode === 'drift' ? pool.tail : []);
      const pick = rng.next();
      const delta =
        deltaPool.length === 0
          ? { mad: 0, cor: 0, dig: 0 }
          : (deltaPool[Math.floor(pick * deltaPool.length)] ?? { mad: 0, cor: 0, dig: 0 });
      mad = clamp01(mad + delta.mad);
      cor = clamp01(cor + delta.cor);
      dig = clamp01(dig + delta.dig);
      // M2.2 §5.6：「激进行为 MAD 涨得更猛」——按当天的扮演次数加压
      if (config.escalation && playsHistogram && playsHistogram.length > 0) {
        const playsToday = samplePlaysPerDay(playsHistogram, rng.next());
        mad = clamp01(mad + escalationMadOf(playsToday, config.escalation));
      }
      madByDay[day]!.push(mad);
    }
    finals.push({ mad, cor, dig, sequence });
  }

  const danger = finals.filter((row) => row.mad >= 80 && row.cor >= 70).length;
  const deadlock = finals.filter((row) => row.sequence === 9 && row.dig >= 60 && row.mad >= 80 && row.cor >= 70).length;

  return {
    persona,
    characters,
    days,
    lostControlRate: triggeredEver.filter(Boolean).length / Math.max(1, characters),
    lostControlPerCharacter: triggers.reduce((sum, value) => sum + value, 0) / Math.max(1, characters),
    byDay: byDay.map((count) => count / Math.max(1, characters)),
    madMeanByDay: madByDay.map((values) => mean(values)),
    madP90ByDay: madByDay.map((values) => percentile(values, 0.9)),
    dangerShare: danger / Math.max(1, characters),
    deadlockShare: deadlock / Math.max(1, characters),
  };
}

/** 一次投影多个画像；候选闸门临时拧进 NUMERIC，结束必 reset */
export function project(distribution: MeasuredDistribution, config: ProjectionConfig): PersonaProjection[] {
  const pools = buildTrajectories(distribution.samples);
  const personas = config.personas ?? [...pools.keys()].sort();
  // M2.2：画像 → 「每角色日扮演次数」直方图（只有给了 escalation 才用得上）
  const histograms = new Map<string, number[]>(
    (distribution.actionRates ?? []).map((rate) => [rate.persona, rate.playsPerDayHistogram ?? []]),
  );
  /*
   * M2.33（P5 落地后）：闸门从「一个全局值」变成「一张按序列的表」，
   * 所以候选值要**拧到每一档**，而且 mad / cor 分开拧（扫参扫的就是这两个维度）。
   *
   * ⚠️ 只拧 `madThreshold` / `corThreshold` 已经**没人读**了 —— M2.33 实测：那样投影会静默
   * 跑成「用真值判定」，症状是「闸门以上一个都不触发」（`test/m21.test.ts` 那条用例当场红）。
   */
  const candidate = { mad: config.madThreshold, cor: config.corThreshold };
  applyNumericOverrides({
    lossOfControl: {
      divisor: config.divisor,
      // 保留：`validate` 与报告读它们（判定不再读，见 numeric 里那两个字段的注释）
      madThreshold: config.madThreshold,
      corThreshold: config.corThreshold,
      thresholdBySequence: Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((sequence) => [sequence, { ...candidate }]),
      ),
    },
  });
  try {
    return personas
      .filter((persona) => (pools.get(persona)?.length ?? 0) > 0)
      .map((persona) => projectPersona(persona, pools.get(persona)!, config, histograms.get(persona)));
  } finally {
    resetNumeric();
  }
}

/** 每画像在窗口结束时的实测均值 / P90（给报告做「输入换对了」的对照） */
export function measuredCurve(
  distribution: MeasuredDistribution,
  persona: string,
  days: number,
): { madMean: number[]; madP90: number[] } {
  const rows = distribution.samples.filter((sample) => sample.persona === persona && sample.day < days);
  const madMean: number[] = [];
  const madP90: number[] = [];
  for (let day = 0; day < days; day += 1) {
    const values = rows.filter((row) => row.day === day).map((row) => row.mad);
    madMean.push(values.length > 0 ? mean(values) : Number.NaN);
    madP90.push(values.length > 0 ? percentile(values, 0.9) : Number.NaN);
  }
  return { madMean, madP90 };
}
