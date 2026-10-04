/**
 * 晋升仪式（M2.5）：数据形状。
 *
 * 硬约束（任务书 §2）：判定层是纯函数 `(state, config, rng) → RitualResult`，无 IO。
 * 所以这里没有仓储、没有时钟、没有随机器 —— 所有输入都由命令层拼好传进来，
 * 所有随机都来自注入的 rng。
 *
 * 一条贯穿全篇的口径：**仪式不是另起一套晋升公式**，
 * 它在 W5 的 `computePromotionSuccess` 之上**加**配置项（地点 / 时段 / 天气 / 见证 / 材料），
 * 再把 MAD/COR 惩罚**原样拆开显示**（任务书 §3.2 的死循环 UX 缺口就落在这里）。
 */
import type { CharacterStatus } from '../character/types.ts';
import type { EffectDelta } from '../effect/apply.ts';
import type { MaterialNeed } from '../potion/recipe.ts';
import type { TimeOfDay } from '../world/clock.ts';
import type { WeatherId } from '../world/weather.ts';

/** 仪式在库里的状态（rituals.status） */
export type RitualStatus = 'preparing' | 'success' | 'failed' | 'interrupted';

/** 一次仪式跑完的三种结局 */
export type RitualOutcome = 'success' | 'fail' | 'interrupt';

/**
 * 阶段编号。1 布置 / 2 引导 / 3 融合是入门档（M2.5）的三关；
 * M2.76 起高序列档会**多出中间关**（结障 / 封印），所以上限放宽到 5。
 *
 * ⚠️ 这里放宽的是**编号的取值域**，不是「每档都有 5 关」——
 * 一档有几关由 `rituals.yaml` 的阶段列表决定，编号只是它在列表里的位置。
 */
export type RitualStageNo = 1 | 2 | 3 | 4 | 5;

/** 入门档（M2.5）三关的标签。高序列档的标签来自内容表，不从这里取。 */
export const RITUAL_STAGE_LABELS: Record<RitualStageNo, string> = {
  1: '布置',
  2: '引导',
  3: '融合',
  4: '第四关',
  5: '第五关',
};

export const RITUAL_OUTCOME_LABELS: Record<RitualOutcome, string> = {
  success: '晋升成功',
  fail: '融合失败',
  interrupt: '仪式中断',
};

/** 玩家布置出来的仪式配置（落 rituals.config_json） */
export interface RitualConfig {
  /** 地点 id；null = 还没选（不能开始） */
  locationId: string | null;
  /** 期望时段；null = 不限（随到随做）。命中才有加成，不命中不能开始 */
  timeOfDay: TimeOfDay | null;
  /** 见证人 userId（队伍里除自己以外的成员，最多 witnessMax 个） */
  witnesses: string[];
  /** 已经被干扰成功的次数（每次 -20%） */
  interferenceCount: number;
  /**
   * M2.76：`.仪式 开始` 算出来的**累积惩罚**（档位 + 各前置关失败），带进融合关。
   *
   * 为什么落在这里：两次调用（开始 / 融合）之间**只共享这一份配置** ——
   * 不写下来，融合关要么重算（信息已经丢了：哪一关失败没存），
   * 要么退回到 `setupStage >= 2` 那个只在「固定两关」下成立的旧判据。
   * 可选：老行（M2.76 之前建的）没有这一项，undefined 时融合关走旧判据。
   */
  fusePenalty?: number;
}

export function emptyRitualConfig(): RitualConfig {
  return { locationId: null, timeOfDay: null, witnesses: [], interferenceCount: 0 };
}

/**
 * 成功率拆解。**每一项都要能被单独显示出来** ——
 * 任务书 §3.2 要求「预览必须拆开」，尤其是 MAD/COR 惩罚：
 * 玩家要能一眼看出「我现在该先 .休息 / .净化」。
 * 负数表示扣分。
 */
export interface RitualChanceBreakdown {
  /** W5 公式的基线（70%） */
  base: number;
  /** 消化度项：+0.2 × DIG/100（W5 原式，未改） */
  dig: number;
  /** 序列项：-0.05 × (9 - 序列)（W5 原式，未改） */
  sequence: number;
  /** MAD 惩罚：-0.3 × MAD/100（W5 原式，未改） */
  mad: number;
  /** COR 惩罚：-0.15 × COR/100（W5 原式，未改） */
  cor: number;
  /** 连续失败保护（W5 原式） */
  failStreak: number;
  /** 地点加成 */
  location: number;
  /** 时段加成 */
  time: number;
  /** 天气加成 */
  weather: number;
  /** 见证人加成 */
  witness: number;
  /** 材料成色加成 */
  material: number;
  /** 被干扰的惩罚（负） */
  interference: number;
  /** 求和（clamp 之前） */
  raw: number;
  /** clamp 之后的最终成功率 */
  final: number;
  capped: boolean;
  floored: boolean;
}

export interface RitualChanceInput {
  state: { dig: number; sequence: number; mad: number; cor: number };
  /** 已经连续失败几次（W5 的连续失败保护） */
  fails: number;
  /** 目标准备在哪举行（null = 还没选，地点项按 0 算） */
  locationId: string | null;
  timeOfDay: TimeOfDay;
  weather: WeatherId;
  witnessCount: number;
  /** 晋升用的主材料 id（决定材料成色）；null = 未知 → 按 normal 算 */
  mainMaterialId: string | null;
  /** 被干扰成功的次数 */
  interferenceCount: number;
}

export interface RitualPreview {
  breakdown: RitualChanceBreakdown;
  /** 需要提醒玩家的话（MAD/COR 惩罚、被干扰、上限截断…） */
  notes: string[];
  /** 现在能不能开始；不能的话给出原因 */
  canStart: boolean;
  blockedReason?: string;
}

export interface RitualStageResult {
  stage: RitualStageNo;
  label: string;
  chance: number;
  roll: number;
  success: boolean;
  /** 这一阶段的反馈（写进私聊明细） */
  note: string;
}

export interface RitualResult {
  outcome: RitualOutcome;
  stages: RitualStageResult[];
  /** 阶段 3 实际用的成功率（已含阶段 2 的 -20% 与干扰惩罚，且已被 successCap 截断） */
  finalChance: number;
  /** 实际该扣的材料（命令层负责真扣，扣不动就跳过并记录） */
  materialLoss: MaterialNeed[];
  /** 属性变化（重伤 / MAD / COR / 序列） */
  deltas: EffectDelta[];
  status: CharacterStatus;
  flagsToSet: string[];
  targetSequence: number;
  narrative: string[];
}

/** 一次干扰判定的结果 */
export interface InterferenceResult {
  success: boolean;
  chance: number;
  roll: number;
  /** 干扰者要承受的代价（失败时 COR +5） */
  deltas: EffectDelta[];
  narrative: string[];
}

export interface RitualConfigInput {
  config: RitualConfig;
  /** 内容层能提供的地点（id + 名字），用于校验地点是否真实存在 */
  knownLocationIds: readonly string[];
}

/** 配置是否完整到可以开始 */
export function ritualConfigStatus(input: RitualConfigInput): { ok: true } | { ok: false; reason: string } {
  const { config } = input;
  if (!config.locationId) return { ok: false, reason: '还没有选地点（.仪式 地点 <地点名>）。' };
  if (!input.knownLocationIds.includes(config.locationId)) {
    return { ok: false, reason: '选的地点不存在（.仪式 地点 <地点名> 重新选一个）。' };
  }
  return { ok: true };
}