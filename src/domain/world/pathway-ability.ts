/**
 * 原作能力清单（M2.85 内容填充 P5）—— **原作数据直出**。
 *
 * 2405 条 = 22 途径 × 10 档的 `sequences[].abilities` 逐条原文。
 *
 * ## 为什么不做成 effect
 *
 * `AbilityEffectSchema`（src/domain/ability/ability.ts）只有 9 个数值字段，
 * 而原作的能力是**定性描述**（「获得灵视能力」「完全脱离现实至少三百年」）。
 * 把 2405 条这样压成 9 个数值字段，产出的必然是拍出来的数字 ——
 * 那是**编造**，而本批次的第一条禁令就是不许编造。
 *
 * ## 两层的关系
 *
 *   本表           设定层：原著里这个序列能做什么（原文）
 *   abilities.yaml 机制层：项目里它给什么数值（154 条，effect 字段）
 *
 * 读取点：`.图鉴 能力 <途径>` 与 `.图鉴 能力 <途径> <序列>`。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const PathwayAbilitySchema = z.object({
  id: z.string().min(1),
  pathway: PathwayIdSchema,
  seq: z.number().int().min(0).max(9),
  sequenceTitle: z.string().default(''),
  order: z.number().int().min(1),
  text: z.string().min(1),
});

export type PathwayAbility = z.infer<typeof PathwayAbilitySchema>;

export const PathwayAbilitiesFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  pathway_abilities: z.array(PathwayAbilitySchema).default([]),
});

export type ParsePathwayAbilitiesResult =
  | { ok: true; abilities: PathwayAbility[] }
  | { ok: false; issues: string[] };

/** 解析 + 校验：id 唯一。不写死条数（K14）。 */
export function parsePathwayAbilitiesFile(raw: unknown): ParsePathwayAbilitiesResult {
  const parsed = PathwayAbilitiesFileSchema.safeParse(raw);
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
  for (const ability of parsed.data.pathway_abilities) {
    if (ids.has(ability.id)) issues.push('能力 id 重复：' + ability.id);
    ids.add(ability.id);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, abilities: parsed.data.pathway_abilities };
}

/** 某途径（可选某序列）的原作能力清单，按序列降序、条内按 order */
export function abilitiesOfPathway(
  abilities: readonly PathwayAbility[],
  pathway: string,
  seq?: number,
): PathwayAbility[] {
  return abilities
    .filter((ability) => ability.pathway === pathway && (seq === undefined || ability.seq === seq))
    .sort((a, b) => (a.seq === b.seq ? a.order - b.order : b.seq - a.seq));
}
