/**
 * 失控文本池 + 堕落形态的 zod schema（M2.76）。
 *
 * ## 为什么现在才补
 *
 * `src/cards/lost-control.yaml` 从 W5 起就是**唯一一个没有任何 schema 兜底的内容文件**：
 * 加载器（`lost-control.ts`）只手动取 `lost_control` 与 `aftershock` 两个顶层键，
 * 其余字段**读不到、也不报错**；而且旧实现还会对取到的值做 `String(entry)` 强转，
 * 于是一个写错的结构（对象、数字）会**变成一句看起来正常的字符串**。
 *
 * 这正是铁律 9（`docs/架构铁律.md:27`）要挡的形状，只是这个文件连 zod 都没有 ——
 * 所以它属于「会被静默剥掉」的那一类里最彻底的一种：**连剥都算不上，是根本没读**。
 *
 * ## 途径枚举不再抄第二份
 *
 * `pathway` 复用 `PathwayIdSchema`（`src/domain/geo/types.ts`，内容表校验口径的唯一出处）。
 * 加一条途径时它会跟着 tsc 一起红，不需要回来改这里。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../domain/geo/types.ts';

/**
 * 一个堕落形态。
 *
 * ⚠️ HP 损失写成 **`hp_loss_min` / `hp_loss_max` 两个字段**，不是一个 `[min, max]` 元组。
 * 元组更紧凑，但**后台编辑器编辑不了它**（FieldSpec 的类型系统里没有 tuple），
 * 而「运营能自己加内容、自己调数值」是这一轮的方向 —— 所以紧凑让位于可编辑。
 * 顺序校验（`min <= max`）在下面 `superRefine` 里只写一次，不受影响。
 */
export const LostFormSchema = z.object({
  id: z.string().min(1),
  pathway: PathwayIdSchema,
  /** 形态名，玩家看到的那个 */
  name: z.string().min(1),
  /** 从这一序列起可选（9 = 新号也能进） */
  min_seq: z.number().int().min(0).max(9).default(9),
  /**
   * 抽取权重。**必须为正** —— 0 或负值会让 `weightedPick` 返回 null，
   * 症状是「这个形态写出来了却永远不进」，而加载期一句话都不说。
   * 要让一个形态暂时不出现，正确做法是把 `min_seq` 调深或直接删掉它。
   */
  weight: z.number().positive(),
  /** HP 损失闭区间（两个字段，后台都能编辑） */
  hp_loss_min: z.number().int().min(0),
  hp_loss_max: z.number().int().min(0),
  mad_gain: z.number().int().min(0).default(0),
  cor_gain: z.number().int().min(0).default(0),
  /** 私聊正文里「你现在是什么样」那一句 */
  blurb: z.string().min(1),
  /** 群播报 */
  group: z.string().min(1),
}).superRefine((form, ctx) => {
  if (form.hp_loss_min > form.hp_loss_max) {
    ctx.addIssue({
      code: 'custom',
      path: ['hp_loss_max'],
      message: `hp_loss_min(${form.hp_loss_min}) 不能大于 hp_loss_max(${form.hp_loss_max})`,
    });
  }
});

/**
 * 整份文件。
 *
 * `lost_control` 的键用 `z.string()` 而不是途径枚举，**这是有意的**：
 * 它是一张「哪些途径已经写了文本」的**稀疏表**（正在补的途径可以缺席，
 * 缺席时走 `pool.all` 兜底）。键的合法性由加载器对着 `PATHWAY_LABELS` 校验 ——
 * 与 `pickLostControlText` 读的是同一份清单，不在这里抄第三份。
 */
export const LostControlFileSchema = z.object({
  lost_control: z.record(z.string(), z.array(z.string())).default({}),
  aftershock: z.array(z.string()).default([]),
  forms: z.array(LostFormSchema).default([]),
});

export type LostFormRaw = z.infer<typeof LostFormSchema>;
export type LostControlFileRaw = z.infer<typeof LostControlFileSchema>;

export type ParseLostControlResult =
  | { ok: true; data: LostControlFileRaw }
  | { ok: false; issues: string[] };

export function parseLostControlFile(raw: unknown): ParseLostControlResult {
  const result = LostControlFileSchema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
  };
}
