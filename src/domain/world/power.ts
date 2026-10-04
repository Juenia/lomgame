/**
 * 文明势力（M2.59）—— 判定层纯数据 + 纯函数，零 IO。
 *
 * ## 这一层回答的问题
 *
 * 「世界出了这件事，**哪个势力会反应、反应多大、做什么**。」
 *
 * 在这之前项目里没有这个问题：`factions` 表只有 4 行地点归属（谁管哪块地），
 * 势力自己没有任何状态、目标和反应。于是 `world/events.ts` 里那类 `faction` 事件
 * 从 M2.4 起就是一个空壳 —— `factionEvents()` 恒返回空数组。
 *
 * ## 三个概念
 *
 *   Power        势力实体：目标、资源、态度、与其他势力的关系（powers.yaml，内容）
 *   PowerState   势力的此刻状态：警觉度、影响力（power_state 表，世界状态）
 *   PowerAction  势力做出来的事（由反应引擎算出，落进 world_events 播报）
 *
 * 「内容 vs 状态」的分法与生态域完全一致（zones.yaml vs zone_state），
 * 不是新发明的规矩。
 */
import { z } from 'zod';

export const PowerTypeSchema = z.enum(['police', 'church', 'gang', 'royal', 'order']);
export type PowerType = z.infer<typeof PowerTypeSchema>;

export const PowerStanceSchema = z.enum(['hostile', 'watchful', 'neutral', 'friendly']);
export type PowerStance = z.infer<typeof PowerStanceSchema>;

export const PowerRelationKindSchema = z.enum(['ally', 'hostile', 'debt']);
export type PowerRelationKind = z.infer<typeof PowerRelationKindSchema>;

/** 一家势力的资源（0—1）。影响它**能投入多少**，不决定它想不想动。 */
export const PowerResourcesSchema = z.object({
  /** 人力：能同时压住多少地方 */
  manpower: z.number().min(0).max(1).default(0.5),
  /** 财力：能烧多久 */
  wealth: z.number().min(0).max(1).default(0.5),
  /** 神秘侧力量：对付非凡事件的本钱 */
  mystic: z.number().min(0).max(1).default(0.3),
});
export type PowerResources = z.infer<typeof PowerResourcesSchema>;

export const PowerRelationSchema = z.object({
  to: z.string().min(1),
  kind: PowerRelationKindSchema,
});

export const PowerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: PowerTypeSchema,
  description: z.string().default(''),
  /** 主场区域（regions.yaml 的 id）；空串 = 无处不在 */
  home_region: z.string().default(''),
  /** 对玩家的默认态度 */
  stance: PowerStanceSchema.default('neutral'),
  /** 长期目标。反应引擎按它算「这件事与它有多相关」 */
  goals: z.array(z.string().min(1)).default([]),
  resources: PowerResourcesSchema.default({ manpower: 0.5, wealth: 0.5, mystic: 0.3 }),
  relations: z.array(PowerRelationSchema).default([]),
});
export type Power = z.infer<typeof PowerSchema>;


/* ---------------- 势力索引（属地判定） ---------------- */

/**
 * 「这个地点是不是它的主场」—— 两级判定，**领地优先于主场区域**。
 *
 *   1. **领地**：M2.6 的 `factionTerritory`（那 4 家的具体地点名单）。
 *      它是最精确的一级 —— 警察厅管廷根市，黑帮管老码头，都是逐个地点定下来的。
 *   2. **主场区域**：powers.yaml 的 `home_region`。教会与王室没有那种逐点名单，
 *      它们的势力按区域算（黑夜女神在鲁恩、风暴之主在海上）。
 *
 * 两级都用不上的势力（`home_region` 为空）**无处不在** —— 那不是「没有主场」，
 * 而是「哪里都算它的主场」。这个区分很重要：一个无处不在的势力
 * 在任何地方都会有属地加成，而那正是「王室哪里都插得上手」的形状。
 *
 * 为什么放在判定层而不是 infra：这是一条**规则**（谁算主场），不是一次查询。
 * 领地表与区域表由调用方喂进来（`factions` 与 `locationRegion` 两个映射），
 * 判定层不查库。
 */
export class PowerIndex {
  readonly #powers: readonly Power[];
  readonly #byId = new Map<string, Power>();
  /** 势力 id → 它逐个地点声明的领地（M2.6 那 4 家里有 3 家） */
  readonly #territoryOf: (powerId: string) => readonly string[];
  /** 地点 id → 它属于哪个区域 */
  readonly #regionOfLocation: (locationId: string) => string | null;

  constructor(
    powers: readonly Power[],
    territoryOf: (powerId: string) => readonly string[] = () => [],
    regionOfLocation: (locationId: string) => string | null = () => null,
  ) {
    this.#powers = powers;
    for (const power of powers) this.#byId.set(power.id, power);
    this.#territoryOf = territoryOf;
    this.#regionOfLocation = regionOfLocation;
  }

  get powers(): readonly Power[] {
    return this.#powers;
  }

  byId(id: string): Power | undefined {
    return this.#byId.get(id);
  }

  /**
   * 这个地点是不是它的主场。
   *
   * `locationId` 为 null（全境事件，例如灾厄）时：只有**无处不在**的势力算主场 ——
   * 一场全境灾厄对「哪里都插得上手」的势力是主场，
   * 对一个只管着老码头的黑帮不是。
   */
  isHomeOf(powerId: string, locationId: string | null): boolean {
    const power = this.#byId.get(powerId);
    if (power === undefined) return false;
    if (locationId === null) return power.home_region === '';
    if (this.#territoryOf(powerId).includes(locationId)) return true;
    if (power.home_region === '') return true;
    return this.#regionOfLocation(locationId) === power.home_region;
  }

  /** 此刻控制这个地点的势力（领地声明优先；没人的地方返回空数组） */
  atLocation(locationId: string): Power[] {
    return this.#powers.filter((power) => this.isHomeOf(power.id, locationId));
  }

  get size(): number {
    return this.#powers.length;
  }
}

/* ---------------- 运行时状态（power_state 表） ---------------- */

export interface PowerState {
  powerId: string;
  /** 警觉度 0—1：出了事就涨，没事就落。**它是「这次会不会反应」的主输入** */
  alert: number;
  /** 影响力 0—1：它能压住多少地方。随反应成功与否涨落 */
  influence: number;
  /** 累计反应次数（只增不减，报告读它） */
  reactionCount: number;
  lastReactionAt: number | null;
}

/* ---------------- 事件与反应 ---------------- */

/**
 * 势力会为之动的事件类型。
 *
 * 与 world_events 的 type 不是一回事：那是**播报口径**（给玩家看的分类），
 * 这是**势力口径**（它在意什么）。两者刻意不合并 ——
 * 播报要的是「这条消息长什么样」，势力要的是「这件事值不值得动」。
 */
export type PowerEventKind =
  /** 有人撞见了不该撞见的东西 */
  | 'sighting'
  /** 灾厄（世界进入的一段状态） */
  | 'calamity'
  /** 环境异象（血月 / 灵界渗透 / 灰雾潮） */
  | 'environment'
  /** 传闻（真假难辨） */
  | 'rumor';

/** 势力能做出来的事。**每一条都对应一句玩家看得见的话。** */
export type PowerActionKind =
  /** 巡逻：加派人手 */
  | 'patrol'
  /** 净化：处理污染与非凡残留 */
  | 'purify'
  /** 封锁：不让进也不让出 */
  | 'lockdown'
  /** 调查：派人去看看到底怎么回事 */
  | 'investigate'
  /** 撤离：把自己人撤走（保命优先） */
  | 'withdraw'
  /** 趁火打劫：捞一笔 */
  | 'exploit';

export interface PowerEvent {
  kind: PowerEventKind;
  /** 发生的地点；null = 全境（灾厄这类） */
  locationId: string | null;
  /** 事件强度 0—1（灾厄等级 / 目击的感知层次换算而来） */
  severity: number;
  at: number;
  /** 幂等键的来源（同一次事件重放得到同一个 id） */
  sourceId: string;
}

/** 一次反应 */
export interface PowerReaction {
  powerId: string;
  powerName: string;
  action: PowerActionKind;
  locationId: string | null;
  /** 反应强度 0—1（决定播报的措辞与对世界的影响） */
  strength: number;
  /** 为什么动 —— 报告与审计读它，玩家看不见 */
  reason: string;
  /** 幂等 id：同一次事件 + 同一家力量 → 同一个 id */
  id: string;
}
/* ---------------- 反应引擎（纯函数） ---------------- */

/**
 * 反应引擎的参数。
 *
 * ⚠️ 这些数刻意**不放进 numeric.ts** —— 与 M2.58 的 SPIRITUALITY_ACTIVITY_BONUS 同一个理由：
 * `NUMERIC.*` 里那些段各有各的轮次与冻结契约，把 M2.59 的键塞进去会让账混在一起，
 * 而下一次有人要调「反应门槛」时，他分不清哪个数属于哪一轮、能不能动。
 * 它们住在这里，跟着读它们的函数走。
 */
const REACTION = {
  /** 反应强度低于这个值 = 这次不动（不是所有势力都会对每件事有反应） */
  minStrength: 0.25,
  /** 相关性低于这个值 = 这件事与它无关 */
  minRelevance: 0.1,
  /** 同一次事件最多几家力量反应（防刷屏：一次灾厄不该让 11 家全动） */
  maxPowersPerEvent: 3,
  /** 事件发生地的属地势力加成（它在自己地盘上反应更快） */
  homeBonus: 0.25,
  /** 警觉度对反应强度的权重 */
  alertWeight: 0.4,
  /*
   * ---- M2.68：**关系**对反应的影响（三方：盟友 / 敌对 / 人情） ----
   *
   * 三个数都作用在**第二轮**（见 relationAdjustmentOf 的注释）：
   * 第一轮先按 M2.59 的老口径各自独立算，第二轮再看「旁边站着谁」。
   * 盟友的加成比人情的略大 —— 盟约是**互相的**，人情只是**该还了**。
   */
  /** 盟友也在场：互相壮胆 */
  allyBonus: 0.12,
  /** 敌对也在场：互相牵制 */
  hostilePenalty: 0.12,
  /** 欠人情的一方会跟着债主动（比盟友轻） */
  debtBonus: 0.06,
  /**
   * M2.67：**影响力低于这个数就不在属地之外动手**
   *（在 `reachFactorOf` 的连续倍率之上再设一道门槛）。
   *
   * 为什么连续倍率之外还要一道硬门槛：只乘倍率的话，一家影响力 0.05 的势力
   * 在区外仍然会冒出来 —— 只是「弱一点」。而「它根本管不到那里」是一个**定性**的事实，
   * 用倍率表达不出来（0.5 + 0.5×0.05 = 0.53，看起来还挺能打）。
   */
  minInfluenceAbroad: 0.3,
} as const;

/**
 * 一家势力有多在意这类事件 —— 基础分（按势力类型 × 事件类型）。
 *
 * 这张表是这一层的**核心内容**：它说的是「什么样的组织会为什么样的事动」。
 * 写成一张显式的表而不是一串 if：这是可以被读、被讨论、被改的东西，
 * 而规则一旦埋在 if 里，改它就要先读懂代码。
 */
const BASE_RELEVANCE: Readonly<Record<PowerType, Partial<Record<PowerEventKind, number>>>> = {
  // 秩序机器：街上出事它管，世界出事它装作没看见
  police:  { sighting: 0.55, rumor: 0.30, calamity: 0.25, environment: 0.10 },
  // 教会：专门管「不该存在的东西」
  church:  { sighting: 0.50, environment: 0.50, calamity: 0.45, rumor: 0.25 },
  // 黑帮：对世界大事唯一的兴趣是能不能赚钱
  gang:    { calamity: 0.35, sighting: 0.15, rumor: 0.15, environment: 0.05 },
  // 王室：知道得越少越好，但必须由我掌握
  royal:   { calamity: 0.30, rumor: 0.35, environment: 0.20, sighting: 0.10 },
  // 密教团（本版无内容，口径先留着）
  order:   { environment: 0.50, sighting: 0.40, calamity: 0.40, rumor: 0.30 },
};

/** 目标关键词 → 它增益哪几类事件 */
const GOAL_TAGS: Readonly<Record<string, readonly PowerEventKind[]>> = {
  污染: ['environment', 'calamity'],
  净化: ['environment', 'calamity'],
  异端: ['sighting'],
  封锁: ['rumor', 'sighting'],
  真相: ['rumor'],
  秩序: ['rumor', 'sighting'],
  恐慌: ['rumor', 'calamity'],
  通缉: ['sighting'],
  灵界: ['environment', 'sighting'],
  海怪: ['sighting', 'calamity'],
  航路: ['calamity'],
  灾厄: ['calamity'],
  变异: ['calamity', 'environment'],
  失控: ['sighting'],
  秘密: ['rumor'],
  知识: ['rumor'],
};

/** 目标关键词给的加成 */
const GOAL_BONUS = 0.2;

/**
 * 一件事与一家势力有多相关（0—1）。
 *
 * 两个来源：
 *   1. **类型基础分** —— 警察厅对目击比对环境异象在意得多；
 *   2. **目标加成** —— 它的长期目标里有没有对应的话题（污染 / 异端 / 真相…）。
 *
 * 写成纯函数而不是内联，是为了让「为什么这次它动了」有一个可以断言的答案 ——
 * 报告里 `reason` 字段就是照它写的。
 */
export function relevanceOf(power: Power, event: PowerEvent): number {
  let score = BASE_RELEVANCE[power.type][event.kind] ?? 0;
  for (const goal of power.goals) {
    for (const [keyword, kinds] of Object.entries(GOAL_TAGS)) {
      if (!goal.includes(keyword)) continue;
      if (kinds.includes(event.kind)) score += GOAL_BONUS;
    }
  }
  return Math.min(1, score);
}

/**
 * M2.67：**三项资源各自的权重**（按事件类型）。
 *
 * ## 为什么要有这张表
 *
 * `powers.yaml` 从 M2.59 起每家都写了三项资源，而判定层只读了 `manpower` 一项 ——
 * `wealth` 与 `mystic` **一个读者都没有**（11 家势力各写了一份）。
 * 于是「教会神秘侧强、黑帮有钱、警察人多」这三句设定在玩法上完全一样。
 *
 * ## 四条权重行怎么读
 *
 *   sighting    目击 —— 撞见不该撞见的东西：**神秘侧为主**（派巡警去看灵体是没用的）
 *   environment 环境异象（血月 / 灵界渗透）—— 神秘侧与人力各一半
 *   calamity    灾厄 —— **人力和钱为主**（大灾要的是人扛、钱烧）
 *   rumor       传闻 —— **钱为主**（线人、悬赏、封口，这些都是钱）
 *
 * 每行三个数**和为 1**（由测试守着）—— 于是 `resourceMixOf` 与「某一项资源的取值」
 * 永远在同一个 0—1 的尺子上，乘进同一个公式不会悄悄改变量纲。
 */
const RESOURCE_WEIGHTS: Readonly<Record<PowerEventKind, PowerResources>> = {
  sighting: { manpower: 0.3, wealth: 0.1, mystic: 0.6 },
  environment: { manpower: 0.35, wealth: 0.2, mystic: 0.45 },
  calamity: { manpower: 0.5, wealth: 0.3, mystic: 0.2 },
  rumor: { manpower: 0.3, wealth: 0.45, mystic: 0.25 },
};

/**
 * 这件事上，这家势力的**本钱**有多少（0—1）—— 三项资源的加权和。
 *
 * ⚠️ 它**按事件类型变**：同一家教会面对目击是 0.8 的本钱，面对灾厄可能只有 0.5 ——
 * 因为灾厄要的是人和钱，而它两样都不多。
 * 「一项资源的强弱」与「这件事上它有多少本钱」是两件事，这一层把它们分开。
 */
export function resourceMixOf(power: Power, event: PowerEvent): number {
  const w = RESOURCE_WEIGHTS[event.kind];
  const r = power.resources;
  return r.manpower * w.manpower + r.wealth * w.wealth + r.mystic * w.mystic;
}

/**
 * **属地之外还压不压得住**（0—1 的倍率）—— `influence` 的读取点之一。
 *
 * influence 是「它能压住多少地方」（M2.59 §5.2 登记，但一直是死列：只存取、没有判定、也从不变化）。
 * 落点：**在属地之外**动手时要乘它 —— 影响力越低，手伸得越短。
 *
 *   属地内 → ×1（自己的地盘，不看影响力）
 *   属地外 → ×(0.5 + influence)：influence 0 → ×0.5，**0.5（中性）→ ×1**，1 → ×1.5
 *
 * ⚠️ 形状为什么是 `0.5 + influence` 而不是 `0.5 + 0.5×influence`：
 * 后者在**缺省值 0.5** 上给出 ×0.75 —— 也就是「谁都没有状态行时，全体区外能力凭空掉四分之一」。
 * 那不是这条规则要表达的东西（它要说的是「影响力**低**的势力手伸不长」），
 * 而是把中性值当成了惩罚。取 0.5 + influence 之后：中性 → ×1（与加这一层之前逐位相同），
 * 低于中性 → 罚，高于中性 → **奖**（影响力高的势力在区外反而更有分量）。
 *
 * 于是「势力版图」第一次成为一个**渐变**，而不是「在区内全效、区外全废」。
 */
export function reachFactorOf(influence: number, isHome: boolean): number {
  if (isHome) return 1;
  const i = Math.min(1, Math.max(0, influence));
  return 0.5 + i;
}

/**
 * 一家势力这次会投入多少（0—1）。
 *
 * 五个乘数：
 *   severity  —— 事有多大（灾厄 3 级与 1 级不是一回事）
 *   relevance —— 与它有多相关
 *   alert     —— 它本来有多紧张（警觉是**会累积的**，见 power_state）
 *   resources —— 它有多少本钱（**三资源按事件类型加权**，见 RESOURCE_WEIGHTS）
 *   reach     —— 在属地之外还压不压得住（读 influence，见 reachFactorOf）
 *
 * ⚠️ **后两项是 M2.67 加的**：在此之前资源只算 manpower、而且没有 reach 这一项。
 * **缺省值下 reach = 1**（无 state 行 → influence 0.5 → ×1），所以「没有状态行的势力」
 * 与加这一层之前**逐位相同**。真正改变的只有**资源那一项**：
 * 从「只看人力」变成「三项按事件类型加权」—— 这是**有意的再平衡**：
 * 警察厅对目击的本钱从 0.88 掉到 0.61，黑夜女神教会从 0.76 升到 0.84
 *（于是「灵异的事该由教会管」第一次在数值上成立）。
 *
 * 属地加成仍然**单独加、不乘** —— 因为「在自己的地盘上」是**门槛上的优势**，
 * 不是「更用力」。一个资源很少的势力在自家地盘上仍然会动，
 * 而乘进去的话它永远动不了（0.2 × 0.4 已经低于门槛了）。
 */
export function reactionStrengthOf(
  power: Power,
  event: PowerEvent,
  relevance: number,
  state: PowerState | undefined,
  isHome: boolean,
): number {
  const alert = state?.alert ?? 0;
  const influence = state?.influence ?? INFLUENCE_NEUTRAL;
  const base =
    event.severity *
    relevance *
    (1 + alert * REACTION.alertWeight) *
    (0.4 + resourceMixOf(power, event) * 0.6) *
    reachFactorOf(influence, isHome);
  return Math.min(1, base + (isHome ? REACTION.homeBonus : 0));
}

/**
 * M2.67：**一次反应能让影响力怎么变**。
 *
 *   · 在**自家地盘**上动一次（而且不是敷衍）→ 影响力上升：它证明了自己压得住；
 *   · 在**别人的地方**动一次 → 影响力下降：手伸得越长，本钱掉得越快。
 *
 * 两个系数不对称（+0.05 / −0.08）是有意的：**扩张比守成贵**。
 * 强度为零的反应不产生任何变化（测试守着）—— 与 `alertDeltaOf` 同一条纪律。
 */
export function influenceDeltaOf(reaction: PowerReaction, isHome: boolean): number {
  return (isHome ? 0.05 : -0.08) * reaction.strength;
}

/** 影响力的中性值（新建一行时的默认值，也是衰减的回归点） */
export const INFLUENCE_NEUTRAL = 0.5;

/** 影响力每小时向中性值回归的比例（与生态恐慌、势力警觉同一个量级） */
export const INFLUENCE_DECAY_PER_HOUR = 0.01;

/**
 * 影响力的小时衰减：**向中性值 0.5 回归**，不是向 0。
 *
 * 为什么不向 0：0 意味着「不动的势力会彻底失去影响力」，
 * 于是任何一次沉默都会永久削弱一家势力 —— 而世界里的势力本来就该有起伏，不该有单向滑坡。
 * 与 `decayAlert`（向 0）不同是有理由的：警觉是「此刻有多紧张」，影响力是「它能压住多少地方」。
 */
export function decayInfluence(influence: number, hours: number): number {
  const i = Math.min(1, Math.max(0, influence));
  const kept = Math.pow(1 - INFLUENCE_DECAY_PER_HOUR, Math.max(0, hours));
  return INFLUENCE_NEUTRAL + (i - INFLUENCE_NEUTRAL) * kept;
}

/**
 * M2.67：**一次反应的公告能挂多久**（倍率）—— `wealth` 的第二个读取点。
 *
 * 资源权重表把「财力」写进了「这次投入多少」，但「能烧多久」是另一件事：
 * 一次封锁要人守着、一次净化要材料，**钱决定它能撑几个钟头**。
 * 落点是世界事件的 TTL：富的势力那条「封锁了现场」在玩家的消息流里留得久，
 * 穷的那条很快就过期 —— 它没钱一直守在那儿。
 *
 *   0.5 + wealth：wealth 0 → ×0.5（挂 3 小时），0.5 → ×1（6 小时），1 → ×1.5（9 小时）
 */
export function enduranceOf(power: Power): number {
  return 0.5 + power.resources.wealth;
}

/**
 * 一家势力会做出哪件事。
 *
 * 按**势力类型 × 事件类型**查表 —— 这是「什么样的组织会怎么反应」的落点。
 * 强度反过来也会改动作：同样一件事，投入多的是封锁，投入少的是调查。
 */
export function actionOf(power: Power, event: PowerEvent, strength: number): PowerActionKind {
  switch (power.type) {
    case 'police':
      if (event.kind === 'rumor') return strength >= 0.5 ? 'investigate' : 'patrol';
      return strength >= 0.5 ? 'lockdown' : 'patrol';
    case 'church':
      if (event.kind === 'environment' || event.kind === 'calamity') {
        return strength >= 0.5 ? 'purify' : 'investigate';
      }
      return strength >= 0.5 ? 'investigate' : 'withdraw';
    case 'gang':
      // 对黑帮来说没有「灾难」，只有行情
      return strength >= 0.5 ? 'exploit' : 'withdraw';
    case 'royal':
      return strength >= 0.5 ? 'lockdown' : 'investigate';
    case 'order':
      return 'investigate';
    default:
      return 'investigate';
  }
}

/* ---------------- M2.68：关系（盟友 / 敌对 / 人情） ---------------- */

/** 一家势力在关系网里的位置（对称化之后的） */
export interface RelationView {
  /** 与它结盟的势力（**双向**：一方写就够了） */
  allies: string[];
  /** 与它敌对的势力（**双向**） */
  hostiles: string[];
  /** 它**欠谁**人情（**单向**：只有欠的那一方写） */
  owes: string[];
}

/**
 * 把「谁和谁什么关系」摊平成一族对称表。
 *
 * ## 三条口径
 *
 * 1. **盟友与敌对是双向的事实**：`police` 写了「church 是盟友」，那 church 这一侧也算数 ——
 *    内容表里两个方向都写了，但历史与运行时写入的往往只有一侧
 *    （`history.yaml` 的旧仇就只写一边）。按单向处理会让「谁先写」决定谁能用上这条关系。
 * 2. **人情是单向的亏欠**：只有欠的那一方写。`god_of_war → storm_lord: debt`
 *    读作「战神欠风暴之主一个人情」，于是风暴之主动手时战神更可能跟着动。
 * 3. **同一对既有 ally 又有 hostile 时，敌对优先**（「翻脸」比「盟约」更该算数）。
 *    ⚠️ 刻意**不是**「后写覆盖先写」：那会让结果依赖 `powers` 的数组顺序。
 */
export function buildRelationIndex(powers: readonly Power[]): Map<string, RelationView> {
  /**
   * 先摊平成一族「一对势力 → 关系」的表，再按口径展开。
   *
   * ⚠️ 冲突时**敌对优先**，而不是「后写覆盖先写」—— 后者会让结果依赖
   * `powers` 的数组顺序（同一份内容，换个顺序得到不同的外交表）。
   * 这一条是测试逼出来的：第一版写的是「后者覆盖」，端到端用例当场红在「换个顺序」那一句上。
   */
  const pairs = new Map<string, PowerRelationKind>();
  const RANK: Readonly<Record<string, number>> = { ally: 0, hostile: 1 };
  const key = (a: string, b: string): string => (a < b ? a + '|' + b : b + '|' + a);
  for (const power of powers) {
    for (const relation of power.relations) {
      // 人情是单向的，不参与对称化
      if (relation.kind === 'debt') continue;
      const pairKey = key(power.id, relation.to);
      const existing = pairs.get(pairKey);
      if (existing === undefined || (RANK[relation.kind] ?? 0) > (RANK[existing] ?? 0)) {
        pairs.set(pairKey, relation.kind);
      }
    }
  }
  const out = new Map<string, { allies: string[]; hostiles: string[]; owes: string[] }>();
  const view = (id: string): { allies: string[]; hostiles: string[]; owes: string[] } => {
    const existing = out.get(id);
    if (existing !== undefined) return existing;
    const created = { allies: [] as string[], hostiles: [] as string[], owes: [] as string[] };
    out.set(id, created);
    return created;
  };
  for (const power of powers) view(power.id);
  for (const [pair, kind] of pairs) {
    const [a, b] = pair.split('|') as [string, string];
    if (kind === 'ally') {
      view(a).allies.push(b);
      view(b).allies.push(a);
    } else if (kind === 'hostile') {
      view(a).hostiles.push(b);
      view(b).hostiles.push(a);
    }
  }
  for (const power of powers) {
    for (const relation of power.relations) {
      if (relation.kind !== 'debt') continue;
      view(power.id).owes.push(relation.to);
    }
  }
  for (const value of out.values()) {
    value.allies.sort();
    value.hostiles.sort();
    value.owes.sort();
  }
  return out as Map<string, RelationView>;
}

/** 关系对这次反应的调整（强度增量 + 为什么） */
export interface RelationAdjustment {
  /** 加在强度上的量（可正可负） */
  delta: number;
  /** 也在场的盟友 */
  allies: string[];
  /** 也在场的敌对 */
  hostiles: string[];
  /** 它欠人情、而对方也在场 */
  owes: string[];
}

/**
 * **第二轮**：旁边站着谁，会改多少。
 *
 * ## 为什么必须是第二轮
 *
 * 关系的输入是「**谁也动了**」—— 而那要等第一轮算完才知道。
 * 所以这一轮不能并进 `reactionStrengthOf`（那里只看得到这一家自己）。
 *
 * ## 三条效果
 *
 *   · 盟友也在场 → **互相壮胆**（+0.12 / 家，最多算两家，见 allyBonusCap）
 *   · 敌对也在场 → **互相牵制**（−0.12 / 家）—— 警察与教会都动了，黑帮就收敛
 *   · 欠人情的一方，债权人也在场 → **跟着动**（+0.06 / 家，比盟友轻）
 *
 * ⚠️ 敌对是**减自己**而不是「抵消对方」：这一轮不引入 A 削 B 的非对称打法 ——
 * 那会让「谁先算」变成结果的一部分（同样的输入，换个遍历顺序得到不同的强度）。
 * 「互相牵制」是对称的、与顺序无关的，而它表达的正是想要的那件事：
 * **两拨人同时在场时，谁都施展不开。**
 */
export function relationAdjustmentOf(
  powerId: string,
  reacting: ReadonlySet<string>,
  index: ReadonlyMap<string, RelationView>,
  /** 盟友加成的上限（家数）—— 三四个盟友一起上不该叠加成必然反应 */
  allyBonusCap = 2,
): RelationAdjustment {
  const view = index.get(powerId);
  if (view === undefined) return { delta: 0, allies: [], hostiles: [], owes: [] };
  const allies = view.allies.filter((id) => reacting.has(id));
  const hostiles = view.hostiles.filter((id) => reacting.has(id));
  const owes = view.owes.filter((id) => reacting.has(id));
  const delta =
    Math.min(allies.length, allyBonusCap) * REACTION.allyBonus -
    hostiles.length * REACTION.hostilePenalty +
    owes.length * REACTION.debtBonus;
  return { delta, allies, hostiles, owes };
}
/**
 * 算出一件事会引发哪些反应（对外唯一入口）。
 *
 * ## 两条保证
 *
 *   1. **不是每家都会动** —— 低于 `minStrength` / `minRelevance` 的势力不出现在结果里。
 *      「11 家势力对每件事都反应」等于没有势力系统。
 *   2. **最多 `maxPowersPerEvent` 家** —— 取强度最高的那几家。
 *      一次灾厄该让 2—3 家动起来，而不是让播报变成一张花名册。
 *
 * ## 属地优先
 *
 * `isHomeOf` 由调用方给（判定层不认识领地表）—— 与生态域的 `zoneOf` 同一个手法：
 * 调用方负责查，判定层负责算。
 */
export function resolvePowerReactions(input: {
  powers: readonly Power[];
  event: PowerEvent;
  states: ReadonlyMap<string, PowerState>;
  /** 这个地点是不是它的主场（领地或主场区域） */
  isHomeOf?: (powerId: string, locationId: string | null) => boolean;
}): PowerReaction[] {
  /*
   * ---- 第一轮：各自独立算 ----
   *
   * 这一轮与 M2.59 的实现**逐字相同**（相关度 / 态势门槛 / 强度门槛）。
   * 单独一轮是有意的：第二轮的输入是「**谁也动了**」，
   * 而那必须等这一轮算完 —— 两轮的顺序不能换。
   */
  const candidates: Array<{ power: Power; relevance: number; isHome: boolean; strength: number }> = [];
  for (const power of input.powers) {
    const relevance = relevanceOf(power, input.event);
    if (relevance < REACTION.minRelevance) continue;
    const state = input.states.get(power.id);
    const isHome = input.isHomeOf?.(power.id, input.event.locationId) ?? false;
    // M2.67：影响力太低就伸不到属地之外（它是「能压住多少地方」）
    if (!isHome && (state?.influence ?? INFLUENCE_NEUTRAL) < REACTION.minInfluenceAbroad) continue;
    const strength = reactionStrengthOf(power, input.event, relevance, state, isHome);
    if (strength < REACTION.minStrength) continue;
    candidates.push({ power, relevance, isHome, strength });
  }
  if (candidates.length === 0) return [];

  /*
   * ---- 第二轮：关系（M2.68） ----
   *
   * 「旁边站着谁」会改这次投入多少：盟友壮胆、敌对牵制、欠人情的跟着走。
   * 输入取**第一轮结果的那一份快照**（`reacting`）—— 而不是边算边加，
   * 否则结果会依赖遍历顺序（同一次事件，换个数组顺序得到不同的强度）。
   *
   * 被牵制到门槛以下的势力**干脆不动**：这正是「警察和教会都到了，黑帮就收敛」。
   */
  const relationIndex = buildRelationIndex(input.powers);
  const reacting = new Set(candidates.map((entry) => entry.power.id));
  const nameOf = new Map(input.powers.map((power) => [power.id, power.name]));
  const out: PowerReaction[] = [];
  for (const entry of candidates) {
    const adjustment = relationAdjustmentOf(entry.power.id, reacting, relationIndex);
    const strength = Math.min(1, Math.max(0, entry.strength + adjustment.delta));
    if (strength < REACTION.minStrength) continue;
    const names = (ids: readonly string[]): string =>
      ids.map((id) => nameOf.get(id) ?? id).join('、');
    const relationNote =
      (adjustment.allies.length > 0 ? '，与' + names(adjustment.allies) + '同进' : '') +
      (adjustment.hostiles.length > 0 ? '，与' + names(adjustment.hostiles) + '相争' : '') +
      (adjustment.owes.length > 0 ? '，跟着' + names(adjustment.owes) + '还人情' : '');
    out.push({
      powerId: entry.power.id,
      powerName: entry.power.name,
      action: actionOf(entry.power, input.event, strength),
      locationId: input.event.locationId,
      strength: Number(strength.toFixed(4)),
      reason:
        entry.power.name +
        ' 对' +
        EVENT_LABELS[input.event.kind] +
        '的相关度 ' +
        entry.relevance.toFixed(2) +
        (entry.isHome ? '（属地）' : '') +
        (strength >= 0.5 ? '，投入较多' : '，投入有限') +
        relationNote,
      // 幂等：同一次事件 + 同一家力量 → 同一个 id（重放不会重复播报）
      id: 'power:' + input.event.sourceId + ':' + entry.power.id,
    });
  }
  // 强度高的先动；同强度按 id 稳定排序（补跑重放要得到同一个顺序）
  out.sort((a, b) => b.strength - a.strength || (a.powerId < b.powerId ? -1 : a.powerId > b.powerId ? 1 : 0));
  return out.slice(0, REACTION.maxPowersPerEvent);
}

export const EVENT_LABELS: Readonly<Record<PowerEventKind, string>> = {
  sighting: '目击',
  calamity: '灾厄',
  environment: '环境异象',
  rumor: '传闻',
};

/** 动作的中文名（播报用） */
export const ACTION_LABELS: Readonly<Record<PowerActionKind, string>> = {
  patrol: '加派了巡逻',
  purify: '开始了净化',
  lockdown: '封锁了现场',
  investigate: '派人去查',
  withdraw: '把自己人撤了回来',
  exploit: '趁乱动了手',
};

/**
 * 恐慌对势力的**警觉**累积：一件事发生之后，属地势力更紧张。
 *
 * 与生态的 fear 是同一个思路（M2.58 阶段三）：发生过就该留下痕迹，
 * 而且会衰减。这里给的是增量，衰减由调用方按时钟算。
 */
export function alertDeltaOf(reaction: PowerReaction): number {
  return 0.1 * reaction.strength;
}

/** 警觉每小时的衰减（与生态恐慌同一个量级：有涨有落，不是计数器） */
export const ALERT_DECAY_PER_HOUR = 0.04;

export function decayAlert(alert: number, hours: number): number {
  return alert * Math.pow(1 - ALERT_DECAY_PER_HOUR, Math.max(0, hours));
}