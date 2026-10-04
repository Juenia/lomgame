/**
 * 神明（M2.85 内容填充 P1）—— **原作数据直出**。
 *
 * ## 与 `churches.yaml` / `authorities.yaml` 的分工
 *
 *   pantheon.yaml   **神明本身**：尊名、神国、象征、教会、状态（设定层）
 *   churches.yaml   正神教会的**玩法骨架**：途径绑定 / 教义 / 等级 / 据点（M2.15）
 *   authorities.yaml **权柄的玩法落点**：改天气的世界级事件（M2.76）
 *
 * 三者不合并：读它们的人不同（图鉴 / 入教判定 / 世界 tick）。
 *
 * ## 数据来源
 *
 * `诡秘之主原作数据/04-神明与教会/`：七正神 7 + 支柱级旧日 4 + 隐秘存在与邪神 16 = **27**。
 * `godNameFull` 由原作嵌套结构拍平成「一段一行」（只做格式转换，未新增文字）；
 * `pathways` 用**序列 0 称号**与序列 9 称号反查项目途径 id，
 * 未映射的原样留在 `pathwayNames`（如《宿命之环》外神途径「混沌原胎」「世界」「异种」）。
 *
 * ## 读取点
 *
 * ``.图鉴 神明``（列表）与 ``.图鉴 神明 黑夜女神``（详查）。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const DeitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nameEn: z.string().nullable().default(null),
  /** 正神 / 支柱级旧日 / 隐秘存在与邪神（原作的分类口径） */
  category: z.string().min(1),
  tier: z.string().nullable().default(null),
  /** 真名（原作 true_name）；未载为 null */
  trueName: z.string().nullable().default(null),
  /** 已映射到项目途径的 id（可空：外神途径不在项目 22 条里） */
  pathways: z.array(PathwayIdSchema).default([]),
  /** 原作口径的途径名（保真；pathways 映射不上时以此为准） */
  pathwayNames: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  status: z.string().nullable().default(null),
  /** 完整尊名，一段一条（原作 god_name_full 拍平） */
  godNameFull: z.array(z.string()).default([]),
  divineKingdom: z.string().nullable().default(null),
  symbols: z.array(z.string()).default([]),
  holyEmblem: z.string().nullable().default(null),
  church: z.string().nullable().default(null),
  /** M2.85 数据兼容对齐：这个神的教会在 `churches.yaml` 里的 id（原作名常带/不带「教会」后缀，已归一） */
  churchIds: z.array(z.string()).default([]),
  beliefOrgs: z.array(z.string()).default([]),
  /** 本质 / 外貌 / 性质：原作里是数组或对象，生成时已拍平成「一段一行」（只做格式转换） */
  essence: z.array(z.string()).default([]),
  appearance: z.array(z.string()).default([]),
  nature: z.array(z.string()).default([]),
  relatedLocations: z.array(z.string()).default([]),
  source: z.string().nullable().default(null),
  confidence: z.string().nullable().default(null),
});

export type Deity = z.infer<typeof DeitySchema>;

export const PantheonFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  deities: z.array(DeitySchema).default([]),
});

export type ParsePantheonResult =
  | { ok: true; deities: Deity[] }
  | { ok: false; issues: string[] };

/**
 * 解析 + 两道校验：
 *   1. **id 唯一**（重一条 = 图鉴里两行一模一样，查谁都不知道该看哪条）；
 *   2. **category 必须写明**（分组靠它 —— 空值会让这位神掉出所有分类）。
 *
 * ⚠️ 故意**不**校验条数：原作本身没有「神明必须 N 位」的口径，
 * 写死 27 会变成下一次补录时的假判据（K14）。
 */
export function parsePantheonFile(raw: unknown): ParsePantheonResult {
  const parsed = PantheonFileSchema.safeParse(raw);
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
  for (const deity of parsed.data.deities) {
    if (ids.has(deity.id)) issues.push('神明 id 重复：' + deity.id);
    ids.add(deity.id);
    if (deity.category.trim() === '') issues.push(deity.id + ' 缺 category（图鉴分组靠它）');
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, deities: parsed.data.deities };
}

/** 与某条途径有关的神明（图鉴详查与「这条途径谁在管」都用它） */
export function deitiesOfPathway(deities: readonly Deity[], pathway: string): Deity[] {
  return deities.filter((deity) => deity.pathways.includes(pathway as never));
}
