import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

/** 绑定类型：bound 绑定（不可交易）/ unbound 非绑定 */
export type BindType = 'bound' | 'unbound';

export const ItemKindSchema = z.enum(['material', 'consumable', 'currency', 'potion', 'trinket']);
export type ItemKind = z.infer<typeof ItemKindSchema>;

/**
 * M2.13：**非凡物的类型**（任务书 §5.3 / §5.7）。
 *
 * ⚠️ 它与 `kind` 是**两个不同的维度**，不要混：
 *   `kind` —— 背包分类（材料 / 消耗品 / 货币 / 魔药 / 杂物），M2.5 定的，管的是「怎么显示、能不能交易」；
 *   `type` —— **非凡物类型**（普通物 / 神奇物品 / 封印物 / 符咒），M2.13 定的，
 *              管的是「它有没有封印等级、是不是被动生效、使用时代价多大」。
 *
 * 已有物品的 `type` **一律是 `material`**（默认值），内容表一个字都不用改。
 * 三件 M2.9 的老符咒（符咒·灼烧 / 净除 / 定身）**不在**这一套里 ——
 * 它们是战斗专用的消耗品（`battle` 字段），与 M2.13 的 `charm` 是两件事：
 * 前者是「战斗里的一个动作」，后者是「背包里的一张一次性牌」。
 * 把它们并进来会让 `charm` 这一个词指两样东西。
 */
export const ExtraordinaryTypeSchema = z.enum(['material', 'wonder', 'sealed', 'charm']);
export type ExtraordinaryType = z.infer<typeof ExtraordinaryTypeSchema>;

/**
 * 消耗品效果：与 apply() 的 delta 字段同名。
 *
 * M2.13 起它同时承载**封印物的机制效果**（下面那一组）。为什么同住一个对象：
 * 任务书 §5.7 给封印物只留了 `effect_json` 这一列，而这一列本来就是 `effect` 的序列化。
 *
 * ⚠️ **每一个机制字段都必须在这里显式声明**：zod 会**静默剥掉**未声明的字段，
 * 而剥掉之后的表现是「内容表里写了、运行期是 undefined、什么都不发生」——
 * M2.12 §6.1 正是被这个坑过一次（三条序列 7 的能力差点变成空能力）。
 * 所以：加一个机制效果 = 在这里加一行 + 在 `domain/extraordinary` 里真的读它。
 */
export const ItemEffectSchema = z.object({
  /* ---- 数值效果：走 apply()（唯一数值入口） ---- */
  hp: z.number().optional(),
  mp: z.number().optional(),
  mad: z.number().optional(),
  cor: z.number().optional(),
  dig: z.number().optional(),
  dp: z.number().optional(),

  /* ---- 机制效果：走 domain/extraordinary 的判定层 ---- */
  /** 占卜次数 +1（占卜水晶，被动） */
  divinationBonus: z.number().int().optional(),
  /** 交易税率的倍率（幸运硬币 0.8 = 税率 -20%，被动） */
  tradeTaxMultiplier: z.number().optional(),
  /** 夜晚探索的危险倍率（夜行披风 0.85 = -15%，被动） */
  exploreDangerMultiplierNight: z.number().optional(),
  /** 白天探索的危险倍率（夜行披风 1.1 = +10%，被动） */
  exploreDangerMultiplierDay: z.number().optional(),
  /** .扮演 的消化度倍率（记录笔记 1.1 = +10%，被动） */
  playDigMultiplier: z.number().optional(),
  /** 命运骰子：本回合 / 本次判定打空后重抽一次 */
  reroll: z.boolean().optional(),
  /** 封印之刃：无视一次序列差拦截（M2.6.1 的 `diff >= 3`） */
  ignoreSequenceGap: z.boolean().optional(),
  /** 本次判定的命中修正（封印之刃 +1.0 = 必中；与 M2.9 的 hitModifier 同一个口径） */
  hitModifier: z.number().optional(),
  /** 本次伤害的倍率（血月之刃 2） */
  damageMultiplier: z.number().optional(),
  /** 灰雾之眼：看得到目标的哪几项（location / hp / sequence） */
  reveal: z.array(z.string()).optional(),
  /** 隐身符：这么多小时之内不被通缉标记 */
  hideWantedHours: z.number().optional(),
  /** 传送符：传送到**已经标记过**的地点 */
  teleportToMarked: z.boolean().optional(),
});

/**
 * M2.13：**使用代价**（封印物的第二张脸）。
 *
 * 与 `effect` 分开存（`side_effect_json` 列），因为两者问的是不同的问题：
 *   `effect`     —— 用了之后**我要办的那件事**成不成（无视序列差 / 重抽 / 伤害翻倍）；
 *   `sideEffect` —— 用了之后**我自己**要付什么（MAD / COR）。
 *
 * 混在一起会让「这件封印物的代价到底是什么」在读内容表时要靠字段名去猜。
 */
export const ItemSideEffectSchema = z.object({
  mad: z.number().optional(),
  cor: z.number().optional(),
});

export type ItemSideEffect = z.infer<typeof ItemSideEffectSchema>;

/**
 * 战斗专用效果（M2.9）：符咒这一类「只在打起来的时候有意义」的物品。
 *
 * 与 effect 分开而不是塞进同一个对象里，是因为两者问的是不同的问题：
 *   effect —— 用了之后**我自己**的数值怎么变（夜香草压 MAD、苦艾酒提神）
 *   battle —— 用了之后**对面**会怎么样（灼烧 / 定身 / 净除）
 * 混在一起会出现「同一件物品在背包里点和使用时表现不同」而没人说得清为什么。
 */
export const ItemBattleEffectSchema = z.object({
  /** 对生物的直接伤害 */
  damage: z.number().int().positive().optional(),
  /** 清掉自己的全部负面状态 */
  cleanse: z.boolean().optional(),
  /** 本回合命中加成（-0.2 = -20%） */
  hitBonus: z.number().optional(),
  /** 给生物挂的状态（符咒·定身 = banish） */
  applyToCreature: z.array(z.enum(['bleed', 'fear', 'poison', 'lostControl', 'banish'])).optional(),
});

/**
 * M2.31（P16 落地）：**物品变体**。
 *
 * ## 为什么是变体不是新 id（P16 已拍）
 *
 * 「秘偶」「改制品」这类东西**不是新物品**，是**现有物品的另一个状态**。
 * 若每件可改装的物品 × N 种改装都建一个新 id ⇒ `items.yaml` 会随内容**线性膨胀**。
 *
 * ## 表示方式：变体声明在原物品下，加载时**展开**成复合 id
 *
 * ```yaml
 * - id: 淬火匕首
 *   kind: trinket
 *   variants:
 *     - id: retrofit
 *       name: 改装过的淬火匕首
 * ```
 *
 * ⇒ 打开时产出一个 **id = `淬火匕首#retrofit`** 的 `ItemDef`（带 `baseId`）。**不建新条目。**
 *
 * ## ⚠️ 为什么是「复合 id」而不是「库存表加一列」
 *
 * `inventory` 表的主键是 `(character_id, item_id, bind_type)`，而 `item_id` **本来就是字符串**
 * （`src/infra/db/migrations/0003_w3.sql:18`）⇒ 复合 id **零迁移**就能存。
 * 加列则要迁移 + 改主键 + 改 `InventoryRepo` 的每一条 SQL —— 而收益完全一样。
 */
export const ItemVariantSchema = z.object({
  /** 变体短名；最终 id 是 `<原物品 id>#<这个>` */
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * M2.65：**这一件变体还要拿什么东西才装得出来**（另一件物品的 id）。
   *
   * 空 = **改制品**（拆开再装回去，只要它自己）；
   * 有 = **合装件**（原物品 + `from` 指的那一件，两件合一件）。
   *
   * 为什么配方写在变体上而不是另开一张装配表：产出物**本来就是**这个变体，
   * 它的来历属于它自己。而 `variants` 已经在加载期展开（P16），
   * 于是「合装」不需要任何新的加载器、新的表、新的编辑器实体 —— 只是多读一个字段。
   */
  from: z.string().min(1).optional(),
  note: z.string().optional(),
});
export type ItemVariant = z.infer<typeof ItemVariantSchema>;

export const ItemDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: ItemKindSchema,
  /** false = 永不绑定（金镑、教会徽记这类身份物） */
  bindable: z.boolean().default(true),
  /** 能否出现在交易单里；金镑可交易，教会徽记不可 */
  tradeable: z.boolean().default(true),
  // M2.19：加 sailor —— 魔药成品（potion_<途径>_<序列>）要靠它认得自己属于哪条途径
  // M2.26：加 perfect / reader（与 geo/types.ts 的 PathwayIdSchema 同一取值域）
  /*
   * M2.76：改成**复用** `PathwayIdSchema` —— 原状是手抄一份 7 条途径的枚举。
   * 与 `recipe.ts` / `item.ts` 是同一个形状，也是同一轮抓出来的：
   * 三处各抄了一份，落地 15 条新途径时三处一起失效（报「Invalid option」）。
   * 参见 AGENTS.md §3.1「清单只能有一份，且不许手抄」。
   */
  pathway: PathwayIdSchema.optional(),
  seq: z.number().optional(),
  /**
   * M2.31（P16）：这件物品**可以被改成什么**。默认空数组 ⇒ **现有物品零行为变化**。
   * 加载时每个变体展开成一条独立的 `ItemDef`（id = `<本物品 id>#<变体 id>`）。
   */
  variants: z.array(ItemVariantSchema).default([]),
  /** 仅变体物品有：它派生自哪一件（原物品的 id） */
  baseId: z.string().min(1).optional(),
  effect: ItemEffectSchema.optional(),
  /** M2.9：战斗专用效果（符咒） */
  battle: ItemBattleEffectSchema.optional(),
  /* ---- M2.13：封印物的四个新字段（对应 0021 迁移的四列） ---- */
  /** 非凡物类型；已有物品一律 `material`（默认值，内容表不用改） */
  type: ExtraordinaryTypeSchema.default('material'),
  /** 使用代价（封印物的第二张脸） */
  sideEffect: ItemSideEffectSchema.optional(),
  /**
   * 封印等级 0—5：越高越危险。
   * **不影响任何判定**，只影响回执里的那一句警告与报告的排序。
   */
  sealLevel: z.number().int().min(0).max(5).optional(),
  /**
   * 稀有度 1—5（1 = 常见，5 = 极稀有）。
   * 与掉落表的 `weight → rarityLabel` 分档是**两件事**：那个是「在地点掉落表里的占比」，
   * 这个是「这一件东西本身有多难见」—— 封印物的来源不在掉落表里（见 numeric.extraordinary.dropRates）。
   */
  rarity: z.number().int().min(1).max(5).default(1),
  note: z.string().optional(),
});

export type ItemDef = z.infer<typeof ItemDefSchema>;
export type ItemEffect = z.infer<typeof ItemEffectSchema>;
export type ItemBattleEffect = z.infer<typeof ItemBattleEffectSchema>;

export function parseItem(raw: unknown): { ok: true; item: ItemDef } | { ok: false; issues: string[] } {
  const result = ItemDefSchema.safeParse(raw);
  if (result.success) return { ok: true, item: result.data };
  return { ok: false, issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`) };
}

/**
 * 货币 id 常量：交易与消耗统一按物品口径走，避免两套账。
 *
 * M2.5 追加：从「金镑」改成「便士」—— 内部一律按**最小单位整数**存，
 * 三层（金镑 / 苏勒 / 便士）只在显示与输入解析里出现。
 * 现有数值一个都没改，改的是单位解释（8 过去显示成「8 金镑」，现在显示成「8 便士」）。
 */
export const CURRENCY_ITEM_ID = '便士';

/** 旧 id（迁移期兼容读：老掉落 / 老存档里可能还写着金镑） */
export const LEGACY_CURRENCY_ITEM_ID = '金镑';

export function isCurrency(item: ItemDef | null): boolean {
  return item?.kind === 'currency';
}

/**
 * 能不能被 `.使用` 指令主动使用。
 *
 * M2.13：**封印物也是「能使用的物品」**，但它的 `kind` 是 `trinket`（用完之后还在），
 * 所以判据不能只看 `kind === 'consumable'`。两类分开写：
 *   消耗品 / 符咒 —— 用完就没（`kind === 'consumable'` + 有效果）
 *   封印物        —— 用完还在，只有代价（`type === 'sealed'`）
 * 神奇物品**不能主动使用**：它是被动的（在背包里就生效）。
 */
export function isUsable(item: ItemDef | null): boolean {
  if (!item) return false;
  if (item.type === 'sealed') return true;
  return item.kind === 'consumable' && item.effect !== undefined;
}

/**
 * M2.13：使用之后**是否从背包里扣掉**。
 *
 * 符咒是消耗品（扣），封印物不是（不扣，但每次都要付 `sideEffect`）
 * —— 这一条是「封印物可以反复用、但每次都有代价」的落点。
 */
export function isConsumedOnUse(item: ItemDef | null): boolean {
  if (!item) return false;
  return item.kind === 'consumable';
}

/**
 * 能否交易：由显式的 tradeable 决定。
 * 注意不能拿 bindable 顶替 —— 金镑是 bindable:false 但必须可交易。
 */
export function isTradeable(item: ItemDef | null): boolean {
  return item !== null && item.tradeable;
}

/**
 * M2.65：**内容表那一份物品**的只读索引（含 `variants`）。
 *
 * ## 为什么不能拿 `ItemRepo` 顶替
 *
 * `items` 表里**没有 variants 这一列**（P16 有意没加迁移），所以
 * `deps.items.all()` 读回来每一条的 `variants` 都是空数组 ——
 * 实测：`.行动 改装 淬火匕首` 会回一句「你手上没有能改装的东西」，
 * 而背包里明明有一把淬火匕首。纯函数那一层是对的（它拿的是 loadItems 的结果），
 * 是**接线层喂错了那份数据**。
 *
 * ⇒ 与 geopraphy / creatures / zones 一样，再加一份**内容索引**：
 * 判定层要的「这件东西能不能改 / 能和什么装在一起」读它，而不是读库。
 * `ItemRepo` 仍然是「名字 / 能否交易 / 使用效果」的读取点（那些字段真的在表里）。
 */
export class ItemIndex {
  #byId: Map<string, ItemDef>;
  #order: string[];

  constructor(items: readonly ItemDef[]) {
    this.#byId = new Map(items.map((item) => [item.id, item]));
    this.#order = items.map((item) => item.id).sort();
  }

  get(id: string): ItemDef | null {
    return this.#byId.get(id) ?? null;
  }

  all(): ItemDef[] {
    return this.#order.map((id) => this.#byId.get(id)!).filter((item) => item !== undefined);
  }

  /** 有变体的原物品（改装 / 总装的候选）—— 变体自己 `variants` 是空的，不会被算进来 */
  withVariants(): ItemDef[] {
    return this.all().filter((item) => item.variants.length > 0);
  }
}
