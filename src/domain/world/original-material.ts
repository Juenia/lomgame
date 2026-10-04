/**
 * 原作材料全表（M2.85 内容填充 P4）—— **原作数据直出**。
 *
 * 1173 条 = 原作《材料索引》的全部材料（辅助材料 797 / 主材料 376）。
 *
 * ## 三向连接（这张表真正的用处）
 *
 *   材料 → 配方：`usedIn`（形如 `seer:9:辅助材料`，即「占卜家途径序列 9 需要它」）
 *   材料 → 生物：`bestiary.materials` 里含该材料名的条目（"产出它的生物"）
 *   材料 → 物品：与 `items.yaml` 的玩法物品**并存但不互相替换**
 *
 * ⚠️ 为什么不替换 `items.yaml` 的材料：那些是**已经发出去的东西**
 * （掉落表、背包、交易、配方引用都指向它们），换 id 等于把所有玩家的背包清空。
 * 本表是原著的**材料全表**（设定层），读取点是 `.图鉴 材料`。
 */
import { z } from 'zod';

export const OriginalMaterialSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 主材料 / 辅助材料 */
  kind: z.string().default(''),
  /**
   * M2.85 数据兼容对齐：这一个材料在 `items.yaml` 里对应的**玩法物品 id**（能对上时才写）。
   *
   * 设定层（原作 1147 种材料）与玩法层（948 件物品，掉落/交易/配方都指向它们）原本没有对应关系，
   * 于是「原著里这个材料能干什么」与「游戏里这个物品能干什么」是两段互不相干的话。
   */
  itemId: z.string().nullable().default(null),
  /** 需求它的配方位置（`途径:序列:类别`） */
  usedIn: z.array(z.string()).default([]),
  occurrenceCount: z.number().int().min(0).default(0),
  /** 原作里的用量写法（如「100毫升」） */
  quantitySamples: z.array(z.string()).default([]),
  /** 原作里的原文写法（同一材料在不同配方里的写法） */
  rawForms: z.array(z.string()).default([]),
});

export type OriginalMaterial = z.infer<typeof OriginalMaterialSchema>;

export const OriginalMaterialsFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  original_materials: z.array(OriginalMaterialSchema).default([]),
});

export type ParseOriginalMaterialsResult =
  | { ok: true; materials: OriginalMaterial[] }
  | { ok: false; issues: string[] };

/** 解析 + 校验：id 唯一、name 不重复也不为空。不写死条数（K14）。 */
export function parseOriginalMaterialsFile(raw: unknown): ParseOriginalMaterialsResult {
  const parsed = OriginalMaterialsFileSchema.safeParse(raw);
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
  const names = new Set<string>();
  for (const material of parsed.data.original_materials) {
    if (ids.has(material.id)) issues.push('材料 id 重复：' + material.id);
    ids.add(material.id);
    if (names.has(material.name)) issues.push('材料名重复：' + material.name);
    names.add(material.name);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, materials: parsed.data.original_materials };
}

/** 出产这种材料的生物（从 bestiary 的 materials 文本里反查） */
export function creaturesProducing(
  materials: readonly OriginalMaterial[],
  bestiary: readonly { name: string; materials: readonly string[] }[],
  name: string,
): string[] {
  if (name === '') return [];
  return bestiary.filter((entry) => entry.materials.some((line) => line.includes(name))).map((entry) => entry.name);
}

/** 需要这种材料的配方位置（途径:序列），去重后按途径名排序 */
export function recipesNeeding(material: OriginalMaterial): string[] {
  return [...new Set(material.usedIn.map((line) => line.split(':').slice(0, 2).join(':')))].sort();
}
