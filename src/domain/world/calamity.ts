/**
 * 灾厄（M2.14）—— 判定层纯函数，**没有任何 IO**。
 *
 * ## 它是什么
 *
 * 灾厄是**世界自己进入的一段状态**：持续几天，期间外面的东西比平时更强、
 * 也更愿意往有人的地方走。对玩家来说两句话同时成立 ——
 * **出去更危险**，但**愿意动手的人拿到平时拿不到的东西**。
 *
 * ## 为什么是纯 seed 派生（路线 A）
 *
 * 任务书 §一 拍板的是「灾厄不下渗判定层」，落在三条上：
 *   - 它**不进任何 seedFrom 的参数表** —— 判定 seed 的组成一个字段不改；
 *   - 它**不落 world_state 新列** —— 灾厄属于「seed 决定」类，不是「事件改写」类；
 *   - 判定层看到的它只是一个**入参**（与 worldModifiers 喂给 resolveExplore 的倍率同一手法）。
 *
 * 所以这一层的全部契约就是一句：**同 seed 同 t → 同灾厄**。没有任何状态。
 *
 * ## 时间结构：绝对时间桶（铁律 5）
 *
 * 每 intervalDays 天一个**窗口**（bucket），窗口内至多一次灾厄；
 * 灾厄整日对齐、且**不跨窗口**。于是「这一刻有没有灾厄」只看当前窗口就够 ——
 * 补跑（一次跑 5 格）与逐小时跑必然算出同一串结果，
 * 与生态的「世界补充」用绝对小时桶（ecology.ts:328-333）是同一个理由。
 *
 * ## 为什么没有缓存
 *
 * dayPlanFor / fogScheduleCache 都是「纯函数 + 进程内缓存、无失效逻辑」。
 * 这一层**刻意不跟**：整个判定只有三次 rng.next()，比查表还便宜；
 * 而缓存一旦加上，applyNumericOverrides（模拟器调参）改了参数就不会生效 ——
 * 那是一个只在调参时才发作、且症状是「改了没用」的坑。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { weightedPick } from '../random.ts';
import { createSeededRng, seedFrom } from '../rng.ts';
import { dayIndexOf, dayStartOf } from './clock.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 灾厄等级：0 = 无灾厄 */
export type CalamityLevel = 0 | 1 | 2 | 3;

export interface Calamity {
  level: CalamityLevel;
  /** 连续强度 0—1 =（level / maxLevel）× 淡入淡出。给生态与掉落当乘数用 */
  factor: number;
  /** 起止（整日对齐，整点） */
  since: number;
  until: number;
  /** 持续几天 */
  days: number;
  /** 展示名（`text` 的第一行之后会用到） */
  name: string;
  /** 当前天序号 */
  dayIndex: number;
  /**
   * 这次查询问的是哪个地点（M2.15 任务 D）；`null` = 全服。
   *
   * ⚠️ 它**不改变灾厄本身**：同一场灾厄不论问哪个地点，等级 / 起止 / 强度都是同一份
   * （灾厄是**世界**进入的状态，不是某个地点自己的状态）。这个字段只是把
   * 「这个答案是关于谁的」记下来，好让调用方不必自己再拿一个变量记住它。
   */
  locationId: string | null;
}

/**
 * 等级 → 名字。
 * 文案住在判定层（与 events.ts 的 RUMOR_TEXTS / DISCOVERY_TEXTS 同一手法），
 * 数值才住 numeric —— 「几级」是规则，「叫什么」是内容。
 */
const CALAMITY_NAMES: Record<number, string> = {
  1: '雾魇',
  2: '血月余波',
  3: '灵界倒灌',
};

/** 这一刻落在第几个灾厄窗口（绝对时间桶，纯 t 的函数） */
export function calamityBucketOf(t: number): number {
  return Math.floor(dayIndexOf(t) / NUMERIC.calamity.intervalDays);
}

/** 窗口的第一个天序号 */
function bucketStartDay(bucket: number): number {
  return bucket * NUMERIC.calamity.intervalDays;
}

/**
 * 灾厄的「日起点」＝ 那一天的**白天开始**（`NUMERIC.world.clock.dayStartHour`，9 点）。
 *
 * ⚠️ 为什么不直接对齐到 0 点：`generateWorldEvents` 有**安静时段**
 * （`NUMERIC.world.events.quietFromHour/quietToHour` = 0—5 点，那一段世界不播报，
 * 见 events.ts:266-267）。灾厄的开始如果落在 0 点，它的播报就正好被安静时段吃掉 ——
 * **一次都播不出来**，而症状是「灾厄在生效、群里没人知道」。
 * 对齐到 9 点既躲开安静时段，又保住「整日对齐」这条时间结构。
 */
export function calamityDayAnchor(dayIndex: number): number {
  return dayStartOf(dayIndex) + NUMERIC.world.clock.dayStartHour * HOUR_MS;
}

interface BucketPlan {
  level: CalamityLevel;
  startDay: number;
  durationDays: number;
}

/**
 * 一个窗口的灾厄排期。
 *
 * **只掷三次**，顺序固定（同 seed 同窗口 → 同结果）：
 *   1. 有没有灾厄；
 *   2. 哪一天开始 —— 起始天的上界是 `intervalDays − durationDays`，**留出整整 durationDays**
 *      （这是「不跨窗口」的来处；calamityAt 里还有一条运行时断言兜底）；
 *   3. 几级。
 */
function rollPlan(seed: string, bucket: number): BucketPlan | null {
  const cfg = NUMERIC.calamity;
  const rng = createSeededRng(seedFrom(['calamity', seed, bucket]));
  if (rng.next() >= cfg.chancePerBucket) return null;

  const levels: CalamityLevel[] = [1, 2, 3];
  const level = (weightedPick(levels, (entry) => cfg.levelWeights[entry] ?? 0, rng) ?? 1) as CalamityLevel;
  const durationDays = Math.max(1, cfg.durationDays[level] ?? 1);
  const latestStart = Math.max(0, cfg.intervalDays - durationDays);
  const startDay = bucketStartDay(bucket) + Math.floor(rng.next() * (latestStart + 1));
  return { level, startDay, durationDays };
}

/** 淡入淡出：首尾各 rampDays 天线性升降，中间满值 */
function rampOf(elapsedDays: number, durationDays: number): number {
  const rampDays = NUMERIC.calamity.rampDays;
  if (rampDays <= 0) return 1;
  return Math.max(0, Math.min(1, elapsedDays / rampDays, (durationDays - elapsedDays) / rampDays));
}

/**
 * 这一刻世界的灾厄（null = 没有）。
 *
 * **纯函数**：只读 seed + t（+ 可选的 locationId），不读库、不读玩家、不看调用次数。
 *
 * @param locationId M2.15 任务 D 加的**可选**第三参：
 *   - `null` / `undefined`（默认）= 全服，**行为与 M2.14 逐位不变**；
 *   - 传地点 id = 「这一刻**这个地点**有没有灾厄」，不在本场灾厄的范围内时返回 null。
 *
 *   灾厄本身仍然是**全服一场**的：传地点时拿到的等级 / 起止 / 强度与不传时逐位相同，
 *   唯一的差别是多出来的 `locationId` 字段。范围判据在 `NUMERIC.calamity.scopeChance`
 *   （当前 = 1，即全部地点都覆盖 —— 也就是「灾厄是全服的」这条 v1 口径一字不改）。
 *
 * ⚠️ 现有五处调用点（世界事件 / `.今日` / 战斗掉落 / 探索掉落 / 生态 tick）
 * **全部不传第三参**，所以这一轮没有任何行为变化。
 */
export function calamityAt(seed: string, t: number, locationId: string | null = null): Calamity | null {
  /*
   * M2.14 对照批开关（见 numeric.calamity.enabled 的注释）：
   * 关掉时**在这里一刀切断** —— 五处下游调用点自动全关。
   *
   * 位置很关键：这段提前返回在**构造任何 rng 之前**，
   * 所以开关不会改变随机数的消耗（铁律 6 的延伸）。
   */
  if (!NUMERIC.calamity.enabled) return null;
  const cfg = NUMERIC.calamity;
  const bucket = calamityBucketOf(t);
  const plan = rollPlan(seed, bucket);
  if (!plan) return null;

  const since = calamityDayAnchor(plan.startDay);
  const until = calamityDayAnchor(plan.startDay + plan.durationDays);

  /*
   * 跨窗口断言。
   *
   * 「不跨窗口」是 rollPlan 里**按参数算**出来的（起始天上界 = intervalDays − durationDays），
   * 不是逻辑上的保证：有人把 durationDays[3] 从 2 调到 4 而 intervalDays 还是 6，
   * 灾厄就会伸进下一个窗口 —— 而 calamityAt 只看当前窗口，那一段会**凭空消失**，
   * 症状是「灾厄提前结束」，最难查的那一类。
   *
   * ⚠️ 判据是「它占据的**最后一天**」而不是 until 那一刻：
   * 灾厄是 [第 N 天 9 点, 第 N+k 天 9 点) —— until 已经落在**下一个自然日**上了，
   * 拿它去算窗口会把「贴到窗口末尾的合法灾厄」整片误挡（intervalDays=1 时全军覆没）。
   * 所以看 lastDay = startDay + days − 1 落在哪个窗口。
   */
  const lastDay = plan.startDay + plan.durationDays - 1;
  if (Math.floor(lastDay / cfg.intervalDays) !== bucket) return null;
  if (t < since || t >= until) return null;

  const elapsedDays = (t - since) / DAY_MS;
  const calamity: Calamity = {
    level: plan.level,
    factor: (plan.level / cfg.maxLevel) * rampOf(elapsedDays, plan.durationDays),
    since,
    until,
    days: plan.durationDays,
    name: CALAMITY_NAMES[plan.level] ?? `灾厄 ${plan.level} 级`,
    dayIndex: dayIndexOf(t),
    locationId: null,
  };

  /*
   * M2.15 任务 D：地点级查询。
   *
   * 位置很关键：这一段在**全服那一段完全算完之后**才执行，而且只在
   * `locationId !== null` 时掷骰 —— 于是「不传第三参」这条路径
   * **一个随机数都不多消耗**（铁律 6 的延伸：不该掷骰时不掷）。
   *
   * 范围判据只读 (seed, locationId, 窗口)：同一场灾厄里同一个地点的答案稳定，
   * 不同地点彼此独立，重跑一致。当前 `scopeChance = 1`（全部覆盖），
   * 所以判定恒真 —— 分支是活的，只是现在不会拒掉任何地点。
   */
  if (locationId === null) return calamity;
  const scope = createSeededRng(seedFrom(['calamity-scope', seed, locationId, bucket]));
  if (scope.next() >= cfg.scopeChance) return null;
  return { ...calamity, locationId };
}

/**
 * 这一刻灾厄的影响因子 0—1（无灾厄 = 0）。
 *
 * 给生态与掉落当乘数用 —— 调用方拿到的永远是**一个数**，
 * 不需要知道灾厄的等级、名字、起止（那是播报与报告的事）。
 */
export function calamityFactorAt(seed: string, t: number): number {
  return calamityAt(seed, t)?.factor ?? 0;
}
