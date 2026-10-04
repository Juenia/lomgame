/**
 * 生态 tick（M2.8）：世界自己在动。
 *
 * 生物不是静态分布 —— 每小时一次轻 tick 上跑五种行为（任务书 §4.3.5）：
 *
 *   迁移  栖息地变了 / 迁徙习性        → 换地点（**这是「惊喜感」的来源**）
 *   捕食  超过 feedThresholdHours 没吃  → HP 恢复，附近低序列生物减少
 *   进化  存活时间 × 捕食次数           → 序列 -1（变强）
 *   繁衍  群居 + 稳定期                 → 数量 +1
 *   补充  世界自己往空下来的地点放一只   → 数量 +1（**M2.9 前置 1**）
 *   衰亡  长期没捕食                    → HP 持续下滑，滑到 0 就消失
 *
 * 一句话：**玩家不清剿，生物会变强；世界不会等人。**
 * （M2.8 不做战斗，所以「玩家清剿」这一支暂时没有入口 —— 但 tick 的其余部分都在跑。）
 *
 * 本文件是纯函数：tickCreatures(creatures, world, rng) → 结果，无 IO、无副作用。
 * 输入列表不被修改（返回新列表），落库由 infra/creature-tick.ts 负责。
 */
import { CREATURE, NUMERIC } from '../../config/numeric.ts';
import { rollChance, weightedPick } from '../random.ts';
import {
  resolveEcologyParams,
  spiritualityActivity,
  pollutionDecay,
  orderPressure,
  fearReproduceFactor,
  type ResolvedEcologyParams,
} from '../world/zone.ts';
import type { Rng } from '../character/types.ts';
import type {
  Creature,
  CreatureBirth,
  CreatureDeath,
  CreatureEvolution,
  CreatureFeed,
  CreatureMigration,
  CreatureReplenish,
  CreatureRelations,
  CreatureSpecies,
  CreatureStatus,
  CreatureTickResult,
} from './types.ts';

const HOUR_MS = 60 * 60 * 1000;

/** 生态 tick 的世界输入：调用方查库/查世界后喂进来，判定层不认识数据库。 */
export interface EcologyWorld {
  speciesById: ReadonlyMap<string, CreatureSpecies>;
  /** 漂移的目标池：所有可用地点 id。一只本该在南大陆的生物可能出现在普利兹港。 */
  locationIds: readonly string[];
  /** 当前时刻（毫秒） */
  now: number;
  /**
   * 本次 tick 覆盖几小时（补跑时可能 > 1，例如进程重启后补 5 格）。
   * 行为按小时逐格掷，所以补跑与「逐小时真的跑过」结果一致。
   */
  hours: number;
  /**
   * M2.14：灾厄强度 0—1（0 / 不传 = 没有灾厄）。
   *
   * ⚠️ **必须每次调用现场算**（`calamityFactorAt(worldSeed, now)`），
   * **不能**在这一层的构造处算一次缓存住：生态 tick 一次补跑会跨多天，
   * 缓存住会让整段补跑共用同一个灾厄值 —— 补跑与逐小时跑就不一致了。
   * 这与「世界补充用绝对小时桶而不是循环下标」是同一条纪律（见 :328-331）。
   *
   * 做法上是**非破坏性的**：不传就是 0，既有行为逐位不变（与 ExploreWorldInput 同一手法）。
   */
  calamity?: number;
  /**
   * M2.57：某地点的**相邻地点**（捕食范围用）。
   *
   * 可选：不传 = 猎物必须与捕食者同地点（旧口径，逐位不变）。
   */
  neighborsOf?: (locationId: string) => readonly string[];
  /**
   * M2.58 阶段二：某地点所属**生态域**的有效参数。
   *
   * 可选：不传 = 所有地点用全局基线（与加生态域之前逐位相同）。
   *
   * 为什么是一个函数而不是一张现成的 Map：判定层不认识 ZoneIndex（那是 world 层的东西），
   * 只知道「给我一个地点 id，我告诉你那里的生态参数长什么样」。
   * 这与 neighborsOf 同一个手法 —— 调用方负责查，判定层负责算。
   */
  zoneOf?: (locationId: string) => ResolvedEcologyParams;
}

/**
 * 某个地点的有效生态参数。
 *
 * 没传 zoneOf（或它不认识这个地点）时，返回**全局基线** ——
 * 这份基线是从同一批 CREATURE.ecology 常量现算的，所以「不传」与
 * 「域表全空」是同一件事，而两者都与加这一层之前逐位相同。
 */
function ecologyParamsAt(world: EcologyWorld, locationId: string): ResolvedEcologyParams {
  return world.zoneOf?.(locationId) ?? resolveEcologyParams(undefined);
}

/**
 * **一只濒死生物每次 tick 的衰亡概率**（M2.66：抽成函数）。
 *
 * 四个因子逐条都是「这块地方有多不适合活下去」：
 *   `decayChance`    —— 全局基线（CREATURE.ecology.decayChance）
 *   `decayMultiplier` —— 域自己声明的衰亡倍率（外神裂隙 ×2.0、地下墓穴 ×0.5）
 *   `pollutionDecay`  —— 污染 = 毒死（M2.58）
 *   `orderPressure`   —— 秩序 = 有人来清剿（M2.66）
 *
 * 抽出来不是为了好看：这条公式是**四个来源的合成**，而「谁在影响衰亡」
 * 只该有一个地方能回答。测试也直接读它（`test/m2-66-zone-params.test.ts`）。
 */
export function decayChanceOf(params: ResolvedEcologyParams): number {
  return (
    CREATURE.ecology.decayChance *
    params.decayMultiplier *
    pollutionDecay(params) *
    orderPressure(params)
  );
}

/**
 * M2.14：灾厄期「雾里的东西往有人的地方走」。
 *
 * 放大的是**漂移**（离开栖息地）而不是迁移本身 ——
 * 「一只本该在南大陆的生物出现在普利兹港」才是玩家当场看得见的那件事，
 * 而普通迁移只是换了个同样合理的地方。
 */
function strayChanceOf(world: EcologyWorld): number {
  const boost = NUMERIC.calamity.effects.strayBoost;
  return Math.min(1, CREATURE.ecology.strayChance * (1 + (world.calamity ?? 0) * boost));
}

/** M2.14：灾厄期世界更频繁地往空下来的地点放东西（产出变多的那一半） */
function replenishChanceOf(base: number, world: EcologyWorld): number {
  const boost = NUMERIC.calamity.effects.replenishBoost;
  return Math.min(1, base * (1 + (world.calamity ?? 0) * boost));
}

/**
 * 迁移概率 ＝ 全局基线 × 习性 × **地点所属域的迁移倍率** × 灵性活跃加成。
 *
 * M2.58 阶段二之前这里只读全局常量，所以**普利兹港和拜朗的生物一样爱迁徙**。
 * 现在多了一层域参数：城市雾区（×1.4，人来人往）的东西留不住，
 * 地下墓穴（×0.6，封闭）的东西进得少出得也少。
 *
 * 灵性浓度也参与：灵性浓的地方非凡生物更活跃，而「活跃」在这里的表现就是更爱动。
 * 不传 zoneOf 时 params 是全局基线（倍数全 1、灵性 0），逐位回到 M2.8 的行为。
 */
function migrateChanceOf(species: CreatureSpecies, params: ResolvedEcologyParams): number {
  let chance = CREATURE.ecology.migrateChance * params.migrateMultiplier * spiritualityActivity(params);
  if (species.habits.includes('migratory')) chance *= 3;
  if (species.habits.includes('territorial')) chance *= 1.5;
  // 群居生物待在一起：迁移明显更少
  if (species.habits.includes('social')) chance *= 0.5;
  return chance;
}

/* ---------------- 生态关系网（M2.58 阶段一） ---------------- */

/**
 * 一个物种的关系（没有声明时是一份空关系）。
 *
 * ⚠️ 空关系**不等于**「什么都不吃」：它表示「这个物种没有声明任何边」，
 * 判定层据此落回 M2.8 的序列差规则 —— 与完全没有 relations 段的结果**完全一致**
 * （因为关系网是纯加法的，见 canPreyOn 的说明）。
 * schema 层仍然保留 undefined 与空对象的区分，那只是让内容表能表达
 * 「我声明过、但四条边都没有」这个意图（loader 会对它发一条 warn）。
 */
function relationsOf(species: CreatureSpecies): CreatureRelations {
  return (
    species.relations ?? { role: 'consumer', prey: [], predators: [], symbiosis: [], parasite: [] }
  );
}

/**
 * 捕食者能不能吃这只猎物（M2.58）。
 *
 * 两条规则，按顺序判定，第一条命中就返回：
 *
 *   1. **关系命中** —— 捕食者的 prey 列表里有这只猎物。命中即**吃得到**，
 *      不看序列差 —— 这正是「雾鸦吃普通乌鸦」与「序列差刚好是 2」之间的区别。
 *   2. **关系没命中** —— 落回 M2.8 的序列差规则（prey_seq >= pred_seq + predatorSeqGap）。
 *      **兼容性的落点：既有物种在本轮之前行为逐位不变。**
 *
 * ## prey 是**唯一权威**，predators 只做元数据
 *
 * 这一条也是踩过坑之后收敛的：第一版让猎物的 predators 列表也参与判定（任一命中即可），
 * 结果是一对物种**互相捕食** —— 骨语者声明吃骨唱诗班、骨唱诗班声明吃灰雾游魂，
 * 而灰雾游魂的 predators 里有时序蠕虫，于是「时序蠕虫吃骨语者」与
 * 「骨语者吃时序蠕虫」同时成立。既有测试抓到了它：期望 1 次捕食，实测 2 次。
 *
 * 现在的分工是：
 *   - prey      —— 判定的**唯一依据**（谁吃谁，捕食者自己说了算）
 *   - predators —— 冗余的反向索引，供报告、审计与 loader 的双向一致性校验用；
 *                 **运行期一个判定都不读它**
 *
 * 好处是每条边只有一处定义，不可能出现「同一对生物有时吃得到有时吃不到」；
 * 代价是两边必须手工保持一致 —— 那由 loader 的启动校验兜住，不靠人记得。
 *
 * ## 关系网是**纯加法** —— 它只加边，不删边
 *
 * 这一条是踩过坑之后改的，值得写下来。
 *
 * 第一版实现让关系网**取代**序列差：声明过关系的物种之间，只有声明过的边才吃得到。
 * 结果是既有测试当场红了一条（test/m2-8.test.ts 的捕食断言）—— 而那条断言是对的：
 * 骨语者（序列 7）在同一地点遇到一只序列被构造成更弱的猎物时应当吃得到它，
 * 而骨语者的 prey 列表里只有骨唱诗班 —— 关系网一关门，它就什么都不吃了。
 *
 * 根因不是测试写得死，而是取代这个决定本身错了：
 *   - 关系网按**物种**声明，11 个物种里只有 7 对栖息地重叠。
 *     一旦对那些没声明关系的配对关门，一大批物种会失去**全部**猎物
 *     （它们的猎物与它们不共享任何地点），于是捕食恒为 0、进化永不发生 ——
 *     这正是 M2.8 实测过、并写在 numeric.ts:2074-2082 的那个坑的形状：
 *     封闭系统里没有食物链底层，捕食在数学上不可能发生。
 *   - 而且取代会让内容表的**每一条遗漏**都变成一次静默的生态故障：
 *     少写一条边 = 一个物种饿死，而症状只是「捕食次数偏低」。
 *
 * 所以现在的口径是：**关系网表达谁吃谁，序列差继续表达强弱，两者取并集。**
 * 内容同学补关系是在**补充与显式化**，不是在赌自己的表写全了没有；
 * 补一半的内容表不会让世界半坏。
 *
 * ## 已知边界：这一层还**不能禁止**某条捕食
 *
 * 纯加法意味着「骨语者不吃灰雾游魂」这句话现在是**写不下来**的：
 * 只要序列差够，它照吃不误。要表达禁止，需要一个显式的否定声明
 * （例如 relations 里加一个 avoid 列表），那是下一步的事 ——
 * 本轮不做，因为**先把边加对，再谈删边**：现在连谁吃谁都还没有。
 *
 * index 是可选的：测试可以只传两个物种对象，不给索引。
 */
export function canPreyOn(
  predatorSpecies: CreatureSpecies | undefined,
  preySpecies: CreatureSpecies | undefined,
  preySequence: number,
  predatorSequence: number,
): boolean {
  /*
   * 关系命中：**只看捕食者自己的 prey 列表**。
   *
   * ⚠️ 这里**刻意不加**「猎物序列必须更弱」之类的可行性门槛。
   *
   * 试过，两种写法都错：
   *   - 写成 pred_seq <= prey_seq（吃到同级或更弱）：会挡掉「雾鸦(8) 吃普通乌鸦(9)」，
   *     而那正是关系网存在的理由 —— 只留下「序列差本来够」的边等于没做。
   *   - 写成 prey_seq > pred_seq（猎物严格更弱）：会挡掉**同级捕食**，
   *     而同级互吃在诡秘世界里是常态（镜中客吃命运幻影就是同级）。
   *
   * 真正该防的那件事（一对物种互相捕食）**已经在数据层防住了**：
   * 没有哪两个物种在各自的 prey 里互相点名，loader 的双向校验与
   * test/m2-58 的内容表用例一起守着它。数据层的约束就该在数据层解决，
   * 不该让判定层背一个只在特定实例序列下才发作的隐式规则。
   */
  if (predatorSpecies !== undefined && preySpecies !== undefined) {
    if (relationsOf(predatorSpecies).prey.includes(preySpecies.id)) return true;
  }
  // 关系没命中 → M2.8 的序列差规则（兼容落点，数值一个没动）
  return preySequence >= predatorSequence + CREATURE.ecology.predatorSeqGap;
}

/**
 * 地点 → 以它为栖息地的物种（世界补充的抽签池）。
 *
 * 从 speciesById 现算而不是让调用方传进来：调用方（creature-tick）已经给了物种表，
 * 再要一张索引就多一个「两边不一致」的机会，而这张表是纯粹的派生数据。
 */
function habitatIndex(speciesById: ReadonlyMap<string, CreatureSpecies>): Map<string, CreatureSpecies[]> {
  const out = new Map<string, CreatureSpecies[]>();
  for (const species of speciesById.values()) {
    for (const locationId of species.habitat) {
      const list = out.get(locationId) ?? [];
      list.push(species);
      out.set(locationId, list);
    }
  }
  return out;
}

/** 距离上次进食过了几小时（从没吃过就从出生算起） */
function hoursSinceFed(creature: Creature, now: number): number {
  const base = creature.lastFedAt ?? creature.spawnedAt;
  return (now - base) / HOUR_MS;
}

/** 根据饥饿程度算出该有的状态 */
function statusOf(creature: Creature, now: number): CreatureStatus {
  const hungryHours = hoursSinceFed(creature, now);
  if (hungryHours >= CREATURE.ecology.decayHours) return 'dying';
  if (hungryHours >= CREATURE.ecology.feedThresholdHours) return 'hungry';
  return 'healthy';
}

/** 进化门槛：存活够久 **且** 吃得够多（两个条件都要满足） */
export function canEvolve(creature: Creature): boolean {
  return (
    creature.ageHours >= CREATURE.ecology.evolutionHours &&
    creature.feedCount >= CREATURE.ecology.evolutionFeedCount &&
    creature.sequence > 1
  );
}

/**
 * 初始播种：世界上第一次有生物。
 *
 * 每个物种在它的每个栖息地播 spawnPerLocation 只 —— 个体序列从物种基线开始。
 * 由世界 seed 派生，所以同一个世界 seed 得到同一批生物（M2.7「世界 seed 控制内容分布」的兑现）。
 */
export function spawnInitialCreatures(
  speciesList: readonly CreatureSpecies[],
  rng: Rng,
  now: number,
): Creature[] {
  const out: Creature[] = [];
  let index = 0;
  for (const species of speciesList) {
    // 生态金字塔：序列越低（越弱）播得越多 —— 否则底层会被上层吃光（见 numeric 的说明）
    const bonus = CREATURE.ecology.spawnSequenceBonus[species.baseSequence] ?? 1;
    for (const locationId of species.habitat) {
      for (let i = 0; i < CREATURE.ecology.spawnPerLocation * bonus; i += 1) {
        out.push({
          id: `${species.id}-${index}`,
          speciesId: species.id,
          locationId,
          sequence: species.baseSequence,
          hp: species.baseHp,
          maxHp: species.baseHp,
          status: 'healthy',
          ageHours: 0,
          feedCount: 0,
          lastFedAt: now,
          spawnedAt: now,
          migratedFrom: null,
        });
        index += 1;
        // rng 参与：即使同一天启动两次（不同世界 seed），个体序列也可以有微差
        void rng.next();
      }
    }
  }
  return out;
}

/**
 * 跑一次生态 tick。
 *
 * 逐小时推进（world.hours 格），每格按「迁移 → 捕食 → 进化 → 繁衍 → 衰亡」的顺序结算，
 * 全部通过 rng，所以同一 seed + 同一初态必然得到同一结果。
 */
export function tickCreatures(
  creatures: readonly Creature[],
  world: EcologyWorld,
  rng: Rng,
): CreatureTickResult {
  const migrations: CreatureMigration[] = [];
  const evolutions: CreatureEvolution[] = [];
  const feeds: CreatureFeed[] = [];
  const births: CreatureBirth[] = [];
  const deaths: CreatureDeath[] = [];
  const replenishes: CreatureReplenish[] = [];
  const changed = new Set<string>();

  // 可变工作副本 —— 输入列表不动
  let current: Creature[] = creatures.map((creature) => ({ ...creature }));
  let birthSeq = 0;
  // 与 birthSeq 同一个理由：id 必须跨调用唯一，否则 INSERT OR REPLACE 会把上一小时的那只覆盖掉
  let replenishSeq = 0;

  for (let hour = 0; hour < world.hours; hour += 1) {
    const now = world.now - (world.hours - 1 - hour) * HOUR_MS;

    /* ---------------- 1. 迁移 ---------------- */
    for (const creature of current) {
      const species = world.speciesById.get(creature.speciesId);
      if (!species) continue;
      if (!rollChance(rng, migrateChanceOf(species, ecologyParamsAt(world, creature.locationId)))) {
        continue;
      }

      // 目标池：栖息地内（有多个才换），或以 strayChance 漂到栖息地之外。
      // 漂移就是任务书 §4.3.6 说的「惊喜感」—— 一只本该在南大陆的生物出现在普利兹港。
      const stray = rollChance(rng, strayChanceOf(world)) ? world.locationIds : species.habitat;
      const pool = stray.filter((id) => id !== creature.locationId);
      if (pool.length === 0) continue;
      const target = pool[Math.floor(rng.next() * pool.length)] ?? pool[0]!;
      const from = creature.locationId;
      creature.locationId = target;
      creature.migratedFrom = from;
      migrations.push({ creatureId: creature.id, speciesId: creature.speciesId, from, to: target });
      changed.add(creature.id);
    }

    /* ---------------- 2. 捕食 ---------------- */
    /*
     * 饥饿的生物找猎物：同地点、**序列比它大至少 predatorSeqGap** 的另一只。
     * 差三级以上连看清都做不到（与感知分层的 weak3 同一个量级），更别说捕食。
     */
    for (const predator of current) {
      if (predator.hp <= 0) continue;
      if (hoursSinceFed(predator, now) < CREATURE.ecology.feedThresholdHours) continue;
      /*
       * M2.57：捕食范围从「同一地点」放宽到「同地点或相邻地点」。
       *
       * 为什么必须放宽：实测 73 只生物散在 29 个地点、序列又全挤在 5—9，
       * 在「同地点 + 序列差 ≥ 3」这条口径下**可捕食的配对是 0 对** ——
       * 捕食在数学上不可能发生。于是 feed 恒为 0、feed_count 恒为 0、
       * canEvolve 永不满足、进化也恒为 0：整个生态只剩迁移和补充在动。
       * 放宽到相邻地点后有 8 对（gap 仍是 3），捕食才真的会发生。
       *
       * 语义上也更对：捕食者是循着气味去隔壁找猎物，不是站在原地等它过来。
       */
      const nearby = world.neighborsOf === undefined
        ? null
        : new Set(world.neighborsOf(predator.locationId));
      const preyPool = current.filter(
        (other) =>
          other.id !== predator.id &&
          (other.locationId === predator.locationId ||
            (nearby !== null && nearby.has(other.locationId))) &&
          other.hp > 0 &&
          /*
           * M2.58：能不能吃由**关系网**决定，序列差降级为兜底。
           *
           * 改动前这一行是 other.sequence >= predator.sequence + predatorSeqGap ——
           * 一条与物种无关的通用规则，于是「谁吃谁」在代码里根本不存在。
           * 现在走 canPreyOn 的三条规则（关系命中吃得到 / 声明过但未命中吃不到 /
           * 两边都没声明才回退序列差）。
           *
           * ⚠️ 数值一个没动：predatorSeqGap 仍是 3，且只在规则 3 里被读。
           * test/m2-9.test.ts 那条「不改任何 M2.8 已定的生态数值」仍然守着它。
           */
          canPreyOn(
            world.speciesById.get(predator.speciesId),
            world.speciesById.get(other.speciesId),
            other.sequence,
            predator.sequence,
          ),
      );
      if (preyPool.length === 0) continue;
      const prey = preyPool[Math.floor(rng.next() * preyPool.length)] ?? preyPool[0]!;

      prey.hp -= CREATURE.ecology.preyHpLoss;
      predator.hp = Math.min(predator.maxHp, predator.hp + CREATURE.ecology.feedHpRestore);
      predator.feedCount += 1;
      predator.lastFedAt = now;
      predator.status = 'healthy';
      feeds.push({ predatorId: predator.id, preyId: prey.id, locationId: predator.locationId });
      changed.add(predator.id);
      changed.add(prey.id);
    }

    /* ---------------- 3. 捕食致死的清除 ---------------- */
    for (const creature of current) {
      if (creature.hp > 0) continue;
      deaths.push({
        creatureId: creature.id,
        speciesId: creature.speciesId,
        locationId: creature.locationId,
        cause: 'preyed',
      });
    }
    if (deaths.some((death) => death.cause === 'preyed')) {
      const dead = new Set(deaths.filter((death) => death.cause === 'preyed').map((death) => death.creatureId));
      current = current.filter((creature) => !dead.has(creature.id));
    }

    /* ---------------- 4. 进化 ---------------- */
    for (const creature of current) {
      if (!canEvolve(creature)) continue;
      const species = world.speciesById.get(creature.speciesId);
      if (!species) continue;
      const fromSequence = creature.sequence;
      creature.sequence = Math.max(1, creature.sequence - 1);
      // 进化 = 变强：HP 上限跟着涨一档，且回满（它是"蜕了一层"）
      creature.maxHp = creature.maxHp + CREATURE.ecology.evolutionHpBonus;
      creature.hp = creature.maxHp;
      // 进化后重置计数，否则攒着的捕食次数会连着触发第二次进化
      creature.feedCount = 0;
      creature.ageHours = 0;
      creature.status = 'healthy';
      evolutions.push({
        creatureId: creature.id,
        speciesId: creature.speciesId,
        fromSequence,
        toSequence: creature.sequence,
      });
      changed.add(creature.id);
    }

    /* ---------------- 5. 繁衍 ---------------- */
    /*
     * 群居 + 稳定期（吃饱、没受伤）才繁衍，且同地点同物种不超过 cap。
     * 上限是必须的：少了它，0.02/小时的繁衍在 30 天里会把一个地点刷成怪窝。
     */
    const speciesCount = new Map<string, number>();
    for (const creature of current) {
      const key = `${creature.speciesId}@${creature.locationId}`;
      speciesCount.set(key, (speciesCount.get(key) ?? 0) + 1);
    }
    /*
     * 遍历**快照**，不遍历 current 本身。
     * 理由：循环体会 current.push(child)，而 for...of 会继续遍历新加入的元素 ——
     * 新生儿会在同一个小时里立刻生育（甚至连锁下去），直到撞上地点上限为止。
     * 一次 tick 只该走一代。
     */
    for (const parent of [...current]) {
      const species = world.speciesById.get(parent.speciesId);
      if (!species || !species.habits.includes('social')) continue;
      if (parent.status !== 'healthy') continue;
      if (parent.hp < parent.maxHp) continue;
      const key = `${parent.speciesId}@${parent.locationId}`;
      /*
       * 繁衍读三样域参数：
       *   reproduceMultiplier —— 森林（×1.3）比外神裂隙（×0.6）养得住后代；
       *   spirituality       —— 灵性浓的地方非凡生物繁殖更旺；
       *   carryingCapacity   —— 域自己的地点上限（覆盖全局 capPerLocation）。
       * 不传 zoneOf 时三者都回到基线，逐位等于 M2.8。
       */
      const params = ecologyParamsAt(world, parent.locationId);
      if ((speciesCount.get(key) ?? 0) >= CREATURE.ecology.reproduceCapPerLocation) continue;
      if (current.length >= world.locationIds.length * params.carryingCapacity) continue;
      /*
       * M2.58 阶段三：**恐慌抑制繁衍**。
       *
       * 这是信息生态的闭环那一半 —— 目击让一个地方紧张起来（zone_state.fear），
       * 而人一慌就会来清剿、封锁、净化，于是那个地方的东西生不下去。
       * 没有这一行，阶段三就只是一条单向播报（生态 → 信息），
       * 而不是「信息反过来影响物种生存」这件事。
       *
       * fear 恒为 0 时 factor = 1，逐位等于阶段二。
       */
      const reproduceChance =
        CREATURE.ecology.reproduceChance *
        params.reproduceMultiplier *
        spiritualityActivity(params) *
        fearReproduceFactor(params.fear);
      if (!rollChance(rng, reproduceChance)) continue;

      const child: Creature = {
        /*
         * id 必须**跨调用唯一**：birthSeq 只在本次 tickCreatures 调用内递增，
         * 而调度器是每小时调用一次（world.hours = 1）—— 只用 birthSeq 的话，
         * 同一个物种在不同小时生出来的孩子全都叫 `xxx-b0`，
         * INSERT OR REPLACE 会一次次覆盖，**繁衍等于没发生**。
         *
         * 实测抓到的正是这个：200×14 报告说繁衍 8 次，
         * 而库里只有 1 行 `blood_hound-b0`。
         *
         * now 是这一格的整点时刻（调用方传进来的 cursor），所以它 + birthSeq 天然唯一，
         * 且仍然完全确定（同 seed 同小时 → 同一个 id）。
         */
        id: `${parent.speciesId}-b${now}-${birthSeq}`,
        speciesId: parent.speciesId,
        locationId: parent.locationId,
        sequence: species.baseSequence,
        hp: species.baseHp,
        maxHp: species.baseHp,
        status: 'healthy',
        ageHours: 0,
        feedCount: 0,
        lastFedAt: now,
        spawnedAt: now,
        migratedFrom: null,
      };
      birthSeq += 1;
      current.push(child);
      speciesCount.set(key, (speciesCount.get(key) ?? 0) + 1);
      births.push({
        creatureId: child.id,
        speciesId: child.speciesId,
        locationId: child.locationId,
        sequence: child.sequence,
      });
    }

    /* ---------------- 6. 世界补充（M2.9 前置 1） ---------------- */
    /*
     * 为什么需要这一步：M2.8 的生态是**封闭系统** —— 8 个物种里只有铁血猎犬群居，
     * 其余 7 种只减不增，30 天窗口下 40 只只剩 13 只（见 docs/M2.8-交付说明.md 第七节）。
     * M2.9 的对手就来自 creatures 表，不补就会撞上「没东西可打」。
     *
     * 这是**最小机制**，不是生态学：没有食物链底层、没有初级生产者，
     * 就是一个「地点空下来了，世界往里放一只」的旋钮。它可以被完整的生态设计整体替换。
     *
     * 判定时刻用**绝对小时桶**（now / 3600000 % intervalHours）而不是本次 tick 的循环下标：
     * 调度器是每小时调用一次（hours = 1），而补跑时会一次传好几个小时 ——
     * 用下标的话「逐小时真的跑过」与「重启后一次补 5 格」会得到不同的补充时机。
     * 绝对小时桶让两者逐格一致（与迁移/捕食用 hours 逐格推进是同一个理由）。
     */
    if (Math.floor(now / HOUR_MS) % CREATURE.ecology.replenish.intervalHours === 0) {
      const replenishCfg = CREATURE.ecology.replenish;
      // 每个地点此刻有几只（不分物种）—— 上限是**地点**级的，所以按地点数
      const perLocation = new Map<string, number>();
      for (const creature of current) {
        perLocation.set(creature.locationId, (perLocation.get(creature.locationId) ?? 0) + 1);
      }
      const habitatByLocation = habitatIndex(world.speciesById);
      for (const locationId of world.locationIds) {
        /*
         * 补充也读域参数，两处：
         *   carryingCapacity     —— 阈值按域算（森林 ×8×0.5=4，外神裂隙 ×4×0.5=2）；
         *   replenishMultiplier  —— 污染重的地方「世界往里放东西」更频繁：
         *                           废墟 ×1.5、裂隙 ×1.8，而地下墓穴只有 ×0.7。
         * 与衰亡倍率合起来就是这一层的核心表达：
         * **废墟是一个坏死得快、但也长得出东西的生态。**
         */
        const params = ecologyParamsAt(world, locationId);
        const threshold = params.carryingCapacity * replenishCfg.onlyIfBelow;
        if ((perLocation.get(locationId) ?? 0) >= threshold) continue;
        const pool = habitatByLocation.get(locationId);
        // 这个地点本来就没有栖息物种 —— 跳过（任务书 §4.5 的验收原话）
        if (!pool || pool.length === 0) continue;
        const chance = replenishCfg.chancePerLocation * params.replenishMultiplier;
        if (!rollChance(rng, replenishChanceOf(chance, world))) continue;

        /*
         * 权重与**初始播种**共用一张表（spawnSequenceBonus）：
         * 补充进来的生物必须和初始播种是同一个金字塔形状（弱的多、强的少），
         * 否则跑上几十天之后，世界的物种构成会从金字塔慢慢变成倒金字塔。
         */
        const species = weightedPick(
          pool,
          (entry) => CREATURE.ecology.spawnSequenceBonus[entry.baseSequence] ?? 1,
          rng,
        );
        if (!species) continue;

        const id = `${species.id}-r${now}-${replenishSeq}`;
        replenishSeq += 1;
        const newcomer: Creature = {
          id,
          speciesId: species.id,
          locationId,
          sequence: species.baseSequence,
          // 世界放进来的是**一只新个体**：满血、健康，不是从别处挪过来的伤兵
          hp: species.baseHp,
          maxHp: species.baseHp,
          status: 'healthy',
          ageHours: 0,
          feedCount: 0,
          lastFedAt: now,
          spawnedAt: now,
          migratedFrom: null,
        };
        current.push(newcomer);
        perLocation.set(locationId, (perLocation.get(locationId) ?? 0) + 1);
        replenishes.push({
          creatureId: id,
          speciesId: species.id,
          locationId,
          sequence: species.baseSequence,
        });
      }
    }

    /* ---------------- 7. 衰亡与状态推进 ---------------- */
    for (const creature of current) {
      const next = statusOf(creature, now);
      if (next !== creature.status) {
        creature.status = next;
        changed.add(creature.id);
      }
      if (next !== 'dying') continue;
      /*
       * 20 天没进食：HP 持续下滑，滑到 0 就消失。
       *
       * M2.58：衰亡率乘两个域因子 ——
       *   decayMultiplier  —— 外神裂隙 ×2.0（活不长）、地下墓穴 ×0.5（活得久）；
       *   pollution        —— 污染越重，衰亡越快（pollutionDecay）。
       * 后者是「污染富集的地方东西死得快」这条设定第一次真的进了判定。
       *
       * M2.66：再乘一个 `orderPressure` —— **人间干预**的落点。
       * 秩序高的地方（城市雾区 0.8）有人来清剿，那里的非凡生物活不长；
       * 秩序低的地方（外神裂隙 0.05）没人管，东西能一直待着。
       * 它与恐慌的分工：恐慌是「生不出来」（fearReproduceFactor），秩序是「活不下去」。
       */
      const params = ecologyParamsAt(world, creature.locationId);
      if (!rollChance(rng, decayChanceOf(params))) continue;
      creature.hp -= CREATURE.ecology.decayHpLoss;
      changed.add(creature.id);
    }
    for (const creature of current) {
      if (creature.hp > 0) continue;
      if (deaths.some((death) => death.creatureId === creature.id)) continue;
      deaths.push({
        creatureId: creature.id,
        speciesId: creature.speciesId,
        locationId: creature.locationId,
        cause: 'starved',
      });
    }
    if (deaths.length > 0) {
      const dead = new Set(deaths.map((death) => death.creatureId));
      current = current.filter((creature) => !dead.has(creature.id));
    }

    /* ---------------- 8. 年龄 ---------------- */
    for (const creature of current) {
      creature.ageHours += 1;
    }
  }

  // 被清掉的生物不该再出现在 changed 里（调用方按 id UPDATE，找不到就算了）
  for (const death of deaths) changed.delete(death.creatureId);

  return {
    ticked: creatures.length,
    migrations,
    evolutions,
    feeds,
    births,
    deaths,
    replenishes,
    creatures: current,
    changed: [...changed],
  };
}

/** 报告用：按物种数一遍当前世界里的生物 */
export function countBySpecies(creatures: readonly Creature[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const creature of creatures) {
    out.set(creature.speciesId, (out.get(creature.speciesId) ?? 0) + 1);
  }
  return out;
}

export { HOUR_MS as CREATURE_HOUR_MS };
