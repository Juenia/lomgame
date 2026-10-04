/**
 * 生物名录（M2.85 内容填充 P1）—— **原作数据直出**。
 *
 * ## 它不是什么
 *
 * 它**不是** `creatures.yaml`（战斗对手模板：HP / 命中 / 专属行为 / 感知五层）。
 * 原作的生物数据**没有**战斗数值，也大量没有栖息地与外形 ——
 * 原作自己写明「来源未载，一律 null，**不做任何推测性填充**」。
 * 那份「战斗模板」只能由项目设计，本表不冒充。
 *
 * ## 它是什么
 *
 * **材料来源名录 + 生态资料**，544 条，用 `category` 区分：
 *   超凡生物 285 / 普通物种与材料 157 / 神话生物形态 32 / 具名神话生物 17 /
 *   失控机制 6 / 变异向量 9 / 事件案例 8 / 按途径的怪物群 5 / 封印与活化 6 /
 *   地理物种 2 / 植被环境 3 / 存疑记录 14
 *
 * ## 最关键的一列：`materials`
 *
 * 它记着「这条生物产出什么材料、那材料用在哪些配方」（如 `criminal:7`）——
 * 这是 **P4 配方材料体系替换**时「材料 ← 产出生物」的连接键。
 *
 * ## 读取点
 *
 * ``.图鉴 生物``（按分类列出）与 ``.图鉴 生物 <名字>``（详查）。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const BestiaryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  /** 超凡生物 / 普通物种与材料 / 神话生物形态 / 具名神话生物 / 失控机制 / 变异向量 / … */
  category: z.string().min(1),
  /** 原作的生物类别（animal / plant / mineral / spirit …） */
  creatureCategory: z.string().nullable().default(null),
  /** 是否非凡生物（原作 is_extraordinary）；未载为 null */
  isExtraordinary: z.boolean().nullable().default(null),
  pathways: z.array(PathwayIdSchema).default([]),
  pathwayNames: z.array(z.string()).default([]),
  /** 产出材料（原文拍平：「名字（角色 · 用在 x:y）」） */
  materials: z.array(z.string()).default([]),
  /** 该条目涉及的全部配方引用（剧情 / 材料链用） */
  usedIn: z.array(z.string()).default([]),
  /** ⚠️ 多数为 null —— 原作未载，不许推测 */
  habitat: z.string().nullable().default(null),
  appearance: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
  note: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  confidence: z.string().nullable().default(null),
});

export type BestiaryEntry = z.infer<typeof BestiaryEntrySchema>;

export const BestiaryFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  bestiary: z.array(BestiaryEntrySchema).default([]),
});

export type ParseBestiaryResult =
  | { ok: true; bestiary: BestiaryEntry[] }
  | { ok: false; issues: string[] };

/** 解析 + 两道校验：**id 唯一**、**category 非空**（图鉴分组靠它）。不写死条数（K14）。 */
export function parseBestiaryFile(raw: unknown): ParseBestiaryResult {
  const parsed = BestiaryFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const at = issue.path.length > 0 ? issue.path.join('.') + '：' : '';
        return at + issue.message;
      }),
    };
  }
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const entry of parsed.data.bestiary) {
    if (ids.has(entry.id)) issues.push('生物 id 重复：' + entry.id);
    ids.add(entry.id);
    if (entry.category.trim() === '') issues.push(entry.id + ' 缺 category（图鉴分组靠它）');
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, bestiary: parsed.data.bestiary };
}

/**
 * **这一条在生物图鉴里算不算「生物」（M2.93）。**
 *
 * ## 为什么要有它
 *
 * 这张表 544 条里有**四种不同的东西**混在一起 —— 它们来自同一份原作资料、共用
 * `materials` / `usedIn` 两列，所以当初放在一张表里是对的；但 `category` 是自由字符串，
 * 而 `.图鉴 生物` 把它**整表按 category 列出来** ⇒ 玩家在「生物名录」底下会读到：
 *
 *   【存疑记录】血月与红月的关系 · 「怪物」一词的两种用法
 *   【变异向量】红月 · 神弃之地的黑暗
 *   【事件案例】因斯·赞格威尔
 *   【普通物种与材料】红葡萄酒100毫升 · 纯水80毫升
 *
 * 用户的原话是「生物名录的底部数据依旧有乱七八糟的数据」。
 *
 * ## 三分类
 *
 *   creature  真生物（个体）：超凡生物 / 具名神话生物 / 地理物种 / 封印与活化
 *   form      神话生物形态：是「形态」不是个体，但玩家确实想知道「愚者的神话生物形态是什么」，
 *             所以单列一节，不混进生物列表
 *   other     其余：材料清单 / 整理笔记 / 机制说明 / 事件案例 / 环境 / 分组标签
 *             —— **不在列表里出现**，但仍可 `.图鉴 生物 <名字>` 详查（那是主动查询，不是摆给人看）
 *
 * ⚠️ 映射表**必须覆盖表里出现的每一个 category**（测试守着）—— 漏一个的后果是那一条
 * 在玩家图鉴里**静默消失**（落到 other 去了），而这不会报错。
 */
export const BESTIARY_KIND_OF: Readonly<Record<string, 'creature' | 'form' | 'other'>> = {
  超凡生物: 'creature',
  具名神话生物: 'creature',
  地理物种: 'creature',
  封印与活化: 'creature',
  神话生物形态: 'form',
  普通物种与材料: 'other',
  存疑记录: 'other',
  变异向量: 'other',
  事件案例: 'other',
  失控机制: 'other',
  按途径的怪物群: 'other',
  植被环境: 'other',
};

/** 这一条是什么（未知 category 一律算 other —— 宁可少显示，也不要再往图鉴里塞笔记） */
export function bestiaryKindOf(entry: BestiaryEntry): 'creature' | 'form' | 'other' {
  return BESTIARY_KIND_OF[entry.category] ?? 'other';
}

/** 产出某件材料的生物（P4 材料体系要用：材料 → 去哪找 → 打什么） */
export function producersOfMaterial(bestiary: readonly BestiaryEntry[], materialName: string): BestiaryEntry[] {
  return bestiary.filter((entry) => entry.materials.some((m) => m.includes(materialName)));
}
