/**
 * 塔罗牌 · 大阿卡那（M2.85 内容填充 P1）—— **原作数据直出**。
 *
 * ## 数据来源
 *
 * `诡秘之主原作数据/12-仪式与占卜/塔罗牌.yaml`，三方互证（confidence = 高）：
 *   · 萌娘百科《非凡途径》——「对应塔罗牌：XXX（N The XXX）」逐条列出；
 *   · 百度百科《亵渎之牌》——22 张牌名与下落清单；
 *   · 原文 ch5 / ch7 / ch94 —— 牌面与抽牌场景。
 *
 * ## 读取点（不许有「只写着没人读」的表）
 *
 * `.占卜` 的回执：每次占卜按 seed 抽一张牌，显示牌名 / 编号 / 对应途径 / 象征
 * （见 `src/router/commands/divination.ts`）。
 *
 * ## 与项目途径 id 的对应
 *
 * 原作 `pathway_id` 取「序列 9 的英文名」，与项目 id 有 5 处不同名（同一途径）：
 *   apprentice → door ／ savant → perfect ／ marauder → error ／ bard → sun ／ planter → mother
 * 生成时已逐条转换，并由 `parseTarotFile` 做**双向覆盖校验**（22 条途径恰好各一张牌）。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const TarotCardSchema = z.object({
  /** 大阿卡那编号：愚者是 0 号，不在 1—21 的顺序里（原作设定） */
  number: z.number().int().min(0).max(21),
  id: z.string().min(1),
  name: z.string().min(1),
  nameEn: z.string().min(1),
  pathway: PathwayIdSchema,
  /** 原作口径的途径名（「占卜家途径」），卡面展示用 */
  pathwayName: z.string().min(1),
  /** 该途径序列 0（神名）与序列 9（起点名）—— 与原作数据同字 */
  sequence0: z.string().min(1),
  sequence9: z.string().min(1),
  /** 该牌在故事里关联的组织（原作数据字段 related_organizations） */
  organizations: z.array(z.string()).default([]),
  /** 牌在故事里的持有者；原作未载时为 null（**不推测**） */
  holder: z.string().nullable().default(null),
  /** 象征意义（原作数据字段 symbolism，原文口径） */
  symbolism: z.string().min(1),
  /** 故事注记（原作数据字段 story_note）；未载为 null */
  storyNote: z.string().nullable().default(null),
  evidence: z.string().min(1),
  confidence: z.string().min(1),
});

export type TarotCard = z.infer<typeof TarotCardSchema>;

export const TarotFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  cards: z.array(TarotCardSchema).default([]),
});

export type ParseTarotResult =
  | { ok: true; cards: TarotCard[] }
  | { ok: false; issues: string[] };

/**
 * 解析 + 四道校验（不报错就会静默走错的形状，所以放在这里）：
 *   1. **22 张齐全**且编号恰好是 0—21（缺一张 = 某条途径没有牌）；
 *   2. **id 唯一**；
 *   3. **牌 → 途径**：每条途径恰好一张牌（多一张 = 有一张永远不会被抽到）；
 *   4. **途径 → 牌**：项目 22 条途径全覆盖（漏一条 = 那条途径的人占卜看不到自己的牌）。
 */
export function parseTarotFile(raw: unknown): ParseTarotResult {
  const result = TarotFileSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => {
        const at = issue.path.length > 0 ? issue.path.join('.') + '：' : '';
        return at + issue.message;
      }),
    };
  }
  const cards = result.data.cards;
  const issues: string[] = [];
  if (cards.length !== 22) issues.push(`大阿卡那必须 22 张，实际 ${cards.length} 张`);
  const numbers = new Set<number>();
  const ids = new Set<string>();
  for (const card of cards) {
    if (numbers.has(card.number)) issues.push(`编号重复：${card.number}`);
    numbers.add(card.number);
    if (ids.has(card.id)) issues.push(`牌 id 重复：${card.id}`);
    ids.add(card.id);
  }
  for (let n = 0; n < 22; n += 1) if (!numbers.has(n)) issues.push(`缺编号 ${n} 的牌`);
  const byPathway = new Map<string, number>();
  for (const card of cards) byPathway.set(card.pathway, (byPathway.get(card.pathway) ?? 0) + 1);
  for (const [pathway, count] of byPathway) {
    if (count > 1) issues.push(`途径 ${pathway} 有 ${count} 张牌（应当恰好 1 张）`);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, cards };
}

/** 按途径取牌（占卜用）。找不到返回 null —— 调用方必须显式处理，不许隐含默认。 */
export function tarotCardOf(cards: readonly TarotCard[], pathway: string): TarotCard | null {
  return cards.find((card) => card.pathway === pathway) ?? null;
}
