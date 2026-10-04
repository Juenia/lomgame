/**
 * 奇遇（M2.85）—— `fortunes.yaml` 的 schema。
 *
 * 用户问「没有奇遇吗？」—— 之前确实没有。`.探索` 只有三种掷骰，
 * 全是「你捡到了什么」，没有「你碰上了什么」。
 *
 * 奇遇与掉落的区别就在这里：**掉落给资源，奇遇给一段事** ——
 * 可能给东西，也可能只给你一个念头、一段记忆、一个该记住的名字。
 */
import { z } from 'zod';

export const FORTUNE_KINDS = ['find', 'witness', 'meet', 'omen', 'mishap'] as const;
export type FortuneKind = (typeof FORTUNE_KINDS)[number];

export const FORTUNE_KIND_LABELS: Record<FortuneKind, string> = {
  find: '捡到',
  witness: '目睹',
  meet: '偶遇',
  omen: '预兆',
  mishap: '无妄之灾',
};

export const FortuneEffectSchema = z.object({
  /** 得到的东西（items 表里的 id） */
  itemId: z.string().optional(),
  quantity: z.number().int().min(0).optional(),
  /** 与某位 NPC 的好感（碰到「聊得来的人」） */
  affinity: z.number().int().optional(),
  hp: z.number().int().optional(),
  mad: z.number().int().optional(),
  cor: z.number().int().optional(),
  dig: z.number().int().optional(),
  /** 玩家记下的那句话（回执末尾） */
  note: z.string().default(''),
});

export type FortuneEffect = z.infer<typeof FortuneEffectSchema>;

export const FortuneSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(FORTUNE_KINDS),
  title: z.string().min(1),
  text: z.string().min(1),
  /** 抽中的相对权重 */
  weight: z.number().int().min(1),
  /** 发生在哪一带（真实性：取自 locations.yaml） */
  location: z.string().optional(),
  // ⚠️ default 必须给全 required（note 是 required）—— 这是 zod 的 default 与 .optional() 的区别
  effect: FortuneEffectSchema.default({ note: '' }),
});

export type Fortune = z.infer<typeof FortuneSchema>;

/** 按权重抽一条奇遇 */
export function pickFortune(fortunes: readonly Fortune[], roll: number): Fortune | null {
  const total = fortunes.reduce((n, f) => n + f.weight, 0);
  if (total <= 0) return null;
  let target = roll * total;
  for (const f of fortunes) {
    target -= f.weight;
    if (target <= 0) return f;
  }
  return fortunes[fortunes.length - 1] ?? null;
}

/** 奇遇的正文（.探索 的回执用它） */
export function renderFortune(fortune: Fortune): string {
  const lines = ['　', '【' + FORTUNE_KIND_LABELS[fortune.kind] + ' · ' + fortune.title + '】'];
  lines.push(fortune.text);
  if (fortune.effect.note.length > 0) lines.push('（' + fortune.effect.note + '）');
  return lines.join('\n');
}
