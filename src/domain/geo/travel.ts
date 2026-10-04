/**
 * 移动判定（M2.7 主任务三）：纯函数。
 *
 * 这一层负责三件事，全部无 IO、无副作用：
 *   1. **计划**：一条路线上会在哪几个时刻可能出事（planTravel）；
 *   2. **结算**：玩家对某个事件做的选择换来什么（resolveTravelChoice）；
 *   3. **查表**：这条路要多少钱、多少 AP、走多久。
 *
 * 时间口径（三处必须一致，否则玩家会觉得「怎么还没到」）：
 *   - 1 游戏小时 = 1 现实小时（与世界时钟 M2.2 同一把尺子）；
 *   - 事件点均匀分布在行程里：8 小时的路只有 1 个点，72 小时的海路有 3 个点；
 *   - 迷雾（fog）会把到达时间往后推 extraHours 小时 —— 这是唯一会改到达时刻的事件。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { clamp } from '../character/rules.ts';
import type { Rng } from '../character/types.ts';
import type { EffectDelta } from '../effect/apply.ts';
import { weightedPick } from '../random.ts';
import { isTravelEventId, TRAVEL_EVENTS, type TravelChoiceId, type TravelEventId } from './events.ts';
import type { Route } from './types.ts';

export const MS_PER_HOUR = 60 * 60 * 1000;

export interface PlannedTravelEvent {
  id: TravelEventId;
  /** 触发的游戏时刻（毫秒时间戳） */
  at: number;
}

export interface TravelPlan {
  events: PlannedTravelEvent[];
  arrivesAt: number;
  durationHours: number;
  costPenny: number;
}

/* ---------------- M2.71：区域危险度（`Region.danger` 的读取点） ---------------- */

/**
 * 区域危险度的**中性值**（= `RegionSchema.danger` 的默认值 0.5）。
 *
 * 等于它 = **不改变任何东西** —— 这是这一层「不排斥现有数据」的落点：
 * 一个没写 danger 的区域（取默认 0.5）与加这一层之前逐位相同。
 */
export const REGION_DANGER_NEUTRAL = 0.5;

/** 区域危险度对路线危险的权重（0.3：从最安稳的 0.2 到最凶的 0.8，路线危险 ±0.09） */
const REGION_DANGER_WEIGHT = 0.3;

/**
 * **一条路线的实际危险** = 路线自己的危险 + 目的地所在区域的偏移。
 *
 * ## 为什么读的是**目的地**区域
 *
 * 类型注释写的是「影响**该区域内**的路线危险」，而一条路线连着两个区域。
 * 取目的地是因为**陌生感是你到达时才有的**（regions.yaml 的原话是「这条路有多不安」）：
 * 从鲁恩出发去南大陆，让人不安的是南大陆，不是你已经在的地方。
 *
 * ## 形状
 *
 *     effective = clamp01(route.danger + (region.danger − 0.5) × 0.3)
 *
 * 鲁恩 0.3 → −0.06（帝国腹地，路好走）；因蒂斯 0.5 → ±0；苏尼亚海 0.6 → +0.03；
 * 南大陆 0.8 → +0.09（最南边那条航线本来就 0.7，加上去 0.79）。
 *
 * @param regionDanger 目的地所在区域的危险度；null（区域没登记）时**不改变**
 */
export function effectiveRouteDanger(routeDanger: number, regionDanger: number | null): number {
  const base = clamp(routeDanger, 0, 1);
  if (regionDanger === null) return base;
  return clamp(base + (clamp(regionDanger, 0, 1) - REGION_DANGER_NEUTRAL) * REGION_DANGER_WEIGHT, 0, 1);
}

/**
 * **抵达时的陌生感文案**（`Region.danger` 的第二个读取点）。
 *
 * 只在两端说一句：太凶的地方（≥0.7）与太顺的地方（≤0.3）。
 * 中间那一段**返回 null** —— 不是每一趟路都该有一句感慨，
 * 每趟都说等于没说。
 */
export function regionUneaseLine(regionDanger: number): string | null {
  const danger = clamp(regionDanger, 0, 1);
  if (danger >= 0.7) return '这里的空气比来处重一些。你不太确定是天气，还是别的什么。';
  if (danger <= 0.3) return '这一路顺得反常。你反而比平时更警觉。';
  return null;
}

/**
 * 事件点数量：按时长分档（numeric.geo.travel.eventPointsByHours）。
 * 为什么按时长：任务书要求「移动本身是一段内容」，
 * 如果 8 小时的陆路与 72 小时的海路事件数一样，长途就只剩「数字更大」这一个区别。
 */
export function eventPointsFor(durationHours: number): number {
  const bands = NUMERIC.geo.travel.eventPointsByHours;
  let points = 1;
  for (const band of bands) {
    if (durationHours >= band.minHours) points = band.points;
  }
  return Math.max(1, Math.min(NUMERIC.geo.travel.maxEventsPerRoute, points));
}

/** 这条路可能出的事（route.events 里认识的那些 id） */
export function parseRouteEvents(route: Route): TravelEventId[] {
  return route.events.filter((id): id is TravelEventId => isTravelEventId(id));
}

/** 这条路的权重表：海路用 seaEvents，陆路用 landEvents（numeric.geo） */
export function travelWeightsOf(route: Route): Record<string, number> {
  return route.type === 'sea' ? NUMERIC.geo.seaEvents : NUMERIC.geo.landEvents;
}

/**
 * 计划一次移动：什么时候到、路上会在哪个时刻撞上什么。
 *
 * 「每次移动至少触发一次事件」（任务书 §8）：各事件点按 eventChance 掷骰，
 * 若一个都没中，**强制补一个**。所以 eventChance 控制的是事件密度，不是有没有事件。
 */
export function planTravel(input: { route: Route; now: number; rng: Rng }): TravelPlan {
  const cfg = NUMERIC.geo.travel;
  const { route } = input;
  const durationMs = route.duration_hours * MS_PER_HOUR;
  const points = eventPointsFor(route.duration_hours);
  const weights = travelWeightsOf(route);
  const candidates = parseRouteEvents(route).filter((id) => (weights[id] ?? 0) > 0);

  const events: PlannedTravelEvent[] = [];
  for (let index = 0; index < points; index += 1) {
    /*
     * 第一个事件点**必中，而且就在此刻**。两条理由：
     *   1. 任务书要求「移动本身是一段内容」—— 上路那一刻就该有件事可做，
     *      而不是让玩家干等几个小时；
     *   2. 交互上的死结：.移动 的回执会立刻把这个事件摆出来（带按钮），
     *      而 pendingTravelEvent 按 at <= now 判定 —— 如果它的 at 在未来，
     *      玩家点按钮只会得到「你现在没有需要处理的事」。
     */
    const first = index === 0;
    if (!first && input.rng.next() >= cfg.eventChance) continue;
    const at = first
      ? input.now
      : input.now + Math.round((durationMs * (index + 1)) / (points + 1));
    const picked = weightedPick(candidates, (id) => weights[id] ?? 0, input.rng);
    if (picked) events.push({ id: picked, at });
  }
  if (events.length === 0 && cfg.guaranteeAtLeastOne && candidates.length > 0) {
    const picked = weightedPick(candidates, (id) => weights[id] ?? 0, input.rng);
    if (picked) events.push({ id: picked, at: input.now + Math.round(durationMs / 2) });
  }

  return {
    events,
    arrivesAt: input.now + durationMs,
    durationHours: route.duration_hours,
    costPenny: route.cost_penny,
  };
}

export interface TravelChoiceResult {
  deltas: EffectDelta[];
  narrative: string[];
  /** 这次选择额外花掉的小时数（只有迷雾会非 0） */
  extraHours: number;
  /** 一行摘要（落库 + 报告统计用） */
  outcome: string;
  /** 本次掷骰值（复现用；同 seed 同值） */
  roll: number;
}

/**
 * 玩家对路途事件的选择 → 结算。
 *
 * 四种选择的分工（数值全在 numeric.geo.encounter）：
 *   - **战斗**：掷一次压制判定，赢就免掉事件的基础伤害并涨消化度，输就吃满伤害；
 *   - **逃跑**：掷一次逃脱判定，成功全身而退，失败照样吃伤害；
 *   - **观察**：吃满基础伤害，但稳定拿到一点消化度（看清楚它 = 更懂这条路）；
 *   - **互动**：基础伤害减半 —— 与它打交道的收益不如战斗，但风险也小。
 *
 * 为什么把「基础伤害」与「选择的后果」分开算：
 * 风浪就是风浪（HP -10 / MAD +5 是客观的），但**你怎么应对**决定它最终伤你多少。
 * 合并成一坨的话，「战斗」在有伤害的事件上就永远不如「观察」，四个按钮会退化成两个。
 */
export function resolveTravelChoice(input: {
  eventId: TravelEventId;
  choice: TravelChoiceId;
  /** 路线危险度 0—1：越高越难战斗、越难逃 */
  routeDanger: number;
  rng: Rng;
}): TravelChoiceResult {
  const effects = NUMERIC.geo.effects[input.eventId] ?? {};
  const cfg = NUMERIC.geo.encounter;
  const danger = clamp(input.routeDanger, 0, 1);
  const deltas: EffectDelta[] = [];
  const narrative: string[] = [];
  const extraHours = effects.extraHours ?? 0;
  const roll = input.rng.next();

  const pushBase = (scale: number): void => {
    if (effects.hp) deltas.push({ type: 'hp', value: Math.round(effects.hp * scale) });
    if (effects.mad) deltas.push({ type: 'mad', value: Math.round(effects.mad * scale) });
    if (effects.cor) deltas.push({ type: 'cor', value: effects.cor });
    if (effects.dig) deltas.push({ type: 'dig', value: effects.dig });
  };

  switch (input.choice) {
    case 'fight': {
      const chance = clamp(
        cfg.fight.winChanceBase - danger * 0.4,
        cfg.fight.winChanceMin,
        cfg.fight.winChanceMax,
      );
      if (roll < chance) {
        deltas.push({ type: 'dig', value: cfg.fight.winDig });
        narrative.push('你迎了上去，而且你赢了 —— 它退回了它该待的地方。');
        return { deltas, narrative, extraHours, roll, outcome: `战斗获胜（${(chance * 100).toFixed(0)}%）` };
      }
      pushBase(1);
      deltas.push({ type: 'hp', value: cfg.fight.loseHp });
      deltas.push({ type: 'mad', value: cfg.fight.loseMad });
      narrative.push('你迎了上去，但它比你想象的重。你是被自己拖着离开那儿的。');
      return { deltas, narrative, extraHours, roll, outcome: `战斗落败（${(chance * 100).toFixed(0)}%）` };
    }
    case 'flee': {
      const chance = clamp(1 - cfg.flee.successChance - danger * 0.2, 0.05, 0.95);
      if (roll > chance) {
        narrative.push('你没有回头，跑到肺里全是铁锈味才停下。');
        return { deltas, narrative, extraHours, roll, outcome: '逃跑成功' };
      }
      pushBase(1);
      deltas.push({ type: 'hp', value: cfg.flee.failHp });
      deltas.push({ type: 'mad', value: cfg.flee.failMad });
      narrative.push('你跑了，但它比你快。');
      return { deltas, narrative, extraHours, roll, outcome: '逃跑失败' };
    }
    case 'interact': {
      pushBase(0.5);
      deltas.push({ type: 'dig', value: cfg.interact.dig });
      narrative.push('你没有躲，也没有动手 —— 你试着与它打交道。');
      return { deltas, narrative, extraHours, roll, outcome: '互动' };
    }
    case 'observe':
    default: {
      pushBase(1);
      deltas.push({ type: 'dig', value: cfg.observe.dig });
      deltas.push({ type: 'mad', value: cfg.observe.mad });
      narrative.push('你站在原地，把它从头到尾看完了 —— 这大概不是好事，但你记住了。');
      return { deltas, narrative, extraHours, roll, outcome: '观察' };
    }
  }
}

/** 这个事件允许哪些选择（菜单层生成按钮时用它，返回顺序即展示顺序） */
export function choicesOf(eventId: TravelEventId): TravelChoiceId[] {
  return [...TRAVEL_EVENTS[eventId].choices];
}
