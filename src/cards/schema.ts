import { z } from 'zod';

/** 事件卡 schema（S1 交付物二 —— src/cards/schema.ts），代码只认这份 schema */
export const EffectSchema = z.object({
  dig: z.number().optional(),
  cor: z.number().optional(),
  mad: z.number().optional(),
  hp: z.number().optional(),
  mp: z.number().optional(),
  // M2.85：ap（行动点）随行动值机制整体移除 —— 卡效果里不再有这一档
  dp: z.number().optional(),
  item: z.string().optional(),
  n: z.number().optional(),
  /** W2 新增：卡效果可以授予 flag，供 cond 里的 flag:xxx 使用 */
  flag: z.string().optional(),
});

export const TriggerSchema = z.object({
  type: z.enum(['daily', 'main', 'random', 'org', 'hidden']),
  weight: z.number().default(10),
  cond: z.array(z.string()).default([]),
  location: z.array(z.string()).optional(),
  min_seq: z.number().optional(),
  max_seq: z.number().optional(),
  /** W2 新增：同一张卡在 N 天内不再触发 */
  cooldown_days: z.number().default(0),
});

export const EventCardSchema = z.object({
  id: z.string(),
  /**
   * M2.40：这张卡在群里的**显示名**（中文）。
   *
   * 为什么必填：在此之前渲染层念的是 `card.id`（群里出现 `事件【daily_013】`），
   * 而卡片本身**没有名字可念** —— 两件事叠在一起就是「显示英文」。
   * 补完名字之后把 schema 一起收紧（铁律 9：漏了要让它在加载期报错，
   * 而不是等玩家在群里看见一个 id）。
   */
  name: z.string().min(1),
  trigger: TriggerSchema,
  effects: z.array(EffectSchema).default([]),
  texts: z.object({
    priv: z.string(),
    group: z.string().optional(),
  }),
  /**
   * M2.69：**这张卡每天最多出几次**（0 = 今天不许出）。
   *
   * ⚠️ 它从 W2 起就写在每一张卡的顶层，而**运行期零读取**（每日去重走的是
   * event_triggers 表里那一行的存在性，恒为 1 次）。M2.69 把那一行改成「触发过几次」
   * （迁移 0030 的 count 列），判据落在 `domain/event/engine.ts` 的 `eligible()` ——
   * 全仓**唯一**一处读它的地方。
   *
   * 于是 `daily_limit: 2` 的卡真的能出两次，而 0 有了一种表达「今天别出我」的方式
   *（不必把卡从内容里删掉 —— 删了会打断 locations.yaml 对它的引用）。
   */
  daily_limit: z.number().default(1),
  /*
   * ⚠️ M2.119：**玩家要做出选择的那类卡**（用户拍板的改造方向）。
   *
   * > 「扮演应该取消　取而代之改为**途径专属事件卡**　每天随机让玩家遇到几次　
   * >  让他**做出相对应的选择**　然后涨消化度」
   *
   * 没有 `options` 的卡 = 现在那种「遇到就自动生效」（663 张既有卡全是这种，行为逐字不变）。
   * 有 `options` 的卡 = **不自动生效**，而是把选择摆给玩家，按他选的那一支结算。
   *
   * 每一支可以有**自己的效果与自己的正文**（`text`）—— 「相对应的选择」意味着
   * 不同的选择要读起来不一样，而不只是数值不同。
   */
  options: z
    .array(
      z.object({
        /** 玩家回复的数字（与菜单的 key 同一套） */
        key: z.string(),
        /** 选项文字（菜单上显示的那一行） */
        label: z.string(),
        /** 这一支的效果（不给就是纯叙事，不涨不跌） */
        effects: z.array(EffectSchema).default([]),
        /** 选择之后给他的那段正文（不给就沿用卡本身的 `texts.priv`） */
        text: z.string().optional(),
      }),
    )
    .optional(),
});

export type Effect = z.infer<typeof EffectSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type EventCard = z.infer<typeof EventCardSchema>;
export type CardOption = NonNullable<EventCard['options']>[number];

export type ParseCardResult =
  | { ok: true; card: EventCard }
  | { ok: false; issues: string[] };

export function parseCard(raw: unknown): ParseCardResult {
  const result = EventCardSchema.safeParse(raw);
  if (result.success) return { ok: true, card: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
  };
}
