/**
 * 生态域（M2.58 阶段二）—— 判定层纯数据 + 纯函数。
 *
 * ## 它解决的那件事实

 * 阶段一给物种之间加了关系（谁吃谁），但生态 tick 的**所有概率仍然读全局常量**
 * CREATURE.ecology.*。于是**普利兹港的老鼠和拜朗的老鼠行为完全一样** ——
 * 迁移率、繁衍率、承载力全部与地点无关。
 *
 * 这一层把地点分组（域），每个域给一组参数覆盖值，没写的键回落到全局基线。
 *
 * ## 兼容性：每个参数都可选，缺省 = 全局基线
 *
 *   - 域不写某个参数 → 该参数用全局基线；
 *   - 地点没登记在任何域里 → 整个域参数为 undefined，生态 tick 走原路径。
 *
 * 所以「不写 zones.yaml」与「写了 zones.yaml 但全不填」在行为上是**同一件事**，
 * 而两者都与加这一层之前逐位相同。内容可以一个域一个域地调，调一半不会让世界半坏。
 */
import { z } from 'zod';
import { CREATURE } from '../../config/numeric.ts';

/**
 * 灵性 → 活跃度的加成上界。
 *
 * ⚠️ 这两个常量**刻意不放进 numeric.ts**。
 *
 * `NUMERIC.creature.ecology` 是 M2.8 定下来的冻结表 ——
 * `test/m2-9.test.ts:202-216` 逐项断言着它的每一个值，
 * 而那条断言的语义是「后一轮不许偷偷改前一轮的生态数值」。
 * 把 M2.58 的键塞进去，会让那张表变成两轮混在一起的账，
 * 而下一次有人要改灵性加成时，他分不清哪个数属于哪一轮、能不能动。
 *
 * 它们住在这里，跟着读它们的函数走。
 */
const SPIRITUALITY_ACTIVITY_BONUS = 0.8;

/** 污染 → 衰亡的加成上界（同上，刻意不进 numeric.ts） */
const POLLUTION_DECAY_BONUS = 1.0;

/** 一个域的生态参数（比率类 0—1，倍数类以 1.0 为中性）。全部可选。 */
export interface ZoneEcologyParams {
  /** 灵性浓度 0—1：越高的地方非凡生物越活跃（迁移与繁衍更容易） */
  spirituality?: number;
  /** 污染度 0—1：越高的地方坏死得越快 */
  pollution?: number;
  /** 疯狂度 0—1：阶段三的失真传播用。**本轮只落数据、不接判定。** */
  madness?: number;
  /** 隐秘度 0—1：阶段三的目击概率用。**本轮只落数据、不接判定。** */
  hidden?: number;
  /** 秩序度 0—1：人间干预（猎杀 / 净化 / 封锁）用。**本轮只落数据、不接判定。** */
  order?: number;
  /** 恐慌度 0—1：阶段三的恐慌累积用。**本轮只落数据、不接判定。** */
  fear?: number;
  /** 这个域里单个地点的生物上限（覆盖 CREATURE.ecology.capPerLocation） */
  carryingCapacity?: number;
  /** 迁移倍率 */
  migrateMultiplier?: number;
  /** 繁衍倍率 */
  reproduceMultiplier?: number;
  /** 世界补充倍率 */
  replenishMultiplier?: number;
  /** 衰亡倍率 */
  decayMultiplier?: number;
}

/** 一个生态域（zones.yaml 的一行）。 */
export interface Zone extends ZoneEcologyParams {
  id: string;
  name: string;
  /** 一句话说明这个域是什么样 —— 给后台与报告用，不参与判定 */
  description: string;
  /** 这个域包含的地点 id（locations.yaml 的 id） */
  locations: readonly string[];
}

/* ---------------- 有效参数：域覆盖 + 全局基线 ---------------- */

/**
 * 生态 tick 真正会读的那几个参数，**已经解析成确定值**（不再有可选）。
 *
 * 为什么要解析成一个扁平对象而不是在判定层到处 zone?.xxx ?? GLOBAL.xxx：
 * 那样每一处读取都是一次「域有没有写」的判断，而这类判断只要漏一处，
 * 症状就是「这个域有的参数生效、有的不生效」—— 一种极难在报告里看出来的不一致。
 */
export interface ResolvedEcologyParams {
  carryingCapacity: number;
  migrateMultiplier: number;
  reproduceMultiplier: number;
  replenishMultiplier: number;
  decayMultiplier: number;
  /** 灵性浓度（0—1）；没给域时是 0，表示「不额外加成」 */
  spirituality: number;
  /**
   * M2.66：**疯狂度**（0—1）—— 传闻在这块地方传出去时会失真。
   *
   * M2.58 阶段二把它写进了 zones.yaml，但 `resolveEcologyParams` 一直没把它带上，
   * 于是「历史在某个地点留下的 madness 伤痕」连读都读不到（只落数据的典型）。
   * 落点见 `distortionChanceOf`。
   */
  madness: number;
  /** 污染度（0—1）；没给域时是 0 */
  pollution: number;
  /**
   * M2.66：**秩序度**（0—1）—— 这块地方有多少「人」在管事。
   *
   * 落点见 `orderPressure`：秩序高的地方，非凡生物活不长（有人来清剿）。
   */
  order: number;
  /**
   * 恐慌度（0—1）：**这个域的基线气质 + 此刻累积**（由调用方算好，见 fearLevelOf）。
   *
   * 为什么它不是从 zone 直接读的：zones.yaml 里的 fear 是**静态气质**，
   * 而真正影响生态的是「最近出了多少事」——那是 zone_state 表里的运行时状态。
   * 两者相加后传给这里，所以这个字段是**合成值**，不是内容表字段。
   *
   * 没给域时是 0 → 不抑制繁衍（与阶段二逐位相同）。
   */
  fear: number;
}

/**
 * 把一个域的参数解析成确定值。
 *
 * `zone` 可以是 undefined（地点没登记在任何域里）—— 那时所有值都取全局基线，
 * 与加这一层之前逐位相同。这是兼容性的落点。
 */
export function resolveEcologyParams(zone?: ZoneEcologyParams): ResolvedEcologyParams {
  const base = CREATURE.ecology;
  return {
    carryingCapacity: zone?.carryingCapacity ?? base.capPerLocation,
    migrateMultiplier: zone?.migrateMultiplier ?? 1,
    reproduceMultiplier: zone?.reproduceMultiplier ?? 1,
    replenishMultiplier: zone?.replenishMultiplier ?? 1,
    decayMultiplier: zone?.decayMultiplier ?? 1,
    spirituality: zone?.spirituality ?? 0,
    pollution: zone?.pollution ?? 0,
    // M2.66：基线 0 = 不改变任何东西（与加这两个参数之前逐位相同）
    madness: zone?.madness ?? 0,
    order: zone?.order ?? 0,
    // 只取基线气质；累积的部分由调用方加上去（见 ZoneIndex.paramsOf 的 fearOf 参数）
    fear: zone?.fear ?? 0,
  };
}

/**
 * 灵性对「活跃度」的加成倍率。
 *
 * 灵性浓度是 0—1 的**比例**，而这里要的是一个**倍率** —— 中间的换算必须有唯一出处，
 * 否则迁移和繁衍会各自发明一套（两个地方都写一遍，改的时候必然漏一个）。
 *
 * 形状：1 + spirituality × spiritualityActivityBonus。
 * 基线 0 → ×1（与加这一层之前相同）；满值 → ×1.8（灵界重叠区的生物明显更活跃）。
 */
export function spiritualityActivity(params: ResolvedEcologyParams): number {
  return 1 + params.spirituality * SPIRITUALITY_ACTIVITY_BONUS;
}

/**
 * 污染对「衰亡」的加成倍率。
 *
 * 与灵性同一个手法：污染是比例，衰亡要的是倍率。
 * 基线 0 → ×1；满值 → ×2（外神裂隙那种地方的东西活不长）。
 */
export function pollutionDecay(params: ResolvedEcologyParams): number {
  return 1 + params.pollution * POLLUTION_DECAY_BONUS;
}

/**
 * M2.66：**秩序对衰亡的加成倍率** —— 「人间干预」在生态层的落点。
 *
 * ## 为什么是乘在衰亡上
 *
 * M2.58 的文件头写着秩序度的用途是「人间干预（猎杀 / 净化 / 封锁）」。
 * 干预的**结果**就是「这块地方的非凡生物活不长」，而衰亡已经是那一层的机制 ——
 * 与恐慌（`fearReproduceFactor`）走「抑制繁衍」是同一种做法：
 * 新增一条并行的通路只会让「谁在影响这地方的生物」变成要看两处才知道。
 *
 * 两条的**分工**也在这里：恐慌是「生不出来」，秩序是「活不下去」。
 *
 * 形状：1 + order × orderCullBonus。
 * 基线 0 → ×1（与加这一层之前逐位相同）；满值 0.8（城市雾区）→ ×1.4。
 *
 * ⚠️ 它只加快「已经半死不活的东西消失」，不改出生 —— 所以不会让高秩序区
 * 变成空城（那会让城市雾区几乎没有遭遇，与 M2.8 的实测分布对不上）。
 */
export function orderPressure(params: ResolvedEcologyParams): number {
  return 1 + params.order * ORDER_CULL_BONUS;
}

/** 秩序满值（1.0）时的衰亡加成 —— 0.5 表示「清剿让衰亡快一半」 */
const ORDER_CULL_BONUS = 0.5;

/**
 * M2.66：**传闻失真的概率** —— 疯狂度在信息生态里的落点。
 *
 * M2.58 阶段三文件头写的「失真传播」就是这一条：一块地方的疯狂度越高，
 * 从这里传出去的传闻越不是原来的样子。
 *
 * 形状：madness × madnessDistortionRate（线性）。
 * 基线 0 → 0（与加这一层之前逐位相同）；满值 → 0.6。
 * 实测的两端：城市雾区 0.2 → 12%，灵界重叠区 0.8 → 48%。
 *
 * ⚠️ 失真**不是**「传不出去」（那是 hidden 的活）：传出去的次数一样多，
 * 只是内容变了 —— 这两件事必须分得开，否则「隐秘的地方传闻离谱」这种组合就表达不出来。
 */
export function distortionChanceOf(madness: number): number {
  const m = Math.min(1, Math.max(0, madness));
  return m * MADNESS_DISTORTION_RATE;
}

/** 疯狂满值（1.0）时的失真概率 */
const MADNESS_DISTORTION_RATE = 0.6;

/* ---------------- 地点 → 域的索引 ---------------- */

/**
 * 地点 → 域的索引。
 *
 * 建一次、查多次：生态 tick 每小时对每只生物都要问「它在哪个域」，
 * 每次线性扫一遍 zones 是 O(域数)，而它在最内层 —— 与阶段一的捕食索引同一个理由。
 */
/**
 * 一组域参数的偏移（M2.61 历史伤痕的输入形状）。
 *
 * 与 Zone 的六个比率字段同名同量纲 —— 因为它的用途就是**叠在它们上面**。
 * 只允许比率类，不给倍数类：一场灾难把某地的迁徒倍率改掉，
 * 会让那个域的生态整体失控，而那不是「伤痕」，是重写。
 */
export interface ZonePatch {
  spirituality?: number;
  pollution?: number;
  madness?: number;
  hidden?: number;
  order?: number;
  fear?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  /*
   * 夹到 0—1 之后**再抹掉浮点尾巴**（0.2 + 0.1 = 0.30000000000000004）。
   *
   * 为什么值得专门做：历史伤痕是**相加**上去的，所以这种尾巴一定会出现，
   * 而它会一路渗进报告、后台界面与快照对比 ——
   * 「这个域的灵性浓度是 0.30000000000000004」正是那种没人报但一眼就看得出的错。
   * 六位小数远高于这个世界需要的精度（参数本身只有一两位）。
   */
  return Math.round(Math.min(1, Math.max(0, value)) * 1e6) / 1e6;
}

export class ZoneIndex {
  readonly #zones: readonly Zone[];
  readonly #byLocation = new Map<string, Zone>();
  /**
   * 地点 → **历史伤痕带来的域参数偏移**（M2.61）。
   *
   * 为什么是一张朴素的 Map 而不是从 history 模块导入：
   * 判定层这一层不该知道「历史」这个概念 —— 它只知道「这个地点的参数要偏移多少」。
   * 由调用方把历史压成偏移喂进来（与 zoneOf / isHomeOf 同一个手法：
   * 调用方负责查，判定层负责算）。
   * 一张空表 = 没有历史，行为与 M2.58 逐位相同。
   */
  readonly #scars: ReadonlyMap<string, ZonePatch>;

  constructor(zones: readonly Zone[], scars: ReadonlyMap<string, ZonePatch> = new Map()) {
    this.#zones = zones;
    this.#scars = scars;
    for (const zone of zones) {
      for (const locationId of zone.locations) {
        // 一个地点只能属于一个域 —— 重复登记由 loader 在启动时报错，
        // 这里取先出现的那个，保证索引本身不会抛（判定层不该因为内容问题崩）
        if (!this.#byLocation.has(locationId)) this.#byLocation.set(locationId, zone);
      }
    }
  }

  /** 这个地点的历史伤痕（没伤过就是 undefined） */
  scarOf(locationId: string): ZonePatch | undefined {
    return this.#scars.get(locationId);
  }

  get zones(): readonly Zone[] {
    return this.#zones;
  }

  /** 这个地点属于哪个域；没登记 = undefined（落回全局基线） */
  of(locationId: string): Zone | undefined {
    return this.#byLocation.get(locationId);
  }

  /**
   * 这个地点的**有效生态参数**（域覆盖 + 全局基线 + 此刻的恐慌）。
   *
   * `fearOf` 用来叠加**运行时**的恐慌累积（zone_state 表里那一份）：
   * 不传 = 只用 zones.yaml 的静态基线（阶段二的行为）。
   *
   * 为什么恐慌走参数而不是单独一个字段：它对生态的作用就是「抑制繁衍」，
   * 而抑制繁衍已经是这一层的事 —— 多一条并行的通路只会让「谁在影响繁衍」
   * 变成要看两个地方才知道。
   */
  paramsOf(locationId: string, fearOf?: (zoneId: string) => number): ResolvedEcologyParams {
    const zone = this.#byLocation.get(locationId);
    /*
     * M2.61：历史伤痕叠在域参数上。
     *
     * 叠加而不是覆盖，而且**夹在 0—1**：一场大雾把某条街的污染推高一点，
     * 但它不该把整条街变成外神裂隙。历史改变世界的脾气，不重写它。
     */
    const patch = this.#scars.get(locationId);
    const params = resolveEcologyParams(
      zone === undefined || patch === undefined
        ? zone
        : {
            ...zone,
            spirituality: clamp01((zone.spirituality ?? 0) + (patch.spirituality ?? 0)),
            pollution: clamp01((zone.pollution ?? 0) + (patch.pollution ?? 0)),
            madness: clamp01((zone.madness ?? 0) + (patch.madness ?? 0)),
            hidden: clamp01((zone.hidden ?? 0) + (patch.hidden ?? 0)),
            order: clamp01((zone.order ?? 0) + (patch.order ?? 0)),
            fear: clamp01((zone.fear ?? 0) + (patch.fear ?? 0)),
          },
    );
    if (zone === undefined || fearOf === undefined) return params;
    return { ...params, fear: fearLevelOf(params.fear, fearOf(zone.id)) };
  }

  get size(): number {
    return this.#byLocation.size;
  }
}


/* ---------------- 信息生态（M2.58 阶段三） ---------------- */

/**
 * 一次目击被「传出去」的概率。
 *
 * 这是**信息生态接口**的第一环：生态层发生的事（你遇到了不该遇到的东西）
 * 只有在被传出去之后才会变成世界事件。而传不传出去由**域的隐秘度**决定 ——
 * 城里人多的、天上灵界重叠的地方，目击很难藏住；地下墓穴里的目击几乎没人知道。
 *
 * 形状：base × (1 − hidden)。隐秘度满值 → 传不出去（×0）。
 * 所以 zones.yaml 里 hidden 确实不写时是 undefined → 0，而 0 意味着**一律传出去**，
 * 那是错的（没配的域反而最吵）。所以这里用 base 做基线，而不是从 0 起步：
 * 未配置的域按「一半多一点」的默认隐秘度处理，见 DEFAULT_HIDDEN。
 */
export function rumorChanceOf(params: ResolvedEcologyParams, hidden?: number): number {
  const h = hidden ?? DEFAULT_HIDDEN;
  return RUMOR_BASE_CHANCE * (1 - Math.min(1, Math.max(0, h)));
}

/**
 * 没配 hidden 的域用的默认隐秘度。
 *
 * 为什么不是 0：0 意味着「目击一律传出去」，于是没配参数的域比配了的域更吵 ——
 * 一个「什么都不写反而最有戏剧性」的默认值是错的。0.5 是中性：一半传得出去。
 */
const DEFAULT_HIDDEN = 0.5;

/** 基础传播概率（隐秘度 0 时的上限） */
const RUMOR_BASE_CHANCE = 0.55;

/**
 * 一次目击让恐慌涨多少。
 *
 * 隐秘度越高，传出去的那一次越吓人（少而重的传闻比天天见的东西更吓人）——
 * 所以这里是 base × (0.5 + hidden)。
 */
export function fearDeltaOf(hidden?: number): number {
  const h = hidden ?? DEFAULT_HIDDEN;
  return FEAR_PER_SIGHTING * (0.5 + Math.min(1, Math.max(0, h)));
}

const FEAR_PER_SIGHTING = 0.08;

/**
 * 恐慌每小时的衰减（记忆会淡，但不是立刻）。
 *
 * 0.05/小时 → 半天掉两成多、两天掉九成。
 * 与「目击累积」一起构成一个有涨有落的量，而不是单调递增的计数器。
 */
export const FEAR_DECAY_PER_HOUR = 0.05;

/** 恐慌怎么衰减（纯函数，落库由仓储负责） */
export function decayFear(fear: number, hours: number): number {
  return fear * Math.pow(1 - FEAR_DECAY_PER_HOUR, Math.max(0, hours));
}

/**
 * 恐慌对繁衍的**抑制**倍率。
 *
 * 这是「信息反过来影响生态」那一环的落点：
 * 人一慌就会来清剿、封锁、净化 —— 于是那个地方的东西生不下去。
 *
 * 与 zones.yaml 的 fear（基线气质）相加后 clamp 到 1：
 * 一个本来就慌的地方，再加一点就满了。
 *
 * 形状：1 − fear × fearReproducePenalty。恐慌满值 → ×0.5（繁衍减半）。
 * 不写这一层时 fear 恒为 0 → ×1，与阶段二逐位相同。
 */
export function fearReproduceFactor(fear: number): number {
  const f = Math.min(1, Math.max(0, fear));
  return 1 - f * FEAR_REPRODUCE_PENALTY;
}

const FEAR_REPRODUCE_PENALTY = 0.5;

/**
 * 一个域的**此刻**恐慌 = 基线气质（zones.yaml 的 fear）+ 累积状态，clamp 到 1。
 *
 * 两者相加而不是取最大：基线气质是「这个地方本来就容易慌」，
 * 累积是「最近真的出了事」—— 两件事都该算数。
 */
export function fearLevelOf(baseline: number | undefined, accumulated: number): number {
  return Math.min(1, Math.max(0, (baseline ?? 0) + accumulated));
}

/* ---------------- 内容表（zones.yaml）的 schema ---------------- */

/**
 * 一个域的 schema。
 *
 * **每个参数都 optional** —— 这是「不排斥现有数据」的落点：
 * 内容同学可以先只写 id / name / locations 把域建起来，
 * 之后再一个参数一个参数地调。不写的键回落全局基线（见 resolveEcologyParams）。
 *
 * 比率类限死 0—1、倍数类限非负：写错量级（例如把 0.2 写成 20）是最常见的
 * 内容错，而它的症状是「那个域的生物行为完全失控」—— 启动时报错远好过跑批时才发现。
 */
export const ZoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  spirituality: z.number().min(0).max(1).optional(),
  pollution: z.number().min(0).max(1).optional(),
  madness: z.number().min(0).max(1).optional(),
  hidden: z.number().min(0).max(1).optional(),
  order: z.number().min(0).max(1).optional(),
  fear: z.number().min(0).max(1).optional(),
  carryingCapacity: z.number().int().positive().optional(),
  migrateMultiplier: z.number().nonnegative().optional(),
  reproduceMultiplier: z.number().nonnegative().optional(),
  replenishMultiplier: z.number().nonnegative().optional(),
  decayMultiplier: z.number().nonnegative().optional(),
  /** 这个域包含的地点 id。**至少一个** —— 空域没有任何意义，还会让人以为它生效了 */
  locations: z.array(z.string().min(1)).min(1),
});



