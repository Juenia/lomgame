/**
 * 世界地理类型（M2.7 主任务一）。
 *
 * 四层结构，一层管一层的事：
 *
 *   海域/大陆（Region）—— 鲁恩王国、因蒂斯、南大陆、苏尼亚海
 *     └ 城市（City）—— 廷根市、贝克兰德、普利兹港、特里尔、拜朗、苏尼亚海
 *         └ 地点（Location）—— 已有的 locations.yaml，**不改结构**，只在 City.locations 里被引用
 *             └ 路线（Route）—— 城市之间的有向边
 *
 * 两条硬约束：
 *   1. **途径是地理化的**：City.pathways 是这座城市**传承**的途径。
 *      玩家出生在哪个城市，就只能走那两条 —— 这是任务书 §2.2 的核心，
 *      也是「玩家群天然分成几个圈子」的来源。
 *   2. **地点表不做城市字段**：城市 → 地点是**一对多**的映射，写在 City.locations 里。
 *      为什么不给 locations.yaml 加一列：地点可能被两个城市共享（未来的商路节点），
 *      而且改一张 31 行的内容表比改 11 行 + 一个映射表更容易出错。
 *      代价是「这个地点属于哪个城市」要反查 —— 所以有 GeoIndex.cityOfLocation()。
 */
import { z } from 'zod';
import type { PathwayId } from '../character/types.ts';

/**
 * 本版真正实现了内容的途径。
 *
 * S1 §2.1 的三条（seer / warrior / sleepless）+ **M2.19 落地的 sailor（水手）**。
 * 「实现」的口径是三处齐备：配方（recipes.yaml）+ 途径能力（abilities.yaml 的序列 8/7）
 * + 教会绑定（churches.yaml 里有一家正神教会真的绑它）。
 *
 * ⚠️ 加一条途径**不是**只改这一行：`PathwayId`（character/types.ts）是它的影子，
 * 而 `Record<PathwayId, …>` 的五张表（PATHWAY_LABELS / PATHWAY_TAGS / TAG_PHRASES /
 * CLUE_TEXT / SEQ9_TITLES）会被 tsc 逐个点出来 —— 那是**故意的**，
 * 少一张表就是「新途径的玩家在某条链路上看到 undefined」。
 */
export const PathwayIdSchema = z.enum([
  'seer', 'warrior', 'sleepless', 'sailor', 'perfect', 'reader', 'mother',
  'door', 'sun', 'corpse_collector', 'error', 'mystery_pryer', 'spectator',
  'apothecary', 'arbiter', 'assassin', 'criminal', 'hunter', 'lawyer',
  'monster', 'prisoner', 'secrets_supplicant',
]);

/**
 * 尚未实现、但**已经登记了 id** 的途径（M2.15）。
 *
 * ## 为什么要有一个显式的枚举
 *
 * 这一套 id 在 M2.15 之前**事实上已经存在**，只是没有 schema 兜着：
 *   - `cities.yaml` 的 `planned_pathways`（M2.7：任务书 §3.2 表里本版没实现的途径）；
 *   - `regions.yaml` 的 `pathways`（区域**设计上**传承的途径）；
 *   - `creatures.yaml` 的 `pathwayAffinity`（loader 拿 `planned_pathways` 当白名单校验它）。
 *
 * 「事实上是 id，schema 上是自由字符串」正是**铁律 9** 要挡的那种状态
 * （内容 YAML 里的每一个机制字段必须显式声明在 schema 里，否则会被静默剥掉）：
 * `loadContent` 里那条「物种的途径亲和既不是已实现途径、也不在任何城市的 planned_pathways 里 → warn」
 * 已经在**当 id 空间用**它了，而写错一个字母时，schema 层什么都不说。
 *
 * ## 命名口径
 *
 * **id 标识的是「途径」，不是序列 9 的魔药名** —— 与 `seer`（愚者途径）同一口径：
 * 完美者 / 太阳 / 阅读者 / 母亲 都是途径名，不是「工匠 / 歌唱家 / 学者 / 耕种者」。
 *
 * ⚠️ 曾经的例外 `sailor`（水手）**已经在 M2.19 实现**，所以它搬到了上面的
 * `PathwayIdSchema` 里，不再是这一份的成员。
 *
 * M2.15 当时记的那笔账是「它是 M2.7 登记的第一批 id 之一，命名口径与其它值不一致，
 * 等真正实现这条途径时再统一」。M2.19 拍板的是**保留这个历史 id**（不改成 `storm` 之类）：
 * 它同时出现在 `cities.yaml`（普利兹港的 `pathways`）、`regions.yaml` 的 `pathways`、
 * `creatures.yaml` 的 `pathwayAffinity` 与 `factions.yaml` 的注释里，
 * 改名要动四张内容表而收益只是好看 —— 这条账到此为止，不再挂在这里。
 *
 * ⚠️ 这是**闭集枚举**：这 10 个值就是当前**全部**已登记的未实现途径。
 * 新途径（无论是新实现一条、还是新登记一条）都要**在这里加一行** ——
 * 加进来之后 `cities.yaml` 的 `planned_pathways`、`regions.yaml` 的 `pathways`、
 * `churches.yaml` 的 `plannedPathway` 才写得进去。这是有意的：
 * 宁可启动时报错，也不要一个写错的值被静默剥掉（铁律 9）。
 *
 * `regions.yaml` 的 `pathways` 用的是 `KnownPathwayIdSchema`（已实现 ∪ 计划）——
 * 它与本枚举是两个集合，见下面的注释。
 */
/**
 * 尚未实现、但**已经登记了 id** 的途径。
 *
 * ## M2.76 的大清理
 *
 * 22 条**正途径全部落地**之后，这一份只剩《宿命之环》的 **10 条外神途径**：
 * 它们**没有魔药配方**（数据集 `00-索引/与本项目映射.md` 记着「原页面就没有，不是抓漏了」），
 * 所以本版不做 —— 但 id 先登记，这样 `regions.yaml` 想写它们时写得进去。
 *
 * ### 移出记录（实现一条就挪一条，这是本枚举的设计用法）
 *
 * | 轮次 | 移出的途径 |
 * | --- | --- |
 * | M2.19 | `sailor` |
 * | M2.26 | `perfect` / `reader` / `mother` |
 * | **M2.76** | `door` / `sun` / `corpse_collector` / `error` / `mystery_pryer` / `spectator` |
 *
 * ### ⚠️ `mysticism` 被**删除**，不是移出
 *
 * 它在原著 22 条途径里**没有落点** ——「秘法师」其实是**学徒途径（`door`）的序列 5**。
 * 保留它等于凭空多出一条原著不存在的途径（数据集 `00-索引/与本项目映射.md` 第三节记的正是这笔账）。
 * `cities.yaml` 里引用它的那一行随之清空。
 */
export const PlannedPathwayIdSchema = z.enum([
  // 《宿命之环》10 条外神途径（id = 该途径序列 9 的英文名）
  'astronomer', // 致密者
  'broker', // 混沌迷雾
  'dancer', // 永劫者
  'dreamborn', // 永生律
  'miser', // 主父
  'novice', // 不朽者
  'patient', // 第二定律
  'scoundrel', // 混沌原胎
  'shaman', // 尘世之眼
  'vagrant', // 吞尾者
]);
export type PlannedPathwayId = z.infer<typeof PlannedPathwayIdSchema>;

/**
 * **已登记的全部途径 id** ＝ 已实现的三条 ∪ 尚未实现的十一条。
 *
 * 用途只有一个：`regions.yaml` 的 `pathways`（区域「设计上」传承的途径）——
 * 它同时写着已实现与未实现的途径，所以既不能只用 `PathwayIdSchema`，
 * 也不能只用 `PlannedPathwayIdSchema`。
 *
 * ⚠️ 这个集合**不适用于 `churches.yaml` 的 `pathway`**：那里必须是**已实现**的途径
 * （教会与途径强绑定，绑一条还没实现的途径，只会让 M2.16 的入教判定去读一条不存在的路）。
 */
export const KnownPathwayIdSchema = z.union([PathwayIdSchema, PlannedPathwayIdSchema]);
export type KnownPathwayId = z.infer<typeof KnownPathwayIdSchema>;

export const RegionTypeSchema = z.enum(['continent', 'island', 'sea']);

export const RegionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: RegionTypeSchema,
  /**
   * 该区域**设计上**传承的途径（`KnownPathwayIdSchema`：已实现的三条 + 已登记的未实现途径）。
   *
   * **M2.15 收敛了这一处**，理由要写清楚，因为原来的代码注释给过一个相反的说法
   * （「允许字符串而不是 PathwayId 枚举，因为那七条尚未实现的途径是世界观的一部分」）——
   * 那是**用途**的说明，不是**类型**的决定。查证结果：
   *
   *   - `docs/M2.7-交付说明.md:165-166`：「它们记在 cities.yaml 的 planned_pathways 与
   *     regions.yaml 的 pathways 里，与 promotion.sequenceGating.planned 同一手法：
   *     **设计意图有落点，但没有代码读它**」；
   *   - `src/data/regions.yaml:4-7`：「**出生校验只读 cities.yaml 的 pathways**，
   *     这个字段没有任何代码读它」。
   *
   * 两处书面表述都在说它**没人读**，**没有任何一处**写过「区域途径必须是自由字符串」。
   * 所以它与 `City.planned_pathways` 是**同一个欠账的两处**（铁律 9：
   * 内容 YAML 里的每一个机制字段必须显式声明在 schema 里），M2.15 一起收。
   * **现有内容一个值都没改** —— regions.yaml 的 6 行本来就全在枚举里。
   *
   * **没有任何判定读它**；出生校验只读 City.pathways。
   */
  pathways: z.array(KnownPathwayIdSchema).default([]),
  /** 区域内的城市 id（冗余但便于一屏展示；真相在 City.region_id） */
  cities: z.array(z.string()).default([]),
  /** 0—1，区域危险度：影响该区域内的路线危险与陌生感文案 */
  danger: z.number().min(0).max(1).default(0.5),
  /**
   * M2.167：**这片地方本身就是堕落源**（东大陆——神弃之地）。
   *
   * 【原作】「整片大陆被黑暗笼罩……神弃之地的黑暗本身就存在危险，会让生物堕落为怪物」。
   * 与地点的 `corruption_source` 是两层：区域标记影响**整片地方**，地点标记只管那一处。
   */
  corruption_source: z.boolean().default(false),
  /*
   * ===== M2.85 内容填充 P2：区域的原作设定字段（全部可选，缺省为空）=====
   * 执行点：`.世界 区域 <名>`（区域档案）。
   * ⚠️ `pathways` 是**设计意图**（没有判定读它），但它是 link-check 的输入：
   *    `city.pathways ⊆ region.pathways` —— 所以城市开放的途径必须在区域里先有。
   */
  country_name: z.string().default(''),
  name_en: z.string().default(''),
  government: z.string().default(''),
  capital: z.string().default(''),
  language: z.string().default(''),
  currency: z.string().default(''),
  state_religion: z.array(z.string()).default([]),
  royal_pathway: z.string().default(''),
  status: z.string().default(''),
  continent: z.string().default(''),
  origin: z.string().default(''),
  sources: z.array(z.string()).default([]),
  confidence: z.string().default(''),
});

export const CitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region_id: z.string().min(1),
  /** 城市内的地点 id（引用 src/data/locations.yaml） */
  locations: z.array(z.string()).default([]),
  /** 势力 id（对应 numeric.factionTerritory 的四家） */
  factions: z.array(z.string()).default([]),
  /** 是否港口：只有港口才能走海路（.移动 的路线校验要用） */
  is_port: z.boolean().default(false),
  /** 进入门槛（序列号越小越高；9 = 新号即可抵达） */
  min_seq: z.number().int().min(0).max(9).default(9),
  /**
   * M2.85：**地理坐标**（用户：「地球是圆的，而诡秘之主的世界其实也就是地球」）。
   *
   * 按原作《世界地理总览》§1.4 的地球对照给：北大陆 = 北美洲、南大陆 = 南美洲、
   * 东大陆 = 欧洲、西大陆 = 亚洲、苏尼亚岛 = 格陵兰、迷雾海 = 太平洋……
   * 可选：没写的地点退到所属区域中心（见 domain/geo/coordinates.ts），距离一律按球面算。
   */
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  /**
   * **本版实际开放**的途径（出生校验的唯一依据）。
   * 每城 2 条 —— 任务书 §2.2「每个区域只开 2—3 条途径」。
   */
  pathways: z.array(PathwayIdSchema).default([]),
  /**
   * 任务书 §3.2 表里、本版尚未实现的途径（设计意图）。
   *
   * M2.15 起收敛到 `PlannedPathwayIdSchema`（原先是一串自由字符串）。
   * 「无代码读取」这句**已经过时**：M2.8 起 loader 拿它当
   * `creatures.yaml` 的 `pathwayAffinity` 的白名单用（写错一个字母只会 warn）。
   */
  planned_pathways: z.array(PlannedPathwayIdSchema).default([]),
  /** 出生权重；0 = 不作为出生城市（苏尼亚海就是 0，它只能被「到达」） */
  birth_weight: z.number().min(0).default(0),
  /**
   * 城区地点 id：玩家抵达这座城市时落脚的地方。
   * 为什么需要它：到达必须有一个具体的地点（flags.loc 是按地点存的，
   * 通缉系统的「你此刻在谁的势力范围内」全靠它），否则玩家会带着上一个城市的地点下车。
   */
  center: z.string().min(1),
  /**
   * M2.7.6：这座城市给人的第一印象，用在 .创建 的回执里。
   *
   * 为什么是内容而不是代码里的常量：出生回执是玩家见到这个世界的**第一句话**，
   * 它属于世界观写作，改它不该改代码。空串是允许的（回执会退化成一句通用文案）。
   */
  flavor: z.string().default(''),
  /*
   * ================= M2.85 内容填充 P2：原作设定字段 =================
   *
   * ⚠️ 这一段**全部可选、缺省为空** —— 所以「只填玩法字段」的既有 6 城一个字都不用改
   * （格式向后兼容：没声明的字段会被 zod 静默剥掉，声明成可选则旧内容照常通过）。
   *
   * ⚠️ 每一项都有**真实执行点**（AGENTS 禁止「只写着没人读」的字段）：
   *   aliases / features / districts / notable_places / population / country / city_type
   *     → `.世界 城市 <名>` 的城市档案（含 **别名匹配**：`.世界 城市 尘埃之都` 也能查到贝克兰德）
   *   sources / confidence
   *     → 后台与图鉴溯源用（不面向玩家）
   */
  /** 原作口径的国家（「鲁恩王国」）—— 与 region_id（项目区域）并存，不改任何判定 */
  country: z.string().default(''),
  /** 原作的城市类型：capital / city / port / town / village / historic / otherworld */
  city_type: z.string().default(''),
  /** 原作口径的存续状态（现存 / 历史城市） */
  status: z.string().default(''),
  /** 人口描述（原作口径，如「超过五百万」） */
  population: z.string().default(''),
  /** 别名与旧称 —— 执行点：`.世界 城市 <别名>` */
  aliases: z.array(z.string()).default([]),
  /** 城市特征（工业 / 天气 / 历史…）—— 执行点：城市档案里列前几条 */
  features: z.array(z.string()).default([]),
  /** 城区（原作 districts：名字 + 一句注记）—— 执行点：城市档案 */
  districts: z.array(z.object({ name: z.string().min(1), note: z.string().default('') })).default([]),
  /** 地标（原作 notable_places）—— 执行点：城市档案 */
  notable_places: z.array(z.string()).default([]),
  /** 来源 URL（原作 source）—— 运营可追溯 */
  sources: z.array(z.string()).default([]),
  confidence: z.string().default(''),
});

export const RouteTypeSchema = z.enum(['land', 'sea']);

export const RouteSchema = z.object({
  id: z.string().min(1),
  /** 起点城市 id */
  from: z.string().min(1),
  /** 终点城市 id */
  to: z.string().min(1),
  type: RouteTypeSchema,
  /** 游戏内小时（与世界时钟同一口径：1 游戏小时 = 1 现实小时） */
  duration_hours: z.number().positive(),
  /** 花费（便士，最小货币单位） */
  cost_penny: z.number().int().min(0),
  /** 0—1，路线危险度：与区域危险度一起决定路途事件的严重度 */
  danger: z.number().min(0).max(1),
  /** 路途事件池（事件 id，见 src/domain/geo/events.ts） */
  events: z.array(z.string()).default([]),
});

export type Region = z.infer<typeof RegionSchema>;
export type City = z.infer<typeof CitySchema>;
export type Route = z.infer<typeof RouteSchema>;
export type RegionType = z.infer<typeof RegionTypeSchema>;
export type RouteType = z.infer<typeof RouteTypeSchema>;

export function parseRegion(raw: unknown): { ok: true; region: Region } | { ok: false; issues: string[] } {
  const result = RegionSchema.safeParse(raw);
  if (result.success) return { ok: true, region: result.data };
  return { ok: false, issues: result.error.issues.map((i) => i.path.join('.') + ': ' + i.message) };
}

export function parseCity(raw: unknown): { ok: true; city: City } | { ok: false; issues: string[] } {
  const result = CitySchema.safeParse(raw);
  if (result.success) return { ok: true, city: result.data };
  return { ok: false, issues: result.error.issues.map((i) => i.path.join('.') + ': ' + i.message) };
}

export function parseRoute(raw: unknown): { ok: true; route: Route } | { ok: false; issues: string[] } {
  const result = RouteSchema.safeParse(raw);
  if (result.success) return { ok: true, route: result.data };
  return { ok: false, issues: result.error.issues.map((i) => i.path.join('.') + ': ' + i.message) };
}

/** 地理层用到的途径 id（与 domain/character/types.ts 同一个联合类型） */
export type GeoPathwayId = PathwayId;
