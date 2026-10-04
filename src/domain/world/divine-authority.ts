/**
 * 权柄与象征（M2.85 内容填充 P1）—— **原作数据直出**。
 *
 * ## 与 `authorities.yaml` 的区别（名字像，东西不同）
 *
 *   divine-authorities.yaml   **原作的权柄 / 象征**（设定层：真神层次的能力概念）
 *   authorities.yaml          **M2.76 的世界级能力玩法**（触发后真去改天气，落 world_overrides）
 *
 * 本表是前者的忠实副本：95 条（原作 118 条按「途径 × 权柄名」去重后）。
 * `kind` 由名字前缀派生：「象征：X」→ 象征，其余 → 权柄（不新增文字）。
 *
 * ## 读取点
 *
 * ``.图鉴 权柄``（按途径列出）与 ``.图鉴 权柄 <名字>``（详查）。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const DivineAuthoritySchema = z.object({
  id: z.string().min(1),
  /** 映射到项目途径 id；映射不上为 null（原作 18 组里有外神途径时会有） */
  pathway: PathwayIdSchema.nullable().default(null),
  /** 原作口径的途径名（「占卜家·愚者途径」） */
  pathwayName: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  description: z.string().default(''),
  source: z.string().nullable().default(null),
  confidence: z.string().nullable().default(null),
});

export type DivineAuthority = z.infer<typeof DivineAuthoritySchema>;

export const DivineAuthoritiesFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  divine_authorities: z.array(DivineAuthoritySchema).default([]),
});

export type ParseDivineAuthoritiesResult =
  | { ok: true; divineAuthorities: DivineAuthority[] }
  | { ok: false; issues: string[] };

/** 解析 + 两道校验：**id 唯一**、**name 非空**。不写死条数（K14）。 */
export function parseDivineAuthoritiesFile(raw: unknown): ParseDivineAuthoritiesResult {
  const parsed = DivineAuthoritiesFileSchema.safeParse(raw);
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
  for (const entry of parsed.data.divine_authorities) {
    if (ids.has(entry.id)) issues.push('权柄 id 重复：' + entry.id);
    ids.add(entry.id);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, divineAuthorities: parsed.data.divine_authorities };
}

/** 某条途径的权柄（图鉴详查 / 高序列内容取材） */
export function authoritiesOfPathway(entries: readonly DivineAuthority[], pathway: string): DivineAuthority[] {
  return entries.filter((entry) => entry.pathway === pathway);
}
