/**
 * 初始历史（M2.61）—— 判定层纯数据 + 纯函数，零 IO。
 *
 * ## 这一层要解决的事
 *
 * 在它之前这个世界**没有过去**：`NUMERIC.epoch` 存在（当前纪元 90 天 + 争神之战），
 * 但注释自陈「本版没有任何代码读它」；内容表里没有一处写纪元、王朝、战争、条约。
 * 于是玩家脚下的每一寸地都是刚刚生成的 —— 教会之间没有旧仇，
 * 封印物没有来历，官方的说法没有需要被掩盖的东西。
 *
 * ## 硬口径：历史必须**生成现在**
 *
 * 每个事件带一段 `effects`，四类后果，每一条都指向真实存在的实体：
 *
 *   power_relations  势力之间的旧仇 / 旧盟 / 旧债（交给 M2.59 的 PowerRelation）
 *   location_scars   地点伤痕：危险度加成 + 生态域参数偏移（交给 M2.58 的域参数）
 *   sealed           埋在地点下的封印物
 *   taboo_knowledge  不该被知道的事（谁想埋掉它、谁还记得）
 *
 * 一张只写「三百年前打过一仗」的历史表是背景文本；
 * 一张写着「那仗让黑夜女神与永恒烈阳至今互相敌视」的历史表才会改变世界。
 */
import { z } from 'zod';
import type { PowerRelationKind } from './power.ts';

export const HistoryEventTypeSchema = z.enum([
  'epoch',
  'dynasty',
  'war',
  'treaty',
  'disaster',
  'scandal',
  'migration',
]);
export type HistoryEventType = z.infer<typeof HistoryEventTypeSchema>;

export const SealLevelSchema = z.enum(['low', 'medium', 'high', 'forbidden']);
export type SealLevel = z.infer<typeof SealLevelSchema>;

export const HISTORY_EVENT_TYPE_LABELS: Readonly<Record<HistoryEventType, string>> = {
  epoch: '纪元',
  dynasty: '王朝',
  war: '战争',
  treaty: '条约',
  disaster: '灾难',
  scandal: '丑闻',
  migration: '迁徙',
};

/** 地点的历史伤痕：危险度加成 + 生态域参数偏移 */
export const LocationScarSchema = z.object({
  location: z.string().min(1),
  /** 危险度加成（0—3）。叠到 locations.yaml 的 danger 上（上限 5） */
  danger_bonus: z.number().int().min(0).max(3).default(0),
  /**
   * 生态域参数的偏移（与 M2.58 的域参数同名 —— 历史就是这样改变世界的脾气）。
   * 只允许域参数里那六个比率；倍数类不给历史改（那会让一个域的生态整体失控）。
   */
  zone_patch: z
    .object({
      spirituality: z.number().min(-1).max(1).optional(),
      pollution: z.number().min(-1).max(1).optional(),
      madness: z.number().min(-1).max(1).optional(),
      hidden: z.number().min(-1).max(1).optional(),
      order: z.number().min(-1).max(1).optional(),
      fear: z.number().min(-1).max(1).optional(),
    })
    .default({}),
});
export type LocationScar = z.infer<typeof LocationScarSchema>;

/** 埋在某处的封印物 */
export const SealedItemSchema = z.object({
  location: z.string().min(1),
  what: z.string().min(1),
  level: SealLevelSchema.default('medium'),
});
export type SealedItem = z.infer<typeof SealedItemSchema>;

/** 一条不该被知道的事 */
export const TabooKnowledgeSchema = z.object({
  /** 这件事是关于哪里的：区域 id 或地点 id */
  scope: z.string().min(1),
  what: z.string().min(1),
  /** 谁想把它埋掉（势力 id） */
  holder: z.string().min(1),
});
export type TabooKnowledge = z.infer<typeof TabooKnowledgeSchema>;

export const HistoryEffectsSchema = z.object({
  power_relations: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        kind: z.enum(['ally', 'hostile', 'debt']),
      }),
    )
    .default([]),
  location_scars: z.array(LocationScarSchema).default([]),
  sealed: z.array(SealedItemSchema).default([]),
  taboo_knowledge: z.array(TabooKnowledgeSchema).default([]),
});
export type HistoryEffects = z.infer<typeof HistoryEffectsSchema>;

export const HistoryEventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: HistoryEventTypeSchema,
  /** 距今年数（越大越古老）。0 = 就是现在 */
  year: z.number().int().min(0),
  /** 一句话的结果（报告与背景文案读它） */
  result: z.string().min(1),
  /** 这件事发生在哪 —— 区域 id 列表（可以为空 = 世界级） */
  region: z.string().default(''),
  /** 涉及的地点 id */
  locations: z.array(z.string()).default([]),
  /** 涉及哪些势力 */
  parties: z.array(z.string()).default([]),
  effects: HistoryEffectsSchema.default({
    power_relations: [],
    location_scars: [],
    sealed: [],
    taboo_knowledge: [],
  }),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

/* ---------------- 索引与聚合 ---------------- */

/**
 * 历史索引：按地点与势力查「这里有过什么事」。
 *
 * 建一次、查多次：世界层在生成传闻、风暴层在算影响力时都会问「这里的历史」，
 * 而每次线性扫一遍 events 是 O(事件数)。与 M2.58 的 ZoneIndex 同一个理由。
 */
export class HistoryIndex {
  readonly #events: readonly HistoryEvent[];
  readonly #byLocation = new Map<string, HistoryEvent[]>();
  readonly #byParty = new Map<string, HistoryEvent[]>();
  /** M2.72：地点 → 那底下埋着的封印物（同一个地点只留 level 最高的那一件） */
  readonly #sealedAt = new Map<string, HistorySealed>();

  constructor(events: readonly HistoryEvent[], sealed: readonly HistorySealed[] = []) {
    this.#events = events;
    /*
     * M2.72：**埋在地点下的封印物**进索引。
     *
     * 在此之前 `historyEffects().sealed` 只被后台的只读页展示（admin/console.js 的标题
     * 甚至写着「未接判定」）—— 9 处地点写着「这底下埋着东西」，
     * 而玩法上一个字节都没读它。
     *
     * 同一地点埋了多件时**取 level 最高的那一件**：索引回答的是「这里最要紧的是什么」，
     * 而挖掘判定只需要一个概率档（多件并存会让概率变成两倍，那不是内容想说的）。
     */
    for (const item of sealed) {
      const existing = this.#sealedAt.get(item.location);
      if (existing === undefined || SEAL_LEVEL_RANK[item.level] > SEAL_LEVEL_RANK[existing.level]) {
        this.#sealedAt.set(item.location, item);
      }
    }
    for (const event of events) {
      for (const locationId of event.locations) {
        const list = this.#byLocation.get(locationId) ?? [];
        list.push(event);
        this.#byLocation.set(locationId, list);
      }
      for (const powerId of event.parties) {
        const list = this.#byParty.get(powerId) ?? [];
        list.push(event);
        this.#byParty.set(powerId, list);
      }
    }
  }

  get events(): readonly HistoryEvent[] {
    return this.#events;
  }

  /** 这个地点发生过哪些事（新→旧：距今近的在前） */
  ofLocation(locationId: string): readonly HistoryEvent[] {
    return [...(this.#byLocation.get(locationId) ?? [])].sort((a, b) => a.year - b.year);
  }

  /** 这家势力卷进过哪些事 */
  ofPower(powerId: string): readonly HistoryEvent[] {
    return [...(this.#byParty.get(powerId) ?? [])].sort((a, b) => a.year - b.year);
  }

  /**
   * M2.72：**这个地点底下埋着什么**（没有就是 null）。
   *
   * 这是 `historyEffects().sealed` 的读取点 —— 探索结算拿它决定
   * 「在这里挖不挖得到东西、有多大概率」。
   */
  sealedAt(locationId: string): HistorySealed | null {
    return this.#sealedAt.get(locationId) ?? null;
  }

  /** 全部埋着东西的地点（报告与后台用） */
  get sealedCount(): number {
    return this.#sealedAt.size;
  }

  /** 找一件事（报告与测试用） */
  byId(id: string): HistoryEvent | undefined {
    return this.#events.find((event) => event.id === id);
  }

  get size(): number {
    return this.#events.length;
  }
}

/* ---------------- 历史 → 现在的状态 ---------------- */

export interface HistoryRelation {
  from: string;
  to: string;
  kind: PowerRelationKind;
  /** 为什么（哪一场战争留下的） */
  because: string;
}

export interface HistorySealed {
  location: string;
  what: string;
  level: SealLevel;
  because: string;
}

/** 封印等级 → 序（用来比较「哪一件更要紧」） */
const SEAL_LEVEL_RANK: Readonly<Record<SealLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  forbidden: 3,
};

/**
 * M2.72：**一次探索在「埋着东西的地点」挖到它的概率**。
 *
 * 与 `NUMERIC.extraordinary.dropRates` 的关系：那一份是**全服通用**的封印物掉落
 *（explore 0.8%），回答的是「随便哪个地方都可能捡到」；这一份回答的是
 *「**历史说这里埋着东西**，所以这里明显更容易挖到」—— 两者独立掷、可以同时命中
 *（一个地方既可能随手捡到，也可能挖出埋着的那件）。
 *
 * 三个档位对应历史内容里的 three 值：
 *   low    —— 埋得浅，容易翻出来（4%）
 *   medium —— 要挖一阵（8%）
 *   high   —— 得动真家伙（14%）
 */
export function sealedDigChanceOf(level: SealLevel): number {
  switch (level) {
    case 'low':
      return 0.04;
    case 'medium':
      return 0.08;
    case 'high':
      return 0.14;
    default:
      // forbidden（禁）：本版内容里没有，但取值域是闭集 —— 给了它就不该「比 high 还低」
      return 0.2;
  }
}

export interface HistoryTaboo {
  scope: string;
  what: string;
  holder: string;
  because: string;
}

export interface HistoryScar {
  location: string;
  dangerBonus: number;
  zonePatch: LocationScar['zone_patch'];
  because: string;
}

/**
 * 把全部历史压成四份「现在」。
 *
 * ## 一个刻意的合并规则：多条伤痕**相加**，冲突的关系**后者胜**
 *
 * 地点伤痕：同一地点被多场灾难伤过，那些偏移应当叠加（雾灾 + 塌方 = 更糟），
 * 所以 zone_patch 逐键相加、dangerBonus 相加。
 *
 * 势力关系：同一对势力被多件事影响时**取距今最近的那一件** ——
 * 「他们后来和好了」应当覆盖「他们以前打过仗」，而时间就近的那件才是现在的样子。
 * 这条规则让 content 同学调整历史顺序时能预期结果，而不是撞出一个看运气的结果。
 */
export function historyEffects(events: readonly HistoryEvent[]): {
  relations: HistoryRelation[];
  scars: HistoryScar[];
  sealed: HistorySealed[];
  taboos: HistoryTaboo[];
} {
  const relations: HistoryRelation[] = [];
  const relationKey = new Map<string, number>();
  const scarByLocation = new Map<string, HistoryScar>();
  const sealed: HistorySealed[] = [];
  const taboos: HistoryTaboo[] = [];

  // 从**最古老**到最近地遍历：关系「后者胜」于是自然成立（后写的覆盖先写的）
  const ordered = [...events].sort((a, b) => b.year - a.year);
  for (const event of ordered) {
    for (const relation of event.effects.power_relations) {
      const key = relation.from + '->' + relation.to;
      const entry: HistoryRelation = {
        from: relation.from,
        to: relation.to,
        kind: relation.kind,
        because: event.name,
      };
      const existing = relationKey.get(key);
      if (existing === undefined) {
        relationKey.set(key, relations.length);
        relations.push(entry);
      } else {
        // 后者胜：距今更近的那件事覆盖旧的
        relations[existing] = entry;
      }
    }
    for (const scar of event.effects.location_scars) {
      const existing = scarByLocation.get(scar.location);
      if (existing === undefined) {
        scarByLocation.set(scar.location, {
          location: scar.location,
          dangerBonus: scar.danger_bonus,
          zonePatch: { ...scar.zone_patch },
          because: event.name,
        });
        continue;
      }
      // 相加：同一个地方被多场灾难伤过，那些偏移叠起来
      existing.dangerBonus += scar.danger_bonus;
      for (const [key, value] of Object.entries(scar.zone_patch)) {
        if (typeof value !== 'number') continue;
        const field = key as keyof LocationScar['zone_patch'];
        existing.zonePatch[field] = (existing.zonePatch[field] ?? 0) + value;
      }
      existing.because = existing.because + ' + ' + event.name;
    }
    for (const item of event.effects.sealed) {
      sealed.push({
        location: item.location,
        what: item.what,
        level: item.level,
        because: event.name,
      });
    }
    for (const item of event.effects.taboo_knowledge) {
      taboos.push({
        scope: item.scope,
        what: item.what,
        holder: item.holder,
        because: event.name,
      });
    }
  }
  return { relations, scars: [...scarByLocation.values()], sealed, taboos };
}

/**
 * 把历史的关系叠加到 powers.yaml 的默认关系上。
 *
 * 规则：**历史优先**。`powers.yaml` 写的是「这张外交底图默认长什么样」，
 * 而历史写的是「实际发生过什么」—— 发生过的事比默认设定更该算数。
 *
 * 那些不在历史里的默认关系原样保留（它们是 M2.59 已有的内容，不删不改）。
 */
export function mergeWithDeclaredRelations<
  T extends { from: string; to: string; kind: PowerRelationKind },
>(declared: readonly T[], historical: readonly HistoryRelation[]): Array<T | HistoryRelation> {
  const key = (entry: { from: string; to: string }): string => entry.from + '->' + entry.to;
  const out = new Map<string, T | HistoryRelation>();
  for (const entry of declared) out.set(key(entry), entry);
  for (const entry of historical) out.set(key(entry), entry);
  return [...out.values()];
}
