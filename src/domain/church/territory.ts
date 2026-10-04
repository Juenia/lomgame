/**
 * 正神教会的动态据点（M2.15 任务 B）—— 判定层纯函数，**没有任何 IO**。
 *
 * ## 它是什么
 *
 * 教会不是钉在地图上的：`seats`（churches.yaml）说「这家教会在这几座城市有堂口」，
 * 而**本窗口它扩张到了哪个地点**是算出来的。两句话合起来才是「它现在占着哪儿」。
 *
 * 为什么这半是**动态**的：M2.16 的入教发生在堂口、M2.17 的势力层争夺争的是地点 ——
 * 一个永远不动的据点图会让「势力争夺」变成一张静态表，玩家第二次登录就背下来了。
 *
 * ## 为什么是纯 seed 派生（与灾厄同一路线）
 *
 *   - 它**不进任何 seedFrom 的参数表** —— 判定 seed 的组成一个字段不改；
 *   - 它**不落库、不落 world_state 新列** —— 据点属于「seed 决定」类，不是「事件改写」类；
 *   - 这一层的全部契约就是一句：**同 seed 同 t 同教会 → 同据点**。没有任何状态。
 *
 * ## 时间结构：绝对时间桶（铁律 5）
 *
 * 每 `territoryIntervalDays` 天一个**窗口**（bucket），窗口内至多一次**扩张**，
 * 且**不跨窗口** —— 于是「这一刻它占着哪儿」只看当前窗口就够：
 * 补跑（一次跑 5 格）与逐小时跑必然算出同一串结果（与 calamityAt 同一个理由）。
 *
 * ## ⚠️ 本轮**没有收缩**（M2.16 前置的降级）
 *
 * 第一版做的是三区间（扩张 / 收缩 / 不动），M2.16 前置降为两区间（扩张 / 不动）。
 * 三条理由（完整版见 docs/M2.15-交付说明.md §3.2 与偏差登记第 3 条）：
 *
 *   1. **M2.16 的入教是城市级**（读 `seats`）—— 收缩若影响 `seats`，
 *      就是「这座城能不能入教」随窗口变，那是 M2.16 无法解释的变量；
 *      而若收缩只影响 `territoryAt`，它就只是扩张的另一个符号，没有独立意义。
 *   2. 本轮据点**没有消费方**（入教在 M2.16、势力争夺在 M2.17）：收缩既测不到，到 M2.16 还会碍事。
 *   3. 真正的收缩是 **M2.17**「势力争夺输了丢一块地」的语义 ——
 *      与「教会自己临时撤一个点」不是一回事，现在做是错位的。
 *
 * ## ⚠️ 这里最容易做错的地方：把它写成累积式
 *
 * 「地盘随窗口累积扩张」听起来更像经营，但它需要**记住上一个窗口** ——
 * 而这一层一旦有状态，就同时失去「补跑一致」与「不落库」两条性质
 * （重启后据点会变，而玩家看不出为什么）。
 * 所以 `assertSingleWindowStep` 有一条形状断言守着：本窗口相对静态据点**至多 +1**。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { createSeededRng, seedFrom } from '../rng.ts';
import { dayIndexOf } from '../world/clock.ts';

/** 没有任何邻接信息时的兜底：扩张池恒为空 → 结果就是静态据点那一条 */
const NO_ADJACENCY: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * 这一刻落在第几个据点窗口（绝对时间桶，纯 t 的函数）。
 *
 * 与 `calamityBucketOf` 同一手法：窗口号只由 t 决定，与调用次数、与是补跑还是逐格跑无关。
 */
export function churchTerritoryBucketOf(t: number): number {
  return Math.floor(dayIndexOf(t) / NUMERIC.church.territoryIntervalDays);
}

/** 静态据点的全部邻居（**含**已经在据点里的那些）：扩张池与断言都从它算 */
function neighborsOf(
  seats: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const found = new Set<string>();
  for (const id of seats) for (const next of adjacency.get(id) ?? []) found.add(next);
  return found;
}

/** 可扩张的地点：邻居里**还没有**被占的那些，排序 —— 结果与输入顺序无关 */
function expansionPoolOf(
  seats: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[] {
  const pool = neighborsOf(seats, adjacency);
  for (const id of seats) pool.delete(id);
  return [...pool].sort();
}

/**
 * 「不跨窗口」的运行时断言。
 *
 * 与 calamityAt 里那条 `Math.floor(lastDay / intervalDays) !== bucket` 同一手法：
 * **断言失败就退回一个安全值**（这里是静态据点），而不是让错的东西流出去。
 *
 * 判据是**形状**而不是时间：本窗口的结果相对静态据点**至多 +1**，
 * 绝不可能是「上几个窗口累积下来的地盘」。将来有人把这一层改成累积式，
 * 这里会先兜住 —— 症状从「据点悄悄长满了整张地图」变成「据点一直是静态的那一份」，
 * 后者一跑报告就看得出来。
 *
 * `removed` 那一半本轮**恒为空**（据点只做加法）。留着它不是为了当前逻辑，
 * 而是为了让「把累积式改进来」或「把收缩加回来」的人**先撞上这条断言** ——
 * 加收缩那次必须先回答 M2.16 的入教怎么办（见文件头第 1 条理由）。
 */
function assertSingleWindowStep(
  seats: readonly string[],
  result: readonly string[],
): readonly string[] {
  const added = result.filter((id) => !seats.includes(id));
  const removed = seats.filter((id) => !result.includes(id));
  const wellFormed = added.length <= 1 && removed.length === 0;
  return wellFormed ? result : seats;
}

/**
 * 某教会在时刻 t 占据的地点 id 列表（**静态据点 + 本窗口的动态扩张**）。
 *
 * **纯函数**：只读 seed / t / churchId / 入参，不读库、不读玩家、不看调用次数。
 *
 * @param base      静态据点（地点 id）。由调用方从 `seats`（城市 id）× `cities.center` 映射而来，
 *                  函数内部会去重排序 —— 结果必须与调用方传进来的顺序无关。
 * @param adjacency 地点邻接图（`locations.yaml` 的 `adjacent`，无向）。
 *                  扩张只落在**邻居**上：这就是任务书 B2「只在同城或邻近城市扩张」的落地 ——
 *                  邻接图本身就跨越城市（老码头 ↔ 贝克兰德），所以它表达的正是「邻近」。
 *
 * 规则（每窗口最多掷两次，顺序固定）：
 *   1. 一次掷骰判本窗口扩不扩张；
 *   2. **扩张了才**掷第二次（选哪个地点）——
 *      「没扩张」与「没有邻居可扩」两条路径**只掷一次**（铁律 6：不该掷骰时不掷）。
 */
export function churchTerritoryAt(
  seed: string,
  t: number,
  churchId: string,
  base: readonly string[] = [],
  adjacency: ReadonlyMap<string, readonly string[]> = NO_ADJACENCY,
): readonly string[] {
  const cfg = NUMERIC.church;
  const seats = [...new Set(base)].sort();
  const bucket = churchTerritoryBucketOf(t);
  const rng = createSeededRng(seedFrom(['church-territory', seed, churchId, bucket]));

  if (rng.next() >= cfg.expansionChance) return seats;

  const pool = expansionPoolOf(seats, adjacency);
  if (pool.length === 0) return seats;
  const picked = pool[Math.floor(rng.next() * pool.length)]!;
  /*
   * 断言：扩张只能落在**相邻**地点上（任务书 B2 的硬要求）。
   * 这里用邻接图**独立再算一遍**，而不是信任 pool —— 将来有人把 pool 换成
   * 「全地图随机」时，这一条会在运行期把不该出现的地点挡掉，
   * 而不是让教会的据点悄悄长到海的另一边（那种错在报告里完全看不出来）。
   */
  if (!neighborsOf(seats, adjacency).has(picked)) return seats;
  return assertSingleWindowStep(seats, [...seats, picked].sort());
}
