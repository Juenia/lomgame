/**
 * 人物（M2.85 内容填充 P1）—— **原作数据直出**。
 *
 * ## 来源与去重
 *
 * `诡秘之主原作数据/10-人物/`（主要角色.yaml + 神明与天使.yaml + 配角与NPC.yaml），
 * 跨十余个数组按 `category` 合并，共 70 条。
 *
 * ⚠️ 与 `pantheon.yaml`（神明本体）按 id **去重**：七正神 / 外神 / 旧日已在神明表里，
 * 这里只收「人物视角」的条目（角色 / 天使 / 圣徒 / 古神 / 古代帝王 / 天使之王）。
 * 神明看 ``.图鉴 神明``，人物看 ``.图鉴 人物``。
 *
 * ## 不丢字段
 *
 * 原作每条记录的字段差异很大（profile / titles / deeds / abilities…）——
 * 凡是没映射成正式字段的键，都**原样收进 `note`（保留键名）**，不做取舍。
 *
 * ## 读取点
 *
 * ``.图鉴 人物``（按分类列出）与 ``.图鉴 人物 <名字>``（详查）。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const FigureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  /** 主要角色 / 廷根配角 / 莫雷蒂家 / 贝克兰德配角 / 中序列非凡者 / 特殊角色 / 古神 / 古代帝王 / 天使之王 / 天使 / 圣徒 / 其他神明 */
  category: z.string().min(1),
  gender: z.string().nullable().default(null),
  nation: z.string().nullable().default(null),
  pathways: z.array(PathwayIdSchema).default([]),
  pathwayNames: z.array(z.string()).default([]),
  sequence: z.string().nullable().default(null),
  sequenceTitle: z.string().nullable().default(null),
  ascent: z.string().nullable().default(null),
  organization: z.array(z.string()).default([]),
  /**
   * M2.85 数据兼容对齐：所属组织在 `organizations.yaml` 里的 id。
   * 原作这一栏是复合文本（「塔罗会（创立者）」），直接比对组织表一条也对不上（实测 0/70），
   * 这一列是多级匹配的结果 —— `.图鉴 人物` 因此能说出「他属于谁」。
   */
  organizationIds: z.array(z.string()).default([]),
  occupation: z.string().nullable().default(null),
  origin: z.string().nullable().default(null),
  identity: z.string().nullable().default(null),
  relation: z.string().nullable().default(null),
  ending: z.string().nullable().default(null),
  /** 原作里未映射成正式字段的内容（保留原键名） */
  note: z.array(z.string()).default([]),
  confidence: z.string().nullable().default(null),
  sources: z.array(z.string()).default([]),
});

export type Figure = z.infer<typeof FigureSchema>;

export const FiguresFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  figures: z.array(FigureSchema).default([]),
});

export type ParseFiguresResult =
  | { ok: true; figures: Figure[] }
  | { ok: false; issues: string[] };

/** 解析 + 两道校验：**id 唯一**、**category 非空**（图鉴按它分组）。不写死条数（K14）。 */
export function parseFiguresFile(raw: unknown): ParseFiguresResult {
  const parsed = FiguresFileSchema.safeParse(raw);
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
  for (const figure of parsed.data.figures) {
    if (ids.has(figure.id)) issues.push('人物 id 重复：' + figure.id);
    ids.add(figure.id);
    if (figure.category.trim() === '') issues.push(figure.id + ' 缺 category（图鉴分组靠它）');
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, figures: parsed.data.figures };
}

/** 某条途径上的人物（图鉴详查 / 剧情取材） */
export function figuresOfPathway(figures: readonly Figure[], pathway: string): Figure[] {
  return figures.filter((figure) => figure.pathways.includes(pathway as never));
}
