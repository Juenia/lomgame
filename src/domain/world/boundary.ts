/**
 * 边界输入（M2.62）—— 让世界有外面。
 *
 * ## 为什么需要它
 *
 * 在它之前，这个世界是**封闭**的：
 *
 *   因蒂斯、南大陆、苏尼亚海是区域名，但它们与外界的往来没有任何机制；
 *   「外神」「殖民」「外来物种」只出现在地点描述与生态漂移里；
 *   58 个地点里没有一个知道自己「挨着外面」。
 *
 * 一个完全封闭的世界会僵化 —— 它只能在自己内部循环，玩家的行为之外没有新输入。
 *
 * ## 这一层的三个概念
 *
 *   BOUNDARY      一个边界（港口 / 边境 / 裂隙）：世界从这里与外面接触
 *   FOREIGN_POWER 一个外部势力（因蒂斯 / 南大陆 / 海外教会 / 外神）
 *   BoundaryPressure  边界张力：**累积制，不是概率制**
 *
 * ## 为什么张力是累积的而不是掷骰的
 *
 * 掷骰的问题是「一个高关注的边界可能连续三十天什么都没发生」，
 * 而那让「边界」变成一个没有存在感的概念。
 * 累积制保证**事情一定会发生**，只是早晚 —— 关注度越高，来得越快。
 * 这与 M2.58 的恐慌、M2.59 的警觉是同一个形状（涨落量，不是开关）。
 */
import { z } from 'zod';

export const BoundaryKindSchema = z.enum(['port', 'frontier', 'rift']);
export type BoundaryKind = z.infer<typeof BoundaryKindSchema>;

/** 四种外来输入。**每一种都对应一组真实的后果。** */
export const ForeignInputKindSchema = z.enum(['trade', 'migrant', 'threat', 'contamination']);
export type ForeignInputKind = z.infer<typeof ForeignInputKindSchema>;

export const INPUT_LABELS: Readonly<Record<ForeignInputKind, string>> = {
  trade: '贸易',
  migrant: '移民',
  threat: '军事威胁',
  contamination: '污染渗入',
};

/**
 * 一个外部势力。
 *
 * ⚠️ 它们**不是** powers.yaml 里的本地势力：那些在自己的土地上争地盘，
 * 而这些在世界的**外面**，只能通过边界施加影响。
 * 把它们混进 powers 会让「谁管着这条街」和「谁在海上盯着我们」变成同一张表。
 */
export const ForeignPowerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * 它从哪个方向来（区域 id）；空串 = 不属于任何区域的来路（例如外神）。
   *
   * ⚠️ `.nullish()` 是刻意的：YAML 里写 `from_region:` 后面留空时，
   * 解析器给的是 **null** 而不是空串，而 `.default('')` 只在**字段缺失**时生效 ——
   * 于是那一条势力会因为「expected string, received null」被整条丢掉。
   * 这个坑真实踩到过：`outer_god` 就是这样消失的，
   * 而症状只是「外部势力少了一个、某条边界找不到对面」。
   */
  from_region: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  /** 它对本地世界的关注度 0—1：越高，从它那条边界来的事越频繁 */
  attention: z.number().min(0).max(1).default(0.5),
  /** 它对本地势力的威胁 0—1 */
  threat: z.number().min(0).max(1).default(0.3),
  description: z.string().default(''),
});
export type ForeignPower = z.infer<typeof ForeignPowerSchema>;

/**
 * 一个边界：世界从这里与外面接触。
 *
 * `base_pressure` 是**每小时累积的张力**。累积到 1 就发生一次输入事件，
 * 然后归零重来。所以「多久出一次事」= 1 / base_pressure 小时。
 */
export const BoundarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: BoundaryKindSchema,
  /** 本地这一侧的地点 id */
  location: z.string().min(1),
  /** 对面是谁（外部势力 id） */
  foreign_power: z.string().min(1),
  /** 它主要带来哪几种输入 */
  inputs: z.array(ForeignInputKindSchema).default([]),
  /** 每小时累积的基础张力 0—1（0.02 → 平均 50 小时一次） */
  base_pressure: z.number().min(0).max(1).default(0.02),
  description: z.string().default(''),
});
export type Boundary = z.infer<typeof BoundarySchema>;

/* ---------------- 输入事件的后果 ---------------- */

/**
 * 一次外来输入对本地世界的后果。
 *
 * ⚠️ 这里的字段名与 M2.58 的域参数**同名**，因为它们的用途就是叠上去。
 * 一条贸易航线抬高一个港口的财富，一次污染渗入抬高它的污染度 ——
 * 历史（M2.61）用的是同一套叠加机制，两种输入不该发明两套表示。
 */
export interface ForeignInputEffect {
  /** 地点危险度加成 0—3（会叠到 locations 的 danger 上，上限 5） */
  dangerBonus: number;
  /** 生态参数偏移（与 ZonePatch 同形状） */
  zonePatch: {
    spirituality?: number;
    pollution?: number;
    madness?: number;
    hidden?: number;
    order?: number;
    fear?: number;
  };
  /** 本地势力的警觉该涨多少（0—1 的增量） */
  alertDelta: number;
  /** 这个地点所在域的恐慌该涨多少 */
  fearDelta: number;
}

/**
 * 一次外来输入的定义。
 *
 * 文案与后果写在一起，因为它们是一件事 —— 分开写会让「这句话对应的后果是什么」
 * 变成要看两个地方才知道，而那正是这一层最容易被改坏的地方。
 */
export interface ForeignInputDef {
  kind: ForeignInputKind;
  /** 播报正文（`{power}` 与 `{loc}` 会被替换） */
  text: string;
  effect: ForeignInputEffect;
}

/**
 * 四类输入的后果表。
 *
 * 数值取的是「一次输入该有多大影响」：
 *   trade         —— 让港口更繁荣（秩序涨、隐秘降），但不危险
 *   migrant       —— 人多起来（秩序降、恐慌涨），生态承载压力变大
 *   threat        —— 危险度直接涨，势力警觉大涨（他们要应对）
 *   contamination —— 污染与灵性一起涨，隐秘也涨（没人愿意说）
 *
 * ⚠️ 数值刻意保守：边界是**持续的小输入**，不是一锤定音。
 * 一次贸易不该让一个港口变成另一个城市，但连着来二十次会。
 */
export const FOREIGN_INPUTS: Readonly<Record<ForeignInputKind, ForeignInputDef>> = {
  trade: {
    kind: 'trade',
    text: '{power}的商队到了{loc}。码头忙了起来，价钱也活了起来。',
    effect: {
      dangerBonus: 0,
      zonePatch: { order: 0.03, hidden: -0.02 },
      alertDelta: 0.01,
      fearDelta: 0,
    },
  },
  migrant: {
    kind: 'migrant',
    text: '一批人从{power}那边过来了，落脚在{loc}。他们不太说自己为什么来。',
    effect: {
      dangerBonus: 0,
      zonePatch: { order: -0.03, fear: 0.04, hidden: 0.02 },
      alertDelta: 0.03,
      fearDelta: 0.02,
    },
  },
  threat: {
    kind: 'threat',
    text: '{power}的人又出现在{loc}附近。这次他们没有遮掩。',
    effect: {
      dangerBonus: 1,
      zonePatch: { fear: 0.06, order: -0.02 },
      alertDelta: 0.08,
      fearDelta: 0.05,
    },
  },
  contamination: {
    kind: 'contamination',
    text: '{loc}的水面浮起了一层不该有的东西。{power}那边来的，没人明说。',
    effect: {
      dangerBonus: 1,
      zonePatch: { pollution: 0.05, spirituality: 0.03, hidden: 0.03 },
      alertDelta: 0.05,
      fearDelta: 0.04,
    },
  },
};

/* ---------------- 事件时刻表（纯函数，只由 seed 与小时决定） ---------------- */

/**
 * ⚠️ 这一层**刻意不依赖任何运行时状态**。
 *
 * 第一版实现让边界张力存在 `boundary_state` 表里（「上次事件是什么时候」），
 * 于是张力是累积出来的。它被 `test/m2-4.test.ts` 的分片一致性用例当场拦下：
 *
 * ```text
 * M2.4 分片实测：4 片用不同节奏推进同样的小时 → 世界事件逐条一致
 * ```
 *
 * 那条用例的判据是「世界事件只由 (世界 seed, 小时) 决定」—— 而 4 个分片各有
 * 自己的 SQLite，各自的 `boundary_state` 累积进度不同，于是各自算出不同的边界事件，
 * 世界事件序列就对不上了。**这不是实现瑕疵，是设计错了**：
 * 凡是进 `world_events` 的东西都必须是 (seed, 小时) 的函数，
 * 否则「4 片看到同一个世界」这个项目级保证直接破掉。
 *
 * 所以这一层改成**事件时刻表**：每条边界的事件时刻由 seed 派生的间隔序列决定。
 * 于是：
 *   - 分片一致：同一 (seed, 边界, 小时) 在哪个分片都算出同一个答案；
 *   - 补跑一致：时刻表是可复现的，补 5 格与逐小时跑 5 次结果相同；
 *   - 「累积」的语义保留：间隔由关注度缩放，关注度越高间隔越短。
 *
 * 丢掉的是「整个服务停了一周之后，那些本该发生的事件会补上」——
 * 边界事件与天气同一性质（每小时一格的瞬时状态），不补跑本来就是它的口径。
 */

/** 时刻表的起点（天序号 0 的整点，即 1970-01-01T00:00Z）。固定的，不随进程启动变。 */
const SCHEDULE_EPOCH = 0;

/**
 * 某条边界的第 index 个间隔（毫秒）。
 *
 * 基础间隔 = 1 / base_pressure 小时（base_pressure 0.03 → 约 33 小时一次），
 * 再按关注度缩放：关注度越高间隔越短（0.5 + attention 作除数）。
 * 最后乘一个 0.5—1.5 的抖动，由 (seed, 边界, index) 派生 ——
 * 抖动让事件不至于像钟表一样准点，但它仍然是**确定的**。
 */
export function boundaryGapMs(input: {
  boundaryId: string;
  basePressure: number;
  attention: number;
  index: number;
  seed: string;
  /** 0—1 的抽样值（调用方从 rng 取；不传 = 无抖动，用于测试） */
  roll?: number;
}): number {
  const base = 1 / Math.max(1e-6, input.basePressure); // 小时
  const scaled = base / (0.5 + input.attention);
  const jitter = input.roll === undefined ? 1 : 0.5 + input.roll;
  return Math.max(1, Math.round(scaled * jitter)) * 3_600_000;
}

/** 每条边界的事件时刻表缓存：键 (seed, 边界)，值是从 SCHEDULE_EPOCH 起的时刻数组 */
const scheduleCache = new Map<string, number[]>();

/**
 * 这条边界的事件时刻表（只增不减，按调用方给的 upTo 补齐）。
 *
 * 与 M2.2 的 `fogStartDays` 同一个手法：纯函数 + 进程内缓存、无失效逻辑
 * （世界 seed 在一个进程生命周期里不变）。
 */
export function boundaryEventTimes(input: {
  boundaryId: string;
  basePressure: number;
  attention: number;
  seed: string;
  /** 要覆盖到哪个时刻（毫秒） */
  upTo: number;
  /** 按 (边界, index) 取 0—1 的抽样值 */
  rollFor: (index: number) => number;
}): readonly number[] {
  const key = input.seed + '|' + input.boundaryId;
  let times = scheduleCache.get(key);
  if (times === undefined) {
    times = [SCHEDULE_EPOCH];
    scheduleCache.set(key, times);
  }
  // 上限只是防御性护栏：正常调用下循环次数 ≈ 天数 / 间隔小时数
  while ((times[times.length - 1] ?? 0) <= input.upTo && times.length <= 20_000) {
    const gap = boundaryGapMs({
      boundaryId: input.boundaryId,
      basePressure: input.basePressure,
      attention: input.attention,
      index: times.length - 1,
      seed: input.seed,
      roll: input.rollFor(times.length - 1),
    });
    times.push((times[times.length - 1] ?? 0) + gap);
  }
  return times;
}

/**
 * 这一小时是不是某条边界的事件时刻。
 *
 * 比较的是**整点**（调用方传进来的 `at` 应当已经是小时起点，
 * 与 `generateWorldEvents` 的 `hourStart` 同一个口径）。
 */
export function isBoundaryHour(times: readonly number[], at: number): boolean {
  // 时刻表最多几千项，而这一层每小时只问一次（8 条边界），二分不值得
  for (const time of times) {
    if (time === at) return true;
    if (time > at) return false;
  }
  return false;
}

/**
 * 这一小时该发生哪一种输入（没到时刻就返回 null）。
 *
 * `roll` 由调用方从世界 seed 派生（与其它判定同一个口径）——
 * 同一个 (seed, 边界, 小时) 必然得到同一种输入，分片与补跑都一致。
 */
export function foreignInputAt(input: {
  boundary: Boundary;
  seed: string;
  attention: number;
  at: number;
  /** 按 (边界, index) 取间隔抖动 */
  gapRollFor: (index: number) => number;
  /** 决定发生哪一种输入 */
  kindRoll: number;
}): ForeignInputDef | null {
  const times = boundaryEventTimes({
    boundaryId: input.boundary.id,
    basePressure: input.boundary.base_pressure,
    attention: input.attention,
    seed: input.seed,
    upTo: input.at,
    rollFor: input.gapRollFor,
  });
  if (!isBoundaryHour(times, input.at)) return null;
  const pool = input.boundary.inputs;
  if (pool.length === 0) return null;
  const picked = pool[Math.min(pool.length - 1, Math.floor(input.kindRoll * pool.length))]!;
  return FOREIGN_INPUTS[picked];
}

/**
 * 把外部输入的名字与地点填进文案。
 */
export function foreignInputText(def: ForeignInputDef, powerName: string, locationName: string): string {
  return def.text.replace(/\{power\}/g, powerName).replace(/\{loc\}/g, locationName);
}
/* ---------------- 索引 ---------------- */

/** 边界索引：地点 → 那条边界，以及外部势力查询 */
export class BoundaryIndex {
  readonly #boundaries: readonly Boundary[];
  readonly #powers: ReadonlyMap<string, ForeignPower>;
  readonly #byLocation = new Map<string, Boundary>();

  constructor(boundaries: readonly Boundary[], powers: readonly ForeignPower[]) {
    this.#boundaries = boundaries;
    this.#powers = new Map(powers.map((power) => [power.id, power]));
    for (const boundary of boundaries) {
      // 一个地点只算一条边界 —— 重复登记由 loader 报错，这里取先出现的
      if (!this.#byLocation.has(boundary.location)) this.#byLocation.set(boundary.location, boundary);
    }
  }

  get boundaries(): readonly Boundary[] {
    return this.#boundaries;
  }

  foreignPower(id: string): ForeignPower | undefined {
    return this.#powers.get(id);
  }

  /** 这个地点是不是边界（挨着外面） */
  atLocation(locationId: string): Boundary | undefined {
    return this.#byLocation.get(locationId);
  }

  get size(): number {
    return this.#boundaries.length;
  }
}
