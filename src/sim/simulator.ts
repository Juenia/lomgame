/**
 * 数值模拟器（W5）
 *
 * 硬约束：
 *   - 只调用真实纯函数（resolvePlay / resolveExplore / resolveBrew / resolveDrink /
 *     resolvePromotion / planCharacterTick / planRest / planPurify / apply），不复制任何规则；
 *   - 背包账本走 domain/item/inventory-rules.ts 的同一份纯规则（与 InventoryRepo 共用）；
 *   - 全部随机来自注入的 seed，同 config 必然产出同一份报告。
 *
 * 与指令层的差异：模拟器不落库、不发消息，只做「同样的判定 + 同样的扣减顺序」。
 */
import { NUMERIC } from '../config/numeric.ts';
import { loadCards } from '../cards/loader.ts';
import type { EventCard } from '../cards/schema.ts';
import { loadAbilities, loadItems, loadLocations, loadRecipes } from '../data/loader.ts';
import type { ItemDef } from '../domain/item/item.ts';
import type { AbilityDef } from '../domain/ability/ability.ts';
import type { InitiatedCharacter } from '../domain/character/types.ts';
import { capsFromAbilityEffects, abilityFlag, mergeAbilityEffects } from '../domain/ability/ability.ts';
import { PATHWAY_TAGS } from '../domain/play/tags.ts';
import { resolvePlay } from '../domain/play/play.ts';
import { planCharacterTick } from '../domain/daily/tick.ts';
import { applyWithCaps, type EffectDelta } from '../domain/effect/apply.ts';
import { EventEngine } from '../domain/event/engine.ts';
import type { TriggerContext } from '../domain/event/trigger.ts';
import { resolveExplore } from '../domain/explore/explore.ts';
import { sequenceAllowed, type LocationDef } from '../domain/explore/location.ts';
import { computePotionSuccess, resolveBrew, resolveDrink } from '../domain/potion/potion.ts';
import { potionProductId, recipeMaterials, type RecipeDef } from '../domain/potion/recipe.ts';
import { checkPromotion, promotionRequirement, resolvePromotion } from '../domain/promotion/promotion.ts';
import { planPurify, planRest, recoveryCounterKey } from '../domain/recovery/recovery.ts';
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import { randomInt, weightedPick } from '../domain/random.ts';
import { addItem, countOf, planRemovalMany, removeItem, type Slot } from '../domain/item/inventory-rules.ts';
import { dateKey } from '../infra/date.ts';
import type { CharacterState, PathwayId, Rng } from '../domain/character/types.ts';
import { STRATEGIES, type StrategyDef, type StrategyId } from './strategy.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const PATHWAYS: PathwayId[] = ['seer', 'warrior', 'sleepless'];

export interface SimConfig {
  characterCount: number;
  days: number;
  seed: string;
  strategy: StrategyId;
  /** 起始时刻（毫秒），默认 2026-01-01T00:00:00Z */
  startAt?: number;
  cards?: EventCard[];
  locations?: LocationDef[];
  recipes?: RecipeDef[];
  abilities?: AbilityDef[];
  /** 物品元数据：材料产出/消耗比只统计 kind=material 的物品 */
  items?: ItemDef[];
}

/**
 * 模拟器的运行时状态。
 *
 * M2.7.6：state 收窄成 InitiatedCharacter —— 模拟器模拟的是**已经入途径**的玩家
 * （它研究的是失控分布、晋升成功率、消化度曲线，全部只在入途径之后才有意义）。
 * 收窄之后「模拟器不会遇到普通人状态」这条假设由类型系统守着，
 * 而不是靠读代码的人记得。
 */
interface Runtime {
  index: number;
  state: InitiatedCharacter;
  inventory: Slot[];
  flags: Set<string>;
  abilities: AbilityDef[];
  tagUsage: Map<string, number>;
  exploreCount: Map<string, number>;
  dailyCounters: Map<string, number>;
  /** M2.69：今天每张卡出过几次（次数，不是「出过没有」—— 卡片的 daily_limit 要读它） */
  triggeredToday: Map<string, number>;
  lastTriggerDate: Map<string, string>;
  actionSeq: number;
  /** 本途径当前序列配方所需的材料 id（材料比按这个口径统计） */
  neededMaterials: Set<string>;
  /** 全部能力定义（用于按 flag 查表解锁，模拟器版 AbilityRepo.unlockedFor） */
  abilityPool: AbilityDef[];
  stats: {
    plays: number;
    explores: number;
    rests: number;
    purifies: number;
    brews: number;
    brewSuccess: number;
    /** 调制被什么挡住：没灵性 / 缺材料（用来定位循环瓶颈） */
    brewBlockedNoMp: number;
    brewBlockedNoMaterials: number;
    materialsFromExplore: number;
    materialsFromCards: number;
    /** 本途径配方所需材料的产出（口径二） */
    neededGained: number;
    /** 调制被哪个材料挡住（itemId → 次数），用来定位循环瓶颈 */
    brewBlockedBy: Map<string, number>;
    drinks: number;
    promotions: number;
    promotionSuccess: number;
    itemsGained: number;
    itemsConsumed: number;
    materialsGained: number;
    materialsConsumed: number;
    lostControls: number;
    recovered: number;
  };
}

export interface PromotionSample {
  day: number;
  chance: number;
  roll: number;
  success: boolean;
  dig: number;
  mad: number;
  cor: number;
  sequence: number;
}

export interface DayMetrics {
  day: number;
  date: string;
  digAvg: number;
  madAvg: number;
  corAvg: number;
  hpAvg: number;
  mpAvg: number;
  lostControl: number;
  recovered: number;
  promotionsAttempted: number;
  promotionsSucceeded: number;
  rests: number;
  purifies: number;
  brews: number;
  drinks: number;
  explores: number;
  plays: number;
  itemsGained: number;
  itemsConsumed: number;
  materialsGained: number;
  materialsConsumed: number;
}

export interface SimSummary {
  characterCount: number;
  days: number;
  seed: string;
  strategy: StrategyId;
  /** 30 天内至少失控过一次的角色比例 */
  lostControlRate: number;
  lostControlPerCharacterAvg: number;
  promotionAttempts: number;
  promotionSuccessRate: number;
  promotionSuccessRateBySequence: Record<string, { attempts: number; success: number; rate: number }>;
  /** DIG 达标但 MAD/COR 双双越过阈值、仍卡在序列 9 的角色比例（正式死循环口径） */
  deadlockRate: number;
  /** 死循环口径的分档诊断（便于解释这个数字怎么来的） */
  deadlockBreakdown: {
    stuckNoPromotion: number;
    stuckHighCor: number;
    stuckHighMad: number;
    stuckBoth: number;
  };
  purifyUsageRate: number;
  restUsageRate: number;
  /** 材料消耗 / 产出 */
  materialRatio: number;
  itemsGained: number;
  itemsConsumed: number;
  /** 材料口径（kind=material）的产出与消耗 */
  materialsGained: number;
  materialsConsumed: number;
  /** 口径二：本途径配方所需材料的产出/消耗比 */
  materialRatioNeededGained: number;
  /** 口径一（全部材料，含跨途径废料）的比值，仅作对照 */
  materialsAllRatio: number;
  finalDigAvg: number;
  finalMadAvg: number;
  finalCorAvg: number;
  finalHpAvg: number;
  sequenceDistribution: Record<string, number>;
  /** 失控触发率按天（30 天曲线） */
  lostControlByDay: number[];
  /** 循环瓶颈诊断：调制因缺灵性 / 缺材料被挡下的次数 */
  brewBlockedNoMp: number;
  brewBlockedNoMaterials: number;
  /** 材料产出按来源拆分 */
  materialsFromExplore: number;
  materialsFromCards: number;
  /** 调制被哪个材料挡住（占比最高的前几项） */
  brewBottleneck: Array<{ itemId: string; count: number }>;
  brews: number;
  drinks: number;
  plays: number;
  explores: number;
}

export interface SimReport {
  config: {
    characterCount: number;
    days: number;
    seed: string;
    strategy: StrategyId;
    strategyName: string;
  };
  daily: DayMetrics[];
  promotionSamples: PromotionSample[];
  summary: SimSummary;
  /** 本次模拟用的关键旋钮（便于报告里写依据） */
  numeric: {
    divisor: number;
    exposureChance: number;
    digThreshold: number;
    madOnFail: number;
    corOnFail: number;
    mpRestore: number;
    purifyCor: number;
    purifyMaterials: number;
  };
}

function createRuntime(index: number, config: SimConfig, startAt: number): Runtime {
  const pathway = PATHWAYS[index % PATHWAYS.length]!;
  void config;
  return {
    index,
    state: {
      id: `sim-${index}`,
      userId: `sim-user-${index}`,
      name: `模拟角色${index}`,
      pathway,
      sequence: 9,
      // M2.7.6：模拟器里的角色一律是「已经入途径」的（见 Runtime 的注释）
      pathwayStatus: 'initiated',
      gender: 'male',
      hp: 100,
      mp: 100,
      mad: 0,
      cor: 0,
      dig: 0,
      dp: 0,
      status: 'active',
      promotionFails: 0,
      createdAt: startAt,
      updatedAt: startAt,
    },
    inventory: [],
    flags: new Set(),
    abilities: [],
    tagUsage: new Map(),
    exploreCount: new Map(),
    dailyCounters: new Map(),
    triggeredToday: new Map(),
    lastTriggerDate: new Map(),
    actionSeq: 0,
    neededMaterials: new Set<string>(),
    abilityPool: [],
    stats: {
      plays: 0,
      explores: 0,
      rests: 0,
      purifies: 0,
      brews: 0,
      brewSuccess: 0,
      brewBlockedNoMp: 0,
      brewBlockedNoMaterials: 0,
      materialsFromExplore: 0,
      materialsFromCards: 0,
      neededGained: 0,
      brewBlockedBy: new Map<string, number>(),
      drinks: 0,
      promotions: 0,
      promotionSuccess: 0,
      itemsGained: 0,
      itemsConsumed: 0,
      materialsGained: 0,
      materialsConsumed: 0,
      lostControls: 0,
      recovered: 0,
    },
  };
}

function abilityEffects(rt: Runtime) {
  return mergeAbilityEffects(rt.abilities);
}

function capsOf(rt: Runtime) {
  return capsFromAbilityEffects(abilityEffects(rt));
}

function triggerContextOf(rt: Runtime, date: string, location?: string): TriggerContext {
  return {
    character: rt.state,
    flags: rt.flags,
    date,
    location,
    partySize: 1,
  };
}

/** 判定用 seed：模拟器 + 全局 seed + 角色 + 天 + 动作序号 */
function seedFor(config: SimConfig, rt: Runtime, day: number): string {
  rt.actionSeq += 1;
  return seedFrom(['sim', config.seed, rt.index, day, rt.actionSeq]);
}

function applyDeltas(rt: Runtime, deltas: EffectDelta[], reason: string, now: number, seed: string) {
  const applied = applyWithCaps(rt.state, deltas, reason, now, seed, capsOf(rt));
  // apply 只改数值、不改 pathway/sequence，所以「已入途径」在结果上仍然成立（见 Runtime 注释）
  rt.state = applied.newState as InitiatedCharacter;
  return applied;
}

function pickPlayText(rt: Runtime, rng: Rng, style: StrategyDef['playStyle']): string {
  const tags = PATHWAY_TAGS[rt.state.pathway];
  const pick = (pool: readonly string[]): string => pool[Math.floor(rng.next() * pool.length)] ?? pool[0] ?? '';
  if (style === 'random') {
    return pick(['随便走了走', '在街上发呆', '跟人闲聊了几句', '睡了一觉', '吃了点东西']);
  }
  const core = pick(tags.core);
  if (style === 'mixed' && rng.next() < 0.5) return `我${core}`;
  const secondary = pick(tags.secondary);
  return `我${core}，顺便${secondary}`;
}

/** 扮演：消化判定 + 暴露抽卡（与 .扮演 指令同一条链路） */
function simulatePlay(
  rt: Runtime,
  ctx: SimContext,
  day: number,
  date: string,
  now: number,
  rng: Rng,
): void {
  const seed = seedFor(ctx.config, rt, day);
  const styleRng = createSeededRng(seedFrom([seed, 'text']));
  const text = pickPlayText(rt, styleRng, ctx.strategy.playStyle);
  const outcome = resolvePlay({
    state: rt.state,
    text,
    tags: PATHWAY_TAGS[rt.state.pathway],
    usage: rt.tagUsage,
    seed,
  });
  applyDeltas(rt, outcome.deltas, '扮演消化', now, seed);
  rt.stats.plays += 1;

  for (const tag of [...outcome.breakdown.matchedCore, ...outcome.breakdown.matchedSecondary]) {
    rt.tagUsage.set(tag, (rt.tagUsage.get(tag) ?? 0) + 1);
  }

  if (!outcome.exposed) return;
  const card = ctx.engine.pick(triggerContextOf(rt, date), rng, {
    date,
    types: ['random'],
    triggeredToday: rt.triggeredToday,
    inCooldown: (candidate) => isInCooldown(rt, candidate, date),
  });
  if (card) applyCard(rt, ctx, card, now, seed, date);
}

function isInCooldown(rt: Runtime, card: EventCard, date: string): boolean {
  const days = card.trigger.cooldown_days;
  if (days <= 0) return false;
  const last = rt.lastTriggerDate.get(card.id);
  if (!last) return false;
  const diff = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / DAY_MS;
  return diff < days;
}

function applyCard(
  rt: Runtime,
  ctx: SimContext,
  card: EventCard,
  now: number,
  seed: string,
  date: string,
): void {
  const { deltas, flagsToSet } = EventEngine.toDeltas(card);
  for (const delta of deltas) {
    if (delta.type === 'item') {
      gainItem(rt, ctx, delta.itemId, Math.max(0, delta.quantity), 'unbound', 'card');
    }
  }
  applyDeltas(
    rt,
    deltas.filter((delta) => delta.type !== 'item'),
    `事件卡:${card.id}`,
    now,
    seed,
  );
  for (const flag of flagsToSet) {
    rt.flags.add(flag);
    rt.abilities = ctxAbilities(rt, flag);
  }
  rt.triggeredToday.set(card.id, (rt.triggeredToday.get(card.id) ?? 0) + 1);
  rt.lastTriggerDate.set(card.id, date);
}

/** 卡片/晋升授予的解锁标记 → 能力（与 AbilityRepo.unlockedFor 同规则：flag 名即 ability_<途径>_<序列>） */
function ctxAbilities(rt: Runtime, flag: string): AbilityDef[] {
  const matched = rt.abilityPool.filter((ability) => abilityFlag(ability.pathway, ability.seq) === flag);
  if (matched.length === 0) return rt.abilities;
  return [...rt.abilities, ...matched];
}

/** 探索：危险 + 掉落 + 地点事件卡（与 .探索 指令同一条链路） */
function simulateExplore(
  rt: Runtime,
  ctx: SimContext,
  day: number,
  date: string,
  now: number,
  rng: Rng,
): void {
  const reachable = ctx.locations.filter((location) => sequenceAllowed(location, rt.state.sequence));
  if (reachable.length === 0) return;

  // 像真人一样按「缺什么找什么」挑地点：主材料优先，其次辅助材料
  const recipe = ctx.recipes.find(
    (candidate) => candidate.pathway === rt.state.pathway && candidate.seq === rt.state.sequence,
  );
  const missing = recipe
    ? recipeMaterials(recipe).filter((need) => countOf(rt.inventory, need.itemId) < need.qty)
    : [];
  // 先解决最难弄到的那件（所有可达地点里的最高供给占比最低者）
  const supplyShare = (itemId: string): number => {
    let best = 0;
    for (const candidate of reachable) {
      const total = candidate.loot.reduce((sum, entry) => sum + entry.weight, 0);
      const hit = candidate.loot.find((entry) => entry.itemId === itemId)?.weight ?? 0;
      if (total > 0) best = Math.max(best, hit / total);
    }
    return best;
  };
  const wanted = [...missing].sort((a, b) => supplyShare(a.itemId) - supplyShare(b.itemId))[0]?.itemId;
  const preferred = wanted
    ? reachable.filter((candidate) => candidate.loot.some((entry) => entry.itemId === wanted))
    : [];
  const pool = preferred.length > 0 ? preferred : reachable;
  // 按目标材料在该地点的权重占比挑，去「最可能出这件东西」的地方
  const location =
    weightedPick(
      pool,
      (candidate) => {
        if (!wanted) return 1;
        const total = candidate.loot.reduce((sum, entry) => sum + entry.weight, 0);
        const hit = candidate.loot.find((entry) => entry.itemId === wanted)?.weight ?? 0;
        return total > 0 ? hit / total : 0;
      },
      rng,
    ) ?? pool[0]!;
  const todayCount = rt.exploreCount.get(location.id) ?? 0;
  /*
   * M2.86：**软上限**（越刷越亏，但不禁止）。
   *
   * 这里原来是 `>= cap` 就 return —— 模拟器因此从不越过软上限，
   * 而真实玩家现在**可以**继续探（只是收益递减、危险上涨）。
   * 模拟器与真实行为不一致，会让所有跑批读数失真。
   */
  if (todayCount >= NUMERIC.explore.hardCapPerLocation) return;

  const seed = seedFor(ctx.config, rt, day);
  const candidates = ctx.engine
    .eligible(triggerContextOf(rt, date, location.name), {
      date,
      location: location.name,
      types: ['daily', 'random', 'hidden'],
      triggeredToday: rt.triggeredToday,
      inCooldown: (candidate) => isInCooldown(rt, candidate, date),
    })
    .filter((card) => location.events.includes(card.id))
    .map((card) => card.id);

  const outcome = resolveExplore({
    state: rt.state,
    location,
    rng,
    seed,
    todayCount,
    candidateEventIds: candidates,
    dangerMultiplier: abilityEffects(rt).exploreDangerMultiplier ?? 1,
  });
  if (!outcome.ok) return;

  if (outcome.deltas.length > 0) applyDeltas(rt, outcome.deltas, '探索危险', now, seed);
  for (const drop of outcome.drops) {
    gainItem(rt, ctx, drop.itemId, drop.quantity, drop.bindType, 'explore');
  }
  rt.exploreCount.set(location.id, todayCount + 1);
  rt.stats.explores += 1;

  if (outcome.eventCardId) {
    const card = ctx.engine.byId(outcome.eventCardId);
    if (card) applyCard(rt, ctx, card, now, seed, date);
  }
}

function simulateBrew(rt: Runtime, ctx: SimContext, day: number, now: number, rng: Rng): void {
  const recipe = ctx.recipes.find(
    (candidate) => candidate.pathway === rt.state.pathway && candidate.seq === rt.state.sequence,
  );
  if (!recipe) return;
  if (rt.state.mp < NUMERIC.potion.mpCost) {
    rt.stats.brewBlockedNoMp += 1;
    return;
  }
  const needs = recipeMaterials(recipe);
  if (!planRemovalMany(rt.inventory, needs).ok) {
    rt.stats.brewBlockedNoMaterials += 1;
    const firstMissing = needs.find((need) => countOf(rt.inventory, need.itemId) < need.qty);
    if (firstMissing) {
      rt.stats.brewBlockedBy.set(
        firstMissing.itemId,
        (rt.stats.brewBlockedBy.get(firstMissing.itemId) ?? 0) + 1,
      );
    }
    return;
  }

  const seed = seedFor(ctx.config, rt, day);
  const outcome = resolveBrew({ state: rt.state, recipe, rng, seed });
  const consumed = planRemovalMany(rt.inventory, outcome.consumed);
  if (!consumed.ok) return;
  for (const need of outcome.consumed) consumeItem(rt, ctx, need.itemId, need.qty);
  applyDeltas(rt, outcome.deltas, `魔药:${recipe.id}`, now, seed);
  rt.stats.brews += 1;
  if (outcome.success) {
    gainItem(rt, ctx, outcome.productItemId, 1, 'unbound');
    rt.stats.brewSuccess += 1;
  }
  void potionProductId;
}

function simulateDrink(rt: Runtime, ctx: SimContext, day: number, now: number, rng: Rng): void {
  const potion = rt.inventory.find((slot) => {
    const id = slot.itemId;
    const recipe = ctx.recipes.find((candidate) => potionProductId(candidate) === id);
    return recipe !== undefined && recipe.pathway === rt.state.pathway && recipe.seq === rt.state.sequence;
  });
  if (!potion) return;

  const seed = seedFor(ctx.config, rt, day);
  const firstTime = !rt.flags.has('first_potion_taken');
  const outcome = resolveDrink({
    state: rt.state,
    potionItemId: potion.itemId,
    rng,
    seed,
    firstTime,
  });
  if (!consumeItem(rt, ctx, potion.itemId, 1)) return;
  applyDeltas(rt, outcome.deltas, `服用:${potion.itemId}`, now, seed);
  rt.stats.drinks += 1;
  rt.flags.add('first_potion_taken');
  const recipe = ctx.recipes.find((candidate) => potionProductId(candidate) === potion.itemId);
  if (recipe) {
    const flag = abilityFlag(recipe.pathway, recipe.seq);
    rt.flags.add(flag);
    rt.abilities = ctxAbilities(rt, flag);
  }
}

function simulateRest(rt: Runtime, ctx: SimContext, day: number, now: number): void {
  const plan = planRest(rt.state);
  const key = recoveryCounterKey(plan);
  const used = rt.dailyCounters.get(key) ?? 0;
  if (used >= plan.dailyLimit) return;

  const seed = seedFor(ctx.config, rt, day);
  const applied = applyDeltas(
    rt,
    plan.deltas,
    '休息',
    now,
    seed,
  );
  if (applied.rejected) return;
  rt.dailyCounters.set(key, used + 1);
  rt.stats.rests += 1;
  if (plan.clearsLostControl) rt.state = { ...rt.state, status: 'active' };
}

function simulatePurify(rt: Runtime, ctx: SimContext, day: number, now: number): void {
  const plan = planPurify(rt.state);
  const key = recoveryCounterKey(plan);
  const used = rt.dailyCounters.get(key) ?? 0;
  if (used >= plan.dailyLimit) return;
  if (!planRemovalMany(rt.inventory, plan.materials).ok) return;

  const seed = seedFor(ctx.config, rt, day);
  for (const need of plan.materials) consumeItem(rt, ctx, need.itemId, need.qty);
  const applied = applyDeltas(
    rt,
    plan.deltas,
    '净化',
    now,
    seed,
  );
  if (applied.rejected) {
    for (const need of plan.materials) addItem(rt.inventory, need.itemId, need.qty, 'unbound');
    return;
  }
  rt.dailyCounters.set(key, used + 1);
  rt.stats.purifies += 1;
  if (plan.clearsLostControl) rt.state = { ...rt.state, status: 'active' };
}

function simulatePromotion(
  rt: Runtime,
  ctx: SimContext,
  day: number,
  now: number,
  rng: Rng,
  samples: PromotionSample[],
): void {
  const recipe = ctx.recipes.find(
    (candidate) => candidate.pathway === rt.state.pathway && candidate.seq === rt.state.sequence,
  );
  if (!recipe) return;
  const requirement = promotionRequirement(recipe, rt.state);
  const check = checkPromotion({
    state: rt.state,
    requirement,
    ownedOf: (itemId) => countOf(rt.inventory, itemId),
    hasRequiredFlag: rt.flags.has(requirement.requiredFlag),
  });
  if (!check.ok) {
    // 被 COR/MAD 拖住的角色：DIG 达标但条件不满足 → 记一次死循环样本（由 summary 统计）
    return;
  }

  const seed = seedFor(ctx.config, rt, day);
  const outcome = resolvePromotion({
    state: rt.state,
    requirement,
    fails: rt.state.promotionFails,
    rng,
    seed,
  });
  for (const need of outcome.consumed) consumeItem(rt, ctx, need.itemId, need.qty);
  applyDeltas(rt, outcome.deltas, '晋升判定', now, seed);

  rt.state = {
    ...rt.state,
    status: outcome.status,
    promotionFails: outcome.success ? 0 : rt.state.promotionFails + 1,
  };
  if (outcome.success) {
    for (const flag of outcome.flagsToSet) {
      rt.flags.add(flag);
      rt.abilities = ctxAbilities(rt, flag);
    }
  }
  rt.stats.promotions += 1;
  if (outcome.success) rt.stats.promotionSuccess += 1;

  samples.push({
    day,
    chance: outcome.chance.chance,
    roll: outcome.roll,
    success: outcome.success,
    dig: Math.round(rt.state.dig * 100) / 100,
    mad: rt.state.mad,
    cor: rt.state.cor,
    sequence: outcome.targetSequence,
  });
}

interface SimContext {
  config: SimConfig;
  strategy: StrategyDef;
  engine: EventEngine;
  locations: LocationDef[];
  recipes: RecipeDef[];
  /** kind=material 的物品 id：材料口径的产出/消耗只统计它们 */
  materials: ReadonlySet<string>;
}

type ItemSource = 'explore' | 'card' | 'other';

function gainItem(
  rt: Runtime,
  ctx: SimContext,
  itemId: string,
  quantity: number,
  bindType: Slot['bindType'],
  source: ItemSource = 'other',
): void {
  addItem(rt.inventory, itemId, quantity, bindType);
  rt.stats.itemsGained += quantity;
  if (!ctx.materials.has(itemId)) return;
  rt.stats.materialsGained += quantity;
  if (source === 'explore') rt.stats.materialsFromExplore += quantity;
  else if (source === 'card') rt.stats.materialsFromCards += quantity;
  // 口径二：只统计本途径配方真正要用的材料（跨途径材料留待交易系统消化）
  if (rt.neededMaterials.has(itemId)) rt.stats.neededGained += quantity;
}

function consumeItem(rt: Runtime, ctx: SimContext, itemId: string, quantity: number): boolean {
  if (!removeItem(rt.inventory, itemId, quantity)) return false;
  rt.stats.itemsConsumed += quantity;
  if (ctx.materials.has(itemId)) rt.stats.materialsConsumed += quantity;
  return true;
}

function simulateDay(
  rt: Runtime,
  ctx: SimContext,
  day: number,
  now: number,
  rng: Rng,
  metrics: DayMetrics,
  samples: PromotionSample[],
): void {
  const date = dateKey(now);
  // 每日重置
  rt.tagUsage.clear();
  rt.exploreCount.clear();
  rt.dailyCounters.clear();
  rt.triggeredToday.clear();

  // 1) 每日结算（AP/MP 恢复 + 失控判定，与线上 tick 同一个 planCharacterTick）
  const plan = planCharacterTick({ state: rt.state, rng });
  if (plan.deltas.length > 0 || plan.status !== rt.state.status) {
    const seed = seedFrom(['sim', ctx.config.seed, rt.index, 'tick', day]);
    applyDeltas(rt, plan.deltas, `每日tick:${date}`, now, seed);
    rt.state = { ...rt.state, status: plan.status };
  }
  if (plan.recoveredFrom === 'lost_control') {
    metrics.recovered += 1;
    rt.stats.recovered += 1;
  }
  if (plan.lostControl?.triggered) {
    metrics.lostControl += 1;
    rt.stats.lostControls += 1;
  }

  // 2) 日常行动
  const before = { ...rt.stats };

  if (ctx.strategy.randomOnly) {
    const [min, max] = ctx.strategy.randomActions ?? [0, 3];
    const count = randomInt(rng, min, max);
    const weights = ctx.strategy.actionWeights ?? { play: 40, explore: 25, brew: 15, drink: 10, promote: 10 };
    const actions: Array<{ key: keyof typeof weights; weight: number }> = [
      { key: 'play', weight: weights.play },
      { key: 'explore', weight: weights.explore },
      { key: 'brew', weight: weights.brew },
      { key: 'drink', weight: weights.drink },
      { key: 'promote', weight: weights.promote },
    ];
    for (let i = 0; i < count; i += 1) {
      const action = weightedPick(actions, (entry) => entry.weight, rng)?.key ?? 'play';
      if (action === 'play') simulatePlay(rt, ctx, day, date, now, rng);
      else if (action === 'explore') simulateExplore(rt, ctx, day, date, now, rng);
      else if (action === 'brew') simulateBrew(rt, ctx, day, now, rng);
      else if (action === 'drink') simulateDrink(rt, ctx, day, now, rng);
      else simulatePromotion(rt, ctx, day, now, rng, samples);
    }
    flushMetrics(rt, metrics, before);
    return;
  }

  for (let i = 0; i < ctx.strategy.playsPerDay; i += 1) simulatePlay(rt, ctx, day, date, now, rng);
  for (let i = 0; i < ctx.strategy.exploresPerDay; i += 1) {
    simulateExplore(rt, ctx, day, date, now, rng);
  }
  for (let i = 0; i < ctx.strategy.brewsPerDay; i += 1) simulateBrew(rt, ctx, day, now, rng);
  if (ctx.strategy.drinkImmediately) simulateDrink(rt, ctx, day, now, rng);

  const purifyThreshold = ctx.strategy.purifyWhenCorAtLeast;
  if (purifyThreshold !== undefined && rt.state.cor >= purifyThreshold) {
    simulatePurify(rt, ctx, day, now);
  }
  for (let i = 0; i < ctx.strategy.restsPerDay; i += 1) simulateRest(rt, ctx, day, now);

  // 3) 晋升：DIG 超过门槛 + margin 才试
  const threshold = NUMERIC.promotion.digThreshold + ctx.strategy.promoteDigMargin;
  if (rt.state.dig >= threshold && rt.state.sequence > 0) {
    simulatePromotion(rt, ctx, day, now, rng, samples);
  }

  flushMetrics(rt, metrics, before);
}

function flushMetrics(
  rt: Runtime,
  metrics: DayMetrics,
  before: Runtime['stats'],
): void {
  metrics.plays += rt.stats.plays - before.plays;
  metrics.explores += rt.stats.explores - before.explores;
  metrics.rests += rt.stats.rests - before.rests;
  metrics.purifies += rt.stats.purifies - before.purifies;
  metrics.brews += rt.stats.brews - before.brews;
  metrics.drinks += rt.stats.drinks - before.drinks;
}

export function runSimulation(config: SimConfig): SimReport {
  const cards = config.cards ?? loadCards().cards;
  const locations = config.locations ?? loadLocations().locations;
  const recipes = config.recipes ?? loadRecipes().recipes;
  const abilities = config.abilities ?? loadAbilities().abilities;
  const items = config.items ?? loadItems().items;
  const materialIds = new Set(items.filter((item) => item.kind === 'material').map((item) => item.id));
  const engine = new EventEngine(cards);
  const strategy = STRATEGIES[config.strategy];
  const startAt = config.startAt ?? Date.UTC(2026, 0, 1);

  const runtimes: Runtime[] = Array.from({ length: config.characterCount }, (_, index) => {
    const runtime = createRuntime(index, config, startAt);
    runtime.abilityPool = abilities;
    const recipe = recipes.find(
      (candidate) => candidate.pathway === runtime.state.pathway && candidate.seq === runtime.state.sequence,
    );
    runtime.neededMaterials = new Set(recipeMaterials(recipe ?? recipes[0]!).map((need) => need.itemId));
    return runtime;
  });
  void abilities;

  const ctx: SimContext = { config, strategy, engine, locations, recipes, materials: materialIds };
  const daily: DayMetrics[] = [];
  const samples: PromotionSample[] = [];

  for (let day = 0; day < config.days; day += 1) {
    const now = startAt + day * DAY_MS;
    const date = dateKey(now);
    const metrics: DayMetrics = {
      day,
      date,
      digAvg: 0,
      madAvg: 0,
      corAvg: 0,
      hpAvg: 0,
      mpAvg: 0,
      lostControl: 0,
      recovered: 0,
      promotionsAttempted: 0,
      promotionsSucceeded: 0,
      rests: 0,
      purifies: 0,
      brews: 0,
      drinks: 0,
      explores: 0,
      plays: 0,
      itemsGained: 0,
      itemsConsumed: 0,
      materialsGained: 0,
      materialsConsumed: 0,
    };

    let digSum = 0;
    let madSum = 0;
    let corSum = 0;
    let hpSum = 0;
    let mpSum = 0;

    for (const runtime of runtimes) {
      const rng = createSeededRng(seedFrom(['sim', config.seed, runtime.index, 'day', day]));
      const promotionsBefore = runtime.stats.promotions;
      const successBefore = runtime.stats.promotionSuccess;
      const gainedBefore = runtime.stats.itemsGained;
      const consumedBefore = runtime.stats.itemsConsumed;
      const materialsGainedBefore = runtime.stats.materialsGained;
      const materialsConsumedBefore = runtime.stats.materialsConsumed;

      simulateDay(runtime, ctx, day, now, rng, metrics, samples);

      metrics.promotionsAttempted += runtime.stats.promotions - promotionsBefore;
      metrics.promotionsSucceeded += runtime.stats.promotionSuccess - successBefore;
      metrics.itemsGained += runtime.stats.itemsGained - gainedBefore;
      metrics.itemsConsumed += runtime.stats.itemsConsumed - consumedBefore;
      metrics.materialsGained += runtime.stats.materialsGained - materialsGainedBefore;
      metrics.materialsConsumed += runtime.stats.materialsConsumed - materialsConsumedBefore;

      digSum += runtime.state.dig;
      madSum += runtime.state.mad;
      corSum += runtime.state.cor;
      hpSum += runtime.state.hp;
      mpSum += runtime.state.mp;
    }

    const count = Math.max(1, runtimes.length);
    metrics.digAvg = digSum / count;
    metrics.madAvg = madSum / count;
    metrics.corAvg = corSum / count;
    metrics.hpAvg = hpSum / count;
    metrics.mpAvg = mpSum / count;
    daily.push(metrics);
  }

  return buildReport(config, strategy, runtimes, daily, samples, materialIds);
}

function buildReport(
  config: SimConfig,
  strategy: StrategyDef,
  runtimes: Runtime[],
  daily: DayMetrics[],
  samples: PromotionSample[],
  materialIds: ReadonlySet<string>,
): SimReport {
  const count = Math.max(1, runtimes.length);
  const lostControlCharacters = runtimes.filter((rt) => rt.stats.lostControls > 0).length;
  const purifiedCharacters = runtimes.filter((rt) => rt.stats.purifies > 0).length;
  const restedCharacters = runtimes.filter((rt) => rt.stats.rests > 0).length;

  const itemsGained = runtimes.reduce((sum, rt) => sum + rt.stats.itemsGained, 0);
  const itemsConsumed = runtimes.reduce((sum, rt) => sum + rt.stats.itemsConsumed, 0);
  // 材料口径：只算 kind=material（金镑与杂物只进不出，混进来会把比值压到失真）
  const materialsGained = runtimes.reduce((sum, rt) => sum + rt.stats.materialsGained, 0);
  const materialsConsumed = runtimes.reduce((sum, rt) => sum + rt.stats.materialsConsumed, 0);
  const materialsFromExplore = runtimes.reduce((sum, rt) => sum + rt.stats.materialsFromExplore, 0);
  const materialsFromCards = runtimes.reduce((sum, rt) => sum + rt.stats.materialsFromCards, 0);
  const neededGained = runtimes.reduce((sum, rt) => sum + rt.stats.neededGained, 0);
  const neededConsumed = materialsConsumed;
  const blockedBy = new Map<string, number>();
  for (const rt of runtimes) {
    for (const [itemId, count] of rt.stats.brewBlockedBy) {
      blockedBy.set(itemId, (blockedBy.get(itemId) ?? 0) + count);
    }
  }

  const promotionAttempts = runtimes.reduce((sum, rt) => sum + rt.stats.promotions, 0);
  const promotionSuccess = runtimes.reduce((sum, rt) => sum + rt.stats.promotionSuccess, 0);

  const bySequence: Record<string, { attempts: number; success: number; rate: number }> = {};
  for (const sample of samples) {
    const key = `${sample.sequence + 1}->${sample.sequence}`;
    const entry = (bySequence[key] ??= { attempts: 0, success: 0, rate: 0 });
    entry.attempts += 1;
    if (sample.success) entry.success += 1;
  }
  for (const entry of Object.values(bySequence)) entry.rate = entry.success / Math.max(1, entry.attempts);

  // 死循环诊断：DIG 已达标却还卡在序列 9，按不同严格度分别统计
  const stuckBase = runtimes.filter(
    (rt) => rt.state.sequence === 9 && rt.state.dig >= NUMERIC.promotion.digThreshold,
  );
  // 死循环用固定尺子（deadlock*），不跟着闸门走：闸门管「多久失控一次」，尺子管「是不是卡死了」
  const stuckHighCor = stuckBase.filter((rt) => rt.state.cor >= NUMERIC.lossOfControl.deadlockCorThreshold);
  const stuckHighMad = stuckBase.filter((rt) => rt.state.mad >= NUMERIC.lossOfControl.deadlockMadThreshold);
  const stuckBoth = stuckBase.filter(
    (rt) =>
      rt.state.mad >= NUMERIC.lossOfControl.deadlockMadThreshold &&
      rt.state.cor >= NUMERIC.lossOfControl.deadlockCorThreshold,
  );
  /**
   * 正式口径：DIG 达标、仍是序列 9，且「疯狂与污染都在阈值之上」——
   * 这类角色每天都可能失控，又没有晋升收益，是真正被代价拖死的状态。
   */
  const deadlocked = stuckBoth.length;

  const sequenceDistribution: Record<string, number> = {};
  for (const rt of runtimes) {
    const key = String(rt.state.sequence);
    sequenceDistribution[key] = (sequenceDistribution[key] ?? 0) + 1;
  }

  const lastDay = daily[daily.length - 1];

  return {
    config: {
      characterCount: config.characterCount,
      days: config.days,
      seed: config.seed,
      strategy: config.strategy,
      strategyName: strategy.name,
    },
    daily,
    promotionSamples: samples,
    summary: {
      characterCount: runtimes.length,
      days: config.days,
      seed: config.seed,
      strategy: config.strategy,
      lostControlRate: lostControlCharacters / count,
      lostControlPerCharacterAvg:
        runtimes.reduce((sum, rt) => sum + rt.stats.lostControls, 0) / count,
      promotionAttempts,
      promotionSuccessRate: promotionSuccess / Math.max(1, promotionAttempts),
      promotionSuccessRateBySequence: bySequence,
      deadlockRate: deadlocked / count,
      deadlockBreakdown: {
        stuckNoPromotion: stuckBase.length / count,
        stuckHighCor: stuckHighCor.length / count,
        stuckHighMad: stuckHighMad.length / count,
        stuckBoth: stuckBoth.length / count,
      },
      purifyUsageRate: purifiedCharacters / count,
      restUsageRate: restedCharacters / count,
      materialRatio: neededConsumed / Math.max(1, neededGained),
      materialsAllRatio: materialsConsumed / Math.max(1, materialsGained),
      itemsGained,
      itemsConsumed,
      materialsGained,
      materialsConsumed,
      materialRatioNeededGained: neededGained,
      finalDigAvg: lastDay?.digAvg ?? 0,
      finalMadAvg: lastDay?.madAvg ?? 0,
      finalCorAvg: lastDay?.corAvg ?? 0,
      finalHpAvg: lastDay?.hpAvg ?? 0,
      sequenceDistribution,
      lostControlByDay: daily.map((entry) => entry.lostControl / count),
      brewBlockedNoMp: runtimes.reduce((sum, rt) => sum + rt.stats.brewBlockedNoMp, 0),
      brewBlockedNoMaterials: runtimes.reduce((sum, rt) => sum + rt.stats.brewBlockedNoMaterials, 0),
      materialsFromExplore,
      materialsFromCards,
      brewBottleneck: [...blockedBy.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([itemId, count]) => ({ itemId, count })),
      brews: runtimes.reduce((sum, rt) => sum + rt.stats.brews, 0),
      drinks: runtimes.reduce((sum, rt) => sum + rt.stats.drinks, 0),
      plays: runtimes.reduce((sum, rt) => sum + rt.stats.plays, 0),
      explores: runtimes.reduce((sum, rt) => sum + rt.stats.explores, 0),
    },
    numeric: {
      divisor: NUMERIC.lossOfControl.divisor,
      exposureChance: NUMERIC.play.exposureChance,
      digThreshold: NUMERIC.promotion.digThreshold,
      madOnFail: NUMERIC.promotion.madOnFail,
      corOnFail: NUMERIC.promotion.corOnFail,
      mpRestore: NUMERIC.tick.mpRestore,
      purifyCor: NUMERIC.recovery.purify.cor,
      purifyMaterials: NUMERIC.recovery.purify.materials.reduce((sum, need) => sum + need.qty, 0),
    },
  };
}
