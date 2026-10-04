/**
 * 组织与势力（M2.85 内容填充 P1）—— **原作数据直出**。
 *
 * ## 范围
 *
 * `诡秘之主原作数据/07-组织与势力/` 的**组织类**条目，共 49 条：
 * 鲁恩机构 6 / 军队 3 / 贵族家族 14 / 商会 2 / 地下势力 2 / 隐秘组织 22。
 *
 * ⚠️ 该目录的 `nations` 数组（国家政体 / 首都 / 货币 / 国教 / 殖民地）**不属于本表** ——
 * 它归 P2 地理批次（`regions.yaml` / `cities.yaml` 的扩充），本表不重复收录。
 *
 * ## 与现有三张「势力」表的分工
 *
 *   organizations.yaml  **原作的世俗与隐秘组织**（设定层：教义 / 成员 / 与玩家的关系）
 *   factions.yaml       本地势力**玩法骨架**（出生城市权重、通缉范围、线索落点）
 *   churches.yaml       正神教会的玩法骨架（途径绑定 / 教义 / 等级 / 据点）
 *   powers.yaml         文明势力**实体**（世界 tick 的反应方）
 *
 * ## 读取点
 *
 * ``.图鉴 组织``（按分类列出）与 ``.图鉴 组织 <名字>``（详查）。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const OrganizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nameEn: z.string().nullable().default(null),
  /** 鲁恩机构 / 军队 / 贵族家族 / 商会 / 地下势力 / 隐秘组织（原作的目录分类） */
  category: z.string().min(1),
  nation: z.string().nullable().default(null),
  era: z.string().nullable().default(null),
  nature: z.string().nullable().default(null),
  structure: z.array(z.string()).default([]),
  doctrine: z.array(z.string()).default([]),
  members: z.array(z.string()).default([]),
  pathways: z.array(PathwayIdSchema).default([]),
  pathwayNames: z.array(z.string()).default([]),
  playerRelation: z.string().nullable().default(null),
  emblem: z.string().nullable().default(null),
  note: z.array(z.string()).default([]),
  disputed: z.string().nullable().default(null),
  /** 来源 URL（原作里是 {url, confidence}，confidence 已并入条目级） */
  sources: z.array(z.string()).default([]),
  source: z.string().nullable().default(null),
  confidence: z.string().nullable().default(null),
});

export type Organization = z.infer<typeof OrganizationSchema>;

export const OrganizationsFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  organizations: z.array(OrganizationSchema).default([]),
});

export type ParseOrganizationsResult =
  | { ok: true; organizations: Organization[] }
  | { ok: false; issues: string[] };

/**
 * 解析 + 两道校验：**id 唯一**、**category 非空**（图鉴按它分组）。
 * ⚠️ 不写死条数：原作允许后续补录，写死 49 会变成假判据（K14）。
 */
export function parseOrganizationsFile(raw: unknown): ParseOrganizationsResult {
  const parsed = OrganizationsFileSchema.safeParse(raw);
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
  for (const org of parsed.data.organizations) {
    if (ids.has(org.id)) issues.push('组织 id 重复：' + org.id);
    ids.add(org.id);
    if (org.category.trim() === '') issues.push(org.id + ' 缺 category（图鉴分组靠它）');
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, organizations: parsed.data.organizations };
}

/** 与某条途径有关的组织（图鉴详查与「这条途径谁在管」） */
export function organizationsOfPathway(orgs: readonly Organization[], pathway: string): Organization[] {
  return orgs.filter((org) => org.pathways.includes(pathway as never));
}
