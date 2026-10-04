/**
 * 生态 tick（M2.8）：生物自己的节拍。
 *
 *   轻 tick：每小时一次 —— 迁移 / 捕食 / 进化 / 繁衍 / 衰亡（见 domain/creature/ecology.ts）
 *   播种：进程第一次跑（或内容改了）时，从一个**世界 seed 派生**的初态开始
 *
 * 幂等：每个 tick 先到 `creature_ticks` 里抢占 tick_key，抢不到就直接跳过。
 *       补跑：从水位线（最后一条 tick_key）往后逐格补齐，单次有上限。
 *
 * 与 M2.2 的 world-tick 是**两条独立的线**：世界时钟推进天气/月相，这条推进生物。
 * 分表（creature_ticks）而不是共用 world_ticks —— 见 0017_mig_8.sql 的说明。
 *
 * ⚠️ 生态 tick 与玩家指令**无关**：不管有没有人在线，生物都在动。
 */
import { spawnInitialCreatures, tickCreatures, type CreatureSpecies, type CreatureTickResult } from '../domain/creature/index.ts';
import { calamityFactorAt } from '../domain/world/calamity.ts';
import { createSeededRng } from '../domain/rng.ts';
import { hourStartOf } from '../domain/world/clock.ts';
import type { ResolvedEcologyParams } from '../domain/world/zone.ts';
import type { CreatureRepo } from './db/creatures.ts';
// 小时键与 M2.2 世界时钟**同一个口径**（东八区）—— 复用而不是再写一份，
// 否则两条时间线在跨日边界上会错开一小时，而那种错位很难被发现。
import { hourKeyOf } from './world-tick.ts';

const HOUR_MS = 60 * 60 * 1000;

/** 单次调用最多补跑多少小时（防止进程停了半年后一次性跑爆） */
export const MAX_CATCH_UP_HOURS = 72;

export interface CreatureTickOutcome {
  /** 本次真的结算了几个小时 */
  executed: number;
  keys: string[];
  /** 本次是否做了初始播种（世界第一次有生物） */
  seeded: boolean;
  /** 播种了多少只 */
  spawned: number;
  skipped: boolean;
  /** 本次所有小时的合并结果（报告用）；没执行则为 null */
  result: CreatureTickResult | null;
}

export interface AdvanceCreatureOptions {
  /** 忽略进程内水位线，强制查一次库（启动补跑用） */
  force?: boolean;
}

/**
 * 进程内水位线（每份仓储一个）：已经结算到（不含）until 之前的每一个整点。
 * 与 world-tick 同一手法 —— 实例测试里时钟天天回跳，没有这道缓存每次回跳都要查库。
 */
const watermarks = new WeakMap<object, number>();

/** 世界 seed 派生的生态随机源：同一个世界 seed → 同一批生物、同一串迁移 */
function ecologyRng(seed: string, key: string) {
  return createSeededRng(`creature:${seed}:${key}`);
}

/**
 * 推进生态到 now（幂等）。所有时间都来自参数；函数内部不读墙上时间。
 */
export function advanceCreatures(input: {
  repo: CreatureRepo;
  speciesList: readonly CreatureSpecies[];
  /** 漂移目标池：所有可用地点 id */
  locationIds: readonly string[];
  /**
   * M2.57：某地点的相邻地点（捕食范围用）。
   * 不传 = 猎物必须与捕食者同地点（旧口径）—— 但那个口径下捕食实测恒为 0 次。
   */
  neighborsOf?: (locationId: string) => readonly string[];
  /**
   * M2.58 阶段二：地点 → 生态域参数。不传 = 全局基线（旧口径）。
   */
  zoneOf?: (locationId: string) => ResolvedEcologyParams;
  now: number;
  worldSeed: string;
  options?: AdvanceCreatureOptions;
}): CreatureTickOutcome {
  const { repo, speciesList, now, worldSeed } = input;
  const options = input.options ?? {};
  const targetHour = hourStartOf(now);
  const empty: CreatureTickOutcome = {
    executed: 0,
    keys: [],
    seeded: false,
    spawned: 0,
    skipped: true,
    result: null,
  };

  // 水位线短路（O(1)，不查库）
  let until = watermarks.get(repo);
  if (until !== undefined && !options.force && targetHour < until) return empty;

  let seeded = false;
  let spawned = 0;

  // ---- 播种：世界第一次有生物 ----
  // 物种模板每次启动都覆盖式重写（内容改了要生效）；
  // 生物实例只在**库里一只都没有**时播种一次 —— 它们是世界状态，不能被重启重置。
  repo.seedSpecies(speciesList, now);
  if (repo.count() === 0) {
    const starters = spawnInitialCreatures(speciesList, ecologyRng(worldSeed, 'spawn'), now);
    repo.insertMany(starters);
    seeded = true;
    spawned = starters.length;
  }

  if (until === undefined || options.force) {
    const last = repo.lastTick();
    // 水位线 = 最后一格的整点 + 1 小时；从没跑过就从目标整点开始（只跑当前这一格）
    until = last === null ? targetHour : hourStartOf(last.at) + HOUR_MS;
    watermarks.set(repo, until);
  }
  if (!options.force && targetHour < until) {
    return { ...empty, seeded, spawned };
  }

  // 物种表在补跑期间是常量，建一次就够
  const speciesById = new Map(speciesList.map((species) => [species.id, species]));

  // ---- 逐小时补齐 ----
  let cursor = until;
  let executed = 0;
  const keys: string[] = [];
  let merged: CreatureTickResult | null = null;

  while (cursor <= targetHour && executed < MAX_CATCH_UP_HOURS) {
    const key = hourKeyOf(cursor);
    const claimed = repo.claimTick(key, cursor, now, {});
    if (claimed) {
      // 随机源按「世界 seed + 小时键」派生：补跑与「逐小时真的跑过」得到同一结果
      const rng = ecologyRng(worldSeed, key);
      const result = tickCreatures(
        repo.all(),
        {
          speciesById,
          locationIds: input.locationIds,
          ...(input.neighborsOf === undefined ? {} : { neighborsOf: input.neighborsOf }),
          ...(input.zoneOf === undefined ? {} : { zoneOf: input.zoneOf }),
          now: cursor,
          hours: 1,
          /*
           * M2.14：灾厄强度**每一格现场算**。
           *
           * ⚠️ 不能提到循环外面算一次缓存住：一次补跑会跨多天（MAX_CATCH_UP_HOURS = 72），
           * 缓存住会让整段补跑共用同一个值 —— 于是「补跑 72 格」与「逐小时真的跑过 72 次」
           * 得到不同的生态，而这条一致性正是 M2.8 起就守着的（见 ecology.ts:328-331）。
           * calamityAt 是纯函数且只有三次 rng，逐格算的代价可以忽略。
           */
          calamity: calamityFactorAt(worldSeed, cursor),
        },
        rng,
      );
      // 变更写回：更新 → 新增 → 删除（顺序不能反：新生儿的 id 不在库里，先删后插会白跑）
      repo.updateMany(result.creatures, result.changed);
      /*
       * 新增的个体有两类，都是**全新 id**（库里没有这一行，必须 INSERT 而不是 UPDATE）：
       *   births      —— 繁衍出来的
       *   replenishes —— 世界补充进来的（M2.9 前置 1）
       * 两类的处理手法完全一样，合并成一次 insertMany。
       */
      const newcomers = new Set([
        ...result.births.map((birth) => birth.creatureId),
        ...result.replenishes.map((entry) => entry.creatureId),
      ]);
      if (newcomers.size > 0) {
        repo.insertMany(result.creatures.filter((creature) => newcomers.has(creature.id)));
      }
      if (result.deaths.length > 0) {
        repo.deleteMany(result.deaths.map((death) => death.creatureId));
      }
      repo.setTickSummary(key, {
        migrate: result.migrations.length,
        feed: result.feeds.length,
        evolve: result.evolutions.length,
        birth: result.births.length,
        // M2.9 前置 1：世界补充了几只（报告直接读它，不从「数量差」反推）
        replenish: result.replenishes.length,
        death: result.deaths.length,
      });
      merged = mergeTickResults(merged, result);
      keys.push(key);
      executed += 1;
    }
    cursor += HOUR_MS;
  }

  watermarks.set(repo, Math.max(until, cursor));
  return { executed, keys, seeded, spawned, skipped: executed === 0, result: merged };
}

function mergeTickResults(
  base: CreatureTickResult | null,
  next: CreatureTickResult,
): CreatureTickResult {
  if (!base) return next;
  return {
    ticked: base.ticked + next.ticked,
    migrations: [...base.migrations, ...next.migrations],
    evolutions: [...base.evolutions, ...next.evolutions],
    feeds: [...base.feeds, ...next.feeds],
    births: [...base.births, ...next.births],
    deaths: [...base.deaths, ...next.deaths],
    replenishes: [...base.replenishes, ...next.replenishes],
    creatures: next.creatures,
    changed: [...new Set([...base.changed, ...next.changed])],
  };
}
