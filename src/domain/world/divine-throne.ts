/**
 * **神座**（M2.97）—— 二十二条途径的序列 0，现在坐着谁。
 *
 * ## 它回答什么问题
 *
 * 原作里「序列 0」是唯一的：一条途径只有一个真神的位置。而这个世界已经跑了几千年 ——
 * 有的位置一直有人，有的位置**空着**（第四纪末的苍白之灾、四皇之战打掉了好几个），
 * 还有的位置正被人往上爬（克莱恩 → 愚者）。
 *
 * 在这之前，项目里**没有任何地方**记着这件事：`pantheon.yaml` 是图鉴（神的档案），
 * `npc-tracks.yaml` 是 NPC 的晋升轨迹，而「这条途径现在有没有神」要靠人脑把两张表对起来。
 *
 * ## 与 `pantheon.yaml` 的分工
 *
 *   pantheon          **神是谁**（档案：尊名、教会、象征、本质）
 *   divine-thrones    **神在不在于这个位置**（22 条途径 × 一个座位，含空位）
 *
 * 一张表里既有「黑夜女神坐着黑暗途径」也有「黄昏巨人途径空着，战神在神战里被暗算」，
 * 后者才是这一层真正的信息量 —— **空位是这个世界的机会**。
 *
 * ## 神会做事（`schemes`）
 *
 * 每条途径 2—4 条「这位神会做的具体事」，按祂自己的性格写（黑夜女神抹记录、
 * 原初魔女蛊惑绝望的人、宇宙暗面让一处地方慢慢变脏）。
 * 世界 tick 会按 `activity` 与资源抽一条出来执行 —— 写在表里但没人读，与没写是一样的。
 */
import { z } from 'zod';

/** 这个位置现在是什么状态 */
export const ThroneStateSchema = z.enum([
  'occupied',    // 有神坐着
  'vacant',      // 空着（上一任陨落，还没人补上）—— 空位本身就是事件
  'contested',   // 有人正在往上爬（还没坐稳）
  'sealed',      // 位置被占着，但那位动不了（被污染 / 沉睡 / 被封印）
]);
export type ThroneState = z.infer<typeof ThroneStateSchema>;

export const THRONE_STATE_LABELS: Readonly<Record<ThroneState, string>> = {
  occupied: '在位',
  vacant: '空位',
  contested: '争夺中',
  sealed: '占而不得',
};

/** 坐的是哪一类存在（决定祂能动用多少资源） */
export const SeatKindSchema = z.enum([
  'pillar',    // 支柱级旧日（诡秘之主 / 上帝 / 堕落母神）
  'god',       // 正神（七大正神）
  'hidden',    // 隐秘存在与邪神（真实造物主 / 原初魔女 / 宇宙暗面…）
  'outsider',  // 外神
  'angel',     // 天使之王（准神，还没坐上）
]);
export type SeatKind = z.infer<typeof SeatKindSchema>;

export const SEAT_KIND_LABELS: Readonly<Record<SeatKind, string>> = {
  pillar: '支柱级旧日',
  god: '正神',
  hidden: '隐秘存在',
  outsider: '外神',
  angel: '天使之王',
};

/**
 * **神能动用的资源**（M2.97 用户口径：「给神明大量的资源调用」）。
 *
 * ⚠️ 它不是「一个 0—100 的数字」—— 那样写出来的神只会「随机做一件事」。
 * 资源要**逐项连到真实实体**，因为决策要用它：能派谁去、去得了哪里、
 * 出手之后还剩多少。
 *
 *   churches / factions  连 `churches.yaml` / `factions.yaml`（能派教会的人）
 *   artifacts            封印物编号（能拿出来用，用一次就是一条世界事件）
 *   reach                连 `cities.yaml`（伸手够得到的城市）
 *   angels / intel / wealth  等级（1—5）：战力 / 情报 / 财力
 */
export const DivineResourcesSchema = z.object({
  churches: z.array(z.string()).default([]),
  factions: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
  reach: z.array(z.string()).default([]),
  angels: z.number().int().min(0).max(9).default(0),
  intel: z.number().int().min(0).max(5).default(0),
  wealth: z.number().int().min(0).max(5).default(0),
});
export type DivineResources = z.infer<typeof DivineResourcesSchema>;

/** 这位神**想要什么**（长期意图 —— 决策时按它算「这一步值不值」） */
export const DivineGoalSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  weight: z.number().positive().default(1),
});
export type DivineGoal = z.infer<typeof DivineGoalSchema>;

/**
 * **手段**：这位神会做的一件事。
 *
 * 与「随机播报一句话」的区别在于三样它必须交代清楚的东西：
 *   `goal`   做这件事是为了哪个目标（对不上目标的不会被选）
 *   `cost`   代价（资源扣减 —— 神不是无限的，只是很多）
 *   `needs`  前提（没有教会就派不出主教，到不了那座城就伸不了手）
 */
export const DivineMethodSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** 执行时玩家看到的播报（不写就退回 text） */
  broadcast: z.string().default(''),
  scope: z.enum(['world', 'city', 'location']).default('world'),
  /** 服务于哪个目标（`goals[].id`） */
  goal: z.string().default(''),
  /** 资源代价 */
  cost: z.record(z.string(), z.number()).default({}),
  /** 冷却（小时）—— 同一手段不会连着用 */
  cooldown_hours: z.number().int().min(0).default(12),
  /** 前提：`church` / `angel` / `artifact` / `intel` / `wealth` / `reach` */
  needs: z.array(z.string()).default([]),
  weight: z.number().positive().default(1),
});
export type DivineMethod = z.infer<typeof DivineMethodSchema>;

/**
 * **注视**（M2.97 用户追问：「神明也有可能将视线投到玩家身上，他们会做什么呢？」）。
 *
 * 这是「神明 → **单个玩家**」的那一层，与世界级的 `responses` 并列：
 * 世界级的反应改的是天气、危险度、某座城的局势；注视改的是**你**。
 *
 * 原作里神的注视几乎总是从「一点不对劲」开始的 —— 你先感觉到什么，
 * 然后事情才发生。所以 `act` 的排序不是随机的：
 *
 *   gaze    只是看着。什么也不做，但你会知道（氛围，不是空转 —— 它是后面几步的前兆）
 *   bless   赐福：一点力量 / 一件东西（`maxHpBonus` 这类已有字段，零新字段口径）
 *   test    试探：派个手下来试你（触发一场遭遇 —— 用已有的遭遇/战斗链路）
 *   warn    警告：让你知道别再往前（临时理智压力）
 *   recruit 招募：给你一个身份（写下 `faith_<神>` 这类 flag）
 *   punish  降罚：拿走你一点东西
 *   descend 神降：把你变成祂的容器（极端，只有高序列 + 极特定的条件才可能）
 */
export const GazeActSchema = z.enum([
  'gaze', 'bless', 'test', 'warn', 'recruit', 'punish', 'descend',
]);
export type GazeAct = z.infer<typeof GazeActSchema>;

export const GAZE_ACT_LABELS: Readonly<Record<GazeAct, string>> = {
  gaze: '注视',
  bless: '赐福',
  test: '试探',
  warn: '警告',
  recruit: '招募',
  punish: '降罚',
  descend: '神降',
};

/** 一次注视：什么情形下祂会看你，看过来之后做什么 */
export const DivineGazeSchema = z.object({
  /** 触发情形（见 `divine-decide.ts` 的玩家局势枚举） */
  when: z.string().min(1),
  /** 祂会做的事 */
  act: GazeActSchema,
  /** 玩家看到的那一句（第一人称经历，不是播报） */
  text: z.string().min(1),
  /** 效果：落在已有字段上（maxHpBonus / divinationDailyBonus / madRate…） */
  effect: z.record(z.string(), z.number()).default({}),
  /** 写下的 flag（招募那类要用） */
  flag: z.string().default(''),
  weight: z.number().positive().default(1),
});
export type DivineGaze = z.infer<typeof DivineGazeSchema>;

/**
 * **反应**：世界出了某件事时，这位神会偏向用哪个手段。
 *
 * 这是「不死板」的落点 —— 没有它，神只会按自己的权重表自顾自地出手；
 * 有了它，玩家在祂的城市里挖封印物、或者有邪神在祂的地盘上蛊惑人时，
 * **祂会针对性地动**。
 */
export const DivineResponseSchema = z.object({
  /** 触发情形（世界状态的关键词，见 `divine-decide.ts` 的局势枚举） */
  when: z.string().min(1),
  /** 优先使用的手段 id */
  prefer: z.string().min(1),
  /** 反应强度：越大越容易被选中 */
  weight: z.number().positive().default(2),
});
export type DivineResponse = z.infer<typeof DivineResponseSchema>;

export const DivineThroneSchema = z.object({
  pathway: z.string().min(1),
  /** 序列 0 的称号（原作：愚者 / 暴君 / 白塔…） */
  title: z.string().min(1),
  /** 现在坐在这儿的名字（空位时写上一任，或在位者的尊名） */
  seat: z.string().default(''),
  seatKind: SeatKindSchema,
  state: ThroneStateSchema,
  /** 原作给的依据（哪本书 / 哪一节） */
  evidence: z.string().default(''),
  /** 正在往上爬的那位（`npc-tracks.yaml` 的 id），没有就空 */
  claimant: z.string().default(''),
  /** 能动用的资源（逐项连到实体，见 DivineResourcesSchema） */
  /*
   * ⚠️ zod 的 `.default()` 要**完整对象**（不能给 `{}` 让内层默认值去填）——
   * 这里与 `DivineResourcesSchema` 的字段默认值重复了一份，是刻意的：
   * 它只有一处，而且 tsc 会在 schema 加字段时提醒。
   */
  resources: DivineResourcesSchema.default({
    churches: [], factions: [], artifacts: [], reach: [], angels: 0, intel: 0, wealth: 0,
  }),
  /** 长期目标 —— 手段要服务于它，对不上的不会被选 */
  goals: z.array(DivineGoalSchema).default([]),
  /** 手段库 */
  methods: z.array(DivineMethodSchema).default([]),
  /** 对局势的反应（「不死板」的落点） */
  responses: z.array(DivineResponseSchema).default([]),
  /** 看向玩家时会做什么（世界级反应之外的、针对个人的那一层） */
  gaze: z.array(DivineGazeSchema).default([]),
});
export type DivineThrone = z.infer<typeof DivineThroneSchema>;

export const DivineThroneFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  divine_thrones: z.array(DivineThroneSchema).default([]),
});

/** 按途径查（读取点：.图鉴 途径 / .世界 神明） */
export class DivineThroneIndex {
  readonly #byPathway = new Map<string, DivineThrone>();
  readonly #all: readonly DivineThrone[];

  constructor(thrones: readonly DivineThrone[]) {
    this.#all = thrones;
    for (const throne of thrones) this.#byPathway.set(throne.pathway, throne);
  }

  get all(): readonly DivineThrone[] {
    return this.#all;
  }

  ofPathway(pathway: string): DivineThrone | null {
    return this.#byPathway.get(pathway) ?? null;
  }

  /** 现在真的坐着神的位置（世界 tick 只在这些位置上抽行动） */
  seated(): readonly DivineThrone[] {
    return this.#all.filter((t) => t.state === 'occupied' || t.state === 'contested');
  }

  byState(state: ThroneState): readonly DivineThrone[] {
    return this.#all.filter((t) => t.state === state);
  }
}
