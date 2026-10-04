/**
 * 晋升仪式要求（M2.85 内容填充 P6）—— **原作数据直出**。
 *
 * 数据源：`诡秘之主原作数据/01-途径与序列/途径-*.yaml` 的 `sequences[].advancement_ritual`。
 * 共 132 条 = 22 途径 × 序列 5—0。
 *
 * ⚠️ 原作对**序列 6—9 没有记载**晋升仪式（低序列直接服食魔药）——
 * 所以本表不含那四档。**那是原作的空白，不是我们的缺口**，
 * 读取点遇到这种情况会明说「原作未载」，不假装有。
 *
 * 读取点：`.仪式 准备` 的「原作记载」一栏。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const AdvancementRiteSchema = z.object({
  id: z.string().min(1),
  pathway: PathwayIdSchema,
  seq: z.number().int().min(0).max(9),
  sequenceTitle: z.string().default(''),
  potion: z.string().default(''),
  ritual: z.string().min(1),
  source: z.string().nullable().default(null),
  confidence: z.string().nullable().default(null),
});

export type AdvancementRite = z.infer<typeof AdvancementRiteSchema>;

export const AdvancementRitesFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  advancement_rites: z.array(AdvancementRiteSchema).default([]),
});

export type ParseAdvancementRitesResult =
  | { ok: true; rites: AdvancementRite[] }
  | { ok: false; issues: string[] };

/** 解析 + 校验：id 唯一、（pathway, seq）不重复。不写死条数（K14）。 */
export function parseAdvancementRitesFile(raw: unknown): ParseAdvancementRitesResult {
  const parsed = AdvancementRitesFileSchema.safeParse(raw);
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
  const cells = new Set<string>();
  for (const rite of parsed.data.advancement_rites) {
    if (ids.has(rite.id)) issues.push('仪式 id 重复：' + rite.id);
    ids.add(rite.id);
    const cell = rite.pathway + '/' + rite.seq;
    if (cells.has(cell)) issues.push('同一格出现两条仪式：' + cell);
    cells.add(cell);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, rites: parsed.data.advancement_rites };
}

/** 某一格的晋升仪式（没有就是原作未载 —— 调用方要明说，不要编） */
export function advancementRiteOf(
  rites: readonly AdvancementRite[],
  pathway: string,
  seq: number,
): AdvancementRite | null {
  return rites.find((rite) => rite.pathway === pathway && rite.seq === seq) ?? null;
}
