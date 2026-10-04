import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const MaterialNeedSchema = z.object({
  itemId: z.string().min(1),
  qty: z.number().int().positive(),
});

export const RecipeDefSchema = z.object({
  id: z.string().min(1),
  /*
   * M2.76：改成**复用** `PathwayIdSchema`。
   *
   * 原状是手抄一份 7 条途径的枚举 —— 而那两行注释自己写着「与 PATHWAY_LABELS /
   * PathwayIdSchema 同一取值域」，也就是说**抄的人知道有唯一出处，还是抄了**。
   * 代价在 M2.76 落地 15 条新途径时当场兑现：120 条新配方全部解析失败，
   * 报的是「pathway: Invalid option」，而 schema 里那份清单还停在上一个版本。
   * 这正是 AGENTS.md §3.1 要挡的形状 —— 清单只能有一份。
   */
  pathway: PathwayIdSchema,
  seq: z.number().int().min(0).max(9),
  main: z.array(MaterialNeedSchema).min(1),
  aux: z.array(MaterialNeedSchema).default([]),
  ritual: z.string().default(''),
  /** 基础成功率，实际值还要受 COR 惩罚 */
  base_success: z.number().min(0).max(1),
  cor_on_fail: z.number().int().min(0).default(0),
  mad_on_fail: z.number().int().min(0).default(0),
});

export type MaterialNeed = z.infer<typeof MaterialNeedSchema>;
export type RecipeDef = z.infer<typeof RecipeDefSchema>;

export function parseRecipe(raw: unknown): { ok: true; recipe: RecipeDef } | { ok: false; issues: string[] } {
  const result = RecipeDefSchema.safeParse(raw);
  if (result.success) return { ok: true, recipe: result.data };
  return { ok: false, issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`) };
}

/** 主材料 + 辅助材料的完整清单 */
export function recipeMaterials(recipe: RecipeDef): MaterialNeed[] {
  return [...recipe.main, ...recipe.aux];
}

/** 成品 id 约定：potion_<途径>_<序列>，与 items.yaml 对齐 */
export function potionProductId(recipe: RecipeDef): string {
  return `potion_${recipe.pathway}_${recipe.seq}`;
}
