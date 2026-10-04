/**
 * 装备（M2.85 RPG 化 B）—— **纯函数，无 IO**。
 *
 * ## 用户拍板
 *
 * > 「我希望这个项目是更 rpg 一点的」→ 选定 A 角色成长 / **B 装备与物品** / C 战斗深度 / D 任务系统
 *
 * ## 为什么与 items.yaml 分开
 *
 * items 装的是**材料 / 消耗品 / 货币**（可堆叠、有数量）；装备是**另一类实体**：
 * 有槽位、有品质、有词条，而且**不可堆叠** —— 一个人不可能同时穿两件外套。
 * 混在一张表里，「背包里有几把刀」会变成一个查不清的问题。
 *
 * ## 四个槽位与它们各自管什么
 *
 *   weapon 武器   命中 / 伤害
 *   armor  防具   HP / 防御
 *   charm  护符   失控抗性 / 腐蚀
 *   relic  遗物   灵力 / 消化（晋升进度）
 *
 * ⚠️ 数值全部是**项目派生值**（原著没有装备数值），按「序列 × 品质倍率」算，
 * 见 equipment.yaml 的 meta 注释。
 */
import { z } from 'zod';
import { EMOJI, withEmoji } from '../emoji.ts';

export const EQUIPMENT_SLOTS = ['weapon', 'armor', 'charm', 'relic'] as const;
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

export const SLOT_LABELS: Record<EquipmentSlot, string> = {
  weapon: '武器',
  armor: '防具',
  charm: '护符',
  relic: '遗物',
};

export const EQUIPMENT_QUALITIES = ['common', 'fine', 'rare', 'epic', 'mythic'] as const;
export type EquipmentQuality = (typeof EQUIPMENT_QUALITIES)[number];

export const QUALITY_LABELS: Record<EquipmentQuality, string> = {
  common: '寻常',
  fine: '精工',
  rare: '罕见',
  epic: '珍稀',
  mythic: '神话',
};

export const EquipmentStatsSchema = z.object({
  /** 命中加成（加在命中率上，如 0.03 = +3%） */
  hit: z.number().optional(),
  /** 伤害加成（加在基础伤害上） */
  damage: z.number().optional(),
  /** HP 上限加成 */
  hp: z.number().optional(),
  /** 防御（减伤，0.02 = 2%） */
  defense: z.number().optional(),
  /** 失控抗性 */
  madResist: z.number().optional(),
  /** 腐蚀抗性 */
  cor: z.number().optional(),
  /** MP 上限加成 */
  mp: z.number().optional(),
  /** 消化加成（晋升进度更快） */
  digBonus: z.number().optional(),
});

export type EquipmentStats = z.infer<typeof EquipmentStatsSchema>;

/**
 * **封印等级**（沿用原作的四级 + 未评级）。
 *
 * 等级越高（0 级）增幅越大、代价也越重 —— 这正是原著的规则：
 * 0 级「非常危险，不可打听、不可外传、不可描述、不可窥探」。
 */
export const SEAL_LEVELS = ['0', '1', '2', '3', 'unrated'] as const;
export type SealLevel = (typeof SEAL_LEVELS)[number];

export const SEAL_LEVEL_LABELS: Record<SealLevel, string> = {
  '0': '0 级封印物',
  '1': '1 级封印物',
  '2': '2 级封印物',
  '3': '3 级封印物',
  unrated: '未评级',
};

/**
 * **代价**（用户拍板「装备上去有增幅，但也有 debuff」）。
 *
 * 原著的文字副作用（negativeEffects）没法直接判定，所以另给一份**可算的**数值；
 * 风味仍然由原文承担 —— 数值只是让「代价」在战斗里真的扣得出来。
 */
export const EquipmentDebuffsSchema = z.object({
  madPerUse: z.number().optional(),
  corGain: z.number().optional(),
  hpDrain: z.number().optional(),
  statPenalty: z.number().optional(),
});

export type EquipmentDebuffs = z.infer<typeof EquipmentDebuffsSchema>;

export const EquipmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slot: z.enum(EQUIPMENT_SLOTS),
  quality: z.enum(EQUIPMENT_QUALITIES),
  /** 适用序列（越低越强）；装错了没有加成 —— 见 canEquip */
  sequence: z.number().int().min(0).max(9),
  /** 途径专属（没有 = 通用） */
  pathway: z.string().optional(),
  /** 封印等级（神奇物品记为 unrated） */
  level: z.enum(SEAL_LEVELS).default('unrated'),
  stats: EquipmentStatsSchema.default({}),
  /** **副作用的原文**（如「每隔一天就必须用一个活人的灵魂和血肉满足它」） */
  negativeEffects: z.array(z.string()).default([]),
  /** **代价的可算数值**（项目派生） */
  debuffs: EquipmentDebuffsSchema.default({}),
  /** 能力的原文 */
  abilities: z.array(z.string()).default([]),
  text: z.string().default(''),
  origin: z.string().default(''),
});

export type Equipment = z.infer<typeof EquipmentSchema>;

/**
 * 这件装备他能不能用。
 *
 * 规则：**序列不到就穿不上**（序列 4 的人拿不动序列 1 的东西）；
 * 途径专属的装备只给**走这条途径的人**加成（别人能拿，但没用）。
 */
export function canEquip(item: Equipment, character: { sequence: number | null; pathway: string | null }): { ok: boolean; reason?: string } {
  const seq = character.sequence ?? 9;
  // 序列越大越弱：玩家的序列必须 ≤ 装备要求的序列
  if (seq > item.sequence) {
    return { ok: false, reason: `${item.name}至少要序列 ${item.sequence} 才压得住 —— 你现在是序列 ${seq}。` };
  }
  if (item.pathway !== undefined && item.pathway !== character.pathway) {
    return { ok: true, reason: `${item.pathway} 途径的东西，你拿着也只是件死物。` };
  }
  return { ok: true };
}

/** 只对**用得上的人**生效的加成（途径不符时返回空） */
export function effectiveStats(item: Equipment, character: { pathway: string | null }): EquipmentStats {
  if (item.pathway !== undefined && item.pathway !== character.pathway) return {};
  return item.stats;
}

/** 把若干件装备的加成加起来（同名字段相加） */
export function totalStats(items: readonly Equipment[], character: { pathway: string | null }): EquipmentStats {
  const out: Record<string, number> = {};
  for (const item of items) {
    const stats = effectiveStats(item, character) as Record<string, number | undefined>;
    for (const [k, v] of Object.entries(stats)) {
      if (typeof v === 'number') out[k] = Number(((out[k] ?? 0) + v).toFixed(4));
    }
  }
  return out as EquipmentStats;
}

/**
 * 把若干件装备的**代价**加起来。
 *
 * 与 totalStats 对称：那边是「你得到了什么」，这边是「你要付什么」。
 * 原著的规则是必然伴随（「有强大能力的同时必然会具备副作用」），
 * 所以这两件事在设计上是同一枚硬币的两面 —— 玩家挑装备挑的就是这个权衡。
 */
export function totalDebuffs(items: readonly Equipment[]): EquipmentDebuffs {
  const out: Record<string, number> = {};
  for (const item of items) {
    for (const [k, v] of Object.entries(item.debuffs)) {
      if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
    }
  }
  return out as EquipmentDebuffs;
}

/**
 * 代价的一句话（.装备栏 用它 —— 只看得到加成、看不到代价的装备栏是不诚实的）。
 *
 * M2.86：行首加 `⬇️`。**只在行首放一个** —— 这一行是整句，
 * 逐项加符号会变成满屏 emoji（与颜色同一条纪律：满屏等于没有）。
 * emoji 是纯文本，两端都渲染、还自带颜色，**颜色失效时它仍然在分层**。
 */
export function debuffLine(debuffs: EquipmentDebuffs): string {
  const parts: string[] = [];
  if ((debuffs.madPerUse ?? 0) > 0) parts.push('每次使用理智 −' + debuffs.madPerUse);
  if ((debuffs.corGain ?? 0) > 0) parts.push('腐蚀 +' + debuffs.corGain);
  if ((debuffs.hpDrain ?? 0) > 0) parts.push('每回合流血 ' + debuffs.hpDrain);
  if ((debuffs.statPenalty ?? 0) > 0) parts.push('属性惩罚 ' + debuffs.statPenalty);
  return parts.length > 0 ? withEmoji(EMOJI.cost, parts.join('、')) : '没有代价';
}

/** 一句话说明加成（.装备栏 与装备回执共用）；M2.86：行首加 `⬆️` */
export function statsLine(stats: EquipmentStats): string {
  const parts: string[] = [];
  const push = (label: string, value: number | undefined, pct = false) => {
    if (value === undefined || value === 0) return;
    parts.push(`${label} ${pct ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%` : `${value > 0 ? '+' : ''}${value}`}`);
  };
  push('命中', stats.hit, true);
  push('伤害', stats.damage);
  push('HP', stats.hp);
  push('防御', stats.defense, true);
  push('失控抗性', stats.madResist, true);
  push('腐蚀抗性', stats.cor);
  push('灵力', stats.mp);
  push('消化', stats.digBonus, true);
  return parts.length > 0 ? withEmoji(EMOJI.gain, parts.join('、')) : '没有加成';
}
